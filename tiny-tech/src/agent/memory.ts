/**
 * use_memory — memory that works with no account, no server, no database.
 *
 * tiny-tech already has memory: tiny_learn / tiny_recall write to
 * tiny.technology's cross-device memory graph, with semantic search and linked
 * facts. It is better than this file in every way — except that it needs an
 * account and a network. Log out, board a plane, or run the daemon on a box
 * that never signed in, and tiny-tech remembers NOTHING. devduck's
 * sqlite_memory, for all its faults, always worked. This closes that gap: a
 * local store the user owns, in a file they can read, that is always there.
 *
 *   save     write a fact down (title, tags, metadata, supersedes)
 *   recall   find it again by intent, bounded, with the matching lines shown
 *   list     newest first, or everything under a tag
 *   get      one memory in full
 *   forget   delete one, by id
 *   tags     what the store is actually about
 *   stats    counts, derived from the store itself
 *
 * ── the five ways devduck's memory let you down ────────────────────────────
 * Ported by reading sqlite_memory.py and fixing what it does, not copying it:
 *
 *   1. A search could be a SYNTAX ERROR. Its query went to FTS5 `MATCH`
 *      verbatim, so `recall "what's the deploy?"` came back
 *      `Error: fts5: syntax error near "'"` — the apostrophe, the `?`, a bare
 *      `-`, the word `OR`. A memory you cannot phrase is a memory you have
 *      lost. Here the query is tokenised by us and can never be a syntax
 *      error, because there is no query language.
 *   2. It could dump 2.5 MB into the context window: 50 results × a 50 000
 *      char preview each. Recall here is bounded twice over — a per-hit
 *      snippet around the match and a total ceiling — and says how many
 *      matches it did not show.
 *   3. Saving the same text twice REFUSED, and threw away the new tags and
 *      metadata with it ("⚠️ Duplicate exists"). Learning the same thing
 *      again, with better labels, is not an error: it merges.
 *   4. `stats` lied. Tag counts were kept in a second table that `update`
 *      never touched, so they drifted from the truth silently. Every count
 *      here is derived from the records on each call — it cannot drift.
 *   5. It shipped `action="sql"` with arbitrary SQL, which is `DROP TABLE
 *      memories` from a prompt injection away, and interpolated `order_by`
 *      straight into the statement. There is no such route here. Nothing a
 *      model can say deletes more than one memory per call.
 *
 * ── why a JSONL log and not SQLite ─────────────────────────────────────────
 * node:sqlite exists in Node 22 but needs --experimental-sqlite and does not
 * exist at all on the Node 18 this package still supports, and a native dep is
 * the one thing this codebase refuses (see yaml.ts). So: one append-only JSONL
 * file. A save is one line appended under O_APPEND, which is the one write
 * concurrent tiny processes (daemon, tray, loop, mesh) can do to the same file
 * without a lock and without losing each other's work — the failure mode
 * registry.ts had to fix the hard way. A forget appends a tombstone rather
 * than rewriting, so a crash mid-write costs the last line and nothing else,
 * and a line that somehow IS corrupt is skipped rather than taking the store
 * down with it.
 *
 * Errors return as text, never throw — the model adapts (device-tools rule).
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** One memory's ceiling. Longer than this is a file, not a memory. */
export const MEMORY_TEXT_MAX = 20_000
/** What recall may spend of the context window, all hits together. */
export const RECALL_OUTPUT_MAX = 8_000
/** Characters of a memory shown around the terms that matched. */
export const SNIPPET_WIDTH = 320
/** Hits per recall unless asked otherwise. */
export const RECALL_LIMIT = 5
/** Rewrite the log once tombstones and rewrites outnumber live records. */
export const COMPACT_RATIO = 2

export function hasMemory(): boolean {
  return process.env.TINY_MEMORY !== '0'
}

