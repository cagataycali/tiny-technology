/**
 * 🌐 use_browse — a real browser over CDP, with no dependencies.
 *
 * What's testable here without launching a browser is everything that decides
 * WHAT gets sent and what the agent is told, plus the two mechanisms that have
 * no safe manual reproduction:
 *
 *  1. **The NUL framing.** The pipe transport is NUL-delimited, not newline —
 *     the detail that silently breaks any client copied from the WebSocket
 *     examples. Every real bug in a stream reader is a chunk-boundary bug, and
 *     none of them (a message split across two reads, three in one read, a
 *     trailing partial, an unparseable frame) can be provoked on demand from a
 *     live browser.
 *  2. **A pending call must never outlive the browser.** If Chrome dies, the
 *     reply never comes, and a promise that never settles hangs the agent's
 *     TURN — which may be a relay envelope with a web agent waiting on it. So
 *     the client is exercised against a fake transport that can be killed.
 *
 * The live browser is covered by a manual end-to-end run (recorded in the
 * cycle's notes), not here: a suite that launches Chrome is a suite that fails
 * on any machine without one.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-browse-'))
process.env.TINY_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const {
  browserCandidates, findBrowser, browserProfileDir, launchArgs,
  isBrowsableUrl, normalizeUrl, makeNulDecoder, CdpClient,
  rectExpression, textExpression, linksExpression, keyDescriptor,
  clampText, formatLinks, runBrowse, refuseBeforeLaunch, makeBrowseTool, browseBlock,
  BROWSE_DESCRIPTION, BROWSE_TEXT_MAX, BROWSE_IDLE_MS, MAX_LINKS,
  __setSessionForTest,
} = await import('../dist/agent/browse.js')

const exists = (...paths) => (p) => paths.includes(p)
const none = () => false

// ── finding a browser ───────────────────────────────────────────────────────

test('an explicit TINY_BROWSER_BIN is EXCLUSIVE, not just first', () => {
  // A user who names a browser has named it. Falling through to Chrome because
  // their path had a typo is how "why is it logged into the wrong account?"
  // happens — the profile and its cookies belong to whichever binary runs.
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const env = { TINY_BROWSER_BIN: '/opt/my-chrome' }
  assert.deepEqual(browserCandidates('darwin', env), ['/opt/my-chrome'])
  assert.equal(findBrowser('darwin', env, exists('/opt/my-chrome')), '/opt/my-chrome')
  // Chrome is installed, the override is not: the answer is null, not Chrome.
  assert.equal(findBrowser('darwin', env, exists(chrome)), null)
})

test('Chrome is preferred, but Chromium/Edge/Brave still yield a browser', () => {
  // CDP is identical across Chromium-based browsers, so a machine without
  // Chrome should get a browser rather than "not supported".
  const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium'
  assert.equal(findBrowser('darwin', {}, exists(chromium)), chromium)
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.equal(findBrowser('darwin', {}, exists(chromium, chrome)), chrome)
})

test('every platform has candidates, and none is found when nothing exists', () => {
  for (const plat of ['darwin', 'linux', 'win32']) {
    assert.ok(browserCandidates(plat, {}).length > 0, plat)
    assert.equal(findBrowser(plat, {}, none), null)
  }
})

test('windows candidates follow the real env vars, not a hardcoded C:', () => {
  const c = browserCandidates('win32', { PROGRAMFILES: 'D:\\Apps', LOCALAPPDATA: 'E:\\local' })
  assert.ok(c.some((p) => p.startsWith('D:\\Apps\\Google')), c.join(' | '))
  assert.ok(c.some((p) => p.startsWith('E:\\local\\Google')), c.join(' | '))
})

// ── the profile: it can NEVER be the user's own ─────────────────────────────

test('the profile lives under TINY_HOME, never the default Chrome profile', () => {
  // Two independent reasons, both verified against real Chrome 150: it refuses
  // remote debugging on the default data dir ("requires a non-default data
  // directory"), and a second instance on an already-open profile dies on the
  // SingletonLock with exit 21. So this is not a preference.
  assert.equal(browserProfileDir({ TINY_HOME: '/tmp/h' }), join('/tmp/h', 'browser'))
  assert.equal(browserProfileDir({ TINY_BROWSER_PROFILE: '/tmp/other' }), '/tmp/other')
  assert.ok(browserProfileDir({}).endsWith(join('.tiny', 'browser')))
})

test('launch args use the PIPE transport and never a debugging PORT', () => {
  // --remote-debugging-port opens an unauthenticated full-control channel on
  // localhost: any process under any account could attach and drive the
  // session. The pipe rides fds 3/4 of our own child, so the parent-child
  // relationship IS the access control. Same judgement as the tray socket.
  const args = launchArgs('/tmp/profile')
  assert.ok(args.includes('--remote-debugging-pipe'))
  assert.ok(!args.some((a) => a.includes('remote-debugging-port')), args.join(' '))
  assert.ok(args.includes('--user-data-dir=/tmp/profile'))
})

test('headless by default; visible drops the headless flag and nothing else', () => {
  assert.ok(launchArgs('/p').includes('--headless=new'))
  const vis = launchArgs('/p', { visible: true })
  assert.ok(!vis.includes('--headless=new'))
  // The visible mode exists so the USER can log in once; it must still be the
  // same profile and the same protocol, or the login wouldn't persist.
  assert.ok(vis.includes('--user-data-dir=/p'))
  assert.ok(vis.includes('--remote-debugging-pipe'))
})

test('a fresh profile cannot be blocked by a first-run dialog', () => {
  const args = launchArgs('/p')
  assert.ok(args.includes('--no-first-run'))
  assert.ok(args.includes('--no-default-browser-check'))
})

// ── URL policy ──────────────────────────────────────────────────────────────

test('http(s) only — file:// and friends are refused, not normalized', () => {
  // A URL can arrive from a relay envelope, i.e. from ANOTHER user's tiny. An
  // unrestricted scheme turns "read this page" into rendering
  // file:///Users/…/.ssh/id_rsa and summarizing it back over the network.
  assert.equal(isBrowsableUrl('https://example.com'), true)
  assert.equal(isBrowsableUrl('http://localhost:3000/x'), true)
  for (const bad of [
    'file:///etc/passwd', 'file://localhost/etc/passwd', 'javascript:alert(1)',
    'data:text/html,<b>x', 'chrome://settings', 'view-source:https://x.com',
    'about:blank', 'ftp://x.com', '', '   ', 'https://', 'https:///nohost',
  ]) {
    assert.equal(isBrowsableUrl(bad), false, bad)
  }
})

test('a URL with a newline is refused (no CDP param smuggling)', () => {
  assert.equal(isBrowsableUrl('https://example.com\nfile:///etc/passwd'), false)
})

test('a bare hostname becomes https, but an explicit scheme is left alone', () => {
  // What a model actually types. Normalizing is friendlier than refusing — and
  // the refusal above still runs on the RESULT, so this cannot launder a scheme.
  assert.equal(normalizeUrl('example.com'), 'https://example.com')
  assert.equal(normalizeUrl('example.com/a?b=c'), 'https://example.com/a?b=c')
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com')
  assert.equal(normalizeUrl('file:///etc/passwd'), 'file:///etc/passwd')
  assert.equal(isBrowsableUrl(normalizeUrl('file:///etc/passwd')), false)
})

// ── NUL framing ─────────────────────────────────────────────────────────────

test('the decoder splits on NUL, not newline', () => {
  // THE detail that breaks a client copied from the WebSocket examples: a JSON
  // message containing an escaped newline is still exactly one message here.
  const got = []
  const feed = makeNulDecoder((m) => got.push(m))
  feed(Buffer.from(JSON.stringify({ id: 1, result: { value: 'a\nb' } }) + '\0'))
  assert.deepEqual(got, [{ id: 1, result: { value: 'a\nb' } }])
})

test('a message split across chunk boundaries is reassembled', () => {
  const got = []
  const feed = makeNulDecoder((m) => got.push(m))
  const line = JSON.stringify({ id: 7, result: { ok: true } }) + '\0'
  for (let i = 0; i < line.length; i++) feed(Buffer.from(line[i]))
  assert.deepEqual(got, [{ id: 7, result: { ok: true } }])
})

test('several messages in ONE chunk all dispatch, in order', () => {
  const got = []
  const feed = makeNulDecoder((m) => got.push(m.id))
  feed(Buffer.from([1, 2, 3].map((id) => JSON.stringify({ id }) + '\0').join('')))
  assert.deepEqual(got, [1, 2, 3])
})

test('a trailing partial message waits instead of being dispatched', () => {
  const got = []
  const feed = makeNulDecoder((m) => got.push(m))
  feed(Buffer.from(JSON.stringify({ id: 1 }) + '\0' + '{"id":2,"res'))
  assert.equal(got.length, 1)
  feed(Buffer.from('ult":{}}\0'))
  assert.equal(got.length, 2)
  assert.equal(got[1].id, 2)
})

test('a multi-byte character split across chunks survives', () => {
  // Buffer concat before decode, not string concat: splitting a UTF-8 sequence
  // mid-character and decoding each half yields replacement chars, which would
  // corrupt page text at exactly a 64KB boundary and nowhere reproducible.
  const got = []
  const feed = makeNulDecoder((m) => got.push(m))
  const buf = Buffer.from(JSON.stringify({ id: 1, result: { t: '→é😀' } }) + '\0')
  feed(buf.subarray(0, 20))
  feed(buf.subarray(20))
  assert.equal(got[0].result.t, '→é😀')
})

test('one unparseable frame does not kill the stream', () => {
  // The remaining bytes are still a valid message sequence; dropping them would
  // strand every pending call on a browser that is actually fine.
  const got = []
  const bad = []
  const feed = makeNulDecoder((m) => got.push(m.id), (line) => bad.push(line))
  feed(Buffer.from('not json\0' + JSON.stringify({ id: 5 }) + '\0'))
  assert.deepEqual(got, [5])
  assert.deepEqual(bad, ['not json'])
})

test('empty frames are skipped, not reported as errors', () => {
  const got = []
  const bad = []
  const feed = makeNulDecoder((m) => got.push(m.id), (l) => bad.push(l))
  feed(Buffer.from('\0\0' + JSON.stringify({ id: 9 }) + '\0'))
  assert.deepEqual(got, [9])
  assert.deepEqual(bad, [])
})

// ── the CDP client ──────────────────────────────────────────────────────────

function fakeTransport() {
  const sent = []
  let onMsg = () => {}
  let onClose = () => {}
  return {
    sent,
    reply: (msg) => onMsg(msg),
    die: (reason) => onClose(reason),
    transport: {
      send: (line) => sent.push(JSON.parse(line)),
      onMessage: (cb) => { onMsg = cb },
      onClose: (cb) => { onClose = cb },
      close: () => { sent.push('__closed__') },
    },
  }
}

test('a call resolves with its own reply, paired by id', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  const p1 = cdp.send('A')
  const p2 = cdp.send('B')
  // Answered out of order on purpose: the whole point of id pairing.
  f.reply({ id: f.sent[1].id, result: { which: 'B' } })
  f.reply({ id: f.sent[0].id, result: { which: 'A' } })
  assert.deepEqual(await p1, { which: 'A' })
  assert.deepEqual(await p2, { which: 'B' })
})

test('a sessionId rides along only when given (flat session mode)', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  cdp.send('Page.enable', {}, 'SESS').catch(() => {})
  cdp.send('Target.getTargets').catch(() => {})
  assert.equal(f.sent[0].sessionId, 'SESS')
  assert.ok(!('sessionId' in f.sent[1]))
  cdp.close()
})

test('a CDP error reply rejects with the protocol message', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  const p = cdp.send('DOM.getBoxModel')
  f.reply({ id: f.sent[0].id, error: { code: -32000, message: 'Could not find node with given id' } })
  await assert.rejects(p, /Could not find node/)
})

test('a browser that DIES rejects every pending call', async () => {
  // The failure that hangs an agent's turn: no reply ever arrives. The turn may
  // be a relay envelope with a web agent waiting on it at 45s.
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  const p1 = cdp.send('A')
  const p2 = cdp.send('B')
  f.die('browser exited (code 21)')
  await assert.rejects(p1, /code 21/)
  await assert.rejects(p2, /code 21/)
  assert.equal(cdp.isClosed, true)
})

test('a call made AFTER the browser died rejects instead of hanging forever', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  f.die('browser pipe closed')
  await assert.rejects(cdp.send('A'), /pipe closed/)
})

test('a call times out with the method named, and stops waiting', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport, 40)
  await assert.rejects(cdp.send('Runtime.evaluate'), /Runtime\.evaluate timed out/)
  // A late reply for a timed-out id must not throw inside the dispatcher.
  f.reply({ id: 1, result: {} })
})

test('a transport write failure rejects that call rather than throwing', async () => {
  const cdp = new CdpClient({
    send: () => { throw new Error('EPIPE') },
    onMessage: () => {}, onClose: () => {}, close: () => {},
  })
  await assert.rejects(cdp.send('A'), /EPIPE/)
})

test('events reach listeners; a throwing listener does not break the stream', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  const seen = []
  cdp.on('Page.loadEventFired', () => { throw new Error('listener bug') })
  cdp.on('Page.loadEventFired', (p) => seen.push(p))
  f.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 } })
  assert.deepEqual(seen, [{ timestamp: 1 }])
})

test('waitFor resolves NULL on timeout — a missing load event is information', async () => {
  // Not an exception: a single-page app fires NO load event for a pushState
  // navigation (verified against real Chrome), so "it didn't fire" must be
  // reportable alongside whatever DID render, not a failed navigation.
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  assert.equal(await cdp.waitFor('Page.loadEventFired', 30), null)
  const p = cdp.waitFor('Page.loadEventFired', 1000)
  f.reply({ method: 'Page.loadEventFired', params: { t: 2 } })
  assert.deepEqual(await p, { t: 2 })
})

// ── page-side expressions ───────────────────────────────────────────────────

test('a selector is JSON-encoded into the expression, never interpolated raw', () => {
  // The selector reaches JavaScript, so a raw quote would end the string and
  // the rest would execute. Model-authored selectors aren't hostile; a selector
  // copied out of page content can be.
  const expr = rectExpression(`a[title='x'] /*"*/`)
  assert.ok(expr.includes(JSON.stringify(`a[title='x'] /*"*/`)))
  assert.ok(!expr.includes(`querySelector(a[title=`))
})

test('the rect expression scrolls the element into view before measuring', () => {
  // An element below the fold has viewport coordinates that are off-screen, so
  // a click at them lands on whatever IS there instead.
  const expr = rectExpression('#x')
  assert.ok(expr.includes('scrollIntoView'))
  assert.ok(expr.includes('getBoundingClientRect'))
  // And it must be able to say "no such element" rather than throwing.
  assert.ok(/if \(!el\) return null/.test(expr))
})

test('page text comes from innerText, not textContent', () => {
  // textContent includes <script> bodies and hidden nodes — that's how "the
  // page text" becomes 40k of minified JS.
  const expr = textExpression(100)
  assert.ok(expr.includes('innerText'))
  assert.ok(!expr.includes('textContent'))
  // Asks for max+1 chars so the caller can tell "exactly max" from "clipped".
  assert.ok(expr.includes('slice(0, 101)'))
})

test('links are deduped, labelled, and javascript: hrefs are dropped', () => {
  const expr = linksExpression(5)
  assert.ok(expr.includes('javascript:'))
  assert.ok(expr.includes('seen.has(href)'))
  assert.ok(expr.includes('out.length >= 5'))
  // Zero-size anchors are skipped: an agent can't click what isn't rendered.
  assert.ok(expr.includes('!r.width && !r.height'))
})

test('keyDescriptor knows the keys that MEAN something, and refuses the rest', () => {
  const enter = keyDescriptor('Enter')
  assert.equal(enter.key, 'Enter')
  assert.equal(enter.windowsVirtualKeyCode, 13)
  // `text` is what makes Enter submit a form rather than just move focus.
  assert.equal(enter.text, '\r')
  assert.equal(keyDescriptor('escape').key, 'Escape')
  assert.equal(keyDescriptor('down').key, 'ArrowDown')
  // An unknown key returns null rather than guessing: a wrong keyCode does
  // NOTHING silently, which reads to the model as "the site ignored Enter".
  assert.equal(keyDescriptor('f13'), null)
  assert.equal(keyDescriptor(''), null)
  assert.equal(keyDescriptor(undefined), null)
})

test('typing goes through insertText, so no key table is needed for text', () => {
  // Layout-independent, handles emoji, one round trip instead of one per char.
  assert.equal(keyDescriptor('a'), null)
  assert.ok(BROWSE_DESCRIPTION.includes('type (text'))
})

// ── output clamps ───────────────────────────────────────────────────────────

test('clamped text SAYS it was clipped', () => {
  // relay-poller clamps a device reply again at 8000 chars: a silent truncation
  // upstream of a silent truncation is how "the page was empty" gets reported.
  const out = clampText('x'.repeat(BROWSE_TEXT_MAX + 50))
  assert.ok(out.includes('[clipped at'))
  assert.equal(clampText('short'), 'short')
  assert.equal(clampText(''), '')
  assert.equal(clampText(null), '')
})

test('exactly-at-the-limit text is NOT reported as clipped', () => {
  const out = clampText('y'.repeat(BROWSE_TEXT_MAX))
  assert.ok(!out.includes('[clipped'))
  assert.equal(out.length, BROWSE_TEXT_MAX)
})

test('formatLinks names the empty case instead of returning nothing', () => {
  assert.equal(formatLinks([]), 'no links on this page')
  assert.equal(formatLinks(null), 'no links on this page')
  assert.equal(formatLinks([{ text: '', href: 'https://x' }]), '- (no label) → https://x')
  assert.equal(
    formatLinks([{ text: 'Docs', href: 'https://x/d' }, { text: 'Blog', href: 'https://x/b' }]),
    '- Docs → https://x/d\n- Blog → https://x/b',
  )
})

// ── the tool surface ────────────────────────────────────────────────────────

test('close and status need NO browser — they never launch one', async () => {
  // A status action that starts a browser to tell you no browser is running is
  // a joke the user pays for in RAM.
  __setSessionForTest(null)
  assert.match(await runBrowse({ action: 'close' }), /no browser was running/)
  const st = await runBrowse({ action: 'status' })
  assert.match(st, /no browser running/)
  assert.match(st, /browser/) // names the profile dir so it's inspectable
})

test('close shuts a live session down and reports it', async () => {
  let killed = false
  const cdp = new CdpClient(fakeTransport().transport)
  __setSessionForTest({
    child: { kill: () => { killed = true } },
    cdp, sessionId: 'S', visible: false, lastUsed: Date.now(),
    reaper: setTimeout(() => {}, 1),
  })
  assert.match(await runBrowse({ action: 'close' }), /browser closed/)
  assert.equal(await runBrowse({ action: 'status' }), `🌐 no browser running (profile: ${browserProfileDir()})`)
  await new Promise((r) => setTimeout(r, 1700))
  // SIGKILL is a backstop after the pipe close, so a reaped session can never
  // leak a process even on a build that ignores the pipe closing.
  assert.equal(killed, true)
})

test('a refused URL never launches a browser', async () => {
  // This test FAILED on the first run and found a real ordering bug: ensure()
  // ran before the scheme check, so a hostile file:// URL spent ~300MB and a
  // Chrome process before being refused — i.e. the refusal itself was a
  // resource-exhaustion primitive. Hence refuseBeforeLaunch().
  __setSessionForTest(null)
  const out = await runBrowse({ action: 'open', url: 'file:///etc/passwd' })
  assert.match(out, /refused/)
  assert.match(await runBrowse({ action: 'status' }), /no browser running/)
})

test('open with no url is a message, not a launch', async () => {
  __setSessionForTest(null)
  assert.equal(await runBrowse({ action: 'open' }), 'need url')
  assert.match(await runBrowse({ action: 'status' }), /no browser running/)
})

test('EVERY no-browser-needed refusal is decided before a launch', async () => {
  // Pinned as a pure function so the ordering can't regress one action at a
  // time: whatever refuseBeforeLaunch answers, runBrowse must answer identically
  // with no session at all.
  __setSessionForTest(null)
  const cases = [
    { action: 'open' },
    { action: 'goto', url: 'javascript:alert(1)' },
    { action: 'type' },
    { action: 'key' },
    { action: 'key', key: 'f13' },
    { action: 'eval' },
    { action: 'click' },
  ]
  for (const c of cases) {
    const expected = refuseBeforeLaunch(c)
    assert.ok(expected, `${c.action} should be refusable without a browser`)
    assert.equal(await runBrowse(c), expected, JSON.stringify(c))
    assert.match(await runBrowse({ action: 'status' }), /no browser running/, JSON.stringify(c))
  }
})

test('refuseBeforeLaunch passes through the calls that DO need a browser', () => {
  // The complement matters as much: a refusal list that swallows a valid call
  // would make the tool silently useless.
  for (const ok of [
    { action: 'open', url: 'example.com' },
    { action: 'goto', url: 'https://x.com' },
    { action: 'text' }, { action: 'links' }, { action: 'html' },
    { action: 'screenshot' }, { action: 'scroll' }, { action: 'back' },
    { action: 'type', text: '' },            // empty string is a real clear
    { action: 'key', key: 'enter' },
    { action: 'click', selector: '#a' },
    { action: 'click', x: 1, y: 2 },
    { action: 'eval', expression: '1+1' },
  ]) {
    assert.equal(refuseBeforeLaunch(ok), null, JSON.stringify(ok))
  }
})

test('a dead browser is discarded, and the failure is a STRING not a throw', async () => {
  // A browser can die under us at any time (crash, OOM, the user quitting a
  // visible window). Two things must hold: the next action does not throw — a
  // thrown tool aborts the agent's turn, so a crashed browser would cost the
  // whole conversation — and a closed session is discarded rather than reused
  // forever, so the following call gets a fresh one.
  //
  // TINY_BROWSER_BIN is pointed at nothing for the duration, which makes the
  // relaunch fail deterministically on ANY machine. Nothing in this suite may
  // actually launch Chrome: it would be 300MB per run, and the profile it writes
  // races the temp-dir cleanup (this test found that the hard way).
  const realBin = process.env.TINY_BROWSER_BIN
  process.env.TINY_BROWSER_BIN = join(home, 'no-such-browser')
  try {
    const f = fakeTransport()
    const cdp = new CdpClient(f.transport)
    f.die('browser exited (code 21)')
    __setSessionForTest({
      child: { kill: () => {} }, cdp, sessionId: 'S', visible: false,
      lastUsed: Date.now(), reaper: setTimeout(() => {}, 1),
    })
    const out = await runBrowse({ action: 'text' })
    assert.equal(typeof out, 'string')
    // isClosed → shutdown → relaunch attempt → the honest install message,
    // naming the override so a user with a browser elsewhere knows what to set.
    assert.match(out, /no Chrome\/Chromium\/Edge found/)
    assert.match(out, /TINY_BROWSER_BIN/)
    // And the dead session is gone rather than lingering as a live-looking one.
    assert.match(await runBrowse({ action: 'status' }), /no browser running/)
  } finally {
    if (realBin == null) delete process.env.TINY_BROWSER_BIN
    else process.env.TINY_BROWSER_BIN = realBin
    __setSessionForTest(null)
  }
})

test('unknown actions and unknown keys are named, not silently ignored', async () => {
  const f = fakeTransport()
  const cdp = new CdpClient(f.transport)
  __setSessionForTest({
    child: { kill: () => {} }, cdp, sessionId: 'S', visible: false,
    lastUsed: Date.now(), reaper: setTimeout(() => {}, 1),
  })
  assert.match(await runBrowse({ action: 'teleport' }), /unknown action: teleport/)
  assert.match(await runBrowse({ action: 'key', key: 'f13' }), /unknown key: f13/)
  assert.match(await runBrowse({ action: 'key' }), /need key/)
  assert.match(await runBrowse({ action: 'type' }), /need text/)
  assert.match(await runBrowse({ action: 'eval' }), /need expression/)
  assert.match(await runBrowse({ action: 'click' }), /need selector, or x \+ y/)
  __setSessionForTest(null)
})

test('the tool registers as use_browse with the actions in its description', () => {
  const t = makeBrowseTool()
  assert.equal(t.name, 'use_browse')
  for (const action of ['open', 'text', 'links', 'screenshot', 'click', 'type', 'key', 'eval', 'close']) {
    assert.ok(BROWSE_DESCRIPTION.includes(action), `description never mentions ${action}`)
  }
})

test('the description teaches the LOGIN path, because it is not discoverable', () => {
  // The profile is ours, so it starts logged into nothing. Without this the
  // agent reports "this page needs a login" as a dead end, when one visible
  // launch by the user fixes it permanently.
  assert.match(BROWSE_DESCRIPTION, /visible:true/)
  assert.match(BROWSE_DESCRIPTION, /logins survive/i)
})

test('the description says the browser self-closes, so the agent need not fear leaks', () => {
  assert.match(BROWSE_DESCRIPTION, /idle/)
  assert.ok(BROWSE_IDLE_MS >= 60_000, 'too short to survive a multi-step read→click→read')
  assert.ok(BROWSE_IDLE_MS <= 15 * 60_000, 'a forgotten browser should not outlive the conversation')
})

test('the prompt block steers AWAY from httpRequest on JS pages', () => {
  // The mistake this exists to prevent doesn't error: httpRequest on a SPA
  // returns an empty shell, which the model then reports as an empty page.
  const b = browseBlock()
  assert.match(b, /use_browse/)
  assert.match(b, /httpRequest/)
  assert.match(b, /empty/)
})

test('use_browse registers when a browser exists, and is absent when none does', async () => {
  // A tool that exists and always answers "no browser" is worse than an absent
  // one: the model plans around a capability the machine doesn't have.
  const { makeDeviceTools } = await import('../dist/agent/device-tools.js')
  const { hasBrowser } = await import('../dist/agent/browse.js')
  const { labels } = makeDeviceTools()
  assert.equal(labels.includes('browse'), hasBrowser())
})

test('the daemon carries the browser env vars (launchd reads no shell profile)', async () => {
  const { __envFileContentForTest } = await import('../dist/daemon.js')
  if (typeof __envFileContentForTest !== 'function') return // not exported on this build
  const content = __envFileContentForTest({ TINY_BROWSER_BIN: '/opt/chrome' })
  assert.match(content, /TINY_BROWSER_BIN/)
})

test('MAX_LINKS is a page-navigation budget, not a sitemap dump', () => {
  assert.ok(MAX_LINKS > 10 && MAX_LINKS <= 200, String(MAX_LINKS))
})
