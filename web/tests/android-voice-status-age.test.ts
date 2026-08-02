// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🕒 A status reading stops claiming to be newer than it is.
 *
 * **A reading is TWO facts — the values, and when they were read.** The Nicla
 * Voice panel only ever held the first. `NiclaVoiceGateway._status` carried no
 * timestamp at all, and status arrives ONLY by BLE notify — `refreshStatus()` has
 * no caller on either platform, verified by grep — so the phone cannot ask the
 * board to repeat itself. A necklace that boots, notifies once and then wedges (a
 * crashed firmware loop, an NDP load that never finishes, a `.synpkg` half
 * written) leaves a link that is genuinely UP under a figure that will never move
 * again, and the panel goes on saying "listening · 3 wake words · 12 heard" in the
 * present tense about an hour ago.
 *
 * That is the second of two staleness cases. `liveVoiceStatus` already covers the
 * first — the one the phone KNOWS about, where the link dropped and the reading is
 * withdrawn. This is the one it doesn't: **the link stays up while the readings
 * stop.** iOS fixed the same class on a different transport at `43914e44`
 * (`FlipperGateway.infoAt`), where a refresh that deliberately keeps stale values
 * on failure — a blank panel being worse than a stale line — must not also keep
 * the impression that they are current. The timestamp moves only when the reading
 * moves.
 *
 * `VoiceStatusLineTest` (Kotlin) owns the pure rules: the ladder, the freshness
 * threshold, the backwards-clock guard, elapsed-not-clock-time. This suite owns
 * what a JVM test cannot see — WHERE the stamp is written, that it is cleared with
 * the value it dates, and that the panel can actually draw an age line while
 * nothing at all is arriving.
 */

const ROOT = process.cwd()
const GW = join(ROOT, 'android/app/src/main/java/technology/tiny/app/fleet/NiclaVoiceGateway.kt')
const PANELS = join(ROOT, 'android/app/src/main/java/technology/tiny/app/ui/Panels.kt')

/** Comments stripped: a rule explained in prose must not satisfy a pin. */
const stripped = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** The `{ … }` block opening at or after `at`, brace-matched. */
function braced(source: string, at: number): string {
  const open = source.indexOf('{', at)
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open, i)
}

/** A block, with its anchor ASSERTED — an unfound anchor makes every `.not` pin vacuous. */
function body(source: string, signature: string): string {
  const at = source.indexOf(signature)
  expect(at, `${signature} not found — every pin below would be vacuous`).toBeGreaterThan(-1)
  return braced(source, at)
}

