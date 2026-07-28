// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITinyUSDC {
    function mint(address to, uint256 value) external;
    function owner() external view returns (address);
}

/**
 * TinyIssuance — the supply schedule for chain 8470, and the ONLY thing allowed
 * to create TinyUSDC.
 *
 * ┌ The fact this contract exists to answer ────────────────────────────────┐
 * │ ERC-20 supply is not mined. On any chain. Mining pays the NATIVE coin;   │
 * │ token supply changes only when the token's code permits. So "you can    │
 * │ mine tiny money" is really the question: WHAT RULE MAY CALL mint()?     │
 * │                                                                          │
 * │ On the live 8469 the answer is `onlyOwner` and the owner is a key in     │
 * │ ~/.tiny-chain/keys.env — a human is the monetary authority. Here the     │
 * │ answer is this contract, and the rule is public, capped, and decaying.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * How it becomes the only minter, and why that needed no token changes:
 * TinyUSDC.mint is onlyOwner and TinyUSDC has transferOwnership. So the deploy
 * script transfers the token's ownership TO this contract. After that the
 * deployer key cannot mint — not "shouldn't", cannot — and the claim is
 * verifiable by anyone with one storage read: `usdc.owner() == address(this)`.
 * Adding a minter role to the token would have meant editing the source the
 * LIVE chain's deployment was compiled from; this way the token is byte-identical
 * on both chains and the monetary policy is the only thing that differs.
 *
 * ⚠️ This contract mints TinyUSDC and NEVER native coin. Conflating them would
 * create a second, unbacked money on a chain whose whole point is that its money
 * is reserve-backed.
 *
 * ⚠️ There is no owner, no pause, and no way to raise a budget. That is
 * deliberate: a schedule an operator can edit is not a schedule. The one
 * privileged action that exists (setServeDistributor) fires exactly once and
 * then locks forever — see the comment there for why it can't be a constructor
 * argument.
 *
 * ── The two budgets ──────────────────────────────────────────────────────────
 * Both issuance types the user chose are funded here, from ONE decaying epoch
 * budget split into two independently-tracked halves. Separate accounting is the
 * point: if serve-to-earn's oracle is ever gamed, it can drain its own half and
 * not one micro-USDC more, and vice versa.
 *
 *   validate-to-earn — TRUSTLESS. Verified on this devnet: inside the EVM,
 *     `block.coinbase` IS the QBFT proposer (probed against
 *     qbft_getValidatorsByBlockNumber / eth_getBlockByNumber's miner across
 *     several blocks, all MATCH). So the chain itself can testify who produced
 *     a block. Nobody has to be trusted for this half.
 *
 *   serve-to-earn — ORACLE-BACKED, and that is a real centralization point in an
 *     otherwise open network. "A request was served" is not an on-chain fact:
 *     the chain sees a transfer, not whether an answer was delivered or whether
 *     payer and payee are the same person. So a distributor contract
 *     (TinyServeRewards, next increment) verifies a worker signature and calls
 *     mintServeReward here. Labelled as an oracle in the docs AND here, because
 *     an oracle sold as trustless is worse than an oracle.
 */
