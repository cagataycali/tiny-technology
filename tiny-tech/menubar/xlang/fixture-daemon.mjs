/**
 * A tray server backed by the REAL `startTrayServer`, with scripted deps.
 *
 * The point of this fixture is that neither test suite can catch a contract
 * drift on its own: the Swift tests answer themselves from an echo socket, and
 * the Node tests answer themselves from a JS client. Only this pairing puts the
 * real server in front of the real Swift client — which is where the two
 * Swift-specific decisions in the protocol (`state` rather than `status` on a
 * result, and `protocol` on every reply) either hold or don't.
 */
import { startTrayServer } from '../../dist/tray.js'

const path = process.argv[2] || `/tmp/tiny-xlang-${process.pid}.sock`

const server = await startTrayServer({
  path,
  onError: (m) => { console.error(`fixture: ${m}`); process.exit(1) },
  deps: {
    status: () => ({
      device: { name: "cagatay's mac", id: 'dev_1', online: true },
      peers: 3,
      senses: ['computer', 'browse', 'desktop'],
      tools: { loaded: 4, failed: 1 },
      tasks: { running: 1, finished: 2 },
      relay: true,
      logPath: '/tmp/daemon.log',
      startedAt: 1753000000000,
      version: '0.8.0',
    }),
    tasks: () => [
      { id: 't_1', status: 'running', prompt: 'summarise the overnight mail', startedAt: 1753000001000 },
      { id: 't_2', status: 'done', prompt: 'what changed in the repo', startedAt: 1753000000500, endedAt: 1753000000900 },
    ],
    // Newlines on purpose: they are what makes the framing claim falsifiable.
    taskResult: (id) => (id === 't_2' ? { status: 'done', result: 'three commits,\nall on main' } : null),
    startTask: (prompt) => (prompt === 'no' ? { error: '3 tasks already running — wait or cancel one' } : { id: 't_new' }),
    cancelTask: (id) => `stopped waiting for ${id} — the work already in flight cannot be aborted`,
    logs: () => 'line one\nline two',
    reloadTools: () => '3 local tools loaded',
  },
})

if (!server) { console.error('fixture: could not bind'); process.exit(1) }
console.log(`SOCKET ${path}`)

const shutdown = () => { try { server.close() } catch { } process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// Never outlive the check that started it, even if that check crashes.
setTimeout(shutdown, 60_000)
