/**
 * 🖥️ use_desktop — the daemon's senses at the machine it runs on, plus the
 * capability declaration that finally tells the cloud what this machine can do.
 *
 * Nothing here touches the real desktop: the platform matrix is built from pure
 * {bin, args} descriptions, and the tool's exec is swapped for a recorder. A
 * test suite that fires real notifications or overwrites the developer's
 * clipboard is a bug in the suite.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tiny-desktop-'))
process.env.TINY_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const {
  copyCommand, pasteCommand, notifyCommand, openCommand,
  appleScriptString, appleScriptNotify, isOpenableTarget,
  hasDesktopSenses, desktopSenses, desktopSenseBlock,
  makeDesktopTool, runDesktop, DESKTOP_DESCRIPTION, __setRunnerForTest,
  NOTIFY_TITLE_MAX, NOTIFY_BODY_MAX, CLIPBOARD_READ_MAX,
} = await import('../dist/agent/desktop.js')

const { buildCapabilities, setDeviceCapabilities, deviceCapabilities, CLI_CAPABILITIES } =
  await import('../dist/device.js')

const all = () => true
const none = () => false
const only = (...bins) => (b) => bins.includes(b)

// ── clipboard: the backend follows the DISPLAY SERVER, not the distro ────────

test('macOS clipboard is pbcopy/pbpaste', () => {
  assert.deepEqual(copyCommand('darwin', {}, none), { bin: 'pbcopy', args: [] })
  assert.deepEqual(pasteCommand('darwin', {}, none), { bin: 'pbpaste', args: [] })
})

test('a Wayland session uses wl-clipboard even when xclip is installed', () => {
  // The load-bearing case: xclip present under Wayland would copy into an X
  // selection nothing on that desktop reads — a silent no-op, the worst outcome.
  const env = { WAYLAND_DISPLAY: 'wayland-0' }
  assert.equal(copyCommand('linux', env, all).bin, 'wl-copy')
  assert.equal(pasteCommand('linux', env, all).bin, 'wl-paste')
})

test('Wayland without wl-clipboard installed falls back to X tools', () => {
  const env = { WAYLAND_DISPLAY: 'wayland-0' }
  assert.equal(copyCommand('linux', env, only('xclip')).bin, 'xclip')
  assert.equal(copyCommand('linux', env, only('xsel')).bin, 'xsel')
})

test('X11 prefers xclip, then xsel, then nothing at all', () => {
  assert.equal(copyCommand('linux', {}, only('xclip', 'xsel')).bin, 'xclip')
  assert.equal(copyCommand('linux', {}, only('xsel')).bin, 'xsel')
  assert.equal(copyCommand('linux', {}, none), null)
  assert.equal(pasteCommand('linux', {}, none), null)
})

test('xclip/xsel read and write the CLIPBOARD selection, not PRIMARY', () => {
  // Default selection is PRIMARY (mouse highlight) — the user's ⌘V/Ctrl+V
  // buffer is `clipboard`, so omitting the flag copies somewhere they'll never
  // paste from.
  assert.deepEqual(copyCommand('linux', {}, only('xclip')).args, ['-selection', 'clipboard'])
  assert.deepEqual(pasteCommand('linux', {}, only('xclip')).args, ['-selection', 'clipboard', '-o'])
  assert.deepEqual(copyCommand('linux', {}, only('xsel')).args, ['--clipboard', '--input'])
  assert.deepEqual(pasteCommand('linux', {}, only('xsel')).args, ['--clipboard', '--output'])
})

test('Windows writes with clip and reads with PowerShell Get-Clipboard', () => {
  assert.equal(copyCommand('win32', {}, none).bin, 'clip')
  const cmd = pasteCommand('win32', {}, none)
  assert.equal(cmd.bin, 'powershell')
  // -Raw is the load-bearing flag: without it Get-Clipboard emits an ARRAY and
  // the console formatter wraps long lines, so the text comes back with breaks
  // the user never copied. -NoProfile keeps a profile's banner out of stdout.
  assert.deepEqual(cmd.args, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'])
})

test('the Windows read side is NOT gated on a PATH probe', () => {
  // realHas asks `command -v`, which does not exist in cmd.exe — every probe on
  // Windows answers "no". Gating the one interpreter that ships in-box on a
  // probe that can't work there is how a working sense reports itself missing.
  assert.ok(pasteCommand('win32', {}, none), 'must resolve with no binaries found')
  assert.ok(pasteCommand('win32', { WAYLAND_DISPLAY: 'wayland-0' }, none), 'env must not matter on win32')
})

test('Windows paste does not shell out — the command is pure argv', () => {
  // One `-Command` string we wrote ourselves, no caller text in it: nothing the
  // clipboard contains can ever be re-parsed as PowerShell.
  const { args } = pasteCommand('win32', {}, none)
  assert.equal(args.filter((a) => a === '-Command').length, 1)
  assert.ok(!args.some((a) => /[&|;`$]/.test(a)), 'no shell metacharacters in argv')
})

// ── notify: AppleScript quoting is a real injection surface ──────────────────

test('appleScriptString escapes quotes and backslashes, collapses newlines', () => {
  // A raw newline inside an AppleScript literal is a SYNTAX ERROR, not a
  // two-line notification — the whole notify silently fails.
  assert.equal(appleScriptString('say "hi"'), 'say \\"hi\\"')
  assert.equal(appleScriptString('a\\b'), 'a\\\\b')
  assert.equal(appleScriptString('one\ntwo\tthree'), 'one two three')
  assert.equal(appleScriptString('crlf\r\nend'), 'crlf end')
})

test('a quote-carrying body cannot break out of the AppleScript literal', () => {
  const evil = 'done" \n do shell script "rm -rf ~" \n display notification "'
  const script = appleScriptNotify({ title: 't', body: evil })
  assert.ok(!script.includes('do shell script "rm'), 'unescaped quote let the body become script')
  assert.ok(script.startsWith('display notification "'))
  assert.ok(script.includes('with title "t"'))
})

test('notify clamps title and body to the worker push limits', () => {
  const cmd = notifyCommand({ title: 'T'.repeat(500), body: 'B'.repeat(900) }, 'darwin', none)
  const script = cmd.args[1]
  assert.ok(script.includes('T'.repeat(NOTIFY_TITLE_MAX)))
  assert.ok(!script.includes('T'.repeat(NOTIFY_TITLE_MAX + 1)))
  assert.ok(script.includes('B'.repeat(NOTIFY_BODY_MAX)))
  assert.ok(!script.includes('B'.repeat(NOTIFY_BODY_MAX + 1)))
})

test('sound is opt-in — a silent notification stays silent', () => {
  assert.ok(!notifyCommand({ title: 't', body: 'b' }, 'darwin', none).args[1].includes('sound name'))
  assert.ok(notifyCommand({ title: 't', body: 'b', sound: 'Ping' }, 'darwin', none).args[1].includes('sound name "Ping"'))
})

test('linux notify-send takes ARGS, never a shell string', () => {
  const cmd = notifyCommand({ title: 'build', body: 'ok; rm -rf ~' }, 'linux', only('notify-send'))
  assert.equal(cmd.bin, 'notify-send')
  // The dangerous text is one argv entry — it can never be re-parsed as a command.
  assert.ok(cmd.args.includes('ok; rm -rf ~'))
  assert.deepEqual(cmd.args, ['-a', 'tiny', 'build', 'ok; rm -rf ~'])
  assert.equal(notifyCommand({ title: 't', body: 'b' }, 'linux', none), null)
})

// ── open: the scheme is a capability boundary ────────────────────────────────

test('open accepts https URLs and absolute-ish paths', () => {
  for (const t of ['https://tiny.technology', 'http://localhost:3000', '/tmp/x.png', './rel.txt', '~/notes.md']) {
    assert.equal(isOpenableTarget(t), true, t)
  }
})

test('open REFUSES exotic schemes — "open this link" must not mean "run this"', () => {
  // file:// and app-registered handlers are how a launcher becomes an executor;
  // an embedded newline is how one target becomes two.
  for (const t of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://host/share', 'vscode://x', 'data:text/html,<b>', '', '   ', 'https://ok\nsecond']) {
    assert.equal(isOpenableTarget(t), false, t)
  }
  // A bare relative name is ambiguous (file? search term?) — not openable.
  assert.equal(isOpenableTarget('notes.md'), false)
})

test('openCommand per platform, and no opener is reported honestly', () => {
  assert.deepEqual(openCommand('https://x', 'darwin', none), { bin: 'open', args: ['https://x'] })
  assert.equal(openCommand('https://x', 'linux', only('xdg-open')).bin, 'xdg-open')
  assert.equal(openCommand('https://x', 'linux', none), null)
  // Windows `start` needs the empty-title argument or a quoted URL becomes the title.
  assert.deepEqual(openCommand('https://x', 'win32', none).args, ['/c', 'start', '', 'https://x'])
})

// ── registration gate ───────────────────────────────────────────────────────

test('the tool registers only where a sense actually resolves', () => {
  assert.equal(hasDesktopSenses('darwin', {}, none), true)
  assert.equal(hasDesktopSenses('linux', {}, only('xclip')), true)
  assert.equal(hasDesktopSenses('linux', {}, only('notify-send')), true)
  // A headless box with nothing installed: better no tool than a tool that
  // always answers "no backend" — the model plans around what it's offered.
  assert.equal(hasDesktopSenses('linux', {}, none), false)
})

test('desktopSenses names the senses that resolved', () => {
  // The 4th arg is the PATH probe for the voice halves (say / osascript) — the
  // clipboard/notify probe is `command -v` and the voice one is a file check,
  // because both voice binaries ship in-box (see speech.ts). Passing noVoice
  // here keeps this test about the four original senses; speech.test.mjs owns
  // the voice matrix.
  // ⚠️ That same PATH probe now also answers for `see` (/usr/bin/sips), which is
  //    probed by path for exactly the reason `say` is: it ships in-box, so
  //    `command -v` is the wrong question. So a blanket `() => true` posits sips
  //    as well and reports sight — the lines below that aren't about sight say
  //    which binaries they posit rather than answering yes to everything.
  //    see.test.mjs owns the sight matrix.
  const noVoice = () => false
  const noSips = (p) => p !== '/usr/bin/sips'
  // ⚠️ `see` is now UNCONDITIONAL — showing an already-showable file needs no
  //    binary at all (see.ts measureHeader), so it appears on every platform and
  //    `convert` is the word that tracks sips. Which is why it is in every list
  //    below, including the Windows and Linux ones.
  assert.deepEqual(desktopSenses('darwin', {}, none, noVoice), ['notify', 'copy', 'paste', 'open', 'see'])
  assert.deepEqual(desktopSenses('darwin', {}, none, () => true), ['notify', 'copy', 'paste', 'open', 'speak', 'listen', 'see', 'convert'])
  // …EXCEPT where nothing else resolved: hasDesktopSenses refuses to register
  // use_desktop on that machine, and a sense with no tool behind it is the same
  // defect as a label with no tool behind it. Empty stays empty.
  assert.deepEqual(desktopSenses('linux', {}, none, noSips), [])
  assert.deepEqual(desktopSenses('linux', {}, only('xclip'), noVoice), ['copy', 'paste', 'see'])
  // Windows now has the read side too; notify is still absent (no in-box
  // notifier we can drive without a toast module), and that asymmetry is
  // exactly why the prompt gets the list rather than assuming a platform.
  assert.deepEqual(desktopSenses('win32', {}, none, noSips), ['copy', 'paste', 'open', 'see'])
})

test('the prompt block tells the agent what it can and CANNOT do here', () => {
  // Announcing the senses is the point: otherwise the agent finds out by calling
  // and being told "no backend", and the failure that matters is a daemon that
  // promises to notify on a machine with no notifier.
  const mac = desktopSenseBlock(desktopSenses('darwin', {}, none, () => false))
  assert.match(mac, /notify, copy, paste, open/)
  assert.match(mac, /You CAN reach the person/)

  const win = desktopSenseBlock(desktopSenses('win32', {}, none, () => true))
  assert.match(win, /copy, paste, open/)
  assert.ok(!/You CAN reach the person/.test(win), 'must not claim notify on Windows')
  assert.match(win, /cannot notify/)

  // Degenerate case: the block is only built where the tool registered, but if
  // it ever is built empty it must still read as a limitation, not as a list.
  assert.match(desktopSenseBlock([]), /none/)
  assert.match(desktopSenseBlock([]), /cannot notify/)
})

// ── the tool callback, against a recorded runner ─────────────────────────────

function withRunner(fn) {
  const calls = []
  __setRunnerForTest((cmd, input) => {
    calls.push({ cmd, input })
    return typeof fn === 'function' ? fn(cmd, input) : (fn ?? '')
  })
  return calls
}
after(() => __setRunnerForTest(null))

const call = (args) => runDesktop(args)

test('the tool is named use_desktop and teaches the four actions', () => {
  assert.equal(makeDesktopTool().name, 'use_desktop')
  for (const a of ['notify', 'copy', 'paste', 'open']) {
    assert.ok(DESKTOP_DESCRIPTION.includes(a), `description must teach ${a}`)
  }
})

test('notify runs one command and confirms what the human saw', async () => {
  const calls = withRunner('')
  const out = await call({ action: 'notify', title: 'build', body: 'green in 42s' })
  assert.equal(calls.length, 1)
  assert.match(out, /🔔 notified: build/)
  assert.match(out, /green in 42s/)
})

test('notify with neither title nor body is refused, not sent empty', async () => {
  const calls = withRunner('')
  assert.match(await call({ action: 'notify' }), /need title or body/)
  assert.equal(calls.length, 0)
})

test('copy passes the text as STDIN, never as an argument', async () => {
  // Text on the command line leaks into the process table and blows the ARG_MAX
  // limit on anything sizable; pbcopy/xclip/wl-copy all read stdin.
  const calls = withRunner('')
  const out = await call({ action: 'copy', text: 'x'.repeat(5000) })
  assert.equal(calls[0].input.length, 5000)
  assert.deepEqual(calls[0].cmd.args.join(' ').includes('xxxx'), false)
  assert.match(out, /copied 5000 chars/)
})

test('copy of an empty string is a real clear; a MISSING text is a mistake', async () => {
  const calls = withRunner('')
  assert.match(await call({ action: 'copy', text: '' }), /copied 0 chars/)
  assert.equal(calls.length, 1)
  assert.match(await call({ action: 'copy' }), /need text/)
  assert.equal(calls.length, 1) // no second run
})

test('paste returns the clipboard and reports an empty one distinctly', async () => {
  withRunner(() => 'ssh-rsa AAAA...')
  assert.match(await call({ action: 'paste' }), /ssh-rsa AAAA/)
  withRunner(() => '')
  assert.match(await call({ action: 'paste' }), /clipboard is empty/)
})

test('one trailing newline is dropped — a PowerShell CRLF is not "content"', async () => {
  // Get-Clipboard terminates its output with CRLF, so an EMPTY Windows clipboard
  // arrives as "\r\n". Without the trim that reads as 2 chars of clipboard and
  // the agent reports content where there is none.
  withRunner(() => '\r\n')
  assert.match(await call({ action: 'paste' }), /clipboard is empty/)
  withRunner(() => 'ssh-rsa AAAA\r\n')
  const out = await call({ action: 'paste' })
  assert.match(out, /12 chars/)
  assert.ok(out.endsWith('ssh-rsa AAAA'), 'the trailing break must not survive')
  // Only ONE break, and only at the END: a genuinely multi-line clipboard keeps
  // its interior newlines and its blank last line minus the terminator.
  withRunner(() => 'a\nb\n\n')
  assert.match(await call({ action: 'paste' }), /a\nb\n$/)
})

test('a huge clipboard is clamped AND says it was clamped', async () => {
  // The reply travels back through relay-poller's 8000-char clamp; being cut
  // there is silent, being cut here is announced.
  withRunner(() => 'y'.repeat(50_000))
  const out = await call({ action: 'paste' })
  assert.ok(out.length < 50_000)
  assert.match(out, /50000 chars/)
  assert.match(out, new RegExp(`showing first ${CLIPBOARD_READ_MAX}`))
})

test('open refuses a bad target BEFORE it reaches the OS launcher', async () => {
  const calls = withRunner('')
  assert.match(await call({ action: 'open', target: 'javascript:alert(1)' }), /refused/)
  assert.equal(calls.length, 0, 'a refused target must never be executed')
  assert.match(await call({ action: 'open' }), /need target/)
  assert.match(await call({ action: 'open', target: 'https://tiny.technology' }), /🚀 opened/)
  assert.equal(calls.length, 1)
})

test('a failing backend degrades to a message, never a thrown tool', async () => {
  // A tool that throws aborts the agent's turn; a tool that reports lets it adapt.
  __setRunnerForTest(() => { const e = new Error('boom'); e.stderr = 'not permitted'; throw e })
  const out = await call({ action: 'notify', title: 't', body: 'b' })
  assert.match(out, /desktop error/)
  assert.match(out, /not permitted/)
  __setRunnerForTest(null)
})

test('an unknown action is named, not silently ignored', async () => {
  withRunner('')
  assert.match(await call({ action: 'levitate' }), /unknown action: levitate/)
})

// ── capability declaration: what the CLOUD is told this machine can do ───────

test('capabilities are the base pair plus the tools that really registered', () => {
  assert.deepEqual(buildCapabilities([]), ['mcp', 'files'])
  assert.deepEqual(buildCapabilities(['apple', 'computer', 'desktop']),
    ['mcp', 'files', 'apple', 'computer', 'desktop'])
})

test('declaration is deduped, lowercased, trimmed', () => {
  assert.deepEqual(buildCapabilities(['Apple', ' apple ', 'files', 'mcp']), ['mcp', 'files', 'apple'])
})

test('the clamp drops the TAIL, never the base capabilities', () => {
  // The worker sanitizes to 32 entries × 32 chars; overshooting there is silent
  // truncation, so `mcp`/`files` must be at the front where they survive.
  const many = Array.from({ length: 60 }, (_, i) => `tool${i}`)
  const caps = buildCapabilities(many)
  assert.equal(caps.length, 32)
  assert.deepEqual(caps.slice(0, 2), ['mcp', 'files'])
  assert.equal(buildCapabilities(['x'.repeat(99)])[2].length, 32)
})

test('setDeviceCapabilities is what heartbeats declare — live, not enroll-time', () => {
  // A Flipper plugged in (or `tiny-tech connect spotify`) must reach /devices at
  // the next 30s beat; the old code hardcoded CLI_CAPABILITIES forever.
  setDeviceCapabilities(['computer', 'desktop'])
  assert.deepEqual(deviceCapabilities(), ['mcp', 'files', 'computer', 'desktop'])
  setDeviceCapabilities([])
  assert.deepEqual(deviceCapabilities(), CLI_CAPABILITIES)
})

test('garbage from a caller degrades to the base pair, never throws', () => {
  setDeviceCapabilities(null)
  assert.deepEqual(deviceCapabilities(), ['mcp', 'files'])
  assert.deepEqual(buildCapabilities([null, undefined, '', '   ']), ['mcp', 'files'])
  setDeviceCapabilities([])
})
