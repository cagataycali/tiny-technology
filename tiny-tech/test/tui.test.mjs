/**
 * 🖥️  The TUI itself — concurrent conversations rendered by the real component tree.
 *
 * conversations.test.mjs proves the reducer's rules and fork.test.mjs proves the
 * history bookkeeping; neither would catch App.tsx wiring the two together wrong.
 * This drives the actual Ink app with a fake stdin and a fake session whose turns
 * park mid-stream, so two turns MUST overlap for the assertions to pass.
 *
 * Three things about faking Ink v7's terminal that are easy to get wrong:
 *  - it never listens for 'data' — it attaches a 'readable' listener and drains
 *    with stdin.read() until null;
 *  - one chunk is one keypress event, so "text\r" arrives as a single string
 *    with the \r inside it and never submits. Real keys come one at a time, so
 *    these do too;
 *  - a PASTE is not "a long chunk", it's bracketed: \x1b[200~ … \x1b[201~. That
 *    matters both ways — `paste()` below has to send the markers, and enabling
 *    the mode makes Ink write \x1b[?2004h to stdout, which is a write but not a
 *    frame (see `frame()`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import React from 'react'
import { render } from 'ink'
import stringWidth from 'string-width'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 🧪 Isolation. The app reads the real machine unless told otherwise, and one
 * of those reads is now the loop registry — the picture-in-picture strip polls
 * ~/.tiny/loops. A developer with a loop actually running made three unrelated
 * tests fail (a real ♾ row appeared inside the frames they were matching), which
 * is a test bug and not a UI bug: assertions about a rendered screen have to own
 * everything on that screen. Every boot() below gets an empty loops dir, and the
 * strip test writes its own record into one.
 */
const LOOPS_HOME = mkdtempSync(join(tmpdir(), 'tiny-tui-loops-'))
process.env.TINY_LOOPS_DIR = LOOPS_HOME
process.on('exit', () => { try { rmSync(LOOPS_HOME, { recursive: true, force: true }) } catch {} })

/** A loop record on disk, as the runner writes it (agent/loop.ts writeLoop). */
function writeLoopRecord(dir, rec) {
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify({
    prompt: 'do the thing', status: 'running', startedAt: Date.now() - 60_000,
    iterations: [], pid: process.pid, host: 'test', ...rec,
  }))
}

const { default: App } = await import('../dist/tui/App.js')
const { requestInteraction } = await import('../dist/agent/interact.js')

