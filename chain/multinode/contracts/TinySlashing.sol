// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IValidatorRegistry {
    function stakeOf(address validator) external view returns (uint256);
    function isActive(address validator) external view returns (bool);
}

/**
 * TinySlashing — the equivocation court for chain 8470.
 *
 * Open validator entry (P2) means anyone can seat themselves by staking. Until
 * something punishes misbehaviour, that stake bounds only how many identities you
 * can AFFORD, not how they BEHAVE — an unslashed stake is a deposit, not a bond,
 * and TinyValidators says so in its own header comment. This contract is the
 * first half of making it a bond: it adjudicates the one validator fault that is
 * objectively provable on-chain.
 *
 * ┌ WHAT THIS CONTRACT IS AND IS NOT ───────────────────────────────────────┐
 * │ IS:     a court. It decides, from cryptographic evidence anyone can      │
 * │         submit, whether a given validator double-signed. A conviction is │
 * │         permanent and public.                                           │
 * │ IS NOT: an executioner. It does NOT burn stake, because it cannot:      │
 * │         TinyValidators is already deployed and has no admin, no hook,   │
 * │         and no upgrade path — by design. Enforcement needs a registry   │
 * │         that reads `isEquivocator()`, which means a registry swap.      │
 * │                                                                          │
 * │ So today a conviction costs the validator its reputation and nothing     │
 * │ else. That is stated here rather than only in the docs, for the same     │
 * │ reason TinyServeRewards calls itself an oracle: a court sold as a        │
 * │ guillotine is worse than a court.                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── How a QBFT double-signature is proven, and how it was verified ──────────
 *
 * Every QBFT validator that commits to a block appends a "commit seal" —
 * a secp256k1 signature — to the block's extraData. Both digests below start from
 * the same preimage: RLP(header) with extraData's SEAL LIST REPLACED BY []. Plain
 * RLP of the header as `eth_getBlockByNumber` returns it reproduces NEITHER — the
 * seals are excluded, which is exactly what makes them signable.
 *
 * From that one preimage there are TWO different digests, and conflating them is
 * the trap this contract was rewritten to escape:
 *
 *     SEAL DIGEST = keccak256(preimage)                         — what a seal signs
 *     ANCHOR      = keccak256(preimage, extraData ROUND EMPTIED) — the block hash
 *
 * The block hash empties extraData's round field; the seal digest keeps it. For a
 * round-0 block the two coincide, which is how an earlier version of this contract
 * passed its tests while being wrong: the devnet had produced nothing but round-0
 * blocks. Once the validator set grew and real round changes appeared, seals on
 * those blocks recovered ONLY against the round-kept digest and the block hash
 * matched ONLY the round-zeroed one. Measured over 59 consecutive blocks, 15 of
 * them at round ≠ 0: anchor == blockhash 59/59, and seals recover to seated
 * validators 59/59 — but only with the two digests computed separately.
 *
 * Two consequences, both load-bearing:
 *
 *   1. Because the ANCHOR is the block hash, `blockhash(n)` lets this contract
 *      confirm that a submitted header preimage is a REAL block of THIS chain — no
 *      oracle, no trusted relayer. Compare TinyIssuance.creditBlock(): the chain
 *      testifies for itself again.
 *   2. Equivocation evidence is SELF-PROVING. Two signatures by one key over two
 *      different SEAL digests that both claim the same height and round is a fault
 *      no matter which (if either) block is canonical. Nobody has to be trusted to
 *      report it, and nobody can suppress it.
 *
 * Note which of the two is derived, because it decides how a mistake fails. The
 * seal digest is the plain keccak of exactly the bytes submitted — it decides WHO
 * signed, so it is never recomputed or adjusted. The anchor is the derived one, and
 * if that derivation is ever wrong the proof fails as NotCanonical. A bug there
 * costs a conviction; a bug the other way round would cost an innocent validator.
 *
 * ── The false-positive traps, which matter more than the detection ──────────
 *
 * A slashing rule that can burn honest stake is worse than one that misses
 * faults, so each of these narrows the rule on purpose:
 *
 *   A. ROUND CHANGES ARE NOT EQUIVOCATION. When a QBFT round times out, the same
 *      height is re-proposed in a new round, and an honest validator may commit
 *      to a different block than it did before. Both blocks are real and both are
 *      signed, so a naive "two seals at one height" rule would slash the entire
 *      honest set the first time the network hiccuped. This contract therefore
 *      requires the same height AND THE SAME ROUND — the one state in which QBFT
 *      admits exactly one proposal, making a second signature indefensible.
 *
 *      The round is also why the two digests exist. It changes the SEAL digest but
 *      not the block hash, which is what a round change has to mean: the same block
 *      keeps its identity across rounds while each round's seals sign something
 *      distinct. Zeroing it for the anchor is not a workaround — it is that rule.
 *
 *   B. HEADERS CARRY NO CHAIN ID. Ethereum block headers have no chainId field,
 *      so a seal from a completely different QBFT network at the same
 *      height/round would otherwise look like equivocation here. That would make
 *      running the same key on a testnet a slashable offence retroactively. The
 *      fix is the anchor: one of the two headers must be canonical on THIS chain
 *      per `blockhash`, and a foreign header can never be.
 *
 *   C. ONE HEADER, TWO ENCODINGS. The digests must actually differ, or a
 *      "proof" could present the same block twice.
 *
 * ⚠️ THE HONEST LIMIT: `blockhash` only reaches back 256 blocks (~8.5 min at 2s),
 * so the anchor forces evidence to be submitted inside that window. Older
 * equivocation is unprovable HERE. That is a real gap and the alternative was
 * worse: dropping the anchor to accept ancient evidence would import trap B and
 * make honest keys slashable by a stranger's unrelated chain. A future version
 * with a checkpointed header history can widen the window without weakening it.
 *
 * ⚠️ ALSO OUT OF SCOPE, deliberately: censorship, invalid-block production, and
 * general safety faults. None is objectively provable on-chain — a censored
 * transaction is indistinguishable from one that never arrived. Documented as a
 * known limit rather than silently omitted, per the design doc §3.3.
 */
