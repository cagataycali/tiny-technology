// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Stake {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * TinyValidators — the contract that makes validator entry PERMISSIONLESS on
 * chain 8470.
 *
 * Besu QBFT reads its validator set from here when the genesis (or a
 * transition) names this address as `validatorcontractaddress`. Verified
 * against the shipped besu-consensus-qbft-26.7.0.jar:
 *   - it calls exactly `getValidators()` -> address[]  (ValidatorContractController)
 *   - it sorts the result itself (TransactionValidatorProvider: Stream.sorted())
 *   - it treats an EMPTY result as an error: "Unexpected empty result from
 *     validator smart contract call"
 * That last one is why every path below is written to keep the active set
 * non-empty. No stake, no permission, and no amount of exiting can empty it.
 * If it ever returned nothing, Besu would have no proposer and the CHAIN WOULD
 * HALT — a bug here is not a lost feature, it is a dead network.
 *
 * ┌ What "anyone can validate" means, precisely ────────────────────────────┐
 * │ Anyone holding MIN_STAKE of the stake token can seat THEMSELVES. There  │
 * │ is no owner, no allowlist, and no approval step: `stake()` then         │
 * │ `rotate()`, both callable by anyone. The operator cannot keep a staked  │
 * │ candidate out, and cannot evict a seated one.                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ msg.sender IS the validator identity. The address that stakes is the
 * address Besu expects to sign blocks, i.e. the one derived from the node's
 * devp2p/consensus key. Staking from an exchange or a multisig you cannot sign
 * blocks with would seat a validator that never proposes, which costs the whole
 * network liveness (QBFT waits out its turn). Zero-price gas is what makes this
 * practical — the node key can send its own stake tx holding no native coin.
 *
 * ⚠️ NOT IN THIS CONTRACT: slashing. Nothing here punishes a seated validator
 * that equivocates or censors; stake can only be lost by choice. Until P4 adds
 * it, stake bounds only how many identities you can afford, not how they
 * behave. Say so plainly in the join docs — an unslashed stake is a deposit,
 * not a bond.
 */