/** Where memories live. TINY_MEMORY_DIR scopes them to a project. */
export function memoryDir(): string {
  if (process.env.TINY_MEMORY_DIR) return process.env.TINY_MEMORY_DIR
  return join(process.env.TINY_HOME || join(homedir(), '.tiny'), 'memory')
}

export function memoryFile(): string {
  return join(memoryDir(), 'memories.jsonl')
}

export interface Memory {
  id: string
  title: string
  text: string
  tags: string[]
  meta?: Record<string, unknown>
  created: string
  updated: string
  /** Set when this memory replaced another — the breadcrumb tiny_learn keeps. */
  supersedes?: string
}

interface Record_ { op: 'save' | 'forget'; at: string; memory?: Memory; id?: string }

// ── the log ─────────────────────────────────────────────────────────────────

/**
 * Every live memory, oldest first.
 *
 * Replaying the log is how a save-then-forget-then-save-again ends up with one
 * memory: later records win. A line that will not parse is skipped — half a
 * line written by a process that died is not a reason to lose the other 400.
 */
export function allMemories(): Memory[] {
  let raw: string
  try { raw = fs.readFileSync(memoryFile(), 'utf-8') } catch { return [] }
  const live = new Map<string, Memory>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let r: Record_
    try { r = JSON.parse(line) } catch { continue }
    if (r.op === 'forget' && r.id) live.delete(r.id)
    else if (r.op === 'save' && r.memory?.id) live.set(r.memory.id, r.memory)
  }
  return [...live.values()]
}

function append(r: Record_): void {
  fs.mkdirSync(memoryDir(), { recursive: true, mode: 0o700 })
  // A single appendFileSync is a single write(2) under O_APPEND: two tiny
  // processes appending at once interleave whole lines, never halves.
  fs.appendFileSync(memoryFile(), JSON.stringify(r) + '\n', { mode: 0o600 })
}

/** How many log lines back the live set — the reason to compact. */
export function logLines(): number {
  try { return fs.readFileSync(memoryFile(), 'utf-8').split('\n').filter((l) => l.trim()).length } catch { return 0 }
}

/**
 * Rewrite the log as one line per live memory.
 *
 * Via a temp file and rename so a crash leaves either the old log or the new
 * one, never a truncated file. Skipped silently if anything goes wrong: a
 * failed compaction is a bigger log, not lost memories.
 */
export function compact(): boolean {
  const live = allMemories()
  const file = memoryFile()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, live.map((m) => JSON.stringify({ op: 'save', at: m.updated, memory: m }) + '\n').join(''), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    return false
  }
}

function maybeCompact(liveCount: number): void {
  if (liveCount > 0 && logLines() > liveCount * COMPACT_RATIO) compact()
}

// ── ids and text ────────────────────────────────────────────────────────────

let idCounter = 0

/** Sortable, unique, and readable in the file: mem_<time36>_<n>. */
export function newId(): string {
  return `mem_${Date.now().toString(36)}${(idCounter++).toString(36)}`
}

/** A title the user would recognise in a list — a sentence, not 500 chars. */
export function autoTitle(text: string): string {
  const first = text.trim().split(/\n/).find((l) => l.trim()) || ''
  const sentence = /^(.{10,80}?[.!?])(\s|$)/.exec(first)
  const t = (sentence ? sentence[1] : first).trim()
  return t.length > 80 ? t.slice(0, 77).trimEnd() + '…' : t
}

/**
 * Words, for matching.
 *
 * Unicode-aware because a memory about `çay` must be findable by `çay`, and
 * deliberately dumb: no query language, so no query can be invalid.
 */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) || []).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean)
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'that', 'this', 'what',
  'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'and', 'or', 'but', 'if',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'as', 'by', 'from', 'into',
  's', 't', 'll', 've', 're',
])

/** Content words, or the raw words if the question was ALL stopwords. */
export function queryTerms(q: string): string[] {
  const words = [...new Set(tokenize(q))]
  const content = words.filter((w) => !STOPWORDS.has(w))
  return content.length ? content : words
}

