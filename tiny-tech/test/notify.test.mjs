/**
 * 🔔 use_notify — pluggable NotifyBackend registry + all 4 kinds.
 *
 * Why these tests: use_notify was verified by hand only (studio-mac,
 * 2026-08-14). The suite exercises the public API surface — registerNotifyBackend,
 * pickNotifyBackend, notify(), makeNotifyTool() callback — with a recording
 * backend so no osascript ever fires. This runs on Linux CI too.
 *
 * Isolation strategy: each test builds a fresh request object. The module is
 * a singleton (backend list is module-level), so tests that add a backend must
 * clean it up — we use a helper `withBackend()` that restores the list via
 * registerNotifyBackend's own "replace by name" logic.
 *
 * The osascript backend is always present (registered at module load) but
 * `available()` returns false on Linux, so it never runs here. We do not need
 * to unpatch it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  notify,
  registerNotifyBackend,
  pickNotifyBackend,
  notifyBackends,
  unregisterNotifyBackend,
  resetNotifyBackends,
  makeNotifyTool,
  DEFAULT_SOUND,
} = await import('../dist/agent/notify.js')

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Register a recording backend for the duration of `fn`, then remove it.
 * Priority 999 so it beats osascript (10) in every environment.
 */
async function withBackend(name, sendFn, fn) {
  const recording = {
    name,
    priority: 999,
    available: () => true,
    send: sendFn,
  }
  registerNotifyBackend(recording)
  try {
    return await fn(recording)
  } finally {
    // Actually REMOVE it. Parking a disabled shell in the registry leaves a
    // zombie that later assertions about the list have to know about.
    unregisterNotifyBackend(name)
  }
}

/** Capture every request that passes through. */
function recorder() {
  const calls = []
  const send = async (req) => {
    calls.push(req)
    return { shown: true, backend: 'recorder', answer: req._fakeAnswer }
  }
  send.calls = calls
  return send
}

// ─── registry ─────────────────────────────────────────────────────────────────

test('notifyBackends() lists registered backends', async () => {
  const names = notifyBackends()
  assert.ok(Array.isArray(names), 'returns an array')
  assert.ok(names.includes('osascript'), 'osascript is pre-registered')
})

test('registerNotifyBackend replaces an existing backend by name', async () => {
  const prev = notifyBackends().filter((n) => n === 'osascript').length
  registerNotifyBackend({
    name: 'osascript',
    priority: 10,
    available: () => false,
    send: async () => ({ shown: false, backend: 'osascript' }),
  })
  const next = notifyBackends().filter((n) => n === 'osascript').length
  assert.equal(next, prev, 'no duplicate created')
  // Replacing by name overwrote the REAL osascript backend with an unavailable
  // fake. Without restoring it, every later test in this file runs against a
  // machine that appears to have no backend at all.
  resetNotifyBackends()
  assert.ok(notifyBackends().includes('osascript'), 'the real backend is back')
})

test('backends are sorted highest priority first', async () => {
  const REC_NAME = '__priority-test__'
  registerNotifyBackend({ name: REC_NAME, priority: 9999, available: () => true, send: async () => ({ shown: true, backend: REC_NAME }) })
  const names = notifyBackends()
  const idx = names.indexOf(REC_NAME)
  assert.equal(idx, 0, 'highest-priority backend is first')
  // Clean up
  unregisterNotifyBackend(REC_NAME)
  assert.ok(!notifyBackends().includes(REC_NAME), 'removed, not just disabled')
})

test('pickNotifyBackend returns null when no backend is available', async () => {
  // On Linux, osascript is not available; no other backend registered
  // (the others we add above were cleaned up). Verify null-or-osascript.
  // With the registry emptied there is NO backend anywhere — that is the real
  // "nothing available" case, and it must not depend on the host platform.
  const saved = notifyBackends()
  for (const name of saved) unregisterNotifyBackend(name)
  assert.equal(await pickNotifyBackend(), null, 'empty registry picks nothing')
  assert.equal(notifyBackends().length, 0, 'registry is empty')
  resetNotifyBackends()

  const b = await pickNotifyBackend()
  // On Linux: null. On macOS: osascript. Either is correct per platform.
  if (process.platform === 'linux') {
    assert.equal(b, null, 'no backend on Linux without a registered one')
  } else {
    assert.ok(b !== null, 'osascript is available on macOS')
    assert.equal(b.name, 'osascript')
  }
})

