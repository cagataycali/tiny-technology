/**
 * 🔔 The tray PUSH channel — queue semantics.
 *
 * This code shipped in 0.12.0 with no tests at all (it was uncommitted work in
 * progress when the release tarball was cut), so these tests are written against
 * the published behaviour and pin down the parts a menu-bar helper depends on:
 * a bounded queue, delivery that does not repeat itself, and answers that cannot
 * be invented.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrayNotifyQueue, TRAY_NOTIFY_MAX, TRAY_TEXT_MAX, handleTrayCommand, resetTrayNotifications } from '../dist/tray.js'
import { trayBackend, TRAY_FRESH_MS } from '../dist/agent/notify.js'

test('the queue is bounded: the OLDEST goes, and the loss is counted', () => {
  const q = new TrayNotifyQueue(3)
  for (const t of ['a', 'b', 'c', 'd', 'e']) q.enqueue({ title: t, kind: 'info' })
  const d = q.drain()
  assert.deepEqual(d.notifications.map((n) => n.title), ['c', 'd', 'e'], 'the newest survive')
  assert.equal(d.dropped, 2, 'and the tray is told how many it never saw')
})

test('a drop is reported ONCE, not on every poll', () => {
  const q = new TrayNotifyQueue(1)
  q.enqueue({ title: 'lost' }); q.enqueue({ title: 'kept' })
  assert.equal(q.drain().dropped, 1)
  assert.equal(q.drain().dropped, 0, 'the same loss must not be re-reported forever')
})

test('the default cap is a real number, not accidentally zero', () => {
  assert.equal(TRAY_NOTIFY_MAX, 50)
  assert.ok(new TrayNotifyQueue().max ?? true)
})

test('draining marks delivered: a tray never re-renders the same prompt', () => {
  const q = new TrayNotifyQueue()
  q.enqueue({ title: 'once', kind: 'confirm' })
  assert.equal(q.drain().notifications.length, 1)
  assert.equal(q.drain().notifications.length, 0, 'second poll sees nothing new')
})

test('a delivered info card is forgotten; a question stays pending until answered', () => {
  const q = new TrayNotifyQueue()
  q.enqueue({ title: 'fyi', kind: 'info' })
  const asked = q.enqueue({ title: 'well?', kind: 'confirm' })
  const d = q.drain()
  assert.equal(d.notifications.length, 2)
  assert.equal(d.pending, 1, 'only the question is still outstanding')
  assert.equal(q.answer(asked.id, { value: 'Yes' }).ok, true)
  assert.equal(q.drain().pending, 0)
})

test('an answer reaches whoever is waiting on it', async () => {
  const q = new TrayNotifyQueue()
  const item = q.enqueue({ title: 'ship it?', kind: 'confirm' })
  const waiting = q.await(item.id, 5000)
  q.answer(item.id, { value: 'Yes' })
  assert.deepEqual(await waiting, { value: 'Yes' })
})

test('an id nobody raised is refused, and refused differently once it is spent', () => {
  const q = new TrayNotifyQueue()
  const item = q.enqueue({ title: 'x', kind: 'confirm' })
  const never = q.answer('nope', { value: 'Yes' })
  assert.equal(never.ok, false)
  assert.match(never.error, /no such notification/)
  assert.equal(q.answer(item.id, { value: 'Yes' }).ok, true)
  const again = q.answer(item.id, { value: 'Yes' })
  assert.equal(again.ok, false)
  assert.match(again.error, /already answered/, 'a stale menu is a real condition, named as such')
})

test('dismissal is not consent: a cancelled answer carries no value', async () => {
  const q = new TrayNotifyQueue()
  const item = q.enqueue({ title: 'delete everything?', kind: 'confirm' })
  const waiting = q.await(item.id, 5000)
  q.answer(item.id, { cancelled: true, value: 'Yes' })   // caller lies
  const ans = await waiting
  assert.equal(ans.cancelled, true)
  assert.equal(ans.value, undefined, 'a value smuggled alongside cancelled must be dropped')
})

test('waiting has a deadline, and a deadline is not an answer', async () => {
  const q = new TrayNotifyQueue()
  const item = q.enqueue({ title: 'anyone?', kind: 'confirm' })
  assert.equal(await q.await(item.id, 30), null, 'no answer in time resolves null, never a made-up value')
})

test('freshness is what proves someone is WATCHING, not that a socket exists', () => {
  const q = new TrayNotifyQueue()
  assert.equal(q.fresh(10_000), false, 'a queue nobody has ever polled is not fresh')
  q.drain()
  assert.equal(q.fresh(10_000), true)
  assert.equal(q.fresh(10_000, Date.now() + 11_000), false, 'a tray that stopped polling goes stale')
})

test('an overflow drop is a FALL-THROUGH, never a cancellation', async () => {
  // Found by this suite: the queue used to release a dropped question with
  // { cancelled: true }, which tells the asker the user refused. The user never
  // saw it. null is the only honest answer, and it is what sends the question on
  // to a dialog instead of resolving it silently.
  const q = new TrayNotifyQueue(1)
  const doomed = q.enqueue({ title: 'first', kind: 'confirm' })
  const waiting = q.await(doomed.id, 5000)
  q.enqueue({ title: 'second', kind: 'confirm' })   // evicts the first
  assert.equal(await waiting, null, 'no answer exists, so no answer is reported')
})

// ── the command layer a menu-bar helper actually speaks ──────────────────────

test('notifications drains and answer posts back, over the command layer', async () => {
  const q = new TrayNotifyQueue()
  const item = q.enqueue({ title: 'from the daemon', kind: 'confirm' })
  const deps = { notifications: q }
  const drained = await handleTrayCommand({ cmd: 'notifications' }, deps)
  assert.equal(drained.ok, true)
  assert.equal(drained.notifications.length, 1)
  assert.equal(drained.notifications[0].title, 'from the daemon')
  assert.equal(drained.pending, 1)
  const posted = await handleTrayCommand({ cmd: 'answer', id: item.id, value: 'Yes' }, deps)
  assert.equal(posted.ok, true)
  assert.equal(posted.accepted, true)
})

test('a stale menu item is refused with a sentence, not an exception', async () => {
  const deps = { notifications: new TrayNotifyQueue() }
  const r = await handleTrayCommand({ cmd: 'answer', id: 'ghost', value: 'Yes' }, deps)
  assert.equal(r.ok, false)
  assert.match(String(r.error), /no such notification/)
  const noId = await handleTrayCommand({ cmd: 'answer', value: 'Yes' }, deps)
  assert.equal(noId.ok, false)
  assert.match(String(noId.error), /need id/)
})

test('typed text coming back from the tray is clamped like everything else', async () => {
  const q = new TrayNotifyQueue()
  const item = q.enqueue({ title: 'name?', kind: 'text' })
  const waiting = q.await(item.id, 5000)
  await handleTrayCommand({ cmd: 'answer', id: item.id, value: 'x'.repeat(TRAY_TEXT_MAX + 5_000) }, { notifications: q })
  const ans = await waiting
  // Clamped, and SAYS SO. Silent truncation is worse than a hard cap: an agent
  // reading a half-sentence cannot tell whether the user stopped talking or the
  // transport ate the rest.
  assert.ok(ans.value.length <= TRAY_TEXT_MAX + 64, `typed text lands in an agent context: ${ans.value.length}`)
  assert.match(ans.value, /truncated at 20000 chars/)
})

test('the tray backend refuses to take a question no tray is watching', async () => {
  // A live socket is not evidence: the daemon serving it may have no menu bar
  // attached, and a question queued there would hang unseen.
  const q = resetTrayNotifications()
  assert.equal(q.fresh(TRAY_FRESH_MS), false)
  assert.equal(await trayBackend.available(), false, 'no drain ⇒ unavailable ⇒ the dialog happens')
})
