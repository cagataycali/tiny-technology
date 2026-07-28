// 💸 WHO the facilitator is willing to settle FOR.
//
// c34 screened the public RPC's SIGNERS. This is the other tunnel hostname.
// `x402.example.com → :8546` is the facilitator, and its /settle took
// `paymentRequirements` — including `payTo` — straight from the request body.
// Nothing checked that payTo was an address we receive at. Verified against the
// LIVE service on 2026-07-25, from a freshly generated key holding 0 USDC and
// 0 ETH:
//
//     POST /settle  {payTo: 0x…dEaD, value: "0", resource: "https://not-ours…"}
//     → {"success":true,"transaction":"0xf416d8…"}
//     relayer nonce 3 → 4, 0.0000603 ETH of OUR gas burned
//
// The authorization was valid and self-consistent, so every existing check
// passed: the signature recovers to `from`, `auth.to === requirement.payTo`,
// the nonce is unused, `value <= balance`. All true — of a payment that has
// nothing to do with us. The relayer signed a stranger's transfer, to a payee
// the stranger named, for a resource we don't host, and paid for the block space.
//
// Two things that are NOT the problem, because naming them keeps the fix small:
//   • It isn't theft. EIP-3009 authorizations are signed by their payer, so no
//     third party's balance can move; the caller can only move their own.
//   • It isn't the relayer key. That key is doing exactly its job (pay gas,
//     hold no USDC) — c32's guard already covers it being a published one.
//
// What it is: an unmetered write channel with OUR relayer as the funding
// source. A caller with no ETH gets free, unauthenticated, arbitrary
// TinyUSDC transfers relayed on demand — self-payments to inflate a
// balance-history, storage growth in `~/.tiny-chain/state`, and eventually a
// drained relayer, at which point real payments stop settling. Same shape as
// c34's finding: availability and disk, free to the attacker.
//
// The fix reuses `X402_PAY_TO` rather than inventing a facilitator-side env.
// That is the load-bearing decision here. The receiver advertises exactly one
// payTo in its 402 challenge (app/api/x402/chat/[slug]/route.ts) and this
// facilitator exists to settle exactly that challenge — so the set of payees we
// settle for and the set we advertise are THE SAME FACT. A second env
// (FACILITATOR_PAY_TO) would be a copy that drifts, and the drift is silent in
// the expensive direction: rotate the receiving address, forget the facilitator's
// copy, and every real payment fails while every stranger's still settles.
//
// Comma-separated so a rotation can list old + new during the overlap.
const norm = (s) => String(s ?? '').trim().toLowerCase()

/**
 * Parse `X402_PAY_TO` into the lowercased addresses this deployment settles for.
 *
 * Junk entries are DROPPED, not tolerated as wildcards: a typo'd address must
 * shrink the allowlist, never widen it. An all-junk value therefore parses to
 * `[]`, which is the same fail-closed state as unset — the c32 rule that a
 * wrong value must not read as configured.
 */
export function parsePayees(raw) {
  return String(raw ?? '')
    .split(',')
    .map(norm)
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
}

/** Is this payTo one we receive at? Case-insensitive (EIP-55 vs lowercase). */
export function payeeAllowed(payTo, payees) {
  const p = norm(payTo)
  return p !== '' && payees.includes(p)
}

/**
 * The /verify + /settle refusal reason for an off-list payee.
 *
 * Deliberately does NOT name the allowed address(es). A prober learns only that
 * this facilitator is not theirs to use — which is the whole answer they're
 * entitled to — while our receiving address stays something they have to get
 * from the 402 challenge like every honest payer. It also doesn't echo the
 * requested payTo: they sent it, and reflecting caller input into a response
 * string is a habit worth not having on a public endpoint.
 */
export const OFF_LIST_REASON =
  'payTo is not an address this facilitator settles for ' +
  '(it serves one deployment, not the public)'

/**
 * The startup refusal when `X402_PAY_TO` is unset or all-junk.
 *
 * Refuse at STARTUP, matching the relayer-key guard in the same file: a
 * facilitator that boots and then refuses every payment is much harder to
 * diagnose than one that says why it won't boot. Recoverable by setting the env
 * and restarting, so the message says exactly that (c33's refuse-vs-exit rule:
 * exit when a later env fix cures it, and nothing here is written on-chain).
 */
export const NO_PAYEES_REFUSAL =
  'refusing to start with no X402_PAY_TO: /settle would relay ANY caller\'s ' +
  'authorization to ANY payee at our relayer\'s expense. Set X402_PAY_TO to the ' +
  'same receiving address the x402 receiver advertises (comma-separated for a ' +
  'rotation) and restart.'