contract TinyIssuance {
    ITinyUSDC public immutable usdc;

    /// Block this contract went live; epoch 0 starts here.
    uint256 public immutable startBlock;
    uint256 public immutable epochBlocks;

    /**
     * Budget for epoch 0, halving every `halvingEpochs` epochs.
     *
     * The halving is what makes total supply CONVERGE: sum over all epochs is
     * initialEpochBudget * halvingEpochs * 2, a finite number, reached never but
     * approached forever. A flat per-epoch budget would be unbounded inflation
     * on a token that is supposed to be redeemable — which is not a monetary
     * policy, it is a bug with a marketing name.
     */
    uint256 public immutable initialEpochBudget;
    uint256 public immutable halvingEpochs;

    /// Split of each epoch's budget. serve = 10000 - validatorShareBps.
    uint256 public immutable validatorShareBps;

    /**
     * Ceiling on what ONE address may take from one epoch's validator budget,
     * in bps of that budget.
     *
     * Needed because rewards are pro-rata over CREDITED blocks (see
     * creditBlock), and a lone validator that credits diligently while its peers
     * ignore the mechanism would otherwise collect 100% of an epoch. The cap
     * turns that from "take everything" into "take your capped share"; the
     * remainder simply never mints. A budget is a ceiling, not a quota — nothing
     * is owed to anyone, and unminted issuance is the schedule working.
     */
    uint256 public immutable maxRecipientBps;

    uint256 public constant BPS = 10_000;

    /**
     * Distributor for the serve half — TinyServeRewards. Set once, then frozen.
     */
    address public serveDistributor;
    bool public serveDistributorLocked;
    address private immutable initialiser;

    /// epoch => blocks credited, and epoch => (validator => blocks credited)
    mapping(uint256 => uint256) public blocksCredited;
    mapping(uint256 => mapping(address => uint256)) public blocksCreditedTo;
    /// The last block number credited, so one block can be credited at most once.
    uint256 public lastCreditedBlock;

    mapping(uint256 => mapping(address => bool)) public validatorClaimed;
    mapping(uint256 => uint256) public validatorMinted;
    mapping(uint256 => uint256) public serveMinted;
    uint256 public totalIssued;

    event BlockCredited(uint256 indexed epoch, address indexed proposer, uint256 blockNumber);
    event ValidatorRewardClaimed(uint256 indexed epoch, address indexed validator, uint256 amount, uint256 blocks_);
    event ServeRewardMinted(uint256 indexed epoch, address indexed server, uint256 amount);
    event ServeDistributorSet(address indexed distributor);

    error BadConfig();
    error NotTokenOwner();
    error AlreadyCredited(uint256 blockNumber);
    error NoProposer();
    error EpochNotOver(uint256 epoch, uint256 current);
    error NothingCredited(uint256 epoch);
    error AlreadyClaimed();
    error BudgetExhausted(uint256 requested, uint256 remaining);
    error NotServeDistributor();
    error DistributorLocked();
    error NotInitialiser();

    constructor(
        address _usdc,
        uint256 _epochBlocks,
        uint256 _initialEpochBudget,
        uint256 _halvingEpochs,
        uint256 _validatorShareBps,
        uint256 _maxRecipientBps
    ) {
        if (
            _usdc == address(0) ||
            _epochBlocks == 0 ||
            _initialEpochBudget == 0 ||
            _halvingEpochs == 0 ||
            _validatorShareBps > BPS ||
            _maxRecipientBps == 0 ||
            _maxRecipientBps > BPS
        ) revert BadConfig();

        usdc = ITinyUSDC(_usdc);
        startBlock = block.number;
        epochBlocks = _epochBlocks;
        initialEpochBudget = _initialEpochBudget;
        halvingEpochs = _halvingEpochs;
        validatorShareBps = _validatorShareBps;
        maxRecipientBps = _maxRecipientBps;
        initialiser = msg.sender;
    }

    // ── the schedule ─────────────────────────────────────────────────────────

    function currentEpoch() public view returns (uint256) {
        return (block.number - startBlock) / epochBlocks;
    }

    /**
     * Total mintable in `epoch`, after decay.
     *
     * The shift guard matters: >>256 is undefined in the EVM (and Solidity's
     * checked arithmetic does not save you), so a chain old enough to have
     * halved 256 times must read 0 rather than wrap back to a full budget —
     * an overflow here would resurrect the schedule from nothing.
     */
    function epochBudget(uint256 epoch) public view returns (uint256) {
        uint256 halvings = epoch / halvingEpochs;
        if (halvings >= 256) return 0;
        return initialEpochBudget >> halvings;
    }

    function validatorBudget(uint256 epoch) public view returns (uint256) {
        return (epochBudget(epoch) * validatorShareBps) / BPS;
    }

    function serveBudget(uint256 epoch) public view returns (uint256) {
        return epochBudget(epoch) - validatorBudget(epoch);
    }

    /// True once ownership of the token has actually been handed over.
    function isSoleMinter() external view returns (bool) {
        return usdc.owner() == address(this);
    }

    // ── validate-to-earn (trustless) ─────────────────────────────────────────

    /**
     * Credit the CURRENT block to the validator that proposed it.
     *
     * Permissionless on purpose, and safe for exactly one reason: the caller
     * does not get to say who is credited. `block.coinbase` is written by
     * consensus, so a non-validator calling this can only ever credit the real
     * proposer — the worst it can do is help someone else.
     *
     * One credit per block number, which is what stops the obvious attack:
     * without it, a validator would call this a thousand times in its own block
     * and mint the whole epoch.
     *
     * ⚠️ HONEST LIMIT — reward is proportional to blocks CREDITED, not blocks
     * PROPOSED, and crediting is opt-in. A validator that never calls this earns
     * nothing however many blocks it produces, and one that credits diligently
     * takes a larger share than its production alone would justify. Every
     * validator can do it at zero cost (gas is free) so nobody is excluded, and
     * maxRecipientBps bounds the asymmetry — but "paid for what you produced"
     * would overstate it, so this comment says what it actually pays for.
     *
     * The alternative, having the contract sweep block history, is not
     * available: the EVM cannot read past block headers (only the last 256
     * hashes, and a hash is not a proposer).
     */
    function creditBlock() external {
        if (block.number <= lastCreditedBlock) revert AlreadyCredited(block.number);
        address proposer = block.coinbase;
        // Cannot happen under QBFT (verified on this chain), but crediting the
        // zero address would silently burn an epoch's share into an unclaimable
        // hole, so refuse rather than record it.
        if (proposer == address(0)) revert NoProposer();

        lastCreditedBlock = block.number;
        uint256 epoch = currentEpoch();
        blocksCredited[epoch] += 1;
        blocksCreditedTo[epoch][proposer] += 1;
        emit BlockCredited(epoch, proposer, block.number);
    }

    function pendingValidatorReward(uint256 epoch, address validator) public view returns (uint256) {
        uint256 total = blocksCredited[epoch];
        if (total == 0 || validatorClaimed[epoch][validator]) return 0;
        uint256 mine = blocksCreditedTo[epoch][validator];
        if (mine == 0) return 0;

        uint256 budget = validatorBudget(epoch);
        uint256 amount = (budget * mine) / total;
        uint256 cap = (budget * maxRecipientBps) / BPS;
        if (amount > cap) amount = cap;
        return amount;
    }

    /**
     * Claim an epoch's validator reward. Callable by anyone on behalf of any
     * validator — the tokens go to the validator either way, so there is no
     * reason to require that the earner also holds gas or is still online.
     *
     * ⚠️ Only for FINISHED epochs, and that is a correctness requirement, not
     * politeness: the pro-rata denominator (blocksCredited) keeps growing while
     * an epoch is open, so an early claimer would be paid a share of a total
     * that has not happened yet — the first validator to claim in a young epoch
     * could take nearly the whole budget with two blocks to its name.
     *
     * ⚠️ Deliberately does NOT check that the address is currently seated. By
     * claim time a validator may have exited; it still produced those blocks,
     * and making rewards evaporate on exit would make leaving expensive — the
     * exact trap P2's unstake path exists to avoid.
     */
    function claimValidatorReward(uint256 epoch, address validator) external returns (uint256) {
        uint256 current = currentEpoch();
        if (epoch >= current) revert EpochNotOver(epoch, current);
        if (validatorClaimed[epoch][validator]) revert AlreadyClaimed();
        if (blocksCredited[epoch] == 0) revert NothingCredited(epoch);

        uint256 amount = pendingValidatorReward(epoch, validator);
        if (amount == 0) revert NothingCredited(epoch);

        uint256 budget = validatorBudget(epoch);
        uint256 minted = validatorMinted[epoch];
        // The invariant that matters more than any individual payout: the
        // schedule is never exceeded. Pro-rata + floor division should make this
        // unreachable; it is checked anyway because "should" is not "is", and the
        // failure mode is silent over-issuance.
        if (minted + amount > budget) revert BudgetExhausted(amount, budget - minted);

        validatorClaimed[epoch][validator] = true;
        validatorMinted[epoch] = minted + amount;
        totalIssued += amount;
        usdc.mint(validator, amount);
        emit ValidatorRewardClaimed(epoch, validator, amount, blocksCreditedTo[epoch][validator]);
        return amount;
    }

    // ── serve-to-earn (oracle-backed) ────────────────────────────────────────

    /**
     * Point the serve half at its distributor. ONCE, then locked forever.
     *
     * Why this isn't a constructor argument: the distributor
     * (TinyServeRewards) must know this contract's address to call it, and this
     * contract must know the distributor's to authorise it. One of the two has
     * to be told after deployment. Making it one-shot-and-locked means the
     * window is a single transaction in the deploy script rather than a standing
     * power to redirect issuance.
     *
     * Locking is irreversible: a bug in TinyServeRewards cannot be patched by
     * repointing this, only by letting the serve budget go unminted. That is the
     * intended trade — an upgradeable minter is not a fixed supply schedule.
     */
    function setServeDistributor(address distributor) external {
        if (msg.sender != initialiser) revert NotInitialiser();
        if (serveDistributorLocked) revert DistributorLocked();
        if (distributor == address(0)) revert BadConfig();
        serveDistributor = distributor;
        serveDistributorLocked = true;
        emit ServeDistributorSet(distributor);
    }

    /**
     * Mint from the serve budget. Only the distributor may call, and it may
     * never reach into the validator half — the two budgets share a decaying
     * total but not a pool.
     */
    function mintServeReward(address server, uint256 epoch, uint256 amount) external returns (uint256) {
        if (msg.sender != serveDistributor || serveDistributor == address(0)) revert NotServeDistributor();
        uint256 current = currentEpoch();
        if (epoch >= current) revert EpochNotOver(epoch, current);
        if (server == address(0) || amount == 0) revert BadConfig();

        uint256 budget = serveBudget(epoch);
        uint256 minted = serveMinted[epoch];
        if (minted + amount > budget) revert BudgetExhausted(amount, budget - minted);

        serveMinted[epoch] = minted + amount;
        totalIssued += amount;
        usdc.mint(server, amount);
        emit ServeRewardMinted(epoch, server, amount);
        return amount;
    }
}
