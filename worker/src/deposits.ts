/**
 * 💰 USDC deposits on Base (payments PR2) — zero-dependency, trustless claims.
 *
 * Flow:
 *   1. User registers the address they'll send FROM (/pay/link-address)
 *   2. UI shows the PLATFORM deposit address (env.DEPOSIT_ADDRESS)
 *   3. User sends USDC (Base) → submits the tx hash (/pay/claim)
 *   4. Worker verifies via Base JSON-RPC (no SDK, raw eth_getTransactionReceipt):
 *      - receipt.status == 0x1
 *      - a USDC Transfer log: token contract matches, `to` == DEPOSIT_ADDRESS,
 *        `from` == the user's linked address
 *      - confirmations >= MIN_CONFIRMATIONS
 *   5. Ledger credit, idempotent by tx hash (UNIQUE user/kind/ref index +
 *      global claimed_txs table so two users can't claim one tx — migration
 *      0021; the reservation is the gate, not the preceding read)
 *
 * Why claim-based instead of a block scanner: D1-friendly (no cron state),
 * user-driven (instant feedback), and the from-address binding makes claims
 * unstealable. A scanner can be layered on later for auto-credit UX.
 *
 * Env (wrangler secrets / vars):
 *   DEPOSIT_ADDRESS  — platform USDC deposit address on Base
 *   BASE_RPC_URL     — optional; default https://mainnet.base.org
 *   PAYMENTS_TESTNET — "1" → Base Sepolia RPC + testnet USDC
 */
import { OpenAPIRoute, Query } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { reputationScore } from "./reputation";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const unauthorized = () => json({ error: "unauthorized" }, 401);

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer topic
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Canonical USDC contracts
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";          // Base mainnet
export const USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";  // Base Sepolia

export const MIN_CONFIRMATIONS = 3;
const MAX_CLAIM_MICRO = 10_000_000_000; // $10k per single claim, sanity cap

// Multi-network: mainnet, Base Sepolia and the SELF-HOSTED tiny-chain run
// SIMULTANEOUSLY. The claim/x402/withdraw callers pick per-request via
// `network`; PAYMENTS_NETWORK (falling back to legacy PAYMENTS_TESTNET) only
// flips the DEFAULT when the caller doesn't say.
export type PayNetwork = "base" | "base-sepolia" | "tiny";

export type TinyChain = { caip2: string; chainId: number; usdc: string; rpc: string };

/**
 * Self-hosted chain config from env — the worker mirror of the app's
 * `tinyChainConfig()` (lib/x402/tiny-chain.ts). FAIL-CLOSED on purpose: a
 * half-configured chain returns null everywhere, so 'tiny' can never be
 * selected for a chain we can't verify deposits on (an unverifiable network
 * that still credited the ledger would be a mint).
 */
export function tinyChain(env: any): TinyChain | null {
  const chainId = Number(env?.TINY_CHAIN_ID);
  const usdc = String(env?.TINY_CHAIN_USDC_ADDRESS || "");
  if (!Number.isInteger(chainId) || chainId <= 0 || !isAddress(usdc)) return null;
  return {
    caip2: `eip155:${chainId}`,
    chainId,
    usdc: usdc.toLowerCase(),
    rpc: String(env?.TINY_CHAIN_RPC_URL || "http://127.0.0.1:8545"),
  };
}

/** The network used when the caller names none. Same precedence as the app's
 *  paymentsNetwork(): PAYMENTS_NETWORK wins, legacy PAYMENTS_TESTNET honored. */
export function defaultNetwork(env: any): PayNetwork {
  const sel = String(env?.PAYMENTS_NETWORK || "").toLowerCase();
  if (sel === "tiny" && tinyChain(env)) return "tiny";
  if (sel === "base") return "base";
  if (sel === "base-sepolia" || sel === "base_sepolia" || sel === "sepolia") return "base-sepolia";
  return env?.PAYMENTS_TESTNET === "1" ? "base-sepolia" : "base";
}

/**
 * The network a caller's string actually NAMES — or null when it names none.
 *
 * This is the primitive; `normalizeNetwork` is this plus the deployment default.
 * The split matters wherever "the caller didn't say" and "the caller said base"
 * must lead to different outcomes. Falling back to a default is right for a
 * REQUEST (a withdrawal names the chain it wants, and silence means "the usual
 * one"), and wrong for a REPORT: a credit that records which chain money
 * arrived on cannot invent that chain, because the answer decides whether the
 * credit is real money or trial (see `creditCounterparty` in payments.ts).
 *
 * Deliberately the same matching, byte for byte, as the function that used to
 * hold it — `String(requested || "").toLowerCase()`, no trim, coercion included.
 * A stricter or looser parse here would silently change which chain every
 * withdrawal debits, and this refactor must move ZERO existing behaviour. A
 * caller that needs a stricter type contract than "whatever stringifies" applies
 * it before calling (payments.ts `creditCounterparty` does).
 */
export function namedNetwork(env: any, requested?: unknown): PayNetwork | null {
  const r = String(requested || "").toLowerCase();
  if (r === "base-sepolia" || r === "base_sepolia" || r === "sepolia" || r === "eip155:84532") return "base-sepolia";
  if (r === "base" || r === "eip155:8453") return "base";
  const t = tinyChain(env);
  if (t && (r === "tiny" || r === t.caip2 || r === String(t.chainId))) return "tiny";
  return null;
}

export function normalizeNetwork(env: any, requested?: string): PayNetwork {
  // Unknown (incl. 'tiny' on a deployment without the chain) → the default.
  return namedNetwork(env, requested) ?? defaultNetwork(env);
}

export function rpcUrl(env: any, network: PayNetwork = "base"): string {
  if (network === "tiny") return tinyChain(env)?.rpc || "http://127.0.0.1:8545";
  if (network === "base-sepolia") {
    return env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  }
  return env.BASE_RPC_URL || "https://mainnet.base.org";
}
/**
 * The token whose Transfer logs count as a deposit. `env` is required for the
 * tiny-chain (its address is deployment-specific); an unconfigured tiny-chain
 * yields '' — which matches NO log in findUsdcTransfer, so a claim on a chain
 * we don't know about is refused rather than credited.
 */
export function usdcContract(network: PayNetwork = "base", env?: any): string {
  if (network === "tiny") return tinyChain(env)?.usdc || "";
  return (network === "base-sepolia" ? USDC_BASE_SEPOLIA : USDC_BASE).toLowerCase();
}

// 🧪 Deposits on a network whose USDC we can MINT (or that anyone can faucet)
// are TRIAL credits: spendable inside the economy, never withdrawable as real
// money, and lifetime-capped per user. Sepolia USDC is free from a faucet;
// tiny-chain USDC is minted by us outright (chain/contracts/TinyUSDC.sol,
// owner-only mint) — so 'tiny' MUST be trial-class too. Treating it as real
// (the pre-c-d fallthrough did: any non-sepolia network credited 1:1) would
// make the self-hosted chain a printing press for withdrawable USDC.
export const TESTNET_TRIAL_CAP_MICRO = 1_000_000; // $1.00 lifetime

