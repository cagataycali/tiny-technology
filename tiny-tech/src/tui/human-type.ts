/**
 * ⌨️ The human keystroke engine — a seeded PLAN of keystrokes, not a player.
 *
 * Ported 1:1 from strands-fun-tools' human_typer.py, with one architectural
 * change: that tool interleaves random + sleep + stdout, which is fine for a
 * terminal and untestable in Ink. Here the personality lives in a pure
 * planner — humanPlan(text, opts) returns the full keystroke tape up front —
 * and the component just plays ops through timers. Same emotion presets,
 * same qwerty typo map, same punctuation/word-boundary rhythm, but every
 * decision comes from a seeded RNG, so the SAME seed replays the SAME
 * keystrokes on every terminal that reads the entry. Determinism is the
 * feature: the blackboard stores {seed, emotion} and every viewer sees the
 * same hesitations, the same typo, the same correction.
 *
 * Guarantees the tests hold us to:
 *   - replaying the ops (chars minus backspaces) always yields exactly `text`
 *   - every typo is followed by its backspace + the correct char
 *   - at most ONE word-rewrite event per plan
 *   - the whole tape fits in 15s (long text is scaled, not truncated)
 */

/** One keystroke of the tape. ms = how long to wait AFTER applying the op. */
export type TypeOp =
  | { op: 'char'; ch: string; ms: number }
  | { op: 'bs'; ms: number }
  | { op: 'wait'; ms: number }

export interface EmotionParams {
  /** Multiplies base typing speed. */
  speed: number
  /** Multiplies thinking-pause length at punctuation. */
  pause: number
  /** Per-keystroke timing variance, ± fraction of the base delay. */
  var: number
}

/** The five personalities, verbatim from human_typer.py's presets. */
export const EMOTIONS: Record<string, EmotionParams> = {
  excited: { speed: 1.3, pause: 0.7, var: 0.4 },
  thoughtful: { speed: 0.8, pause: 1.5, var: 0.2 },
  rushed: { speed: 1.5, pause: 0.5, var: 0.5 },
  calm: { speed: 1.0, pause: 1.0, var: 0.1 },
  nervous: { speed: 1.2, pause: 1.3, var: 0.6 },
}

/** Qwerty neighbours — the exact map from human_typer.py's simulate_typo. */
export const NEARBY_KEYS: Record<string, string> = {
  a: 'sq', b: 'vn', c: 'xv', d: 'sf', e: 'wr', f: 'dg', g: 'fh',
  h: 'gj', i: 'uo', j: 'hk', k: 'jl', l: 'k;', m: 'n,', n: 'bm',
  o: 'ip', p: 'o[', q: 'wa', r: 'et', s: 'ad', t: 'ry', u: 'yi',
  v: 'cb', w: 'qe', x: 'zc', y: 'tu', z: 'xs',
}

/** Base typing speed, chars/sec — human_typer.py's default. */
export const BASE_SPEED = 7

/** The typo is on screen this long before its author "notices" and corrects. */
export const TYPO_NOTICE_MS = 120

/** Nobody reads a marquee that types for half a minute. */
export const PLAN_CAP_MS = 15_000

/**
 * mulberry32 — the standard tiny seeded PRNG. 32-bit state, good enough
 * distribution for typing jitter, and identical output on every JS engine,
 * which is the entire point: the seed travels in the marquee entry.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * FNV-1a over the string — the fallback seed for v1 entries that predate the
 * seed field. Hashing the entry id (not the text) keeps two entries with the
 * same text from animating identically, which reads as a glitch.
 */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface PlanOptions {
  /** One of EMOTIONS; unknown names fall back to calm, like the python. */
  emotion?: string
  /** Probability of a typo per character (0–1). */
  typoRate?: number
  /** RNG seed — same seed, same tape. Defaults to 1 (still deterministic). */
  seed?: number
  /** Chars/sec before the emotion multiplier. */
  baseSpeed?: number
  /** Probability of the single word-rewrite event (default 0.15). */
  rewriteChance?: number
}

/** A wrong-but-plausible word: a shorter prefix, or two letters swapped. */
function wrongWordFor(word: string, rand: () => number): string {
  if (word.length >= 4 && rand() < 0.5) {
    // A prefix that stops short — typed the stem, meant the whole word.
    const cut = 2 + Math.floor(rand() * (word.length - 3))
    return word.slice(0, cut)
  }
  // Scramble: swap two interior-ish letters.
  const chars = word.split('')
  const i = Math.floor(rand() * (chars.length - 1))
  const t = chars[i]; chars[i] = chars[i + 1]; chars[i + 1] = t
  const scrambled = chars.join('')
  // A swap that lands on the same word (e.g. "aa") isn't a rewrite — cut instead.
  return scrambled === word ? word.slice(0, Math.max(1, word.length - 1)) : scrambled
}

