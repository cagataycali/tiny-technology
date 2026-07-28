// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Stake {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IEquivocationCourt {
    function isEquivocator(address validator) external view returns (bool);
}

/**
 * TinyValidatorsSlashable — the registry that makes a conviction COST something.
 *
 * P4 shipped `TinySlashing`, a court that proves equivocation on-chain and
 * records a verdict. It burns nothing, and it cannot: `TinyValidators` was
 * deployed with no admin and no hook, so no verdict could ever reach the stake it
 * was a verdict about. Every doc since has had to say "a conviction costs
 * reputation only; stake is NOT slashable". This contract is the other half — the
 * registry that reads the docket.
 *
 * It is a REPLACEMENT for `TinyValidators`, not a fork of it: the two share the
 * whole seating rule, and after the genesis transition points Besu here the old
 * one is vestigial. Written as one readable file rather than a subclass because a
 * contract Besu depends on for liveness should be auditable top-to-bottom without
 * chasing an inheritance chain.
 *
 * ┌ What changes, exactly ──────────────────────────────────────────────────────┐
 * │ 1. A convicted validator is INELIGIBLE. rotate() skips it however much      │
 * │    stake it holds, so the highest bidder can no longer buy a seat back.     │
 * │ 2. forfeit(v) — permissionless — moves a convict's stake out of its own      │
 * │    balance permanently. Anyone may execute a recorded verdict.              │
 * │ 3. A convict cannot unstake. Without this, enforcement is a footrace: the   │
 * │    verdict is public the moment it lands, and withdrawing is one tx.        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ WHAT "FORFEIT" MEANS HERE: the stake is LOCKED IN THIS CONTRACT FOREVER, not
 * burned. TinyUSDC has no burn function and `_transfer` rejects address(0), so a
 * literal burn is not available; sending it to a treasury would be us inventing a
 * beneficiary for money that was posted as a bond, which is a transfer of value
 * nobody voted for. Locked is the honest option and it is what a bond means:
 * gone for the validator, not gained by anyone. `forfeitedTotal` is public so the
 * difference between circulating and locked supply stays auditable.
 *
 * ⚠️ THE SEAT IS NOT LOST INSTANTLY, AND THAT IS DELIBERATE. Convictions take
 * effect at the next rotation, because seats change only on epoch boundaries — a
 * mid-epoch set change is exactly the condition BFT safety proofs exclude. And
 * `minValidators` still wins: if excluding a convict would leave fewer eligible
 * candidates than the floor, the rotation is REFUSED and the convict keeps its
 * seat until enough honest candidates exist. A chain that halts to punish someone
 * has punished everyone. `blockedByFloor()` reports that state rather than leaving
 * it to be inferred from a revert.
 *
 * ⚠️ A BROKEN COURT MUST NOT FREEZE THE REGISTRY — so every court read is
 * FAIL-OPEN, gas-bounded, and never reverts. See _convicted(). The alternative
 * (fail-closed) sounds safer and is not: rotate() is the only way anyone is ever
 * seated OR unseated, so a court that reverts would permanently end entry and
 * exit for everybody, on a chain whose entire point is that entry is
 * permissionless. Fail-open loses enforcement while the court is broken; that is
 * strictly the smaller failure, and `courtHealthy()` makes it visible instead of
 * silent.
 *
 * Inherited from TinyValidators, unchanged and load-bearing (see that file for the
 * reasoning, all of it paid for by a bug): getValidators() is a bare storage read
 * that cannot revert (Besu halts on an empty or failing result); founders are
 * enrolled as candidates or the first rotation evicts them all; the candidate
 * queue is capped because rotate() iterates it; ties break by lower address so the
 * set is reproducible from chain state.
 */
