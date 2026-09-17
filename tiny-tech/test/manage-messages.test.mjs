/**
 * manage_messages — turn parsing, orphan repair, active-turn preservation,
 * compact. Pure functions against fixture arrays built with the REAL SDK
 * Message class (same block shapes the live agent holds), plus tool-level
 * invariants through a fake ToolContext.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Message } from '@strands-agents/sdk'
import {
  parseTurns, pendingToolUseIds, activeTurnStart, activeToolIds,
  fixIncompleteToolCycles, validateStructure, removeToolBlocks,
  stripToolBlocksFromTurns, summarize, allToolCalls, resolveTurnIndices,
  makeManageMessagesTool,
} from '../dist/agent/manage-messages.js'

// ── fixture builders (MessageData shapes → real SDK Message instances) ──────
const M = (role, content) => Message.fromMessageData({ role, content })
const user = (text) => M('user', [{ text }])
const asst = (text) => M('assistant', [{ text }])
const use = (id, name = 'shell', input = { cmd: 'ls' }) =>
  ({ toolUse: { toolUseId: id, name, input } })
const res = (id, text = 'ok') =>
  ({ toolResult: { toolUseId: id, status: 'success', content: [{ text }] } })

/** turn 0: q + 1 tool cycle · turn 1: q + text only */
function twoTurns() {
  return [
    user('list files'),
    M('assistant', [{ text: 'sure' }, use('t1')]),
    M('user', [res('t1')]),
    asst('done: a b c'),
    user('thanks'),
    asst('welcome'),
  ]
}

/** mid-execution shape: last turn's toolUse (this very call) unresolved */
function midExecution() {
  return [
    ...twoTurns(),
    user('now compact yourself'),
    M('assistant', [use('t-self', 'manage_messages', { action: 'compact' })]),
  ]
}

test('parseTurns: a turn = user query + ALL its tool cycles', () => {
  const turns = parseTurns(twoTurns())
  assert.deepEqual(turns, [{ start: 0, end: 4 }, { start: 4, end: 6 }])
})

test('parseTurns: multi-tool chain stays one turn; toolResult carriers are not queries', () => {
  const msgs = [
    user('do three things'),
    M('assistant', [use('a')]),
    M('user', [res('a')]),
    M('assistant', [use('b'), use('c')]),
    M('user', [res('b'), res('c')]),
    asst('all done'),
  ]
  assert.deepEqual(parseTurns(msgs), [{ start: 0, end: 6 }])
})

test('parseTurns: leading preamble (orphan assistant/toolResult) belongs to no turn', () => {
  const msgs = [M('user', [res('x')]), asst('stray'), user('real query'), asst('answer')]
  assert.deepEqual(parseTurns(msgs), [{ start: 2, end: 4 }])
})

test('pendingToolUseIds finds orphans only', () => {
  assert.deepEqual(pendingToolUseIds(twoTurns()), [])
  assert.deepEqual(pendingToolUseIds(midExecution()), ['t-self'])
})

test('activeTurnStart = last real user query; activeToolIds locks the tail + self', () => {
  const msgs = midExecution()
  assert.equal(activeTurnStart(msgs), 6)
  const ids = activeToolIds(msgs, 'ctx-self')
  assert.ok(ids.has('t-self') && ids.has('ctx-self') && !ids.has('t1'))
})

test('fixIncompleteToolCycles injects a synthetic result after the orphaned assistant msg', () => {
  const msgs = [user('q'), M('assistant', [use('lost')])]
  const fixed = fixIncompleteToolCycles(msgs)
  assert.equal(fixed.length, 3)
  assert.equal(fixed[2].role, 'user')
  const block = fixed[2].content[0]
  assert.equal(block.type, 'toolResultBlock')
  assert.equal(block.toolUseId, 'lost')
  assert.deepEqual(pendingToolUseIds(fixed), [])
})