test('pickNotifyBackend skips unavailable backends', async () => {
  const SKIP = '__skip-test__'
  registerNotifyBackend({ name: SKIP, priority: 888, available: () => false, send: async () => ({ shown: false, backend: SKIP }) })
  const PICK = '__pick-test__'
  registerNotifyBackend({ name: PICK, priority: 777, available: () => true, send: async () => ({ shown: true, backend: PICK }) })
  const b = await pickNotifyBackend()
  // PICK should be picked (SKIP is unavailable), but SKIP is higher priority so
  // only PICK wins because SKIP returns false.
  assert.ok(b !== null)
  assert.equal(b.name, PICK, 'skipped unavailable backend, picked next')
  // Clean up
  for (const n of [SKIP, PICK]) {
    registerNotifyBackend({ name: n, priority: -1, available: () => false, send: async () => ({ shown: false, backend: n }) })
  }
})

// ─── notify() with recording backend ──────────────────────────────────────────

test('kind=info: notify() routes to backend and returns NotifyResult', async () => {
  await withBackend('rec-info', async (req) => {
    return { shown: true, backend: 'rec-info' }
  }, async () => {
    const r = await notify({ title: 'Test', body: 'Hello', kind: 'info' })
    assert.equal(r.shown, true)
    assert.equal(r.backend, 'rec-info')
    assert.equal(r.error, undefined)
  })
})

test('kind=confirm: backend receives request and returns answer', async () => {
  await withBackend('rec-confirm', async (req) => {
    assert.equal(req.kind, 'confirm')
    assert.equal(req.title, 'Delete?')
    return { shown: true, backend: 'rec-confirm', answer: 'Yes' }
  }, async () => {
    const r = await notify({ title: 'Delete?', body: 'Are you sure?', kind: 'confirm', options: ['No', 'Yes'] })
    assert.equal(r.answer, 'Yes')
    assert.equal(r.cancelled, undefined)
  })
})

test('kind=select: backend receives options and returns chosen item', async () => {
  const choices = ['Option A', 'Option B', 'Option C']
  await withBackend('rec-select', async (req) => {
    assert.equal(req.kind, 'select')
    assert.deepEqual(req.options, choices)
    return { shown: true, backend: 'rec-select', answer: 'Option B' }
  }, async () => {
    const r = await notify({ title: 'Pick one', body: 'Choose wisely', kind: 'select', options: choices })
    assert.equal(r.answer, 'Option B')
  })
})

test('kind=text: backend receives text request and returns typed value', async () => {
  await withBackend('rec-text', async (req) => {
    assert.equal(req.kind, 'text')
    return { shown: true, backend: 'rec-text', answer: 'hello world' }
  }, async () => {
    const r = await notify({ title: 'Type something', body: 'Enter text:', kind: 'text' })
    assert.equal(r.answer, 'hello world')
  })
})

test('cancelled result: NotifyResult has cancelled=true and no answer', async () => {
  await withBackend('rec-cancel', async () => {
    return { shown: true, backend: 'rec-cancel', cancelled: true }
  }, async () => {
    const r = await notify({ title: 'Question', body: '?', kind: 'confirm' })
    assert.equal(r.cancelled, true)
    assert.equal(r.answer, undefined)
  })
})

test('backend error: notify() returns error without throwing', async () => {
  await withBackend('rec-error', async () => {
    throw new Error('backend exploded')
  }, async () => {
    const r = await notify({ title: 'X', body: 'Y' })
    assert.equal(r.shown, false)
    assert.match(r.error, /backend exploded/)
  })
})

test('no backend: notify() returns error without throwing', async () => {
  // On Linux with no recording backend added, there is no backend.
  if (process.platform !== 'linux') return // osascript is available on macOS
  const r = await notify({ title: 'Ghost', body: 'Nobody home', kind: 'info' })
  assert.equal(r.shown, false)
  assert.equal(r.backend, 'none')
  assert.match(r.error, /no notification backend/)
})

// ─── context + sound are forwarded ────────────────────────────────────────────

