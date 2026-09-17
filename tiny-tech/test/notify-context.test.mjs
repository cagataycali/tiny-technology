/**
 * 🔔 use_notify — what the user can actually READ.
 *
 * Why this file exists: cagatay looked at a real prompt on 2026-08-14 and said
 * "notifications doesn't have context, i just see yes no". He was right. The tool
 * schema only requires `title`, so an agent asking a quick yes/no sent body:'',
 * and osascript rendered a dialog with two buttons and nothing else. Two buttons
 * with no question is not a decision, it is a guess.
 *
 * Separate from notify.test.mjs on purpose: a background loop of mine is editing
 * that file right now, and a test file is cheaper to merge than a conflict.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { dialogBody, provenanceLine, makeNotifyTool, registerNotifyBackend, unregisterNotifyBackend } =
  await import('../dist/agent/notify.js')

/** Capture the NotifyRequest the tool builds, without opening a real dialog. */
async function requestFor(input) {
  let seen
  const SPY = '__ctx-spy__'
  registerNotifyBackend({ name: SPY, priority: 999, available: () => true, send: async (req) => { seen = req; return { shown: true, backend: SPY, answer: 'Yes' } } })
  try { await makeNotifyTool()._callback(input) } finally { unregisterNotifyBackend(SPY) }
  return seen
}

test('a confirm with no body still asks a legible question', async () => {
  const req = await requestFor({ title: 'Restart the daemon?', kind: 'confirm' })
  assert.equal(req.body, '', 'the agent really did send an empty body')
  const shown = dialogBody(req)
  assert.match(shown, /Restart the daemon\?/, 'the title carries the question when body is empty')
  assert.ok(shown.trim().length > 0, 'never an empty dialog body')
})

test('body wins over title when the agent sends one', async () => {
  const req = await requestFor({ title: 'Heads up', body: 'Delete 3 stale sockets?', kind: 'confirm' })
  const shown = dialogBody(req)
  assert.match(shown, /Delete 3 stale sockets\?/)
  assert.ok(!shown.startsWith('Heads up'), 'the body leads, not the headline')
})

test('context rows are rendered as label: value lines', async () => {
  const req = await requestFor({ title: 'Push?', body: 'Push 4 commits to main?', kind: 'confirm', context: { branch: 'main', commits: '4' } })
  const shown = dialogBody(req)
  assert.match(shown, /branch: main/)
  assert.match(shown, /commits: 4/)
})

test('every dialog says WHO is asking', async () => {
  const req = await requestFor({ title: 'Anything?', kind: 'confirm' })
  assert.match(dialogBody(req), /— tiny on \S+/, 'provenance line present')
})

test('a background loop names itself, so the user knows it was not the terminal', async () => {
  const prev = process.env.TINY_LOOP_ID
  process.env.TINY_LOOP_ID = 'l20260814050529003'
  try {
    assert.match(provenanceLine(), /background loop l20260814050529003/)
  } finally {
    if (prev === undefined) delete process.env.TINY_LOOP_ID
    else process.env.TINY_LOOP_ID = prev
  }
})

test('provenance does not leak a fully qualified hostname', async () => {
  const prev = process.env.TINY_DEVICE_NAME
  delete process.env.TINY_DEVICE_NAME
  try {
    assert.ok(!provenanceLine().includes('.local'), 'the .local suffix is noise in a dialog')
  } finally { if (prev !== undefined) process.env.TINY_DEVICE_NAME = prev }
})
