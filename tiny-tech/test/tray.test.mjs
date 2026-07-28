/**
 * 🎛 Tray control socket — the daemon's local IPC surface.
 *
 * The daemon is headless, so this socket is the only way a menu-bar helper (or a
 * curious user) can see what it's doing. Four things have to hold, and each one
 * is a bug that shipped somewhere else first:
 *
 *  1. A reply ALWAYS comes back. A tray that gets silence cannot tell a crashed
 *     daemon from a slow one, so bad JSON, an unknown command and a dep that
 *     throws all have to answer `{ok:false}` on a still-usable connection.
 *  2. Binding is not destructive. A crash leaves an inode behind and `listen()`
 *     then EADDRINUSEs forever — but blind-unlinking lets a second daemon steal
 *     the socket from a first one that is happily serving it. Probe, don't guess.
 *  3. The FILESYSTEM is the whole authentication story (Node has no portable
 *     SO_PEERCRED), so the socket must actually be 0600 and the path must not be
 *     silently truncated past sun_path's 104 bytes into somewhere else.
 *  4. Framing survives content. A task result is arbitrary text full of
 *     newlines; if that can be read as two replies the protocol desynchronizes.
 *
 * Real sockets in a real temp dir — every one of those is a property of the OS,
 * not of a mock.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'

const home = mkdtempSync(join(tmpdir(), 'tt-tray-'))
process.env.TINY_HOME = home
delete process.env.TINY_TRAY_SOCK
after(() => rmSync(home, { recursive: true, force: true }))

const {
  TRAY_PROTOCOL, TRAY_LINE_MAX, TRAY_TEXT_MAX, TRAY_MAX_CONNS, SOCKET_PATH_MAX, TRAY_COMMANDS,
  traySocketPath, socketPathError, handleTrayCommand, probeSocket, startTrayServer,
  trayRequest, formatTrayReply,
} = await import('../dist/tray.js')

let seq = 0
const freshPath = () => join(home, `s${seq++}.sock`)

/** Everything a fully capable daemon offers, so a test can knock pieces out. */
const fullDeps = (over = {}) => ({
  status: () => ({ peers: 2, relay: true, senses: ['screenshot'], tools: { loaded: 3, failed: 0 } }),
  tasks: () => [{ id: 't1', status: 'running', prompt: 'hello', startedAt: 1 }],
  taskResult: (id) => (id === 't1' ? { status: 'done', result: 'the answer' } : null),
  startTask: (prompt) => ({ id: `task-${prompt.length}` }),
  cancelTask: (id) => `stopped watching ${id}`,
  logs: (lines) => `last ${lines} lines`,
  reloadTools: () => '2 local tools',
  shareFile: (path, note) => `sharing ${path}${note ? ` (${note})` : ''}`,
  ...over,
})

// ── the command layer (no socket needed) ─────────────────────────────────────

test('every command answers, and the reply carries the protocol version', async () => {
  const deps = fullDeps()
  for (const cmd of TRAY_COMMANDS) {
    const r = await handleTrayCommand({ cmd, id: 't1', prompt: 'why', lines: 5, path: '/tmp/shot.png' }, deps)
    assert.equal(r.ok, true, `${cmd} should succeed: ${r.error}`)
    // The helper is a separate binary installed once and forgotten — it reads
    // this on every reply to decide whether it can render at all.
    assert.equal(r.protocol, TRAY_PROTOCOL)
  }
})

test('ping is the handshake: pid + the command list', async () => {
  const r = await handleTrayCommand({ cmd: 'ping' }, fullDeps())
  assert.equal(r.pid, process.pid)
  assert.deepEqual(r.commands, [...TRAY_COMMANDS])
})

