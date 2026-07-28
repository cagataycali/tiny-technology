/**
 * integrations.ts — the connection store and its status rendering.
 *
 * The wizard itself is prompts and browsers, exercised by hand. What's testable
 * is the part that decides whether a tool exists in the next terminal: the
 * store's read/merge/forget, the env precedence rule, and the status lines the
 * user reads to decide whether to bother connecting.
 *
 * TINY_HOME is redirected per test, so nothing here touches the real ~/.tiny.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  loadIntegrations, saveIntegration, forgetIntegration, applyStoredEnv,
  integrationsPath, renderStatuses, isServiceKey, SERVICE_KEYS, SERVICE_LABELS,
} = await import('../dist/integrations.js')

/** Run fn with a throwaway TINY_HOME and a clean slate of the given env vars. */
function sandbox(fn, clearEnv = []) {
  const home = mkdtempSync(join(tmpdir(), 'tiny-int-'))
  const saved = { TINY_HOME: process.env.TINY_HOME }
  for (const k of clearEnv) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.TINY_HOME = home
  try {
    return fn(home)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  }
}

// ── the store ───────────────────────────────────────────────────────────────

test('loadIntegrations returns an empty store when nothing is connected', () => {
  sandbox(() => {
    assert.deepEqual(loadIntegrations(), { version: 1, services: {} })
  })
})

test('loadIntegrations ignores a corrupt file instead of crashing the CLI', () => {
  sandbox(() => {
    writeFileSync(integrationsPath(), 'not json{')
    assert.deepEqual(loadIntegrations(), { version: 1, services: {} })
  })
})

test('saveIntegration round-trips and writes 0600 — it holds client secrets', () => {
  sandbox(() => {
    saveIntegration('telegram', { TELEGRAM_BOT_TOKEN: 'abc123' })
    assert.deepEqual(loadIntegrations().services.telegram, { TELEGRAM_BOT_TOKEN: 'abc123' })
    assert.equal(statSync(integrationsPath()).mode & 0o777, 0o600)
  }, ['TELEGRAM_BOT_TOKEN'])
})

test('saveIntegration merges into a service rather than replacing it', () => {
  sandbox(() => {
    saveIntegration('spotify', { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'sec' })
    saveIntegration('spotify', { SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:9999/callback' })
    assert.deepEqual(loadIntegrations().services.spotify, {
      SPOTIFY_CLIENT_ID: 'id',
      SPOTIFY_CLIENT_SECRET: 'sec',
      SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:9999/callback',
    })
  }, ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI'])
})

test('saveIntegration with an empty value clears that key', () => {
  sandbox(() => {
    saveIntegration('spotify', { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_REDIRECT_URI: 'x' })
    saveIntegration('spotify', { SPOTIFY_REDIRECT_URI: '' })
    assert.deepEqual(loadIntegrations().services.spotify, { SPOTIFY_CLIENT_ID: 'id' })
  }, ['SPOTIFY_CLIENT_ID', 'SPOTIFY_REDIRECT_URI'])
})

test('saveIntegration keeps other services untouched', () => {
  sandbox(() => {
    saveIntegration('telegram', { TELEGRAM_BOT_TOKEN: 't' })
    saveIntegration('google', { GOOGLE_OAUTH_CLIENT: '/tmp/client.json' })
    const { services } = loadIntegrations()
    assert.deepEqual(Object.keys(services).sort(), ['google', 'telegram'])
  }, ['TELEGRAM_BOT_TOKEN', 'GOOGLE_OAUTH_CLIENT'])
})

test('forgetIntegration removes one service and reports whether it did', () => {
  sandbox(() => {
    saveIntegration('telegram', { TELEGRAM_BOT_TOKEN: 't' })
    saveIntegration('google', { GOOGLE_OAUTH_CLIENT: '/tmp/c.json' })
    assert.equal(forgetIntegration('telegram'), true)
    assert.equal(forgetIntegration('telegram'), false) // already gone
    assert.deepEqual(Object.keys(loadIntegrations().services), ['google'])
  }, ['TELEGRAM_BOT_TOKEN', 'GOOGLE_OAUTH_CLIENT'])
})

test('forgetIntegration deletes the file once the last service is gone', () => {
  sandbox(() => {
    saveIntegration('telegram', { TELEGRAM_BOT_TOKEN: 't' })
    forgetIntegration('telegram')
    // Leaving an empty {} behind would read as "connected, somehow broken".
    assert.equal(existsSync(integrationsPath()), false)
  }, ['TELEGRAM_BOT_TOKEN'])
})

// ── env precedence ──────────────────────────────────────────────────────────

test('applyStoredEnv exports stored values so a connection survives the terminal', () => {
  sandbox(() => {
    writeFileSync(integrationsPath(), JSON.stringify({
      version: 1, services: { telegram: { TELEGRAM_BOT_TOKEN: 'stored' } },
    }))
    assert.deepEqual(applyStoredEnv(), ['TELEGRAM_BOT_TOKEN'])
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'stored')
    delete process.env.TELEGRAM_BOT_TOKEN
  }, ['TELEGRAM_BOT_TOKEN'])
})

test('a real export beats the stored value — an override is deliberate', () => {
  sandbox(() => {
    writeFileSync(integrationsPath(), JSON.stringify({
      version: 1, services: { telegram: { TELEGRAM_BOT_TOKEN: 'stored' } },
    }))
    process.env.TELEGRAM_BOT_TOKEN = 'from-shell'
    assert.deepEqual(applyStoredEnv(), []) // nothing applied
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'from-shell')
  }, ['TELEGRAM_BOT_TOKEN'])
})

test('applyStoredEnv is safe with no store at all', () => {
  sandbox(() => {
    assert.deepEqual(applyStoredEnv(), [])
  })
})

// ── status rendering ────────────────────────────────────────────────────────

test('renderStatuses marks ready, partial and missing distinctly', () => {
  const out = renderStatuses([
    { key: 'google', label: 'Google', state: 'ready', detail: 'authorized', unlocks: '' },
    { key: 'whatsapp', label: 'WhatsApp', state: 'partial', detail: 'not linked', unlocks: '' },
    { key: 'spotify', label: 'Spotify', state: 'missing', detail: 'not connected', unlocks: '' },
  ]).split('\n')
  // Labels pad to the widest one ('WhatsApp'), so the details column lines up.
  assert.match(out[0], /^ {2}✓ Google {4}authorized$/)
  assert.match(out[1], /^ {2}◐ WhatsApp {2}not linked$/)
  assert.match(out[2], /^ {2}· Spotify {3}not connected$/)
})

test('isServiceKey accepts exactly the four services', () => {
  for (const k of SERVICE_KEYS) assert.equal(isServiceKey(k), true)
  assert.equal(isServiceKey('slack'), false)
  assert.equal(isServiceKey(''), false)
})

test('every service key has a label and the set is the documented four', () => {
  assert.deepEqual(SERVICE_KEYS.sort(), ['google', 'spotify', 'telegram', 'whatsapp'])
  for (const k of SERVICE_KEYS) assert.ok(SERVICE_LABELS[k])
})

// ── the CLI contract ────────────────────────────────────────────────────────

test('`connect` is a known command and appears in help', () => {
  // A command missing from KNOWN falls through to the one-shot agent query
  // path, so `tiny-tech connect` would silently ask the model about the word.
  const cli = readFileSync(new URL('../dist/cli.js', import.meta.url), 'utf-8')
  assert.match(cli, /KNOWN = new Set\(\[[^\]]*'connect'/)
  assert.match(cli, /connect \[app\] +optional: connect google\|spotify\|telegram\|whatsapp/)
})
