/**
 * 💧 THE FAUCET CLAIM THAT GOT NO ANSWER — all three clients.
 *
 * 🏷️ THE DEFECT: a claim POST that came back with nothing readable made the card
 * say **"couldn't reach the faucet"** (iOS + web, under ⚠️) or **"couldn't reach
 * the faucet — try again"** (Android). Three clients, one conclusion, and not one
 * of them had checked it:
 *
 *   - web  — `faucetClaim()` is `fetch(…).then(r => r.json())`, so the rejection is
 *            a transport drop OR the `AbortSignal.timeout` firing (the POST was
 *            DELIVERED) OR a body that wasn't JSON (the server ANSWERED — a
 *            platform 502 page, a captive portal's login HTML).
 *   - iOS  — `Wallet.post()` returns nil down THREE paths: a malformed `Api.base`
 *            (a Settings typo; nothing was ever sent), transport/timeout, and a
 *            non-JSON body. `LoadFailure.message` already keeps those three apart
 *            for content loads — the wallet's own POST never got the lesson.
 *   - Android — `executeJson` swallows a non-JSON body into an empty JSONObject, so
 *            its null is transport OR the settle timeout. Still not "unreachable".
 *
 * ⚠️ And the timeout case costs money. `/api/wallet/faucet` CREDITS THE LEDGER and
 *    only then waits on the TinyUSDC mint receipt (~20s), so a client that gives up
 *    is looking at credit the user already holds. Told "couldn't reach the faucet —
 *    try again", they press again, get the 429, and now believe they were refused
 *    twice while the money sits in their balance. iOS's `claimFaucet` documents that
 *    exact sequence in prose: it raised its own deadline to 120s to make it rarer
 *    and left the sentence alone. Web and Android didn't even RELOAD on this path,
 *    so the balance stayed stale and the button kept offering the claim.
 *
 * The honest answer was already on the same screen: every client's `withdraw` null
 * branch says "couldn't confirm — check Activity before retrying" — neutral tone, no
 * retry nudge, points at where the truth is. The faucet card, one up, never got it.
 *
 * Behaviour is pinned in Swift (`TopUpTests`, "TopUp — the claim reply"). What only
 * lives here: that the three clients still say the SAME thing, that none of them has
 * quietly gone back to naming the transport, and that the plumbing facts this fix
 * leans on are still true of the plumbing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { faucetNoAnswerNote } from '@/lib/x402/top-up'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Source with comments stripped. MANDATORY here: all five changed files quote the
 *  old copy in their own prose to explain the history, so a naive grep for
 *  "couldn't reach the faucet" finds the explanation and reports the defect as
 *  live. (Inc 24's lesson — a prose-grep test fails on its own documentation.) */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

/** A top-level declaration's own source, bounded by the NEXT top-level `export`.
 *
 *  NOT `src.slice(src.indexOf(decl))`, which runs to END OF FILE: "faucetClaim
 *  sets an abort signal" then passes on `getWallet()`'s signal 40 lines below, and
 *  a mutant that strips faucetClaim's own signal survives. (It did — that is what
 *  this helper exists for.) NOT `braced()` either: a TS return type that is an
 *  object literal steals the opening brace. */
function topLevel(src: string, decl: string): string {
  const at = src.indexOf(decl)
  if (at < 0) throw new Error(`not found: ${decl}`)
  const next = src.indexOf('\nexport ', at + decl.length)
  return src.slice(at, next < 0 ? src.length : next)
}

/** The brace-balanced block that starts at `name`'s declaration. */
function braced(src: string, name: string): string {
  const at = src.indexOf(name)
  if (at < 0) throw new Error(`not found: ${name}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced: ${name}`)
}

const IOS_TOPUP = 'ios/Tiny/Sources/TopUp.swift'
const IOS_WALLET = 'ios/Tiny/Sources/Wallet.swift'
const WEB_PAGE = 'app/wallet/page.tsx'
const KT_CORE = 'android/app/src/main/java/technology/tiny/app/wallet/WalletCore.kt'
const KT_UI = 'android/app/src/main/java/technology/tiny/app/ui/Wallet.kt'