// ── ranking ─────────────────────────────────────────────────────────────────

export interface Hit { memory: Memory; score: number; terms: string[] }

/**
 * Rank memories against a question.
 *
 * Not BM25 and not embeddings: term rarity (a word in one memory out of 200 is
 * worth more than a word in all of them), the field it matched (a tag or title
 * hit means the memory is ABOUT that, a body hit means it mentions it), a
 * bonus if the question appears as a phrase, a prefix match so `deploy` finds
 * `deployment`, and recency only as a tiebreak. Enough to put the right note
 * first out of a few thousand, with no service to call.
 */
export function rankMemories(memories: Memory[], query: string, tags?: string[], since?: number): Hit[] {
  const terms = queryTerms(query)
  const phrase = query.trim().toLowerCase()
  const pool = memories.filter((m) => {
    if (tags?.length && !tags.every((t) => m.tags.map((x) => x.toLowerCase()).includes(t.toLowerCase()))) return false
    if (since && Date.parse(m.updated || m.created) < since) return false
    return true
  })
  // Term rarity, over the pool we are actually choosing between.
  const df = new Map<string, number>()
  const words = pool.map((m) => new Set(tokenize(`${m.title} ${m.text} ${m.tags.join(' ')}`)))
  words.forEach((set) => { for (const w of set) df.set(w, (df.get(w) || 0) + 1) })
  const idf = (w: string) => Math.log(1 + pool.length / (1 + (df.get(w) || 0)))

  const hits: Hit[] = []
  pool.forEach((m, i) => {
    const title = m.title.toLowerCase()
    const text = m.text.toLowerCase()
    const tagText = m.tags.join(' ').toLowerCase()
    const set = words[i]
    let score = 0
    const matched: string[] = []
    for (const w of terms) {
      const weight = idf(w) + 0.5
      let s = 0
      if (set.has(w)) s = 6
      else if ([...set].some((x) => x.startsWith(w) || w.startsWith(x))) s = 2      // deploy ↔ deployment
      if (!s) continue
      matched.push(w)
      if (tagText.includes(w)) s += 6                                              // a tag says what it IS about
      if (title.includes(w)) s += 4
      score += s * weight
    }
    if (!matched.length) {
      // A tag-only or since-only recall is a legitimate ask: everything in the
      // filtered pool is a hit, newest first.
      if (!terms.length) hits.push({ memory: m, score: 1, terms: [] })
      return
    }
    if (phrase.length > 3 && (text.includes(phrase) || title.includes(phrase))) score += 12
    if (matched.length === terms.length && terms.length > 1) score += 6             // every word found
    hits.push({ memory: m, score, terms: matched })
  })
  // Recency breaks a score tie — and the id breaks a recency tie, because an
  // ISO timestamp has millisecond resolution and a batch of saves inside one
  // millisecond would otherwise come back in whatever order the log happens to
  // hold them, i.e. oldest first, which is the opposite of what `list` promises.
  return hits.sort((a, b) =>
    b.score - a.score ||
    Date.parse(b.memory.updated || b.memory.created) - Date.parse(a.memory.updated || a.memory.created) ||
    (b.memory.id < a.memory.id ? -1 : b.memory.id > a.memory.id ? 1 : 0))
}

/** The window of a memory where the match actually is, not its first 320 chars. */
export function snippet(text: string, terms: string[], width = SNIPPET_WIDTH): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  const low = flat.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = low.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return flat.slice(0, width).trimEnd() + '…'
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(flat.length, start + width)
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '')
}

/** `2026-08-13` — the day is what a person remembers, not the millisecond. */
const day = (iso: string) => (iso || '').slice(0, 10)

