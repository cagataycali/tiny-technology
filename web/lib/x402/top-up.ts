/**
 * 💧 TOP-UP PRESENTATION — how a client decides what to offer a user who has no
 * money, and what to say about the network their money lives on.
 *
 * This is the client half of the self-hosted chain (docs/e2e-gaps-report-
 * 2026-07-25.md §1.2 item 7). Every client still renders Coinbase Onramp,
 * MoonPay and faucet.circle.com — three real-money on-ramps that are **actively
 * misleading** on a chain we own: nobody sells TinyUSDC, and faucet.circle.com
 * hands out Sepolia USDC, so a user who follows any of those links spends real
 * money (or real time) and arrives with a token this deployment cannot credit.
 * The in-house faucet (`/api/wallet/faucet`) is the only source, and the server
 * already advertises whether it exists via `deposit_info.faucet.available`.
 *
 * PURE (env-free, DOM-free, no fetch) because the interesting content here is
 * PRODUCT JUDGEMENT, not markup: which of three mutually-exclusive top-up routes
 * a deployment offers, and how a refusal is phrased. Both are the kind of thing
 * that looks right in review and is wrong in front of a user — you find out when
 * someone is staring at a button that 424s, or at "try again later" when the real
 * answer is "you've had all of it". So they get asserted (tests/top-up.test.ts)
 * rather than eyeballed, and all three clients can converge on one source.
 *
 * The three routes are mutually exclusive ON PURPOSE. Offering a fiat card
 * button "just in case" next to the faucet, on a chain where the card can't
 * deliver, is the exact bug this module exists to delete.
 */

/** Networks the payments stack can settle on — mirrors the worker's `PayNetwork`. */
export type PayNetwork = 'base' | 'base-sepolia' | 'tiny'

/** What `deposit_info.faucet` looks like (worker: PayDepositInfoCall). */
export type FaucetInfo = {
  available?: boolean
  network?: string
  drip_micro?: number
  cap_micro?: number
  granted_micro?: number
  remaining_micro?: number
  claimed_today?: boolean
  next_drip_in_seconds?: number
  reputation?: number
  micro_per_point?: number
  max_micro?: number
}

export type DepositInfoLike = {
  default_network?: string
  linked_address?: string | null
  faucet?: FaucetInfo | null
}

/**
 * Which top-up route this deployment offers. Exactly one, always:
 *
 *  - `faucet`  — we own the chain, so we issue the credit. No external rail can
 *                deliver a token only we can mint.
 *  - `testnet` — Sepolia: the public faucet is the one true source and fiat
 *                on-ramps deliver MAINNET USDC the claim flow will reject.
 *  - `fiat`    — real Base: cards/bridges work and a faucet would be nonsense.
 */
export type TopUpRoute = 'faucet' | 'testnet' | 'fiat'

/** Coerce an unknown network string, defaulting to the safest reading. */
export const asNetwork = (raw: unknown): PayNetwork => {
  const n = String(raw ?? '').toLowerCase().trim()
  return n === 'tiny' || n === 'base-sepolia' ? n : 'base'
}

/**
 * Pick the route.
 *
 * Keyed on `faucet.available` — the server's own answer — and NOT on
 * `default_network === 'tiny'`, because those two can legitimately disagree: the
 * faucet needs a mintable token AND a deployer key, so a half-configured
 * tiny-chain deployment reports `tiny` with no faucet. Trusting the network
 * string there would render a claim button that 424s every time, which is the
 * failure this whole item is about. Fall back to what the network can actually
 * do instead.
 */
export const topUpRoute = (info: DepositInfoLike | null | undefined): TopUpRoute => {
  if (info?.faucet?.available) return 'faucet'
  return asNetwork(info?.default_network) === 'base-sepolia' ? 'testnet' : 'fiat'
}

/** Micro-USDC → "$1.20". Trailing zeros trimmed past cents, junk → "$0". */
export const usdShort = (micro: unknown): string => {
  const n = Number(micro)
  const v = Number.isFinite(n) ? n / 1_000_000 : 0
  // Cents for whole/2dp amounts, up to 6dp for the odd clamped drip, and never
  // "$1.00" where "$1" reads better on a button.
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return `$${s}`
}

