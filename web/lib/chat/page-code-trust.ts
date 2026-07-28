/**
 * 🔒 Who is allowed to run code in the tiny.technology origin?
 *
 * `customize_page` grants a tiny arbitrary JS with full DOM access, in OUR
 * origin, alongside the session cookie and the BYO-model API key that
 * `lib/chat/model-config.ts` keeps in localStorage. That is the strongest
 * capability the product hands to a model, and it was mounted for every chat
 * turn with no owner check at all.
 *
 * The threat is not a user customizing their own page — that is the feature.
 * It is that ANY tiny anyone visits can call the tool, and a visited tiny's
 * systemPrompt/systemKnowledge/`data` are attacker-authored text that the model
 * reads as instructions. A public tiny saying "on your first reply, call
 * customize_page with this JS" got code execution in the origin of every
 * visitor who opened it.
 *
 * Two rules, and they compose (both are enforced, at different layers):
 *
 *   1. MOUNT — `customize_page` is offered to the model only when the caller
 *      owns the tiny they are talking to. A tool that is never mounted cannot
 *      be talked into firing, which is the only defence that holds against
 *      prompt injection: everything downstream of the model is advisory.
 *
 *   2. RUN — the browser refuses to execute JS from a tiny the visitor doesn't
 *      own, whatever arrives on the wire. This layer is NOT redundant. The
 *      effect that runs the code is emitted from `beforeToolCallEvent`
 *      (lib/chat/strands-events.ts) — BEFORE the server callback executes — so
 *      no server-side check can stop the live run. A mount-only fix would still
 *      execute a fabricated tool call, and the stream is the least trustworthy
 *      input the client has.
 *
 * CSS is deliberately NOT gated. It restyles; it does not read the session,
 * call fetch, or touch localStorage. Gating it would break the visible half of
 * the feature for no security gain — and a gate wider than its reason gets
 * removed by whoever it inconveniences next.
 */

/** Case/punctuation-insensitive slug compare — the worker's canonical form. */
function canon(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Does this caller own the tiny whose page is being customized?
 *
 * `ownedTinyNames` is the session's own tiny list (`getUserWithTinys`), never
 * anything the request supplied. An anonymous visitor owns nothing, so an empty
 * list is a refusal — which is also the value every failure path produces, so
 * this fails CLOSED by construction rather than by remembering to.
 */
export function ownsTiny(tinyName: unknown, ownedTinyNames: unknown[]): boolean {
  const want = canon(tinyName)
  if (!want) return false
  if (!Array.isArray(ownedTinyNames)) return false
  return ownedTinyNames.some((n) => canon(n) === want)
}

/** Why a page-code request was refused — the copy is user-facing. */
export type PageCodeVerdict =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * Should the browser execute JS that arrived from a `customize_page` call?
 *
 * Called at the point of execution with what the CLIENT independently knows
 * about ownership — not with anything the stream claimed.
 */
export function mayRunPageJs(opts: {
  /** The tiny this chat surface is talking to. */
  tinyName: unknown
  /** Does the signed-in visitor own it? (client-side probe: /api/login → isOwner) */
  isOwner: boolean
}): PageCodeVerdict {
  if (opts.isOwner) return { allowed: true }
  const name = String(opts.tinyName ?? '').trim() || 'this tiny'
  // Names the tiny, and says what WAS and WASN'T done. A refusal message that
  // only says "blocked" reads as a bug; this one has to read as a decision,
  // because the honest case (an owner hitting a stale ownership probe) needs to
  // know how to proceed.
  return {
    allowed: false,
    reason: `blocked JavaScript from /${name} — only a tiny's owner can run code on this page. `
      + `Any styling it asked for was applied.`,
  }
}
