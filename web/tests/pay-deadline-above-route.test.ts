/**
 * ⏱️💸 THE CLIENT THAT HUNG UP ON ITS OWN PAYMENT — iOS, Android, web.
 *
 * 🏷️ THE DEFECT: `PUT /api/x402/pay` is the one call in this app that moves a
 * user's money, and it is the longest-running route we have — `maxDuration = 180`,
 * spent SEQUENTIALLY (re-probe 30s → sign → paid fetch 90s → reconcile-log → 202).
 * Two of the three clients hung up before the route was allowed to finish:
 *
 *   - Android — `putJson` rides the default 30s `jsonClient`. It gave up during the
 *     route's FIRST internal step, 150s early.
 *   - iOS — `Api.putBody` used `timeoutInterval = 120`, and because that is an IDLE
 *     timer on a route that sends nothing until it decides, it fired at exactly the
 *     moment the route was returning the **202 pending_confirmation** — the reply
 *     that exists to stop a double-pay.
 *   - web — 195_000 from `ROUTE_DEADLINE_MS`, correctly above the route. Only web
 *     had a test, and that test only ever looked at web.
 *
 * Hanging up cancels nothing. The PUT is already on the server, the payment may
 * already have settled, and all the client loses is the answer — which it then
 * rendered as **"Payment not sent"** with "check your connection". Each client's own
 * 409 branch spells out why that is the worst possible sentence here ("The money DID
 * move — showing 'not sent' would be the opposite of the truth and could push the
 * user to pay twice").
 *
 * ⚠️ THE POINT OF THIS FILE: the invariant was already written down THREE times, in
 * three comments, in three languages — Android's `settleClient` ("120s sits above the
 * server ceiling so the client stops racing the server's own deadline"), Android's
 * `postJsonSettle` ("so a slow broadcast/receipt doesn't abort mid-flight and get
 * mislabeled a failure"), web's PayReceipt ("with a SHORTER one we'd abort settlements
 * the server was completing … inviting a double-pay to a third party"). Three
 * statements of the rule and not one check, so the one call the rule was written FOR
 * was the one that broke it. Prose is not a gate.
 *
 * So: every number here is READ FROM SOURCE — the route's own `maxDuration`, iOS's
 * `timeoutInterval`, Android's `callTimeout` reached by resolving call site → verb →
 * OkHttp client. Nothing is asserted against a literal copy of a number that lives
 * somewhere else, because that is the failure mode this file exists to catch.
 *
 * Scope: the three calls where losing the answer costs money (pay / withdraw /
 * faucet). `tests/deadlines.test.ts` owns the exhaustive walk for web; the natives
 * have no equivalent, and the honest thing is a test that says which calls it covers
 * rather than an "all clear" over paths it never resolved. One measured sibling is
 * NOT covered and NOT fixed: Android's `/api/media` upload rides the 30s
 * `jsonClient` against a route whose own worker budget is `AbortSignal.timeout(30_000)`
 * — an exactly-equal race, the case `exceedsServerBudget` rejects. It costs duplicate
 * R2 objects rather than money, and it is recorded in the ledger, not hidden here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deadlineFor, exceedsServerBudget } from '@/lib/deadlines'

const repo = join(__dirname, '..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

/** Source with comments stripped — every file here explains the rule in prose that
 *  quotes the very numbers and paths being matched (inc 24: a prose-grep test
 *  passes on its own documentation). Kotlin/Swift/TS all use the same two forms. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

/** The brace-balanced body that starts at `sig`. Safe for Swift and Kotlin: neither
 *  puts a `{` in a return type the way a TS object-literal return does (inc 26's
 *  trap), and comments — which could carry an unbalanced brace — are already gone. */
function body(src: string, sig: string): string {
  const at = src.indexOf(sig)
  if (at < 0) throw new Error(`not found: ${sig}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced: ${sig}`)
}

/** The paren-balanced argument list of the call at `needle`. A multi-line call's
 *  trailing `timeout:` argument sits AFTER the body dictionary, so a fixed line
 *  window would either miss it or read the next call's. */
