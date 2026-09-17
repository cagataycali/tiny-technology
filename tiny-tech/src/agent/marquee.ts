/**
 * 💬 The marquee blackboard — one shared ticker file every local agent writes.
 *
 * ~/.tiny/marquee.jsonl is append-only JSONL: {id, ts, author, text,
 * supersedes?}. Append-only because several processes share it (the TUI, its
 * loops, mesh peers on this machine) and an appendFileSync of a single line
 * under PIPE_BUF is the one multi-writer primitive that needs no lock — the
 * same reasoning as ~/.tiny/loops, where disk is the only truth and a 2s poll
 * beats an event bus nobody else can join.
 *
 * Supersedes lets an author revise its own last word without growing the
 * visible history — but ONLY its own: an entry that names another author's id
 * is dropped at read time and the original stays. Peers append next to each
 * other; they do not rewrite each other.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { tool } from '@strands-agents/sdk'
import { parseMarkup } from '../tui/marquee-markup.js'

export interface MarqueeEntry {
  id: string
  /** Epoch ms when it was said. */
  ts: number
  /** Who said it — mesh peer label or this host's short name. */
  author: string
  text: string
  /** An earlier entry id this one replaces — same author only. */
  supersedes?: string
  /** RNG seed for the keystroke performance — every terminal replays the same tape. */
  seed?: number
  /** Typing personality (see EMOTIONS in tui/human-type.ts). Default calm. */
  emotion?: string
}

/** Where the blackboard lives. Env override so tests never touch the real one. */
export function marqueeFile(): string {
  return process.env.TINY_MARQUEE_FILE || join(homedir(), '.tiny', 'marquee.jsonl')
}

/** This process's byline: mesh label when one was assigned, hostname otherwise. */
export function marqueeAuthor(): string {
  return process.env.TINY_MARQUEE_AUTHOR || hostname().split('.')[0]
}

/**
 * Append one entry. A single serialised line + '\n' in one appendFileSync
 * call — under PIPE_BUF that write is atomic across the processes sharing
 * the file, so interleaved writers can never shear each other's lines.
 */