describe('the sentence itself — what it must not claim', () => {
  it('names no cause, because the client never checked one', () => {
    expect(faucetNoAnswerNote).not.toMatch(/reach/i)
    expect(faucetNoAnswerNote).not.toMatch(/connection|offline|network|unreachable/i)
    expect(faucetNoAnswerNote).not.toMatch(/failed|unavailable/i)
  })

  it('does not send the user back to the button — that press is the 429', () => {
    expect(faucetNoAnswerNote).not.toMatch(/try again|retry/i)
  })

  it('points at the balance, which is the only thing that answers the question', () => {
    expect(faucetNoAnswerNote.toLowerCase()).toContain('balance')
    // The claim it IS allowed to make: the drip may have landed. That is a fact
    // about the route (it credits, THEN waits on the mint), not a guess.
    expect(faucetNoAnswerNote).toMatch(/may already/i)
  })

  it('carries ⏳ and not ⚠️ — the glyph is read before the words', () => {
    expect(faucetNoAnswerNote.startsWith('⏳')).toBe(true)
    expect(faucetNoAnswerNote).not.toContain('⚠️')
  })
})

describe('all three clients say the same thing', () => {
  /** The one string literal on a line that assigns the note. */
  const literal = (src: string, decl: string) => {
    const line = src.split('\n').find(l => l.includes(decl))
    // …plus the next line: Swift and Kotlin both wrap the assignment.
    const at = src.split('\n').findIndex(l => l.includes(decl))
    const win = src.split('\n').slice(at, at + 3).join('\n')
    expect(line, `no line declaring ${decl}`).toBeTruthy()
    const m = win.match(/"([^"]*⏳[^"]*)"/)
    expect(m, `no ⏳ literal near ${decl}`).toBeTruthy()
    return m![1]
  }

  it('iOS mirrors the shared sentence byte for byte', () => {
    expect(literal(code(IOS_TOPUP), 'static let noAnswerNote')).toBe(faucetNoAnswerNote)
  })

  it('Android mirrors the shared sentence byte for byte', () => {
    expect(literal(code(KT_CORE), 'const val FAUCET_NO_ANSWER')).toBe(faucetNoAnswerNote)
  })

  it('web imports it rather than re-typing it', () => {
    const src = code(WEB_PAGE)
    expect(src).toMatch(/from "\.\.\/\.\.\/lib\/x402\/top-up"/)
    expect(src).not.toMatch(/const faucetNoAnswerNote/) // the import, not a local twin
    // Asserted on the BLOCK, not the file: a literal pasted into the catch would
    // leave the import line intact and pass a whole-file grep. (And a `slice` from
    // a missing identifier returns index -1, which slices to the last character
    // and reads as a pass — so this checks presence directly.)
    const claim = braced(src, 'const claimFaucet = async ()')
    expect(claim).toContain('setFaucetMsg(faucetNoAnswerNote)')
    expect(claim).not.toContain('⏳')
  })

  it('nobody still asserts the transport in CODE', () => {
    for (const p of [IOS_TOPUP, IOS_WALLET, WEB_PAGE, KT_CORE, KT_UI]) {
      expect(code(p), p).not.toContain("couldn't reach the faucet")
    }
    // …and the comment-stripper really did run, or the four assertions above are
    // passing on an empty string. Each file must still contain its own prose copy.
    for (const p of [IOS_TOPUP, WEB_PAGE, KT_UI]) {
      expect(read(p), `${p} lost the history comment`).toContain("couldn't reach the faucet")
    }
  })
})

describe('an unknown outcome is not a refusal', () => {
  it('iOS gives nil its own case instead of a fourth flavour of failed', () => {
    const src = code(IOS_TOPUP)
    expect(src).toMatch(/case noAnswer\b/)
    expect(braced(src, 'static func parseFaucetResult')).toMatch(/guard let d = body else \{ return \.noAnswer \}/)
  })

  it('iOS renders it neutrally and reloads, like withdraw does for its own nil', () => {
    const claim = braced(code(IOS_WALLET), 'private func claimFaucet')
    const branch = claim.slice(claim.indexOf('case .noAnswer'))
    expect(branch).toContain('TopUp.noAnswerNote')
    expect(branch).toContain('await load()')
    expect(branch).not.toContain('⚠️')
  })

  it('Android reloads too — this branch used to leave the card offering the claim', () => {
    const line = code(KT_UI).split('\n').find(l => l.includes('WalletCore.FAUCET_NO_ANSWER'))!
    expect(line).toBeTruthy()
    expect(line).toContain('reloadKey++')
    // The `isError` flag drives the alarm colour; false is the neutral tone.
    expect(line).toMatch(/FAUCET_NO_ANSWER,\s*false\s*\)/)
  })

  it('web reloads BOTH, like its own ok path — it used to refresh neither', () => {
    const claim = braced(code(WEB_PAGE), 'const claimFaucet = async ()')
    const branch = claim.slice(claim.indexOf('faucetNoAnswerNote'))
    expect(branch).toContain('load()')
    expect(branch).toContain('loadDepositInfo()')
  })
})

