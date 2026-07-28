/**
 * tiny-tech daemon — persistence via launchd (macOS) / systemd (Linux).
 * Direct port of devduck's `service` tool semantics.
 *
 *   tiny-tech daemon install     write unit/plist + start (boot-persistent)
 *   tiny-tech daemon status      running? + unit paths
 *   tiny-tech daemon logs        tail the daemon log
 *   tiny-tech daemon restart     kickstart / restart
 *   tiny-tech daemon uninstall   stop + remove files
 *   tiny-tech daemon show        dry-run: print what install would write
 *
 * The daemon process = `tiny-tech mesh` (headless zenoh node answering
 * peer commands) + device heartbeat (loadDevice → presence on /devices).
 * User-level only (LaunchAgent / systemd --user) — no sudo required.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const NAME = 'tiny-tech'
const LABEL = 'technology.tiny.daemon'

export interface DaemonPaths {
  kind: 'launchd' | 'systemd'
  unitPath: string
  logPath: string
  envPath: string
  wrapperPath: string
}

function home(): string { return homedir() }
function tinyDir(): string { return process.env.TINY_HOME || join(home(), '.tiny') }

export function daemonPaths(): DaemonPaths {
  const logPath = join(tinyDir(), 'daemon.log')
  const envPath = join(tinyDir(), 'daemon.env')
  const wrapperPath = join(tinyDir(), 'daemon-wrapper.sh')
  if (platform() === 'darwin') {
    return { kind: 'launchd', unitPath: join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`), logPath, envPath, wrapperPath }
  }
  return { kind: 'systemd', unitPath: join(home(), '.config', 'systemd', 'user', `${NAME}.service`), logPath, envPath, wrapperPath }
}

/** Resolve the entrypoint: the installed dist/cli.js run by THIS node */
function entrypoint(): { node: string; cli: string } {
  return { node: process.execPath, cli: new URL('./cli.js', import.meta.url).pathname }
}

/** Env vars the daemon needs — captured at install time (launchd/systemd have no shell profile) */
function envFileContent(extraEnv: Record<string, string> = {}): string {
  const keep = [
    'TINY_API_URL', 'TINY_HOME', 'TINY_TOKEN', 'TINY_MESH', 'TINY_TOOLS_DIR',
    'TINY_BROWSER_BIN', 'TINY_BROWSER_PROFILE',
    'TINY_MODEL_PROVIDER', 'TINY_MODEL_API_KEY', 'TINY_MODEL_ID', 'TINY_MODEL_BASE_URL',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_PROFILE',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'BEDROCK_MODEL_ID', 'BEDROCK_REGION',
    'ZENOH_CONNECT', 'ZENOH_LISTEN',
    // Integration keys. `tiny-tech connect` also stores these in
    // ~/.tiny/integrations.json (applyStoredEnv re-hydrates them at agent
    // start), but a user who exported them in their shell instead never went
    // through the wizard — and launchd/systemd read no shell profile, so those
    // tools would silently vanish the moment the work moved into the daemon.
    'GOOGLE_OAUTH_CLIENT', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_SCOPES',
    'GOOGLE_IMPERSONATE_SUBJECT',
    'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI', 'SPOTIPY_CACHE_PATH',
    'TELEGRAM_BOT_TOKEN', 'WACLI_BINARY', 'WACLI_STORE', 'WACLI_STORE_DIR',
    // A GUI-less launchd session can't reach the desktop notification/clipboard
    // daemons without these — DISPLAY/WAYLAND_DISPLAY pick the Linux clipboard
    // backend, DBUS_SESSION_BUS_ADDRESS is what notify-send speaks over.
    'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  ]
  const lines: string[] = ['# tiny-tech daemon environment (captured at install; edit + restart to change)']
  for (const k of keep) {
    const v = extraEnv[k] ?? process.env[k]
    if (v) lines.push(`${k}=${v}`)
  }
  return lines.join('\n') + '\n'
}

function wrapperContent(p: DaemonPaths): string {
  const { node, cli } = entrypoint()
  return `#!/bin/bash
# tiny-tech daemon wrapper — sources env, execs the mesh node
set -a
[ -f "${p.envPath}" ] && . "${p.envPath}"
set +a
exec "${node}" "${cli}" mesh
`
}

function plistContent(p: DaemonPaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${p.wrapperPath}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>WorkingDirectory</key>
    <string>${home()}</string>
    <key>StandardOutPath</key>
    <string>${p.logPath}</string>
    <key>StandardErrorPath</key>
    <string>${p.logPath}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`
}

function unitContent(p: DaemonPaths): string {
  return `[Unit]
Description=tiny-tech daemon (tiny.technology mesh node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-${p.envPath}
ExecStart=/bin/bash ${p.wrapperPath}
Restart=always
RestartSec=10
StandardOutput=append:${p.logPath}
StandardError=append:${p.logPath}
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`
}

function launchctl(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

function systemctl(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

function uid(): string {
  try { return execFileSync('id', ['-u'], { encoding: 'utf8' }).trim() } catch { return '501' }
}

export function installDaemon(opts: { dryRun?: boolean } = {}): string {
  const p = daemonPaths()
  const unit = p.kind === 'launchd' ? plistContent(p) : unitContent(p)
  const wrapper = wrapperContent(p)
  const env = envFileContent()

  if (opts.dryRun) {
    return [
      `── ${p.unitPath} ──`, unit,
      `── ${p.wrapperPath} ──`, wrapper,
      `── ${p.envPath} ──`, env.replace(/=(.{4}).+$/gm, '=$1***'),
    ].join('\n')
  }

  mkdirSync(tinyDir(), { recursive: true, mode: 0o700 })
  mkdirSync(join(p.unitPath, '..'), { recursive: true })
  writeFileSync(p.envPath, env, { mode: 0o600 })
  chmodSync(p.envPath, 0o600) // env holds API keys
  writeFileSync(p.wrapperPath, wrapper, { mode: 0o755 })
  writeFileSync(p.unitPath, unit)

  if (p.kind === 'launchd') {
    launchctl('bootout', `gui/${uid()}`, p.unitPath) // idempotent re-install
    const r = launchctl('bootstrap', `gui/${uid()}`, p.unitPath)
    if (!r.ok && !/already/i.test(r.out)) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`)
    launchctl('kickstart', '-k', `gui/${uid()}/${LABEL}`)
  } else {
    systemctl('daemon-reload')
    const r = systemctl('enable', '--now', `${NAME}.service`)
    if (!r.ok) throw new Error(`systemctl enable failed: ${r.out.trim()}`)
  }
  return `installed + started (${p.kind})\n  unit: ${p.unitPath}\n  logs: ${p.logPath}\n  env:  ${p.envPath} (0600)`
}