export function appendMarquee(
  input: { text: string; supersedes?: string; author?: string; emotion?: string; seed?: number },
  file: string = marqueeFile(),
): MarqueeEntry {
  const text = String(input.text || '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('marquee entry needs text')
  const entry: MarqueeEntry = {
    id: `mq${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    ts: Date.now(),
    author: input.author || marqueeAuthor(),
    text,
    ...(input.supersedes ? { supersedes: String(input.supersedes) } : {}),
    // The seed is minted HERE, not at render: every terminal that reads this
    // entry replays the exact same keystroke tape — hesitations, typo, fix.
    seed: Number.isFinite(input.seed) ? (input.seed! >>> 0) : randomBytes(4).readUInt32LE(0),
    ...(input.emotion ? { emotion: String(input.emotion) } : {}),
  }
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

/**
 * Read + resolve the blackboard. Malformed lines are skipped (a writer dying
 * mid-line is a normal race, not a corruption event), then supersedes are
 * applied: a valid one (target exists, SAME author) removes the target; an
 * invalid one — unknown target, or another author's words — drops the
 * superseding entry itself and keeps the original. Rewriting a peer is the
 * one move the format refuses.
 */
export function readMarquee(file: string = marqueeFile()): MarqueeEntry[] {
  if (!existsSync(file)) return []
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const parsed: MarqueeEntry[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t)
      if (e && typeof e.id === 'string' && typeof e.text === 'string'
        && typeof e.author === 'string' && Number.isFinite(e.ts)) parsed.push(e)
    } catch { /* torn or foreign line — skip */ }
  }
  const byId = new Map(parsed.map((e) => [e.id, e]))
  const replaced = new Set<string>()
  const dropped = new Set<string>()
  for (const e of parsed) {
    if (!e.supersedes) continue
    const target = byId.get(e.supersedes)
    if (target && target.author === e.author) replaced.add(target.id)
    else dropped.add(e.id) // invalid supersede: keep the original, drop this
  }
  return parsed.filter((e) => !replaced.has(e.id) && !dropped.has(e.id))
}

const MARQUEE_DESCRIPTION =
  'Write one line to the shared marquee ticker — the blackboard row every local agent and mesh peer sees in the TUI. supersedes replaces YOUR earlier entry by id. ' +
  'Inline color markup: {cyan}word{/} with styles cyan green yellow magenta red blue gray bold dim ({{ }} escape literal braces); plain entries auto-highlight ids, ✓/pass, ✗/fail and numbers instead.'

/** The agent-side voice: marquee_say appends as this process's author. */
export function makeMarqueeSayTool(opts: { author?: string } = {}) {
  return tool({
    name: 'marquee_say',
    description: MARQUEE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'one line for the ticker' },
        supersedes: { type: 'string', description: 'id of YOUR earlier entry this replaces' },
        emotion: {
          type: 'string',
          enum: ['excited', 'thoughtful', 'rushed', 'calm', 'nervous'],
          description: 'typing personality for the keystroke performance (default calm)',
        },
      },
      required: ['text'],
    },
    callback: async (input: any) => {
      const text = String(input?.text || '').trim()
      if (!text) return 'need text'
      try {
        const e = appendMarquee({
          text,
          supersedes: input?.supersedes ? String(input.supersedes) : undefined,
          author: opts.author,
          emotion: input?.emotion ? String(input.emotion) : undefined,
        })
        return `💬 on the marquee as ${e.author} — id ${e.id}`
      } catch (err: any) {
        return `could not write marquee: ${String(err?.message || err)}`
      }
    },
  })
}

// ── v5: context injection — the blackboard as turn news ────────────────────

/** At most this many entries per turn; the newest win, older get a count. */
export const MARQUEE_NEWS_CAP = 5

/** Each injected line is clipped to about this many characters. */
export const MARQUEE_NEWS_CHARS = 120

/**
 * The per-process seen cursor. A ts high-water mark plus the ids AT that
 * mark — two entries can share a millisecond (atomic appends from two
 * processes), so the ids disambiguate the boundary without keeping the whole
 * history in memory.
 */
export interface MarqueeSeen {
  ts: number
  ids: string[]
}

/**
 * Pure: which entries are news, and what the injected block says. Entries
 * must already be resolved (readMarquee output). Markup is stripped — the
 * model reads plain words, colors are a render-time concern — and each line
 * is clipped to ~chars. More than `cap` unseen: the NEWEST cap entries are
 * shown oldest→newest (so the story reads forward) with a '(+N earlier)'
 * note, because when the room talked a lot, the recent lines are the ones
 * that still matter.
 */
export function marqueeNewsBlock(
  entries: MarqueeEntry[],
  seen: MarqueeSeen,
  opts: { cap?: number; chars?: number } = {},
): { block: string; seen: MarqueeSeen } {
  const cap = opts.cap ?? MARQUEE_NEWS_CAP
  const chars = opts.chars ?? MARQUEE_NEWS_CHARS
  const unseen = entries
    .filter((e) => e.ts > seen.ts || (e.ts === seen.ts && !seen.ids.includes(e.id)))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  if (!unseen.length) return { block: '', seen }
  // Advance the cursor over EVERYTHING unseen — including entries the cap
  // hides. News repeats never; a hidden line is spent, not deferred.
  const maxTs = unseen[unseen.length - 1].ts
  const next: MarqueeSeen = {
    ts: maxTs,
    ids: entries.filter((e) => e.ts === maxTs).map((e) => e.id),
  }
  const shown = unseen.slice(-cap)
  const hidden = unseen.length - shown.length
  const lines = shown.map((e) => {
    const plain = parseMarkup(e.text).plain.replace(/\s+/g, ' ').trim()
    const clipped = plain.length > chars ? plain.slice(0, chars - 1) + '…' : plain
    return `- ${e.author}: ${clipped}`
  })
  const head = `[Marquee — the room's blackboard since your last turn${hidden ? ` (+${hidden} earlier)` : ''}]`
  return { block: `${head}\n${lines.join('\n')}\n\n`, seen: next }
}

/**
 * The stateful rail dynamicContext() calls once per turn. The cursor is
 * primed AT CREATION — a fresh session must not have last week's blackboard
 * dumped into its first turn; only what lands while this process lives is
 * news. Reading the file is cheap and already tolerates torn lines; any
 * error is swallowed because news must never take a turn down.
 */
export function makeMarqueeNews(now: number = Date.now()) {
  // Prime the boundary ids too: an entry written in this very millisecond is
  // history, not news — without this, a same-ms append would slip through.
  let seen: MarqueeSeen = { ts: now, ids: [] }
  try {
    seen.ids = readMarquee().filter((e) => e.ts === now).map((e) => e.id)
  } catch { /* an unreadable file just means an empty boundary */ }
  return {
    take(): string {
      try {
        const r = marqueeNewsBlock(readMarquee(), seen)
        seen = r.seen
        return r.block
      } catch {
        return ''
      }
    },
  }
}