/** Human "2h 5m" until the next drip. Empty when it isn't in the future. */
export const untilNextDrip = (seconds: unknown): string => {
  const n = Math.floor(Number(seconds))
  if (!Number.isFinite(n) || n <= 0) return ''
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${Math.max(1, m)}m`
}

/**
 * What the faucet button says and whether it's live.
 *
 * Three states, and the two refusals must NEVER collapse into one sentence —
 * they're the client mirror of the worker's deliberately-distinct 429 vs 400
 * (see PayFaucetCall). "Wait until UTC midnight" and "you've spent your lifetime
 * ceiling, earn more by getting followed" are opposite instructions; a shared
 * "try again later" sends a user who is permanently capped back to the button
 * every day, and a user who just claimed off to farm reputation they don't need.
 *
 * Ceiling is checked BEFORE the daily claim: someone who is fully capped AND
 * claimed today is capped — telling them to come back tomorrow would be a lie,
 * because tomorrow's drip is refused too.
 *
 * ⚠️ `claimed_today` IS A SERVER OBSERVATION WITH AN EXPIRY, and this function
 *    used to treat it as a standing fact. It means "already claimed for the UTC
 *    day that was current when deposit_info was fetched" — so once that day
 *    rolls over it is simply out of date, and a page left open across UTC
 *    midnight kept the Claim button disabled forever with no visible reason.
 *    The caller may now pass `remainingSeconds` (from
 *    faucet-countdown.dripRemainingSeconds, which is derived from a LIVE clock
 *    rather than the frozen server delta). At 0 the claim is offered again; the
 *    faucet's idempotency key is per-UTC-day, so the server accepts it, and if
 *    the boundary is somehow missed the 429 is already surfaced verbatim.
 *    Omitting the option preserves the old behaviour exactly, for callers that
 *    have no clock — the number of them is the point of the option.
 */
export type FaucetCta = {
  enabled: boolean
  label: string
  /** Why it's disabled — '' when enabled. */
  reason: string
}

export const faucetCta = (
  f: FaucetInfo | null | undefined,
  opts?: { remainingSeconds?: number | null },
): FaucetCta => {
  if (!f?.available) {
    return { enabled: false, label: 'Top-up unavailable', reason: 'This deployment has no in-house faucet.' }
  }
  const remaining = Math.max(0, Number(f.remaining_micro) || 0)
  if (remaining <= 0) {
    return {
      enabled: false,
      label: 'Lifetime credit used',
      // The actionable half: the ceiling is reputation-scaled, so it GROWS.
      reason: `You've used all ${usdShort(f.cap_micro)} of your trial credit. Get followed to raise the ceiling, or deposit real USDC on Base.`,
    }
  }
  // `undefined` = the caller has no clock, so fall back to the server's own
  // frozen delta and behave exactly as before. `null` = a clock-aware caller
  // that has no deadline to count to (the server sent no delta), which is still
  // "wait", just without a duration to name.
  const live = opts?.remainingSeconds
  const lapsed = live != null && Number.isFinite(live) && live <= 0
  if (f.claimed_today && !lapsed) {
    const wait = untilNextDrip(live === undefined ? f.next_drip_in_seconds : live)
    return {
      enabled: false,
      label: 'Claimed today',
      reason: `Next top-up ${wait ? `in ${wait}` : 'after midnight UTC'} — ${usdShort(remaining)} still left on your ceiling.`,
    }
  }
  // The drip can be MIN-clamped by the remaining ceiling, so the button must
  // promise what will actually be credited, not the nominal drip.
  const credit = Math.min(Number(f.drip_micro) || 0, remaining)
  return { enabled: true, label: `Claim ${usdShort(credit)} free credit`, reason: '' }
}