export function formatHit(h: Hit): string {
  const m = h.memory
  const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : ''
  return `• ${m.title}${tags}  (${m.id}, ${day(m.updated || m.created)})\n  ${snippet(m.text, h.terms)}`
}

// ── saving ──────────────────────────────────────────────────────────────────

export interface SaveResult { memory: Memory; merged: boolean; replaced?: string }

/**
 * Write a memory down, or merge it into the one that already says this.
 *
 * The same text arriving twice is not an error (devduck refused it): the tags
 * and metadata of the second save are folded into the first, which is what
 * "learning it again, better labelled" should do.
 */
export function saveMemory(input: { text: string; title?: string; tags?: string[]; meta?: Record<string, unknown>; supersedes?: string }): SaveResult {
  const text = input.text.trim()
  const now = new Date().toISOString()
  const live = allMemories()
  const same = live.find((m) => m.text.trim() === text)
  if (same) {
    const tags = [...new Set([...same.tags, ...(input.tags || [])])]
    const memory: Memory = {
      ...same,
      title: input.title || same.title,
      tags,
      meta: (input.meta || same.meta) ? { ...same.meta, ...input.meta } : undefined,
      updated: now,
    }
    append({ op: 'save', at: now, memory })
    return { memory, merged: true }
  }
  const memory: Memory = {
    id: newId(),
    title: (input.title || autoTitle(text)).trim(),
    text,
    tags: [...new Set((input.tags || []).map((t) => t.trim()).filter(Boolean))],
    ...(input.meta && Object.keys(input.meta).length ? { meta: input.meta } : {}),
    created: now,
    updated: now,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  }
  append({ op: 'save', at: now, memory })
  let replaced: string | undefined
  if (input.supersedes && live.some((m) => m.id === input.supersedes)) {
    append({ op: 'forget', at: now, id: input.supersedes })
    replaced = input.supersedes
  }
  maybeCompact(live.length + 1)
  return { memory, merged: false, ...(replaced ? { replaced } : {}) }
}

export function getMemory(id: string): Memory | undefined {
  return allMemories().find((m) => m.id === id)
}

export function forgetMemory(id: string): boolean {
  const live = allMemories()
  if (!live.some((m) => m.id === id)) return false
  append({ op: 'forget', at: new Date().toISOString(), id })
  maybeCompact(live.length - 1)
  return true
}

/** Tag counts, derived — the number devduck kept in a table and let drift. */
export function tagCounts(memories = allMemories()): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const m of memories) for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1)
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Levenshtein, for "no memory says that — did you mean this tag?" */
export function closest(word: string, options: string[], max = 3): string[] {
  const d = (a: string, b: string): number => {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      let last = prev[0]
      prev[0] = i
      for (let j = 1; j <= b.length; j++) {
        const t = prev[j]
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1))
        last = t
      }
    }
    return prev[b.length]
  }
  const w = word.toLowerCase()
  return options
    .map((o) => ({ o, s: d(w, o.toLowerCase()) }))
    .filter((x) => x.s <= Math.max(1, Math.min(max, Math.floor(x.o.length / 3))))
    .sort((a, b) => a.s - b.s)
    .slice(0, 3)
    .map((x) => x.o)
}

/** Everything recall prints, under one ceiling, honest about what it dropped. */
export function formatRecall(hits: Hit[], query: string, limit: number, max = RECALL_OUTPUT_MAX): string {
  const shown: string[] = []
  let used = 0
  let printed = 0
  for (const h of hits.slice(0, limit)) {
    const line = formatHit(h)
    if (used + line.length > max && printed > 0) break
    shown.push(line)
    used += line.length + 1
    printed++
  }
  const rest = hits.length - printed
  const head = `${hits.length} ${hits.length === 1 ? 'memory' : 'memories'} match${query ? ` "${query}"` : ''}`
  const tail = rest > 0 ? `\n(${rest} more — narrow with tags=, or raise limit=)` : ''
  return `${head}:\n${shown.join('\n')}${tail}`
}

