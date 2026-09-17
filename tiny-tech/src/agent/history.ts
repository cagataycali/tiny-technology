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

/**
 * Shell history is the densest pile of plaintext credentials on a developer's
 * disk, and this file's whole purpose is to mail it to a model.
 *
 * Nobody typed `export ANTHROPIC_API_KEY=sk-ant-…` AT tiny, so nothing consented
 * to it leaving the machine — and because the system prompt is rebuilt per turn,
 * it would leave on every one. The context is worth keeping (knowing you were
 * just in a psql shell is genuinely useful); the secret is incidental to it.
 * `export ANTHROPIC_API_KEY=[redacted]` carries everything that mattered.
 *
 * A filter, not a guarantee. It catches shapes that ANNOUNCE themselves — a
 * secret-sounding variable name, a password flag, an auth header, URL userinfo,
 * or a vendor prefix that is self-identifying. `export FOO=zzz` is
 * indistinguishable from a build flag and still passes; that is the argument for
 * an opt-out as well as a filter, not an argument against the filter.
 */
export function redactSecrets(line: string): string {
  return line
    // KEY=…, --token=…, "secret": "…" — anything whose NAME says it is a secret.
    // The name is kept: which credential you were setting is the useful part.
    .replace(
      /((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|key|token|secret|password|passwd|pwd|credential|auth|bearer)["']?\s*[:=]\s*["']?)([^\s"'`;&|]{4,})/gi,
      '$1[redacted]',
    )
    // `aws configure set aws_secret_access_key <value>` — space-separated, so the
    // assignment rule above cannot see it. Narrow on purpose: a bare `\s+`
    // separator for secret-ish names would redact half of ordinary prose.
    .replace(/\b(aws configure set \S*(?:secret|key|token|password)\S*\s+)(\S+)/gi, '$1[redacted]')
    // mysql -phunter2 — ATTACHED only. `-p` with a space is far more often a
    // path or a port (`mkdir -p src/agent`, `ssh -p 2222`) than a password, and
    // eating the argument after every -p would gut the injected context.
    .replace(/(\s-p)(?=\S)(\S{3,})/g, '$1[redacted]')
    // Long forms are unambiguous, so these may take a spaced value.
    .replace(/(--(?:pass|password|token|secret|api-key)[= ])(\S{3,})/gi, '$1[redacted]')
    // Authorization: Bearer …  ·  -H 'X-Api-Key: …'
    .replace(/((?:authorization|x-api-key|x-auth-token)\s*:\s*(?:bearer\s+|basic\s+)?)(\S+)/gi, '$1[redacted]')
    // postgres://user:pass@host — userinfo only, never the host or the scheme
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi, '$1[redacted]$3')
    // Self-identifying vendor tokens, wherever they appear — no name needed
    .replace(/\b(sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xoxb-|xoxp-|xoxa-|glpat-|AIza)[A-Za-z0-9_-]{8,}/g, '$1[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, 'AKIA[redacted]')
    // JWTs — three base64url segments. Long enough to not hit ordinary words.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    // Commands whose ARGUMENTS are a credential by definition — everything after
    // the verb goes, because there is no non-secret tail worth keeping.
    .replace(/\b(ssh-add|security add-generic-password|gh auth login --with-token)\b.*/gi, '$1 [redacted]')
}

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
      // Redacted like the shells are: this was typed at devduck, not at tiny, so
      // it carries no more consent to leave the machine than a shell line does.
      // tiny's OWN history above is left alone — the model already saw it.
      const q = line.match(/^: (\d+):0;# devduck: (.*)$/)
      if (q) entries.push({ ts: Number(q[1]), who: 'you→devduck', text: redactSecrets(q[2]).slice(0, 200) })
    }
  } catch { /* absent is fine */ }

  // zsh shell commands (extended format has timestamps).
  // Redacted before truncation, so a secret can't survive by being cut in half
  // into something the patterns no longer recognise.
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.zsh_history'), 'utf-8')
    for (const line of raw.split('\n')) {
      const e = parseZshLine(line, 'shell')
      if (e && !e.text.startsWith('#')) entries.push({ ...e, text: `$ ${redactSecrets(e.text).slice(0, 200)}` })
    }
  } catch { /* absent is fine */ }

  // bash (no timestamps — epoch 0 sorts them FIRST, so they're the first
  // trimmed when dated entries fill maxEntries; dated context wins)
  try {
    const lines = fs.readFileSync(path.join(os.homedir(), '.bash_history'), 'utf-8').split('\n')
    for (const line of lines.slice(-30)) {
      if (line.trim()) entries.push({ ts: 0, who: 'shell', text: `$ ${redactSecrets(line.trim()).slice(0, 200)}` })
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
