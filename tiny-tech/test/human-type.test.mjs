/**
 * ⌨️ The human keystroke engine — pure-plan tests, no Ink, no real timers.
 *
 * The planner returns the whole tape up front, so every behaviour is
 * inspectable as data: determinism (the seed IS the performance), the replay
 * invariant (chars minus backspaces === the text, always — fuzzed), the typo
 * grammar (slip → notice beat → backspace → correction), the emotion
 * personalities (nervous jitters measurably more than calm), the punctuation
 * and word-boundary rhythm ported from human_typer.py, and the 15s cap that
 * compresses long performances instead of truncating them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  humanPlan, replayPlan, totalMs, mulberry32, hashSeed,
  EMOTIONS, NEARBY_KEYS, TYPO_NOTICE_MS, PLAN_CAP_MS,
} = await import('../dist/tui/human-type.js')

test('determinism: same seed → identical plan, different seed → different plan', () => {
  const a = humanPlan('the quick brown fox jumps', { seed: 42 })
  const b = humanPlan('the quick brown fox jumps', { seed: 42 })
  assert.deepEqual(a, b)
  const c = humanPlan('the quick brown fox jumps', { seed: 43 })
  assert.notDeepEqual(a, c) // at minimum the jitter differs
})

test('replay invariant: fuzz 50 random strings × seeds — the tape always types the text', () => {
  const rand = mulberry32(0xf00d)
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .!?,;:0123456789'
  for (let i = 0; i < 50; i++) {
    const len = 1 + Math.floor(rand() * 80)
    let text = ''
    for (let k = 0; k < len; k++) text += alphabet[Math.floor(rand() * alphabet.length)]
    const seed = Math.floor(rand() * 0xffffffff)
    // Crank typos AND force the rewrite — the invariant must survive both.
    const plan = humanPlan(text, { seed, typoRate: 0.3, rewriteChance: 1 })
    assert.equal(replayPlan(plan), text, `seed=${seed} text=${JSON.stringify(text)}`)
  }
})

test('typo grammar: slip → ~120ms notice beat → backspace → the correct char', () => {
  // typoRate 1 makes EVERY char a slip; rewrite off keeps the tape pure typo.
  const text = 'abc'
  const plan = humanPlan(text, { seed: 7, typoRate: 1, rewriteChance: 0 })
  // Expect, per char: char(slip), wait(TYPO_NOTICE_MS), bs, char(correct)
  const ops = plan.filter((o) => o.op !== 'wait' || o.ms === TYPO_NOTICE_MS)
  let i = 0
  for (const ch of text) {
    assert.equal(ops[i].op, 'char') // the slip
    assert.ok(NEARBY_KEYS[ch].includes(ops[i].ch), `slip for '${ch}' is a qwerty neighbour`)
    assert.equal(ops[i + 1].op, 'wait')
    assert.equal(ops[i + 1].ms, TYPO_NOTICE_MS) // the notice beat, before the bs
    assert.equal(ops[i + 2].op, 'bs')
    assert.equal(ops[i + 3].op, 'char')
    assert.equal(ops[i + 3].ch, ch) // the correction
    i += 4
  }
  assert.equal(replayPlan(plan), text)
})

test('every typo is corrected before the next word starts', () => {
  // Invariant form: at every step the buffer is a prefix of the text, or a
  // prefix plus exactly ONE wrong char whose very next keystroke is the bs.
  const text = 'some words to type here'
  const plan = humanPlan(text, { seed: 99, typoRate: 0.5, rewriteChance: 0 })
  let buf = ''
  for (let i = 0; i < plan.length; i++) {
    const op = plan[i]
    if (op.op === 'char') buf += op.ch
    else if (op.op === 'bs') buf = buf.slice(0, -1)
    if (!text.startsWith(buf)) {
      assert.ok(text.startsWith(buf.slice(0, -1)), 'at most one pending wrong char')
      // the next non-wait op must erase it — never carried into the next word
      let j = i + 1
      while (plan[j] && plan[j].op === 'wait') j++
      assert.equal(plan[j].op, 'bs')
    }
  }
  assert.equal(buf, text)
})

test('at most ONE word-rewrite per plan, and it replays clean', () => {
  const text = 'the marquee performs like a person'
  const plan = humanPlan(text, { seed: 5, typoRate: 0, rewriteChance: 1 })
  // With typos off, every bs on the tape belongs to the rewrite.
  const bsCount = plan.filter((o) => o.op === 'bs').length
  assert.ok(bsCount >= 1, 'rewrite forced → some backspaces')
  // The 400–800ms stare exists exactly once.
  const stares = plan.filter((o) => o.op === 'wait' && o.ms >= 400 && o.ms <= 800)
  assert.equal(stares.length, 1)
  // Backspaces form ONE contiguous run — one rewrite, not several.
  const kinds = plan.map((o) => o.op).join(',')
  assert.ok(!/bs,(?:[^b]|b(?!s))*bs/.test(kinds.replace(/bs(,bs)*/g, 'bs')), 'single bs run')
  assert.equal(replayPlan(plan), text)
})

