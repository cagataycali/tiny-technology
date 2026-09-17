// @vitest-environment node
/**
 * 🎲 "Did the money move?" has THREE answers, and the pay card had room for two.
 *
 * When the settle PUT produced no parseable reply — a dropped connection, the
 * deadline firing, a body that wasn't JSON — all three clients set their `failed`
 * phase. That card is red, it announces itself assertively to a screen reader, its
 * title reads "Payment not sent", and its body used to say "check your connection
 * and try again". Every one of those is a claim the client cannot support: the PUT
 * LEFT THE DEVICE, so the server may have reserved, signed, settled and debited
 * before the answer was lost. A lost answer is not a lost request.
 *
 * Worse, "try again" read as "pay again" — the exact double-pay each client's own
 * `already_paid` (409) branch exists to prevent. And on a FIRST attempt neither
 * `needsFunds` nor `canReQuote` was set, so the failed card rendered no button at
 * all: the copy told the user to try again and offered nothing to tap.
 *
 * chain/settle-outcome.mjs has carried the honest verdict server-side for a while
 * (SETTLED / NOT_SETTLED / UNKNOWN, where "unknown … NEVER refund — that
 * double-pays a landing transfer"). This suite pins the same third answer at the
 * layer whose reader is the USER: a fourth phase, accent-toned, politely
 * announced, titled "Couldn't confirm this payment", whose single action re-asks
 * the SAME quote — jti-idempotent, so it either settles once or comes back
 * already_paid and flips the card to "Payment sent".
 *
 * Absence assertions carry the weight here (the c27 lesson): the wrong claim must
 * be provably GONE from the branch, not merely accompanied by a right one. Two
 * consequences for how this file is written:
 *   · each client's unconfirmed branch is SLICED out of its source and asserted on
 *     in isolation — "Payment not sent" still legitimately lives in the `failed`
 *     branch a few lines below, so a whole-file grep would prove nothing; and
 *   · comments are STRIPPED before the absence checks, because every one of these
 *     branches carries prose explaining the very words it must not display.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8')

const IOS = read('ios', 'Tiny', 'Sources', 'PayQuote.swift')
const IOS_API = read('ios', 'Tiny', 'Sources', 'Api.swift')
const WEB = read('components', 'chat', 'PayReceipt.tsx')
const KT_CORE = read('android', 'app', 'src', 'main', 'java', 'technology', 'tiny', 'app', 'wallet', 'WalletCore.kt')
const KT_CARD = read('android', 'app', 'src', 'main', 'java', 'technology', 'tiny', 'app', 'ui', 'PayReceiptCard.kt')
const KT_API = read('android', 'app', 'src', 'main', 'java', 'technology', 'tiny', 'app', 'net', 'TinyApi.kt')
const ROUTE = read('app', 'api', 'x402', 'pay', 'route.ts')
const DEADLINES = read('lib', 'deadlines.ts')

/**
 * The brace-balanced block that starts at `marker` (whose last `{` opens it).
 * Slicing beats grepping for this defect class: the words that must be ABSENT are
 * present-and-correct elsewhere in the same file.
 */
