/**
 * Environment embodiment — devduck's shell-history pattern in TypeScript.
 *
 * Two jobs:
 * 1. Context injection: read ~/.tiny_history + ~/.zsh_history + ~/.bash_history
 *    and inject recent activity into the system prompt, so tiny knows what the
 *    user has been doing on this machine even across restarts (cold-start fix).
 * 2. Input recall: persist REPL/TUI inputs to ~/.tiny_history so ↑/↓ works
 *    across sessions (zsh extended format — greppable, devduck-compatible).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const TINY_HISTORY = path.join(os.homedir(), '.tiny_history')

// ── input recall ────────────────────────────────────────────────────────────

/** Append a REPL input + response summary (zsh extended format). */
export function appendHistory(query: string, response?: string): void {
  try {
    const ts = Math.floor(Date.now() / 1000)
    let entry = `: ${ts}:0;# tiny: ${query.replace(/\n/g, ' ')}\n`
    if (response) {
      entry += `: ${ts}:0;# tiny_result: ${String(response).replace(/\n/g, ' ').slice(0, 2000)}\n`
    }
    fs.appendFileSync(TINY_HISTORY, entry, { mode: 0o600 })
  } catch { /* history is enhancement, never fatal */ }
}

/** Load past user inputs (most recent last) for ↑/↓ recall. */
export function loadInputHistory(limit = 200): string[] {
  try {
    const lines = fs.readFileSync(TINY_HISTORY, 'utf-8').split('\n')
    const inputs: string[] = []
    for (const line of lines) {
      const m = line.match(/^: \d+:0;# tiny: (.*)$/)
      if (m && m[1].trim()) inputs.push(m[1].trim())
    }
    // de-dupe consecutive repeats
    const out: string[] = []
    for (const i of inputs) if (out[out.length - 1] !== i) out.push(i)
    return out.slice(-limit)
  } catch { return [] }
}

// ── context injection ───────────────────────────────────────────────────────

interface HistEntry { ts: number; who: string; text: string }

function parseZshLine(line: string, who: string, skipPrefix?: string): HistEntry | null {
  const m = line.match(/^: (\d+):\d+;(.*)$/s)
  if (!m) return null
  const body = m[2].trim()
  if (!body || (skipPrefix && body.startsWith(skipPrefix))) return null
  return { ts: Number(m[1]), who, text: body }
}

/**
 * Recent machine activity for system-prompt injection.
 * Merges tiny conversation history + zsh + bash shell commands, time-sorted.
 */
export function getHistoryContext(maxEntries = 150): string {
  const entries: HistEntry[] = []

  // tiny's own history (queries + result summaries)
  try {
    for (const line of fs.readFileSync(TINY_HISTORY, 'utf-8').split('\n')) {
      const q = line.match(/^: (\d+):0;# tiny: (.*)$/)
      if (q) { entries.push({ ts: Number(q[1]), who: 'you', text: q[2] }); continue }
      const r = line.match(/^: (\d+):0;# tiny_result: (.*)$/)
      if (r) entries.push({ ts: Number(r[1]), who: 'tiny', text: r[2].slice(0, 300) })
    }
  } catch { /* absent is fine */ }

  // devduck history — same machine, sibling agent
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.devduck_history'), 'utf-8').split('\n')) {
      const q = line.match(/^: (\d+):0;# devduck: (.*)$/)
      if (q) entries.push({ ts: Number(q[1]), who: 'you→devduck', text: q[2].slice(0, 200) })
    }
  } catch { /* absent is fine */ }

  // zsh shell commands (extended format has timestamps)
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.zsh_history'), 'utf-8')
    for (const line of raw.split('\n')) {
      const e = parseZshLine(line, 'shell')
      if (e && !e.text.startsWith('#')) entries.push({ ...e, text: `$ ${e.text.slice(0, 200)}` })
    }
  } catch { /* absent is fine */ }

  // bash (no timestamps — epoch 0 sorts them FIRST, so they're the first
  // trimmed when dated entries fill maxEntries; dated context wins)
  try {
    const lines = fs.readFileSync(path.join(os.homedir(), '.bash_history'), 'utf-8').split('\n')
    for (const line of lines.slice(-30)) {
      if (line.trim()) entries.push({ ts: 0, who: 'shell', text: `$ ${line.trim().slice(0, 200)}` })
    }
  } catch { /* absent is fine */ }

  if (!entries.length) return ''

  entries.sort((a, b) => a.ts - b.ts)
  const recent = entries.slice(-maxEntries)

  const fmt = (e: HistEntry) => {
    const t = e.ts
      ? new Date(e.ts * 1000).toLocaleString('sv-SE').slice(0, 16) // local time, ISO-like
      : 'undated'
    return `[${t}] ${e.who}: ${e.text}`
  }
  return `\n\n## Recent machine activity (shell + agent history — this device's context):\n${recent.map(fmt).join('\n')}\n`
}