/**
 * Plan the whole typing performance for `text`. Pure: same inputs, same tape.
 *
 * The rhythm, from human_typer.py:
 *   - per-keystroke delay = 1000/(baseSpeed·speed) jittered ±var, floor 10ms
 *   - a thinking pause of 0.5–1.5s (×pause) after . ! ?
 *   - a 2× beat after a space — fingers reset at word boundaries
 *   - typoRate chance per char of a qwerty-neighbour slip, shown for
 *     TYPO_NOTICE_MS, then backspaced and retyped
 * Plus one planner-only move the python couldn't do: at most one word-rewrite
 * per plan (~15%) — a plausible wrong word, a 400–800ms stare, backspaces,
 * the right word.
 */
export function humanPlan(text: string, opts: PlanOptions = {}): TypeOp[] {
  const params = EMOTIONS[opts.emotion || 'calm'] || EMOTIONS.calm
  const typoRate = opts.typoRate ?? 0.02
  const rand = mulberry32(opts.seed ?? 1)
  const baseDelay = 1000 / ((opts.baseSpeed ?? BASE_SPEED) * params.speed)

  const uniform = (lo: number, hi: number) => lo + rand() * (hi - lo)
  const charDelay = () => Math.max(10, baseDelay * (1 + uniform(-params.var, params.var)))

  // Decide the single word-rewrite up front so there's at most one, ever.
  // Candidates are alphabetic words of 3+ chars — short words rewrite as noise.
  const words: Array<{ start: number; word: string }> = []
  const re = /[A-Za-z]{3,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) words.push({ start: m.index, word: m[0] })
  let rewriteAt = -1
  let rewriteWord = ''
  if (words.length && rand() < (opts.rewriteChance ?? 0.15)) {
    const pick = words[Math.floor(rand() * words.length)]
    const wrong = wrongWordFor(pick.word, rand)
    if (wrong !== pick.word) {
      rewriteAt = pick.start
      rewriteWord = wrong
    }
  }

  const plan: TypeOp[] = []
  for (let i = 0; i < text.length; i++) {
    const delay = charDelay()

    // Thinking pause after sentence-enders — reading what was just said.
    if (i > 0 && '.!?'.includes(text[i - 1])) {
      plan.push({ op: 'wait', ms: uniform(500, 1500) * params.pause })
    }
    // Word boundary: fingers travel, 2× the beat of the char that follows.
    if (i > 0 && text[i - 1] === ' ') {
      plan.push({ op: 'wait', ms: delay * 2 })
    }

    // The one word-rewrite: type the wrong word, stare, erase, move on to
    // typing the right one through the normal per-char path below.
    if (i === rewriteAt) {
      for (const ch of rewriteWord) plan.push({ op: 'char', ch, ms: charDelay() })
      plan.push({ op: 'wait', ms: uniform(400, 800) })
      for (let k = 0; k < rewriteWord.length; k++) plan.push({ op: 'bs', ms: Math.max(10, baseDelay * 0.6) })
    }

    // Qwerty slip: wrong neighbour shown, noticed, backspaced, corrected.
    if (rand() < typoRate) {
      const lower = text[i].toLowerCase()
      const nearby = NEARBY_KEYS[lower]
      const typo = nearby ? nearby[Math.floor(rand() * nearby.length)] : text[i]
      plan.push({ op: 'char', ch: typo, ms: delay })
      plan.push({ op: 'wait', ms: TYPO_NOTICE_MS })
      plan.push({ op: 'bs', ms: delay * 1.5 })
    }

    plan.push({ op: 'char', ch: text[i], ms: delay })
  }

  // Long-text guard: scale, don't truncate — the performance compresses but
  // every keystroke still happens and the replay invariant survives untouched.
  const total = totalMs(plan)
  if (total > PLAN_CAP_MS) {
    const scale = PLAN_CAP_MS / total
    for (const op of plan) op.ms = Math.max(1, op.ms * scale)
  }
  return plan
}

/** How long the whole tape takes to play. */
export function totalMs(plan: TypeOp[]): number {
  let t = 0
  for (const op of plan) t += op.ms
  return t
}

/** Apply the tape: what the screen shows after the last op. */
export function replayPlan(plan: TypeOp[]): string {
  let out = ''
  for (const op of plan) {
    if (op.op === 'char') out += op.ch
    else if (op.op === 'bs') out = out.slice(0, -1)
  }
  return out
}
