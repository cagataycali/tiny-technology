// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IEpochSource {
    function epochBlocks() external view returns (uint256);
}

/**
 * TinyValidatorAttendance — on-chain proof that a seated validator is ACTUALLY
 * THERE.
 *
 * ┌ The gap this closes ────────────────────────────────────────────────────────┐
 * │ `TinyValidators` enforces stake and voluntary exit and has NO notion of a    │
 * │ validator being present. A staked-and-vanished seat is indistinguishable    │
 * │ from a working one — so 8470's fault tolerance degrades silently every time │
 * │ somebody joins and leaves, which on a permissionless chain is the NORMAL    │
 * │ case, not an incident. c15 proved this the expensive way: the devnet halted │
 * │ at block 11857 with 5 seats and 4 live processes, and every acceptance      │
 * │ check called the set healthy, because every check judged its SHAPE.         │
 * │                                                                            │
 * │ c15 shipped DETECTION (off-chain, `assessSetLiveness`, evidence from        │
 * │ `eth_getBlockByNumber().miner`). This contract is the on-chain EVIDENCE     │
 * │ LAYER that an enforcement rule can be built on, because a rule the chain    │
 * │ enforces cannot read an operator's monitoring script.                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️⚠️ THE DESIGN IS ONE LINE, AND EVERY OTHER SHAPE I CONSIDERED WAS A CHAIN
 * TAKEOVER. `attest()` requires `msg.sender == block.coinbase`.
 *
 * The obvious alternative is what `TinyIssuance.creditBlock()` already does:
 * permissionless, credits `block.coinbase`, so anybody may record anybody. That
 * is correct for PAYING a proposer (the worst a stranger can do is help someone
 * else) and catastrophic for JUDGING one, because it makes attendance OPT-IN
 * EVIDENCE — and a validator proposing a block chooses that block's
 * transactions. So a cheat includes its own credit tx in its own blocks, never
 * helps anyone else, and honest validators who simply aren't running the credit
 * script record nothing, look absent, and lose their seats to it. No stake
 * required, no equivocation, no fault: the enforcement rule hands over the
 * chain. That is the "rich candidate unseats honest validators during a blip"
 * hazard in its sharpest form — it doesn't even need to be rich.
 *
 * `msg.sender == block.coinbase` fixes it by making the evidence:
 *   • UNFORGEABLE — you cannot land your own signed tx in a block you did not
 *     propose while your address is its coinbase. Consensus writes coinbase;
 *     the signature is checked by the EVM. Both halves are outside the caller's
 *     control, and only their conjunction is accepted.
 *   • SELF-SERVICEABLE — a live validator attests unilaterally, needing nobody's
 *     cooperation. Its seat can never be lost to another party's inaction.
 *   • PROOF OF THE RIGHT THING — not "my key is online" (a heartbeat from a
 *     laptop proves that while the node is dead) but "my node produced a block".
 *     That is the property QBFT liveness actually depends on.
 *
 * And exactly ONE evidence class, deliberately. A supplementary
 * "anyone-may-record" signal alongside this one would recreate the same defect
 * in a place nobody looks: two writers whose records mean different things, read
 * through a single predicate.
 *
 * ── What this contract deliberately does NOT do ───────────────────────────────
 * NOTHING here unseats, slashes, or withholds a reward. It is a RECORD and a set
 * of verdicts about that record, with no reference to the registry at all. That
 * mirrors P4: `TinySlashing` shipped a docket before `TinyValidatorsSlashable`
 * shipped the consequence, and the separation is what let the consequence be
 * designed under its own scrutiny (the fail-open court read, the floor beating
 * enforcement) instead of being smuggled in with the evidence.
 *
 * ⚠️ SO ADOPTION, NOT CODE, IS WHAT MAKES ABSENCE MEAN ABSENCE. Until validators
 * run an attest loop, a silent record means "nobody attests here", not "this
 * validator is dead" — and an enforcement rule switched on early would convict
 * the whole honest set at once. `participation()` exists to make those two
 * readings distinguishable BEFORE anything is enforced, and `verdict()` refuses
 * to answer rather than guess. Same call as c15's `assessSetLiveness` returning
 * `unknown` on a short window: declining beats both errors, because a false
 * stall trains an operator to ignore the check and a false pass is the bug the
 * check exists for.
 *
 * ⚠️ HOLDS NO FUNDS, HAS NO OWNER, NO PAUSE, NO LOCK, AND NOTHING DEPENDS ON IT
 * FOR LIVENESS. Safe to redeploy at will (unlike TinyIssuance/TinyServeRewards,
 * whose wiring is irreversible). A replacement loses history, nothing else.
 */