export const TRIAL_NETWORKS: PayNetwork[] = ["base-sepolia", "tiny"];
export const isTrialNetwork = (n: PayNetwork): boolean => TRIAL_NETWORKS.includes(n);

/** Per-network BASE lifetime trial cap — the floor `trialCapMicro()` scales from. */
export const TRIAL_CAP_MICRO: Record<string, number> = {
  "base-sepolia": TESTNET_TRIAL_CAP_MICRO,
  tiny: TESTNET_TRIAL_CAP_MICRO,
};

/**
 * 🚰 THE FAUCET (loop item c-f) — the in-house top-up that replaces the
 * Coinbase / MoonPay / faucet.circle.com links, which are meaningless on a chain
 * we own (docs/e2e-gaps-report-2026-07-25.md §1.2 item 10).
 *
 * The self-hosted chain exists so credits can be MINTED at the source
 * (chain/contracts/TinyUSDC.sol, owner-only `mint`), and this is where that
 * authority is spent. Two decisions are worth stating, because both had a
 * plausible alternative:
 *
 * **1. A drip is a TRIAL DEPOSIT ROW, not a new ledger kind.** The alternative
 * (a `faucet_credit` kind) would have needed every real-value exit's exclusion
 * re-derived to name it — and c-d already proved that shape fails: it patched the
 * withdrawal clause by hand and missed `/pay/spend` entirely (c-f0), which then
 * missed `invoke_credit` (c-f0b). By writing `kind='deposit'` with
 * `counterparty='chain:tiny'`, a drip is *already* covered by
 * TRIAL_DEPOSITS_SUM_SQL, so all three exits exclude it with **zero new safety
 * code**, and any exit added later inherits it. What makes it auditable is the
 * `ref` (`faucet:d<epochDay>`), not a bespoke counterparty.
 *
 * **2. The faucet and on-chain claims share ONE allowance.** `trialCapMicro()`
 * is the single ceiling both paths enforce against, over the same
 * `counterparty='chain:tiny'` sum. Separate budgets would have made total trial
 * exposure `claimCap + faucetCap` while every comment in this file still claimed
 * one lifetime allowance.
 *
 * Why raising the ceiling is safe now, and was not before c14: trial credit
 * provably cannot become real money at any of the three exits — it can't be
 * withdrawn (c-d), can't fund an outbound x402 payment the platform hot wallet
 * fronts (c-f0), and can't be laundered into a second account's withdrawable
 * earnings (c-f0b taint propagation). So the ceiling no longer bounds a
 * money-loss vector. It still bounds a REAL cost — a tiny invoked with trial
 * credit burns model tokens — which is why it's a ceiling and not `Infinity`.
 */
export const FAUCET_DRIP_MICRO = 1_000_000;      // $1.00 per drip, once a day
export const FAUCET_MICRO_PER_POINT = 200_000;   // $0.20 of ceiling per reputation point
export const FAUCET_MAX_MICRO = 25_000_000;      // $25.00 lifetime ceiling, however popular
/** The ONLY network the faucet drips on — see `faucetNetwork()`. */
export const FAUCET_NETWORK: PayNetwork = "tiny";

/**
 * Reputation-scaled lifetime trial ceiling (the product decision c-f had left
 * open: flat vs reputation-scaled — scaled, since c7/c8 made the score readable
 * and "gamified credits" is what the chain was self-hosted for).
 *
 * Shape deliberately mirrors `reputationAllowance()` in the app's lib/rate-limit.ts:
 * scale the BONUS and clamp it, never the total, and treat junk input as zero so
 * a failed score read degrades to exactly today's flat cap.
 *
 * Capped for the same reason the rate-limit bonus is: reputation is earned from
 * other people's gestures (being followed pays, following pays nothing — see
 * reputation.ts), but sybil follows are still cheap, so an uncapped curve would
 * make a farmed account the cheapest way to drain the trial budget.
 *
 * Monotone by construction, which is what makes it safe to enforce a *past*
 * drip against a *present* ceiling: `reputation` is append-only with positive
 * grants only, so a score never falls and an earlier credit can never end up
 * exceeding a later allowance (i.e. this can't retroactively overdraw anyone).
 *
 * Only the chain we own scales. Base Sepolia USDC comes from a third party's
 * faucet, and its cap bounds our exposure to somebody ELSE's free money —
 * standing on this network is no reason to widen that.
 */
export function trialCapMicro(network: PayNetwork, score: number = 0): number {
  const base = TRIAL_CAP_MICRO[network] ?? TESTNET_TRIAL_CAP_MICRO;
  if (network !== FAUCET_NETWORK) return base;
  const points = Number(score);
  if (!Number.isFinite(points) || points <= 0) return base;
  return base + Math.min(
    Math.max(0, FAUCET_MAX_MICRO - base),
    Math.floor(points) * FAUCET_MICRO_PER_POINT,
  );
}

/**
 * The faucet's network for this deployment, or null when it can't drip.
 * FAIL-CLOSED and deliberately narrower than `isTrialNetwork`: a drip is credit
 * we promise is backed by TinyUSDC we can mint, so it's `tiny` ONLY. Dripping on
 * base-sepolia would credit trial balance against a token only a third party can
 * issue — unbackable by design, not merely unconfigured.
 */
export function faucetNetwork(env: any): PayNetwork | null {
  return tinyChain(env) ? FAUCET_NETWORK : null;
}

/** Epoch day (UTC) — the drip's rate-limit bucket. Pure, so it's testable. */
export const epochDay = (nowMs: number): number => Math.floor(nowMs / 86_400_000);

/**
 * A drip's idempotency key. One per user per UTC day, enforced by the ledger's
 * UNIQUE(user_id, kind, ref) index rather than by a preceding read — the guard
 * shape migrations 0021/0024 had to fix everywhere else. The `faucet:` prefix is
 * what distinguishes a drip from an on-chain claim (whose ref is the tx hash) in
 * an audit, since both share the `chain:tiny` counterparty on purpose.
 */
export const faucetRef = (nowMs: number): string => `faucet:d${epochDay(nowMs)}`;

/** Seconds until the next UTC day — what the UI counts down to. */
export const nextDripInSeconds = (nowMs: number): number =>
  Math.max(0, Math.ceil(((epochDay(nowMs) + 1) * 86_400_000 - nowMs) / 1000));

/**
 * 🧪 The ONE statement that grants trial credit, shared by the on-chain claim
 * path and the faucet. Both draw down the same per-network lifetime allowance,
 * so neither can enforce a different ceiling than the other — the same
 * anti-drift move c-f0 made for the exclusion fragment.
 *
 * The cap lives INSIDE the write. A read-then-insert was a check-then-act race:
 * two concurrent grants with distinct refs both read trial total = 0, both
 * passed, both credited up to the cap, minting past the lifetime ceiling. The
 * conditional INSERT…SELECT computes what remains and clamps with MIN in one
 * atomic write; a concurrent second grant sees the first's row, so its WHERE
 * yields 0 rows (ceiling met) or MIN clamps it to exactly what's left.
 *
 * Bindings: ?1 userId, ?2 requested micro, ?3 ceiling, ?4 ref, ?5 counterparty.
 * The ceiling and counterparty are BOUND, which is what lets one statement serve
 * every trial network and every reputation tier.
 *
 * 0 changes WITHOUT a throw ⟺ the WHERE was false ⟺ the allowance is spent.
 * A UNIQUE throw instead means this exact ref already landed (a claim retry, or
 * today's drip) — a different answer for the caller, so the two must not be
 * collapsed.
 */