function block(src: string, marker: string): string {
  const at = src.indexOf(marker)
  if (at < 0) throw new Error(`marker not found: ${marker}`)
  const open = at + marker.lastIndexOf('{')
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced block: ${marker}`)
}

/** Code with its comments removed — what the card RENDERS, not what it explains. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// The three unconfirmed branches, sliced whole (for ordering) and stripped (for
// absence). Slice first: comments contain no unbalanced braces, stripping might.
const IOS_CARD = block(IOS, 'private var unconfirmed: some View {')
const WEB_CARD = block(WEB, 'if (phase === "unknown") {')
const KT_UNKNOWN = block(KT_CARD, 'PayPhase.UNKNOWN -> {')
const RENDERED = { iOS: code(IOS_CARD), web: code(WEB_CARD), android: code(KT_UNKNOWN) }

// ── Did we actually read the files we claim to be pinning? ────────────────────
describe('vacuity guards', () => {
  it('every source under test is the real, non-trivial file', () => {
    for (const [name, src] of Object.entries({ IOS, IOS_API, WEB, KT_CORE, KT_CARD, KT_API, ROUTE, DEADLINES })) {
      expect(src.length, name).toBeGreaterThan(1_000)
    }
    expect(IOS).toContain('struct PayQuoteCard: View {')
    expect(WEB).toContain('export default function PayReceipt(')
    expect(KT_CARD).toContain('fun PayReceiptCard(')
    expect(KT_CORE).toContain('sealed interface SettleResult {')
    expect(ROUTE).toContain('export const maxDuration = 180')
  })

  it('the block slicer finds a block and stops at its close', () => {
    const b = block('x fun a() {\n  { }\n}\ntrailing', 'fun a() {')
    expect(b).toBe('{\n  { }\n}')
    expect(b).not.toContain('trailing')
    expect(() => block(IOS, 'no such marker anywhere {')).toThrow(/marker not found/)
  })

  it('the comment stripper removes prose but keeps code and URLs', () => {
    expect(code('a() // Payment not sent\nb()')).toBe('a() \nb()')
    expect(code('/** Payment not sent */\nb()')).toBe('\nb()')
    expect(code('fetch("https://x/y")')).toBe('fetch("https://x/y")')
    // The point of stripping: each real branch DOES explain itself in prose.
    expect(IOS_CARD).toMatch(/not `wifi\.slash`/)
    expect(RENDERED.iOS).not.toContain('wifi')
  })

  it('all three unconfirmed branches were actually sliced', () => {
    for (const [name, b] of Object.entries(RENDERED)) {
      expect(b.length, name).toBeGreaterThan(120)
      expect(b, name).toContain('Check again')
    }
  })
})

// ── 1. A lost answer reaches the third state, on all three clients ────────────
describe('the no-answer branch reports UNKNOWN, not a failure', () => {
  it('iOS: `guard let r else` sets .unknown', () => {
    const b = code(block(IOS, 'guard let r else {'))
    expect(b).toContain('phase = .unknown')
    expect(b).not.toContain('phase = .failed')
    // It must not invent a reason either — the old copy named a cause (the
    // connection) that nothing in this branch observed.
    expect(b).not.toMatch(/settleErr\s*=\s*"/)
  })

  it('web: the outer catch sets "unknown"', () => {
    const b = code(block(WEB, '} catch {'))
    expect(b).toContain('setPhase("unknown")')
    expect(b).not.toContain('setPhase("failed")')
    expect(b).not.toMatch(/setSettleErr\("/)
  })

  it('android: a null reply routes through answerLost, never parseSettleResult', () => {
    // parseSettleResult on an absent body reads a definitive-looking "the payment
    // could not be completed" off nothing at all.
    expect(KT_CARD).toMatch(/if \(r == null\) WalletCore\.answerLost\(prior\)/)
    expect(KT_CARD).toMatch(/is WalletCore\.SettleResult\.Unknown -> PayPhase\.UNKNOWN/)
  })

  it('android: answerLost is TYPED to Unknown, so no edit can make it a failure', () => {
    expect(KT_CORE).toMatch(/fun answerLost\(prior: SettleResult\?\): SettleResult\.Unknown/)
    // And the old name is gone — it asserted "failure", the very thing being fixed.
    expect(KT_CORE).not.toMatch(/fun networkFailure\(/)
  })

  it('the state exists in all three phase enumerations', () => {
    expect(IOS).toMatch(/enum Phase[^\n]*\bunknown\b/)
    expect(WEB).toMatch(/type Phase =[^\n]*"unknown"/)
    expect(KT_CARD).toMatch(/enum class PayPhase \{[^}]*\bUNKNOWN\b/)
  })

  it('web renders it from an exact phase check — its if-chain has NO exhaustiveness gate', () => {
    // Swift's `switch` and Kotlin's `when` are compiler-checked, so neither native
    // client can hold a state it doesn't render. Web's if-chain can: weaken or
    // delete this condition and an in-doubt payment falls THROUGH to the approval
    // gate — a live Approve button on a payment that may already have gone
    // through. That asymmetry is why the condition is pinned literally here.
    expect(WEB).toContain('if (phase === "unknown") {')
    expect(WEB.indexOf('if (phase === "unknown") {'))
      .toBeLessThan(WEB.indexOf('<Title tone={ACCENT}>Approve payment?</Title>'))
  })
})

// ── 2. What the unconfirmed card may NOT say or look like ─────────────────────
describe('the unconfirmed card claims nothing it cannot know', () => {
  it('no branch says the payment was not sent', () => {
    for (const [name, b] of Object.entries(RENDERED)) {
      expect(b, name).not.toContain('Payment not sent')
      expect(b, name).not.toMatch(/not sent|didn.t go through|fail/i)
    }
  })

  it('no branch names a cause nobody observed', () => {
    // "check your connection" was a guess: a deadline, a 500 with an HTML body, or
    // a proxy hanging up all land here too.
    for (const [name, b] of Object.entries(RENDERED)) {
      expect(b, name).not.toMatch(/connection|offline|network|wifi|internet/i)
    }
  })

  it('no branch is the danger tone', () => {
    // An alarm colour is itself a claim about the outcome.
    expect(RENDERED.iOS).not.toContain('danger: true')
    expect(RENDERED.web).not.toContain('DANGER')
    expect(RENDERED.web).toContain('tone={ACCENT}')
    expect(RENDERED.android).not.toMatch(/tone = err\b/)
    expect(RENDERED.android).toMatch(/tone = accent\b/)
    // iOS colours the frame from `tone`, which must list only the real failures.
    expect(IOS).toMatch(/private var tone: Color \{ phase == \.failed \|\| phase == \.declined \? \.red : accent \}/)
  })

  it('no branch interrupts a screen reader with an alert', () => {
    // Polite/status, not assertive/alert — same reasoning as the colour.
    expect(RENDERED.web).toContain('live="status"')
    expect(RENDERED.web).not.toContain('live="alert"')
    expect(RENDERED.android).toContain('LiveRegionMode.Polite')
    expect(RENDERED.android).not.toContain('LiveRegionMode.Assertive')
  })

  it('iOS speaks the unconfirmed copy, not the failure line', () => {
    // A blind user cannot glance at the card again, so the announcement WAS the
    // whole outcome they got — and it used to say "Payment not sent".
    const ann = block(IOS, 'private func announcement(for phase: Phase) -> String? {')
    expect(ann).toMatch(/case \.unknown:\s*return "\\\(Self\.unconfirmedTitle\)\. \\\(unconfirmedBody\)"/)
    expect(ann).toContain('case .failed:') // still there — for actual failures
    expect(ann).toContain('"Payment not sent.')
  })

  it('iOS names no cause in its glyph', () => {
    // `wifi.slash` would diagnose the network; a question mark says only what we
    // know. (tests/ios-sf-symbols.test.ts separately proves the name is real.)
    const icon = /icon: "([^"]+)"/.exec(RENDERED.iOS)?.[1]
    expect(icon).toBe('questionmark.circle')
  })
})

// ── 3. The one action: a question, never a second payment ─────────────────────
describe('the unconfirmed card offers exactly one thing to tap', () => {
  it('every client offers "Check again"', () => {
    for (const [name, b] of Object.entries(RENDERED)) {
      expect(b, name).toContain('↻ Check again')
    }
  })

  it('and it re-approves the SAME quote', () => {
    expect(RENDERED.iOS).toContain('Button(action: approve)')
    expect(RENDERED.web).toContain('onClick={approve}')
    expect(RENDERED.android).toMatch(/onClick = \{ approve\(\) \}/)
  })

  it('NO client offers a fresh quote here — that would be a second payment', () => {
    // The load-bearing exclusion. A re-quote mints a NEW jti, so it cannot collide
    // with the in-doubt settlement: the server would settle it as a separate
    // payment. This is how one uncertain charge becomes two real ones.
    for (const [name, b] of Object.entries(RENDERED)) {
      expect(b, name).not.toMatch(/reQuote|fresh quote/i)
    }
    // Android's Unknown carries no fields at all, so the flag that drives the
    // re-quote button cannot be smuggled in from a prior attempt.
    expect(KT_CORE).toMatch(/data object Unknown : SettleResult/)
  })

  it('the button is hidden once the quote expires, on every client', () => {
    // Past the TTL the route 410s BEFORE it reaches the dedup (see below), so
    // "check again" would be a promise it can't keep.
    expect(RENDERED.iOS).toMatch(/if !expired \{/)
    expect(RENDERED.web).toMatch(/\{!expired \? \(/)
    expect(RENDERED.android).toMatch(/if \(!expired\) \{/)
  })

  it('the native approve() paths accept the unknown phase — else the button is decoration', () => {
    expect(IOS).toContain('guard phase == .awaiting || phase == .failed || phase == .unknown else { return }')
    expect(KT_CARD).toContain('if (phase != PayPhase.AWAITING && phase != PayPhase.FAILED && phase != PayPhase.UNKNOWN) return')
  })

  it('web reaches the settle path with no phase gate at all to widen', () => {
    // Web guards on the quote + the inFlight ref, never on phase. Pinned so that
    // adding a gate later has to come back here and include "unknown".
    const b = code(block(WEB, 'async function approve() {'))
    const head = b.slice(0, b.indexOf('if (isQuoteExpired('))
    expect(head).toContain('if (!active?.quote) return')
    expect(head).toContain('if (inFlight.current) return')
    expect(head).not.toContain('phase')
  })
})

// ── 4. Time passing must not turn "we don't know" into "it failed" ────────────
describe('a lapsed TTL does not downgrade unknown to failed', () => {
  it('iOS returns from the expiry guard instead of failing the card', () => {
    const g = code(block(IOS, 'private func approve() {'))
    const guard = g.slice(g.indexOf('if expired {'))
    // The `unknown` early-return must come BEFORE the phase = .failed assignment,
    // or the guard falls through and re-asserts the original defect on a delay.
    const ret = guard.indexOf('if phase == .unknown { return }')
    const fail = guard.indexOf('phase = .failed')
    expect(ret).toBeGreaterThan(-1)
    expect(fail).toBeGreaterThan(ret)
  })

  it('web guards the whole setSettleErr/setPhase pair', () => {
    const g = block(WEB, 'if (isQuoteExpired(active.expires_at, Date.now())) {')
    expect(g).toMatch(/if \(phase !== "unknown"\) \{/)
    // Both writes must be INSIDE that guard — leaving setSettleErr outside would
    // print an expiry error under the unconfirmed title.
    const inner = block(g, 'if (phase !== "unknown") {')
    expect(inner).toContain('setSettleErr("This quote expired')
    expect(inner).toContain('setPhase("failed")')
  })

  it('android returns before building the Failed result', () => {
    const g = code(block(KT_CARD, 'if (WalletCore.isQuoteExpired(quote.expiresAt, System.currentTimeMillis())) {'))
    const ret = g.indexOf('if (phase == PayPhase.UNKNOWN) return')
    const fail = g.indexOf('WalletCore.SettleResult.Failed(')
    expect(ret).toBeGreaterThan(-1)
    expect(fail).toBeGreaterThan(ret)
  })

  it('the card re-reads the clock, so the wording swaps itself', () => {
    // Staying `unknown` is only honest if the BODY changes: past the TTL it must
    // stop promising a re-check and point at the wallet ledger instead.
    expect(block(IOS, 'private var unconfirmedBody: String {'))
      .toMatch(/expired \? Self\.unconfirmedExpired : Self\.unconfirmedCheckable/)
    expect(RENDERED.web).toContain('{expired ? UNCONFIRMED_EXPIRED : UNCONFIRMED_CHECKABLE}')
    expect(RENDERED.android).toContain('WalletCore.unconfirmedBody(expired)')
  })
})

// ── 5. Nothing terminal is persisted — there is no outcome yet ────────────────
describe('an unconfirmed payment is not frozen into a receipt', () => {
  it('android persists nothing for Unknown, on either path', () => {
    // The in-memory saveable AND the message record.
    expect(block(KT_CARD, 'fun of(r: WalletCore.SettleResult): PaySettled? = when (r) {'))
      .toMatch(/is WalletCore\.SettleResult\.Unknown -> null/)
    expect(KT_CORE).toMatch(/is SettleResult\.Unknown -> null/)
  })

  it('the shared PaySettled codec gains NO unknown outcome', () => {
    // Deliberate non-goal: the codec is a wire format shared by all three clients
    // plus the stored message, and there is no terminal outcome to record. A
    // recycled card re-derives the approval gate, which the jti dedup makes safe
    // — exactly as `failed` already does.
    expect(IOS).toContain('enum Outcome: String, Codable { case paid, pending, failed, declined }')
    expect(WEB).toMatch(/type PaySettled = \{ phase: "paid" \| "pending" \| "declined";/)
    expect(KT_CARD).not.toMatch(/"unknown" -> PayPhase/)
  })
})

// ── 6. One payment, one set of words ─────────────────────────────────────────
describe('the copy is byte-identical across the three clients', () => {
  const lit = (src: string, marker: string): string => {
    const at = src.indexOf(marker)
    if (at < 0) throw new Error(`copy marker not found: ${marker}`)
    const m = /"([^"]+)"/.exec(src.slice(at + marker.length))
    if (!m) throw new Error(`no string literal after: ${marker}`)
    return m[1]
  }

  // Kotlin folds both bodies into one if/else, expired-first. Pinning the ORDER
  // here too: a swap would silently hand every unexpired card the dead-end copy.
  const ktBodies = (() => {
    const m = /fun unconfirmedBody\(expired: Boolean\): String = if \(expired\)\s*"([^"]+)"\s*else\s*"([^"]+)"/.exec(KT_CORE)
    if (!m) throw new Error('unconfirmedBody literals not found')
    return { expired: m[1], checkable: m[2] }
  })()

  const titles = {
    iOS: lit(IOS, 'static let unconfirmedTitle ='),
    web: lit(WEB, 'const UNCONFIRMED_TITLE ='),
    android: lit(KT_CORE, 'const val UNCONFIRMED_TITLE ='),
  }
  const checkable = {
    iOS: lit(IOS, 'static let unconfirmedCheckable ='),
    web: lit(WEB, 'const UNCONFIRMED_CHECKABLE ='),
    android: ktBodies.checkable,
  }
  const expired = {
    iOS: lit(IOS, 'static let unconfirmedExpired ='),
    web: lit(WEB, 'const UNCONFIRMED_EXPIRED ='),
    android: ktBodies.expired,
  }

  it('the title matches on all three', () => {
    expect(titles.web).toBe(titles.iOS)
    expect(titles.android).toBe(titles.iOS)
    expect(titles.iOS).toBe('Couldn’t confirm this payment')
  })

  it('the checkable body matches on all three', () => {
    expect(checkable.web).toBe(checkable.iOS)
    expect(checkable.android).toBe(checkable.iOS)
    expect(checkable.iOS).toContain('no answer came back')
    expect(checkable.iOS).toContain('settles at most once')
  })

  it('the expired body matches on all three', () => {
    expect(expired.web).toBe(expired.iOS)
    expect(expired.android).toBe(expired.iOS)
    expect(expired.iOS).toContain('this quote has expired')
    expect(expired.iOS).toContain('activity list')
  })

  it('the two bodies are genuinely different, and only one promises a re-check', () => {
    // A copy-paste that left both identical would silently un-do §4.
    expect(expired.iOS).not.toBe(checkable.iOS)
    expect(expired.iOS).not.toContain('Checking again is safe')
    expect(checkable.iOS).not.toContain('expired')
  })

  it('every string says the approval WAS sent — the one half we witnessed', () => {
    for (const s of [checkable.iOS, expired.iOS]) {
      expect(s).toMatch(/^Your approval was sent/)
      expect(s).not.toMatch(/fail|connection/i)
    }
  })

  it('uses human punctuation, not a straight apostrophe', () => {
    for (const s of [...Object.values(titles), ...Object.values(checkable), ...Object.values(expired)]) {
      expect(s).not.toMatch(/'/)
    }
  })
})

// ── 7. The copy's promises, checked against the route that must keep them ─────
describe('the route backs what the card promises', () => {
  it('"settles at most once" is real: the spend ref is keyed on the quote jti', () => {
    expect(ROUTE).toMatch(/idempotencyKey: q\.jti/)
  })

  it('a re-PUT of the same quote answers already_paid, so Check again can only inform', () => {
    // Both collision points report already_paid — the clients' "treat as paid"
    // signal. Without this, Check again would be a second payment.
    expect(ROUTE).toMatch(/already_spent === true/)
    expect(ROUTE).toMatch(/already_settled === true/)
    expect(ROUTE.match(/already_paid: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('every client treats already_paid as PAID, never as a failure', () => {
    expect(IOS).toMatch(/\(r\["already_paid"\] as\? Bool\) == true/)
    expect(WEB).toMatch(/r\?\.already_paid/)
    expect(KT_CORE).toMatch(/res\.optBoolean\("already_paid", false\)/)
  })

  it('the 410 expired check comes BEFORE the dedup — which is why there are two bodies', () => {
    // This ordering is the whole justification for hiding the button past the TTL:
    // an expired re-PUT never reaches already_spent, so the answer is genuinely
    // unobtainable from the client. If the route were ever reordered, the expired
    // body would be lying and this test should fail loudly.
    const expiry = ROUTE.indexOf('expired: true }, 410')
    const dedup = ROUTE.indexOf('already_spent === true')
    expect(expiry).toBeGreaterThan(-1)
    expect(dedup).toBeGreaterThan(expiry)
  })

  it('every client waits LONGER than the route can run, so "no answer" means the server gave up', () => {
    // An unknown outcome must mean the answer is gone, not that a client hung up
    // early on a settlement still running (inc 27, and pinned in full by
    // tests/pay-deadline-above-route.test.ts). Restated here because it is the
    // premise of this state's honesty: a client-side abort would manufacture
    // doubt about a payment the server was in the middle of answering.
    expect(DEADLINES).toMatch(/'\/api\/x402\/pay':\s*195_000/)
    expect(IOS_API).toMatch(/req\.timeoutInterval = 195/)
    expect(KT_API).toMatch(/suspend fun putJsonPay\(/)
    expect(block(KT_API, 'suspend fun putJsonPay(path: String, body: JSONObject): JSONObject {'))
      .toContain('executeJson(req, payClient)')
  })
})