// ── the tool ────────────────────────────────────────────────────────────────

const DESCRIPTION = `🧠 use_memory — durable memory on THIS machine, no account needed.

  save    text='…' [title=] [tags=] [meta=] [supersedes=]  write a fact down
  recall  query='…' [tags=] [since=] [limit=]              find it by intent
  list    [tags=] [limit=]                                 newest first
  get     id=mem_…                                         one memory in full
  forget  id=mem_…                                         delete one
  tags | stats | help

Save what stays true: preferences, decisions, names, how this machine is set
up, what went wrong last time. Recall BEFORE assuming you don't know something
about the user — the query is plain words, never a query language, so no
phrasing can fail. The store is a file the user can read: ~/.tiny/memory.

tiny_recall searches your tiny account's memory graph across devices and is the
better place for facts that should follow the user. This one always works.`

export function makeMemoryTool() {
  return tool({
    // `use_memory`, not `remember`: a device label must map to a `use_<label>`
    // tool or the fleet announces a capability nothing answers (see the
    // device-tools invariant test), and a remote agent asking THIS machine what
    // it remembers is a real mesh call.
    name: 'use_memory',
    description: DESCRIPTION,
    inputSchema: z.object({
      action: z.enum(['save', 'recall', 'list', 'get', 'forget', 'tags', 'stats', 'help']),
      text: z.string().optional().describe('the fact to remember (save)'),
      title: z.string().optional().describe('short label — derived from the text if omitted'),
      tags: z.string().optional().describe('comma-separated tags (save, or a filter for recall/list)'),
      meta: z.string().optional().describe('JSON object of extra fields (save)'),
      supersedes: z.string().optional().describe('id of the memory this replaces (save)'),
      query: z.string().optional().describe('plain words (recall)'),
      id: z.string().optional().describe('memory id (get, forget)'),
      since: z.string().optional().describe('only memories updated after this date, e.g. 2026-08-01'),
      limit: z.number().optional(),
    }),
    callback: async (a) => {
      try {
        const tags = a.tags ? a.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
        let since: number | undefined
        if (a.since) {
          since = Date.parse(a.since)
          if (Number.isNaN(since)) return `since='${a.since}' is not a date I can read — try 2026-08-01`
        }

        switch (a.action) {
          case 'help':
            return DESCRIPTION

          case 'save': {
            if (!a.text?.trim()) return 'text is required — the fact to remember'
            if (a.text.length > MEMORY_TEXT_MAX) return `that is ${a.text.length} characters; a memory is capped at ${MEMORY_TEXT_MAX}. Save the conclusion, not the transcript.`
            let meta: Record<string, unknown> | undefined
            if (a.meta) {
              try {
                const m = JSON.parse(a.meta)
                if (!m || typeof m !== 'object' || Array.isArray(m)) return `meta must be a JSON object, got ${a.meta.slice(0, 60)}`
                meta = m
              } catch (e: any) { return `meta is not valid JSON: ${e.message}` }
            }
            if (a.supersedes && !getMemory(a.supersedes)) return `no memory ${a.supersedes} to supersede — recall first, or save without supersedes=`
            const r = saveMemory({ text: a.text, title: a.title, tags, meta, supersedes: a.supersedes })
            if (r.merged) {
              return `already remembered as ${r.memory.id} — same text, so tags and metadata were merged: ${r.memory.title}${r.memory.tags.length ? ` [${r.memory.tags.join(', ')}]` : ''}`
            }
            return `remembered as ${r.memory.id}: ${r.memory.title}${r.memory.tags.length ? ` [${r.memory.tags.join(', ')}]` : ''}${r.replaced ? `\nreplaced ${r.replaced}` : ''}`
          }

          case 'recall': {
            const memories = allMemories()
            if (!memories.length) return 'nothing remembered yet on this machine.'
            if (!a.query?.trim() && !tags.length && !since) return "query is required — plain words, e.g. query='how do we deploy'"
            const hits = rankMemories(memories, a.query || '', tags, since)
            if (hits.length) return formatRecall(hits, a.query || '', a.limit && a.limit > 0 ? a.limit : RECALL_LIMIT)
            // Nothing matched. Say what the store DOES know about, so the next
            // call can land — devduck stopped at "No results".
            const known = tagCounts(memories)
            const near = [...new Set(queryTerms(a.query || '').flatMap((w) => closest(w, known.map((t) => t.tag))))]
            const hint = near.length
              ? `Nearest tags: ${near.join(', ')}.`
              : known.length ? `Tags in the store: ${known.slice(0, 12).map((t) => t.tag).join(', ')}.` : 'No tags in the store yet.'
            return `no memory matches${a.query ? ` "${a.query}"` : ''}${tags.length ? ` under [${tags.join(', ')}]` : ''} (${memories.length} stored). ${hint}`
          }

          case 'list': {
            const memories = allMemories()
            if (!memories.length) return 'nothing remembered yet on this machine.'
            const hits = rankMemories(memories, '', tags, since)
            if (!hits.length) {
              const known = tagCounts(memories).map((t) => t.tag)
              return `no memories under [${tags.join(', ')}]${a.since ? ` since ${a.since}` : ''}. Tags: ${known.slice(0, 12).join(', ') || '(none)'}`
            }
            return formatRecall(hits, '', a.limit && a.limit > 0 ? a.limit : 10)
          }

          case 'get': {
            if (!a.id) return 'id is required (from a recall result)'
            const m = getMemory(a.id)
            if (!m) {
              const ids = allMemories().map((x) => x.id)
              const near = closest(a.id, ids)
              return `no memory ${a.id}${near.length ? ` — did you mean ${near.join(', ')}?` : ` (${ids.length} stored)`}`
            }
            const head = `${m.title}\nid: ${m.id}  saved: ${day(m.created)}${m.updated !== m.created ? `  updated: ${day(m.updated)}` : ''}${m.tags.length ? `\ntags: ${m.tags.join(', ')}` : ''}${m.meta ? `\nmeta: ${JSON.stringify(m.meta)}` : ''}${m.supersedes ? `\nsupersedes: ${m.supersedes}` : ''}`
            return `${head}\n\n${m.text}`
          }

          case 'forget': {
            if (!a.id) return 'id is required — forget deletes exactly one memory'
            const m = getMemory(a.id)
            if (!m) return `no memory ${a.id} — nothing forgotten`
            forgetMemory(a.id)
            return `forgotten: ${m.title} (${a.id})`
          }

          case 'tags': {
            const counts = tagCounts()
            if (!counts.length) return 'no tags yet.'
            return `${counts.length} tags:\n${counts.map((t) => `  ${t.tag} (${t.count})`).join('\n')}`
          }

          case 'stats': {
            const memories = allMemories()
            if (!memories.length) return `nothing remembered yet. Store: ${memoryFile()}`
            const words = memories.reduce((n, m) => n + m.text.split(/\s+/).filter(Boolean).length, 0)
            const week = Date.now() - 7 * 86_400_000
            const recent = memories.filter((m) => Date.parse(m.updated || m.created) >= week).length
            const oldest = memories.map((m) => m.created).sort()[0]
            const top = tagCounts(memories).slice(0, 8)
            return [
              `${memories.length} memories, ${words.toLocaleString()} words, ${recent} touched this week`,
              `oldest: ${day(oldest)}   store: ${memoryFile()} (${logLines()} log lines)`,
              top.length ? `tags: ${top.map((t) => `${t.tag}(${t.count})`).join(', ')}` : 'no tags',
            ].join('\n')
          }
        }
        return `unknown action ${a.action}`
      } catch (e: any) {
        return `remember failed: ${e?.message || e}`
      }
    },
  })
}