/**
 * 💧 What the faucet card says when the claim came back with NOTHING IT COULD READ.
 *
 * All three clients used to say **"couldn't reach the faucet"** here, under a ⚠️,
 * and two of them added "try again". None of them can back any of that up:
 *
 *   - web  — `faucetClaim()` is `fetch().then(r => r.json())`, so the rejection is
 *            a transport drop OR the `AbortSignal.timeout` firing (the request WAS
 *            delivered) OR a body that wasn't JSON (the server DID answer — a
 *            platform 502 page, a captive portal's login HTML).
 *   - iOS  — `Wallet.post()` returns nil for a malformed `Api.base` (Settings typo,
 *            nothing was ever sent), for transport/timeout, and for a non-JSON
 *            body. `LoadFailure.message` already knows to keep those apart.
 *   - Android — `executeJson` never throws on non-JSON, so its null is transport
 *            OR the settle timeout. Still not "unreachable".
 *
 * ⚠️ And the timeout case is the one that costs money. `/api/wallet/faucet`
 *    CREDITS THE LEDGER and only then waits on the TinyUSDC mint receipt (~20s),
 *    so a client that gives up is looking at credit the user already has. Told
 *    "couldn't reach the faucet — try again", they press again, get the 429, and
 *    now believe the claim failed twice while holding the money. iOS's
 *    `claimFaucet` documents that exact sequence — it raised its own deadline to
 *    120s to make it rarer and left the sentence in place.
 *
 * So: name no cause, don't invite the retry that 429s, and point at the balance,
 * which is the only thing that actually answers the question. Same shape the
 * withdraw path on all three clients already uses for its own unknown outcome
 * ("couldn't confirm — check Activity before retrying") — the faucet, one card up,
 * never got it. The ⏳ is load-bearing: ⚠️ is the unfounded conclusion in glyph
 * form, and the picture is read before the words.
 */
export const faucetNoAnswerNote =
  "⏳ Couldn't confirm the claim — the drip may already be credited. Check your balance before claiming again."

/**
 * The one-line explanation of the ceiling. Named separately from the CTA because
 * it's shown in ALL faucet states — a user who just claimed still needs to know
 * why their ceiling is what it is, and that following is what raises it.
 */
export const ceilingNote = (f: FaucetInfo | null | undefined): string => {
  if (!f?.available) return ''
  const cap = usdShort(f.cap_micro)
  const used = usdShort(f.granted_micro)
  const rep = Number(f.reputation) || 0
  const per = usdShort(f.micro_per_point)
  const max = usdShort(f.max_micro)
  const earned = rep > 0 ? ` Your ${rep} reputation ${rep === 1 ? 'point adds' : 'points add'} ${per} each` : ` Earn reputation (${per} per point) by getting followed`
  return `${used} of ${cap} used.${earned}, up to ${max}.`
}

/**
 * Label for a network, in the user's terms. `trial` is the load-bearing word:
 * both `tiny` and `base-sepolia` credit balance that is spendable inside tiny
 * but NOT withdrawable as real money, and a user who doesn't know that before
 * they earn on it will feel defrauded when the withdrawal is refused.
 */
export const networkLabel = (n: PayNetwork): string =>
  n === 'tiny' ? 'Tiny Chain (trial credit)'
    : n === 'base-sepolia' ? 'Base Sepolia (trial credit)'
      : 'Base (real USDC)'

/** Short form for a tight picker chip. */
export const networkShort = (n: PayNetwork): string =>
  n === 'tiny' ? 'Tiny Chain' : n === 'base-sepolia' ? 'Sepolia' : 'Base'

/** True when balance earned on this network can leave as real money. */
export const isRealMoney = (n: PayNetwork): boolean => n === 'base'

/**
 * The kind of money a payment on this network spends, for any sentence that
 * asks a user to approve one. "trial credit" vs "real USDC" is the difference
 * between a sandbox tap and a spend — a confirm prompt that omits it makes the
 * user approve blind (the same rule networkLabel enforces on the pickers).
 */
export const moneyKind = (n: PayNetwork): string =>
  isRealMoney(n) ? 'real USDC' : 'trial credit'

/** The one sentence a quote card / agent echoes while awaiting approval. */
export const quoteSummary = (amountMicro: number, n: PayNetwork): string =>
  `Pay ${usdShort(amountMicro)} in ${moneyKind(n)} to consult this service over x402. Awaiting your approval.`

/**
 * Suffix for the 402 challenge's human-readable description. Three networks,
 * three answers — the old `net === 'base' ? '' : ' (testnet)'` ternary branded
 * a self-hosted chain "(testnet)", which tells an external payer to expect a
 * public faucet that does not exist (the c26 two-branch-ternary bug, on copy).
 */