export const TRIAL_CREDIT_SQL =
  `INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty)
   SELECT ?1, MIN(?2, ?3 - COALESCE((SELECT SUM(delta_micro) FROM ledger WHERE user_id = ?1 AND kind='deposit' AND counterparty=?5),0)), 'deposit', ?4, ?5
   WHERE ?3 - COALESCE((SELECT SUM(delta_micro) FROM ledger WHERE user_id = ?1 AND kind='deposit' AND counterparty=?5),0) > 0`;

/** Trial credit already granted on one network — the allowance's spent side. */
export const TRIAL_GRANTED_SQL =
  `SELECT COALESCE(SUM(delta_micro),0) AS v FROM ledger WHERE user_id = ?1 AND kind='deposit' AND counterparty = ?2`;

/** The ledger `counterparty` literal for a network's deposits/withdrawals. */
export const counterpartyFor = (n: PayNetwork): string => `chain:${n}`;
/**
 * Every counterparty whose deposits are NOT withdrawable as real USDC.
 * withdrawals.ts interpolates this into the atomic debit's exclusion clause —
 * miss one and its trial credits become withdrawable real money.
 */
export const TRIAL_COUNTERPARTIES: string[] = TRIAL_NETWORKS.map(counterpartyFor);
/** SQL literal list for the exclusion clause — module constants only, no input. */
export const TRIAL_COUNTERPARTY_SQL_LIST = TRIAL_COUNTERPARTIES.map((c) => `'${c}'`).join(", ");

/**
 * 🧪→🧪 The RECEIVED-trial term: trial value that reached this user from someone
 * ELSE's trial balance (migration 0024).
 *
 * Excluding a user's own trial deposits is not enough, because a paid invocation
 * moves value between accounts under a different `kind`:
 *
 *   A claims minted TinyUSDC → invokes B's paid tiny → B holds `invoke_credit`,
 *   which no exclusion touched → B withdraws REAL USDC.
 *
 * Two free accounts, no accomplice needed beyond a second signup. payments.ts
 * writes a `trial_taint` row on the PAYEE whenever an invocation was funded by
 * trial balance, and this term folds it into the same exclusion both real-value
 * exits already embed — so the fix lands on withdrawals and outbound x402 spend
 * at once, and a future exit that uses the shared fragment inherits it.
 *
 * Also keyed on ?1, so it composes into TRIAL_DEPOSITS_SUM_SQL without changing
 * a single binding at either call site.
 */
export const TRIAL_TAINT_SUM_SQL =
  `COALESCE((SELECT SUM(micro) FROM trial_taint WHERE user_id = ?1),0)`;

/**
 * 🧪 The trial-credit term, as ONE SQL fragment every money statement that can
 * move REAL value must subtract. Assumes the user id is bound as `?1` (the
 * convention in every guarded INSERT…SELECT here).
 *
 * There are TWO ways real value leaves the platform, and both must exclude trial
 * balance or minted TinyUSDC becomes real USDC:
 *
 *   - withdrawals.ts WITHDRAW_DEBIT_SQL — the platform signs a USDC transfer to
 *     the user's own address.
 *   - payments.ts SPEND_DEBIT_SQL — the platform hot wallet FRONTS real USDC to
 *     an external x402 service and debits the user to reimburse itself. This one
 *     was missing the exclusion: it guarded on total balance only, so a user
 *     could fund an outbound mainnet payment with trial credits and the platform
 *     ate the difference in real money. It needs no accomplice account and no
 *     withdrawal — the drain is one call.
 *
 * Sharing the fragment (rather than re-deriving the clause per file) is the
 * point: the exclusion, the counterparty list, and the trial network set now
 * have a single definition, so adding a trial network can't leave one exit open.
 *
 * It has TWO terms because trial value can also change hands. See
 * TRIAL_TAINT_SUM_SQL — a user's OWN trial deposits are not the whole story once
 * a paid invocation can carry them to somebody else's withdrawable balance.
 */
export const TRIAL_DEPOSITS_SUM_SQL =
  `(COALESCE((SELECT SUM(delta_micro) FROM ledger WHERE user_id = ?1 AND kind='deposit' AND counterparty IN (${TRIAL_COUNTERPARTY_SQL_LIST})),0)
    + ${TRIAL_TAINT_SUM_SQL})`;

/** Pure: 32-byte ABI word → checksummed-less 0x address (last 20 bytes). */
export function topicToAddress(topic: string): string {
  const h = String(topic || "").toLowerCase().replace(/^0x/, "");
  if (h.length !== 64) return "";
  return "0x" + h.slice(24);
}

/** Pure: hex quantity → bigint (0x-prefixed, arbitrary length). */
export function hexToBigInt(hex: string): bigint {
  try { return BigInt(String(hex || "0x0")); } catch { return 0n; }
}

/** Pure: strictly validate a tx hash / EVM address shape. */
export const isTxHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);
export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * The ERC-20 zero address. `Transfer(0x0 → to)` is the MINT event, not a
 * payment: no balance left anyone's account, so nobody sent us anything.
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Pure: an address that can be a real counterparty (not the mint/burn sink). */
export const isSenderAddress = (s: string) =>
  isAddress(s) && s.toLowerCase() !== ZERO_ADDRESS;

/**
 * Pure: find the matching USDC Transfer in a receipt's logs.
 * Returns micro-USDC amount (USDC has 6 decimals — micro IS the base unit).
 *
 * 🔒 A MINT IS NOT A DEPOSIT. `_mint` and `_transfer` emit the SAME
 * `Transfer(address,address,uint256)` topic — a mint just has `from = 0x0`
 * (chain/contracts/TinyUSDC.sol:67 vs :165) — and the platform's own faucet
 * mints TinyUSDC straight to `DEPOSIT_ADDRESS` every time a user takes their
 * daily drip. So a faucet mint's receipt contains a log whose `to` IS the
 * deposit address, and whose `from` is an address anyone can name. Link `0x0…0`
 * as your sending address, paste the faucet's own `reserve_tx` (the API hands it
 * to you), and the claim verifies: the platform's mint gets credited to YOUR
 * account as a deposit you never made — on top of the drip already credited for
 * that very mint, and repeatable with every other user's public drip hash.
 * Refusing the zero address here is the guard; `isSenderAddress` at link time
 * is the second lock (defence in depth, since the check is one comparison).
 */