test('fixIncompleteToolCycles: ids answered by the immediate next message get no synthetic', () => {
  const clean = twoTurns()
  assert.equal(fixIncompleteToolCycles(clean), clean) // no-op returns same array
  // partial: one answered next, one orphaned
  const msgs = [user('q'), M('assistant', [use('a'), use('b')]), M('user', [res('a')]), asst('half')]
  const fixed = fixIncompleteToolCycles(msgs)
  const synth = fixed.find((m) => m.content.some((b) => b.type === 'toolResultBlock' && b.toolUseId === 'b'))
  assert.ok(synth, 'synthetic result for b exists')
  assert.deepEqual(pendingToolUseIds(fixed), [])
})

test('validateStructure: pairing is hard error, same-role adjacency only warns', () => {
  const clean = validateStructure(twoTurns())
  assert.equal(clean.ok, true)
  assert.equal(clean.warnings.length, 0)
  assert.equal(validateStructure([user('q'), M('assistant', [use('x')])]).ok, false)
  // Same-role adjacency is legally produced by drop_tools/compact (carrier
  // removed between assistant messages) and the live rail tolerates it —
  // refusing it made import reject the tool's own exports.
  const adj = validateStructure([user('a'), user('b')])
  assert.equal(adj.ok, true)
  assert.equal(adj.warnings.length, 1)
  assert.match(adj.warnings[0], /same-role/)
})

test('removeToolBlocks drops pair, drops emptied messages, preserves trackingId', () => {
  const msgs = twoTurns()
  const tid = msgs[1].trackingId
  const out = removeToolBlocks(msgs, new Set(['t1']))
  // assistant msg keeps its text block + trackingId; toolResult-only user msg vanishes
  assert.equal(out.length, 5)
  const rebuiltMsg = out[1]
  assert.equal(rebuiltMsg.trackingId, tid)
  assert.deepEqual(rebuiltMsg.content.map((b) => b.type), ['textBlock'])
  assert.ok(!out.some((m) => m.content.some((b) => b.type === 'toolResultBlock')))
})

test('removeToolBlocks strips sibling reasoning when it edits a message (pair must NOT survive)', () => {
  const withReasoning = Message.fromMessageData({
    role: 'assistant',
    content: [{ reasoning: { text: 'let me think', signature: 's' } }, { text: 'running it' }, use('t9')],
  })
  const msgs = [user('q'), withReasoning, M('user', [res('t9')]), asst('done')]
  const out = removeToolBlocks(msgs, new Set(['t9']))
  // toolUse gone, reasoning gone WITH it, plain text kept
  const types = out[1].content.map((b) => b.type)
  assert.deepEqual(types, ['textBlock'])
  // no pending cycle left → fixIncompleteToolCycles must be a no-op
  const repaired = fixIncompleteToolCycles(out)
  assert.equal(repaired.length, out.length)
  assert.deepEqual(pendingToolUseIds(repaired), [])
  // untouched messages pass through unchanged
  assert.equal(out[0], msgs[0])
})

test('removeToolBlocks leaves reasoning-bearing messages alone when they hold no targeted block', () => {
  const bystander = Message.fromMessageData({
    role: 'assistant',
    content: [{ reasoning: { text: 'unrelated thought', signature: 's' } }, { text: 'hi' }],
  })
  const msgs = [user('q'), bystander, M('assistant', [use('t1')]), M('user', [res('t1')])]
  const out = removeToolBlocks(msgs, new Set(['t1']))
  assert.equal(out[1], bystander) // same instance — never edited
})