test('no cmd, unknown cmd and non-object requests all fail with a sentence', async () => {
  const deps = fullDeps()
  for (const raw of [{}, { cmd: '  ' }, null, 'hello', 42]) {
    const r = await handleTrayCommand(raw, deps)
    assert.equal(r.ok, false)
    assert.match(String(r.error), /need a cmd/)
  }
  const unknown = await handleTrayCommand({ cmd: 'selfdestruct' }, deps)
  assert.equal(unknown.ok, false)
  // Named, not ignored: a NEWER helper must be able to tell "this daemon is old"
  // from "I sent nonsense", and the command list is how it does that.
  assert.match(String(unknown.error), /unknown cmd/)
  assert.deepEqual(unknown.commands, [...TRAY_COMMANDS])
  assert.equal(unknown.unavailable, undefined)
})

test('a command the daemon knows but cannot serve says unavailable, not unknown', async () => {
  // A daemon with no local model has no task runner. The tray must GREY THE ITEM
  // OUT — telling the user to upgrade tiny-tech would be a lie.
  const bare = { status: () => ({}) }
  for (const cmd of ['tasks', 'result', 'ask', 'cancel', 'logs', 'reload', 'share']) {
    const r = await handleTrayCommand({ cmd, id: 't1', prompt: 'x', path: '/tmp/x.png' }, bare)
    assert.equal(r.ok, false)
    assert.equal(r.unavailable, true, `${cmd} should be unavailable`)
    assert.doesNotMatch(String(r.error), /unknown/)
  }
})

test('a dep that throws becomes a reply, never an exception', async () => {
  // handleTrayCommand is called from a socket handler; a throw there would kill
  // the connection and the tray would see the silence, not the reason.
  const r = await handleTrayCommand({ cmd: 'status' }, {
    status: () => { throw new Error('device file corrupt') },
  })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /status failed: device file corrupt/)
})

test('id/prompt-taking commands refuse politely when the argument is missing', async () => {
  const deps = fullDeps()
  assert.match(String((await handleTrayCommand({ cmd: 'share' }, deps)).error), /need path/)
  assert.match(String((await handleTrayCommand({ cmd: 'result' }, deps)).error), /need id/)
  assert.match(String((await handleTrayCommand({ cmd: 'cancel' }, deps)).error), /need id/)
  assert.match(String((await handleTrayCommand({ cmd: 'ask', prompt: '   ' }, deps)).error), /need prompt/)
  assert.match(String((await handleTrayCommand({ cmd: 'result', id: 'nope' }, deps)).error), /no such task/)
})

test('ask starts a BACKGROUND task and returns its id', async () => {
  // Never an inline turn: the caller is a UI thread painting a menu, so a
  // ten-minute agent turn on this socket would freeze the menu bar for ten
  // minutes. Going through the runner also gives the answer a disk record and
  // next-turn news, so it reaches the user's chat and not just the tray.
  let awaited = false
  const r = await handleTrayCommand({ cmd: 'ask', prompt: 'what did I miss?' }, fullDeps({
    startTask: (p) => { awaited = true; return { id: 'bg-1' } },
  }))
  assert.equal(r.ok, true)
  assert.equal(r.id, 'bg-1')
  assert.equal(awaited, true)
  // A runner that refuses (at its cap, say) surfaces its own words.
  const capped = await handleTrayCommand({ cmd: 'ask', prompt: 'x' }, fullDeps({
    startTask: () => ({ error: 'already 3 tasks running' }),
  }))
  assert.equal(capped.ok, false)
  assert.match(String(capped.error), /already 3 tasks running/)
})

test('logs clamps the line count at BOTH ends and defaults sanely', async () => {
  const seen = []
  const deps = fullDeps({ logs: (n) => { seen.push(n); return 'x' } })
  const ask = async (lines) => (await handleTrayCommand({ cmd: 'logs', lines }, deps)).lines
  assert.equal(await ask(undefined), 80)
  assert.equal(await ask('nonsense'), 80)
  assert.equal(await ask(0), 1)          // 0 lines is a request for nothing
  assert.equal(await ask(-5), 1)
  assert.equal(await ask(1e9), 500)      // an unbounded read of a growing log
  assert.equal(await ask(12.7), 12)      // no fractional line counts reach the dep
  assert.deepEqual(seen, [80, 80, 1, 1, 500, 12])
})

