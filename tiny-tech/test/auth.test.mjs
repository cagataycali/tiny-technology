/**
 * auth.ts — credential store + loopback callback server behavior.
 * No real login: drives the callback server directly. No creds needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, loadCredentials, saveCredentials, clearCredentials, credentialsValid, extractCode } from '../dist/auth.js'

// These cases exercise login()'s loopback callback server, which would
// otherwise spawn a real browser tab (to tiny.invalid) on every run.
process.env.TINY_NO_BROWSER = '1'

test('credential store round-trip with 0600 perms', () => {
  process.env.TINY_HOME = mkdtempSync(join(tmpdir(), 'tiny-auth-'))
  delete process.env.TINY_TOKEN
  const creds = {
    version: 1, apiUrl: 'https://tiny.technology', token: 'tok',
    user: { id: 'u1', login: 'tester' }, expires: Math.floor(Date.now() / 1000) + 1000,
  }
  saveCredentials(creds)
  const mode = statSync(join(process.env.TINY_HOME, 'credentials.json')).mode & 0o777
  assert.equal(mode, 0o600)
  assert.deepEqual(loadCredentials(), creds)
  assert.ok(credentialsValid(loadCredentials()))
  assert.ok(clearCredentials())
  assert.equal(loadCredentials(), null)
})

test('corrupt credentials file → null, not crash', () => {
  process.env.TINY_HOME = mkdtempSync(join(tmpdir(), 'tiny-auth-'))
  delete process.env.TINY_TOKEN
  writeFileSync(join(process.env.TINY_HOME, 'credentials.json'), 'not json{{{')
  assert.equal(loadCredentials(), null)
})

test('expired credentials fail credentialsValid', () => {
  assert.equal(credentialsValid({ version: 1, apiUrl: 'x', token: 't', user: { id: 'a', login: 'b' }, expires: 1 }), false)
})

test('TINY_TOKEN env override wins', () => {
  process.env.TINY_TOKEN = 'env-token'
  const c = loadCredentials()
  assert.equal(c.token, 'env-token')
  assert.ok(credentialsValid(c))
  delete process.env.TINY_TOKEN
})

test('callback server: 404/400 abuse, wrong state, then valid callback resolves', async () => {
  let authUrl = ''
  const done = login('https://tiny.invalid', 10_000, (u) => { authUrl = u })
  // wait for the server to be listening (authUrl set)
  for (let i = 0; i < 50 && !authUrl; i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(authUrl, 'auth url produced')
  const port = authUrl.match(/port=(\d+)/)[1]
  const state = decodeURIComponent(authUrl.match(/state=([^&]+)/)[1])
  const base = `http://127.0.0.1:${port}`

  assert.equal((await fetch(`${base}/nope`)).status, 404)
  assert.equal((await fetch(`${base}/callback`)).status, 400)
  assert.equal((await fetch(`${base}/callback?code=x&state=WRONG`)).status, 400)
  assert.equal((await fetch(`${base}/callback?code=%`)).status, 400) // malformed — must not crash
  // still alive → correct callback now succeeds at the HTTP layer
  const okRes = await fetch(`${base}/callback?code=fakecode&state=${encodeURIComponent(state)}`)
  assert.equal(okRes.status, 200)
  // the exchange against tiny.invalid then fails — that's expected
  await assert.rejects(done, /Token exchange failed|fetch failed|getaddrinfo/)
})

test('extractCode: full callback URL, bare code, state guard, junk', () => {
  const S = 'my-state-nonce'
  // Full URL the remote-device user pastes from their local browser
  assert.equal(extractCode(`http://127.0.0.1:36699/callback?code=abc123&state=${S}`, S), 'abc123')
  // State in the URL must match the session's state
  assert.equal(extractCode(`http://127.0.0.1:36699/callback?code=abc123&state=WRONG`, S), null)
  // Bare code paste — no state to check, trusted as typed (trimmed)
  assert.equal(extractCode('  abc123  ', S), 'abc123')
  // A URL with no code at all → null
  assert.equal(extractCode(`http://127.0.0.1:36699/callback?state=${S}`, S), null)
  // Empty / whitespace → null
  assert.equal(extractCode('   ', S), null)
})

test('callback timeout error includes the auth URL', async () => {
  await assert.rejects(
    login('https://tiny.invalid', 300),
    (e) => /Login timed out/.test(e.message) && /tiny.invalid\/auth\/cli\?port=/.test(e.message)
  )
})