test('stripToolBlocksFromTurns strips tool blocks from reasoning-bearing messages too', () => {
  const msgs = [
    user('q'),
    Message.fromMessageData({
      role: 'assistant',
      content: [{ reasoning: { text: 'think', signature: 's' } }, { text: 'sure' }, use('t1')],
    }),
    M('user', [res('t1')]),
    asst('done'),
  ]
  const turns = parseTurns(msgs)
  const out = stripToolBlocksFromTurns(msgs, new Set([0]), turns)
  assert.ok(!out.some((m) => m.content.some((b) => b.type === 'toolUseBlock' || b.type === 'toolResultBlock')))
  assert.ok(!out.some((m) => m.content.some((b) => b.type === 'reasoningBlock')))
  assert.equal(out[1].content[0].text, 'sure') // plain text survives
  assert.deepEqual(pendingToolUseIds(fixIncompleteToolCycles(out)), [])
})

test('stripToolBlocksFromTurns keeps text, drops tool blocks + emptied messages', () => {
  const msgs = twoTurns()
  const turns = parseTurns(msgs)
  const out = stripToolBlocksFromTurns(msgs, new Set([0]), turns)
  assert.equal(out.length, 5) // toolResult-only carrier dropped
  assert.ok(!out.some((m) => m.content.some((b) => b.type === 'toolUseBlock' || b.type === 'toolResultBlock')))
  assert.equal(out[0].content[0].text, 'list files') // queries intact
})

test('resolveTurnIndices: csv, ranges, open ends, bad input', () => {
  assert.deepEqual([...resolveTurnIndices(5, '0,2')], [0, 2])
  assert.deepEqual([...resolveTurnIndices(5, undefined, 1, 3)], [1, 2])
  assert.deepEqual([...resolveTurnIndices(5, undefined, 3, undefined)], [3, 4])
  assert.deepEqual([...resolveTurnIndices(5, undefined, undefined, 2)], [0, 1])
  assert.ok('error' in resolveTurnIndices(5, '0,x'))
})

test('summarize + allToolCalls read the block shapes', () => {
  const msgs = twoTurns()
  assert.match(summarize(msgs[1].content), /toolUse:shell/)
  const calls = allToolCalls(msgs)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].hasResult, true)
  assert.equal(calls[0].name, 'shell')
})

// ── tool-level invariants through a fake ToolContext ────────────────────────
const ctx = (messages, selfId = 't-self') => ({ agent: { messages }, toolUse: { toolUseId: selfId } })
const t = makeManageMessagesTool()

test('tool: compact default preserves last 3 turns AND the active turn', async () => {
  // 5 completed turns + active turn
  const messages = []
  for (let i = 0; i < 5; i++) {
    messages.push(user(`q${i}`), M('assistant', [use(`t${i}`)]), M('user', [res(`t${i}`)]), asst(`a${i}`))
  }
  messages.push(user('active q'), M('assistant', [use('t-self', 'manage_messages')]))
  const out = await t.invoke({ action: 'compact' }, ctx(messages))
  assert.match(String(out), /Compacted 2 turn/)
  // turns 0,1 compacted; 2,3,4 keep tool blocks; active turn untouched at tail
  const toolIds = new Set(messages.flatMap((m) => m.content.filter((b) => b.type === 'toolUseBlock').map((b) => b.toolUseId)))
  assert.ok(!toolIds.has('t0') && !toolIds.has('t1') && toolIds.has('t2') && toolIds.has('t-self'))
  assert.deepEqual(pendingToolUseIds(messages), ['t-self']) // only the running call is pending
})

test('tool: clear preserves exactly the active turn', async () => {
  const messages = midExecution()
  const out = await t.invoke({ action: 'clear' }, ctx(messages))
  assert.match(String(out), /preserved active turn/)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content[0].text, 'now compact yourself')
})

test('tool: drop refuses to touch the active turn; repairs cycles in the kept part', async () => {
  const messages = midExecution()
  const out = await t.invoke({ action: 'drop', turns: '1' }, ctx(messages))
  assert.match(String(out), /Dropped 1 turn/)
  // active turn still at tail, turn 0 intact
  assert.equal(activeTurnStart(messages), 4)
  assert.equal(messages[0].content[0].text, 'list files')
  assert.deepEqual(pendingToolUseIds(messages), ['t-self'])
})