contract TinySlashing {
    /// The registry whose stake a conviction is evidence against.
    IValidatorRegistry public immutable validators;

    /**
     * How far back evidence may reach, in blocks. Hard-capped at 256 because
     * `blockhash` returns zero beyond that — a larger value would not extend the
     * window, it would just make every proof at the edge fail as "not canonical"
     * and look like a bug in the submitter's evidence.
     */
    uint256 public immutable maxEvidenceAge;
    uint256 public constant BLOCKHASH_LIMIT = 256;

    struct Conviction {
        /// Block at which the conviction was recorded. 0 means never convicted.
        uint256 provenAtBlock;
        /// The height the validator double-signed.
        uint256 faultHeight;
        /// The QBFT round of the fault.
        uint256 faultRound;
        /**
         * Stake the validator held when convicted — what SHOULD have been burned.
         * Recorded because this court cannot burn it: without this number, the
         * cost of having no enforcement path would be invisible after the fact.
         */
        uint256 stakeAtConviction;
        /// Whether the validator was seated at the moment of conviction.
        bool seatedAtConviction;
        /// Who submitted the evidence.
        address reporter;
    }

    mapping(address => Conviction) public convictions;
    uint256 public convictionCount;

    event Equivocation(
        address indexed validator,
        uint256 indexed height,
        uint256 round,
        bytes32 canonicalHash,
        bytes32 conflictingHash,
        uint256 stakeAtConviction,
        address reporter
    );

    error BadConfig();
    error EvidenceTooOld(uint256 height, uint256 current, uint256 maxAge);
    error EvidenceFromTheFuture(uint256 height, uint256 current);
    error NotCanonical(uint256 height, bytes32 claimed, bytes32 actual);
    error SameBlock();
    error HeightMismatch(uint256 canonical, uint256 conflicting);
    error RoundMismatch(uint256 canonical, uint256 conflicting);
    error DifferentSigners(address canonicalSigner, address conflictingSigner);
    error NotSealedBy(address recovered);
    error AlreadyConvicted(address validator, uint256 atBlock);
    error BadHeader();
    error BadSignature();
    /// The round is too large to anchor in place — see _hashWithZeroedRound.
    error RoundNotAnchorable();

    constructor(address _validators, uint256 _maxEvidenceAge) {
        if (_validators == address(0) || _maxEvidenceAge == 0 || _maxEvidenceAge > BLOCKHASH_LIMIT) {
            revert BadConfig();
        }
        validators = IValidatorRegistry(_validators);
        maxEvidenceAge = _maxEvidenceAge;
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// The one function a future registry needs. Kept trivial for that reason.
    function isEquivocator(address validator) external view returns (bool) {
        return convictions[validator].provenAtBlock != 0;
    }

    /**
     * Decode the height and QBFT round from a sealless header preimage.
     *
     * Public and pure so the acceptance test can compare this parser against a
     * real client's decoding of real blocks. A header parser that is only ever
     * exercised by its own hand-written fixtures is a parser that agrees with
     * itself; the only test that means anything is agreement with the chain.
     */
    function headerFields(bytes calldata header) public pure returns (uint256 number, uint256 round) {
        (number, round,,) = _walk(header);
    }

    /**
     * The single pass both digests need: the height, the round, and WHERE the round
     * sits in the preimage.
     *
     * The offset/length are what the anchor is built from, and they come from this
     * same walk on purpose. Locating the round twice — once to read it, once to
     * blank it — is two chances to disagree, and a disagreement here would mean the
     * bytes checked against `blockhash` are not the bytes whose round was verified.
     */
    function _walk(bytes calldata header)
        private
        pure
        returns (uint256 number, uint256 round, uint256 roundOff, uint256 roundLen)
    {
        // Header itself: RLP list. Its payload starts where the outer prefix ends.
        uint256 off = _enterList(header, 0);
        // 0..7: parentHash, sha3Uncles, miner, stateRoot, txRoot, receiptsRoot,
        //       logsBloom, difficulty.
        off = _skip(header, off, 8);
        // 8: number
        (number, off) = _readUint(header, off);
        // 9..11: gasLimit, gasUsed, timestamp.
        off = _skip(header, off, 3);
        // 12: extraData — a byte string whose contents are themselves an RLP list
        //     [vanity, validators[], vote, round, seals[]].
        off = _enterExtraData(header, off);
        // inner 0..2: vanity, validators, vote.
        off = _skip(header, off, 3);
        // inner 3: round.
        (round, roundOff, roundLen) = _readUintAt(header, off);
    }

    /// Payload offset of the RLP list at `off`. Reverts if it isn't a list.
    function _enterList(bytes calldata b, uint256 off) private pure returns (uint256) {
        (uint256 o,, bool isList) = _item(b, off);
        if (!isList) revert BadHeader();
        return o;
    }

    /**
     * Step into extraData's inner list.
     *
     * The two length checks are the interesting part: extraData is a STRING at
     * the header level whose bytes happen to be a list, so a header that declared
     * an inner list running past extraData's own end could otherwise let the
     * parser read the round out of the NEXT header field. `io + il != xo + xl`
     * refuses anything but an exact fit.
     */
    function _enterExtraData(bytes calldata b, uint256 off) private pure returns (uint256) {
        (uint256 xo, uint256 xl, bool xlist) = _item(b, off);
        if (xlist) revert BadHeader();
        (uint256 io, uint256 il, bool ilist) = _item(b, xo);
        if (!ilist) revert BadHeader();
        if (io + il != xo + xl) revert BadHeader();
        return io;
    }

    function _skip(bytes calldata b, uint256 off, uint256 count) private pure returns (uint256) {
        for (uint256 i = 0; i < count; i++) {
            (uint256 o, uint256 l,) = _item(b, off);
            off = o + l;
        }
        return off;
    }

    function _readUint(bytes calldata b, uint256 off) private pure returns (uint256 value, uint256 next) {
        (uint256 o, uint256 l, bool isList) = _item(b, off);
        if (isList) revert BadHeader();
        value = _uintAt(b, o, l);
        next = o + l;
    }

    /// As _readUint, but also reports where the payload is — see _walk.
    function _readUintAt(bytes calldata b, uint256 off)
        private
        pure
        returns (uint256 value, uint256 dataOff, uint256 dataLen)
    {
        (uint256 o, uint256 l, bool isList) = _item(b, off);
        if (isList) revert BadHeader();
        value = _uintAt(b, o, l);
        dataOff = o;
        dataLen = l;
    }

    /**
     * The digest a QBFT commit seal signs: the preimage exactly as submitted.
     *
     * Deliberately NOT the block hash — see the header comment. This is the value
     * that decides which key gets convicted, so it is never adjusted or rederived.
     */
    function sealDigest(bytes calldata header) public pure returns (bytes32) {
        return keccak256(header);
    }

    /**
     * The canonical block hash of a sealless header preimage: the same bytes with
     * extraData's round replaced by RLP's empty string, which is what `blockhash`
     * returns.
     *
     * "Replaced by empty", NOT "zeroed" — checked byte-by-byte against a real
     * round-1 block, the client's hash preimage differs from the seal's in exactly
     * one byte, and that byte is 0x80 (RLP empty), not 0x00. A zero payload byte
     * encodes the *value* zero, which is a different string, and hashes differently.
     * The distinction is invisible at round 0 and silently wrong everywhere else.
     */
    function anchorDigest(bytes calldata header) public pure returns (bytes32) {
        (,, uint256 roundOff, uint256 roundLen) = _walk(header);
        return _hashWithZeroedRound(header, roundOff, roundLen);
    }

    /**
     * Substitution in place, which is why RoundNotAnchorable can exist.
     *
     * Rounds 1..127 are RLP's single-byte self-encoding, so swapping that byte for
     * 0x80 yields the empty-string encoding at IDENTICAL length and every enclosing
     * length prefix stays valid. A round ≥ 128 encodes as two bytes (0x81 0xNN), so
     * emptying it would shorten the payload and invalidate both the extraData string
     * prefix and the outer header list prefix — the anchor would have to be rebuilt,
     * not patched.
     *
     * This refuses instead, because reaching round 128 means 128 consecutive
     * consensus timeouts at ONE height, and re-implementing RLP re-encoding for that
     * case would add exactly the kind of arithmetic that convicts the wrong address
     * when it is wrong. An explicit revert also beats letting it fall through to
     * NotCanonical, which would read as "your evidence is fake" rather than "this
     * court cannot anchor that round".
     */
    function _hashWithZeroedRound(bytes calldata header, uint256 roundOff, uint256 roundLen)
        private
        pure
        returns (bytes32)
    {
        // Round 0 already encodes AS the empty string: the preimage is its own
        // anchor, which is why the two digests coincide there.
        if (roundLen == 0) return keccak256(header);
        // Self-encoding form: the payload byte IS the item, so it is < 0x80.
        if (roundLen != 1 || uint8(header[roundOff]) >= 0x80) revert RoundNotAnchorable();
        bytes memory patched = header;
        patched[roundOff] = 0x80;
        return keccak256(patched);
    }

    // ── the court ────────────────────────────────────────────────────────────

    /**
     * Convict a validator of equivocation.
     *
     * Permissionless: the evidence is either valid or it is not, so who submits
     * it is irrelevant — and a court only the operator may petition is not a
     * court. There is no bounty, on purpose: a reward for convictions is a reward
     * for entrapment, and with zero-price gas submitting evidence already costs
     * the reporter nothing.
     *
     * @param height             The height of the fault. Must be within
     *                           `maxEvidenceAge` so `blockhash` can anchor it.
     * @param canonicalHeader    Sealless header preimage of the REAL block at
     *                           `height` — its ANCHOR (keccak with extraData's
     *                           round zeroed) must equal `blockhash(height)`.
     * @param canonicalSeal      65-byte commit seal by the accused over that block.
     * @param conflictingHeader  Sealless header preimage of the conflicting block.
     * @param conflictingSeal    65-byte commit seal by the accused over THAT one.
     * @return accused The convicted validator.
     */
    function submitEquivocation(
        uint256 height,
        bytes calldata canonicalHeader,
        bytes calldata canonicalSeal,
        bytes calldata conflictingHeader,
        bytes calldata conflictingSeal
    ) external returns (address accused) {
        uint256 round = _checkEvidence(height, canonicalHeader, conflictingHeader);
        accused = _checkSeals(
            keccak256(canonicalHeader), canonicalSeal, keccak256(conflictingHeader), conflictingSeal
        );

        // One conviction per validator. Re-convicting would let anyone overwrite
        // the recorded stake and reporter of an existing verdict, rewriting
        // history for free; the first proof is the one that stands.
        uint256 already = convictions[accused].provenAtBlock;
        if (already != 0) revert AlreadyConvicted(accused, already);

        uint256 stake = validators.stakeOf(accused);
        convictions[accused] = Conviction({
            provenAtBlock: block.number,
            faultHeight: height,
            faultRound: round,
            stakeAtConviction: stake,
            seatedAtConviction: validators.isActive(accused),
            reporter: msg.sender
        });
        convictionCount += 1;

        emit Equivocation(
            accused, height, round, keccak256(canonicalHeader), keccak256(conflictingHeader), stake, msg.sender
        );
    }

    /**
     * Everything about the evidence that does not involve signatures.
     * Returns the agreed round.
     */
    function _checkEvidence(uint256 height, bytes calldata canonicalHeader, bytes calldata conflictingHeader)
        private
        view
        returns (uint256)
    {
        if (height >= block.number) revert EvidenceFromTheFuture(height, block.number);
        if (block.number - height > maxEvidenceAge) {
            revert EvidenceTooOld(height, block.number, maxEvidenceAge);
        }

        // Trap C: the same block presented twice is not a conflict. Compared on the
        // SEAL digest, because that is what the two signatures are over — two
        // preimages differing only in their round would hash alike as anchors while
        // being genuinely different things to sign.
        if (keccak256(canonicalHeader) == keccak256(conflictingHeader)) revert SameBlock();

        // Parse both, and get the round's location from the same walk that reads it
        // so the anchor below blanks the field this check just validated.
        (uint256 n1, uint256 r1, uint256 ro, uint256 rl) = _walk(canonicalHeader);
        (uint256 n2, uint256 r2,,) = _walk(conflictingHeader);

        // Trap B, the anchor: this proves the first header is a real block of
        // THIS chain, so a seal from some other network can never be half of a
        // conviction here. Note the anchor is NOT the seal digest — the block hash
        // zeroes extraData's round, so on any block from a round > 0 the two differ
        // and only this one can be compared to `blockhash`.
        bytes32 anchor = _hashWithZeroedRound(canonicalHeader, ro, rl);
        bytes32 actual = blockhash(height);
        if (actual != anchor) revert NotCanonical(height, anchor, actual);

        // The canonical side's height is already implied by the blockhash match, so
        // checking it again is really a check on the PARSER: if this disagrees with
        // the chain, the whole rule is unsound and it must fail here rather than
        // convict someone on a misread field.
        if (n1 != height) revert HeightMismatch(n1, height);
        if (n1 != n2) revert HeightMismatch(n1, n2);
        // Trap A: a different round is a legitimate QBFT round change, not a fault.
        if (r1 != r2) revert RoundMismatch(r1, r2);
        return r1;
    }

    function _checkSeals(
        bytes32 canonicalHash,
        bytes calldata canonicalSeal,
        bytes32 conflictingHash,
        bytes calldata conflictingSeal
    ) private pure returns (address) {
        address signer1 = _recover(canonicalHash, canonicalSeal);
        address signer2 = _recover(conflictingHash, conflictingSeal);
        if (signer1 != signer2) revert DifferentSigners(signer1, signer2);
        return signer1;
    }

    // ── RLP ──────────────────────────────────────────────────────────────────

    /**
     * Read one RLP item's payload location.
     *
     * Deliberately strict about STRUCTURE (bounds, long-form minimality) and
     * deliberately lenient about INTEGER encoding: a non-minimal integer decodes
     * to the same value, so rejecting it would buy nothing, while a structural
     * misread could walk off the end of one field and into another — which is how
     * a parser convicts the wrong address.
     */
    function _item(bytes calldata b, uint256 off)
        private
        pure
        returns (uint256 dataOff, uint256 dataLen, bool isList)
    {
        if (off >= b.length) revert BadHeader();
        uint8 p = uint8(b[off]);

        if (p < 0x80) {
            // Single byte < 0x80 encodes itself; the byte IS the payload.
            return (off, 1, false);
        } else if (p < 0xb8) {
            dataOff = off + 1;
            dataLen = uint256(p) - 0x80;
        } else if (p < 0xc0) {
            uint256 ll = uint256(p) - 0xb7;
            dataLen = _uintAt(b, off + 1, ll);
            dataOff = off + 1 + ll;
            // The long form is only legal above 55 bytes; allowing a short value
            // in long form would give one field two encodings.
            if (dataLen < 56) revert BadHeader();
        } else if (p < 0xf8) {
            dataOff = off + 1;
            dataLen = uint256(p) - 0xc0;
            isList = true;
        } else {
            uint256 ll = uint256(p) - 0xf7;
            dataLen = _uintAt(b, off + 1, ll);
            dataOff = off + 1 + ll;
            isList = true;
            if (dataLen < 56) revert BadHeader();
        }

        // Overflow-safe because dataLen came from at most 8 length bytes below.
        if (dataOff + dataLen > b.length) revert BadHeader();
    }

    function _uintAt(bytes calldata b, uint256 off, uint256 len) private pure returns (uint256 v) {
        // 8 is enough for every length prefix and every header integer a real
        // chain produces; a longer one is a crafted header, not a block.
        if (len > 8) revert BadHeader();
        if (off + len > b.length) revert BadHeader();
        for (uint256 i = 0; i < len; i++) {
            v = (v << 8) | uint256(uint8(b[off + i]));
        }
    }

    // ── signatures ───────────────────────────────────────────────────────────

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let p := sig.offset
            r := calldataload(p)
            s := calldataload(add(p, 32))
            v := byte(0, calldataload(add(p, 64)))
        }
        // Besu writes commit seals with v in {0, 1}; most signing libraries emit
        // {27, 28}. Verified against real seals on this chain: both appear.
        if (v < 27) v += 27;
        // Reject the high-S twin. Every seal on this chain is low-S (checked), and
        // accepting both encodings would mean one seal has two forms — which here
        // would let the SAME signature over the SAME header be presented as the
        // "conflicting" one and convict an honest validator. This is not
        // hygiene, it is the difference between a court and a trap.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        address signer = ecrecover(digest, v, r, s);
        // ecrecover returns 0 rather than reverting on failure.
        if (signer == address(0)) revert NotSealedBy(signer);
        return signer;
    }
}