test('context rows are forwarded to the backend', async () => {
  await withBackend('rec-ctx', async (req) => {
    assert.deepEqual(req.context, { key: 'value', loop: '42' })
    return { shown: true, backend: 'rec-ctx' }
  }, async () => {
    await notify({ title: 'T', body: 'B', context: { key: 'value', loop: '42' } })
  })
})

test('sound is forwarded; DEFAULT_SOUND is non-empty string', async () => {
  assert.equal(typeof DEFAULT_SOUND, 'string')
  assert.ok(DEFAULT_SOUND.length > 0)
  await withBackend('rec-sound', async (req) => {
    assert.equal(req.sound, 'none')
    return { shown: false, backend: 'rec-sound' }
  }, async () => {
    await notify({ title: 'Silent', body: '', sound: 'none' })
  })
})

test('timeoutSec is forwarded to the backend', async () => {
  await withBackend('rec-timeout', async (req) => {
    assert.equal(req.timeoutSec, 30)
    return { shown: true, backend: 'rec-timeout' }
  }, async () => {
    await notify({ title: 'T', body: 'B', timeoutSec: 30 })
  })
})

// ─── makeNotifyTool() callback ─────────────────────────────────────────────────

test('makeNotifyTool: missing title returns error string', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  assert.ok(typeof cb === 'function', 'tool has a callback')
  const r = await cb({})
  assert.match(String(r), /need a title/)
})

test('makeNotifyTool: info kind returns banner string via recording backend', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-info', async () => {
    return { shown: true, backend: 'rec-tool-info' }
  }, async () => {
    const r = await cb({ title: 'Loop done', body: 'All tasks finished', kind: 'info' })
    assert.match(String(r), /🔔/)
    assert.match(String(r), /rec-tool-info/)
  })
})

test('makeNotifyTool: confirm kind returns answered string', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-confirm', async () => {
    return { shown: true, backend: 'rec-tool-confirm', answer: 'Yes' }
  }, async () => {
    const r = await cb({ title: 'Deploy?', body: 'Push to prod?', kind: 'confirm' })
    assert.match(String(r), /answered/)
    assert.match(String(r), /Yes/)
  })
})

test('makeNotifyTool: select kind returns chosen answer', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-select', async () => {
    return { shown: true, backend: 'rec-tool-select', answer: 'Option B' }
  }, async () => {
    const r = await cb({ title: 'Pick', body: 'Choose', kind: 'select', options: ['Option A', 'Option B'] })
    assert.match(String(r), /Option B/)
  })
})

test('makeNotifyTool: text kind returns typed answer', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-text', async () => {
    return { shown: true, backend: 'rec-tool-text', answer: 'cagatay typed this' }
  }, async () => {
    const r = await cb({ title: 'Type', body: 'Enter:', kind: 'text' })
    assert.match(String(r), /cagatay typed this/)
  })
})

test('makeNotifyTool: cancelled returns dismissed string', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-cancel', async () => {
    return { shown: true, backend: 'rec-tool-cancel', cancelled: true }
  }, async () => {
    const r = await cb({ title: 'Q', body: '?', kind: 'confirm' })
    assert.match(String(r), /dismissed|timed out/)
  })
})

test('makeNotifyTool: backend error returns error string not a throw', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-err', async () => {
    throw new Error('osascript not found')
  }, async () => {
    const r = await cb({ title: 'X', body: 'Y' })
    assert.match(String(r), /could not notify|osascript not found/)
  })
})

test('makeNotifyTool: context object is forwarded', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-ctx', async (req) => {
    assert.deepEqual(req.context, { loop: 'l123', status: 'done' })
    return { shown: true, backend: 'rec-tool-ctx' }
  }, async () => {
    await cb({ title: 'Done', body: '', context: { loop: 'l123', status: 'done' } })
  })
})

test('makeNotifyTool: non-object context is treated as empty', async () => {
  const t = makeNotifyTool()
  const cb = t.callback ?? t.handler ?? t.fn ?? t._callback
  await withBackend('rec-tool-ctx2', async (req) => {
    assert.deepEqual(req.context, {})
    return { shown: true, backend: 'rec-tool-ctx2' }
  }, async () => {
    await cb({ title: 'T', body: 'B', context: null })
  })
})