contract TinyValidatorsSlashable {
    /// The seated set. Storage-only read, so getValidators() cannot revert.
    address[] private active;
    mapping(address => bool) public isActive;

    /// Everyone who has ever staked and not fully withdrawn.
    address[] private candidates;
    mapping(address => bool) public isCandidate;
    mapping(address => uint256) public stakeOf;
    mapping(address => bool) public exiting;

    /// Stake taken from convicted validators. Locked here permanently — see header.
    mapping(address => uint256) public forfeitedOf;
    uint256 public forfeitedTotal;

    IERC20Stake public immutable stakeToken;

    /**
     * The equivocation court (TinySlashing). Immutable: a registry whose notion of
     * "convicted" could be repointed by anyone would be a registry with an admin,
     * and the whole claim of this chain is that it has none.
     *
     * Required non-zero. A "slashable" registry with no court would be a name that
     * lies — and the lie would be invisible, because everything else works.
     */
    IEquivocationCourt public immutable court;

    uint256 public immutable minStake;
    uint256 public immutable maxValidators;
    uint256 public immutable minValidators;
    uint256 public immutable epochBlocks;
    uint256 public lastRotatedEpoch;

    uint256 public constant MAX_CANDIDATES = 200;

    /**
     * Gas ceiling on a court read.
     *
     * `isEquivocator` is one mapping load — ~2.6k with a cold slot. 50k is ample
     * for that and far too little for a court that tries to grief this registry by
     * burning the rotation's gas. The bound is what makes fail-open *complete*:
     * without it, "the court cannot revert us" would still leave "the court can
     * make rotate() unaffordable", which is the same denial of service wearing a
     * different hat.
     */
    uint256 private constant COURT_GAS = 50_000;

    event Staked(address indexed validator, uint256 amount, uint256 total);
    event Unstaked(address indexed validator, uint256 amount, uint256 remaining);
    event ExitRequested(address indexed validator);
    event ExitCancelled(address indexed validator);
    event Rotated(uint256 indexed epoch, uint256 seated);
    /// A verdict executed. `executor` is whoever bothered to call forfeit().
    event StakeForfeited(address indexed validator, uint256 amount, uint256 total, address indexed executor);

    error EmptySetRefused();
    error BelowValidatorFloor(uint256 eligible, uint256 floor);
    error TooEarly(uint256 currentEpoch, uint256 lastRotated);
    error StillSeated();
    error NothingStaked();
    error CandidateQueueFull();
    error BadConfig();
    /// forfeit() called on someone the court has not convicted.
    error NotConvicted(address validator);
    /// Convicted, but there is nothing left to take.
    error NothingToForfeit(address validator);
    /// A convict may not withdraw ahead of the verdict being executed.
    error ConvictedCannotUnstake(address validator);

    constructor(
        address _stakeToken,
        address _court,
        uint256 _minStake,
        uint256 _maxValidators,
        uint256 _minValidators,
        uint256 _epochBlocks,
        address[] memory initial
    ) {
        if (
            _stakeToken == address(0) ||
            _court == address(0) ||
            _minStake == 0 ||
            _maxValidators == 0 ||
            _minValidators == 0 ||
            _minValidators > _maxValidators ||
            _epochBlocks == 0 ||
            initial.length == 0 ||
            initial.length > _maxValidators ||
            initial.length < _minValidators
        ) revert BadConfig();

        stakeToken = IERC20Stake(_stakeToken);
        court = IEquivocationCourt(_court);
        minStake = _minStake;
        maxValidators = _maxValidators;
        minValidators = _minValidators;
        epochBlocks = _epochBlocks;

        for (uint256 i = 0; i < initial.length; i++) {
            address v = initial[i];
            if (v == address(0) || isActive[v]) revert BadConfig();
            isActive[v] = true;
            active.push(v);
            isCandidate[v] = true;
            candidates.push(v);
        }
        lastRotatedEpoch = block.number / _epochBlocks;
    }

    // ── the court, read defensively ──────────────────────────────────────────

    /**
     * Has the court convicted this address?
     *
     * Never reverts, never spends more than COURT_GAS, and answers "no" to
     * anything it cannot decode. Called from rotate(), which is the only path by
     * which anyone joins or leaves the validator set — so this function's failure
     * mode IS the chain's governance liveness.
     *
     * `ret.length < 32` matters as much as `!success`: a staticcall to an address
     * holding no code SUCCEEDS and returns nothing, so a court address that was
     * mistyped into an EOA would decode as garbage without this check — and
     * abi.decode of an empty return reverts, which is the one thing this function
     * promises never to do.
     */
    function _convicted(address v) private view returns (bool) {
        (bool success, bytes memory ret) = address(court).staticcall{gas: COURT_GAS}(
            abi.encodeWithSelector(IEquivocationCourt.isEquivocator.selector, v)
        );
        if (!success || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /**
     * Whether the court answers at all.
     *
     * Enforcement failing open is a silent condition by construction — everything
     * keeps working, convictions just stop mattering. This is what makes it loud:
     * a monitor (or the acceptance suite) can assert that the chain still has a
     * working court, instead of discovering it doesn't the day someone cheats.
     *
     * Probes address(0), which every correct court answers `false` for.
     */
    function courtHealthy() external view returns (bool) {
        (bool success, bytes memory ret) = address(court).staticcall{gas: COURT_GAS}(
            abi.encodeWithSelector(IEquivocationCourt.isEquivocator.selector, address(0))
        );
        return success && ret.length >= 32;
    }

    /// Public mirror of the eligibility rule, so a joiner can see why they're out.
    function isConvicted(address v) external view returns (bool) {
        return _convicted(v);
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// THE hook Besu calls every block. Bare storage read: cannot revert.
    function getValidators() external view returns (address[] memory) {
        return active;
    }

    function validatorCount() external view returns (uint256) {
        return active.length;
    }

    function candidateCount() external view returns (uint256) {
        return candidates.length;
    }

    function candidateAt(uint256 i) external view returns (address) {
        return candidates[i];
    }

    function currentEpoch() external view returns (uint256) {
        return block.number / epochBlocks;
    }

    function _eligible(address c) private view returns (bool) {
        return !exiting[c] && stakeOf[c] >= minStake && !_convicted(c);
    }

    function eligibleCount() external view returns (uint256 n) {
        for (uint256 i = 0; i < candidates.length; i++) {
            if (_eligible(candidates[i])) n++;
        }
    }

    /// True once rotate() would succeed — checks BOTH conditions rotate() enforces.
    function rotatable() external view returns (bool) {
        if (block.number / epochBlocks <= lastRotatedEpoch) return false;
        uint256 n;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (_eligible(candidates[i])) n++;
        }
        return n >= minValidators;
    }

    /**
     * How many convicted validators are still seated, and would a rotation
     * actually remove them?
     *
     * `stuck` is the honest half of this contract: excluding convicts can drop the
     * eligible pool below the floor, in which case rotate() refuses and the
     * convicts keep signing blocks. That is the correct trade (a halted chain
     * punishes everyone) but it is not a state anyone should have to infer from a
     * revert string. Reported, not hidden.
     */
    function blockedByFloor() external view returns (uint256 convictedSeated, bool stuck) {
        for (uint256 i = 0; i < active.length; i++) {
            if (_convicted(active[i])) convictedSeated++;
        }
        if (convictedSeated == 0) return (0, false);
        uint256 n;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (_eligible(candidates[i])) n++;
        }
        stuck = n < minValidators;
    }

    // ── stake ────────────────────────────────────────────────────────────────

    function stake(uint256 amount) external {
        if (amount == 0) revert NothingStaked();
        if (!isCandidate[msg.sender]) {
            if (candidates.length >= MAX_CANDIDATES) revert CandidateQueueFull();
            isCandidate[msg.sender] = true;
            candidates.push(msg.sender);
        }
        exiting[msg.sender] = false;
        stakeOf[msg.sender] += amount;
        require(stakeToken.transferFrom(msg.sender, address(this), amount), "stake transfer failed");
        emit Staked(msg.sender, amount, stakeOf[msg.sender]);
    }

    function requestExit() external {
        exiting[msg.sender] = true;
        emit ExitRequested(msg.sender);
    }

    function cancelExit() external {
        exiting[msg.sender] = false;
        emit ExitCancelled(msg.sender);
    }

    /**
     * Withdraw stake. Blocked while seated, and blocked while convicted.
     *
     * The conviction check is the reason enforcement is not merely decorative. A
     * verdict is public the instant it is mined and forfeit() is a separate
     * transaction, so without this the whole mechanism is a footrace between the
     * cheat and whoever noticed — one the cheat wins, because they are watching for
     * it and nobody else is.
     */
    function unstake(uint256 amount) external {
        if (isActive[msg.sender]) revert StillSeated();
        if (_convicted(msg.sender)) revert ConvictedCannotUnstake(msg.sender);
        uint256 held = stakeOf[msg.sender];
        if (amount == 0 || amount > held) revert NothingStaked();
        stakeOf[msg.sender] = held - amount;
        require(stakeToken.transfer(msg.sender, amount), "unstake transfer failed");
        emit Unstaked(msg.sender, amount, held - amount);
    }

    /**
     * Execute a recorded verdict: take a convict's stake out of their balance.
     *
     * Permissionless on purpose. A punishment that only an admin can apply is a
     * punishment that is applied selectively, and there is no admin here to apply
     * it. Anyone who can read the docket can act on it, which also means nobody has
     * to be trusted to.
     *
     * Idempotent by refusal rather than by silence: a second call reverts
     * NothingToForfeit instead of succeeding as a no-op, so a caller can tell
     * "already done" from "did something".
     */
    function forfeit(address validator) external {
        if (!_convicted(validator)) revert NotConvicted(validator);
        uint256 held = stakeOf[validator];
        if (held == 0) revert NothingToForfeit(validator);
        stakeOf[validator] = 0;
        forfeitedOf[validator] += held;
        forfeitedTotal += held;
        emit StakeForfeited(validator, held, forfeitedTotal, msg.sender);
    }

    // ── rotation ─────────────────────────────────────────────────────────────

    /**
     * Reseat the validator set from the candidate pool. Permissionless, once per
     * epoch, highest stake first, ties by lower address — and convicts excluded
     * however rich they are.
     */
    function rotate() external {
        uint256 epoch = block.number / epochBlocks;
        if (epoch <= lastRotatedEpoch) revert TooEarly(epoch, lastRotatedEpoch);

        uint256 n = candidates.length;
        address[] memory eligible = new address[](n);
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            address c = candidates[i];
            if (_eligible(c)) eligible[count++] = c;
        }

        if (count == 0) revert EmptySetRefused();
        // The floor beats enforcement. Refusing keeps the previous set — which may
        // include a convict — and that is the lesser harm: a set below the floor
        // has no fault tolerance, so committing one to unseat a cheat hands the
        // chain to a group too small to survive one bad node.
        if (count < minValidators) revert BelowValidatorFloor(count, minValidators);

        uint256 seats = count < maxValidators ? count : maxValidators;

        for (uint256 s = 0; s < seats; s++) {
            uint256 best = s;
            for (uint256 j = s + 1; j < count; j++) {
                uint256 sj = stakeOf[eligible[j]];
                uint256 sb = stakeOf[eligible[best]];
                if (sj > sb || (sj == sb && eligible[j] < eligible[best])) best = j;
            }
            if (best != s) {
                address tmp = eligible[s];
                eligible[s] = eligible[best];
                eligible[best] = tmp;
            }
        }

        for (uint256 i = 0; i < active.length; i++) isActive[active[i]] = false;
        delete active;
        for (uint256 s = 0; s < seats; s++) {
            isActive[eligible[s]] = true;
            active.push(eligible[s]);
        }

        lastRotatedEpoch = epoch;
        emit Rotated(epoch, seats);
    }
}
