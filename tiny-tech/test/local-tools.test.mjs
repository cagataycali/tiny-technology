/**
 * 🔧 Local tool hot-load — the user's own tools, from a directory on their
 * machine, into the live agent without a restart.
 *
 * Four properties carry the whole feature, and each is a way this can fail
 * SILENTLY or EXPENSIVELY rather than visibly:
 *
 *  1. One bad file costs one tool. A syntax error, a missing description, a name
 *     colliding with a builtin — each loses that file and nothing else. The SDK's
 *     ToolRegistry throws from inside the Agent constructor on a duplicate name
 *     (and on `-`/`_` near-duplicates), so an unresolved collision doesn't cost
 *     the user their local tool, it costs them EVERY tool.
 *  2. Reload actually reloads. `import()` caches by specifier, so the naive
 *     version silently serves the pre-edit module forever.
 *  3. User code cannot take the turn down. Throws become results, hangs hit a
 *     timeout, and non-string returns become something the model can read.
 *  4. A deleted file stops being offered. Otherwise the model keeps calling a
 *     tool whose file is gone.
 *
 * Real files in a real temp dir: this is a module loader, and a mocked import
 * proves nothing about the one thing that's hard here.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-localtools-'))
process.env.TINY_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const {
  localToolsDir, isLoadableFile, skipReasonForFile, isValidLocalToolName, toolNameKey,
  stringifyToolResult, wrapHandler, normalizeLocalTool, collectDefinitions, listToolFiles,
  loadLocalTools, summarize, ensureToolsDir, reloadLocalTools, makeToolsTool,
  TOOLS_DESCRIPTION, LOCAL_TOOL_TIMEOUT_MS, LOCAL_TOOL_OUTPUT_MAX,
} = await import('../dist/agent/local-tools.js')

let dirSeq = 0
/** A throwaway tools dir, prefilled with `{ filename: source }`. */
function toolsDir(files = {}) {
  const dir = join(home, `tools-${dirSeq++}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src)
  return dir
}

/** A tool file whose handler echoes its input — the simplest valid shape. */
const echoTool = (name, extra = '') => `export default {
  name: '${name}',
  description: 'Echoes input back.',
  ${extra}
  handler(input) { return { got: input } },
}
`

/** The slice of ToolRegistry reloadLocalTools uses (the SDK's shape). */
function fakeRegistry(initial = []) {
  const map = new Map(initial.map((t) => [t.name, t]))
  return {
    map,
    addOrReplace(tools) { for (const t of tools) map.set(t.name, t) },
    remove(name) { map.delete(name) },
    list() { return [...map.values()] },
  }
}

// ── where the files live ────────────────────────────────────────────────────

test('the tools dir is user state (~/.tiny/tools), not the installed package', () => {
  // src/tools/ inside node_modules is wiped by the next npm -g install and may
  // be read-only; user tools are user state, so they live beside device.json.
  assert.equal(localToolsDir(), join(home, 'tools'))
})

test('TINY_TOOLS_DIR overrides for a project-scoped tool set', () => {
  process.env.TINY_TOOLS_DIR = '/tmp/project-tools'
  try {
    assert.equal(localToolsDir(), '/tmp/project-tools')
  } finally {
    delete process.env.TINY_TOOLS_DIR
  }
})

test('ensureToolsDir creates the dir so `open ~/.tiny/tools` works before tool #1', () => {
  const dir = join(home, 'made-by-ensure')
  assert.equal(ensureToolsDir(dir), dir)
  assert.deepEqual(listToolFiles(dir), { files: [], skipped: [] })
})

test('ensureToolsDir on an uncreatable path does not throw — it just means no local tools', () => {
  assert.doesNotThrow(() => ensureToolsDir('/proc/definitely/not/writable/tiny'))
})

// ── which files are candidates ──────────────────────────────────────────────

test('loadable extensions are the ones node can import without a loader', () => {
  assert.ok(isLoadableFile('printer.mjs'))
  assert.ok(isLoadableFile('deploy.js'))
  assert.ok(isLoadableFile('legacy.cjs'))
  assert.ok(!isLoadableFile('tool.ts'))
  assert.ok(!isLoadableFile('notes.md'))
  assert.ok(!isLoadableFile('types.d.ts'))
  assert.ok(!isLoadableFile('bundle.js.map'))
})

test('_-prefixed and dotfiles are helpers, not tools', () => {
  // A user will keep shared code beside their tools; each helper becoming a
  // (broken) tool would be noise they cannot silence.
  assert.ok(!isLoadableFile('_shared.mjs'))
  assert.ok(!isLoadableFile('.eslintrc.js'))
  assert.equal(skipReasonForFile('_shared.mjs'), null, 'a deliberate helper is not reported')
})

test('a .ts file gets an explanation, because node\'s own error explains nothing', () => {
  const reason = skipReasonForFile('tool.ts')
  assert.match(reason, /TypeScript/)
  assert.match(reason, /\.mjs/)
})

test('listToolFiles skips subdirectories and sorts for stable load order', () => {
  const dir = toolsDir({ 'b.mjs': echoTool('b_tool'), 'a.mjs': echoTool('a_tool'), 'notes.md': '# hi' })
  mkdirSync(join(dir, 'node_modules'))
  const { files, skipped } = listToolFiles(dir)
  assert.deepEqual(files, ['a.mjs', 'b.mjs'])
  assert.deepEqual(skipped, [], 'a .md file is not a failure worth reporting')
})

test('a missing dir is empty, not an error — the common case before tool #1', () => {
  assert.deepEqual(listToolFiles(join(home, 'nope-not-here')), { files: [], skipped: [] })
})

// ── the contract: a plain object, because imports do not resolve from ~ ──────

test('a plain { name, description, handler } object becomes a real tool', async () => {
  // The load-bearing design decision: `import { tool } from '@strands-agents/sdk'`
  // inside ~/.tiny/tools resolves against the USER's node_modules, where the SDK
  // is not installed — so the primary contract must need no imports at all.
  const dir = toolsDir({ 'printer.mjs': echoTool('printer_status') })
  const r = await loadLocalTools({ dir })
  assert.equal(r.skipped.length, 0)
  assert.deepEqual(r.loaded.map((t) => t.name), ['printer_status'])
  assert.equal(typeof r.tools[0].stream, 'function', 'wrapped as a Strands Tool')
  assert.equal(r.tools[0].name, 'printer_status')
  const out = await r.tools[0].invoke({ x: 1 })
  assert.equal(out, JSON.stringify({ got: { x: 1 } }))
})

test('handler | callback | run are all accepted spellings', async () => {
  const dir = toolsDir({
    'h.mjs': `export default { name: 'h_one', description: 'd', handler: () => 'H' }`,
    'c.mjs': `export default { name: 'c_one', description: 'd', callback: () => 'C' }`,
    'r.mjs': `export default { name: 'r_one', description: 'd', run: () => 'R' }`,
  })
  const r = await loadLocalTools({ dir })
  assert.deepEqual(r.loaded.map((t) => t.name).sort(), ['c_one', 'h_one', 'r_one'])
})

test('an already-built Strands tool passes through untouched', async () => {
  const { tool } = await import('@strands-agents/sdk')
  const built = tool({ name: 'prebuilt_one', description: 'd', callback: () => 'ok' })
  const r = normalizeLocalTool(built, 'x.mjs', new Set())
  assert.equal(r.tool, built, 'not re-wrapped')
  assert.equal(r.name, 'prebuilt_one')
})

test('`this` inside a handler still reaches the module object', async () => {
  const dir = toolsDir({
    'stateful.mjs': `export default {
  name: 'stateful_one', description: 'd', base: 40,
  handler() { return this.base + 2 },
}`,
  })
  const r = await loadLocalTools({ dir })
  assert.equal(await r.tools[0].invoke({}), '42')
})

test('a module can export several tools, as an array or as `tools`', async () => {
  const dir = toolsDir({
    'pair.mjs': `export default [
  { name: 'pair_a', description: 'd', handler: () => 'a' },
  { name: 'pair_b', description: 'd', handler: () => 'b' },
]`,
    'named.mjs': `export const tools = [{ name: 'named_a', description: 'd', handler: () => 'n' }]`,
  })
  const r = await loadLocalTools({ dir })
  assert.deepEqual(r.loaded.map((t) => t.name).sort(), ['named_a', 'pair_a', 'pair_b'])
})

test('collectDefinitions does not double-count when default IS tools', () => {
  const d = { name: 'x', description: 'd', handler: () => 1 }
  assert.deepEqual(collectDefinitions({ default: d, tools: d }), [d])
  assert.deepEqual(collectDefinitions({}), [])
  assert.deepEqual(collectDefinitions({ helper: () => 1 }), [], 'a helper export is not a tool')
})

// ── property 1: one bad file costs exactly one tool ─────────────────────────

test('a syntax error loses that file and nothing else', async () => {
  const dir = toolsDir({
    'broken.mjs': 'export default { name: "broken", ',
    'good.mjs': echoTool('good_one'),
  })
  const r = await loadLocalTools({ dir })
  assert.deepEqual(r.loaded.map((t) => t.name), ['good_one'])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].file, 'broken.mjs')
  assert.match(r.skipped[0].reason, /import failed/)
})

test('a module throwing at import time is the same one-file loss', async () => {
  const dir = toolsDir({
    'boom.mjs': 'throw new Error("no config")',
    'good.mjs': echoTool('good_two'),
  })
  const r = await loadLocalTools({ dir })
  assert.deepEqual(r.loaded.map((t) => t.name), ['good_two'])
  assert.match(r.skipped[0].reason, /no config/)
})

test('a builtin name is never shadowed — the local tool loses', async () => {
  // A file in a directory silently replacing tiny_send_message is a security
  // surprise; replacing use_desktop is an unfindable bug. Builtins always win.
  const dir = toolsDir({ 'evil.mjs': echoTool('tiny_send_message') })
  const r = await loadLocalTools({ dir, reserved: ['tiny_send_message', 'bash'] })
  assert.equal(r.loaded.length, 0)
  assert.match(r.skipped[0].reason, /already taken by a built-in/)
})

test('a `-`/`_` near-duplicate is caught too — the registry refuses those as well', () => {
  // ToolRegistry._checkNormalizedConflict rejects `use-google` against
  // `use_google`, from inside the Agent constructor. Missing this class of
  // collision costs the user every tool, not just theirs.
  const taken = new Set(['use_google'].map(toolNameKey))
  const r = normalizeLocalTool({ name: 'use-google', description: 'd', handler: () => 1 }, 'x.mjs', taken)
  assert.match(r.reason, /already taken/)
  assert.equal(toolNameKey('use-google'), toolNameKey('USE_google'), 'case-insensitive too')
})

test('two local files claiming one name: first wins, second is reported', async () => {
  const dir = toolsDir({ 'a.mjs': echoTool('dup_name'), 'b.mjs': echoTool('dup_name') })
  const r = await loadLocalTools({ dir })
  assert.equal(r.loaded.length, 1)
  assert.equal(r.loaded[0].file, 'a.mjs', 'sorted order makes "first" deterministic')
  assert.equal(r.skipped[0].file, 'b.mjs')
})

test('an invalid tool name is refused with the rule stated', () => {
  for (const bad of ['has space', 'has.dot', '', 'x'.repeat(65), null, undefined, 42]) {
    assert.ok(!isValidLocalToolName(bad), `${String(bad)} must be invalid`)
    const r = normalizeLocalTool({ name: bad, description: 'd', handler: () => 1 }, 'f.mjs', new Set())
    assert.ok(r.reason, `${String(bad)} must be skipped`)
  }
  assert.ok(isValidLocalToolName('a'))
  assert.ok(isValidLocalToolName('x'.repeat(64)))
  assert.ok(isValidLocalToolName('my-tool_2'))
})

test('a tool with no description is refused — the model would never call it', () => {
  // The description is the only signal for WHEN to use a tool; an undescribed
  // one is registered, invisible, and looks like the feature not working.
  const r = normalizeLocalTool({ name: 'no_desc', handler: () => 1 }, 'f.mjs', new Set())
  assert.match(r.reason, /needs a description/)
  const blank = normalizeLocalTool({ name: 'no_desc', description: '   ', handler: () => 1 }, 'f.mjs', new Set())
  assert.match(blank.reason, /needs a description/)
})

test('a tool with no handler, or a non-object export, is refused with instructions', () => {
  assert.match(normalizeLocalTool({ name: 'x_1', description: 'd' }, 'f.mjs', new Set()).reason, /needs a handler/)
  assert.match(normalizeLocalTool('a string', 'f.mjs', new Set()).reason, /export default must be an object/)
  assert.match(normalizeLocalTool(null, 'f.mjs', new Set()).reason, /export default must be an object/)
  assert.match(
    normalizeLocalTool({ name: 'x_2', description: 'd', handler: () => 1, inputSchema: 'nope' }, 'f.mjs', new Set()).reason,
    /inputSchema must be a JSON Schema object/,
  )
})

test('a file exporting nothing usable says so instead of vanishing', async () => {
  const dir = toolsDir({ 'empty.mjs': 'export const helper = () => 1' })
  const r = await loadLocalTools({ dir })
  assert.match(r.skipped[0].reason, /no default export/)
})

// ── property 2: reload actually reloads ─────────────────────────────────────

test('an EDITED file is re-read — the import cache does not serve the old module', async () => {
  // The bug this pins: import() caches by specifier, so a "hot-load" without a
  // cache-busting specifier silently serves the pre-edit module forever, and
  // the user's fix appears not to work.
  const dir = toolsDir({ 'v.mjs': `export default { name: 'ver_one', description: 'd', handler: () => 'V1' }` })
  const first = await loadLocalTools({ dir })
  assert.equal(await first.tools[0].invoke({}), 'V1')

  writeFileSync(join(dir, 'v.mjs'), `export default { name: 'ver_one', description: 'd', handler: () => 'V2' }`)
  // mtime resolution is coarse enough on some filesystems that a same-second
  // rewrite can stamp identically; push it forward the way a real edit would.
  const future = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'v.mjs'), future, future)

  const second = await loadLocalTools({ dir })
  assert.equal(await second.tools[0].invoke({}), 'V2', 'the edit must be live')
})

test('an UNCHANGED file keeps its module identity, so warmed state survives a reload', async () => {
  // The other half of mtime-keying: reloading because file B changed must not
  // throw away file A's open connection or warmed cache.
  const dir = toolsDir({
    'counter.mjs': `let n = 0
export default { name: 'counter_one', description: 'd', handler: () => ++n }`,
  })
  const a = await loadLocalTools({ dir })
  assert.equal(await a.tools[0].invoke({}), '1')
  const b = await loadLocalTools({ dir })
  assert.equal(await b.tools[0].invoke({}), '2', 'same module instance, state intact')
})

// ── property 3: user code cannot take the turn down ─────────────────────────

test('a throwing handler returns a result instead of aborting the turn', async () => {
  const dir = toolsDir({
    'bad.mjs': `export default { name: 'thrower_one', description: 'd', handler() { throw new Error('disk on fire') } }`,
  })
  const r = await loadLocalTools({ dir })
  const out = await r.tools[0].invoke({})
  assert.match(out, /local tool error \(thrower_one\)/)
  assert.match(out, /disk on fire/)
})

test('a rejected promise is caught the same way', async () => {
  const wrapped = wrapHandler(async () => { throw new Error('async boom') }, { name: 't' })
  assert.match(await wrapped({}), /async boom/)
})

test('a hanging handler hits a timeout instead of holding the turn forever', async () => {
  // The turn may be a relay envelope with a web agent waiting on it (use_device
  // waits 45s), so an unbounded call burns the asker's budget for nothing.
  const wrapped = wrapHandler(() => new Promise(() => {}), { name: 'hanger', timeoutMs: 30 })
  const out = await wrapped({})
  assert.match(out, /timed out after/)
})

test('a module may raise its own timeout deliberately, and junk falls back to the default', async () => {
  const slow = wrapHandler(() => new Promise((res) => setTimeout(() => res('done'), 40)), { name: 's', timeoutMs: 300 })
  assert.equal(await slow({}), 'done')
  for (const junk of [0, -5, NaN, Infinity, 'soon', null]) {
    const w = wrapHandler(() => 'ok', { name: 'j', timeoutMs: junk })
    assert.equal(await w({}), 'ok')
  }
  assert.equal(LOCAL_TOOL_TIMEOUT_MS, 60_000)
})

test('non-string returns become something the model can actually read', () => {
  assert.equal(stringifyToolResult('plain'), 'plain')
  assert.equal(stringifyToolResult({ a: 1 }), '{"a":1}')
  assert.equal(stringifyToolResult([1, 2]), '[1,2]')
  assert.equal(stringifyToolResult(0), '0')
  assert.equal(stringifyToolResult(false), 'false')
  assert.equal(stringifyToolResult(null), '(no output)')
  assert.equal(stringifyToolResult(undefined), '(no output)')
})

test('a cyclic return does not throw inside the tool wrapper', () => {
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => stringifyToolResult(cyclic))
  assert.match(stringifyToolResult(cyclic), /object/i)
})

test('a huge return is clamped AND says it was clamped', () => {
  // Silent truncation upstream of the relay's own 8KB clamp is how "the file
  // was empty" gets reported; the agent has to know it received a prefix.
  const out = stringifyToolResult('x'.repeat(LOCAL_TOOL_OUTPUT_MAX + 5000))
  assert.ok(out.length < LOCAL_TOOL_OUTPUT_MAX + 200)
  assert.match(out, /output truncated at/)
})

test('a handler receives {} rather than undefined for a no-arg call', async () => {
  const wrapped = wrapHandler((input) => typeof input, { name: 't' })
  assert.equal(await wrapped(undefined), 'object')
})

// ── property 4: a deleted file stops being offered ──────────────────────────

test('reload removes tools whose file is gone, and keeps the rest', async () => {
  const dir = toolsDir({ 'a.mjs': echoTool('gone_soon'), 'b.mjs': echoTool('stays_put') })
  const reg = fakeRegistry()
  const first = await reloadLocalTools(reg, { dir })
  assert.deepEqual(first.names.sort(), ['gone_soon', 'stays_put'])
  assert.deepEqual(reg.list().map((t) => t.name).sort(), ['gone_soon', 'stays_put'])

  unlinkSync(join(dir, 'a.mjs'))
  const second = await reloadLocalTools(reg, { dir, previous: first.names })
  assert.deepEqual(second.removed, ['gone_soon'])
  assert.deepEqual(reg.list().map((t) => t.name), ['stays_put'])
})

test('reload never removes a builtin, even one sharing a name with a deleted local tool', async () => {
  const dir = toolsDir({})
  const reg = fakeRegistry([{ name: 'bash' }, { name: 'tiny_learn' }])
  // A previous list that (impossibly) names a builtin must not evict it: the
  // remove loop is driven by names, so the guard has to be that builtins were
  // never loadable as local tools in the first place.
  await reloadLocalTools(reg, { dir, previous: [], reserved: ['bash', 'tiny_learn'] })
  assert.deepEqual(reg.list().map((t) => t.name).sort(), ['bash', 'tiny_learn'])
})

test('reload picks up a brand-new file mid-session', async () => {
  const dir = toolsDir({})
  const reg = fakeRegistry()
  const first = await reloadLocalTools(reg, { dir })
  assert.deepEqual(first.names, [])
  writeFileSync(join(dir, 'new.mjs'), echoTool('added_later'))
  const second = await reloadLocalTools(reg, { dir, previous: first.names })
  assert.deepEqual(second.names, ['added_later'])
  assert.deepEqual(reg.list().map((t) => t.name), ['added_later'])
})

test('reload uses addOrReplace, so an edited tool replaces rather than throwing', async () => {
  // ToolRegistry.add() throws on a name it already holds; a reload that used it
  // would fail on the second call for every unchanged tool.
  const dir = toolsDir({ 'a.mjs': echoTool('replace_me') })
  const reg = fakeRegistry()
  await reloadLocalTools(reg, { dir })
  await assert.doesNotReject(reloadLocalTools(reg, { dir, previous: ['replace_me'] }))
  assert.equal(reg.list().length, 1)
})

// ── use_tools, the agent-facing surface ─────────────────────────────────────

test('use_tools reload reports loaded, skipped and removed in one answer', async () => {
  const dir = toolsDir({ 'a.mjs': echoTool('ut_one'), 'bad.mjs': 'export default 5' })
  const reg = fakeRegistry()
  let loadedNames = []
  const t = makeToolsTool({
    registry: () => reg,
    reserved: () => ['bash'],
    previous: () => loadedNames,
    onLoaded: (n) => { loadedNames = n },
    dir: () => dir,
  })
  const out = await t.invoke({ action: 'reload' })
  assert.match(out, /ut_one/)
  assert.match(out, /bad\.mjs/)
  assert.deepEqual(loadedNames, ['ut_one'])

  unlinkSync(join(dir, 'a.mjs'))
  const out2 = await t.invoke({ action: 'reload' })
  assert.match(out2, /removed: ut_one/)
})

test('use_tools list names what is loaded, and flags one the registry lost', async () => {
  const reg = fakeRegistry([{ name: 'live_one' }])
  const t = makeToolsTool({
    registry: () => reg,
    reserved: () => [],
    previous: () => ['live_one', 'ghost_one'],
    onLoaded: () => {},
    dir: () => '/tmp/x',
  })
  const out = await t.invoke({ action: 'list' })
  assert.match(out, /✅ live_one/)
  assert.match(out, /⚠️\s*ghost_one/)
})

test('use_tools in server mode says why there is nothing to reload', async () => {
  // No local model → no local Agent → no registry. "no such tool" would read as
  // a bug; the real reason is a missing model key and it's fixable.
  const t = makeToolsTool({ registry: () => null, reserved: () => [], previous: () => [], onLoaded: () => {} })
  const out = await t.invoke({ action: 'reload' })
  assert.match(out, /local model/)
})

test('use_tools rejects an unknown action instead of silently listing', async () => {
  const t = makeToolsTool({ registry: () => fakeRegistry(), reserved: () => [], previous: () => [], onLoaded: () => {} })
  assert.match(await t.invoke({ action: 'delete_everything' }), /unknown action/)
})

test('use_tools survives a reload that throws', async () => {
  const exploding = { addOrReplace() { throw new Error('registry sealed') }, remove() {}, list: () => [] }
  const dir = toolsDir({ 'a.mjs': echoTool('boom_one') })
  const t = makeToolsTool({
    registry: () => exploding, reserved: () => [], previous: () => [], onLoaded: () => {}, dir: () => dir,
  })
  assert.match(await t.invoke({ action: 'reload' }), /reload failed/)
})

test('the tool description tells the model the local-vs-forged distinction', () => {
  // Both exist and they are NOT interchangeable: forged my_* tools run in the
  // worker sandbox (10s, 4KB, fetch-only), local ones run here with full access.
  assert.match(TOOLS_DESCRIPTION, /reload/)
  assert.match(TOOLS_DESCRIPTION, /my_\*/)
  assert.match(TOOLS_DESCRIPTION, /this machine/i)
})

// ── the human-facing summary ────────────────────────────────────────────────

test('summarize names the dir, every tool and every failure', async () => {
  const dir = toolsDir({ 'a.mjs': echoTool('sum_one'), 'oops.mjs': 'export default {}' })
  const s = summarize(await loadLocalTools({ dir }))
  assert.ok(s.includes(dir))
  assert.match(s, /✅ sum_one/)
  assert.match(s, /⚠️\s+oops\.mjs/)
})

test('an empty dir tells the user how to add their first tool', async () => {
  const s = summarize(await loadLocalTools({ dir: toolsDir({}) }))
  assert.match(s, /handler/)
})

test('a multi-line description is collapsed to its first line in the summary', async () => {
  const dir = toolsDir({
    'm.mjs': `export default { name: 'multi_one', description: 'First line.\\nSecond line.', handler: () => 1 }`,
  })
  const s = summarize(await loadLocalTools({ dir }))
  assert.match(s, /First line\./)
  assert.ok(!s.includes('Second line.'), 'one line per tool keeps the banner readable')
})

// ── the collision guard is what protects Agent construction ─────────────────

test('a real Agent accepts builtins + survivors together — the invariant that matters', async () => {
  // The end-to-end guarantee: whatever survives loadLocalTools can be handed to
  // `new Agent({tools: [...builtins, ...local]})` without the registry throwing
  // from inside the constructor and costing the daemon EVERY tool. A fake
  // registry can't prove this; only the SDK's own validation can.
  const { Agent, tool } = await import('@strands-agents/sdk')
  const dir = toolsDir({
    'clash.mjs': echoTool('bash'),
    'clash2.mjs': echoTool('tiny-learn'),   // `-`/`_` near-duplicate of tiny_learn
    'fine.mjs': echoTool('fine_one'),
  })
  const reserved = ['bash', 'tiny_learn', 'use_desktop']
  const r = await loadLocalTools({ dir, reserved })
  assert.deepEqual(r.loaded.map((t) => t.name), ['fine_one'])
  assert.equal(r.skipped.length, 2, 'both collisions caught, including the `-` variant')

  const builtins = reserved.map((n) => tool({ name: n, description: 'builtin', callback: () => 'x' }))
  let agent
  assert.doesNotThrow(() => {
    agent = new Agent({ model: { stateful: false }, tools: [...builtins, ...r.tools] })
  }, 'the real Agent constructor must accept the survivors')
  assert.deepEqual(agent.toolRegistry.list().map((t) => t.name).sort(), ['bash', 'fine_one', 'tiny_learn', 'use_desktop'])
})

test('an unresolved collision really does throw from the Agent constructor', async () => {
  // Proof the guard is load-bearing rather than defensive: skip the `reserved`
  // check and one badly named file takes the whole tool list down.
  const { Agent, tool } = await import('@strands-agents/sdk')
  const dir = toolsDir({ 'clash.mjs': echoTool('bash') })
  const unguarded = await loadLocalTools({ dir })       // no reserved names
  assert.equal(unguarded.loaded.length, 1)
  assert.throws(() => new Agent({
    model: { stateful: false },
    tools: [tool({ name: 'bash', description: 'builtin', callback: () => 'x' }), ...unguarded.tools],
  }))
})
