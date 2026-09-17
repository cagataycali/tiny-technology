/**
 * tiny-tech REPL — devduck interactive() in TypeScript.
 *
 *   tiny-tech repl          interactive session
 *   tiny-tech "query"       one-shot (also: echo "q" | tiny-tech repl)
 *
 * Conventions ported from devduck:
 *   !cmd        run a shell command directly (no agent turn)
 *   /clear      forget the conversation + wipe the screen (also: `clear`)
 *   exit/quit/q leave
 *   double ^C   leave
 */
import * as readline from 'node:readline'
import { TinyApi } from '../api.js'
import { apiHost } from '../config.js'
import { appendHistory, loadInputHistory } from './history.js'
import { loadCredentials, credentialsValid } from '../auth.js'
import { TinyAgent } from './agent.js'
import { AmbientMode } from './ambient.js'

/**
 * Shared: mesh is ON by default — opt out with --no-mesh or TINY_MESH=false.
 *
 * Auto-discovery, devduck-parity:
 *   • joins the multicast-scouted peer mesh (224.0.0.224:7446), no config
 *   • advertises rich presence (real tool names, model, cwd, identity summary)
 *   • prints peers joining/leaving live, so you SEE the fleet appear
 *   • answers peers' commands with a fresh agent, streaming as it types
 *   • mirrors everything into /tmp/tiny/mesh_registry.json for other processes
 */
export async function maybeStartMesh(modelLabel?: string, opts: { announce?: boolean } = {}): Promise<any | undefined> {
  const optOut = process.argv.includes('--no-mesh') || process.env.TINY_MESH === 'false'
  if (optOut) return undefined
  const announce = opts.announce !== false
  try {
    const { MeshNode } = await import('../mesh/zenoh.js')

    // Probe agent: init once to advertise REAL tool names + model in presence
    let tools: string[] = []
    let label = modelLabel || 'tiny-tech'
    let promptSummary = ''
    try {
      const probe = new TinyAgent({ api: new TinyApi(), printer: false })
      await probe.init()
      tools = probe.toolNames
      label = modelLabel || `tiny-tech (${probe.modelLabel})`
      promptSummary = `tiny — ${apiHost()} personal AI · devices: ${probe.deviceLabels.join(',') || 'none'} · ${tools.length} tools`
    } catch { /* presence enrichment is best-effort */ }

    // Declared, then assigned: agentFactory closes over `mesh`, and a `const`
    // referenced inside its own initializer would infer `any`.
    let mesh: InstanceType<typeof MeshNode>
    mesh = new MeshNode({
      modelLabel: label,
      tools,
      systemPromptSummary: promptSummary,
      onPeerJoin: (p) => {
        if (!announce) return
        const t = p.toolCount ? `, ${p.toolCount} tools` : ''
        process.stderr.write(`\n🔗 peer joined: ${p.instanceId} (${p.hostname}) — ${p.model || 'unknown'}${t}${p.cwd ? `, ${p.cwd}` : ''}\n`)
      },
      onPeerLeave: (p) => {
        if (announce) process.stderr.write(`\n⚡ peer left: ${p.instanceId} (${p.hostname})\n`)
      },
      agentFactory: async (ctx) => {
        // `mesh` closes over the node we are constructing — by the time a
        // command arrives it is assigned, so the remote agent can answer
        // identity questions from mesh.instanceId (it used to have no mesh
        // tool at all and resorted to reading the shared registry file, where
        // it read ANOTHER process's self-flag and answered as the wrong node).
        // meshHop caps delegation depth: at MESH_MAX_HOPS this agent gets no
        // mesh_send/mesh_broadcast, so answering a broadcast cannot fan out again.
        const a = new TinyAgent({ api: new TinyApi(), printer: false, mesh, meshHop: ctx?.hop ?? 1 })
        await a.init()
        // streamTurn is picked up by the mesh node → the requester sees this
        // machine's answer token by token, plus its tool calls.
        return a
      },
    })
    await mesh.start()
    if (announce) process.stderr.write(`🕸  mesh: joined as ${mesh.instanceId}\n`)
    return mesh
  } catch (e: any) {
    if (announce) process.stderr.write(`🕸  mesh unavailable: ${e?.message || e}\n`)
    return undefined
  }
}

export async function runOneShot(query: string): Promise<void> {
  const api = new TinyApi()
  const mesh = await maybeStartMesh()
  const agent = new TinyAgent({ api, printer: true, mesh })
  await agent.init()
  if (!agent.isLocal) {
    // Server mode has no streaming printer — print the final text
    const text = await agent.invoke(query)
    process.stdout.write(text + '\n')
  } else {
    await agent.invoke(query) // printer streams to stdout
    process.stdout.write('\n')
  }
  await mesh?.stop()
}

