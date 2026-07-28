// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITinyIssuance {
    function currentEpoch() external view returns (uint256);
    function serveBudget(uint256 epoch) external view returns (uint256);
    function mintServeReward(address server, uint256 epoch, uint256 amount) external returns (uint256);
}

/**
 * TinyServeRewards — serve-to-earn: you earn TinyUSDC by running a tiny that
 * serves real paid x402 requests.
 *
 * ┌ READ THIS FIRST: THIS CONTRACT IS AN ORACLE ────────────────────────────┐
 * │ "A request was served" is NOT an on-chain fact and cannot be made one.   │
 * │ The chain can see a TinyUSDC transfer. It cannot see whether an answer   │
 * │ came back, whether the answer was any good, or whether the payer and the │
 * │ payee are the same person with two keys. So this contract does not       │
 * │ *verify* service — it verifies SIGNATURES from a set of attestors who    │
 * │ claim to have witnessed service.                                        │
 * │                                                                          │
 * │ That is a trusted third party in a network whose validator set is        │
 * │ deliberately trustless. It is the honest phase-1 answer, and it is       │
 * │ labelled here rather than only in the docs, because an oracle sold as    │
 * │ trustless is worse than an oracle. Compare TinyIssuance.creditBlock():   │
 * │ that half needs nobody's word, because consensus writes block.coinbase.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * What the attestor is trusted FOR, precisely — so the trust can shrink later
 * instead of being rediscovered:
 *
 *   1. that the requests happened at all,
 *   2. that PAYER ≠ PAYEE, and that the payer was not funded by the payee.
 *      This is the self-dealing hole: settlement-derived issuance is trivially
 *      farmed by paying yourself in a loop and earning on both sides. The
 *      contract CANNOT check it (the chain sees two addresses, not one person),
 *      so the attestor must exclude such requests before signing. If it doesn't,
 *      serve issuance is farmable — that is a property of the oracle, not of
 *      this code, and no amount of Solidity here fixes it.
 *   3. that the epoch total it reports is the real total.
 *
 * What the attestor is NOT trusted for, because the code doesn't let it be:
 *   - It cannot exceed the serve budget (TinyIssuance enforces, and so does the
 *     cap below). A lying oracle can misallocate the serve half; it can never
 *     mint beyond the schedule, and it can never touch the validator half.
 *   - It cannot pay itself by editing the set alone unless it is already the
 *     whole set — set changes need `threshold` signatures from the CURRENT set.
 *
 * ── The attestor is a SET from day one ───────────────────────────────────────
 * It starts as one member on the devnet, but the SHAPE is m-of-n from the first
 * deployment: threshold signature checks, distinctness enforcement, and
 * self-governing membership. Starting single-signer with a "we'll generalise it
 * later" note is how a centralization point becomes permanent — the migration
 * to real multi-attestation is then a rewrite of the verification path, the
 * storage layout, and every caller, so it never happens.
 *
 * There is no owner. Membership changes are authorised by the attestors
 * themselves (threshold-of-current-set over an EIP-712 AttestorSetChange with a
 * replay nonce). A single operator key that could swap the attestor set at will
 * would make the whole signature scheme decorative.
 */