test('a task result reports its state under `state`, never `status`', async () => {
  // `status` at the top level already means the status OBJECT. Reusing it for a
  // task's string state decodes fine in JS and fails in Swift, where the
  // helper's reply is one Codable struct — so the type is pinned by a test.
  const r = await handleTrayCommand({ cmd: 'result', id: 't1' }, fullDeps())
  assert.equal(r.state, 'done')
  assert.equal(r.result, 'the answer')
  assert.equal(r.status, undefined)
  const status = await handleTrayCommand({ cmd: 'status' }, fullDeps())
  assert.equal(typeof status.status, 'object')
})

test('long text is clamped AND announces it', async () => {
  // A silent truncation upstream of another silent truncation is how "the file
  // was empty" gets reported to a user.
  const long = 'x'.repeat(TRAY_TEXT_MAX + 5_000)
  const r = await handleTrayCommand({ cmd: 'result', id: 't1' }, fullDeps({
    taskResult: () => ({ status: 'done', result: long }),
  }))
  assert.equal(r.ok, true)
  assert.ok(r.result.length < long.length)
  assert.match(r.result, /truncated at 20000 chars/)
  const logs = await handleTrayCommand({ cmd: 'logs' }, fullDeps({ logs: () => long }))
  assert.match(logs.text, /truncated at 20000 chars/)
})

// ── the socket path ─────────────────────────────────────────────────────────

test('the socket path is inside TINY_HOME and TINY_TRAY_SOCK overrides it', () => {
  assert.equal(traySocketPath(), join(home, 'tray.sock'))
  process.env.TINY_TRAY_SOCK = '/tmp/elsewhere.sock'
  try {
    assert.equal(traySocketPath(), '/tmp/elsewhere.sock')
  } finally {
    delete process.env.TINY_TRAY_SOCK
  }
})

test('an over-long path is refused, not silently truncated', () => {
  // sun_path is 104 bytes on macOS / 108 on Linux and the OS TRUNCATES rather
  // than failing: a long TINY_HOME would bind (and connect to) a path other
  // than the one printed in the log.
  assert.equal(socketPathError('/tmp/a.sock'), null)
  assert.equal(socketPathError('/' + 'a'.repeat(SOCKET_PATH_MAX - 1)), null)
  const tooLong = '/' + 'a'.repeat(SOCKET_PATH_MAX)
  const err = socketPathError(tooLong)
  assert.match(String(err), /over the 103-byte OS limit/)
  assert.match(String(err), /TINY_TRAY_SOCK/)   // actionable, not just a refusal
  assert.match(String(socketPathError('')), /empty socket path/)
})

test('startTrayServer reports the path problem and returns null instead of throwing', async () => {
  const msgs = []
  const s = await startTrayServer({
    path: '/' + 'a'.repeat(SOCKET_PATH_MAX + 20),
    deps: fullDeps(),
    onError: (m) => msgs.push(m),
  })
  // The daemon's job is mesh + relay + heartbeat; losing the menu bar must not
  // cost the user any of those.
  assert.equal(s, null)
  assert.equal(msgs.length, 1)
})

// ── probe / bind / rebind ───────────────────────────────────────────────────

test('probeSocket tells absent from live from dead', async () => {
  const path = freshPath()
  assert.equal(await probeSocket(path), 'absent')

  // A leftover inode from a crashed daemon: the file exists, nobody listens.
  writeFileSync(path, '')
  assert.equal(await probeSocket(path), 'dead')
  rmSync(path)

  const srv = createServer(() => { })
  await new Promise((r) => srv.listen(path, r))
  assert.equal(await probeSocket(path), 'live')
  await new Promise((r) => srv.close(r))
  rmSync(path, { force: true })
})

