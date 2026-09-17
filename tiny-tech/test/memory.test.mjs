/**
 * use_memory — the tests are about the five ways devduck's memory lost things.
 *
 * A memory tool is only worth having if it is trustworthy, and "trustworthy"
 * here has specific meanings that each get a test: a question can never be a
 * syntax error, recall can never blow the context window, saving twice cannot
 * lose the second save's labels, stats cannot drift from the store, and no
 * single call can delete more than one memory. The rest pins the file format,
 * because the store is meant to outlive this process — and be readable by a
 * human with `cat`.
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = fs.mkdtempSync(join(tmpdir(), 'tiny-memory-'))
process.env.TINY_MEMORY_DIR = DIR

const M = await import('../dist/agent/memory.js')
const tool = M.makeMemoryTool()
const call = (args) => tool._callback(args)

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {} })

beforeEach(() => { try { fs.rmSync(M.memoryFile()) } catch {} })

const save = (text, extra = {}) => call({ action: 'save', text, ...extra })

// ─── saving ─────────────────────────────────────────────────────────────────

test('a save comes back with an id and a title the user would recognise', async () => {
  const out = await save('We deploy tiny-tech with `npm publish` from main, never from a branch.')
  assert.match(out, /remembered as mem_/)
  // NOT the first 500 characters, which is what devduck used as a title.
  assert.match(out, /We deploy tiny-tech with `npm publish` from main, never from a branch\./)
  const [m] = M.allMemories()
  assert.ok(m.title.length <= 81, m.title)
  assert.equal(m.tags.length, 0)
  assert.equal(m.created, m.updated)
})

test('a title is one sentence, capped, never the whole note', () => {
  assert.equal(M.autoTitle('Short line.\nmore detail after'), 'Short line.')
  assert.equal(M.autoTitle('no punctuation here'), 'no punctuation here')
  const long = M.autoTitle('x'.repeat(300))
  assert.ok(long.length <= 80 && long.endsWith('…'), long)
})

test('saving the same text twice MERGES tags instead of refusing', async () => {
  // devduck answered "⚠️ Duplicate exists" and dropped the new tags and
  // metadata on the floor. Learning something again, better labelled, is not
  // an error.
  await save('The staging database is in eu-west-1.', { tags: 'infra' })
  const out = await save('The staging database is in eu-west-1.', { tags: 'db,staging', meta: '{"source":"runbook"}' })
  assert.match(out, /already remembered/)
  const live = M.allMemories()
  assert.equal(live.length, 1, 'one memory, not two')
  assert.deepEqual(live[0].tags, ['infra', 'db', 'staging'])
  assert.deepEqual(live[0].meta, { source: 'runbook' })
  assert.ok(live[0].updated >= live[0].created, 'the merge touched updated')
})

test('supersedes replaces the old fact and keeps the breadcrumb', async () => {
  await save('The API key lives in 1Password.', { tags: 'secrets' })
  const old = M.allMemories()[0].id
  const out = await save('The API key lives in the shared vault, not 1Password.', { supersedes: old })
  assert.match(out, new RegExp(`replaced ${old}`))
  const live = M.allMemories()
  assert.equal(live.length, 1)
  assert.equal(live[0].supersedes, old)
  assert.match(live[0].text, /shared vault/)
})

test('a save that cannot be right is refused with the reason', async () => {
  assert.match(await call({ action: 'save' }), /text is required/)
  assert.match(await save('x'.repeat(M.MEMORY_TEXT_MAX + 1)), /capped at 20000/)
  assert.match(await save('fine', { meta: 'not json' }), /meta is not valid JSON/)
  assert.match(await save('fine', { meta: '[1,2]' }), /meta must be a JSON object/)
  assert.match(await save('fine', { supersedes: 'mem_nope' }), /no memory mem_nope to supersede/)
  assert.equal(M.allMemories().length, 0, 'nothing was written')
})

// ─── recall ─────────────────────────────────────────────────────────────────

test('a question can never be a syntax error — the whole devduck failure', async () => {
  // sqlite_memory passed the query straight to FTS5 MATCH, so every one of
  // these came back `fts5: syntax error near …` and the memory was, in
  // practice, unreachable.
  await save('We deploy from main with npm publish. Never from a branch.', { tags: 'deploy' })
  for (const q of ["what's the deploy?", 'deploy OR release', '-deploy', 'deploy AND "main"', 'deploy*', '(deploy)', "'"]) {
    const out = await call({ action: 'recall', query: q })
    assert.doesNotMatch(out, /syntax|error|failed/i, `${q} → ${out}`)
  }
  assert.match(await call({ action: 'recall', query: "what's the deploy?" }), /npm publish/)
})

test('recall finds the memory by intent, not by exact words', async () => {
  await save('Cagatay prefers tabs shown as 2 spaces in every editor.', { tags: 'preferences,editor' })
  await save('The Bambu printer is on the 5GHz network and drops off 2.4GHz.', { tags: 'hardware' })
  await save('Deployment runs from main; the release notes go in CHANGELOG.md.', { tags: 'deploy' })

  const editor = await call({ action: 'recall', query: 'how should code be indented' })
  assert.match(editor, /2 spaces/)
  const printer = await call({ action: 'recall', query: 'why does the printer keep disconnecting' })
  assert.match(printer, /Bambu/)
  // A prefix match: `deploy` must find `Deployment`.
  const deploy = await call({ action: 'recall', query: 'deploy' })
  assert.match(deploy.split('\n')[1], /Deployment runs from main/)
})

test('the best hit comes first, and a tag beats a passing mention', async () => {
  await save('Long note that merely mentions zenoh once in passing while discussing something else entirely.', { tags: 'notes' })
  await save('Zenoh is how the mesh discovers peers on the LAN.', { tags: 'zenoh,mesh' })
  const out = await call({ action: 'recall', query: 'zenoh' })
  const first = out.split('\n')[1]
  assert.match(first, /how the mesh discovers peers/, out)
})

test('recall is bounded twice over, and says what it did not show', async () => {
  // devduck could return 50 hits × 50 000 characters — 2.5 MB into a context
  // window — and never mentioned there was more.
  for (let i = 0; i < 12; i++) await save(`Note ${i} about kubernetes clusters. ${'padding '.repeat(400)}`, { tags: 'k8s' })
  const out = await call({ action: 'recall', query: 'kubernetes' })
  assert.ok(out.length <= M.RECALL_OUTPUT_MAX + 400, `recall returned ${out.length} chars`)
  assert.match(out, /12 memories match/)
  assert.match(out, /\(\d+ more — narrow with tags=, or raise limit=\)/)
})

test('a snippet is the window around the match, not the first 320 characters', () => {
  const text = `${'a'.repeat(600)} the interesting part is HERE ${'b'.repeat(600)}`
  const s = M.snippet(text, ['interesting'])
  assert.match(s, /interesting part is HERE/)
  assert.ok(s.length <= M.SNIPPET_WIDTH + 2, s.length)
  assert.ok(s.startsWith('…') && s.endsWith('…'))
  assert.equal(M.snippet('short one', ['short']), 'short one', 'no ellipsis when it all fits')
})

test('recall with no match says what the store DOES know about', async () => {
  await save('The printer is on 5GHz.', { tags: 'hardware' })
  const out = await call({ action: 'recall', query: 'hardwear' })
  assert.match(out, /no memory matches "hardwear"/)
  assert.match(out, /Nearest tags: hardware/, out)
  const blank = await call({ action: 'recall', query: 'quantum tunnelling' })
  assert.match(blank, /Tags in the store: hardware/)
})

test('tags and since narrow the recall, and both can stand alone', async () => {
  await save('A deploy fact.', { tags: 'deploy' })
  await save('A hardware fact.', { tags: 'hardware' })
  const only = await call({ action: 'recall', tags: 'hardware' })
  assert.match(only, /hardware fact/)
  assert.doesNotMatch(only, /deploy fact/)
  // A tag filter is AND, and an unmatched one says so rather than ignoring it.
  assert.match(await call({ action: 'recall', query: 'fact', tags: 'deploy,hardware' }), /no memory matches/)
  assert.match(await call({ action: 'recall', query: 'fact', since: 'yesterday-ish' }), /is not a date I can read/)
  const future = await call({ action: 'recall', query: 'fact', since: '2099-01-01' })
  assert.match(future, /no memory matches/)
})

test('recall on an empty store says so instead of pretending', async () => {
  assert.match(await call({ action: 'recall', query: 'anything' }), /nothing remembered yet/)
  await save('one thing')
  assert.match(await call({ action: 'recall' }), /query is required/)
})

// ─── list, get, forget ──────────────────────────────────────────────────────

test('list is newest first and get returns the memory in full', async () => {
  await save('First fact about oranges.', { tags: 'fruit' })
  await save('Second fact about apples.', { tags: 'fruit' })
  const list = await call({ action: 'list' })
  assert.ok(list.indexOf('apples') < list.indexOf('oranges'), list)

  const id = M.allMemories().find((m) => m.text.includes('apples')).id
  const got = await call({ action: 'get', id })
  assert.match(got, /Second fact about apples\./)
  assert.match(got, new RegExp(`id: ${id}`))
  assert.match(got, /tags: fruit/)
})

test('get with a typo in the id offers the near miss', async () => {
  await save('a fact')
  const id = M.allMemories()[0].id
  const out = await call({ action: 'get', id: id.slice(0, -1) + 'z' })
  assert.match(out, new RegExp(`did you mean ${id}`))
})

test('forget deletes exactly one memory and nothing else can', async () => {
  // devduck shipped action="sql" with arbitrary SQL, so `DROP TABLE memories`
  // was one prompt injection away. There is no route here that deletes more
  // than one, and no route that runs a statement.
  await save('keep me one')
  await save('keep me two')
  await save('delete me')
  const id = M.allMemories().find((m) => m.text === 'delete me').id
  assert.match(await call({ action: 'forget', id }), /forgotten: delete me/)
  assert.deepEqual(M.allMemories().map((m) => m.text).sort(), ['keep me one', 'keep me two'])
  assert.match(await call({ action: 'forget', id }), /nothing forgotten/)
  assert.match(await call({ action: 'forget' }), /id is required/)
  // No action takes SQL, and an unknown action is refused by the schema, not
  // run. Assert on the JSON the SDK actually sends the model: `tool.inputSchema`
  // is undefined on this SDK, so a check written against it proves nothing.
  const schema = tool._inputSchema.toJSONSchema()
  assert.ok(!Object.keys(schema.properties).some((k) => /sql|query_raw|statement/i.test(k)))
  assert.deepEqual(schema.properties.action.enum,
    ['save', 'recall', 'list', 'get', 'forget', 'tags', 'stats', 'help'])
})

// ─── counts that cannot drift ───────────────────────────────────────────────

test('tag counts are derived, so stats cannot lie', async () => {
  // devduck kept counts in a `tags` table that `update` never touched: after
  // one edit, `stats` reported tags that no memory had.
  await save('one', { tags: 'alpha,beta' })
  await save('two', { tags: 'beta' })
  const id = M.allMemories().find((m) => m.text === 'two').id
  await call({ action: 'forget', id })
  assert.deepEqual(M.tagCounts(), [{ tag: 'alpha', count: 1 }, { tag: 'beta', count: 1 }])
  const tags = await call({ action: 'tags' })
  assert.match(tags, /alpha \(1\)/)
  assert.match(tags, /beta \(1\)/)
  const stats = await call({ action: 'stats' })
  assert.match(stats, /^1 memories/m)
  assert.match(stats, /alpha\(1\), beta\(1\)/)
})

test('stats on an empty store names the file, so the user can look', async () => {
  const out = await call({ action: 'stats' })
  assert.match(out, /nothing remembered yet/)
  assert.match(out, /memories\.jsonl/)
})

// ─── the store on disk ──────────────────────────────────────────────────────

test('the store is a JSONL file a human can read, one line per write', async () => {
  await save('a fact worth keeping', { tags: 'x' })
  const lines = fs.readFileSync(M.memoryFile(), 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1)
  const r = JSON.parse(lines[0])
  assert.equal(r.op, 'save')
  assert.equal(r.memory.text, 'a fact worth keeping')
  assert.match(r.at, /^\d{4}-\d\d-\d\dT/)
})

test('a corrupt line is skipped, not fatal — a half-written line is survivable', () => {
  const good = { op: 'save', at: new Date().toISOString(), memory: { id: 'mem_a', title: 't', text: 'good one', tags: [], created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z' } }
  fs.mkdirSync(M.memoryDir(), { recursive: true })
  fs.writeFileSync(M.memoryFile(), `${JSON.stringify(good)}\n{"op":"save","memo\n`)
  const live = M.allMemories()
  assert.equal(live.length, 1)
  assert.equal(live[0].text, 'good one')
})

test('a forget is a tombstone, and replaying the log is what decides', () => {
  const mem = (id, text) => ({ id, title: text, text, tags: [], created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z' })
  fs.mkdirSync(M.memoryDir(), { recursive: true })
  fs.writeFileSync(M.memoryFile(), [
    JSON.stringify({ op: 'save', at: '1', memory: mem('mem_a', 'first') }),
    JSON.stringify({ op: 'save', at: '2', memory: mem('mem_b', 'second') }),
    JSON.stringify({ op: 'forget', at: '3', id: 'mem_a' }),
    JSON.stringify({ op: 'save', at: '4', memory: { ...mem('mem_b', 'second, edited') } }),
  ].join('\n') + '\n')
  assert.deepEqual(M.allMemories().map((m) => m.text), ['second, edited'])
})

test('compaction rewrites the log to one line per memory and keeps them all', async () => {
  for (let i = 0; i < 6; i++) await save(`fact ${i}`)
  const ids = M.allMemories().map((m) => m.id)
  for (const id of ids.slice(0, 3)) await call({ action: 'forget', id })
  assert.equal(M.compact(), true)
  assert.equal(M.logLines(), 3, 'one line per live memory')
  assert.deepEqual(M.allMemories().map((m) => m.text), ['fact 3', 'fact 4', 'fact 5'])
})

test('two writers appending at once keep both memories', async () => {
  // The registry lost-update bug, in miniature: read-modify-write would drop
  // one of these. Appending cannot.
  await Promise.all(Array.from({ length: 8 }, (_, i) => save(`concurrent fact ${i}`)))
  assert.equal(M.allMemories().length, 8)
})

// ─── plumbing ───────────────────────────────────────────────────────────────

test('the store follows TINY_MEMORY_DIR, then TINY_HOME, then ~/.tiny', () => {
  assert.equal(M.memoryDir(), DIR)
  delete process.env.TINY_MEMORY_DIR
  process.env.TINY_HOME = '/tmp/tiny-home-test'
  assert.equal(M.memoryDir(), '/tmp/tiny-home-test/memory')
  delete process.env.TINY_HOME
  assert.match(M.memoryDir(), /\.tiny\/memory$/)
  process.env.TINY_MEMORY_DIR = DIR
})

test('TINY_MEMORY=0 is the only way it is absent', () => {
  assert.equal(M.hasMemory(), true)
  process.env.TINY_MEMORY = '0'
  assert.equal(M.hasMemory(), false)
  delete process.env.TINY_MEMORY
})

test('a question of pure stopwords still searches something', () => {
  assert.deepEqual(M.queryTerms('what is the'), ['what', 'is', 'the'])
  assert.deepEqual(M.queryTerms('what is the deploy'), ['deploy'])
})

test('tokenising is unicode-aware — çay is a word', () => {
  assert.deepEqual(M.tokenize('çay, café — 2 şeker'), ['çay', 'café', '2', 'şeker'])
  assert.deepEqual(M.tokenize("don't split-me"), ["don't", 'split-me'])
})

test('help answers without touching the store', async () => {
  const out = await call({ action: 'help' })
  assert.match(out, /use_memory/)
  assert.match(out, /tiny_recall/, 'points at the cloud memory for facts that should travel')
  assert.equal(fs.existsSync(M.memoryFile()), false)
})