contract TinyServeRewards {
    ITinyIssuance public immutable issuance;

    address[] private attestors;
    mapping(address => bool) public isAttestor;
    /// Signatures required. Never 0, never > attestors.length.
    uint256 public threshold;
    /// Bumped on every set change so an old authorisation cannot be replayed.
    uint256 public setNonce;

    /**
     * Ceiling on one server's share of an epoch's serve budget, in bps.
     * Bounds how badly a compromised or buggy oracle can concentrate issuance:
     * even if it attests that one address served everything, that address is
     * capped and the remainder simply never mints.
     */
    uint256 public immutable maxServerBps;
    uint256 public constant BPS = 10_000;

    /**
     * EIP-712 domain, bound to chainId AND this contract's address.
     *
     * Both matter here specifically: TinyUSDC exists on the live 8469 and on
     * 8470, and this contract could be redeployed. Without the binding, an
     * attestation signed for one chain or one deployment would be valid on
     * another — a signature is only a claim about the thing it names.
     */
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant SERVE_ATTESTATION_TYPEHASH = keccak256(
        "ServeAttestation(address server,uint256 epoch,uint256 requestCount,uint256 volumeMicro,uint256 epochTotalVolumeMicro)"
    );
    bytes32 public constant ATTESTOR_SET_CHANGE_TYPEHASH =
        keccak256("AttestorSetChange(bytes32 attestorsHash,uint256 threshold,uint256 nonce)");

    /**
     * The epoch total each epoch's payouts are divided by, as first attested.
     *
     * Pinned on first claim and then ENFORCED: every later claim for that epoch
     * must carry the same total. Without this, an oracle (or a bug) could hand
     * each server a total that flatters it — every individual payout would look
     * correctly pro-rata while the epoch quietly over-distributed, and the only
     * symptom would be the last claimant reverting for reasons that look like
     * someone else's fault.
     */
    mapping(uint256 => uint256) public epochTotalVolume;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => uint256) public epochAttested;

    event ServeRewardClaimed(
        uint256 indexed epoch, address indexed server, uint256 amount, uint256 requestCount, uint256 volumeMicro
    );
    event AttestorSetChanged(address[] attestors, uint256 threshold, uint256 nonce);

    error BadConfig();
    error EpochNotOver(uint256 epoch, uint256 current);
    error AlreadyClaimed();
    error NothingAttested();
    error VolumeExceedsTotal(uint256 volume, uint256 total);
    error InconsistentEpochTotal(uint256 pinned, uint256 offered);
    error NotEnoughSignatures(uint256 got, uint256 need);
    error SignersNotAscending();
    error NotAnAttestor(address signer);
    error NothingToPay();

    /**
     * @param _issuance     TinyIssuance; must already have this address locked in
     *                      as its serveDistributor, or every claim reverts.
     * @param _attestors    Initial attestor set (may be one member — the shape is
     *                      still m-of-n).
     * @param _threshold    Signatures required.
     * @param _maxServerBps Per-server cap on an epoch's serve budget.
     */
    constructor(address _issuance, address[] memory _attestors, uint256 _threshold, uint256 _maxServerBps) {
        if (
            _issuance == address(0) ||
            _attestors.length == 0 ||
            _threshold == 0 ||
            _threshold > _attestors.length ||
            _maxServerBps == 0 ||
            _maxServerBps > BPS
        ) revert BadConfig();

        issuance = ITinyIssuance(_issuance);
        maxServerBps = _maxServerBps;
        _setAttestors(_attestors, _threshold);

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("TinyServeRewards")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function attestorCount() external view returns (uint256) {
        return attestors.length;
    }

    function attestorAt(uint256 i) external view returns (address) {
        return attestors[i];
    }

    function attestorList() external view returns (address[] memory) {
        return attestors;
    }

    /// The digest an attestor signs. Exposed so an off-chain signer can't guess wrong.
    function attestationDigest(
        address server,
        uint256 epoch,
        uint256 requestCount,
        uint256 volumeMicro,
        uint256 epochTotalVolumeMicro
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(SERVE_ATTESTATION_TYPEHASH, server, epoch, requestCount, volumeMicro, epochTotalVolumeMicro)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function setChangeDigest(address[] memory newAttestors, uint256 newThreshold, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTOR_SET_CHANGE_TYPEHASH, keccak256(abi.encodePacked(newAttestors)), newThreshold, nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /**
     * What `server` would be paid for `epoch` at the given attested numbers.
     * A view, so a server can check before spending anyone's gas — and so the
     * test can assert the payout equals the prediction rather than merely being
     * "some tokens".
     */
    function previewReward(uint256 epoch, uint256 volumeMicro, uint256 epochTotalVolumeMicro)
        public
        view
        returns (uint256)
    {
        if (epochTotalVolumeMicro == 0 || volumeMicro == 0) return 0;
        uint256 budget = issuance.serveBudget(epoch);
        uint256 amount = (budget * volumeMicro) / epochTotalVolumeMicro;
        uint256 cap = (budget * maxServerBps) / BPS;
        return amount > cap ? cap : amount;
    }

    /**
     * Claim serve issuance for a finished epoch against attestor signatures.
     *
     * Callable by ANYONE — the tokens go to `server` regardless of who submits,
     * so requiring the server to submit its own claim would only mean a server
     * that has gone offline loses work it already did. The signatures are the
     * authorisation; the sender is irrelevant.
     *
     * `sigs` must be 65-byte (r,s,v) signatures ordered by ASCENDING RECOVERED
     * ADDRESS. That ordering requirement is not fussiness: it makes duplicate
     * signers impossible to sneak past in O(n) without a nested loop or a
     * scratch mapping. Without a distinctness check, one attestor signing the
     * same digest `threshold` times would satisfy an m-of-n scheme by itself,
     * and the whole set would be theatre.
     */
    function claimServeReward(
        address server,
        uint256 epoch,
        uint256 requestCount,
        uint256 volumeMicro,
        uint256 epochTotalVolumeMicro,
        bytes[] calldata sigs
    ) external returns (uint256) {
        uint256 current = issuance.currentEpoch();
        // Finished epochs only. Mid-epoch, the attested total is still growing,
        // so a claim would divide by a denominator that hasn't happened yet —
        // the same trap as validator claims, and the first claimant would take
        // an outsized share of an epoch nobody has finished serving.
        if (epoch >= current) revert EpochNotOver(epoch, current);
        if (claimed[epoch][server]) revert AlreadyClaimed();
        if (server == address(0) || requestCount == 0 || volumeMicro == 0) revert NothingAttested();
        if (volumeMicro > epochTotalVolumeMicro) revert VolumeExceedsTotal(volumeMicro, epochTotalVolumeMicro);

        uint256 pinned = epochTotalVolume[epoch];
        if (pinned == 0) epochTotalVolume[epoch] = epochTotalVolumeMicro;
        else if (pinned != epochTotalVolumeMicro) revert InconsistentEpochTotal(pinned, epochTotalVolumeMicro);

        _requireSignatures(
            attestationDigest(server, epoch, requestCount, volumeMicro, epochTotalVolumeMicro), sigs
        );

        uint256 amount = previewReward(epoch, volumeMicro, epochTotalVolumeMicro);
        if (amount == 0) revert NothingToPay();

        claimed[epoch][server] = true;
        epochAttested[epoch] += volumeMicro;
        // TinyIssuance holds the budget invariant. If this contract's arithmetic
        // ever disagreed with the schedule, the mint reverts there rather than
        // over-issuing here — the schedule does not trust its own distributor.
        issuance.mintServeReward(server, epoch, amount);
        emit ServeRewardClaimed(epoch, server, amount, requestCount, volumeMicro);
        return amount;
    }

    /**
     * Rotate the attestor set. Authorised by `threshold` signatures from the
     * CURRENT set — the set governs itself, and there is no operator key that
     * can bypass it.
     *
     * This is the path from a single trusted attestor to real multi-attestation
     * without redeploying, which is the entire reason the set exists on day one.
     * Note what it also means: a set of one can replace itself with anything.
     * That is not a loophole, it is what "one trusted attestor" already implies —
     * and it is exactly why the count should grow.
     */
    function setAttestors(address[] calldata newAttestors, uint256 newThreshold, bytes[] calldata sigs) external {
        _requireSignatures(setChangeDigest(newAttestors, newThreshold, setNonce), sigs);
        setNonce += 1;
        _setAttestors(newAttestors, newThreshold);
    }

    function _setAttestors(address[] memory next, uint256 nextThreshold) private {
        if (next.length == 0 || nextThreshold == 0 || nextThreshold > next.length) revert BadConfig();

        for (uint256 i = 0; i < attestors.length; i++) isAttestor[attestors[i]] = false;
        delete attestors;

        for (uint256 i = 0; i < next.length; i++) {
            address a = next[i];
            // A duplicate would inflate attestors.length without adding a signer,
            // making `threshold` unreachable and freezing serve issuance for good.
            if (a == address(0) || isAttestor[a]) revert BadConfig();
            isAttestor[a] = true;
            attestors.push(a);
        }
        threshold = nextThreshold;
        emit AttestorSetChanged(next, nextThreshold, setNonce);
    }

    function _requireSignatures(bytes32 digest, bytes[] calldata sigs) private view {
        if (sigs.length < threshold) revert NotEnoughSignatures(sigs.length, threshold);

        address last = address(0);
        uint256 valid;
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = _recover(digest, sigs[i]);
            if (!isAttestor[signer]) revert NotAnAttestor(signer);
            // Strictly ascending ⇒ every signer distinct, in one pass.
            if (signer <= last) revert SignersNotAscending();
            last = signer;
            valid++;
        }
        if (valid < threshold) revert NotEnoughSignatures(valid, threshold);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadConfig();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let p := sig.offset
            r := calldataload(p)
            s := calldataload(add(p, 32))
            v := byte(0, calldataload(add(p, 64)))
        }
        // Accept the 0/1 encoding some signers emit as well as 27/28.
        if (v < 27) v += 27;
        // Reject the high-S malleable twin: for any valid signature there is a
        // second (r, -s) that recovers the same signer, so accepting both means
        // one attestation has two distinct byte encodings. Nothing here indexes
        // by signature bytes today, but "same claim, two hashes" is the shape of
        // a replay bug in whatever indexes it tomorrow.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadConfig();
        }
        address signer = ecrecover(digest, v, r, s);
        // ecrecover returns 0 on failure instead of reverting. Left unchecked,
        // address(0) would flow into the isAttestor lookup and a garbage
        // signature would read as "not an attestor" — the right outcome for the
        // wrong reason, and a real hazard if address(0) ever entered the set.
        if (signer == address(0)) revert BadConfig();
        return signer;
    }
}