test('a live socket is never stolen; a dead one is reclaimed', async () => {
  const path = freshPath()
  const first = await startTrayServer({ path, deps: fullDeps() })
  assert.ok(first, 'first daemon should bind')

  const msgs = []
  const second = await startTrayServer({ path, deps: fullDeps(), onError: (m) => msgs.push(m) })
  // Blind-unlinking here would hand the tray to whichever daemon won the race,
  // while the first one kept serving a socket nobody could reach.
  assert.equal(second, null)
  assert.match(msgs.join(' '), /already served by another/)

  first.close()
  assert.equal(existsSync(path), false, 'close() removes our own inode')

  // Now simulate the crash case: an inode with no listener behind it.
  writeFileSync(path, '')
  const third = await startTrayServer({ path, deps: fullDeps() })
  assert.ok(third, 'a stale socket must not lock the daemon out forever')
  third.close()
})

test('close() is idempotent and survives a path that is already gone', async () => {
  // The daemon's shutdown runs on both SIGINT and SIGTERM, and launchd sends
  // TERM then KILL — so close() gets called twice in the ordinary case. It also
  // has to tolerate the socket having been deleted underneath it (a user
  // cleaning out ~/.tiny) without taking the daemon's exit path down with it.
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  s.close()
  assert.equal(existsSync(path), false)
  s.close()
  rmSync(path, { force: true })
})

test('the socket cannot outlive the process, even when close() never runs', async () => {
  // The bug this pins: the daemon's SIGTERM handler is NOT a reliable place to
  // unlink, because TinyAgent.init() registers its own handler that calls
  // process.exit(0) — whichever was registered first wins and the other never
  // runs. A leaked inode makes the next daemon probe-and-reclaim, and a tray
  // reports a dead socket as a missing daemon. So the unlink hangs off `exit`.
  const path = join(home, 'child.sock')
  const script = join(home, 'child.mjs')
  writeFileSync(script, `
    const { startTrayServer } = await import(${JSON.stringify(new URL('../dist/tray.js', import.meta.url).href)})
    await startTrayServer({ path: ${JSON.stringify(path)}, deps: { status: () => ({}) } })
    process.on('SIGTERM', () => process.exit(0))   // exits WITHOUT calling close()
    process.send('ready')
    setInterval(() => {}, 1000)
  `)
  const { fork } = await import('node:child_process')
  const proc = fork(script, { stdio: 'ignore' })
  await new Promise((r) => proc.once('message', r))
  assert.equal(existsSync(path), true, 'child should have bound the socket')
  proc.kill('SIGTERM')
  await new Promise((r) => proc.once('exit', r))
  assert.equal(existsSync(path), false, 'a signal exit must still remove the socket')
})