export async function runRepl(): Promise<void> {
  const api = new TinyApi()
  const creds = loadCredentials()

  const mesh = await maybeStartMesh()
  const agent = new TinyAgent({ api, printer: true, mesh })
  await agent.init()

  // 🌙 Ambient mode (devduck port) — background exploration between turns.
  // Shares THIS agent (and its conversation memory); `foregroundBusy` keeps
  // ambient from overlapping a user turn.
  let foregroundBusy = false
  const ambient = new AmbientMode({
    invoke: (prompt) => agent.invoke(prompt),
    busy: () => foregroundBusy,
  })

  const who = credentialsValid(creds) ? `@${creds!.user.login}` : 'not logged in'
  process.stderr.write(`\n🌱 tiny — ${who} · model: ${agent.modelLabel}\n`)
  if (!agent.isLocal) {
    process.stderr.write(`   (no local model key — proxying via ${apiHost()}; set TINY_MODEL_* or OPENAI_API_KEY/ANTHROPIC_API_KEY/AWS creds for local tools)\n`)
  }
  // A tool file that failed to load is the user's to fix, and this banner is
  // the only place they'll see it before the agent quietly doesn't have it.
  if (agent.localTools && (agent.localTools.loaded.length || agent.localTools.skipped.length)) {
    const { summarize } = await import('./local-tools.js')
    process.stderr.write(summarize(agent.localTools) + '\n')
  }
  process.stderr.write("   'exit' to quit · '!cmd' for raw shell · '/clear' to start over · 'ambient'/'auto' background thinking\n\n")

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: '🌱 ', history: loadInputHistory().reverse(), historySize: 500 })

  let lastInterrupt = 0
  rl.on('SIGINT', () => {
    const now = Date.now()
    if (now - lastInterrupt < 2000) { rl.close(); return }
    lastInterrupt = now
    process.stderr.write('\n(^C again to exit)\n')
    rl.prompt()
  })

  rl.prompt()
  for await (const line of rl) {
    const q = line.trim()
    if (!q) { rl.prompt(); continue }
    if (['exit', 'quit', 'q'].includes(q.toLowerCase())) break

    // 🌙 ambient toggles (devduck REPL conventions)
    if (q.toLowerCase() === 'ambient') {
      if (ambient.running && !ambient.autonomous) { ambient.stop(); process.stderr.write('🌙 ambient stopped\n') }
      else ambient.start(false)
      rl.prompt(); continue
    }
    if (['auto', 'autonomous'].includes(q.toLowerCase())) {
      if (ambient.autonomous) { ambient.stop(); process.stderr.write('🌙 autonomous stopped\n') }
      else ambient.start(true)
      rl.prompt(); continue
    }

    // /clear — same contract as the TUI: forget the conversation AND wipe the
    // screen, so the scrollback can't contradict what the agent now knows. Bare
    // `clear` is accepted too, because that's what a shell user types (and the
    // shell's own `clear` would wipe the screen while leaving the agent
    // remembering everything, which is the confusing half-state).
    if (['/clear', '/reset', 'clear'].includes(q.toLowerCase())) {
      const dropped = agent.clearHistory()
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
      process.stderr.write(dropped > 0
        ? `🧼 cleared — forgot ${dropped} message${dropped === 1 ? '' : 's'}\n`
        : agent.isLocal ? '🧼 cleared — history was already empty\n'
        : '🧼 history lives server-side — nothing local to forget\n')
      rl.prompt()
      continue
    }

    if (q.startsWith('!')) {
      const { execSync } = await import('node:child_process')
      const cmd = q.slice(1)
      try {
        const out = execSync(cmd, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        process.stdout.write(out)
        agent.injectExchange('I ran this shell command myself: `' + cmd + '`', 'Command succeeded. Output:\n```\n' + out.slice(0, 8000) + '\n```')
      } catch (e: any) {
        const err = String(e?.stderr || e?.message || e)
        process.stderr.write(err + '\n')
        agent.injectExchange('I ran this shell command myself: `' + cmd + '`', 'Command FAILED. Output:\n```\n' + err.slice(0, 8000) + '\n```')
      }
      rl.prompt()
      continue
    }

    // 🌙 findings from idle-time work join this query (drained exactly once)
    const findings = ambient.getAndClearFindings()
    const turnInput = findings ? `${findings}\n\n[New user query]:\n${q}` : q
    if (findings) process.stderr.write('🌙 injecting ambient findings into this turn…\n')
    ambient.interrupt() // abandon any in-flight ambient thought — the user is here

    foregroundBusy = true
    try {
      if (!agent.isLocal) {
        const text = await agent.invoke(turnInput)
        process.stdout.write(text + '\n')
        appendHistory(q, text)
      } else {
        const r = await agent.invoke(turnInput)
        process.stdout.write('\n')
        appendHistory(q, String(r))
      }
      ambient.recordInteraction(q)
    } catch (e: any) {
      process.stderr.write(`tiny error: ${e?.message || e}\n`)
    } finally {
      foregroundBusy = false
    }
    rl.prompt()
  }

  ambient.stop()
  await mesh?.stop()
  process.stderr.write('\n🌱 bye\n')
}
