#!/usr/bin/env node
/**
 * npx tiny-tech — tiny.technology MCP server + auth CLI.
 *
 *   tiny-tech            start the MCP server on stdio (default)
 *   tiny-tech login      browser auth → ~/.tiny/credentials.json
 *   tiny-tech connect    optional step 2: Google / Spotify / Telegram / WhatsApp
 *   tiny-tech logout     delete stored credentials
 *   tiny-tech whoami     print identity + owned tinys
 *   tiny-tech serve      explicit server start
 *
 * stdout is reserved for MCP stdio framing; all human output → stderr.
 */
import { existsSync, statSync } from 'node:fs'
import { login, clearCredentials, loadCredentials, credentialsValid, DEFAULT_API_URL } from './auth.js'
import { TinyApi } from './api.js'
import { startServer } from './server.js'
import { enrollDevice, loadDevice, clearDevice } from './device.js'
import { applyStoredEnv } from './integrations.js'

// Stored app connections become env vars before anything reads them, so a
// connection made in one terminal works in the next. A real export wins.
applyStoredEnv()

const apiUrl = process.env.TINY_API_URL || DEFAULT_API_URL
// First non-flag arg decides the command; flags like --mesh are options.
// No command: interactive terminal → TUI (the human default); piped stdio
// (MCP clients like Claude Desktop spawn us that way) → MCP server.
const argvRest = process.argv.slice(2)
const cmd = argvRest.includes('--help') || argvRest.includes('-h')
  ? 'help'
  : argvRest.find((a) => !a.startsWith('-'))
    || (process.stdin.isTTY ? 'tui' : 'serve')
const KNOWN = new Set(['login', 'logout', 'whoami', 'connect', 'serve', 'repl', 'tui', 'mesh', 'daemon', 'tray', 'devices', 'help', '--help', '-h'])

