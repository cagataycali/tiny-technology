/**
 * 🔒 history.ts — shell history goes into the system prompt, so secrets must not.
 *
 * getHistoryContext() reads ~/.zsh_history, ~/.bash_history and a sibling
 * agent's ~/.devduck_history and injects the last 150 entries into every system
 * prompt. That is the feature: tiny knows you were just in a psql shell. It also
 * means the model receives whatever you last typed at a shell, and shell history
 * is one of the densest piles of plaintext credentials on a developer's disk.
 * Nobody typed `export ANTHROPIC_API_KEY=…` AT tiny, so nothing consented to it
 * leaving the machine — and the prompt is rebuilt per turn, so it would leave on
 * every one.
 *
 * Two properties, both asserted here:
 *   1. the SECRET is gone
 *   2. the CONTEXT survives — which credential you were setting, which host you
 *      connected to, which command you ran. A redactor that ate the line would
 *      be safe and useless.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../dist/agent/history.js'

/** Assert the secret is gone AND the shape around it survived. */
function scrubs(line, secret, keeps = []) {
  const out = redactSecrets(line)
  assert.ok(!out.includes(secret), `secret survived: ${out}`)
  for (const k of keeps) {
    assert.ok(out.includes(k), `context lost — expected ${JSON.stringify(k)} in ${out}`)
  }
  return out
}

// ── named assignments: the name is context, the value is the secret ──────────

test('an exported API key keeps its NAME and loses its VALUE', () => {
  const out = scrubs(
    'export ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    ['export', 'ANTHROPIC_API_KEY'],
  )
  assert.match(out, /\[redacted\]/)
})

test('the shapes a secret is assigned in are all covered', () => {
  for (const line of [
    'export GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAA',
    'SECRET_KEY=supersecretvalue npm start',
    'curl -d \'{"password": "hunter2xyz"}\' https://api.example.com',
    'aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCY',
    'PGPASSWORD=tiger psql -h db.internal',
  ]) {
    const out = redactSecrets(line)
    assert.match(out, /\[redacted\]/, `not redacted: ${line}`)
  }
})

test('an ATTACHED -p value goes; a spaced one is left, because -p is usually a path', () => {
  scrubs('mysql -u root -phunter2secret', 'hunter2secret', ['mysql', '-u root'])
  scrubs('mysqldump --password=tiger123 mydb', 'tiger123', ['mysqldump', 'mydb'])
  scrubs('psql --password supersecret1 -h db', 'supersecret1', ['psql', '-h db'])
})

// ── headers, URLs, vendor prefixes ──────────────────────────────────────────

test('an Authorization header loses the credential, keeps the URL', () => {
  scrubs(
    'curl -H "Authorization: Bearer abc123def456ghi789" https://api.internal/v1/orders',
    'abc123def456ghi789',
    ['curl', 'Authorization', 'https://api.internal/v1/orders'],
  )
})

test('URL userinfo is redacted but the host is not — the host is the context', () => {
  const out = scrubs(
    'psql postgres://admin:s3cr3tpass@db.prod.internal:5432/orders',
    's3cr3tpass',
    ['psql', 'postgres://', 'db.prod.internal', '5432', 'orders'],
  )
  assert.ok(out.includes('admin'), 'the username is not a secret and locates the account')
})

test('self-identifying vendor tokens go even with no name attached', () => {
  // Pasted bare into a command — no `KEY=` to key off, so the prefix has to.
  for (const [line, secret] of [
    ['gh api -H x 2>&1 ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['echo sk-ant-api03-BBBBBBBBBBBBBBBBBBBB | pbcopy', 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBB'],
    ['slack-cli --as xoxb-fixture_only_1234567890', 'xoxb-fixture_only_1234567890'],
    ['aws sts get-caller-identity AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['gcloud x AIzaSyD-1234567890abcdefghijklmno', 'AIzaSyD-1234567890abcdefghijklmno'],
  ]) {
    scrubs(line, secret)
  }
})

test('a JWT anywhere on the line is replaced wholesale', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImV4cCI6OTk5fQ.dQw4w9WgXcQabcdef'
  const out = scrubs(`TOKEN_CACHE=${jwt} ./deploy.sh`, jwt, ['./deploy.sh'])
  assert.match(out, /redacted/)
})

// ── the other half: context must survive ────────────────────────────────────

test('an ordinary command is passed through completely untouched', () => {
  // The regression that would make this feature pointless: over-redacting until
  // the injected context says nothing. These lines have no secret in them.
  for (const line of [
    'git commit -m "fix the poller backoff"',
    'npm run build && node --test test/*.test.mjs',
    'cd ~/tinyai-id/tiny-tech && ls -la src/agent',
    'ssh deploy@prod.internal',
    'docker compose up -d --build',
    'kubectl get pods -n production',
    'rg "readFileSync" src/',
  ]) {
    assert.equal(redactSecrets(line), line, `over-redacted: ${line}`)
  }
})

test('a spaced -p is a path or a port, and keeps its argument', () => {
  // -p means password on mysql, PARENTS on mkdir and PORT on ssh. Eating the
  // argument after every -p would gut exactly the context this feature injects.
  for (const line of [
    'mkdir -p src/agent/new',
    'ssh -p 2222 deploy@prod.internal',
    'docker run -p 8080:80 nginx',
    'git push origin main',
  ]) {
    assert.equal(redactSecrets(line), line, `over-redacted: ${line}`)
  }
})

test('redaction is idempotent — a redacted line survives a second pass', () => {
  // getHistoryContext redacts before truncating; if this were not stable, a
  // re-read of an already-scrubbed line could mangle the placeholder.
  const once = redactSecrets('export API_KEY=sk-ant-AAAAAAAAAAAAAAAA')
  assert.equal(redactSecrets(once), once)
})

test('an empty or spaceless line does not throw', () => {
  for (const line of ['', ' ', '\t', 'ls', '=', '://', 'key=']) {
    assert.equal(typeof redactSecrets(line), 'string', `threw or returned non-string on ${JSON.stringify(line)}`)
  }
})
