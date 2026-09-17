/**
 * onboard.ts — local model-config store, env application, and cloud sync.
 *
 * The store holds live provider secrets, so the tests care about exactly the
 * things a user would be burned by: file mode, env precedence (a real export
 * must always win), and sync conflict rules (a local edit made after the last
 * sync must survive a pull).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-onboard-'))
  process.env.TINY_HOME = dir
  return dir
}

// import once — TINY_HOME is read per call, not at import time
const mod = await import('../dist/onboard.js')

test('store round-trips and is written 0600', () => {
  const home = freshHome()
  const store = mod.loadModelConfig()
  assert.equal(store.active, '')
  store.providers.bedrock = { provider: 'bedrock', apiKey: 'bk-test', region: 'us-east-1', updatedAt: 100 }
  store.active = 'bedrock'
  store.voice = 'coral'
  mod.saveModelConfig(store)

  const mode = statSync(join(home, 'model-config.json')).mode & 0o777
  assert.equal(mode, 0o600, 'provider keys on disk must be 0600')

  const back = mod.loadModelConfig()
  assert.equal(back.active, 'bedrock')
  assert.equal(back.providers.bedrock.apiKey, 'bk-test')
  assert.equal(back.voice, 'coral')
  rmSync(home, { recursive: true, force: true })
})

test('applyModelEnv maps the ACTIVE provider to TINY_MODEL_* and never clobbers a real export', () => {
  const home = freshHome()
  const store = mod.loadModelConfig()
  store.providers.anthropic = { provider: 'anthropic', apiKey: 'sk-ant-x', modelId: 'claude-opus-5', updatedAt: 1 }
  store.providers.openai = { provider: 'openai', apiKey: 'sk-o', updatedAt: 1 }
  store.active = 'anthropic'
  store.voice = 'marin'
  mod.saveModelConfig(store)

  // clean slate
  for (const k of ['TINY_MODEL_PROVIDER', 'TINY_MODEL_API_KEY', 'TINY_MODEL_ID', 'TINY_MODEL_BASE_URL', 'TINY_VOICE']) delete process.env[k]

  assert.equal(mod.applyModelEnv(), 'anthropic')
  assert.equal(process.env.TINY_MODEL_PROVIDER, 'anthropic')
  assert.equal(process.env.TINY_MODEL_API_KEY, 'sk-ant-x')
  assert.equal(process.env.TINY_MODEL_ID, 'claude-opus-5')
  assert.equal(process.env.TINY_VOICE, 'marin')

  // a real export wins — the stored value must NOT overwrite it
  process.env.TINY_MODEL_PROVIDER = 'openai'
  process.env.TINY_MODEL_API_KEY = 'sk-exported'
  mod.applyModelEnv()
  assert.equal(process.env.TINY_MODEL_PROVIDER, 'openai')
  assert.equal(process.env.TINY_MODEL_API_KEY, 'sk-exported')

  for (const k of ['TINY_MODEL_PROVIDER', 'TINY_MODEL_API_KEY', 'TINY_MODEL_ID', 'TINY_MODEL_BASE_URL', 'TINY_VOICE']) delete process.env[k]
  rmSync(home, { recursive: true, force: true })
})

test('applyModelEnv is a no-op with no active provider', () => {
  const home = freshHome()
  delete process.env.TINY_MODEL_PROVIDER
  assert.equal(mod.applyModelEnv(), null)
  assert.equal(process.env.TINY_MODEL_PROVIDER, undefined)
  rmSync(home, { recursive: true, force: true })
})

function fakeApi({ providers = [], voice = '', posts = [], deletes = [] } = {}) {
  return {
    authenticated: true,
    async get(path) {
      if (path.startsWith('/api/model-providers')) return { ok: true, providers }
      if (path.startsWith('/api/account-voice')) return { ok: true, voice }
      throw new Error(`unexpected GET ${path}`)
    },
    async post(path, body) { posts.push({ path, body }); return { ok: true } },
    async delete(path, body) { deletes.push({ path, body }); return { ok: true } },
    _posts: posts, _deletes: deletes,
  }
}

test('pushToCloud sends every provider, marks the active one, and includes keys', async () => {
  const home = freshHome()
  const store = mod.loadModelConfig()
  store.providers.bedrock = { provider: 'bedrock', apiKey: 'bk', region: 'us-west-2', updatedAt: 1 }
  store.providers.openai = { provider: 'openai', apiKey: 'sk', updatedAt: 1 }
  store.active = 'bedrock'
  store.voice = 'sage'
  mod.saveModelConfig(store)

  const api = fakeApi()
  const r = await mod.pushToCloud(api, store)
  assert.equal(r.error, undefined)
  assert.equal(r.pushed, 2)

  const providerPosts = api._posts.filter(p => p.path === '/api/model-providers')
  assert.equal(providerPosts.length, 2)
  const bedrock = providerPosts.find(p => p.body.provider === 'bedrock')
  assert.equal(bedrock.body.isActive, true)
  assert.equal(bedrock.body.apiKey, 'bk')
  assert.equal(bedrock.body.region, 'us-west-2')
  const openai = providerPosts.find(p => p.body.provider === 'openai')
  assert.equal(openai.body.isActive, false)

  const voicePost = api._posts.find(p => p.path === '/api/account-voice')
  assert.equal(voicePost.body.voice, 'sage')

  // lastSync advanced and persisted
  assert.ok(mod.loadModelConfig().lastSync > 0)
  rmSync(home, { recursive: true, force: true })
})

test('pullFromCloud merges cloud rows, honors is_active, and keeps newer local edits', async () => {
  const home = freshHome()
  const store = mod.loadModelConfig()
  const now = Math.floor(Date.now() / 1000)
  // local anthropic edited AFTER lastSync — must survive the pull
  store.lastSync = now - 100
  store.providers.anthropic = { provider: 'anthropic', apiKey: 'local-newer', updatedAt: now - 10 }
  mod.saveModelConfig(store)

  const api = fakeApi({
    providers: [
      { provider: 'bedrock', apiKey: 'cloud-bk', modelId: 'us.anthropic.claude-opus-5', region: 'us-east-1', isActive: true },
      { provider: 'anthropic', apiKey: 'cloud-stale', isActive: false },
    ],
    voice: 'cedar',
  })
  const r = await mod.pullFromCloud(api, store)
  assert.equal(r.error, undefined)
  assert.equal(r.pulled, 1, 'only bedrock lands; local-newer anthropic is protected')
  assert.equal(store.providers.bedrock.apiKey, 'cloud-bk')
  assert.equal(store.active, 'bedrock', 'cloud is_active becomes local active')
  assert.equal(store.providers.anthropic.apiKey, 'local-newer')
  assert.equal(store.voice, 'cedar')
  rmSync(home, { recursive: true, force: true })
})

test('sync is offline-safe: not logged in returns an error, store untouched', async () => {
  const home = freshHome()
  const store = mod.loadModelConfig()
  const api = { authenticated: false }
  const push = await mod.pushToCloud(api, store)
  const pull = await mod.pullFromCloud(api, store)
  assert.equal(push.error, 'not logged in')
  assert.equal(pull.error, 'not logged in')
  assert.equal(mod.loadModelConfig().lastSync, 0)
  rmSync(home, { recursive: true, force: true })
})

test('PROVIDERS: bedrock first (the ask), and every compat id the model factory knows', () => {
  assert.equal(mod.PROVIDERS[0].id, 'bedrock')
  const ids = mod.PROVIDERS.map(p => p.id)
  for (const want of ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'ollama', 'custom']) {
    assert.ok(ids.includes(want), `missing provider ${want}`)
  }
})

test('VOICES mirrors the worker allowlist (a voice we offer must be one a call accepts)', () => {
  const workerAllowlist = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
  for (const v of mod.VOICES) assert.ok(workerAllowlist.includes(v), `voice ${v} not in worker allowlist`)
})