test('rewriteChance 0 with typoRate 0 → straight-line typing, no bs at all', () => {
  const plan = humanPlan('hello there world', { seed: 1, typoRate: 0, rewriteChance: 0 })
  assert.equal(plan.filter((o) => o.op === 'bs').length, 0)
  assert.equal(replayPlan(plan), 'hello there world')
})

test('punctuation pause: a thinking beat follows . ! ?', () => {
  const plan = humanPlan('End. next', { seed: 3, typoRate: 0, rewriteChance: 0 })
  // Find the char op for '.'; a wait of >= 500×pause (calm: 500ms) must come
  // before the next char lands.
  const dotIdx = plan.findIndex((o) => o.op === 'char' && o.ch === '.')
  assert.ok(dotIdx >= 0)
  const after = plan.slice(dotIdx + 1)
  const nextChar = after.findIndex((o) => o.op === 'char')
  const waits = after.slice(0, nextChar).filter((o) => o.op === 'wait')
  assert.ok(waits.some((w) => w.ms >= 500 * EMOTIONS.calm.pause), 'thinking pause present')
})

test('word boundary: the beat after a space is exactly 2× the next keystroke', () => {
  const plan = humanPlan('ab cd', { seed: 11, typoRate: 0, rewriteChance: 0 })
  const spaceIdx = plan.findIndex((o) => o.op === 'char' && o.ch === ' ')
  const wait = plan[spaceIdx + 1]
  const next = plan[spaceIdx + 2]
  assert.equal(wait.op, 'wait')
  assert.equal(next.op, 'char')
  assert.equal(next.ch, 'c')
  assert.ok(Math.abs(wait.ms - next.ms * 2) < 1e-9, '2× the delay of the keystroke it precedes')
})

test('nervous jitters more than calm — statistically, same seed, same text', () => {
  const text = 'a long enough line of steady typing to measure the jitter of the hands '.repeat(3)
  const cv = (emotion) => {
    const ms = humanPlan(text, { seed: 1234, emotion, typoRate: 0, rewriteChance: 0 })
      .filter((o) => o.op === 'char').map((o) => o.ms)
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length
    const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / ms.length)
    return sd / mean // coefficient of variation — speed multipliers cancel out
  }
  assert.ok(cv('nervous') > cv('calm') * 2, `nervous=${cv('nervous')} calm=${cv('calm')}`)
})

test('emotion presets match human_typer.py verbatim', () => {
  assert.deepEqual(EMOTIONS.excited, { speed: 1.3, pause: 0.7, var: 0.4 })
  assert.deepEqual(EMOTIONS.thoughtful, { speed: 0.8, pause: 1.5, var: 0.2 })
  assert.deepEqual(EMOTIONS.rushed, { speed: 1.5, pause: 0.5, var: 0.5 })
  assert.deepEqual(EMOTIONS.calm, { speed: 1.0, pause: 1.0, var: 0.1 })
  assert.deepEqual(EMOTIONS.nervous, { speed: 1.2, pause: 1.3, var: 0.6 })
})

test('unknown emotion falls back to calm, like the python', () => {
  const a = humanPlan('same text', { seed: 8, emotion: 'no-such-mood', typoRate: 0, rewriteChance: 0 })
  const b = humanPlan('same text', { seed: 8, emotion: 'calm', typoRate: 0, rewriteChance: 0 })
  assert.deepEqual(a, b)
})

test('15s cap: a long text compresses to fit, replay untouched', () => {
  const text = 'word '.repeat(400).trim() // ~2000 chars ≈ 5 minutes at 7cps
  const plan = humanPlan(text, { seed: 21, emotion: 'thoughtful' })
  assert.ok(totalMs(plan) <= PLAN_CAP_MS + 1, `total=${totalMs(plan)}`)
  assert.equal(replayPlan(plan), text)
})

test('short text is NOT scaled — it just plays at human speed', () => {
  const plan = humanPlan('hi there', { seed: 2, typoRate: 0, rewriteChance: 0 })
  const total = totalMs(plan)
  assert.ok(total < PLAN_CAP_MS)
  assert.ok(total > 500, 'still human-paced, not instant')
})

test('hashSeed: deterministic uint32 — the v1 fallback for entries without a seed', () => {
  assert.equal(hashSeed('mqabc123'), hashSeed('mqabc123'))
  assert.notEqual(hashSeed('mqabc123'), hashSeed('mqabc124'))
  const h = hashSeed('anything at all')
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff)
  // and it plans — backwards compat is one function call
  const plan = humanPlan('legacy entry', { seed: hashSeed('mq-old-id') })
  assert.equal(replayPlan(plan), 'legacy entry')
})

test('mulberry32: same seed same stream, output in [0,1)', () => {
  const a = mulberry32(77); const b = mulberry32(77)
  for (let i = 0; i < 100; i++) {
    const x = a()
    assert.equal(x, b())
    assert.ok(x >= 0 && x < 1)
  }
})