async function main() {
  switch (cmd) {
    case 'login': {
      await login(apiUrl)
      // Enroll this machine as a device node (tiny-node PR2) — presence,
      // revocable from the web /devices page. Failure is non-fatal: login
      // is still valid without a device identity.
      try {
        const d = await enrollDevice(new TinyApi())
        process.stderr.write(`✓ Device enrolled: ${d.name} (${d.deviceId.slice(0, 8)}…) — manage at ${apiUrl}/devices\n`)
      } catch (e: any) {
        process.stderr.write(`device enroll skipped: ${e?.message || e}\n`)
      }
      // Step 2 is optional and stays a one-liner — the point is that people
      // who never read the README still learn the tools exist.
      try {
        const { connectHint } = await import('./integrations.js')
        const hint = await connectHint()
        if (hint) process.stderr.write(`${hint}\n`)
      } catch { /* a hint is never worth failing a successful login over */ }
      return
    }

    case 'logout': {
      const removed = clearCredentials()
      const deviceRemoved = clearDevice()
      process.stderr.write(removed ? 'Logged out — credentials removed.\n' : 'No credentials found.\n')
      if (deviceRemoved) process.stderr.write('Device identity removed (revoke it fully at /devices).\n')
      return
    }

    case 'whoami': {
      const creds = loadCredentials()
      if (!credentialsValid(creds)) {
        process.stderr.write('Not logged in. Run: npx tiny-tech login\n')
        process.exitCode = 1
        return
      }
      const api = new TinyApi(creds)
      const me = await api.get('/api/me')
      process.stderr.write(`@${me.user?.login || creds.user.login} (${me.user?.name || ''})\n`)
      const tinys = me.tinys || []
      if (tinys.length) {
        process.stderr.write(`tinys:\n${tinys.map((t: any) => `  - ${t.name}${t.private ? ' (private)' : ''}`).join('\n')}\n`)
      } else {
        process.stderr.write('no tinys yet — create one with the tiny_create tool or at tiny.technology\n')
      }
      const days = Math.round((creds.expires - Date.now() / 1000) / 86400)
      if (days < Number.MAX_SAFE_INTEGER / 86400) process.stderr.write(`token expires in ~${days} days\n`)
      return
    }

    case 'devices': {
      const creds = loadCredentials()
      if (!credentialsValid(creds)) {
        process.stderr.write('Not logged in. Run: npx tiny-tech login\n')
        process.exitCode = 1
        return
      }
      const api = new TinyApi(creds)
      const r = await api.get('/api/devices')
      const devices = r.devices || []
      const me = loadDevice()
      if (!devices.length) {
        process.stderr.write('No devices enrolled — run `npx tiny-tech login` on a machine to add it.\n')
        return
      }
      for (const d of devices) {
        const dot = d.online ? '●' : '○'
        const self = me?.deviceId === d.id ? ' (this machine)' : ''
        const seen = d.last_seen ? new Date(d.last_seen * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never'
        process.stderr.write(`${dot} ${d.name} [${d.kind}/${d.platform || '?'}] seen ${seen}${self}\n`)
      }
      return
    }

    case 'connect': {
      const { runConnect } = await import('./integrations.js')
      await runConnect(argvRest.filter((a) => !a.startsWith('-'))[1])
      return
    }

    case 'serve': {
      const creds = loadCredentials()
      if (!credentialsValid(creds)) {
        // Boot anyway — MCP clients spawn us non-interactively; tools will
        // surface the login instruction, and tiny_login can fix it live.
        process.stderr.write('tiny-tech: no valid credentials (run `npx tiny-tech login`)\n')
      }
      await startServer()
      return
    }

    case 'repl': {
      const { runRepl } = await import('./agent/repl.js')
      await runRepl()
      return
    }

    case 'tui': {
      const { runTui } = await import('./tui/index.js')
      await runTui()
      return
    }

    case 'daemon': {
      const sub = argvRest.filter((a) => !a.startsWith('-'))[1] || 'status'
      const d = await import('./daemon.js')
      try {
        switch (sub) {
          case 'install':   process.stderr.write(d.installDaemon() + '\n'); break
          case 'show':      process.stderr.write(d.installDaemon({ dryRun: true }) + '\n'); break
          case 'status':    process.stderr.write(d.daemonStatus() + '\n'); break
          case 'logs':      process.stderr.write(d.daemonLogs(80) + '\n'); break
          case 'restart':   process.stderr.write(d.restartDaemon() + '\n'); break
          case 'uninstall': process.stderr.write(d.uninstallDaemon() + '\n'); break
          default:
            process.stderr.write(`Unknown daemon action: ${sub} (install|show|status|logs|restart|uninstall)\n`)
            process.exitCode = 1
        }
      } catch (e: any) {
        process.stderr.write(`daemon error: ${e?.message || e}\n`)
        process.exitCode = 1
      }
      return
    }

    case 'mesh': {
      // Headless mesh node: joins the zenoh mesh and answers commands from
      // peers (devduck or tiny-tech) with a fresh local agent per command.
      const { MeshNode } = await import('./mesh/zenoh.js')
      const { TinyAgent } = await import('./agent/agent.js')
      const { TinyApi: Api } = await import('./api.js')
      const mesh = new MeshNode({
        modelLabel: 'tiny-tech',
        agentFactory: async () => {
          const a = new TinyAgent({ api: new Api(), printer: false })
          await a.init()
          return a
        },
      })
      await mesh.start()
      process.stderr.write(`🕸  tiny-tech mesh node: ${mesh.instanceId}\n`)
      process.stderr.write('   answering devduck/broadcast + devduck/cmd — ^C to stop\n')

      // Device presence: heartbeat so /devices shows this daemon online
      const { loadDevice, startHeartbeatLoop } = await import('./device.js')
      const dev = loadDevice()
      if (dev) {
        startHeartbeatLoop(dev, () => {
          process.stderr.write('tiny-tech: device revoked — presence stopped\n')
        })
      }

      // Cloud relay (PR6): poll for envelopes from the web agent (use_device)
      const { startRelayPoller } = await import('./mesh/relay-poller.js')
      const poller = startRelayPoller({
        agentFactory: async () => {
          const a = new TinyAgent({ api: new Api(), printer: false })
          await a.init()
          return a
        },
        onStop: (reason) => process.stderr.write(`📡 relay: ${reason}\n`),
      })
      process.stderr.write(poller
        ? '📡 relay: polling for web-agent envelopes (use_device)\n'
        : '📡 relay: no device identity — run `tiny-tech login` to enroll\n')

      // 🎵 Background ticker probe — passively refreshes ambient data (Spotify,
      // wallet, events) so the menu-bar rotating strip stays current without
      // ever making a live call from inside the status() handler. The probe
      // runs on a staggered interval so bursts of tray polls don't cascade into
      // bursts of Spotify API calls.
      const { tickerCache } = await import('./agent/ticker.js')
      const { spotifyTokenPath } = await import('./agent/spotify.js')
      const { normalizeEventKind } = await import('./tray.js')
      const runTickerProbe = async () => {
        // Spotify now-playing — only if a token file exists (no token = not connected)
        try {
          const fs2 = await import('node:fs')
          if (fs2.existsSync(spotifyTokenPath())) {
            const raw = JSON.parse(fs2.readFileSync(spotifyTokenPath(), 'utf8'))
            const accessToken = raw?.access_token
            if (accessToken) {
              const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                headers: { Authorization: `Bearer ${accessToken}` }
              })
              if (res.status === 200) {
                const data: any = await res.json()
                if (data?.item) {
                  tickerCache.setNowPlaying({
                    title: data.item.name || '',
                    artist: (data.item.artists || []).map((a: any) => a.name).join(', '),
                    isPlaying: data.is_playing === true,
                  })
                } else {
                  tickerCache.setNowPlaying(null)
                }
              } else if (res.status === 204) {
                tickerCache.setNowPlaying(null)
              }
            }
          }
        } catch { /* probe is best-effort, never fatal */ }

        // Wallet balance — via tiny API
        try {
          const api2 = new Api()
          if (api2.authenticated) {
            const walletData: any = await api2.get('/api/wallet/balance')
            if (typeof walletData?.balance === 'number') {
              tickerCache.setWallet({ balance: walletData.balance / 1_000_000, currency: 'USDC' })
            }
          }
        } catch { /* best-effort */ }


      // Feed kinds ("tiny_visit", "job_error", …) → the tray's short vocabulary,
      // which is what picks the glyph in the menu. Now imported from tray.ts
      // (the protocol module) rather than defined inline here, because it is
      // half of a contract with the Swift helper's `glyph`/`eventSymbol` and a
      // closure inside a command handler cannot be tested against the other half.

        // Unread events — light poll
        try {
          const api3 = new Api()
          if (api3.authenticated) {
            const evData: any = await api3.get('/api/events?limit=10')
            const events = evData?.events || []
            tickerCache.setEvents({
              unreadCount: events.length,
              items: events.slice(0, 5).map((e: any) => ({
                id: Number(e.id) || undefined,
                // The feed's shape is {kind, detail, created}; kinds like
                // "tiny_visit" collapse to the tray's short vocabulary so the
                // helper picks the right glyph.
                type: normalizeEventKind(String(e.kind || e.type || 'event')),
                summary: String(e.detail || e.summary || e.message || '').slice(0, 120) || String(e.kind || 'event'),
                at: Number(e.created || e.at || e.created_at) || undefined,
              })),
            })
          }
        } catch { /* best-effort */ }
      }

      // First probe after 3s (let the daemon settle), then every 30s
      setTimeout(() => {
        void runTickerProbe()
        setInterval(() => void runTickerProbe(), 30_000)
      }, 3_000)

      // 🎛 Tray control socket — the local half of the two-process menu-bar
      // shape. The daemon is headless, so without this the only way to see what
      // it's doing is to read a log file. A tray agent is built ONCE and reused
      // for `reload`/`ask`: the point of the socket is that the menu answers
      // instantly, and standing up a whole agent per click doesn't.
      const { startTrayServer } = await import('./tray.js')
      const { desktopSenses } = await import('./agent/desktop.js')
      const { daemonPaths, daemonLogs } = await import('./daemon.js')
      const trayAgent = new TinyAgent({ api: new Api(), printer: false })
      await trayAgent.init().catch((e: any) => process.stderr.write(`🎛 tray: agent unavailable (${e?.message || e})\n`))
      const startedAt = Date.now()
      // Resolved once: the senses probe shells `command -v` per binary, and the
      // tray polls status every few seconds.
      const senses = desktopSenses()
      const logPath = daemonPaths().logPath
      const tray = await startTrayServer({
        onError: (m) => process.stderr.write(`🎛 ${m}\n`),
        deps: {
          status: () => {
            const tasks = trayAgent.tasks?.list() || []
            const running = tasks.filter((t) => t.status === 'running').length
            const finished = tasks.filter((t) => t.status !== 'running').length
            const failedTools = trayAgent.localTools?.skipped.length || 0
            const peerCount = mesh.listPeers().length
            return {
              device: dev ? { name: dev.name, id: dev.deviceId, online: true } : null,
              peers: peerCount,
              senses,
              tools: { loaded: trayAgent.localToolNames.length, failed: failedTools },
              tasks: { running, finished },
              relay: !!poller,
              logPath,
              startedAt,
              mood: tickerCache.computeMood(running, failedTools),
              ticker: tickerCache.buildCards(peerCount),
              nowPlaying: tickerCache.getNowPlaying(),
              events: tickerCache.getRecentEvents(),
            }
          },
          tasks: () => (trayAgent.tasks?.list() || []).map((t) => ({
            id: t.id, status: t.status, prompt: t.prompt, startedAt: t.startedAt, endedAt: t.endedAt,
          })),
          taskResult: (id) => trayAgent.tasks?.get(id) || null,
          startTask: (prompt) => trayAgent.tasks?.start(prompt) || { error: 'no task runner on this daemon' },
          cancelTask: (id) => trayAgent.tasks?.cancel(id) || 'no task runner on this daemon',
          logs: (lines) => daemonLogs(lines),
          reloadTools: () => trayAgent.reloadLocalTools(),
          shareFile: (path, note) => {
            // Validate NOW (the tray deadline is 2s), do the work as a task.
            // The task's agent has use_computer/fileEditor + the tiny_* cloud
            // tools, so "look at this screenshot" runs with full context, and
            // its completion notifies the desktop like any finished task.
            if (!existsSync(path)) return `no file at ${path}`
            const size = statSync(path).size
            if (!size) return `${path} is empty`
            if (size > 3_000_000) return `${path} is ${(size / 1024 / 1024).toFixed(1)}MB — too large to attach (3MB cap)`
            const prompt = `[Shared from the menu bar] The user just captured a screenshot at ${path}.` +
              ` Read it with your vision (attach/view the image), describe anything noteworthy,` +
              ` and act on this note from the user: ${note || '(no note — just look and summarise)'}`
            const r = trayAgent.tasks?.start(prompt)
            if (!r) return 'no task runner on this daemon'
            if ('error' in r) return r.error
            return `shared — task ${r.id} is looking at it (answer lands as a notification + your next chat turn)`
          },
        },
      })
      process.stderr.write(tray
        ? `🎛 tray: ${tray.path} (tiny-tech tray status)\n`
        : '🎛 tray: control socket unavailable — daemon runs without it\n')

      // prependListener, not on(): TinyAgent.init() (above) already registered a
      // SIGTERM/SIGINT handler that calls process.exit(0) to reap its shell
      // sessions, and handlers run in registration order — so appending here
      // would let the agent exit the process before the mesh ever stopped.
      // It does NOT call process.exit itself: the agent's handler does that, and
      // pre-empting it would skip the shell-session reaping it exists for. The
      // setImmediate is the backstop for a daemon whose agent never initialized
      // (no handler to exit for us) — by then every signal listener has run.
      const shutdown = async () => {
        tray?.close()
        await mesh.stop()
        setImmediate(() => process.exit(0))
      }
      process.prependListener('SIGINT', shutdown)
      process.prependListener('SIGTERM', shutdown)
      // Peer table report every 30s
      setInterval(() => {
        const peers = mesh.listPeers()
        process.stderr.write(`🕸  peers: ${peers.length}${peers.length ? ' — ' + peers.map(p => p.instanceId).join(', ') : ''}\n`)
      }, 30_000)
      await new Promise(() => {}) // run forever
      return
    }

    case 'tray': {
      // The client half of the daemon's control socket. Exists for two reasons:
      // a user can inspect a headless daemon without reading a log file, and the
      // Swift menu-bar helper has a reference client to compare itself against
      // (its own bugs then look different from protocol bugs).
      const { trayRequest, formatTrayReply, TRAY_COMMANDS } = await import('./tray.js')
      const rest = argvRest.filter((a) => !a.startsWith('-'))
      const sub = rest[1] || 'status'
      if (!(TRAY_COMMANDS as readonly string[]).includes(sub)) {
        process.stderr.write(`unknown tray command: ${sub} (${TRAY_COMMANDS.join('|')})\n`)
        process.exitCode = 1
        return
      }
      // `ask` takes the REST of the line, so a prompt needs no quoting; the
      // others take one id / a line count.
      const arg = rest.slice(2).join(' ')
      const req: Record<string, unknown> = { cmd: sub }
      if (sub === 'ask') req.prompt = arg
      else if (sub === 'logs') { if (arg) req.lines = Number(arg) }
      else if (sub === 'share') {
        // share <path> [note …] — path first, everything after is the note
        req.path = rest[2] || ''
        const note = rest.slice(3).join(' ')
        if (note) req.note = note
      }
      else if (arg) req.id = arg
      const r = await trayRequest(req)
      process.stderr.write(formatTrayReply(r) + '\n')
      if (!r.ok) process.exitCode = 1
      return
    }

    case 'help':
    case '--help':
    case '-h':
      process.stderr.write(`tiny-tech — tiny.technology MCP server

usage: npx tiny-tech [command]

commands:
  (none)           TUI in a terminal; MCP server when spawned over stdio
  serve            force the MCP server on stdio
  tui              full-screen agent UI (Ink) — the pretty one
  repl             plain interactive agent session (pipes-friendly)
  mesh             headless zenoh mesh node (answers peer commands)
  daemon <action>  persistence: install|status|logs|restart|uninstall|show
                   (launchd on macOS, systemd --user on Linux; runs 'mesh')
  tray <action>    talk to a running daemon over its control socket:
                   status|tasks|result <id>|ask <text>|cancel <id>|logs [n]|
                   reload|ping — the same protocol a menu-bar helper speaks
  "any text"       one-shot agent query (e.g. tiny-tech "what did I miss?")
  login            authorize via browser, store credentials
  connect [app]    optional: connect google|spotify|telegram|whatsapp
  logout           remove stored credentials + device identity
  whoami           show identity + owned tinys
  devices          list your enrolled devices w/ presence

options:
  --no-mesh        disable the zenoh mesh (ON by default — devduck-compatible)

env:
  TINY_MESH        'false' = disable mesh (default: enabled)
  ZENOH_CONNECT    remote endpoint(s), e.g. tcp/host:7447
  ZENOH_LISTEN     listen endpoint(s) for remote peers
  TINY_API_URL     override https://tiny.technology
  TINY_TOKEN       bearer token (skips credentials file — CI/headless)
  TINY_NO_BROWSER  don't auto-open the login URL (print it instead)
  TINY_HOME        credentials dir (default ~/.tiny)
  TINY_TRAY_SOCK   daemon control socket (default ~/.tiny/tray.sock, mode 0600)
  TINY_TOOLS_DIR   your own local tools (default ~/.tiny/tools) — drop in a
                   .mjs exporting { name, description, handler }; the agent
                   hot-reloads them with use_tools, no restart
  TINY_MODEL_*     BYO model for tiny_chat (PROVIDER, API_KEY, ID, BASE_URL)

app connections (optional — 'tiny-tech connect' writes these to
~/.tiny/integrations.json for you; exporting them yourself also works):
  GOOGLE_OAUTH_CLIENT / _CLIENT_ID / _CLIENT_SECRET   use_google
  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET           use_spotify
  TELEGRAM_BOT_TOKEN                                  use_telegram
  wacli auth (a QR scan on your phone)                use_whatsapp
`)
      return

    default: {
      // devduck quick-path: any non-command arg is a one-shot agent query
      if (!cmd.startsWith('-')) {
        const { runOneShot } = await import('./agent/repl.js')
        await runOneShot(argvRest.filter((a) => !a.startsWith('-')).join(' '))
        return
      }
      process.stderr.write(`Unknown command: ${cmd} (try --help)\n`)
      process.exitCode = 1
    }
  }
}

main().catch((e) => {
  process.stderr.write(`tiny-tech error: ${e?.message || e}\n`)
  process.exit(1)
})