contract TinyValidatorAttendance {
    /**
     * Epoch length, in blocks. MUST equal the validator registry's, or this
     * contract's epochs are not the epochs seats change on and every verdict is
     * about the wrong window.
     *
     * The constructor proves the match against a live registry rather than
     * trusting the deploy script's argument — a mismatch is otherwise silent,
     * and silently-wrong attendance is worse than no attendance. The registry
     * address is used ONCE, in the constructor, and never stored: a runtime
     * dependency on the registry is exactly the coupling this contract avoids
     * (see the header — nothing here may ever be able to affect rotation).
     */
    uint256 public immutable epochBlocks;

    /**
     * The genesis epoch of this deployment. Verdicts before it are `NoRecord`,
     * not `Absent`: this contract cannot testify about blocks produced before it
     * existed, and reading its own absence as the validator's would convict
     * every founder for the chain's entire history up to deployment.
     */
    uint256 public immutable startEpoch;

    /**
     * Bound on `absentStreak`'s backward scan. A view is free to callers but not
     * to a contract that calls it, and an unbounded loop over epochs would make
     * this unusable from inside a future enforcement rule — i.e. from the only
     * place it is ever load-bearing.
     */
    uint256 public constant MAX_LOOKBACK = 64;

    /// epoch => validator => attestations recorded in that epoch.
    mapping(uint256 => mapping(address => uint256)) public attestationsIn;
    /// epoch => how many DISTINCT validators attested. The participation signal.
    mapping(uint256 => uint256) public attestorsIn;
    /// validator => the most recent epoch it attested in. 0 = never (see everAttested).
    mapping(address => uint256) public lastAttestedEpoch;
    /// Explicit, because epoch 0 is a real epoch and `lastAttestedEpoch == 0` is ambiguous.
    mapping(address => bool) public everAttested;
    /// Total attestations, all validators, all epochs — a one-read liveness pulse.
    uint256 public totalAttestations;

    /**
     * Attendance verdict for (validator, epoch).
     *
     * `EpochOpen` and `NoRecord` both mean "this is not evidence of absence",
     * and they are separate because the remedies are opposite: EpochOpen means
     * wait, NoRecord means the question is unanswerable for that epoch and
     * always will be. Collapsing either into `Absent` is the c67 defect — a
     * not-yet state read as a negative one, which is how a UI ends up telling
     * somebody a thing happened that never did.
     */
    enum Attendance {
        EpochOpen, // the epoch has not finished; a validator's turn may still come
        NoRecord, // before this contract existed — it cannot testify
        Present, // attested at least once
        Absent // finished epoch, within recorded history, zero attestations
    }

    /// Emitted per accepted attestation. `blockNumber` is the block it proposed.
    event Attested(uint256 indexed epoch, address indexed validator, uint256 blockNumber, uint256 countInEpoch);

    /**
     * `msg.sender` is not the proposer of this block, so the claim is unproven.
     * Reverting (rather than recording a weaker fact) is the whole security
     * property — see the header.
     */
    error NotProposer(address caller, address proposer);
    error BadConfig();
    /// The constructor's epoch-length check against the live registry failed.
    error EpochLengthMismatch(uint256 expected, uint256 registryValue);

    /**
     * @param _epochBlocks  Epoch length. Must match `registry.epochBlocks()`.
     * @param registry      A live validator registry (TinyValidators or
     *                      TinyValidatorsSlashable) read ONCE to prove the epoch
     *                      length matches. Checked by VALUE, not identity, so
     *                      either registry works across the P4 swap.
     */
    constructor(uint256 _epochBlocks, address registry) {
        if (_epochBlocks == 0 || registry == address(0)) revert BadConfig();

        // A plain external call: reverting here is correct and safe, because a
        // failed constructor is a failed DEPLOY — nothing is live to break. This
        // is the one place where fail-closed is right, and the reason is that
        // the alternative (deploying against a registry whose epochs differ) is
        // a contract that answers confidently about the wrong windows forever.
        uint256 fromRegistry = IEpochSource(registry).epochBlocks();
        if (fromRegistry != _epochBlocks) revert EpochLengthMismatch(_epochBlocks, fromRegistry);

        epochBlocks = _epochBlocks;
        startEpoch = block.number / _epochBlocks;
    }

    // ── the record ───────────────────────────────────────────────────────────

    function currentEpoch() public view returns (uint256) {
        return block.number / epochBlocks;
    }

    /**
     * Record that the caller proposed THIS block.
     *
     * Callable only by the block's own proposer, which is the entire mechanism.
     * Idempotent in effect but not in accounting: repeated calls within an epoch
     * increment the count and are harmless, because every verdict below asks
     * `> 0`, never "how many". Counting anyway costs one SSTORE and makes the
     * record useful for the thing it is NOT allowed to be used for — see the
     * warning on `attestationsIn`.
     *
     * ⚠️ EXPECT THIS TO REVERT MOST OF THE TIME, and that is not a defect. A
     * validator cannot choose which block its transaction lands in; the tx is
     * only valid in a block that validator itself proposes. With n validators an
     * untimed attempt succeeds roughly 1/n of the time. On a zero-gas chain a
     * revert costs nothing, so the operator loop is "send, ignore the revert,
     * send again" — and the acceptance suite does exactly that. A rule that
     * accepted a cheaper claim would be a rule that accepted an unprovable one.
     */
    function attest() external {
        address proposer = block.coinbase;
        if (msg.sender != proposer) revert NotProposer(msg.sender, proposer);

        uint256 epoch = currentEpoch();
        uint256 prior = attestationsIn[epoch][msg.sender];
        if (prior == 0) attestorsIn[epoch] += 1;
        attestationsIn[epoch][msg.sender] = prior + 1;
        lastAttestedEpoch[msg.sender] = epoch;
        everAttested[msg.sender] = true;
        totalAttestations += 1;

        emit Attested(epoch, msg.sender, block.number, prior + 1);
    }

    // ── verdicts ─────────────────────────────────────────────────────────────

    /**
     * Did `v` prove presence in `epoch`? Total, never reverts, and refuses in
     * the two cases where a negative answer would be a fabrication.
     *
     * ⚠️ `Absent` means "produced no PROVEN block in that epoch", which is not
     * identical to "produced no block". A live validator that never runs an
     * attest loop is `Absent` here — and that is precisely why enforcement must
     * read `participation()` alongside this, and why this contract does not
     * enforce anything itself.
     */
    function verdict(address v, uint256 epoch) public view returns (Attendance) {
        if (epoch >= currentEpoch()) return Attendance.EpochOpen;
        if (epoch < startEpoch) return Attendance.NoRecord;
        return attestationsIn[epoch][v] > 0 ? Attendance.Present : Attendance.Absent;
    }

    /// Convenience: `verdict(v, epoch) == Absent`. Never true for an open epoch.
    function wasAbsent(address v, uint256 epoch) external view returns (bool) {
        return verdict(v, epoch) == Attendance.Absent;
    }

    /**
     * Consecutive FINISHED epochs, most recent first, in which `v` proved
     * nothing. Stops at `MAX_LOOKBACK`, at `startEpoch`, and at the first epoch
     * `v` attested in.
     *
     * A streak, not a single epoch, because one empty epoch is weak evidence:
     * epochBlocks is 20 and a 6-seat round-robin gives each validator ~3 turns,
     * so a brief network blip or an unlucky tx-pool moment can legitimately cost
     * one epoch. Any enforcement rule should demand a streak, and the length is
     * that rule's parameter, not this record's.
     *
     * Caps at MAX_LOOKBACK rather than reporting the true length — an
     * enforcement threshold larger than the lookback would silently never fire,
     * so `atCap` is returned instead of being inferable only by comparison.
     */
    function absentStreak(address v) external view returns (uint256 streak, bool atCap) {
        uint256 current = currentEpoch();
        if (current == 0) return (0, false);
        uint256 epoch = current - 1; // the newest FINISHED epoch
        while (streak < MAX_LOOKBACK) {
            if (epoch < startEpoch) break;
            if (attestationsIn[epoch][v] > 0) break;
            streak++;
            if (epoch == 0) break;
            epoch--;
        }
        return (streak, streak == MAX_LOOKBACK);
    }

    /**
     * How many distinct validators proved presence in `epoch` — the number that
     * decides whether this record means anything at all.
     *
     * An enforcement rule comparing one validator's silence against a
     * `participation` of 0 is reading a network that doesn't attest, not a dead
     * validator, and acting on it would convict the honest set. Comparing
     * against a participation close to the seat count is reading real evidence.
     * The threshold is the enforcing contract's decision; publishing the
     * denominator is this one's job.
     *
     * (c62's rule, from the web loop of all places: the denominator has to count
     * the same rows as the number beside it. Here the numerator is one
     * validator's attestations and the denominator is the attesting POPULATION,
     * so both are counted over the same epoch and neither is a stand-in for the
     * seat count — which this contract deliberately cannot see.)
     */
    function participation(uint256 epoch) external view returns (uint256) {
        return attestorsIn[epoch];
    }

    /**
     * Is `attest()` callable by `v` right now? Lets an operator loop poll
     * instead of blind-firing, and makes the 1/n revert rate legible rather than
     * looking like a broken contract.
     */
    function attestableBy(address v) external view returns (bool) {
        return v == block.coinbase;
    }

    /// The proposer of the current block, as the EVM sees it. Verified on 8470
    /// to equal the QBFT proposer — the fact the whole contract rests on.
    function currentProposer() external view returns (address) {
        return block.coinbase;
    }
}