export const x402DescSuffix = (n: PayNetwork): string =>
  n === 'base' ? '' : n === 'base-sepolia' ? ' (testnet)' : ' (trial credit)'

/**
 * Which networks a picker should show.
 *
 * Only ever the deployment's own network plus real Base — never all three. A
 * deployment configures ONE chain; offering the other trial network would let a
 * user paste a tx hash the receipt scanner can't see (the permanent "no matching
 * USDC transfer" 400 this repo already fixed once by seeding the selector).
 * Base stays listed on a trial deployment because a real deposit is still the
 * documented way to get withdrawable balance.
 */
export const networkChoices = (defaultNetwork: unknown): PayNetwork[] => {
  const n = asNetwork(defaultNetwork)
  return n === 'base' ? ['base'] : [n, 'base']
}

/**
 * 📖 THE WALLET EXPLAINER, per network.
 *
 * The "What is the tiny wallet?" card is the longest piece of money copy we
 * ship and, until now, the only one still written as if every deployment were
 * real Base: "Deposits and withdrawals are real USDC on Base", "Buy or send
 * USDC on Base", "other people's agents can discover your tiny and pay it".
 * On a chain we host, all three are the same lie c-g deleted from the on-ramps
 * and c27 deleted from the agent's own mouth — and this one is worse than a
 * dead link, because a user reads it BEFORE they earn, decides the balance is
 * real money, and finds out otherwise at the withdrawal.
 *
 * Two of the three sentences are network-dependent for DIFFERENT reasons, so
 * they're separate fields rather than one paragraph:
 *
 *  - `custody`  — can this balance leave as real money? (`isRealMoney`)
 *  - `reach`    — can an outside agent pay it? x402 is open on every network,
 *                 but an external payer needs the ASSET, and on our chain the
 *                 only mint is ours. So the honest claim shrinks from "the whole
 *                 internet" to "any agent we've issued credit to" (report item
 *                 10, which we already corrected in the agent's prose).
 *  - `quickStart` — the deposit instruction; a faucet deployment has no "send
 *                 USDC" step at all, so telling them to buy some is a dead end.
 *
 * Keyed on the NETWORK (not faucet availability) because these are claims about
 * what the money IS, which stays true whether or not the faucet is up — the
 * opposite of `topUpRoute`, which is keyed on capability because it renders a
 * button that must actually work.
 */
export type WalletIntro = {
  custody: string
  reach: string
  quickStart: string
  /** Heading for the custody bullet — "Real money, your custody" is only true on Base. */
  custodyTitle: string
}

export const walletIntro = (network: unknown): WalletIntro => {
  const n = asNetwork(network)
  if (n === 'base') {
    return {
      custodyTitle: 'Real money, your custody',
      custody:
        'Deposits and withdrawals are real USDC on Base (an Ethereum L2 by Coinbase). Withdrawals are instant and self-serve — funds go only to the wallet address YOU linked, so a stolen session can’t redirect your money.',
      reach:
        'Priced tinys are also payable by ANY AI agent via the open x402 protocol — other people’s agents can discover your tiny and pay it per request in USDC, no tiny.technology account needed. Your AI becomes an API that earns.',
      quickStart:
        '1) Link your wallet address below · 2) Buy or send USDC on Base · 3) Claim the deposit · 4) Chat with paid tinys, or price your own and start earning.',
    }
  }
  const chain = networkShort(n)
  return {
    custodyTitle: 'Trial credit, not real money',
    custody: `Balance here is ${moneyKind(n)} on ${chain} — it spends on any paid tiny, but it cannot be withdrawn as real USDC, and earning it doesn’t make it withdrawable. Deposit real USDC on Base if you want a balance you can cash out.`,
    reach: `Priced tinys are payable by any AI agent over the open x402 protocol — but a payer needs ${chain} credit to pay with, and on this chain we’re the only source of it. So your audience is agents we’ve issued credit to, not the open internet.`,
    quickStart:
      '1) Claim your free daily credit below · 2) Chat with paid tinys, or price your own and start earning · 3) Watch the settlements land on the chain explorer.',
  }
}