export function findUsdcTransfer(
  logs: any[], token: string, toAddr: string, fromAddr: string
): { amount_micro: number } | null {
  // Not "no matching transfer" but "these can never be counterparties" — a
  // caller with a zero linked address must match nothing however the logs read,
  // and the mirror case is real too: `isAddress(env.DEPOSIT_ADDRESS)` accepts
  // 0x0, so a deployment that mis-set the deposit address to the sink would make
  // every BURN on the chain (`Transfer(holder → 0x0)`) a claimable deposit —
  // crediting money that just left the supply. Both ends, one predicate.
  if (!isSenderAddress(String(fromAddr || ""))) return null;
  if (!isSenderAddress(String(toAddr || ""))) return null;
  for (const log of Array.isArray(logs) ? logs : []) {
    if (String(log.address || "").toLowerCase() !== token) continue;
    const topics: string[] = log.topics || [];
    if (topics.length < 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topicToAddress(topics[1]) !== fromAddr.toLowerCase()) continue;
    if (topicToAddress(topics[2]) !== toAddr.toLowerCase()) continue;
    const amount = hexToBigInt(log.data);
    if (amount <= 0n || amount > BigInt(MAX_CLAIM_MICRO)) return null;
    return { amount_micro: Number(amount) };
  }
  return null;
}

/**
 * EIP-3009's on-chain redemption bit, as an ABI-encoded eth_call payload.
 *
 *   authorizationState(address from, bytes32 nonce) → bool
 *   selector keccak("authorizationState(address,bytes32)")[0:4] = 0xe94a0102
 *
 * PURE and exported so the encoding is testable without a chain: the selector is
 * a magic constant, and a wrong one does not fail loudly — it either reverts or,
 * worse on a permissive node, returns empty data that a naive reader would treat
 * as `false`. `false` is the answer that AUTHORIZES A REFUND, so a silent
 * encoding bug spends real money. Hence the shape checks return null (ask
 * nothing) rather than encoding garbage.
 */
export const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
export function encodeAuthorizationState(payer: string, nonce: string): string | null {
  if (!isAddress(payer) || !isTxHash(nonce)) return null;
  const addrWord = payer.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const nonceWord = nonce.toLowerCase().replace(/^0x/, "");
  return AUTHORIZATION_STATE_SELECTOR + addrWord + nonceWord;
}

/**
 * Pure: an eth_call result → the redemption bit, or null for "no answer".
 *
 * ⚠️ The null cases are the whole point, and they all mean the SAME thing to a
 * caller that might refund: WE DO NOT KNOW. Empty data ("0x", what a node
 * returns for a call to a contract without that function — a wrong address, a
 * chain where the token isn't deployed, a proxy that didn't forward) must never
 * read as `false`, because `false` past the deadline is the refund verdict.
 * Anything that is not exactly a 32-byte word ending in 0 or 1 is unknown.
 */
export function decodeAuthorizationState(result: unknown): boolean | null {
  const h = String(result ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) return null;
  const v = BigInt(h);
  if (v === 0n) return false;
  if (v === 1n) return true;
  return null; // a bool word is 0 or 1; anything else is not a bool we understand
}

/**
 * 🔍 Ask the chain whether ONE EIP-3009 authorization has been redeemed.
 *
 * Returns true (consumed — transferred, or cancelled, which is equally final:
 * it can never settle now), false (not consumed), or **null = UNKNOWN**, which
 * covers an RPC failure, a chain we can't name, a token address we don't have,
 * and any answer we can't decode. Callers must treat null as "ask again later"
 * and never as evidence of anything: this function exists to authorize refunds,
 * so the one unacceptable failure mode is confidently answering false.
 *
 * `network` decides both the RPC and the token, because a redemption bit is
 * per-chain: the same (payer, nonce) is unredeemed on every chain but the one it
 * was signed for. An unconfigured tiny-chain yields '' from usdcContract() and
 * therefore null here rather than a call to the zero address.
 */
export async function authorizationRedeemed(
  env: any, payer: string, nonce: string, network: PayNetwork,
): Promise<boolean | null> {
  const token = usdcContract(network, env);
  if (!isAddress(token)) return null;
  const data = encodeAuthorizationState(payer, nonce);
  if (!data) return null;
  try {
    const out = await rpc(env, "eth_call", [{ to: token, data }, "latest"], network);
    return decodeAuthorizationState(out);
  } catch {
    // A dead RPC is not a "no". Same discipline as c46/c48: when the authority
    // can't be reached, the verdict is unknown, not the convenient one.
    return null;
  }
}

/**
 * 🔬 THE TWO TOPICS THAT TELL A PAYMENT FROM A VOID.
 *
 *   keccak("AuthorizationUsed(address,bytes32)")     — emitted ONLY by
 *     _transferWithAuthorization, immediately before `_transfer`
 *   keccak("AuthorizationCanceled(address,bytes32)") — emitted ONLY by
 *     cancelAuthorization, which moves nothing
 *
 * Both args are `indexed` (TinyUSDC.sol:42-43), so `authorizer` is topics[1],
 * `nonce` is topics[2], and `data` is EMPTY. Measured, not assumed:
 * chain/scripts/authorization-proof-e2e.mjs signs two same-shaped
 * authorizations, transfers one and cancels the other, and asserts every clause
 * of this comment against a live chain — including that
 * `authorizationState(payer, nonce)` reads **true for BOTH**, which is why the
 * receiver's resolver may never use it.
 */
export const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const AUTHORIZATION_CANCELED_TOPIC =
  "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";