contract TinyValidators {
    /// The seated set. Storage-only read, so getValidators() cannot revert.
    address[] private active;
    mapping(address => bool) public isActive;

    /// Everyone who has ever staked and not fully withdrawn.
    address[] private candidates;
    mapping(address => bool) public isCandidate;
    mapping(address => uint256) public stakeOf;
    mapping(address => bool) public exiting;

    IERC20Stake public immutable stakeToken;
    uint256 public immutable minStake;

    /**
     * QBFT is O(n²) in messages per block: every validator talks to every other
     * one, every round. An uncapped set doesn't just get slow, it stops
     * finalising — so the cap is a liveness parameter, not a policy preference.
     */
    uint256 public immutable maxValidators;

    /**
     * The floor, and the reason it exists is a bug this contract shipped with
     * for one test run: the genesis validators are SEATED but were never
     * CANDIDATES, so the first rotate() found only the one address that had
     * staked and evicted all four founders in a single call. A 4-node set
     * (f = ⌊(n-1)/3⌋ = 1) silently became a 1-node set (f = 0) — no fault
     * tolerance, one process away from a dead chain, and callable by any
     * stranger for the price of one stake.
     *
     * So a rotation that cannot seat at least this many is REFUSED. Refusing
     * keeps the previous set, which is always safe; shrinking below the floor
     * is not something a correct rule should ever be allowed to do, however
     * legitimate each individual claim to a seat may be.
     */
    uint256 public immutable minValidators;

    /**
     * Candidates are iterated in rotate(), so an uncapped queue is a gas bomb
     * that would make rotation impossible to execute — and rotation is the only
     * way anyone ever gets seated OR unseated.
     */
    uint256 public constant MAX_CANDIDATES = 200;

    /**
     * Seats change only on epoch boundaries. Mid-epoch churn would change the
     * set under an in-flight QBFT round, and a set that disagrees about who is
     * in it is exactly the condition BFT safety proofs exclude.
     */
    uint256 public immutable epochBlocks;
    uint256 public lastRotatedEpoch;

    event Staked(address indexed validator, uint256 amount, uint256 total);
    event Unstaked(address indexed validator, uint256 amount, uint256 remaining);
    event ExitRequested(address indexed validator);
    event ExitCancelled(address indexed validator);
    event Rotated(uint256 indexed epoch, uint256 seated);

    error EmptySetRefused();
    error BelowValidatorFloor(uint256 eligible, uint256 floor);
    error TooEarly(uint256 currentEpoch, uint256 lastRotated);
    error StillSeated();
    error NothingStaked();
    error CandidateQueueFull();
    error BadConfig();

    /**
     * @param _stakeToken  ERC-20 posted as stake (TinyUSDC on 8470).
     * @param _minStake    Minimum to be *eligible*. See the open question in
     *                     docs/multinode-tiny-chain-design.md §7: we issue the
     *                     stake asset, so if stake can be faucet credit then
     *                     Sybil resistance is theatre. Set it against
     *                     non-faucet supply.
     * @param _maxValidators Seat cap (QBFT O(n²)).
     * @param _minValidators Floor: a rotation seating fewer is refused.
     * @param _epochBlocks Blocks per seating epoch.
     * @param initial      Genesis validators, seated immediately. MUST be
     *                     non-empty: the contract has to be able to answer
     *                     getValidators() on the very first block Besu asks,
     *                     which is before anyone could possibly have staked.
     */
    constructor(
        address _stakeToken,
        uint256 _minStake,
        uint256 _maxValidators,
        uint256 _minValidators,
        uint256 _epochBlocks,
        address[] memory initial
    ) {
        if (
            _stakeToken == address(0) ||
            _minStake == 0 ||
            _maxValidators == 0 ||
            _minValidators == 0 ||
            _minValidators > _maxValidators ||
            _epochBlocks == 0 ||
            initial.length == 0 ||
            initial.length > _maxValidators ||
            // A floor the founding set already violates would make the FIRST
            // rotation revert forever: nobody could ever join, and the "open"
            // chain would be permanently frozen as whatever we deployed.
            initial.length < _minValidators
        ) revert BadConfig();

        stakeToken = IERC20Stake(_stakeToken);
        minStake = _minStake;
        maxValidators = _maxValidators;
        minValidators = _minValidators;
        epochBlocks = _epochBlocks;

        for (uint256 i = 0; i < initial.length; i++) {
            address v = initial[i];
            // A zero or duplicate address would seat a validator that can never
            // sign, permanently costing the set a seat it still waits on.
            if (v == address(0) || isActive[v]) revert BadConfig();
            isActive[v] = true;
            active.push(v);

            // Enrol founders as candidates too. Without this they are seated but
            // invisible to rotate(), so the first rotation "legitimately" evicts
            // every one of them — see minValidators.
            //
            // Being a candidate is NOT a seat: they hold no stake here, so they
            // are ineligible until they stake like anybody else (the deploy
            // script does it immediately). Founders get no privileged class —
            // the only thing this line buys them is visibility to the rule that
            // everyone is judged by.
            isCandidate[v] = true;
            candidates.push(v);
        }
        lastRotatedEpoch = block.number / _epochBlocks;
    }

    /**
     * THE hook. Besu calls this every block; it must be cheap, total, and never
     * empty. Deliberately a bare storage read — no computation, no external
     * call, nothing that could revert and stop the chain.
     */
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

    /**
     * How many candidates would be seated by a rotation right now.
     *
     * Exists so a failing rotate() is diagnosable from outside: "too early" and
     * "not enough eligible validators" are completely different problems, and a
     * joiner watching only a revert cannot tell which one is theirs to fix.
     */
    function eligibleCount() external view returns (uint256 n) {
        for (uint256 i = 0; i < candidates.length; i++) {
            address c = candidates[i];
            if (!exiting[c] && stakeOf[c] >= minStake) n++;
        }
    }

    /**
     * True once rotate() would succeed — lets a joiner poll instead of guess.
     * Checks BOTH conditions rotate() enforces, so `rotatable() == true` followed
     * by a revert can't happen (it did while this only checked the epoch).
     */
    function rotatable() external view returns (bool) {
        if (block.number / epochBlocks <= lastRotatedEpoch) return false;
        uint256 n;
        for (uint256 i = 0; i < candidates.length; i++) {
            address c = candidates[i];
            if (!exiting[c] && stakeOf[c] >= minStake) n++;
        }
        return n >= minValidators;
    }

    /**
     * Post stake for msg.sender. Requires a prior approve(). Staking does NOT
     * seat you — rotate() does, at the next epoch boundary.
     */
    function stake(uint256 amount) external {
        if (amount == 0) revert NothingStaked();
        if (!isCandidate[msg.sender]) {
            if (candidates.length >= MAX_CANDIDATES) revert CandidateQueueFull();
            isCandidate[msg.sender] = true;
            candidates.push(msg.sender);
        }
        // Re-staking after requesting an exit is a change of mind, not a second
        // identity: clear the flag so the next rotation reconsiders them.
        exiting[msg.sender] = false;
        stakeOf[msg.sender] += amount;
        // transferFrom last: no state is committed if the token pull fails.
        require(stakeToken.transferFrom(msg.sender, address(this), amount), "stake transfer failed");
        emit Staked(msg.sender, amount, stakeOf[msg.sender]);
    }

    /**
     * Ask to be unseated at the next rotation. Separate from unstake() because
     * a seated validator's stake is what its seat rests on: letting it withdraw
     * while still signing blocks would mean an unbonded validator, and once P4
     * adds slashing there would be nothing left to slash.
     */
    function requestExit() external {
        exiting[msg.sender] = true;
        emit ExitRequested(msg.sender);
    }

    /**
     * Change your mind. Without this, the only way to un-flag an exit is to post
     * MORE stake (stake() clears it), which charges people for a decision they
     * are entitled to reverse for free — and leaves the set stuck below its floor
     * until somebody pays. An exit request is an intention, not a commitment.
     */
    function cancelExit() external {
        exiting[msg.sender] = false;
        emit ExitCancelled(msg.sender);
    }

    /**
     * Withdraw stake. Blocked while seated — call requestExit(), wait for a
     * rotation, then withdraw. rotate() is permissionless precisely so this is
     * never a hostage situation: nobody needs the operator's cooperation to get
     * their money out.
     */
    function unstake(uint256 amount) external {
        if (isActive[msg.sender]) revert StillSeated();
        uint256 held = stakeOf[msg.sender];
        if (amount == 0 || amount > held) revert NothingStaked();
        stakeOf[msg.sender] = held - amount;
        require(stakeToken.transfer(msg.sender, amount), "unstake transfer failed");
        emit Unstaked(msg.sender, amount, held - amount);
    }

    /**
     * Reseat the validator set from the candidate pool. Permissionless and
     * once per epoch.
     *
     * Selection: highest stake first, ties broken by lower address. The
     * tie-break exists because "whoever the array happened to order first" is
     * a rule nobody can verify — and a set that isn't reproducible from chain
     * state is one nobody can audit us on.
     */
    function rotate() external {
        uint256 epoch = block.number / epochBlocks;
        if (epoch <= lastRotatedEpoch) revert TooEarly(epoch, lastRotatedEpoch);

        uint256 n = candidates.length;
        address[] memory eligible = new address[](n);
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            address c = candidates[i];
            if (!exiting[c] && stakeOf[c] >= minStake) eligible[count++] = c;
        }

        // Refuse rather than seat nobody. Reverting leaves the previous set in
        // place, which keeps the chain alive; committing an empty set would end
        // it, and no rule about who *deserves* a seat is worth that.
        if (count == 0) revert EmptySetRefused();

        // Same reasoning one step earlier: a set above zero but below the floor
        // is a set with no fault tolerance. Refusing is safe — the previous
        // validators keep validating — whereas committing hands the chain to a
        // group too small to survive one bad node.
        if (count < minValidators) revert BelowValidatorFloor(count, minValidators);

        uint256 seats = count < maxValidators ? count : maxValidators;

        // Partial selection sort: seats × count, both capped, so gas is bounded.
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