export function daemonStatus(): string {
  const p = daemonPaths()
  const installed = existsSync(p.unitPath)
  let running = false
  let detail = ''
  if (p.kind === 'launchd') {
    const r = launchctl('print', `gui/${uid()}/${LABEL}`)
    running = r.ok && /state = running/.test(r.out)
    const pid = r.out.match(/pid = (\d+)/)?.[1]
    detail = running ? `pid ${pid}` : (r.ok ? 'loaded, not running' : 'not loaded')
  } else {
    const r = systemctl('is-active', `${NAME}.service`)
    running = r.out.trim() === 'active'
    detail = r.out.trim()
  }
  return [
    `installed: ${installed ? 'yes' : 'no'} (${p.unitPath})`,
    `running:   ${running ? 'yes' : 'no'}${detail ? ` — ${detail}` : ''}`,
    `logs:      ${p.logPath}`,
  ].join('\n')
}

export function daemonLogs(lines = 50): string {
  const p = daemonPaths()
  if (!existsSync(p.logPath)) return '(no log file yet)'
  const content = readFileSync(p.logPath, 'utf8').split('\n')
  return content.slice(-lines).join('\n')
}

export function restartDaemon(): string {
  const p = daemonPaths()
  if (p.kind === 'launchd') {
    const r = launchctl('kickstart', '-k', `gui/${uid()}/${LABEL}`)
    if (!r.ok) throw new Error(`kickstart failed: ${r.out.trim()}`)
  } else {
    const r = systemctl('restart', `${NAME}.service`)
    if (!r.ok) throw new Error(`restart failed: ${r.out.trim()}`)
  }
  return 'restarted'
}

export function uninstallDaemon(): string {
  const p = daemonPaths()
  if (p.kind === 'launchd') {
    launchctl('bootout', `gui/${uid()}`, p.unitPath)
  } else {
    systemctl('disable', '--now', `${NAME}.service`)
    systemctl('daemon-reload')
  }
  for (const f of [p.unitPath, p.wrapperPath]) {
    try { if (existsSync(f)) unlinkSync(f) } catch {}
  }
  // env file kept deliberately (API keys the user may want) — report it
  return `stopped + removed unit/wrapper\n  kept: ${p.envPath} (delete manually if unwanted)`
}