/** Pure: address → 32-byte ABI topic word. The inverse of topicToAddress. */
export function addressToTopic(addr: string): string {
  if (!isAddress(addr)) return "";
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export type AuthorizationFate =
  | { fate: "used"; txHash: string }
  | { fate: "canceled"; txHash: string };

/**
 * Pure: an `eth_getLogs` result → which of the two things happened to ONE
 * authorization, or null for "the chain has not said".
 *
 * ⚠️ The null cases matter in the OPPOSITE direction from
 * `decodeAuthorizationState`. There, a wrong `false` authorized a refund out of
 * our own float. Here a wrong `used` credits a tiny's owner (plus the platform
 * fee) for USDC that never arrived — a MINT. So:
 *
 *   - a `canceled` log ANYWHERE in the set vetoes the whole answer. Order is not
 *     trust: if both topics somehow appear for one (payer, nonce) the instrument
 *     is not provably paid, and the safe reading of a contradiction is "no".
 *   - anything that isn't exactly our topic0 with our nonce in topics[2] is
 *     ignored rather than interpreted. The filter is supposed to do this, but the
 *     filter is a request; this is the check.
 *   - an empty set is null, NEVER "not settled". The tx may be pending, the range
 *     may be wrong, the node may be behind (c48: absence is not evidence).
 *
 * `nonce` is re-checked here because the log set arrives from a node, and the
 * whole point of this function is that it decides whether money is credited.
 */
export function decodeAuthorizationFate(
  logs: any[], token: string, payer: string, nonce: string,
): AuthorizationFate | null {
  if (!isAddress(token) || !isAddress(payer) || !isTxHash(nonce)) return null;
  const tok = token.toLowerCase();
  const authorizerWord = addressToTopic(payer);
  const nonceLower = nonce.toLowerCase();
  let used: string | null = null;
  for (const log of Array.isArray(logs) ? logs : []) {
    if (String(log?.address || "").toLowerCase() !== tok) continue;
    const topics: string[] = log?.topics || [];
    if (topics.length < 3) continue;
    if (String(topics[1] || "").toLowerCase() !== authorizerWord) continue;
    if (String(topics[2] || "").toLowerCase() !== nonceLower) continue;
    const t0 = String(topics[0] || "").toLowerCase();
    const txHash = String(log?.transactionHash || "").toLowerCase();
    if (!isTxHash(txHash)) continue; // a log we cannot key a credit by is no use
    // A cancel is terminal and it is the SAFE verdict — return it immediately so
    // no ordering of the log set can let a `used` win over it.
    if (t0 === AUTHORIZATION_CANCELED_TOPIC) return { fate: "canceled", txHash };
    if (t0 === AUTHORIZATION_USED_TOPIC && !used) used = txHash;
  }
  return used ? { fate: "used", txHash: used } : null;
}

/**
 * 🔍 Ask the chain what happened to ONE inbound authorization — the RECEIVER's
 * question, and the reason it is not `authorizationRedeemed`.
 *
 * Returns `{fate:'used', txHash}` (the money moved, and here is the tx to key the
 * credit by), `{fate:'canceled', txHash}` (the payer voided it; nothing arrived,
 * and it can never arrive now), or **null = we do not know**.
 *
 * ONE `eth_getLogs` per instrument: the topic0 filter is an ALTERNATION, so both
 * questions are asked in a single round trip (proved against a live node in
 * authorization-proof-e2e.mjs — a node that ignored the alternation would answer
 * with the wrong event's logs, so it is measured rather than assumed).
 *
 * ⚠️ `fromBlock` is REQUIRED of the caller, not defaulted to `earliest`. A
 * genesis-to-latest scan on a chain with real history is the kind of query a
 * public node rejects or truncates, and a TRUNCATED result is indistinguishable
 * from `canceled`'s absence — i.e. it would silently deny a creator their
 * earnings. A caller that cannot bound the range must ask nothing instead.
 */
export async function authorizationFate(
  env: any, payer: string, nonce: string, network: PayNetwork,
  fromBlock: string, toBlock: string = "latest",
): Promise<AuthorizationFate | null> {
  const token = usdcContract(network, env);
  if (!isAddress(token) || !isAddress(payer) || !isTxHash(nonce)) return null;
  if (!/^0x[0-9a-f]+$/i.test(String(fromBlock || ""))) return null;
  try {
    const logs = await rpc(env, "eth_getLogs", [{
      address: token, fromBlock, toBlock,
      topics: [[AUTHORIZATION_USED_TOPIC, AUTHORIZATION_CANCELED_TOPIC],
        addressToTopic(payer), nonce.toLowerCase()],
    }], network);
    return decodeAuthorizationFate(logs, token, payer, nonce);
  } catch {
    // A dead or refusing RPC is not a "nothing happened".
    return null;
  }
}

/**
 * The current head, as a hex block number — the anchor a bounded log range is
 * measured back from. null when the node won't say (so the caller asks nothing).
 */
export async function blockNumber(env: any, network: PayNetwork): Promise<number | null> {
  try {
    const out = await rpc(env, "eth_blockNumber", [], network);
    const n = Number(hexToBigInt(String(out)));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

async function rpc(env: any, method: string, params: any[], network: PayNetwork = "base"): Promise<any> {
  const res = await fetch(rpcUrl(env, network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || "rpc error");
  return data.result;
}

/**
 * One address → one account, enforced by the DB (idx_wallets_address, migration
 * 0021) rather than by a preceding SELECT. Two concurrent links for the same
 * sender address both passed the old read and both wrote — and an address that
 * funds two accounts makes every later claim ambiguous, i.e. one on-chain
 * deposit creditable twice. The `user_id != ?` in the WHERE keeps a re-link by
 * the SAME user idempotent (it updates its own row instead of conflicting);
 * anyone else's row makes this write hit the unique index and change 0 rows.
 *
 * Exported so tests can run the real statement against real sqlite.
 */
export const LINK_ADDRESS_SQL =
  "INSERT INTO wallets (user_id, address) VALUES (?1, ?2) " +
  "ON CONFLICT(user_id) DO UPDATE SET address = excluded.address " +
  "WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE address = ?2 AND user_id != ?1)";

/** POST /pay/link-address (internal) { userId, address } — bind a sender address */
export class PayLinkAddressCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: link a sending address to a user" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId, address } = body;
    // isSenderAddress, not isAddress: 0x0…0 is shape-valid and passes every
    // regex, but it's the mint/burn sink — nobody holds its key, so binding it
    // claims authorship of every `Transfer(0x0 → …)` the chain ever emits,
    // starting with our own faucet's mints into DEPOSIT_ADDRESS.
    if (!userId || !isSenderAddress(String(address || ""))) {
      return json({ error: "userId and valid address required" }, 400);
    }

    const addr = String(address).toLowerCase();
    const taken = () => json({ error: "address already linked to another account" }, 409);
    try {
      const res = await env.DB.prepare(LINK_ADDRESS_SQL).bind(String(userId), addr).run();
      // 0 rows ⟺ the DO UPDATE's WHERE saw another account on this address.
      if (!Number(res?.meta?.changes || 0)) return taken();
    } catch (err: any) {
      // The unique index is the last word: a first-time link (INSERT path, no
      // conflict on user_id) racing another user's link lands here.
      if (String(err?.message || err).includes("UNIQUE")) return taken();
      console.log(err, "pay/link-address");
      return json({ error: "link failed" }, 500);
    }

    return json({ ok: true, address: addr, deposit_address: env.DEPOSIT_ADDRESS || null });
  }
}

/**
 * Global one-claim-per-tx RESERVATION (claimed_txs.tx_hash PRIMARY KEY,
 * migration 0021). The old guard was `SELECT user_id FROM ledger WHERE
 * kind='deposit' AND ref = ?` followed by an insert — and the only unique index
 * on the ledger is (user_id, kind, ref), so two users claiming the SAME hash
 * concurrently both read "unclaimed" and both credited: one deposit, minted
 * twice. Now the winner is decided by a write. Returns the claiming user_id
 * (self ⟺ we just won or already own it).
 *
 * Exported so tests can run the real statement against real sqlite.
 */
export const CLAIM_TX_SQL =
  "INSERT INTO claimed_txs (tx_hash, user_id, network) VALUES (?, ?, ?) " +
  "ON CONFLICT(tx_hash) DO NOTHING";

/**
 * Reserve an on-chain tx hash for one crediting account, whichever PATH credits
 * it. Returns the owning user_id — self ⟺ we just won or already hold it.
 *
 * 🔒 WHY THIS IS SHARED, not private to /pay/claim: `claimed_txs` answers "has
 * this on-chain transfer already been credited?", and TWO code paths credit an
 * on-chain transfer to a tiny balance — /pay/claim (a user pastes a hash) and
 * the inbound x402 settle, which credits the payer through /pay/credit keyed on
 * the settlement hash. Only the first one reserved. Migration 0021's own backfill
 * states the invariant it was written to hold — "one deposit tx → one credit,
 * across ALL users" — and it seeded `claimed_txs` from EVERY `kind='deposit'`
 * ledger row with a hash-shaped ref, x402 credits included. The table already
 * considered those rows claims; the writer just never told it about new ones.
 *
 * Whoever writes a deposit row keyed on a tx hash reserves it here first. The
 * hash — not the account — is the unit of uniqueness, because the ledger's only
 * unique index is (user_id, kind, ref) and the two paths credit DIFFERENT
 * user_ids for the same hash: the tiny account on one side, the synthetic
 * `x402:<payer>` on the other. Two namespaces, one transfer, zero interlock.
 */
export async function reserveTx(
  env: any, txHash: string, userId: string, network: string | null
): Promise<{ ok: boolean; owner?: string; error?: string }> {
  const res = await env.DB.prepare(CLAIM_TX_SQL)
    .bind(txHash, String(userId), network).run().catch((err: any) => {
      console.log(err, "reserveTx");
      return null;
    });
  if (!res) return { ok: false, error: "reserve failed" };
  if (Number(res?.meta?.changes || 0)) return { ok: true, owner: String(userId) };
  // Lost the race, or a retry of our own submit — ask who holds it.
  const row = await env.DB.prepare("SELECT user_id FROM claimed_txs WHERE tx_hash = ?")
    .bind(txHash).first().catch(() => null);
  return { ok: false, owner: row?.user_id ? String(row.user_id) : undefined };
}

/**
 * Who holds each of these settling hashes? `tx_hash → user_id`, for the hashes
 * that are reserved; absent ⟺ unreserved.
 *
 * 🔒 HERE, not in the caller, because `claimed_txs` has ONE owner module — the
 * two credit paths drifted apart precisely by each keeping its own statement, and
 * the reservation suite asserts no other file names the table at all. A reader is
 * no exception: the "is this hash spoken for?" question has to mean the same thing
 * to the reporter as it does to `reserveTx`, or a monitor describes a reservation
 * regime that isn't the one being enforced.
 *
 * ⚠️ CHUNKED AT 50, the house limit for an `IN (…)` here (graph.ts, learnings.ts):
 * D1 caps bound parameters per statement, and the only caller scans up to
 * STATUS_SCAN_LIMIT rows. One statement for 200 hashes would fail on the DEEPEST
 * queues only — precisely when the report matters — and fail quietly, because the
 * failure mode below is silence.
 *
 * A failure returns an EMPTY map (per chunk) rather than throwing: the caller uses
 * this to name a permanent blocker, and an unreadable table must under-report
 * ("nothing is claimed") instead of accusing every row. `prepare()` is inside the
 * try, not just `.all()` — a missing table throws at prepare time on some drivers,
 * and a guard that only wraps the await is no guard for that case.
 *
 * ⚠️ Case-exact by design; see the caller's note. Live writers lowercase, but
 * 0021's backfill copied `ledger.ref` verbatim, so a historical row can be mixed
 * case and will simply be missed.
 */
export const CLAIMED_TX_LOOKUP_CHUNK = 50;

export async function claimedTxHolders(
  env: any, txHashes: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const hashes = [...new Set(txHashes.map((h) => String(h || "").toLowerCase()).filter((h) => h))];
  for (let i = 0; i < hashes.length; i += CLAIMED_TX_LOOKUP_CHUNK) {
    const chunk = hashes.slice(i, i + CLAIMED_TX_LOOKUP_CHUNK);
    try {
      const res = await env.DB.prepare(
        `SELECT tx_hash, user_id FROM claimed_txs WHERE tx_hash IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk).all();
      // `.toLowerCase()` on the way out is belt-and-braces, not logic: the bound
      // values are lowercase and the column collates BINARY, so a returned row
      // already matches one of them. It is here so the map's keys are lowercase by
      // construction rather than by that argument, since the caller looks up with
      // a lowercased hash.
      for (const r of res?.results || []) out.set(String(r.tx_hash).toLowerCase(), String(r.user_id));
    } catch (err: any) {
      console.log(err, "claimedTxHolders");
    }
  }
  return out;
}

/** Give a reservation back. Any path that reserves and then declines to credit
 *  MUST call this, or a refused credit burns a real deposit forever. */
export const releaseTx = (env: any, txHash: string, userId: string) =>
  env.DB.prepare("DELETE FROM claimed_txs WHERE tx_hash = ? AND user_id = ?")
    .bind(txHash, String(userId)).run().catch(() => {});

/** POST /pay/claim (internal) { userId, txHash } — verify + credit a deposit */
export class PayClaimCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: claim a USDC deposit by tx hash" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    if (!env.DEPOSIT_ADDRESS || !isAddress(env.DEPOSIT_ADDRESS)) {
      return json({ error: "deposits not configured" }, 424);
    }
    const body: any = await request.json().catch(() => ({}));
    const { userId } = body;
    const txHash = String(body.txHash || "").toLowerCase();
    const network = normalizeNetwork(env, body.network);
    if (!userId || !isTxHash(txHash)) return json({ error: "userId and valid txHash required" }, 400);

    // Sender address must be linked FIRST — that binding is what makes a
    // tx-hash claim unstealable (hashes are public on-chain).
    const wallet = await env.DB.prepare(
      "SELECT address FROM wallets WHERE user_id = ?"
    ).bind(String(userId)).first();
    if (!wallet?.address) return json({ error: "link your sending address first" }, 400);

    // Fast path only — saves two RPC round-trips on an already-claimed hash.
    // The AUTHORITATIVE guard is the claimed_txs reservation below; this read
    // can (and used to) lose a race, so it must never be the sole gate.
    const claimed = await env.DB.prepare(
      "SELECT user_id FROM claimed_txs WHERE tx_hash = ?"
    ).bind(txHash).first();
    if (claimed) {
      return json(claimed.user_id === String(userId)
        ? { ok: true, already_credited: true }
        : { error: "tx already claimed" }, claimed.user_id === String(userId) ? 200 : 409);
    }

    // Verify on Base
    let receipt: any, latestHex: string;
    try {
      [receipt, latestHex] = await Promise.all([
        rpc(env, "eth_getTransactionReceipt", [txHash], network),
        rpc(env, "eth_blockNumber", [], network),
      ]);
    } catch (e: any) {
      // Transient: Base RPC hiccup. retry:true so clients show "try again"
      // instead of a dead-end error — the tx may be perfectly valid.
      return json({ error: `rpc unavailable: ${String(e?.message || e).slice(0, 100)}`, retry: true }, 424);
    }
    // Also transient: a hash pasted before the tx is mined has no receipt yet.
    // This is the COMMON case (users submit eagerly), so it MUST invite a retry
    // — without retry:true the client renders it as a permanent "not found".
    if (!receipt) return json({ error: "tx not found (still pending?)", retry: true }, 404);
    if (receipt.status !== "0x1") return json({ error: "tx failed on-chain" }, 400);

    const confirmations = Number(hexToBigInt(latestHex) - hexToBigInt(receipt.blockNumber));
    if (confirmations < MIN_CONFIRMATIONS) {
      return json({ error: `needs ${MIN_CONFIRMATIONS} confirmations (has ${confirmations})`, retry: true }, 425);
    }

    const transfer = findUsdcTransfer(
      receipt.logs, usdcContract(network, env), env.DEPOSIT_ADDRESS, String(wallet.address)
    );
    if (!transfer) {
      return json({ error: `no matching USDC transfer (from your linked address to the deposit address) on ${network} in this tx` }, 400);
    }

    // 🔒 RESERVE the tx hash before crediting — this write, not the read above,
    // is what makes a deposit creditable exactly once across all accounts.
    // Reserving only AFTER verification matters: an attacker can't burn someone
    // else's pending hash, because a transfer that didn't come from THEIR linked
    // address never reaches this line.
    // reserveTx(), not an inline INSERT: the x402 settle path credits on-chain
    // transfers too, and it has to reserve through the SAME statement.
    const reserved = await reserveTx(env, txHash, String(userId), network);
    if (!reserved.ok) {
      if (reserved.error) return json({ error: "credit failed" }, 500);
      return json(reserved.owner === String(userId)
        ? { ok: true, already_credited: true }
        : { error: "tx already claimed" }, reserved.owner === String(userId) ? 200 : 409);
    }
    const release = () => releaseTx(env, txHash, String(userId));

    // Credit the ledger. Base (real USDC) credits 1:1 — backstopped by the
    // claimed_txs reservation above + the UNIQUE(user,kind,ref) index.
    //
    // 🧪 TRIAL networks (base-sepolia, and the self-hosted tiny-chain whose USDC
    // we mint ourselves) get a capped credit, never 1:1. The cap MUST be enforced
    // INSIDE the insert, not by a preceding read: a read-then-insert was a
    // check-then-act race — two concurrent claims with DISTINCT valid trial tx
    // hashes both read trial total=0, both passed, both credited up to the cap,
    // minting past the lifetime ceiling. And trial credit is spendable via
    // /pay/invoke, where it lands on the payee as a withdrawable invoke_credit —
    // so an inflated trial balance is a real-money creation path, not just
    // cosmetic. The conditional INSERT…SELECT computes remaining and clamps with
    // MIN in ONE atomic write; a concurrent second claim sees the first's row, so
    // its WHERE yields 0 rows (cap met) or MIN clamps it to exactly what's left.
    // D1 serializes the writes, so no interleave.
    //
    // The cap is per-network (each trial network's own counterparty), so trial
    // USDC on one chain can't consume another's allowance.
    // The ceiling is reputation-scaled on the chain we own (trialCapMicro), and
    // the faucet draws down the SAME allowance over the same counterparty sum —
    // so a builder who earned room gets it whether they claim on-chain or take
    // the daily drip, and neither path can grant past the other's. Computed out
    // here so the response can quote the ceiling that was actually enforced (a
    // note naming the flat $1 while a $5 credit landed reads as a bug).
    const cap = isTrialNetwork(network)
      ? trialCapMicro(network, await reputationScore(env, String(userId)))
      : 0;

    let creditMicro = transfer.amount_micro;
    try {
      if (isTrialNetwork(network)) {
        const counterparty = counterpartyFor(network);
        const ins = await env.DB.prepare(TRIAL_CREDIT_SQL)
          .bind(String(userId), transfer.amount_micro, cap, txHash, counterparty).run();
        // 0 rows with no throw ⟺ WHERE false ⟺ remaining ≤ 0 ⟺ cap already met.
        if (!Number(ins?.meta?.changes || 0)) {
          await release();
          return json({ error: `${network} trial cap reached ($${cap / 1_000_000} lifetime) — use real USDC on Base` }, 400);
        }
        // MIN may have clamped a partial fill — report what actually landed.
        const credited = await env.DB.prepare(
          "SELECT delta_micro AS v FROM ledger WHERE user_id = ? AND kind = 'deposit' AND ref = ?"
        ).bind(String(userId), txHash).first();
        creditMicro = Number(credited?.v || 0);
      } else {
        await env.DB.prepare(
          "INSERT INTO ledger (user_id, delta_micro, kind, ref, counterparty) VALUES (?, ?, 'deposit', ?, ?)"
        ).bind(String(userId), creditMicro, txHash, `chain:${network}`).run();
      }
    } catch (err: any) {
      // UNIQUE(user,kind,ref): this user already has a ledger row for the hash
      // (a retry that crashed after crediting) — the reservation is correct, keep it.
      if (String(err?.message || err).includes("UNIQUE")) return json({ ok: true, already_credited: true });
      console.log(err, "pay/claim insert");
      await release();
      return json({ error: "credit failed" }, 500);
    }

    return json({
      ok: true, credited_micro: creditMicro, confirmations, network,
      // `testnet_trial` is the flag all 3 clients already read to explain why a
      // credit isn't withdrawable — it must be true for EVERY trial network, not
      // just sepolia, or a tiny-chain deposit would look like real money.
      ...(isTrialNetwork(network)
        ? {
            testnet_trial: true,
            // Quote the ceiling actually enforced, not the base constant — on the
            // self-hosted chain reputation widens it (trialCapMicro).
            trial_cap_micro: cap,
            note: `${network} deposits are trial credits, $${cap / 1_000_000} lifetime cap`,
          }
        : {}),
    });
  }
}

/**
 * 🚰 POST /pay/faucet (internal) { userId } — the in-house daily top-up.
 *
 * Replaces the Coinbase Onramp / MoonPay / faucet.circle.com links, which point
 * at real-money rails a self-hosted chain has nothing to do with (report §1.2
 * item 10). This is the only credit-granting route with no on-chain transaction
 * behind it, so it's worth being precise about what bounds it:
 *
 *  - **One drip per user per UTC day**, keyed by the ledger's own
 *    UNIQUE(user_id, kind, ref) index on `faucet:d<epochDay>` — not by a
 *    preceding read (which a concurrent writer can't see).
 *  - **A lifetime ceiling shared with on-chain claims** (`trialCapMicro`), drawn
 *    from one counterparty sum, enforced inside the write.
 *  - **A zero-reputation account can never receive more, in total, than the
 *    flat $1 cap already allowed** — the ceiling only widens for builders other
 *    people followed. So turning the faucet on does not increase the worst-case
 *    exposure of a fresh signup by a single micro-dollar; it makes the credit
 *    reachable without a third-party faucet and lets vouched-for builders earn
 *    more room.
 *  - Trial credit provably cannot leave the platform as real money at any of the
 *    three exits (c-d withdrawals, c-f0 outbound x402 spend, c-f0b taint
 *    propagation), which is what made raising the ceiling a product decision
 *    rather than a safety one.
 *
 * The drip is written as a plain trial DEPOSIT row (`kind='deposit'`,
 * `counterparty='chain:tiny'`) precisely so every existing exclusion covers it
 * with no new safety code — see the FAUCET block above for why a bespoke
 * `faucet_credit` kind would have been the dangerous choice.
 *
 * ⚠️ RESERVE BACKING (deliberately NOT this route's job): the credit is spendable
 * inside the economy immediately, but the matching TinyUSDC is minted by the
 * app's Node route (it holds the deployer key; the worker has no signer). A drip
 * with no mint behind it is still sound — trial balance can't be withdrawn, so
 * nothing here promises on-chain redemption — but the 1:1 backing is what makes
 * the tiny-chain a faithful x402 sandbox, so it's the next increment.
 */
export class PayFaucetCall extends OpenAPIRoute {
  static schema = { tags: ["payments"], summary: "Internal: claim the daily trial-credit drip" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const userId = String(body.userId || "");
    if (!userId) return json({ error: "userId required" }, 400);

    // Fail closed: no self-hosted chain configured ⟺ no token we can mint ⟺
    // nothing to back a drip with. 424 (not 400) — the request was fine, the
    // deployment isn't set up, which is what clients gate their UI on.
    const network = faucetNetwork(env);
    if (!network) return json({ error: "faucet not available on this deployment" }, 424);

    const counterparty = counterpartyFor(network);
    const score = await reputationScore(env, userId);
    const cap = trialCapMicro(network, score);
    const now = Date.now();
    const ref = faucetRef(now);

    let credited = 0;
    try {
      const ins = await env.DB.prepare(TRIAL_CREDIT_SQL)
        .bind(userId, FAUCET_DRIP_MICRO, cap, ref, counterparty).run();
      // 0 rows WITHOUT a throw ⟺ the WHERE was false ⟺ the lifetime ceiling is
      // spent. Distinct from the UNIQUE case below (same day) — same "no credit"
      // outcome, completely different thing for the user to do about it, so they
      // must never collapse into one message.
      if (!Number(ins?.meta?.changes || 0)) {
        return json({
          error: `trial ceiling reached ($${cap / 1_000_000} lifetime) — get followed to earn more room, or deposit real USDC on Base`,
          cap_micro: cap,
          reputation: score,
          ceiling_reached: true,
        }, 400);
      }
      // MIN may have clamped the last drip to whatever remained.
      const row = await env.DB.prepare(
        "SELECT delta_micro AS v FROM ledger WHERE user_id = ? AND kind = 'deposit' AND ref = ?"
      ).bind(userId, ref).first();
      credited = Number(row?.v || 0);
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        return json({
          error: "already claimed today's credit",
          next_drip_in_seconds: nextDripInSeconds(now),
          already_claimed: true,
        }, 429);
      }
      console.log(err, "pay/faucet");
      return json({ error: "faucet failed" }, 500);
    }

    const granted = await env.DB.prepare(TRIAL_GRANTED_SQL).bind(userId, counterparty).first();
    return json({
      ok: true,
      credited_micro: credited,
      network,
      // Same flag the clients already read to explain why a credit isn't
      // withdrawable — a drip is trial money like every other trial deposit.
      testnet_trial: true,
      cap_micro: cap,
      granted_micro: Number(granted?.v || 0),
      reputation: score,
      next_drip_in_seconds: nextDripInSeconds(now),
      note: `$${credited / 1_000_000} in trial credit — spendable across tiny, not withdrawable as real USDC`,
    });
  }
}

/** GET /pay/deposit-info (internal) ?userId= — deposit address + linked sender */
export class PayDepositInfoCall extends OpenAPIRoute {
  static schema = {
    tags: ["payments"], summary: "Internal: deposit config for a user",
    parameters: { userId: Query(String, { required: true }) },
  };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    const wallet = await env.DB.prepare("SELECT address FROM wallets WHERE user_id = ?").bind(userId).first();
    const tiny = tinyChain(env);
    // 🚰 Faucet state, so the clients can render the in-house top-up INSTEAD of
    // the Coinbase/MoonPay/circle links (meaningless on a chain we own) and show
    // the real remaining allowance rather than a hardcoded "$1 trial cap". Read
    // here because every client already fetches deposit-info before showing the
    // wallet — a second round-trip just to learn whether a button exists would
    // make the button flicker in.
    const fnet = faucetNetwork(env);
    const score = fnet ? await reputationScore(env, userId) : 0;
    const faucetCap = fnet ? trialCapMicro(fnet, score) : 0;
    const grantedRow = fnet
      ? await env.DB.prepare(TRIAL_GRANTED_SQL).bind(userId, counterpartyFor(fnet)).first()
      : null;
    const granted = Number(grantedRow?.v || 0);
    const claimedToday = fnet
      ? await env.DB.prepare(
          "SELECT 1 AS v FROM ledger WHERE user_id = ? AND kind='deposit' AND ref = ?"
        ).bind(userId, faucetRef(Date.now())).first()
      : null;
    // Per-network trial ceiling: on the chain we own it's reputation-scaled, so
    // this must not quote the flat base constant (it would under-report the
    // allowance a followed builder actually has).
    const trialCredit = (n: PayNetwork) =>
      `trial, $${trialCapMicro(n, n === fnet ? score : 0) / 1_000_000} lifetime cap`;
    return json({
      ok: true,
      configured: !!(env.DEPOSIT_ADDRESS && isAddress(env.DEPOSIT_ADDRESS)),
      // One EVM address receives on every network — mainnet credits 1:1, trial
      // networks credit as capped trial balance.
      deposit_address: env.DEPOSIT_ADDRESS || null,
      networks: {
        base: { usdc_contract: usdcContract("base"), credit: "1:1" },
        "base-sepolia": { usdc_contract: usdcContract("base-sepolia"), credit: trialCredit("base-sepolia") },
        // Advertised ONLY on a deployment that configures the self-hosted chain —
        // clients build their network picker from these keys, so an unreachable
        // chain must never appear as an option.
        ...(tiny
          ? { tiny: { usdc_contract: tiny.usdc, credit: trialCredit("tiny"), chain_id: tiny.chainId, caip2: tiny.caip2 } }
          : {}),
      },
      default_network: defaultNetwork(env),
      linked_address: wallet?.address || null,
      min_confirmations: MIN_CONFIRMATIONS,
      // Present only where a drip is actually possible, so a client can key the
      // whole top-up card off `faucet.available` and never render a button that
      // 424s. `remaining_micro` is what's left of the lifetime ceiling — the one
      // figure that explains both "claim $1" and "you've had all of it".
      faucet: fnet
        ? {
            available: true,
            network: fnet,
            drip_micro: FAUCET_DRIP_MICRO,
            cap_micro: faucetCap,
            granted_micro: granted,
            remaining_micro: Math.max(0, faucetCap - granted),
            claimed_today: !!claimedToday,
            next_drip_in_seconds: nextDripInSeconds(Date.now()),
            reputation: score,
            micro_per_point: FAUCET_MICRO_PER_POINT,
            max_micro: FAUCET_MAX_MICRO,
          }
        : { available: false },
    });
  }
}