describe('a Nicla Voice reading carries when it was read', () => {
  it('the reading is dated at all, and the date is observable', () => {
    // 🔴 THE GAP in one pin: `_status` was a value with no time attached, so no
    // surface could tell a reading from a minute ago apart from one from an hour ago.
    const gw = stripped(GW)
    expect(gw, 'the reading lost its timestamp — every panel is back to guessing')
      .toMatch(/private val _statusAt = MutableStateFlow<Long\?>\(null\)/)
    expect(gw, 'the timestamp is unreachable from any screen')
      .toMatch(/val statusAt: StateFlow<Long\?> = _statusAt/)
  })

  it('it is stamped where the reading LANDS, not where someone asked', () => {
    // ⚠️ Inside `handleStatus`'s `let`, and the placement IS the fix. Two ways to get
    // it wrong, both of which look right:
    //   · at the top of `refreshStatus()` — that dates the ASK, and on this transport
    //     the answer may simply never come, so the age would count down from a
    //     question nobody replied to;
    //   · outside the `let` — an unparseable notify (a truncated MTU write, firmware
    //     mid-flash) deliberately KEEPS the last good reading, and re-dating it there
    //     is the original defect exactly: values from an hour ago, freshly stamped.
    const gw = stripped(GW)
    const handler = body(gw, 'private fun handleStatus(value: ByteArray)')
    const arm = body(handler, 'parseStatus(value)?.let')
    expect(arm, 'the stamp left the parsed arm — an unparseable notify now re-dates stale values')
      .toMatch(/_statusAt\.value = System\.currentTimeMillis\(\)/)
    expect(arm, 're-anchor: this arm no longer holds the reading it is supposed to date')
      .toMatch(/_status\.value = it/)
    // EXACTLY ONE stamp in the whole gateway: a second one anywhere else is a second
    // answer to "when was this read", and the optimistic one always wins the race.
    expect((gw.match(/_statusAt\.value = System\.currentTimeMillis\(\)/g) ?? []).length,
      'a second stamp appeared — something other than a landed reading now sets the date').toBe(1)
    // And never from the ask side.
    const refresh = body(gw, 'fun refreshStatus()')
    expect(refresh, 'refreshStatus() dates the question instead of the answer')
      .not.toMatch(/_statusAt/)
  })

  it('the date is cleared with the value it dates, never on its own', () => {
    // ⚠️ `forget()` is the ONLY place `_status` is cleared — deliberately not on
    // disconnect, because a wake delivered over a link that dropped a second later
    // still has to reach the row. So the two must be dropped together: a surviving
    // timestamp with no reading dates a value from a board this phone no longer
    // knows, and a surviving reading with no timestamp is the original bug back.
    const gw = stripped(GW)
    const forget = body(gw, 'fun forget(context: Context)')
    expect(forget, 'unpairing keeps the reading\'s date — it now dates a board this phone forgot')
      .toMatch(/_statusAt\.value = null/)
    expect(forget, 're-anchor: forget() no longer clears the reading itself')
      .toMatch(/_status\.value = null/)
    // The reading may never be cleared anywhere its date isn't, and vice versa: both
    // counts are 1, which is what keeps them in step without asserting an ordering.
    expect((gw.match(/_status\.value = null/g) ?? []).length,
      'the reading is cleared somewhere the date is not').toBe(1)
    expect((gw.match(/_statusAt\.value = null/g) ?? []).length,
      'the date is cleared somewhere the reading is not').toBe(1)
  })

  it('the panel has a clock of its own — the age must appear while nothing arrives', () => {
    // ⚠️ THE SUBTLE HALF, and the reason a JVM test can never see this bug: a Compose
    // panel recomposes when something CHANGES, and this line's entire job is to show
    // up when nothing is changing. Without a ticker the age would render correctly
    // the instant some unrelated state moved and otherwise stay invisible for exactly
    // as long as the board stayed silent — which is precisely the window it exists for.
    const panels = stripped(PANELS)
    const panel = body(panels, 'internal fun VoiceDevicePanel(app: TinyApp, deviceId: String)')
    expect(panel, 'the panel stopped collecting the reading\'s date')
      .toMatch(/val statusAt by gw\.statusAt\.collectAsState\(\)/)
    expect(panel, 'the age line lost its clock — it can only appear when something else changes')
      .toMatch(/var nowMs by remember \{ mutableStateOf\(System\.currentTimeMillis\(\)\) \}/)
    const tick = body(panel, 'LaunchedEffect(Unit) {\n        while (true) {')
    expect(tick, 're-anchor: the ticker no longer advances the clock the age reads')
      .toMatch(/nowMs = System\.currentTimeMillis\(\)/)
    // 10s, because the ladder counts seconds below 90 — a coarser tick would leave
    // "read 61s ago" on screen for a visible fraction of a minute.
    expect(tick, 'the tick is no longer 10s — the seconds rung of the ladder now lags')
      .toMatch(/delay\(10_000\)/)
    // ⚠️ …and the rendered age must read the TICKED clock. `voiceStatusAge(statusAt)`
    // compiles — `now` defaults to System.currentTimeMillis() — and would be evaluated
    // only at recomposition, silently restoring the bug this ticker exists to fix.
    expect(panel, 'the age reads the wall clock instead of the ticker — it freezes between recompositions')
      .toMatch(/voiceStatusAge\(statusAt, nowMs\)/)
  })

  it('the age is gated on the READING, not on the detail line above it', () => {
    // ⚠️ The tempting shape is to hang the age off `voiceStatusLine`'s `let`, since
    // they are adjacent and both optional. It drops the age exactly where it matters
    // most: `voiceStatusLine` answers null for a board that reported nothing
    // quantified (every count zero, no uptime) — and the badge is STILL UP in that
    // case, saying "listening" or "not listening". So that shape is silent precisely
    // where the stale claim has the least around it to contradict it.
    const panels = stripped(PANELS)
    const panel = body(panels, 'internal fun VoiceDevicePanel(app: TinyApp, deviceId: String)')
    const at = panel.indexOf('voiceStatusAge(')
    expect(at, 're-anchor: the panel no longer draws the age').toBeGreaterThan(-1)
    // ONE call site, which is what makes checking this one total.
    expect((panel.match(/voiceStatusAge\(/g) ?? []).length,
      'the age is drawn from more than one place — only one of them is checked below').toBe(1)
    // Walk back to the nearest `let` and check what opened it.
    const gate = panel.slice(0, at).lastIndexOf('liveVoiceStatus(status, connected)?.let')
    expect(gate, 'the age is no longer gated by the same decision as the badge').toBeGreaterThan(-1)
    expect(panel.slice(gate, at), 'the age hangs off the detail line — it goes silent for a board that reported nothing usable')
      .not.toMatch(/voiceStatusLine/)
    // …and it is really INSIDE that gate, not merely written after it: an ungated age
    // dates a withdrawn reading, printing how old a figure is directly beneath "out of
    // range", where the figure itself is not shown.
    expect(braced(panel, gate), 'the age escaped the gate — it dates a reading the panel is not showing')
      .toMatch(/voiceStatusAge\(/)
    // ⚠️ And the computed age is actually RENDERED. This pin exists because a mutant
    // that kept every line above and dropped only the `Text` sailed through: the flow
    // is collected, the ticker runs, the ladder is computed — and the one sentence a
    // person would read is gone, which is the original defect with more machinery.
    expect(braced(panel, at), 'the age is computed and never drawn')
      .toMatch(/Text\(\s*age,/)
  })

  it('a backwards clock is clamped, which no behavioural test can prove', () => {
    // ⚠️ Pinned HERE and not in `VoiceStatusLineTest` on purpose: dropping the clamp
    // is an EQUIVALENT mutant today, and the harness proved it. A clock that went
    // backwards (an NTP correction, a manual time change while the sheet is open)
    // gives a negative gap, and a negative gap is trivially below STATUS_FRESH_S, so
    // the freshness gate returns null and the clamp changes no observable output.
    //
    // It is kept because it is what keeps that true. The moment the threshold is
    // tightened — and 60s is a judgement call about a firmware cadence not in this
    // tree, so it will be argued with — an unclamped negative falls straight through
    // into the seconds rung as "read -180s ago", a line that makes the panel look
    // broken instead of the board. Structure is the only place this invariant can
    // live, so it is pinned as structure.
    const panels = stripped(PANELS)
    const fn = body(panels, 'internal fun voiceStatusAge(')
    expect(fn, 'the elapsed gap is unclamped — a backwards clock can print a negative age')
      .toMatch(/\.coerceAtLeast\(0L\)/)
    // …and the clamp must sit on the gap itself, before any rung reads it.
    expect(fn, 're-anchor: the clamp no longer wraps the elapsed seconds')
      .toMatch(/val s = \(\(now - atMs\) \/ 1_000L\)\.coerceAtLeast\(0L\)/)
  })

  it('⚠️ FAILS WHEN FIXED: the board still cannot be asked to repeat itself', () => {
    // WHY an age line is the fix rather than a re-read. `refreshStatus()` exists on
    // both platforms and has no caller on either — status is push-only, by BLE
    // notify — so when a reading goes quiet this phone has no way to get a newer one
    // and the honest move is to date the one it has.
    //
    // If a caller ever lands (a pull-to-refresh, a panel-open poll, `nicla_status`
    // wired through the gateway rather than the relay), this pin fails and the
    // decision is worth re-taking: with a re-read available, a stale reading could be
    // REPLACED instead of merely dated, and the age line becomes a fallback for when
    // the re-read itself times out.
    const gw = stripped(GW)
    expect(gw, 'the stripped source is empty — every pin here is vacuous')
      .toMatch(/internal object NiclaVoiceGateway|object NiclaVoiceGateway \{/)
    const panels = stripped(PANELS)
    expect(panels, '🎉 something calls refreshStatus() now — a stale reading can be REPLACED, not just dated')
      .not.toMatch(/refreshStatus\(\)/)
    // The other half of the same fact: nothing but a notify may write the reading.
    expect((gw.match(/_status\.value = /g) ?? []).length,
      'a second writer of the reading appeared — the stamp in handleStatus no longer dates every value').toBe(2)
  })
})
