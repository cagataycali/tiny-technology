/**
 * Daemon tests — unit/plist/env generation, no launchctl/systemctl calls.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { daemonPaths, installDaemon } from '../dist/daemon.js'

test('daemon: paths match the platform', () => {
  const p = daemonPaths()
  if (process.platform === 'darwin') {
    assert.strictEqual(p.kind, 'launchd')
    assert.match(p.unitPath, /LaunchAgents\/technology\.tiny\.daemon\.plist$/)
  } else {
    assert.strictEqual(p.kind, 'systemd')
    assert.match(p.unitPath, /systemd\/user\/tiny-tech\.service$/)
  }
  assert.match(p.envPath, /daemon\.env$/)
  assert.match(p.logPath, /daemon\.log$/)
})

test('daemon: show (dry-run) writes nothing, renders unit + wrapper + env', () => {
  const out = installDaemon({ dryRun: true })
  // unit content
  if (process.platform === 'darwin') {
    assert.match(out, /RunAtLoad/)
    assert.match(out, /KeepAlive/)
    assert.match(out, /technology\.tiny\.daemon/)
  } else {
    assert.match(out, /Restart=always/)
    assert.match(out, /WantedBy=default\.target/)
  }
  // wrapper execs the mesh node with THIS node binary
  assert.match(out, /exec ".*node.*" ".*cli\.js" mesh/)
  // env sourced with set -a
  assert.match(out, /set -a/)
})

test('daemon: integration + display env survives the install capture', () => {
  // launchd/systemd read NO shell profile, so anything the user exported by hand
  // is gone the moment the work moves into the daemon — the tool simply stops
  // registering, with nothing in the log saying why. DISPLAY/WAYLAND_DISPLAY
  // pick the Linux clipboard backend; DBUS is what notify-send speaks over.
  const vars = {
    TELEGRAM_BOT_TOKEN: 'bot-token-value',
    SPOTIFY_CLIENT_ID: 'spotify-id-value',
    GOOGLE_OAUTH_CLIENT_ID: 'google-id-value',
    WACLI_BINARY: '/usr/local/bin/wacli',
    WAYLAND_DISPLAY: 'wayland-0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  }
  Object.assign(process.env, vars)
  try {
    const out = installDaemon({ dryRun: true })
    for (const k of Object.keys(vars)) assert.match(out, new RegExp(`^${k}=`, 'm'), `${k} dropped from the daemon env`)
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k]
  }
})

test('daemon: dry-run masks env secrets', () => {
  process.env.OPENAI_API_KEY = 'sk-supersecretvalue123'
  try {
    const out = installDaemon({ dryRun: true })
    assert.ok(!out.includes('sk-supersecretvalue123'), 'secret leaked into dry-run output')
    assert.match(out, /OPENAI_API_KEY=sk-s\*\*\*/)
  } finally {
    delete process.env.OPENAI_API_KEY
  }
})