class Stdin extends EventEmitter {
  isTTY = true
  #queue = []
  setRawMode() {} ref() {} unref() {} resume() {} pause() {} setEncoding() {}
  read() { return this.#queue.shift() ?? null }
  async type(s) {
    for (const ch of s) { this.#queue.push(ch); this.emit('readable'); await tick(0) }
  }
  /**
   * One escape SEQUENCE as a single chunk — an arrow key is `\x1b[B` arriving
   * together, and typing it character by character (what `type` does) is instead
   * an Esc followed by two letters. The distinction is the whole reason the menu
   * has to share ↑/↓ with the input history rather than owning them.
   */
  async seq(s) {
    this.#queue.push(s)
    this.emit('readable')
    await tick(0)
  }
  /** One bracketed paste — what a terminal sends when you hit ⌘V, verbatim. */
  async paste(s) {
    this.#queue.push(`\x1b[200~${s}\x1b[201~`)
    this.emit('readable')
    await tick(0)
  }
}

/**
 * Terminal mode switches (bracketed paste on/off, cursor hide/show) go down the
 * same stream as the frames but are not frames — a test that took the last write
 * would read `\x1b[?2004h` as the UI.
 */
const isFrame = (s) => s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').trim().length > 0

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/**
 * A session whose forks stop at a gate. Nothing finishes until `release()`, so
 * anything the test observes in between is genuinely simultaneous.
 */
function fakeSession(opts = {}) {
  const gates = []
  const s = {
    forks: 0, cancelled: 0, absorbed: 0, injected: [], cleared: 0,
    modelLabel: 'fake:test', isLocal: true, localTools: null,
    forkSession() {
      s.forks++
      return {
        async *streamTurn(q) {
          for (const t of opts.tools || [{ name: 'bash' }]) {
            yield { kind: 'tool_start', name: t.name, input: t.input }
          }
          await new Promise((r) => gates.push(r))
          yield { kind: 'tool_end', name: 'bash' }
          for (const ev of opts.emit || []) yield ev
          yield { kind: 'text', text: `answer to ${q}` }
          yield { kind: 'done', text: `answer to ${q}` }
        },
        cancelTurn() { s.cancelled++ },
      }
    },
    absorb() { s.absorbed++; return opts.absorbCount ?? 0 },
    /** Why absorb() refused the last seam — null when it was clean. */
    lastAbsorbIssue: opts.absorbIssue ?? null,
    injectExchange(q, a) { s.injected.push([q, a]) },
    /** /clear — the model side. Returns what it dropped, like the real one. */
    clearHistory() { s.cleared++; return opts.historyLength ?? 6 },
    release() { const g = gates.splice(0); g.forEach((r) => r()) },
  }
  return s
}

/**
 * Mount the real App; returns the latest rendered frame on demand.
 *
 * `size` is a real part of the contract now that the layout is width- and
 * height-aware: 100×40 is a comfortable terminal, and passing something smaller
 * is how the narrow-terminal tests below reproduce what a split pane looks like.
 */
async function boot(env = {}, sessionOpts = {}, size = {}) {
  const prev = {}
  env = { TINY_LOOPS_DIR: LOOPS_HOME, ...env }
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v }
  const frames = []
  const stdout = Object.assign(new EventEmitter(), {
    columns: size.columns ?? 100, rows: size.rows ?? 40, isTTY: true,
    write: (s) => { frames.push(s); return true },
  })
  const stdin = new Stdin()
  const agent = fakeSession(sessionOpts)
  const app = render(React.createElement(App, { agent, who: '@test' }),
    { stdin, stdout, debug: true, exitOnCtrlC: false })
  await tick()
  return {
    agent, stdin,
    /** ANSI-stripped — colors (npm sets FORCE_COLOR in TTY runs) must not split words. */
    frame: () => (frames.filter(isFrame).at(-1) || '').replace(/\x1b\[[0-9;]*m/g, ''),
    /** The bordered rows of the frame, ANSI stripped — what a border test measures. */
    borders: () => frames.filter(isFrame).at(-1)?.split('\n')
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
      .filter((l) => /^[╭│╰]/.test(l)) || [],
    async ask(q) { await stdin.type(`${q}\r`); await tick() },
    async key(k) { await stdin.type(k); await tick() },
    async seq(k) { await stdin.seq(k); await tick() },
    async paste(s) { await stdin.paste(s); await tick() },
    /** Resize the terminal, the way a window drag does. */
    async resize(columns, rows) {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
      await tick()
    },
    async settle() { agent.release(); await tick(); await tick() },
    done() {
      app.unmount()
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    },
  }
}

test('the composer is open before anything has been asked', async () => {
  const t = await boot()
  try {
    assert.match(t.frame(), /ask tiny anything/)
    assert.match(t.frame(), /turns run in parallel/)
  } finally { t.done() }
})

test('a question asked WHILE another streams starts immediately — the original bug', async () => {
  // The old composer did `if (!q || busy) return`, silently discarding the
  // second question while its placeholder claimed the input was queued.
  const t = await boot()
  try {
    await t.ask('first question')
    await t.ask('second question')

    assert.equal(t.agent.forks, 2, 'the second question got its own forked conversation')
    const f = t.frame()
    assert.match(f, /#1 .*first question/, 'panel for the first is still live')
    assert.match(f, /#2 .*second question/, 'and the second is live alongside it')
    assert.match(f, /2 running/)
    assert.match(f, /ask another, it starts now/, 'the composer never closed')
  } finally { t.done() }
})

test('both concurrent answers keep their #id in the transcript', async () => {
  // The last of two concurrent turns to land is alone by then — tagging by the
  // count at completion time would strip the tag from the answer that most
  // needs it, since interleaved answers are exactly what the tag disambiguates.
  const t = await boot()
  try {
    await t.ask('first question')
    await t.ask('second question')
    await t.settle()

    const f = t.frame()
    assert.match(f, /#1 first question/)
    assert.match(f, /#2 second question/)
    assert.match(f, /answer to first question/)
    assert.match(f, /answer to second question/)
    assert.equal(t.agent.absorbed, 2, 'each clean exchange folded back into the session')
    assert.match(f, /ask tiny anything/, 'and the composer is idle again')
  } finally { t.done() }
})

test('a turn that overflowed and RECOVERED folds back in full, not as a summary', async () => {
  // BUG-fork-history-loss.md, conspiring bug B: the overflow heal reported itself
  // as an error, and the fold-back rule reads any error as "this history is
  // unsafe" — so a turn that trimmed its way out and then answered perfectly was
  // still downgraded to a lossy text summary. "Failed" and "recovered" differ.
  const t = await boot({}, {
    absorbCount: 2,
    emit: [{ kind: 'notice', message: 'context overflow — trimmed the oldest history and retried' }],
  })
  try {
    await t.ask('what about the wifi board?')
    await t.settle()

    assert.equal(t.agent.absorbed, 1, 'the real exchange reached the session')
    assert.deepEqual(t.agent.injected, [], 'and nothing was downgraded to text')
    const f = t.frame()
    assert.match(f, /answer to what about the wifi board\?/)
    assert.match(f, /trimmed the oldest history/, 'the trim is said out loud, not hidden')
  } finally { t.done() }
})

test('a turn absorb REFUSES degrades to a text summary and says why', async () => {
  // A dangling tool pair would make the whole session history invalid on some
  // later turn, so absorb() vetoes it — but a veto that folded nothing back and
  // said nothing is exactly the silence that made the session go amnesic.
  const t = await boot({}, { absorbCount: 0, absorbIssue: 'refused to fold back a 3-message turn: it starts on a tool result' })
  try {
    await t.ask('run something')
    await t.settle()

    assert.equal(t.agent.absorbed, 1, 'absorb was attempted')
    assert.equal(t.agent.injected.length, 1, 'and its refusal fell back to text')
    assert.match(t.agent.injected[0][1], /starts on a tool result/)
  } finally { t.done() }
})

test('a turn that ran alone gets no tag — the marker is for ambiguity only', async () => {
  const t = await boot()
  try {
    await t.ask('lonely question')
    await t.settle()
    const f = t.frame()
    assert.match(f, /lonely question/)
    assert.doesNotMatch(f, /#1/, 'nothing to disambiguate, so no noise')
  } finally { t.done() }
})

test('^C stops the newest conversation and leaves the older one streaming', async () => {
  const t = await boot()
  try {
    await t.ask('keep me')
    await t.ask('cancel me')
    await t.key('\x03')

    assert.equal(t.agent.cancelled, 1, 'exactly one fork was cancelled')
    const f = t.frame()
    assert.match(f, /#2 cancel me/)
    assert.match(f, /⊘ cancelled/)
    // The survivor is now the only thing on screen, so ConvPanel drops to `bare`
    // and stops printing its own `#1 keep me` header — by design, not a loss.
    assert.match(f, /running bash…/, 'the older turn is untouched and still streaming')
    assert.match(f, /1 running/)
    assert.doesNotMatch(f, /answer to keep me/, 'and it certainly has not finished')
    // A cancelled turn folds back as TEXT: cut mid-flight it can sit on a
    // toolUse whose result never came, which would poison every later turn.
    assert.equal(t.agent.absorbed, 0)
    assert.equal(t.agent.injected.length, 1)
    assert.match(t.agent.injected[0][1], /cancelled/)
  } finally { t.done() }
})

test('a cancelled stream finishing later does not print itself twice', async () => {
  const t = await boot()
  try {
    await t.ask('doomed')
    await t.key('\x03')
    await t.settle()             // the parked generator now runs to completion
    const f = t.frame()
    assert.equal(f.match(/doomed/g).length, 1, 'the late arrival was ignored')
    assert.doesNotMatch(f, /answer to doomed/)
  } finally { t.done() }
})

test('a chip says what the tool is DOING, not just which tool it is', async () => {
  const t = await boot({}, { tools: [{ name: 'bash', input: { command: 'npm test -- --watch' } }] })
  try {
    await t.ask('run the tests')
    const f = t.frame()
    assert.match(f, /bash npm test -- --watch/, 'the command is on the chip')
    assert.match(f, /running bash npm test/, 'and in the status line')
  } finally { t.done() }
})

test('a tool-heavy panel stays short enough to keep the composer on screen', async () => {
  // 20 chips unbounded would push the composer past a 40-row terminal.
  //
  // The cap itself is arithmetic on the real terminal size now, not a constant,
  // so this asserts the PROPERTY — every chip is either drawn or counted, and
  // the ones kept are the newest. layout.test.mjs pins the number the arithmetic
  // produces; hardcoding it here too just gives the same rule two places to
  // drift, which is exactly how this assertion came to be wrong.
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'bash', input: { command: `step-${i}` } }))
  const t = await boot({}, { tools: many })
  try {
    await t.ask('first')
    await t.ask('second')            // 2 live → framed panels → chips capped
    const f = t.frame()
    const folded = f.match(/⋯ (\d+) earlier tool calls/)
    assert.ok(folded, 'the excess is counted, not dropped silently')
    const shown = [...f.matchAll(/step-(\d+)/g)].map((m) => Number(m[1]))
    const perPanel = new Set(shown).size
    assert.equal(Number(folded[1]) + perPanel, 20, 'every chip is either drawn or counted')
    assert.match(f, /step-19/, 'the newest chips are the ones kept')
    assert.doesNotMatch(f, /step-0\b/, 'the oldest are folded into the count')
    assert.match(f, /ask another, it starts now/, 'and the composer survived')
  } finally { t.done() }
})

test('panel borders stay square when wide emoji chips are on screen', async () => {
  // The symptom the icon table's width rules exist to prevent: Ink lays out with
  // string-width, so a glyph it under-measures pushes that row's right border a
  // column past the others and the box visibly leans. Checking the icons in
  // isolation cannot catch it — only measuring the rendered frame can.
  const t = await boot({}, { tools: [
    { name: 'mesh_send', input: { message: 'ping the swarm' } },
    { name: 'use_computer', input: { action: 'screenshot' } },
    { name: 'use_google', input: { query: 'inbox' } },
    { name: 'use_telegram', input: { text: 'hi' } },
    { name: 'use_apple', input: { action: 'notes' } },
  ] })
  try {
    await t.ask('ping the mesh')
    await t.ask('check my mail')       // 2 live → framed panels → borders matter

    const lines = t.frame().split('\n')
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
      .filter((l) => /^[╭│╰]/.test(l))
    assert.ok(lines.length > 8, 'the framed panels rendered at all')

    const widths = new Set(lines.map((l) => stringWidth(l)))
    assert.equal(widths.size, 1,
      `ragged panel — bordered lines measured ${[...widths].join(', ')} columns`)
    for (const l of lines) {
      assert.match(l.trimEnd().slice(-1), /[╮│╯]/, `row lost its right border: ${JSON.stringify(l)}`)
    }
  } finally { t.done() }
})

test('a narrow terminal truncates the query instead of wrapping the border', async () => {
  // What `slice(0, 60)` used to do: at 60 columns a 60-character query filled the
  // row exactly, wrapped onto a second line INSIDE the border, and left a panel
  // with one header row and two right-hand walls. Flexbox + wrap="truncate-end"
  // is the fix, and only a real narrow render proves it.
  const long = 'explain the whole zenoh mesh discovery handshake in detail please'
  const t = await boot({}, {}, { columns: 60, rows: 30 })
  try {
    await t.ask(long)
    await t.ask('and the registry')     // 2 live → framed panels

    const lines = t.borders()
    assert.ok(lines.length > 6, 'the framed panels rendered at all')
    const widths = new Set(lines.map((l) => stringWidth(l)))
    assert.equal(widths.size, 1, `ragged at 60 columns: measured ${[...widths].join(', ')}`)
    assert.ok([...widths][0] <= 60, `a panel is wider than the terminal (${[...widths][0]})`)

    const f = t.frame()
    assert.doesNotMatch(f, new RegExp(long), 'the long query was truncated, not printed whole')
    assert.match(f, /explain the whole zenoh/, 'but as much of it as fits is there')
    assert.match(f, /ask another, it starts now/, 'and the composer is still on screen')
  } finally { t.done() }
})

test('the layout follows the terminal when it is resized mid-turn', async () => {
  // useWindowSize re-renders on stdout's 'resize'; the old code read process.stdout
  // once at mount, so dragging the window left the panels sized for the old one.
  const t = await boot({}, {}, { columns: 100, rows: 40 })
  try {
    await t.ask('one')
    await t.ask('two')
    const wide = stringWidth(t.borders()[0] || '')
    assert.ok(wide > 80, `expected a wide panel, measured ${wide}`)

    await t.resize(64, 24)
    const narrow = stringWidth(t.borders()[0] || '')
    assert.ok(narrow <= 64 && narrow < wide,
      `panels did not follow the resize: ${wide} → ${narrow}`)
    assert.match(t.frame(), /ask another, it starts now/, 'composer survived the shrink')
  } finally { t.done() }
})

test('a pasted paragraph arrives as ONE line and submits', async () => {
  // ⌘V of two lines used to write a raw \n into a single-line TextInput: the field
  // showed one mangled row and enter never fired, because the \n was part of the
  // value rather than a submit. Ink has a dedicated channel for this — usePaste —
  // and a paste is bracketed (\x1b[200~ … \x1b[201~), not merely "a long chunk".
  const t = await boot()
  try {
    await t.paste('summarise this:\n\n  - the mesh\n  - the registry\n')
    const f = t.frame()
    assert.match(f, /summarise this: - the mesh - the registry/, 'newlines collapsed to spaces')
    assert.equal(t.agent.forks, 0, 'a paste is not a submit — the human still presses enter')

    await t.key('\r')
    assert.equal(t.agent.forks, 1, 'and then it goes')
    // A lone live turn renders `bare` and prints no header, so the flattened
    // question is only visible again once it lands in the transcript.
    await t.settle()
    assert.match(t.frame(), /summarise this: - the mesh - the registry/,
      'the model was asked the paste as one question')
  } finally { t.done() }
})

test('pasting onto typed text joins with a space instead of gluing words', async () => {
  const t = await boot()
  try {
    await t.stdin.type('look at')
    await t.paste('this file')
    assert.match(t.frame(), /look at this file/)
  } finally { t.done() }
})

test('under a screen reader the UI is words, not braille spinners and box art', async () => {
  // INK_SCREEN_READER=true switches Ink to a renderer that drops borders and
  // layout entirely, so anything decorative that is not marked aria-hidden gets
  // READ ALOUD — ten braille frames a second, a clock re-announced every tick.
  const t = await boot({ INK_SCREEN_READER: 'true' })
  try {
    await t.ask('what is the mesh')
    const f = t.frame()

    assert.doesNotMatch(f, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, 'the spinner is decoration, not news')
    assert.doesNotMatch(f, /[╭╮╰╯│]/, 'no box art to read out')
    assert.doesNotMatch(f, /\d+s\b/, 'no elapsed clock — it would re-announce every second')
    assert.match(f, /running bash/, 'what it is doing is said in words')
    assert.match(f, /\(busy\)/, 'and the panel announces that it is still working')
    assert.match(f, /textbox/, 'the composer announces what it is')

    await t.settle()
    const done = t.frame()
    assert.match(done, /what is the mesh/, 'the question is in the transcript')
    assert.match(done, /answer to what is the mesh/, 'and so is the answer')
  } finally { t.done() }
})

test('/cancel #id stops that exact turn, not the newest', async () => {
  // ^C can only reach the newest; the whole point of panel ids is targeting.
  const t = await boot()
  try {
    await t.ask('slow one')          // #1
    await t.ask('second')            // #2
    await t.ask('third')             // #3
    await t.ask('/cancel #1')

    const f = t.frame()
    assert.equal(t.agent.cancelled, 1)
    assert.match(f, /#1 slow one/, 'the targeted turn landed in the transcript')
    assert.match(f, /⊘ cancelled/)
    assert.match(f, /#2 .*second/, 'the newer turns are still live')
    assert.match(f, /#3 .*third/)
    assert.match(f, /2 running/)
  } finally { t.done() }
})

test('/cancel all clears the board; /cancel with nothing live says so', async () => {
  const t = await boot()
  try {
    await t.ask('a')
    await t.ask('b')
    await t.ask('/cancel all')
    assert.equal(t.agent.cancelled, 2)
    assert.doesNotMatch(t.frame(), /running/, 'nothing left in flight')

    await t.ask('/cancel')
    assert.match(t.frame(), /⊘ nothing is running/)
  } finally { t.done() }
})

test('/cancel with an unknown id lists what IS live instead of failing silently', async () => {
  const t = await boot()
  try {
    await t.ask('only one')
    await t.ask('/cancel #99')
    assert.equal(t.agent.cancelled, 0)
    assert.match(t.frame(), /no running conversation #99 — live: #1/)
  } finally { t.done() }
})

test('a finished turn reports how long it took, once that is worth saying', async () => {
  const t = await boot()
  try {
    await t.ask('quick')
    await t.settle()
    // The fake turn finishes in milliseconds, so the marker is correctly absent.
    assert.doesNotMatch(t.frame(), /❯ quick · \d/, 'sub-2s waits are not annotated')
  } finally { t.done() }
})

test('Esc dismissing an agent question does NOT also drop the queue', async () => {
  // Two handlers used to read the same Esc: InteractView cancelled the question
  // and the composer silently dropped every queued turn behind it. One key press,
  // one destructive side effect the user never asked for.
  const t = await boot({ TINY_MAX_CONCURRENT: '1' })
  try {
    await t.ask('running turn')
    await t.ask('queued turn')
    assert.match(t.frame(), /queued — queued turn/)

    const answer = requestInteraction({ type: 'confirm', text: 'proceed?', timeoutMs: 60_000 })
    await tick()
    assert.match(t.frame(), /proceed\?/, 'the question is on screen')

    await t.key('\x1b')                       // Esc — meant for the question only
    assert.deepEqual(await answer, { ok: false, cancelled: true }, 'the question was cancelled')
    assert.doesNotMatch(t.frame(), /⊘ dropped/, 'and the queue was left alone')
    assert.match(t.frame(), /queued — queued turn/, 'still waiting its turn')
  } finally { t.done() }
})

test('a malformed question is refused, not rendered unanswerable', async () => {
  // The REPL fallback already returns "no options provided"; the TUI used to draw
  // an empty box instead. Worse than ugly: arrow keys made the cursor NaN and
  // enter resolved {ok:true, value:undefined}, which the model reads as a choice
  // the human made. A form with no fields threw on the first enter.
  const t = await boot()
  try {
    const select = requestInteraction({ type: 'select', text: 'pick one', options: [], timeoutMs: 60_000 })
    assert.deepEqual(await select, { ok: false, error: 'no options provided for select' })

    const form = requestInteraction({ type: 'form', text: 'fill this in', fields: [], timeoutMs: 60_000 })
    assert.deepEqual(await form, { ok: false, error: 'no fields provided for form' })

    // The refusal leaves no live box behind, and the transcript says WHY rather
    // than blaming the human with a bare "(cancelled)".
    await tick()
    assert.match(t.frame(), /pick one → \(no options provided for select\)/)
    assert.doesNotMatch(t.frame(), /❯ pick one → \(cancelled\)/)

    // A well-formed select still renders and answers.
    const good = requestInteraction({
      type: 'select', text: 'pick a colour', timeoutMs: 60_000,
      options: [{ value: 'red', label: 'red' }, { value: 'blue', label: 'blue' }],
    })
    await tick()
    assert.match(t.frame(), /pick a colour/)
    await t.key('\x1b[B')          // down to blue
    await t.key('\r')
    assert.deepEqual(await good, { ok: true, value: 'blue' })
  } finally { t.done() }
})

test('a question with no timeout waits for the human instead of self-cancelling', async () => {
  // setTimeout(fn, NaN) fires on the next tick, so an unset timeoutMs used to
  // resolve the question as "timed out after NaNs" before it could be answered.
  const t = await boot()
  try {
    const answer = requestInteraction({ type: 'confirm', text: 'still here?' })
    await tick()
    await tick()
    assert.match(t.frame(), /still here\?/, 'the question is still waiting')

    await t.key('y')
    assert.deepEqual(await answer, { ok: true, value: true })
  } finally { t.done() }
})

test('^C still reaches a running turn while a question is on screen', async () => {
  // The guard that fixes the Esc collision must sit BELOW ^C: being asked a
  // question cannot be a state where you are unable to stop a runaway turn.
  const t = await boot()
  try {
    await t.ask('runaway')
    const answer = requestInteraction({ type: 'confirm', text: 'proceed?', timeoutMs: 60_000 })
    await tick()

    await t.key('\x03')
    assert.equal(t.agent.cancelled, 1, 'the turn was cancelled despite the question')
    await t.key('\x1b')                       // tidy up the pending promise
    await answer
  } finally { t.done() }
})

test('with a cap set, the overflow queues and Esc drops it', async () => {
  const t = await boot({ TINY_MAX_CONCURRENT: '1' })
  try {
    await t.ask('running')
    await t.ask('waiting')
    assert.equal(t.agent.forks, 1, 'the cap held the second back')
    assert.match(t.frame(), /queued — waiting/, 'and showed it waiting')

    await t.key('\x1b')          // Esc on an empty composer drops the queue
    await tick()
    assert.match(t.frame(), /⊘ dropped 1 queued/)
    assert.doesNotMatch(t.frame(), /queued — waiting/, 'no waiting panel left')
    assert.equal(t.agent.forks, 1, 'dropping the queue started nothing')
  } finally { t.done() }
})

test('/clear forgets the conversation AND takes it off the screen', async () => {
  // Before this existed, `/clear` had no handler, so it went to the model as a
  // question — and the model answered "context cleared on my side", which was a
  // lie: every message was still in its history. Both halves are asserted here.
  const t = await boot()
  try {
    await t.ask('what is the mesh')
    await t.settle()
    assert.match(t.frame(), /answer to what is the mesh/)

    await t.ask('/clear')

    assert.equal(t.agent.cleared, 1, 'the model history was actually dropped')
    const f = t.frame()
    assert.match(f, /🧼 cleared/)
    assert.match(f, /forgot 6 messages/, 'says what it dropped, rather than claiming success')
    assert.doesNotMatch(f, /answer to what is the mesh/, 'the transcript is gone from the screen too')
    assert.match(f, /ask tiny anything/, 'the composer is still there — this is a reset, not an exit')
  } finally { t.done() }
})

test('/clear does not kill a turn in flight — it says the answer is still coming', async () => {
  // Silently cancelling running work would be the worst reading of "clear".
  // The fork already owns its own copy of the old history, so it finishes.
  const t = await boot()
  try {
    await t.ask('slow one')
    await t.ask('/clear')

    assert.equal(t.agent.cancelled, 0, 'nothing was cancelled')
    assert.match(t.frame(), /#1 still running with the OLD context/)

    await t.settle()
    assert.match(t.frame(), /answer to slow one/, 'the in-flight answer still lands')
  } finally { t.done() }
})

test('/clear on an empty session says so instead of inventing a number', async () => {
  const t = await boot({}, { historyLength: 0 })
  try {
    await t.ask('/clear')
    assert.equal(t.agent.cleared, 1)
    assert.match(t.frame(), /🧼 cleared — history was already empty/)
  } finally { t.done() }
})

test('/clear is offered by autocomplete and documented by /help', async () => {
  const t = await boot()
  try {
    await t.key('/cl')
    assert.match(t.frame(), /\/cl.?ear/, 'the ghost suggestion completes it (cursor cell may sit between typed text and ghost)')
    await t.key('\x1b')            // Esc — drop the input
    await t.ask('/help')
    assert.match(t.frame(), /\/clear\s+forget the conversation/)
  } finally { t.done() }
})

// ─── ⚡ the slash menu ───────────────────────────────────────────────────────

test('typing / opens the whole command list, not one dim guess', async () => {
  // What this replaces: `/` produced a single ghost completion (`/clear`) and no
  // way to discover anything else without already knowing its name.
  const t = await boot()
  try {
    await t.key('/')
    const f = t.frame()
    for (const name of ['/help', '/voice', '/loop', '/peers', '/clear']) {
      assert.ok(f.includes(name), `the menu is missing ${name}`)
    }
    assert.match(f, /↑↓ move .* Enter run .* Esc dismiss/, 'the menu says how to drive it')
    assert.match(f, /no model turn/, 'and which commands cost nothing')
  } finally { t.done() }
})

test('the menu filters as you keep typing, and the composer never loses focus', async () => {
  const t = await boot()
  try {
    await t.key('/')
    await t.key('v')
    const f = t.frame()
    assert.ok(f.includes('/voice'), '/voice survives the filter')
    assert.ok(!f.includes('/peers'), '/peers does not')
    assert.match(f, /> \/v/, 'the text went into the composer, which is still live')
  } finally { t.done() }
})

test('a command that matches nothing says so instead of vanishing', async () => {
  const t = await boot()
  try {
    await t.key('/')
    await t.key('z')
    assert.match(t.frame(), /no command matches/)
  } finally { t.done() }
})

test('↑↓ drive the menu while it is open, and the input history when it is not', async () => {
  const t = await boot()
  try {
    await t.ask('earlier question')
    await t.settle()

    // Menu closed: ↑ recalls what was asked before.
    await t.seq('\x1b[A')
    assert.match(t.frame(), /> earlier question/)
    await t.key('\x1b')

    // Menu open: ↓ moves the cursor instead, and the composer keeps its text.
    await t.key('/')
    const first = t.frame()
    await t.seq('\x1b[B')
    const second = t.frame()
    assert.notEqual(first, second, 'the cursor moved')
    assert.match(second, /> \//, 'and the input is still the slash the menu belongs to')
    assert.ok(!second.includes('earlier question') || !/> earlier question/.test(second),
      'the history recall did not fire')
  } finally { t.done() }
})

test('Enter runs the HIGHLIGHTED row, not the letters that filtered it', async () => {
  const t = await boot()
  try {
    // '/pe' highlights /peers; Enter must run /peers, not send '/pe' to a model.
    await t.key('/')
    await t.key('p')
    await t.key('e')
    await t.key('\r')
    await tick()
    assert.equal(t.agent.forks, 0, 'no model turn was spent')
    assert.match(t.frame(), /mesh is off|no peers discovered|peer/, 'the command answered')
  } finally { t.done() }
})

test('a command TYPED IN FULL runs even though it takes an argument', async () => {
  // The rule that makes bare /cancel, bare /loop and bare /say keep working:
  // completion is for a row you picked, never for text you already finished.
  const t = await boot()
  try {
    await t.ask('/cancel')
    assert.match(t.frame(), /⊘ nothing is running/)
    assert.equal(t.agent.forks, 0)
  } finally { t.done() }
})

test('Tab completes the highlighted row and leaves a space when it takes an argument', async () => {
  const t = await boot()
  try {
    await t.key('/')
    await t.key('s')      // /say <text>
    await t.key('\t')
    await tick()
    assert.match(t.frame(), /> \/say/)
    assert.equal(t.agent.forks, 0, 'Tab completes, it does not submit')
  } finally { t.done() }
})

test('an argument being typed closes the menu — a list over your sentence is noise', async () => {
  const t = await boot()
  try {
    await t.key('/')
    assert.ok(t.frame().includes('/peers'))
    await t.key('l')
    await t.key('o')
    await t.key('o')
    await t.key('p')
    await t.key(' ')
    const f = t.frame()
    assert.ok(!f.includes('Esc dismiss'), 'the menu closed as soon as an argument started')
    assert.match(f, /> \/loop/)
  } finally { t.done() }
})

// ─── Esc, layered ───────────────────────────────────────────────────────────

test('Esc clears a half-typed command, which also closes the menu', async () => {
  const t = await boot()
  try {
    await t.key('/')
    await t.key('l')
    assert.ok(t.frame().includes('Esc dismiss'))
    await t.key('\x1b')
    const f = t.frame()
    assert.ok(!f.includes('Esc dismiss'), 'menu gone')
    assert.match(f, /ask tiny anything/, 'and the composer is empty again')
  } finally { t.done() }
})

test('Esc at rest stops the running turns — but asks first', async () => {
  const t = await boot()
  try {
    await t.ask('slow one')
    await t.ask('another slow one')
    assert.equal(t.agent.cancelled, 0)

    // First Esc: nothing is destroyed, the intent is confirmed. Esc is also the
    // first byte of every arrow sequence, and an orphaned one over ssh must not
    // throw away minutes of work.
    await t.key('\x1b')
    assert.match(t.frame(), /Esc again to stop 2 running turns/)
    assert.equal(t.agent.cancelled, 0, 'still nothing cancelled')

    // Second Esc inside the window: both turns really stop.
    await t.key('\x1b')
    assert.equal(t.agent.cancelled, 2)
    assert.match(t.frame(), /⊘ cancelled/)
  } finally { t.done() }
})

test('typing after the first Esc disarms it — a confirmation must not outlive the moment', async () => {
  const t = await boot()
  try {
    await t.ask('slow one')
    await t.key('\x1b')
    assert.match(t.frame(), /Esc again to stop/)
    await t.key('h')                       // changed my mind, kept working
    assert.ok(!t.frame().includes('Esc again to stop'))
    await t.key('\x1b')                   // this Esc now just clears the 'h'
    assert.equal(t.agent.cancelled, 0, 'nothing was cancelled by a stale confirmation')
  } finally { t.done() }
})

test('^C keeps meaning "the newest" — Esc is the one that means "everything"', async () => {
  const t = await boot()
  try {
    await t.ask('a')
    await t.ask('b')
    await t.key('\x03')
    assert.equal(t.agent.cancelled, 1, '^C stopped exactly one')
  } finally { t.done() }
})

// ─── ♾️ the loop strip ──────────────────────────────────────────────────────

test('a running background loop is on screen without being asked about', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-strip-'))
  writeLoopRecord(dir, {
    id: 'l20260814040640001',
    prompt: 'CAD: the two-layer sandwich case',
    iterations: [{ n: 1, at: Date.now() - 90_000, summary: 'measured MOUNT_PITCH' }],
  })
  const t = await boot({ TINY_LOOPS_DIR: dir })
  try {
    await tick(120)   // the strip polls; give it one beat
    const f = t.frame()
    assert.ok(f.includes('l20260814040640001'), 'the loop id is visible')
    const { LOOP_MAX_ITERATIONS } = await import('../dist/agent/loop.js')
    assert.match(f, new RegExp(`iter 1/${LOOP_MAX_ITERATIONS}`))
    assert.ok(f.includes('CAD: the two-layer sandwich case'), 'and what it is working on')
    assert.ok(f.includes('measured MOUNT_PITCH'), 'and what it last did')
    assert.match(f, /\/loops for the journals/)
  } finally { t.done(); rmSync(dir, { recursive: true, force: true }) }
})

test('a finished loop leaves the strip — its news reaches the transcript instead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-strip-'))
  writeLoopRecord(dir, { id: 'l1', status: 'error', result: 'Model reached maximum token limit' })
  const t = await boot({ TINY_LOOPS_DIR: dir })
  try {
    await tick(120)
    assert.ok(!t.frame().includes('l1'), 'no strip row for a loop that already ended')
  } finally { t.done(); rmSync(dir, { recursive: true, force: true }) }
})