test('the socket is 0600 — file permissions ARE the authentication', async () => {
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  try {
    // Nothing in this protocol proves who is on the other end, and `ask` runs a
    // full agent turn with the user's account and integration keys. Anything
    // group- or world-writable here is a local privilege escalation.
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally { s.close() }
})

// ── end-to-end over a real socket ───────────────────────────────────────────

test('trayRequest round-trips against a real server', async () => {
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  try {
    const ping = await trayRequest({ cmd: 'ping' }, { path })
    assert.equal(ping.ok, true)
    assert.equal(ping.protocol, TRAY_PROTOCOL)

    const status = await trayRequest({ cmd: 'status' }, { path })
    assert.equal(status.status.peers, 2)

    const ask = await trayRequest({ cmd: 'ask', prompt: 'four' }, { path })
    assert.equal(ask.id, 'task-4')

    const bad = await trayRequest({ cmd: 'nope' }, { path })
    assert.equal(bad.ok, false)
  } finally { s.close() }
})

test('a result full of newlines stays exactly ONE reply', async () => {
  // The framing test that matters: task results are arbitrary agent text, and
  // JSON.stringify escaping every newline is the only reason a 40-line answer
  // cannot be read as 40 replies.
  const path = freshPath()
  const body = 'line one\nline two\n\nline four\n'
  const s = await startTrayServer({ path, deps: fullDeps({ taskResult: () => ({ status: 'done', result: body }) }) })
  try {
    const raw = await rawExchange(path, JSON.stringify({ cmd: 'result', id: 't1' }) + '\n')
    assert.equal(raw.split('\n').filter(Boolean).length, 1, `expected one line, got: ${JSON.stringify(raw)}`)
    assert.equal(JSON.parse(raw).result, body)
  } finally { s.close() }
})

test('one connection serves many commands in order', async () => {
  // A tray holds ONE connection and polls on it; a per-command connection would
  // burn through the conn cap in seconds.
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  try {
    const out = await rawExchange(path,
      JSON.stringify({ cmd: 'ping' }) + '\n' +
      JSON.stringify({ cmd: 'status' }) + '\n' +
      JSON.stringify({ cmd: 'tasks' }) + '\n', 3)
    const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(replies.length, 3)
    assert.ok(replies[0].pid)
    assert.ok(replies[1].status)
    assert.equal(replies[2].tasks.length, 1)
  } finally { s.close() }
})

test('malformed JSON is answered and the connection survives it', async () => {
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  try {
    const out = await rawExchange(path, '{not json\n' + JSON.stringify({ cmd: 'ping' }) + '\n', 2)
    const replies = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(replies[0].ok, false)
    assert.match(String(replies[0].error), /malformed JSON/)
    assert.equal(replies[1].ok, true, 'a bad line must not poison the connection')
  } finally { s.close() }
})

test('an over-cap line is refused with a reason before the connection drops', async () => {
  // Past the cap the frame boundary is unfindable, so the connection is
  // unusable — but a tray that just gets hung up on retries in a loop.
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  try {
    const out = await rawExchange(path, JSON.stringify({ cmd: 'ask', prompt: 'z'.repeat(TRAY_LINE_MAX + 100) }))
    const r = JSON.parse(out.split('\n')[0])
    assert.equal(r.ok, false)
    assert.match(String(r.error), /over 65536 bytes/)
  } finally { s.close() }
})

test('past TRAY_MAX_CONNS a client is answered, then hung up on', async () => {
  const path = freshPath()
  const s = await startTrayServer({ path, deps: fullDeps() })
  const held = []
  try {
    for (let i = 0; i < TRAY_MAX_CONNS; i++) {
      held.push(await new Promise((res, rej) => {
        const c = connect(path, () => res(c)); c.on('error', rej)
      }))
    }
    assert.equal(s.connections(), TRAY_MAX_CONNS)
    const out = await rawExchange(path, JSON.stringify({ cmd: 'ping' }) + '\n')
    const r = JSON.parse(out.split('\n')[0])
    assert.equal(r.ok, false)
    assert.match(String(r.error), /too many tray connections/)
  } finally {
    for (const c of held) c.destroy()
    s.close()
  }
})

test('trayRequest fails with a sentence when nothing is listening', async () => {
  const missing = await trayRequest({ cmd: 'ping' }, { path: join(home, 'nope.sock') })
  assert.equal(missing.ok, false)
  // Every caller is a UI that needs words, so this resolves rather than rejects.
  assert.match(String(missing.error), /is the daemon running/)

  const stale = freshPath()
  writeFileSync(stale, '')
  const dead = await trayRequest({ cmd: 'ping' }, { path: stale, timeoutMs: 300 })
  assert.equal(dead.ok, false)
})

test('a daemon that accepts but never answers times out instead of hanging the menu', async () => {
  const { path, stop } = await stubServer(() => { /* accept and say nothing, ever */ })
  try {
    const r = await trayRequest({ cmd: 'ping' }, { path, timeoutMs: 150 })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /did not answer within 150ms/)
  } finally { await stop() }
})

test('a connection closed mid-request reads as a dead daemon, not a hang', async () => {
  const { path, stop } = await stubServer((sock) => sock.destroy())
  try {
    const r = await trayRequest({ cmd: 'ping' }, { path, timeoutMs: 500 })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /closed without a reply|tray socket:/)
  } finally { await stop() }
})