test('tool: drop_tools refuses an active tool id', async () => {
  const messages = midExecution()
  const out = await t.invoke({ action: 'drop_tools', tool_ids: 't-self' }, ctx(messages))
  assert.match(String(out), /cannot drop active tool/)
  // by name skips active silently, drops the old one
  const out2 = await t.invoke({ action: 'drop_tools', tool_name: 'shell' }, ctx(messages))
  assert.match(String(out2), /Dropped 1 tool call/)
  assert.deepEqual(pendingToolUseIds(messages), ['t-self'])
})

test('tool: drop_tools removes a reasoning-adjacent call for real (0.13.1 defect repro)', async () => {
  // turn 0: reasoning + toolUse in the SAME assistant message (reasoning model shape)
  const messages = [
    user('do the thing'),
    Message.fromMessageData({
      role: 'assistant',
      content: [{ reasoning: { text: 'plan', signature: 's' } }, { text: 'ok' }, use('t-r', 'dt_valid')],
    }),
    M('user', [res('t-r')]),
    asst('did it'),
    user('active q'),
    M('assistant', [use('t-self', 'manage_messages')]),
  ]
  const out = String(await t.invoke({ action: 'drop_tools', tool_name: 'dt_valid' }, ctx(messages)))
  assert.match(out, /Dropped 1 tool call/)
  assert.doesNotMatch(out, /survived/)
  // the pair is REALLY gone — the old bug resurrected it via synthetic repair
  const names = messages.flatMap((m) => m.content.filter((b) => b.type === 'toolUseBlock').map((b) => b.name))
  assert.ok(!names.includes('dt_valid'))
  assert.deepEqual(pendingToolUseIds(messages), ['t-self'])
})

test('tool: drop_tools after compact still removes the call (loop repro: compact → drop)', async () => {
  const messages = [
    user('q0'),
    Message.fromMessageData({
      role: 'assistant',
      content: [{ reasoning: { text: 'hm', signature: 's' } }, use('t-a', 'dt_valid')],
    }),
    M('user', [res('t-a')]),
    asst('a0'),
    user('q1'), asst('a1'),
    user('active'), M('assistant', [use('t-self', 'manage_messages')]),
  ]
  await t.invoke({ action: 'compact', start: 0, end: 1 }, ctx(messages))
  // compact already stripped the pair; drop_tools must now say so honestly
  const out = String(await t.invoke({ action: 'drop_tools', tool_name: 'dt_valid' }, ctx(messages)))
  assert.match(out, /No droppable tool calls found/)
  const count = messages.flatMap((m) => m.content.filter((b) => b.type === 'toolUseBlock')).length
  assert.equal(count, 1) // only t-self
})

test('tool: export→import round-trips a mid-execution history, repairing + preserving active', async () => {
  const messages = midExecution()
  const path = join(tmpdir(), `mm-test-${Date.now()}.json`)
  const out = await t.invoke({ action: 'export', path }, ctx(messages))
  assert.match(String(out), /Exported 3 turns/)
  assert.ok(Array.isArray(JSON.parse(readFileSync(path, 'utf8'))))
  // import into a FRESH mid-execution conversation
  const live = [user('fresh active q'), M('assistant', [use('t-new', 'manage_messages')])]
  const out2 = await t.invoke({ action: 'import', path }, ctx(live, 't-new'))
  assert.match(String(out2), /repaired 1 incomplete tool cycle/)
  assert.match(String(out2), /preserved active turn/)
  // imported t-self got a synthetic result; live active turn at tail, still pending
  assert.deepEqual(pendingToolUseIds(live), ['t-new'])
  assert.equal(live[live.length - 1].content[0].toolUseId, 't-new')
  assert.equal(live[live.length - 2].content[0].text, 'fresh active q')
})

