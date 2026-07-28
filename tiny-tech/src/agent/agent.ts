/**
 * TinyAgent — DevDuck's agent loop in TypeScript, tiny-shaped.
 *
 * Local Strands Agent when a BYO model exists (TINY_MODEL_* / AWS creds /
 * OPENAI_API_KEY / ANTHROPIC_API_KEY); otherwise proxies through the
 * server-side /api/chat (zero-config — same agent, higher latency).
 *
 * DevDuck patterns ported:
 * - dynamic context injection per turn (identity, unread events, memories)
 * - shell/file/http local tools (SDK vended tools — the value over web)
 * - context-overflow self-heal (clear history, retry latest query)
 */
import { Agent, Message } from '@strands-agents/sdk'
import { makeBash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import * as os from 'node:os'
import { TinyApi } from '../api.js'
import { createLocalModel } from './model.js'
import { makeTinyTools } from './tiny-tools.js'
import { makeDeviceTools } from './device-tools.js'
import { getHistoryContext } from './history.js'
import { loadDevice, setDeviceCapabilities } from '../device.js'
import { harvestImages, uploadImages, undeliveredNote, type HostedImage } from './media.js'
import { runDesktop, desktopSenses, desktopSenseBlock } from './desktop.js'
import { browseBlock } from './browse.js'
import {
  loadLocalTools, makeToolsTool, ensureToolsDir, reloadLocalTools,
  summarize as summarizeLocalTools, type LocalToolsResult,
} from './local-tools.js'
import { TaskRunner, makeTasksTool } from './tasks.js'
import type { MeshNode } from '../mesh/zenoh.js'

export interface TinyAgentOptions {
  api: TinyApi
  /** Extra tools */
  extraTools?: any[]
  printer?: boolean
  /** Zenoh mesh node — adds mesh_* tools + peer context injection */
  mesh?: MeshNode
  /**
   * This agent IS a background task (see tasks.ts). It gets no `use_tasks`, so
   * the depth is 1 by construction: a task that can start tasks is an invisible
   * fan-out — nobody is reading its output, so the only symptom of a runaway is
   * the user's fan. It also skips the finished-task news, which belongs to the
   * turn the human is actually in.
   */
  background?: boolean
}

export class TinyAgent {
  private agent: Agent | null = null
  private api: TinyApi
  private opts: TinyAgentOptions
  public modelLabel = 'server (tiny.technology /api/chat)'
  public deviceLabels: string[] = []
  /** What the last local-tools load registered — `use_tools reload` diffs against it. */
  public localToolNames: string[] = []
  /** The load report, for the startup banner (repl/tui/daemon print it). */
  public localTools: LocalToolsResult | null = null
  /** Names a local tool may not take — enforced before the registry can throw. */
  private builtinToolNames: string[] = []
  /** Background tasks this daemon is running / has run (null in server mode). */
  public tasks: TaskRunner | null = null
  private lastEventId = 0
  private serverMode = false

  constructor(opts: TinyAgentOptions) {
    this.api = opts.api
    this.opts = opts
  }

  async init(): Promise<void> {
    const { model, label } = await createLocalModel()
    this.modelLabel = label

    if (!model) {
      // Zero-config: everything flows through the server-side agent.
      this.serverMode = true
      return
    }

    const tiny = makeTinyTools(this.api)
    const forged = this.api.authenticated ? await tiny.makeForgedTools() : []
    const device = makeDeviceTools()
    this.deviceLabels = device.labels
    // Tell the presence layer what this machine actually turned out to be able
    // to do — heartbeats declare it, so the WEB agent sees this device's real
    // surface in its prompt before it ever sends a use_device envelope.
    setDeviceCapabilities(device.labels)
    let meshTools: any[] = []
    if (this.opts.mesh) {
      const { makeMeshTools } = await import('../mesh/tools.js')
      meshTools = makeMeshTools(this.opts.mesh)
    }

    // 🔧 The user's OWN tools from ~/.tiny/tools, hot-loadable via use_tools.
    // Loaded BEFORE the Agent exists on purpose: the SDK's ToolRegistry throws
    // on a duplicate name from inside the constructor, so a badly named file
    // would leave the daemon with no tools at all. Passing the builtin names as
    // `reserved` makes a collision skip that one file instead.
    const builtins = [
      makeBash(),           // shell — the local value-add
      fileEditor,           // read/write/edit files
      httpRequest,          // universal http client
      ...tiny.static,       // tiny_* cloud tools
      ...forged,            // my_* forged tools
      ...meshTools,         // mesh_peers / mesh_broadcast / mesh_send
      ...device.tools,      // use_apple / use_spotify / use_computer / use_flipper / use_adb / use_whatsapp / use_google / use_telegram
      ...(this.opts.extraTools || []),
    ]
    const toolsTool = makeToolsTool({
      // Read through `this.agent` every call: the registry doesn't exist yet
      // here, and a reload mid-session must reach the live one.
      registry: () => ((this.agent as any)?.toolRegistry ?? null),
      reserved: () => this.builtinToolNames,
      previous: () => this.localToolNames,
      onLoaded: (names) => { this.localToolNames = names },
    })

    // ⏳ Background tasks — work that outlives the turn that asked for it.
    // A background agent gets NO use_tasks: depth 1 by construction, because a
    // task that can start tasks fans out with nobody reading the output. Each
    // task runs on a fresh agent for the same reason relay envelopes do — two
    // turns interleaving into one message array is a conversation in no order.
    const taskTools: any[] = []
    if (!this.opts.background) {
      this.tasks = new TaskRunner({
        agentFactory: async () => {
          const a = new TinyAgent({ ...this.opts, printer: false, background: true })
          await a.init()
          return a
        },
        // The daemon is headless under launchd/systemd, so without this a
        // 12-minute job lands with no trace anywhere near the person at the
        // keyboard. Best-effort: absent on a machine with no notifier.
        notify: this.deviceLabels.includes('desktop')
          ? (title, body) => { void runDesktop({ action: 'notify', title, body }) }
          : undefined,
      })
      this.tasks.prune()
      taskTools.push(makeTasksTool(this.tasks))
    }
    // `use_tasks` is reserved even in background mode, where it isn't
    // registered: a name that means one thing in the foreground and something
    // else inside a task is worse than a name that's simply unavailable.
    this.builtinToolNames = [...builtins.map((t: any) => t?.name).filter(Boolean), 'use_tools', 'use_tasks']
    ensureToolsDir()
    const local = await loadLocalTools({ reserved: this.builtinToolNames })
    this.localTools = local
    this.localToolNames = local.loaded.map((t) => t.name)

    this.agent = new Agent({
      model,
      systemPrompt: await this.buildSystemPrompt(),
      printer: this.opts.printer ?? true,
      tools: [...builtins, toolsTool, ...taskTools, ...local.tools],
    })
  }

  private async buildSystemPrompt(): Promise<string> {
    const user = this.api.user
    let memoryBlock = ''
    if (this.api.authenticated) {
      try {
        const d = await this.api.get('/api/learnings?limit=20')
        const items = (d.learnings || []).map((l: any) => `- ${l.content}`).join('\n')
        if (items) memoryBlock = `\n\n## What tiny knows about this user (cross-agent memory):\n${items}`
      } catch { /* memory is enhancement, not requirement */ }
    }

    // Device identity (this machine) + sibling devices on the account —
    // gives the agent fleet awareness (which node it IS, who else exists).
    const device = loadDevice()
    let deviceBlock = ''
    if (device) {
      deviceBlock = `\nThis device: ${device.name} (id ${device.deviceId}) — enrolled on the user's account`
    }
    if (this.api.authenticated) {
      try {
        const d = await this.api.get('/api/devices')
        const siblings = (d.devices || []).filter((x: any) => x.id !== device?.deviceId)
        if (siblings.length) {
          const lines = siblings.map((x: any) => {
            const seen = x.last_seen ? new Date(x.last_seen * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never'
            return `- ${x.online ? '●' : '○'} ${x.name} [${x.kind}/${x.platform || '?'}]${Array.isArray(x.capabilities) && x.capabilities.length ? ` caps: ${x.capabilities.join(',')}` : ''} — seen ${seen}`
          }).join('\n')
          deviceBlock += `\n\n## Sibling devices on this account (the user's fleet — reachable via mesh when online):\n${lines}`
        }
      } catch { /* device list is enhancement, not requirement */ }
    }

    // 🖥️ WHICH desktop senses this machine actually has (wording + why: see
    // desktopSenseBlock). Resolved ONCE, here, and only when use_desktop really
    // registered — each desktopSenses() call shells out `command -v` per binary.
    const senseBlock = this.deviceLabels.includes('desktop') ? desktopSenseBlock(desktopSenses()) : ''

    // 🌐 Same reasoning as senseBlock, for the opposite failure: reaching for
    // httpRequest on a JavaScript-rendered page doesn't ERROR, it returns an
    // empty shell the model then reports as an empty page. The agent has to know
    // a browser is available before it makes that call.
    const browseHint = this.deviceLabels.includes('browse') ? browseBlock() : ''

    // The user's own tools, named in the prompt. A registered tool the model
    // can see in its tool list still benefits from being called out here: these
    // are the ones that exist on NO other machine, so they're what makes this
    // node worth routing work to — and a file that failed to load is the user's
    // to fix, so the agent has to be able to say which one and why.
    let localBlock = ''
    if (this.localTools && (this.localTools.loaded.length || this.localTools.skipped.length)) {
      const lines = this.localTools.loaded.map((t) => `- ${t.name} — ${t.description.split('\n')[0].slice(0, 120)}`)
      const bad = this.localTools.skipped.map((s) => `- ⚠️ ${s.file}: ${s.reason}`)
      localBlock = `\n\n## The user's OWN local tools (${this.localTools.dir}) — they wrote these, they run on this machine:\n${[...lines, ...bad].join('\n')}\nAfter they add or edit a file there, call use_tools reload — no restart needed.`
    }

    return `You are tiny — the user's personal AI from tiny.technology, running LOCALLY on their machine via tiny-tech.

Environment: ${os.platform()} ${os.arch()} · node ${process.version}
Hostname: ${os.hostname()}${deviceBlock}
CWD: ${process.cwd()}
User: ${user ? `@${user.login} (${user.name || ''})` : 'not logged in — tiny_* tools will prompt for login'}
Time: ${new Date().toISOString()}

You have LOCAL tools (bash, file editor, http) plus the tiny.technology platform (memory, DMs, scheduled jobs, the universe of tinys, the user's forged tools). You are the same identity that lives at tiny.technology — memory is shared across every surface.

Device capabilities detected: ${this.deviceLabels.length ? this.deviceLabels.join(', ') : 'none'} — you EMBODY this machine (use_apple, use_spotify, use_computer, use_flipper, use_adb, use_whatsapp, use_google, use_telegram when present).${this.deviceLabels.includes('computer') ? `
You can SEE this screen: use_computer screenshot returns the actual image. Look before you act, read coordinates straight off that image, and take a fresh shot after anything that changes the screen.` : ''}${senseBlock}${browseHint}${this.deviceLabels.includes('google') || this.deviceLabels.includes('whatsapp') ? `
These tools reach the user's real mailbox, calendar and contacts. Reading is yours to do freely; anything that SENDS or DELETES gets quoted to the user for approval first (use_google needs confirm=true for exactly this reason).` : ''}

${this.tasks ? `Work that will take more than a minute goes to use_tasks start, which returns a task id immediately — whoever is waiting on this turn may be a phone or the web agent on a 45s timeout, so a long job run inline is a job that gets abandoned half-done. Say the id out loud; its result reaches you in a later turn on its own.
` : `You ARE a background task: finish the work and report it. You cannot start further tasks.
`}
Be brief and direct. Use tools in parallel when independent. Store durable facts about the user with tiny_learn.${localBlock}${memoryBlock}${getHistoryContext()}`
  }

  /** DevDuck get_*_context() pattern — cheap, per-turn, non-fatal */
  private async dynamicContext(): Promise<string> {
    // ⏳ Tasks that finished while nobody was looking, delivered ONCE. This is
    // the whole point of background work: a result the user has to remember to
    // ask for is a result they never see. Local and unauthenticated — it goes
    // FIRST because the early return below (no login) must not swallow it.
    let taskBlock = ''
    try { taskBlock = this.tasks?.takeNews() || '' } catch { /* news is never fatal */ }

    let meshBlock = ''
    if (this.opts.mesh?.isRunning) {
      const peers = this.opts.mesh.listPeers()
      if (peers.length) {
        const now = Date.now()
        const lines = peers.map((p) => `- ${p.instanceId} (${p.hostname}) — ${p.model || '?'}, seen ${Math.round((now - p.lastSeen) / 1000)}s ago`)
        meshBlock = `[Mesh peers — reachable via mesh_send/mesh_broadcast]\n${lines.join('\n')}\n\n`
      }
    }
    if (!this.api.authenticated) return taskBlock + meshBlock
    try {
      const d = await this.api.get(`/api/events${this.lastEventId ? `?sinceId=${this.lastEventId}` : '?limit=5'}`)
      const events = d.events || []
      if (!events.length) return taskBlock + meshBlock
      this.lastEventId = Math.max(...events.map((e: any) => Number(e.id) || 0), this.lastEventId)
      const lines = events.slice(0, 8).map((e: any) =>
        `- [${e.type || 'event'}] ${String(e.summary || e.message || JSON.stringify(e.data || {})).slice(0, 160)}`)
      return `${taskBlock}${meshBlock}[Activity since last turn]\n${lines.join('\n')}\n\n`
    } catch { return taskBlock + meshBlock }
  }

  /**
   * Re-read `~/.tiny/tools` into the live registry and report it.
   *
   * The same operation `use_tools reload` performs, exposed as a method because
   * the tray socket offers it too (a menu item, so the user doesn't have to ask
   * the agent in words). Two call sites reloading through two code paths is how
   * one of them ends up skipping the `previous`/`reserved` bookkeeping and
   * leaves a deleted tool registered.
   */
  async reloadLocalTools(): Promise<string> {
    const reg = (this.agent as any)?.toolRegistry
    if (!reg) return 'no live tool registry (local tools need a local model — this session proxies to the server)'
    try {
      const { result, names, removed } = await reloadLocalTools(reg, {
        previous: this.localToolNames,
        reserved: this.builtinToolNames,
      })
      this.localTools = result
      this.localToolNames = names
      return `${summarizeLocalTools(result)}${removed.length ? `\n   🗑  removed: ${removed.join(', ')}` : ''}`
    } catch (e: any) {
      return `reload failed: ${String(e?.message || e).slice(0, 300)}`
    }
  }

  async invoke(query: string): Promise<string> {
    // Server proxy mode — no local key, still fully functional
    if (this.serverMode || !this.agent) {
      const r = await this.api.chat({ tiny: 'tiny', message: query, timeoutMs: 180_000 })
      if (r.error) throw new Error(r.error)
      return r.text
    }

    const ctx = await this.dynamicContext()
    const input = ctx ? `${ctx}[User]\n${query}` : query

    try {
      const result = await this.agent.invoke(input)
      return String(result)
    } catch (e: any) {
      // DevDuck self-heal: context overflow → clear history, retry bare query
      const msg = String(e?.message || e).toLowerCase()
      if (msg.includes('context window') || msg.includes('too many tokens') || msg.includes('input is too long')) {
        process.stderr.write('tiny: context overflow — clearing history and retrying\n')
        this.agent.messages.length = 0
        const result = await this.agent.invoke(query)
        return String(result)
      }
      throw e
    }
  }

  /**
   * 🖼️ A turn that can hand back PICTURES, not just prose (loop item d-d).
   *
   * use_computer's screenshot already returns a real image block, so THIS agent
   * sees the screen — but invoke() flattens the turn to a string, so a remote
   * asker (the web agent via use_device) got the daemon's description of an
   * image instead of the image. Here the images this turn produced are uploaded
   * once to the media store and returned as hosted URLs alongside the text; the
   * caller decides what to do with them (relay-poller puts them in the reply).
   *
   * Text is never sacrificed for pixels: an upload that fails costs the image
   * and says so, and an unauthenticated device silently returns text only —
   * which is exactly what it does today.
   */
  async invokeWithMedia(query: string): Promise<{ text: string; images: HostedImage[] }> {
    const text = await this.invoke(query)
    if (this.serverMode || !this.agent) return { text, images: [] }

    const harvested = harvestImages(this.agent.messages)
    if (!harvested.length) return { text, images: [] }
    if (!this.api.authenticated) {
      // The media store is session-authed; there is nowhere to put bytes.
      return { text: text + undeliveredNote(harvested.length, 0), images: [] }
    }

    const images = await uploadImages(harvested, (path, body) => this.api.post(path, body))
    return { text: text + undeliveredNote(harvested.length, images.length), images }
  }

  get isLocal(): boolean {
    return !this.serverMode && this.agent !== null
  }

  /** Registered tool names (for mesh presence / introspection). */
  get toolNames(): string[] {
    if (!this.agent) return []
    try {
      const reg = (this.agent as any).toolRegistry ?? (this.agent as any)._toolRegistry
      if (reg?.registry) return [...reg.registry.keys()].sort()
      const tools = (this.agent as any).tools
      if (Array.isArray(tools)) return tools.map((t: any) => t.name).filter(Boolean).sort()
    } catch { /* introspection is best-effort */ }
    return []
  }

  /**
   * Inject a synthetic user/assistant exchange into conversation history.
   * Used by `!cmd` shell escape — the command + output become context the
   * agent can see on subsequent turns, without invoking the model.
   */
  injectExchange(userText: string, assistantText: string): void {
    if (!this.agent) return // server mode keeps history server-side; skip
    this.agent.messages.push(
      Message.fromMessageData({ role: 'user', content: [{ text: userText }] }),
      Message.fromMessageData({ role: 'assistant', content: [{ text: assistantText }] }),
    )
  }

  /**
   * Streaming turn — unified event vocabulary for UIs (Ink TUI).
   * Local mode: normalizes SDK AgentStreamEvents. Server mode: normalizes
   * the /api/chat SSE wire format. Same TurnEvent out either way.
   */
  async *streamTurn(query: string): AsyncGenerator<TurnEvent> {
    if (this.serverMode || !this.agent) {
      // Server proxy — tap the SSE stream via onEvent, re-yield normalized
      const queue: TurnEvent[] = []
      let done = false
      let wake: (() => void) | null = null
      const push = (ev: TurnEvent) => { queue.push(ev); wake?.(); }

      const p = this.api.chat({
        tiny: 'tiny', message: query, timeoutMs: 180_000,
        onEvent: (e: any) => {
          if (e.type === 'modelContentBlockDeltaEvent' && e.textDelta) push({ kind: 'text', text: e.textDelta })
          else if (e.type === 'modelContentBlockDeltaEvent' && e.reasoningDelta) push({ kind: 'reasoning', text: e.reasoningDelta })
          else if (e.type === 'beforeToolCallEvent' && e.toolCall) push({ kind: 'tool_start', name: e.toolCall.name, input: e.toolCall.input })
          else if (e.type === 'afterToolCallEvent' && e.toolResult) push({ kind: 'tool_end', name: e.toolResult.name, error: e.toolResult.error })
          else if (e.type === 'error') push({ kind: 'error', message: String(e.error) })
        },
      }).then((r) => {
        if (r.error) push({ kind: 'error', message: r.error })
        push({ kind: 'done', text: r.text })
      }).catch((e) => {
        push({ kind: 'error', message: String(e?.message || e) })
        push({ kind: 'done', text: '' })
      }).finally(() => { done = true; wake?.(); })

      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>((res) => { wake = res })
        while (queue.length) yield queue.shift()!
      }
      await p
      return
    }

    const ctx = await this.dynamicContext()
    const input = ctx ? `${ctx}[User]\n${query}` : query
    let finalText = ''

    try {
      for await (const e of this.agent.stream(input)) {
        const ev: any = e
        if (ev.type === 'modelStreamUpdateEvent') {
          const inner = ev.event
          if (inner?.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta' && inner.delta.text) {
            finalText += inner.delta.text
            yield { kind: 'text', text: inner.delta.text }
          } else if (inner?.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'reasoningContentDelta' && inner.delta.text) {
            yield { kind: 'reasoning', text: inner.delta.text }
          }
        } else if (ev.type === 'beforeToolCallEvent') {
          yield { kind: 'tool_start', name: ev.toolUse?.name, input: ev.toolUse?.input }
        } else if (ev.type === 'afterToolCallEvent') {
          yield { kind: 'tool_end', name: ev.toolUse?.name, error: ev.error ? String(ev.error?.message ?? ev.error) : undefined }
        }
      }
      yield { kind: 'done', text: finalText }
    } catch (e: any) {
      const msg = String(e?.message || e).toLowerCase()
      if (msg.includes('context window') || msg.includes('too many tokens') || msg.includes('input is too long')) {
        // self-heal: clear + one retry, still streaming
        this.agent.messages.length = 0
        yield { kind: 'error', message: 'context overflow — history cleared, retrying' }
        let retryText = ''
        for await (const e2 of this.agent.stream(query)) {
          const ev: any = e2
          if (ev.type === 'modelStreamUpdateEvent' && ev.event?.type === 'modelContentBlockDeltaEvent' && ev.event.delta?.type === 'textDelta' && ev.event.delta.text) {
            retryText += ev.event.delta.text
            yield { kind: 'text', text: ev.event.delta.text }
          }
        }
        yield { kind: 'done', text: retryText }
        return
      }
      yield { kind: 'error', message: String(e?.message || e) }
      yield { kind: 'done', text: finalText }
    }
  }
}

/** Unified streaming event for UI layers */
export type TurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_start'; name?: string; input?: any }
  | { kind: 'tool_end'; name?: string; error?: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; text: string }