function callArgs(src: string, needle: string): string {
  const at = src.indexOf(needle)
  if (at < 0) throw new Error(`not found: ${needle}`)
  const open = src.indexOf('(', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced call: ${needle}`)
}

// ── the server's side of the race, from the route's own source ────────────────

const ROUTE_FILE: Record<string, string> = {
  '/api/x402/pay': 'app/api/x402/pay/route.ts',
  '/api/wallet/withdraw': 'app/api/wallet/withdraw/route.ts',
  '/api/wallet/faucet': 'app/api/wallet/faucet/route.ts',
}

/** How long the route may legitimately still be working: its platform ceiling, or a
 *  wider internal budget if it somehow declares one. Same derivation as
 *  deadlines.test.ts's walk, so both gates agree on what "the server's budget" means. */
function routeBudgetMs(path: string): number {
  const src = code(ROUTE_FILE[path])
  const md = src.match(/export const maxDuration\s*=\s*(\d+)/)
  const internal = Array.from(src.matchAll(/AbortSignal\.timeout\((\d+)_?(\d*)\)/g)).map((m) =>
    Number(`${m[1]}${m[2]}`),
  )
  const ms = Math.max(md ? Number(md[1]) * 1000 : 0, ...internal, 0)
  expect(ms, `${path} declares no budget — nothing to outlive, so this row is vacuous`).toBeGreaterThan(0)
  return ms
}

// ── Android: call site → verb → OkHttp client → callTimeout ───────────────────

const KT_API = 'android/app/src/main/java/technology/tiny/app/net/TinyApi.kt'

const ktFiles = (): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(join(repo, d))) {
      const rel = `${d}/${e}`
      if (statSync(join(repo, rel)).isDirectory()) walk(rel)
      else if (e.endsWith('.kt')) out.push(rel)
    }
  }
  walk('android/app/src/main/java/technology/tiny/app')
  expect(out.length, 'no Kotlin sources found — the walk is broken').toBeGreaterThan(20)
  return out
}

/** name → callTimeout ms, for every derived OkHttp client in TinyApi. */
function ktClients(): Record<string, number> {
  const src = code(KT_API)
  const found: Record<string, number> = {}
  // Array.from, not a bare for-of: this repo's tsconfig target rejects iterating a
  // matchAll iterator directly (TS2802), and `npm test` would never tell you — vitest
  // strips types, so only `npx tsc --noEmit` sees it.
  for (const m of Array.from(
    src.matchAll(/private val (\w+) = client\.newBuilder\(\)\s*\.callTimeout\((\d+), TimeUnit\.SECONDS\)/g),
  )) {
    found[m[1]] = Number(m[2]) * 1000
  }
  expect(Object.keys(found).length, 'no derived OkHttp clients parsed').toBeGreaterThan(1)
  return found
}

/** The `executeJson` default — the client a verb gets when it passes none. */
function ktDefaultClient(): string {
  const m = code(KT_API).match(/fun executeJson\(request: Request, httpClient: OkHttpClient = (\w+)\)/)
  expect(m, 'executeJson no longer declares a default client').toBeTruthy()
  return m![1]
}

type KtSite = { file: string; verb: string; client: string; ms: number }

/** How long a TinyApi verb waits: the client it hands `executeJson`, or the default. */
function ktVerbMs(verb: string): { client: string; ms: number } {
  const client =
    body(code(KT_API), `suspend fun ${verb}(`).match(/executeJson\(req(?:uest)?,\s*(\w+)\)/)?.[1] ??
    ktDefaultClient()
  const ms = ktClients()[client]
  expect(ms, `${verb} resolves to client "${client}", which declares no callTimeout`).toBeGreaterThan(0)
  return { client, ms }
}

/** EVERY Android call site for `path`, with the deadline each one actually gets.
 *
 *  Deliberately not "the call site" — the first version of this helper asserted a
 *  single verb per path and blew up on `/api/wallet/withdraw`, which had TWO: the
 *  wallet card on the long settle client, and the `/wallet withdraw` chat command
 *  still on the 30s default. That second site was a live instance of this very
 *  defect, found because the resolver refused to average over call sites. So the
 *  check is per-site and the row takes the WEAKEST.
 *
 *  `verbMatch` separates the money-moving verb from a same-path sibling: the
 *  quote-only re-mint POSTs to `/api/x402/pay` too and is correctly short. */
function androidCalls(path: string, verbMatch: RegExp): KtSite[] {
  const re = new RegExp(`\\.(\\w+)\\(\\s*"${path.replace(/\//g, '\\/')}"`, 'g')
  const sites: KtSite[] = []
  for (const f of ktFiles()) {
    if (f.endsWith('TinyApi.kt')) continue // the verb declarations themselves
    for (const m of Array.from(code(f).matchAll(re))) {
      if (verbMatch.test(m[1])) sites.push({ file: f, verb: m[1], ...ktVerbMs(m[1]) })
    }
  }
  expect(sites.length, `no Android call site matching ${verbMatch} for ${path}`).toBeGreaterThan(0)
  return sites
}

/** The weakest deadline any Android surface uses for `path` — one short site is
 *  enough to strand a payment, so the minimum is the number under test. */
const androidWeakest = (path: string, verbMatch: RegExp): KtSite =>
  androidCalls(path, verbMatch).reduce((a, b) => (b.ms < a.ms ? b : a))

// ── iOS: the two shapes its money calls take ──────────────────────────────────

const SWIFT_API = 'ios/Tiny/Sources/Api.swift'
const SWIFT_WALLET = 'ios/Tiny/Sources/Wallet.swift'

/** `Api.putBody` / `Api.postBody` set their own fixed `timeoutInterval`. */
function iosApiHelperMs(fn: string): number {
  const m = body(code(SWIFT_API), `static func ${fn}(`).match(/req\.timeoutInterval = (\d+)/)
  expect(m, `Api.${fn} sets no timeoutInterval`).toBeTruthy()
  return Number(m![1]) * 1000
}

/** `Wallet.post(path, body, timeout:)` — the call site's argument, or the helper's
 *  own declared default when it passes none. Both read from source. */
function iosWalletPostMs(path: string): number {
  const src = code(SWIFT_WALLET)
  const args = callArgs(src, `post("${path}"`)
  const at = args.match(/timeout: (\d+)/)
  if (at) return Number(at[1]) * 1000
  const dflt = src.match(/private func post\([^)]*timeout: TimeInterval = (\d+)/)
  expect(dflt, 'Wallet.post declares no default timeout').toBeTruthy()
  return Number(dflt![1]) * 1000
}

// ── the matrix ────────────────────────────────────────────────────────────────

type Row = {
  path: string
  what: string
  ios: () => number
  /** The money-moving verb pattern — see androidCalls. */
  verb: RegExp
  androidSites: () => KtSite[]
  android: () => KtSite
}

const row = (path: string, what: string, verb: RegExp, ios: () => number): Row => ({
  path,
  what,
  verb,
  ios,
  androidSites: () => androidCalls(path, verb),
  android: () => androidWeakest(path, verb),
})

const MONEY: Row[] = [
  // NOT /^putJson$/ for the pay row: `putJson` is the devices relay long-poll's verb
  // and must KEEP the short cap. The money call has to be the one that doesn't.
  row('/api/x402/pay', 'the settlement PUT — the sole money-moving call', /^putJson/, () =>
    iosApiHelperMs('putBody'),
  ),
  row('/api/wallet/withdraw', 'the payout — signs + broadcasts on-chain', /^postJson/, () =>
    iosWalletPostMs('/api/wallet/withdraw'),
  ),
  row('/api/wallet/faucet', 'the drip — credits the ledger, THEN waits on the mint', /^postJson/, () =>
    iosWalletPostMs('/api/wallet/faucet'),
  ),
]

describe('every client outlasts the money route it calls', () => {
  for (const row of MONEY) {
    it(`${row.path} — ${row.what}`, () => {
      const serverMs = routeBudgetMs(row.path)
      // Every Android SITE, not the weakest: the numbers are identical either way
      // (min ≤ all), but the failure message has to name the file. The chat
      // `/wallet withdraw … confirm` command was the second withdraw site and was
      // still on the 30s default — "Android gives up at 30000ms" would have sent
      // the next reader to the wallet card, which was already correct.
      const clients: [string, number][] = [
        ['web', deadlineFor(row.path)],
        ['iOS', row.ios()],
        ...row.androidSites().map((s): [string, number] => [`Android ${s.file.split('/').pop()} → ${s.verb}`, s.ms]),
      ]
      const short = clients
        .filter(([, ms]) => exceedsServerBudget(ms, serverMs))
        .map(([name, ms]) => `${name} gives up at ${ms}ms, server may work until ${serverMs}ms`)
      expect(
        short,
        `these clients hang up on a route that is still working, then tell the user ` +
        `the money didn't move:\n${short.join('\n')}`,
      ).toEqual([])
      // Vacuity: a resolver that silently returned 0 would pass the check above only
      // by making `exceedsServerBudget(0, serverMs)` true — but a resolver that
      // returned Infinity, or a row whose path stopped existing, would pass quietly.
      for (const [name, ms] of clients) expect(ms, `${name} deadline for ${row.path}`).toBeGreaterThan(0)
    })
  }

  it('the pay PUT gets its own client — raising the shared one would break the relay', () => {
    const { verb, client, ms } = MONEY[0].android()
    expect(verb).toBe('putJsonPay')
    expect(client).toBe('payClient')

    // The OTHER PUT caller is the devices relay long-poll. If a future cycle "fixes"
    // a short-deadline finding by widening `putJson` itself, that poll would hold a
    // socket for minutes at a time — so the short cap staying short is part of this
    // fix, not incidental. Bounded by the loop's OWN cadence rather than a literal
    // 30s: `expect(relay.client).toBe(ktDefaultClient())` reads the same source
    // twice and is true by construction, so it proves nothing on its own.
    const relay = androidWeakest('/api/devices/relay', /^putJson$/)
    expect(relay.verb).toBe('putJson')
    expect(relay.ms).toBeLessThan(ms)
    const loop = body(code('android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt'), 'private suspend fun relayLoop')
    const cadence = loop.match(/delay\((\d+)_?(\d*)\)/)
    expect(cadence, 'relayLoop no longer declares its poll interval').toBeTruthy()
    const cadenceMs = Number(`${cadence![1]}${cadence![2]}`)
    expect(relay.ms, `a ${cadenceMs}ms poll must not hold a socket for ${relay.ms}ms`)
      .toBeLessThanOrEqual(cadenceMs * 10)
  })

  it('the quote-only twin at the same path is NOT held to the settlement budget', () => {
    // POST /api/x402/pay re-mints a fresh quote and moves no money, so the 180s
    // ceiling isn't its budget and the short client is correct for it. Pinned so
    // that if a money body is ever sent on this verb, the exemption fails loudly:
    // the settlement body is {quote, message}, the re-quote's is {url, message,
    // prior_quote} — a `quote` key on THIS verb would mean money on a 30s cap.
    const kt = androidWeakest('/api/x402/pay', /^postJson$/)
    expect(kt.client).toBe(ktDefaultClient())
    const site = code('android/app/src/main/java/technology/tiny/app/ui/PayReceiptCard.kt')
    expect(callArgs(site, 'postJson("/api/x402/pay"')).toContain('reQuoteBody')
    // iOS's twin, same shape: postBody (30s) for the re-quote, putBody for the money.
    const swift = code('ios/Tiny/Sources/PayQuote.swift')
    const reQuote = callArgs(swift, 'postBody("/api/x402/pay"')
    expect(reQuote).toContain('"prior_quote"')
    expect(reQuote).not.toMatch(/"quote":/)
    expect(callArgs(swift, 'putBody("/api/x402/pay"')).toMatch(/"quote":/)
    expect(iosApiHelperMs('postBody')).toBeLessThan(iosApiHelperMs('putBody'))
  })

  it('all three clients agree on the settlement budget, and web is where it came from', () => {
    // Not a byte-mirror pin: they're different languages and different units. What
    // must hold is that no client is the odd one out — a single lowered number is
    // how this defect existed for as long as it did.
    const web = deadlineFor('/api/x402/pay')
    expect(iosApiHelperMs('putBody')).toBe(web)
    expect(MONEY[0].android().ms).toBe(web)
  })
})

describe('the invariant is stated in prose in all three clients — and now checked', () => {
  it('each client still explains WHY its budget is long', () => {
    // If a future cycle deletes the reasoning, the number becomes a magic constant
    // and the next person shortens it. The check is that the explanation survives
    // next to the number, in the file that owns the number.
    expect(read(KT_API)).toMatch(/maxDuration = 180/)
    expect(read(SWIFT_API)).toMatch(/maxDuration = 180/)
    expect(read('lib/deadlines.ts')).toMatch(/maxDuration = 180/)
  })

  it('the route it is measured against still declares 180', () => {
    // The one number this suite reads from the OTHER side of the race. If the route
    // raises its ceiling, every client above becomes too short and the rows fail —
    // this assertion just makes the cause readable when they do.
    expect(routeBudgetMs('/api/x402/pay')).toBe(180_000)
  })
})