test('tool: list marks the active turn; list_tools marks active locks', async () => {
  const messages = midExecution()
  const out = String(await t.invoke({ action: 'list' }, ctx(messages)))
  assert.match(out, /3 turns \(8 messages\)/)
  assert.match(out, /⚡ACTIVE/)
  const tools = String(await t.invoke({ action: 'list_tools' }, ctx(messages)))
  assert.match(tools, /🔒\(active\)/)
  assert.match(tools, /⏳ manage_messages/)
})

test('tool: stats counts blocks and warns on pending', async () => {
  const out = String(await t.invoke({ action: 'stats' }, ctx(midExecution())))
  assert.match(out, /Turns: 3/)
  assert.match(out, /Pending toolUse \(no result\): 1/)
})

test('tool: refuses gracefully without an agent context', async () => {
  const out = String(await t.invoke({ action: 'list' }, undefined))
  assert.match(out, /no live agent history/)
})

// ── 0.13.3 regressions: repair/validator/drop honesty ────────────────────────

test('fixIncompleteToolCycles merges synthetics INTO a partial carrier (no user→user)', () => {
  // assistant fired A+B in parallel; only A's result survived surgery
  const msgs = [
    user('q'),
    M('assistant', [use('A'), use('B')]),
    M('user', [res('A')]),
    asst('done'),
  ]
  const fixed = fixIncompleteToolCycles(msgs)
  assert.deepEqual(pendingToolUseIds(fixed), [])
  assert.equal(fixed.length, 4, 'no extra message inserted')
  const carrier = fixed[2]
  assert.equal(carrier.role, 'user')
  const ids = carrier.content.filter((b) => b.type === 'toolResultBlock').map((b) => b.toolUseId).sort()
  assert.deepEqual(ids, ['A', 'B'], 'B synthetic merged into the real carrier')
  const roles = fixed.map((m) => m.role)
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i - 1], roles[i], 'alternation preserved')
})

test('import accepts the tool\'s own post-surgery export (round-trip)', async () => {
  // drop_tools output: carrier removed → assistant,assistant adjacency
  const surgical = [
    user('q1'),
    asst('working'),
    asst('answer'),
    user('q2'),
    asst('final'),
  ]
  const v = validateStructure(surgical)
  assert.equal(v.ok, true, 'post-surgery shape importable')
  assert.equal(v.warnings.length, 1)
})

test('tool: drop refuses out-of-range turns instead of reporting success', async () => {
  const messages = midExecution() // 2 droppable turns (0,1) + active
  const before = messages.length
  const out = await t.invoke({ action: 'drop', turns: '99' }, ctx(messages))
  assert.match(String(out), /no such turn/)
  assert.equal(messages.length, before, 'history untouched')
  // mixed in/out of range: drops only the real one, counts honestly
  const out2 = await t.invoke({ action: 'drop', turns: '0,99' }, ctx(messages))
  assert.match(String(out2), /Dropped 1 turn/)
})

test('tool: import round-trips its own post-surgery export', async () => {
  const messages = [
    user('q1'), asst('working'), asst('answer'), // drop_tools leftover shape
    user('active'), M('assistant', [use('t-self', 'manage_messages')]),
  ]
  const p = join(tmpdir(), `mm-rt-${Date.now()}.json`)
  await t.invoke({ action: 'export', path: p }, ctx(messages))
  const exported = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(exported.length, 5)
  const fresh = [user('active'), M('assistant', [use('t-self', 'manage_messages')])]
  // import file with only the non-active part (drop trailing active turn copy)
  const fs = await import('node:fs')
  fs.writeFileSync(p, JSON.stringify(exported.slice(0, 3)))
  const out = await t.invoke({ action: 'import', path: p }, ctx(fresh))
  assert.match(String(out), /Imported 1 turns/)
  assert.match(String(out), /same-role/, 'adjacency surfaced as warning, not refusal')
})