describe('the plumbing facts the fix rests on', () => {
  it('iOS post() really does flatten more than one cause into nil', () => {
    const post = braced(code(IOS_WALLET), 'private func post(')
    // url guard + transport guard + JSON guard. If this ever drops to one, the
    // sentence "couldn't reach" would finally be true and this suite is why it
    // isn't there — so the count is the thing under test, not decoration.
    expect((post.match(/return nil/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(post).toContain('URL(string: Api.base + path)')
    expect(post).toContain('JSONSerialization.jsonObject')
  })

  it('web throws on a DELIVERED request too — the abort signal and r.json()', () => {
    const fn = topLevel(code('lib/x402/wallet-client.ts'), 'export async function faucetClaim')
    expect(fn).toContain('AbortSignal.timeout')
    expect(fn).toMatch(/\.then\(\(r\) => r\.json\(\)\)/)
  })

  it('Android nulls only on an IOException, the settle timeout included', () => {
    const exec = braced(code('android/app/src/main/java/technology/tiny/app/net/TinyApi.kt'), 'private suspend fun executeJson')
    // A non-JSON body becomes {} rather than a throw — which is why Android's
    // no-answer set is narrower than the other two, and why its old sentence was
    // wrong for a different reason (the timeout, not the HTML error page).
    expect(exec).toMatch(/runCatching \{ JSONObject\(text\) \}\.getOrElse \{ JSONObject\(\) \}/)
    expect(exec).toContain('resumeWithException(e)')
  })

  it('the route still credits BEFORE it waits, so "may already be credited" holds', () => {
    // The whole sentence rests on this ORDERING, so measure it rather than grep for
    // a word: the ledger credit is committed at step 1, and step 2 can then burn up
    // to a 20s receipt wait under a 30s platform cap. A client that stops listening
    // anywhere in step 2 is looking at money that is already in the ledger.
    const src = code('app/api/wallet/faucet/route.ts')
    const post = braced(src, 'export async function POST')
    const credit = post.indexOf('/pay/faucet')
    const mint = post.indexOf('mintReserve(')
    expect(credit, 'no credit call').toBeGreaterThan(-1)
    expect(mint, 'no mint call').toBeGreaterThan(-1)
    expect(credit).toBeLessThan(mint)
    // …and the mint's failure must NOT fail the request, or a timed-out claim WOULD
    // be a genuine refusal and the old sentence half-right. Counted, not grepped:
    // "there is an `ok: true` somewhere after the mint" passes with an
    // `if (reserve.error) return json({ ok: false }, 502)` sitting above it (a
    // mutant walked straight through that). After the mint there is exactly ONE
    // return, and it is the success one.
    const after = post.slice(mint)
    expect((after.match(/\breturn\b/g) ?? []).length, 'a second return = an early exit on mint failure').toBe(1)
    expect(after).toMatch(/return json\(\{\s*ok: true/)
    expect(after).toContain('reserve.error') // still HANDLED — logged, not returned
    // (`topLevel`, not `braced` — mintReserve's first `{` is its Promise return TYPE.)
    expect(topLevel(src, 'async function mintReserve')).toMatch(/return \{ error:/)
    expect(src).toMatch(/waitForTransactionReceipt\(\{ hash, timeout: 20_000 \}\)/)
  })

  it('the withdraw precedent this copies is still there on all three', () => {
    expect(code(IOS_WALLET)).toMatch(/Couldn't confirm the withdrawal/)
    expect(code(KT_UI)).toMatch(/couldn't confirm — check Activity before retrying/)
    expect(code(WEB_PAGE)).toMatch(/confirm/i)
  })
})
