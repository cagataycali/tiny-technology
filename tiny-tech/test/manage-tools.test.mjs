/**
 * manage_tools — sandbox validation, github raw conversion, create/remove/
 * reload composition with the local-tools loader, kill switch. Uses a temp
 * TINY_TOOLS_DIR and a fake registry; the sandbox tests spawn REAL node
 * subprocesses (that isolation is the feature under test).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  toRawUrl, toolFilePath, loadToolDisabled, sandboxValidate, judgeSandbox,
  makeManageToolsTool,
} from '../dist/agent/manage-tools.js'

const GOOD_TOOL = `export default {
  name: 'greet',
  description: 'Says hello to a name.',
  inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
  handler({ who }) { return 'hello ' + (who ?? 'world') },
}
`

test('toRawUrl converts github blob links, passes others through', () => {
  assert.equal(
    toRawUrl('https://github.com/u/r/blob/main/tools/x.mjs'),
    'https://raw.githubusercontent.com/u/r/main/tools/x.mjs',
  )
  assert.equal(toRawUrl('https://example.com/x.mjs'), 'https://example.com/x.mjs')
})

test('sandbox: valid tool source passes and reports the definition', async () => {
  const r = await sandboxValidate(GOOD_TOOL)
  assert.equal(r.ok, true)
  assert.equal(r.tools.length, 1)
  assert.equal(r.tools[0].name, 'greet')
  assert.equal(r.tools[0].hasHandler, true)
  const v = judgeSandbox(r)
  assert.ok(v.ok && v.names.includes('greet'))
})

test('sandbox: syntax error is caught in the subprocess, not here', async () => {
  const r = await sandboxValidate('export default { name: "broken", oops')
  assert.equal(r.ok, false)
  assert.ok(r.output.length > 0)
  const v = judgeSandbox(r)
  assert.ok(!v.ok && /failed to import/.test(v.reason))
})

test('sandbox: top-level throw is caught; module without tools is judged unloadable', async () => {
  const thrown = await sandboxValidate('throw new Error("boom at import time")')
  assert.equal(thrown.ok, false)
  assert.match(thrown.output, /boom at import time/)
  const empty = await sandboxValidate('export const x = 1')
  assert.equal(empty.ok, true) // imports fine…
  const v = judgeSandbox(empty)
  assert.ok(!v.ok && /no default/.test(v.reason)) // …but nothing loadable
})

test('judgeSandbox: missing description or handler is named specifically', () => {
  const noDesc = judgeSandbox({ ok: true, output: '', tools: [{ name: 'x', hasHandler: true, isStrandsTool: false }] })
  assert.ok(!noDesc.ok && /no description/.test(noDesc.reason))
  const noFn = judgeSandbox({ ok: true, output: '', tools: [{ name: 'x', description: 'd', hasHandler: false, isStrandsTool: false }] })
  assert.ok(!noFn.ok && /no handler/.test(noFn.reason))
})

// ── tool-level: temp dir + fake registry ────────────────────────────────────

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-mt-'))
  const reg = {
    tools: new Map([['bash', { name: 'bash', description: 'builtin shell' }]]),
    addOrReplace(ts) { for (const t of ts) this.tools.set(t.name, t) },
    remove(n) { this.tools.delete(n) },
    list() { return [...this.tools.values()] },
  }
  let previous = []
  const t = makeManageToolsTool({
    registry: () => reg,
    reserved: () => ['bash', 'manage_tools', 'manage_messages'],
    previous: () => previous,
    onLoaded: (names) => { previous = names },
    dir: () => dir,
  })
  return { dir, reg, t, cleanup: () => rmSync(dir, { recursive: true, force: true }), names: () => previous }
}

test('tool: create sandbox-validates, writes to the tools dir and hot-loads', async () => {
  const h = makeHarness()
  try {
    const out = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL }))
    assert.match(out, /✅ create: greet live at/)
    assert.ok(existsSync(toolFilePath('greet', h.dir)))
    assert.ok(h.reg.tools.has('greet'), 'hot-loaded into the live registry')
    assert.deepEqual(h.names(), ['greet'])
    // callable through the loader's wrapper
    const call = await h.reg.tools.get('greet').invoke({ who: 'tiny' })
    assert.match(String(call), /hello tiny/)
    // second create with the same name refuses to overwrite
    const dup = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL }))
    assert.match(dup, /already exists/)
  } finally { h.cleanup() }
})

test('tool: create refuses broken code, builtin names, and name mismatches', async () => {
  const h = makeHarness()
  try {
    const broken = String(await h.t.invoke({ action: 'create', code: 'export default { name: "x", nope' }))
    assert.match(broken, /rejected by sandbox/)
    assert.ok(!existsSync(toolFilePath('x', h.dir)), 'nothing written on sandbox failure')
    const builtin = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL.replace("'greet'", "'bash'") }))
    assert.match(builtin, /builtin tool name/)
    const mismatch = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL, name: 'other' }))
    assert.match(mismatch, /must match/)
  } finally { h.cleanup() }
})

test('tool: list shows builtins + local + dynamic with kinds', async () => {
  const h = makeHarness()
  try {
    await h.t.invoke({ action: 'create', code: GOOD_TOOL })
    h.reg.addOrReplace([{ name: 'ghost', description: 'runtime-only', stream() {} }])
    const out = String(await h.t.invoke({ action: 'list' }))
    assert.match(out, /bash \[builtin\]/)
    assert.match(out, /greet \[local ~\/.tiny\/tools\]/)
    assert.match(out, /ghost \[dynamic\]/)
  } finally { h.cleanup() }
})

test('tool: remove unregisters; delete_file also deletes; builtins refused', async () => {
  const h = makeHarness()
  try {
    await h.t.invoke({ action: 'create', code: GOOD_TOOL })
    const kept = String(await h.t.invoke({ action: 'remove', name: 'greet' }))
    assert.match(kept, /its file .* remains/)
    assert.ok(!h.reg.tools.has('greet') && existsSync(toolFilePath('greet', h.dir)))
    // reload brings it back (the file is still there) — then delete for real
    await h.t.invoke({ action: 'reload' })
    assert.ok(h.reg.tools.has('greet'))
    const gone = String(await h.t.invoke({ action: 'remove', name: 'greet', delete_file: true }))
    assert.match(gone, /deleted/)
    assert.ok(!existsSync(toolFilePath('greet', h.dir)))
    const builtin = String(await h.t.invoke({ action: 'remove', name: 'bash' }))
    assert.match(builtin, /cannot be removed/)
    const missing = String(await h.t.invoke({ action: 'remove', name: 'nope' }))
    assert.match(missing, /no tool named/)
  } finally { h.cleanup() }
})

test('tool: reload picks up files written behind its back', async () => {
  const h = makeHarness()
  try {
    writeFileSync(join(h.dir, 'sneaky.mjs'), GOOD_TOOL.replace("'greet'", "'sneaky'"), 'utf8')
    const out = String(await h.t.invoke({ action: 'reload' }))
    assert.match(out, /✅ sneaky/)
    assert.ok(h.reg.tools.has('sneaky'))
  } finally { h.cleanup() }
})

test('tool: discover inspects without loading', async () => {
  const h = makeHarness()
  try {
    const out = String(await h.t.invoke({ action: 'discover', code: GOOD_TOOL }))
    assert.match(out, /✅ greet — Says hello/)
    assert.ok(!h.reg.tools.has('greet'), 'discover must not load')
    assert.ok(!existsSync(toolFilePath('greet', h.dir)), 'discover must not write')
  } finally { h.cleanup() }
})

test('kill switch: TINY_DISABLE_LOAD_TOOL=true refuses create/fetch/reload but not list/remove', async () => {
  const h = makeHarness()
  process.env.TINY_DISABLE_LOAD_TOOL = 'true'
  try {
    assert.equal(loadToolDisabled(), true)
    for (const action of ['create', 'fetch', 'reload']) {
      const out = String(await h.t.invoke({ action, code: GOOD_TOOL, url: 'https://example.com/x.mjs' }))
      assert.match(out, /TINY_DISABLE_LOAD_TOOL/, `${action} must be gated`)
    }
    const list = String(await h.t.invoke({ action: 'list' }))
    assert.match(list, /tools in the live registry/)
  } finally {
    delete process.env.TINY_DISABLE_LOAD_TOOL
    h.cleanup()
  }
})

// ── per-call registry resolution (the fork fix) ─────────────────────────────
//
// Tool instances are SHARED across forked turns: the registry captured at
// build time is the session agent's, while the agent executing a toolUse (a
// fork, a loop iteration) has its own. These tests pin the fix: mutations
// resolve ToolContext.agent.toolRegistry per call and reach BOTH registries,
// so a tool created mid-turn is callable in the same turn AND survives it.

function fakeRegistry(seed = []) {
  const reg = {
    tools: new Map(seed.map((t) => [t.name, t])),
    addOrReplace(ts) { for (const t of ts) this.tools.set(t.name, t) },
    remove(n) { this.tools.delete(n) },
    list() { return [...this.tools.values()] },
  }
  return reg
}

test('fork fix: create hot-loads into the EXECUTING agent registry from ToolContext, and the session registry', async () => {
  const h = makeHarness()
  const forkReg = fakeRegistry()
  const toolContext = { agent: { toolRegistry: forkReg } }
  try {
    const out = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL }, toolContext))
    assert.match(out, /✅ create: greet live at/)
    assert.ok(forkReg.tools.has('greet'), 'the fork executing the call sees it — same-turn callable')
    assert.ok(h.reg.tools.has('greet'), 'the session registry sees it too — future turns keep it')
  } finally { h.cleanup() }
})

test('fork fix: remove drops the tool from EVERY registry that has it', async () => {
  const h = makeHarness()
  const forkReg = fakeRegistry()
  const toolContext = { agent: { toolRegistry: forkReg } }
  try {
    await h.t.invoke({ action: 'create', code: GOOD_TOOL }, toolContext)
    const out = String(await h.t.invoke({ action: 'remove', name: 'greet', delete_file: true }, toolContext))
    assert.match(out, /🗑 removed "greet"/)
    assert.ok(!forkReg.tools.has('greet'), 'gone from the executing registry')
    assert.ok(!h.reg.tools.has('greet'), 'gone from the session registry')
  } finally { h.cleanup() }
})

test('fork fix: no toolContext still works against the session registry (backward compatible)', async () => {
  const h = makeHarness()
  try {
    const out = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL }))
    assert.match(out, /✅ create: greet live at/)
    assert.ok(h.reg.tools.has('greet'))
  } finally { h.cleanup() }
})

test('fork fix: identical executing and session registries are deduped (no double add)', async () => {
  const h = makeHarness()
  const toolContext = { agent: { toolRegistry: h.reg } }
  try {
    const out = String(await h.t.invoke({ action: 'create', code: GOOD_TOOL }, toolContext))
    assert.match(out, /✅ create: greet live at/)
    assert.equal(h.reg.list().filter((t) => t.name === 'greet').length, 1)
  } finally { h.cleanup() }
})