test('a garbage reply is reported as garbage', async () => {
  // Something else bound ~/.tiny/tray.sock. Better to say so than to render a
  // menu out of whatever parsed.
  const { path, stop } = await stubServer((sock) => sock.write('<html>not a tray</html>\n'))
  try {
    const r = await trayRequest({ cmd: 'ping' }, { path, timeoutMs: 500 })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /malformed reply/)
  } finally { await stop() }
})

// ── rendering ───────────────────────────────────────────────────────────────

test('formatTrayReply renders each reply shape for a terminal', () => {
  assert.match(formatTrayReply({ ok: false, protocol: 1, error: 'nope' }), /^✗ nope/)
  const status = formatTrayReply({
    ok: true, protocol: 1,
    status: { device: { name: 'mac', online: true }, peers: 3, relay: true, tasks: { running: 1, finished: 2 }, tools: { loaded: 4, failed: 1 }, senses: ['screenshot'], logPath: '/l.log' },
  })
  assert.match(status, /device:  mac — online/)
  assert.match(status, /peers:   3/)
  assert.match(status, /1 running, 2 finished/)
  assert.match(status, /4 local, 1 failed/)
  assert.match(status, /logs:    \/l\.log/)

  // An unenrolled daemon must not render "undefined" at a human.
  const bare = formatTrayReply({ ok: true, protocol: 1, status: {} })
  assert.match(bare, /device:  \(not enrolled\)/)
  assert.doesNotMatch(bare, /undefined/)

  assert.match(formatTrayReply({ ok: true, protocol: 1, tasks: [] }), /no tasks/)
  assert.match(formatTrayReply({ ok: true, protocol: 1, tasks: [{ id: 'a1', status: 'running', prompt: 'hi' }] }), /a1  running     hi/)
  assert.equal(formatTrayReply({ ok: true, protocol: 1, text: 'log body' }), 'log body')
  assert.match(formatTrayReply({ ok: true, protocol: 1, id: 't1', state: 'done', result: 'r' }), /\[done\]\nr/)
  assert.equal(formatTrayReply({ ok: true, protocol: 1, message: 'reloaded' }), 'reloaded')
  assert.equal(formatTrayReply({ ok: true, protocol: 1, id: 'bg-9' }), 'task bg-9')
  assert.match(formatTrayReply({ ok: true, protocol: 1, pid: 1, commands: ['ping'] }), /tray protocol 1 — ping/)
})

/** A non-tray server on a socket path, for testing what the CLIENT does when the
 * other end misbehaves. It tracks and destroys its connections: `server.close()`
 * only stops accepting, so a stub that leaves a half-open connection behind
 * keeps the test runner's event loop alive and the whole file gets cancelled. */
async function stubServer(onConn) {
  const path = freshPath()
  const live = new Set()
  const srv = createServer((sock) => {
    live.add(sock)
    sock.on('close', () => live.delete(sock))
    sock.on('error', () => { })
    onConn(sock)
  })
  await new Promise((r) => srv.listen(path, r))
  return {
    path,
    stop: async () => {
      for (const s of live) s.destroy()
      await new Promise((r) => srv.close(r))
      rmSync(path, { force: true })
    },
  }
}

/** Write `payload`, collect until `expect` newline-terminated replies arrive (or
 * the server hangs up / 1s passes). Raw on purpose: framing is the thing under
 * test, so the client half can't be the thing measuring it. */
function rawExchange(path, payload, expect = 1) {
  return new Promise((resolve, reject) => {
    let out = ''
    const sock = connect(path)
    const done = () => { try { sock.destroy() } catch { } resolve(out) }
    const timer = setTimeout(done, 1_000)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(payload))
    sock.on('data', (c) => {
      out += c
      if (out.split('\n').filter(Boolean).length >= expect) { clearTimeout(timer); done() }
    })
    sock.on('close', () => { clearTimeout(timer); resolve(out) })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}
