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
 * - context-overflow self-heal (trim the oldest history, retry latest query)
 */
import {
  Agent, ContextWindowOverflowError, MaxTokensError, Message, NullConversationManager,
  SlidingWindowConversationManager, type Model,
} from '@strands-agents/sdk'
import { makeBash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import * as os from 'node:os'
import { TinyApi } from '../api.js'
import { apiHost } from '../config.js'
import { createLocalModel } from './model.js'
import { parseModelSpec } from './model-spec.js'
import { makeTinyTools } from './tiny-tools.js'
import { makeUseDeviceTool } from './device-invoke.js'
import { makeDeviceTools } from './device-tools.js'
import { getHistoryContext } from './history.js'
import { loadDevice, setDeviceCapabilities, announceTaskResult } from '../device.js'
import { harvestImages, uploadImages, undeliveredNote, type HostedImage } from './media.js'
import {
  loadLocalTools, makeToolsTool, ensureToolsDir, reloadLocalTools,
  summarize as summarizeLocalTools, type LocalToolsResult,
} from './local-tools.js'
import { LoopRunner, makeLoopTool, makeLoopDoneTool, MAX_ACTIVE_LOOPS } from './loop.js'
import { makeSpawnAgentsTool } from './spawn-tools.js'
import { makeNotifyTool, notify } from './notify.js'
import { makeMarqueeSayTool, makeMarqueeNews } from './marquee.js'
import { makeManageMessagesTool } from './manage-messages.js'
import { makeManageToolsTool } from './manage-tools.js'
import { makeInteractTool } from './interact.js'
import { makeRenderTool } from './render.js'
import type { MeshNode } from '../mesh/zenoh.js'

/**
 * How many messages a SESSION keeps. Bounding happens on the parent, once, when
 * a fork's exchange lands — see absorb() and trimHistory().
 *
 * Deliberately larger than the SDK default (40): a single tool-heavy turn is
 * easily six messages, so 40 is a handful of turns, and the point of the bound is
 * to stay under the model's context window rather than to be frugal. Trimming is
 * the parent's job alone — a fork that trims itself eats its own output on the
 * way home (see the conversationManager note in forkSession).
 */
const SESSION_WINDOW = 120

/** Does this message carry a block of the given kind? Never throws on stubs. */
function hasBlock(m: any, type: string): boolean {
  return Array.isArray(m?.content) && m.content.some((b: any) => b?.type === type)
}

/**
 * Is this slice safe to append to another conversation, or would it poison it?
 *
 * Bedrock validates toolUse/toolResult pairing across the WHOLE history, so an
 * orphan at either end of a folded-back turn isn't a local wart — it makes every
 * later turn that sends the history fail. Returns why not, or null when clean.
 */
function seamProblem(slice: any[]): string | null {
  if (hasBlock(slice[0], 'toolResultBlock')) {
    return 'it starts on a tool result whose toolUse is not part of the slice'
  }
  if (hasBlock(slice[slice.length - 1], 'toolUseBlock')) {
    return 'it ends on a toolUse whose tool result never arrived'
  }
  return null
}

/**
 * The `conversationManager` option to pass for this model, as an object to spread.
 *
 * A stateful model keeps the conversation server-side, and the SDK THROWS if you
 * hand one a conversation manager at all (it installs a null one itself). No model
 * tiny builds is stateful today — this is here so adding one is a config change
 * rather than a constructor that throws on startup.
 */
function managerFor(model: Model, manager: () => any): { conversationManager?: any } {
  return (model as any).stateful ? {} : { conversationManager: manager() }
}

/**
 * Did the model refuse this call because the history no longer fits?
 *
 * The SDK's typed error is the real signal. The string match stays as a fallback
 * for throwers that never reach it (the server proxy, a provider SDK surfacing
 * its own wording) — Bedrock wraps the provider message, so that text is
 * provider-dependent and drifts between versions.
 */
function isContextOverflow(e: unknown): boolean {
  if (e instanceof ContextWindowOverflowError) return true
  const msg = String((e as any)?.message || e).toLowerCase()
  return msg.includes('context window') || msg.includes('too many tokens') || msg.includes('input is too long')
}

/** Minimum output cap after halving — Bedrock refuses maxTokens < 4096 on most Claude models. */
const MIN_RETRY_MAX_TOKENS = 4096

/**
 * Did the model stop mid-reply because it hit the OUTPUT token cap?
 *
 * Different beast from context overflow: the INPUT fit, the OUTPUT didn't.
 * The SDK's typed error carries a `partialMessage` — the assistant turn it
 * was in the middle of writing when the cap slammed shut. Same TYPE-based
 * check as overflow because "the string wording drifts between providers"
 * argument holds identically.
 */
function isMaxTokens(e: unknown): boolean {
  return e instanceof MaxTokensError
}

/**
 * Halve the model's output cap for a retry, floored at MIN_RETRY_MAX_TOKENS.
 *
 * Returns the new cap on success, or null if we can't push it lower (either
 * the model has no getConfig/updateConfig, or we're already at the floor —
 * halving into the floor would loop us forever on the same wall).
 *
 * Kept as a pure mutation on the SDK Model: the retry that follows just calls
 * agent.invoke/stream again and the next request uses the smaller cap.
 */
function shrinkMaxTokens(model: Model | null | undefined): number | null {
  if (!model) return null
  const m = model as any
  if (typeof m.getConfig !== 'function' || typeof m.updateConfig !== 'function') return null
  let cfg: any
  try { cfg = m.getConfig() } catch { return null }
  const current = Number(cfg?.maxTokens)
  // If there's no cap set at all, halving is undefined — pick the floor.
  const next = Number.isFinite(current) && current > 0
    ? Math.max(MIN_RETRY_MAX_TOKENS, Math.floor(current / 2))
    : MIN_RETRY_MAX_TOKENS
  if (Number.isFinite(current) && current > 0 && next >= current) return null   // already at/below floor
  try { m.updateConfig({ maxTokens: next }) } catch { return null }
  return next
}

export interface TinyAgentOptions {
  api: TinyApi
  /** Extra tools */
  extraTools?: any[]
  printer?: boolean
  /** Zenoh mesh node — adds mesh_* tools + peer context injection */
  mesh?: MeshNode
  /**
   * This agent IS a background loop iteration (see loop.ts). It gets no
   * `use_loop`, so the depth is 1 by construction: a loop that can start loops
   * is an invisible fan-out — nobody is reading its output, so the only symptom
   * of a runaway is the user's fan. It also skips the finished-loop news, which
   * belongs to the turn the human is actually in.
   */
  background?: boolean
  /**
   * This agent is answering a request that arrived OVER the mesh, and this is
   * how many mesh legs it already travelled (1 = a peer asked us directly).
   * At MESH_MAX_HOPS it gets no mesh_send/mesh_broadcast at all — the same
   * depth-1-by-construction trick `background` uses for use_loop. Without it
   * a peer can answer a broadcast by broadcasting, which is an N-per-hop
   * amplifier where every copy is a real model call on every node.
   */
  meshHop?: number
  /**
   * This agent is a loop iteration AND can end its own loop: the runner's
   * `signalDone` for the one loop it belongs to. Registers `loop_done`, the
   * deterministic alternative to the [LOOP_DONE] sentinel. Closed over a single
   * loop, so it can never reach another one.
   */
  loopDone?: (note?: string) => void
  /** The loop this agent is iterating (paired with loopDone, for messages). */
  loopId?: string
  /** Record a progress line on the current iteration without ending the loop. */
  loopReport?: (note: string) => void
}

export class TinyAgent {
  private agent: Agent | null = null
  private api: TinyApi
  private opts: TinyAgentOptions
  public modelLabel = `server (${apiHost()} /api/chat)`
  public deviceLabels: string[] = []
  /** What the last local-tools load registered — `use_tools reload` diffs against it. */
  public localToolNames: string[] = []
  /** The load report, for the startup banner (repl/tui/daemon print it). */
  public localTools: LocalToolsResult | null = null
  /** Names a local tool may not take — enforced before the registry can throw. */
  private builtinToolNames: string[] = []
  /** Background loops — iterating agents for hours-long goals (null in server mode / background). */
  public loops: LoopRunner | null = null
  private lastEventId = 0
  /** 💬 Blackboard news cursor — primed at construction so only entries that
   * land while this process lives are injected; nothing repeats (v5). */
  private marqueeNews = makeMarqueeNews()
  private serverMode = false
  /**
   * Model / prompt / tools captured at init, so forkSession() can stand up a
   * sibling Agent with NO second init(): re-initializing would re-fetch
   * memories and the device list, re-probe every binary and re-import every
   * local tool file — per submit, while the user is typing the next one.
   */
  private model: Model | null = null
  private systemPromptText = ''
  private allTools: any[] = []
  /** The agent this one was forked from — see forkSession(). */
  private parent: TinyAgent | null = null

  /**
   * Fold a local-tools mutation back into the SESSION state — called by
   * manage_tools / use_tools after a reload, remove, create or fetch.
   *
   * Registries are resolved per call inside those tools (the executing agent's
   * AND this session's), but forks are constructed from `this.allTools` — an
   * array — so a tool that only lives in a registry vanishes on the next fork.
   * Reconcile IN PLACE: forkSession shares the array reference, so every
   * future fork sees the change without a re-init.
   */
  private absorbLocalTools(names: string[], tools?: any[]) {
    const prevNames = new Set(this.localToolNames)
    this.localToolNames = names
    if (!this.allTools.length) return
    const incoming = tools ?? []
    const incomingNames = new Set(incoming.map((t: any) => t?.name).filter(Boolean))
    const keep = new Set(names)
    for (let i = this.allTools.length - 1; i >= 0; i--) {
      const n = (this.allTools[i] as any)?.name
      if (!n || !prevNames.has(n)) continue // not a local tool — never touched
      // replaced by a fresh load, or gone from disk/registry
      if (incomingNames.has(n) || !keep.has(n)) this.allTools.splice(i, 1)
    }
    this.allTools.push(...incoming)
  }
  /**
   * The trackingIds this fork INHERITED; everything else in its array is ITS
   * work. Identity, not a count.
   *
   * This used to be a message INDEX (`forkBase = seed.length`), and that is what
   * made long sessions go silently amnesic: every conversation manager in the SDK
   * reduces history by splicing `messages` in place from the FRONT, so any trim —
   * the fork's own, or the parent's while the fork runs — re-indexes the array
   * under a positional boundary. `slice(forkBase)` then returned the wrong
   * messages, and usually none at all, so absorb() folded nothing back and the
   * session stopped growing with no error anywhere.
   */
  private seedIds = new Set<string>()
  /**
   * The sliding window used to BOUND this agent's history. Held rather than only
   * installed as a plugin because the TUI's parent never invokes — forks do — so
   * the hook it registers would never fire and reduce() has to be callable by
   * hand (absorb → trimHistory).
   */
  private trimmer: SlidingWindowConversationManager | null = null
  /**
   * Why the last absorb() refused to fold a turn back, or null when it was clean.
   * Read by the fold-back call site so a rejected seam degrades to a text summary
   * out loud instead of silently vanishing (src/tui/App.tsx finishConversation).
   */
  public lastAbsorbIssue: string | null = null

  constructor(opts: TinyAgentOptions) {
    this.api = opts.api
    this.opts = opts
  }

  async init(): Promise<void> {
    const { model, label } = await createLocalModel()
    this.modelLabel = label
    this.model = model

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
      const { MESH_MAX_HOPS } = await import('../mesh/zenoh.js')
      const hop = this.opts.meshHop || 0
      // Mesh tools only while there is a leg left to travel. mesh_peers stays
      // either way — reading the fleet is harmless and lets a remote agent
      // answer "who else is here" without being able to ask them.
      const all = makeMeshTools(this.opts.mesh, hop)
      meshTools = hop >= MESH_MAX_HOPS
        ? all.filter((t: any) => t?.name === 'mesh_peers')
        : all
    }

    // 🔧 The user's OWN tools from ~/.tiny/tools, hot-loadable via use_tools.
    // Loaded BEFORE the Agent exists on purpose: the SDK's ToolRegistry throws
    // on a duplicate name from inside the constructor, so a badly named file
    // would leave the daemon with no tools at all. Passing the builtin names as
    // `reserved` makes a collision skip that one file instead.
    const builtins = [
      makeBash(),           // shell — the local value-add
      fileEditor,           // read/write/edit files
      ...tiny.static,       // tiny_* cloud tools
      // 📡 The user's OTHER enrolled devices, via the tiny relay. Session-verb
      // proxies with the Bearer token — no worker key on this machine.
      makeUseDeviceTool(this.api),
      ...forged,            // my_* forged tools
      ...meshTools,         // mesh_peers / mesh_broadcast / mesh_send
      ...device.tools,      // use_apple / use_spotify / use_computer / use_flipper / use_adb / use_whatsapp / use_google / use_telegram
      // 🖥️ dynamic terminal UI (devduck dialog.py / rich_interface.py port).
      // Interact only where a human can answer: a background task has no one
      // at its stdin, so it gets use_render (headless-safe) but not use_interact.
      ...(this.opts.background ? [makeRenderTool()] : [makeInteractTool(), makeRenderTool()]),
      // 🔔 Native notification + the only way background work can ASK anything:
      // use_interact needs a human at this stdin, a loop has none. Registered in
      // BOTH modes for exactly that reason.
      makeNotifyTool(),
      // 💬 The shared marquee blackboard — one ticker line in the TUI that
      // every local agent and peer process can write. Registered in both
      // modes: a background loop announcing itself on the marquee is the
      // point.
      makeMarqueeSayTool(),
      // 🧠 Long-horizon self-management (devduck manage_messages/manage_tools
      // ports). manage_messages edits THIS agent's live history through
      // ToolContext.agent — compact-before-overflow is the survival move on a
      // long task. manage_tools grows the toolset at runtime behind a sandbox.
      // Registered in BOTH modes: background loops are exactly where a
      // conversation outgrows its window.
      makeManageMessagesTool(),
      makeManageToolsTool({
        registry: () => ((this.agent as any)?.toolRegistry ?? null),
        reserved: () => this.builtinToolNames,
        previous: () => this.localToolNames,
        onLoaded: (names, tools) => this.absorbLocalTools(names, tools),
      }),
      // ♾️ A loop's own off switch — present ONLY inside a loop, and only for
      // the loop that handed down its latch.
      ...(this.opts.background && this.opts.loopDone
        ? [makeLoopDoneTool({
            loopId: this.opts.loopId || 'this loop',
            signalDone: this.opts.loopDone,
            report: this.opts.loopReport || (() => {}),
          })]
        : []),
      ...(this.opts.extraTools || []),
    ]
    const toolsTool = makeToolsTool({
      // Read through `this.agent` every call: the registry doesn't exist yet
      // here, and a reload mid-session must reach the live one.
      registry: () => ((this.agent as any)?.toolRegistry ?? null),
      reserved: () => this.builtinToolNames,
      previous: () => this.localToolNames,
      onLoaded: (names, tools) => this.absorbLocalTools(names, tools),
    })

    // ♾️ Background loops — work that outlives the turn that asked for it. ONE
    // persistent agent iterates toward a goal, so hours-long work accumulates
    // context instead of restarting cold.
    //
    // A background agent gets NO use_loop: depth 1 by construction, because a
    // loop that can start loops fans out with nobody reading the output — the
    // only symptom of a runaway is the user's fan. Each loop runs on a fresh
    // agent for the same reason relay envelopes do: two turns interleaving into
    // one message array is a conversation in no order.
    const taskTools: any[] = []
    if (!this.opts.background) {
      this.loops = new LoopRunner({
        agentFactory: async (ctx) => {
          const a = new TinyAgent({
            ...this.opts, printer: false, background: true,
            loopDone: ctx?.signalDone, loopId: ctx?.loopId, loopReport: ctx?.report,
          })
          await a.init()
          return a
        },
        // …and the platform push rail for whoever ISN'T at this keyboard
        // (use_device async: deposit + event + push; device.ts contract).
        // Unconditional — it degrades to a no-op when the device isn't
        // enrolled, and needs no local notifier to matter.
        announce: (loopId, summary, result) => { void announceTaskResult(loopId, summary, result) },
        // 🔔 …and the LOCAL rail, for whoever IS at this machine. This hook has
        // existed unwired since loops shipped, so a finished loop only ever
        // reached the cloud push: the person sitting in front of the Mac got
        // silence. A failed loop chimes differently from a finished one, and a
        // notification can never fail the loop that finished (notify() never
        // throws, and finish() catches regardless).
        notify: (title, body) => {
          void notify({
            title, body, kind: 'info',
            sound: /error|exhausted|stopped/i.test(title) ? 'Basso' : 'Glass',
          })
        },
      })
      this.loops.prune()
      taskTools.push(makeLoopTool(this.loops))
      // ⭐ Parallel sub-agents — the web tool's semantics, local plumbing.
      // Foreground only, same reason as use_loop: a sub-agent is built with
      // background:true, so neither this tool nor use_loop exists inside it —
      // depth 1 by construction, a fan-out cannot fan out again. The finished
      // wait:false aggregate rides the SAME rails as a finished loop: local
      // notify() for whoever is at this machine, announceTaskResult for
      // whoever is not (spawn-tools.ts adds the history notice itself).
      taskTools.push(makeSpawnAgentsTool({
        agentFactory: async (i, count) => {
          const a = new TinyAgent({ ...this.opts, printer: false, background: true })
          await a.init()
          return {
            invoke: (prompt: string) =>
              a.invoke(`You are sub-agent #${i + 1} of ${count} in a parallel batch. Be direct and complete — your answer is merged with the other sub-agents' results.\n\n${prompt}`),
          }
        },
        notify: (title, body) => { void notify({ title, body, kind: 'info', sound: 'Glass' }) },
        announce: (batchId, summary, result) => { void announceTaskResult(batchId, summary, result) },
      }))
    }
    // `use_loop` is reserved even in background mode, where it isn't registered:
    // a name that means one thing in the foreground and something else inside a
    // loop is worse than a name that's simply unavailable. `spawn_agents` is on
    // the list for the identical reason — a sub-agent must not fan out again,
    // and a local tool must not answer to the name where it's absent. `use_tasks`
    // stays on the list after its removal so a local tool can't claim the retired
    // name and answer to it — old prompts and saved scripts still say it.
    this.builtinToolNames = [...builtins.map((t: any) => t?.name).filter(Boolean), 'use_tools', 'use_tasks', 'use_loop', 'spawn_agents', 'use_notify', 'loop_done']
    ensureToolsDir()
    const local = await loadLocalTools({ reserved: this.builtinToolNames })
    this.localTools = local
    this.localToolNames = local.loaded.map((t) => t.name)

    // Named, not defaulted: the SDK would hand us a windowSize-40 sliding window
    // anyway, but we need the INSTANCE to call reduce() on directly — the TUI's
    // session agent never invokes, so the AfterInvocationEvent hook that normally
    // does the trimming never fires here and its history would grow unbounded.
    this.trimmer = new SlidingWindowConversationManager({ windowSize: SESSION_WINDOW })

    this.agent = new Agent({
      model,
      systemPrompt: (this.systemPromptText = await this.buildSystemPrompt()),
      printer: this.opts.printer ?? true,
      tools: (this.allTools = [...builtins, toolsTool, ...taskTools, ...local.tools]),
      ...managerFor(model, () => this.trimmer),
    })
  }

  /**
   * 🧵 A SIBLING TURN: same model, same system prompt, same tool instances —
   * its OWN message history.
   *
   * This is what lets the TUI accept a second question while the first is still
   * streaming. The obvious alternative (devduck's SharedMessages: several agents
   * appending into one array) cannot work here: Bedrock validates toolUse /
   * toolResult pairing strictly, so two turns interleaving their blocks produce
   * a message sequence the API rejects outright — and the SDK refuses a second
   * concurrent invoke on one Agent anyway (ConcurrentInvocationError). The same
   * rule the mesh and the relay already follow, applied to the local UI.
   *
   * The fork STARTS from a snapshot of this agent's history, so the second
   * question knows what the first conversation was about, and its finished
   * exchange is folded back with absorb() in COMPLETION order — which is the
   * only order that reads correctly later: the transcript then matches what the
   * user watched happen.
   *
   * Tool objects are shared deliberately (their callbacks are stateless, and
   * re-wrapping them per fork would re-import every local tool file). The one
   * tool that DOES hold state is safe by construction: the SDK's bash tool keys
   * its persistent shell off `context.agent` in a WeakMap, so each fork gets its
   * own bash process instead of two turns interleaving commands and sentinels
   * down one stdin. The cost is that a fork doesn't inherit the parent shell's
   * cwd or variables — the right trade, since the alternative is one turn
   * reading the other's output.
   *
   * Server mode forks too: /api/chat is stateless per call, so a fork there is
   * just a second caller.
   */
  forkSession(): TinyAgent {
    const child = new TinyAgent({ ...this.opts, printer: false })
    child.parent = this
    child.modelLabel = this.modelLabel
    child.deviceLabels = this.deviceLabels
    child.localTools = this.localTools
    child.localToolNames = this.localToolNames
    // Shared on purpose: the runner, its slot cap and its record dir belong to
    // the SESSION, not to one turn. Two forks starting loops share the max.
    child.loops = this.loops
    if (this.serverMode || !this.agent || !this.model) {
      child.serverMode = true
      return child
    }
    const seed = [...this.agent.messages]
    child.model = this.model
    child.systemPromptText = this.systemPromptText
    child.allTools = this.allTools
    // WHAT was inherited, not how many — see the seedIds field for the amnesia
    // bug a positional boundary caused. trackingId is durable: minted at
    // construction, preserved across copy/restore, stripped before model calls.
    child.seedIds = new Set(seed.map((m) => m.trackingId))
    child.agent = new Agent({
      model: this.model,
      systemPrompt: this.systemPromptText,
      printer: false,
      tools: this.allTools,
      messages: seed,
      // A fork must NOT manage its own history. The SDK's default is a sliding
      // window that splices `messages` in place on AfterInvocationEvent — which
      // fires when the fork's turn ENDS, i.e. before absorb() runs — so a long
      // session's every turn would silently eat its own output on the way home.
      // Bounding history is the SESSION's job, once, after the turn lands.
      ...managerFor(this.model, () => new NullConversationManager()),
    })

    return child
  }

  /**
   * Messages this fork produced beyond the history it inherited.
   *
   * Filter, not slice: trim-proof and reorder-proof, so it stays correct however
   * either array was reduced while the turn was in flight.
   */
  newMessages(): Message[] {
    if (!this.agent) return []
    return this.agent.messages.filter((m) => !this.seedIds.has(m.trackingId))
  }

  /** How long this agent's history is (fork bookkeeping + tests). */
  get messageCount(): number {
    return this.agent?.messages.length ?? 0
  }

  /**
   * Fold a finished fork's exchange into this history. Returns how many
   * messages moved. Called when a conversation ENDS, never while it streams:
   * a half-finished turn merged early is exactly the invalid toolUse/toolResult
   * sequence forking exists to avoid.
   */
  absorb(fork: TinyAgent): number {
    this.lastAbsorbIssue = null
    if (!this.agent) return 0
    const add = fork.newMessages()
    if (!add.length) return 0

    // Validate at the seam. A slice with a dangling tool pair is worse than no
    // slice: it makes the session's history invalid for every LATER turn, far
    // from the turn that produced it, so it has to fail here and out loud.
    const problem = seamProblem(add)
    if (problem) {
      this.lastAbsorbIssue = `refused to fold back a ${add.length}-message turn: ${problem}`
      // Still claim them: a slice we won't take must not be re-offered next time.
      for (const m of add) fork.seedIds.add(m.trackingId)
      return 0
    }

    this.agent.messages.push(...add)
    // The fork keeps streaming nothing after this, but if it were reused its own
    // "new" messages must not be handed over twice.
    for (const m of add) fork.seedIds.add(m.trackingId)
    // Bound the session HERE — the one place where its history grows, and a point
    // where no fork's boundary can be disturbed by it (they're identity-based).
    this.trimHistory()
    return add.length
  }

  /**
   * Bound this agent's history at a valid trim point, dropping the oldest
   * messages. No-op while under the window.
   *
   * `reduce()` with no error is the SDK's proactive path: it trims to the window
   * and walks the trim point forward past any orphaned toolResult / unanswered
   * toolUse, which is exactly the invariant a hand-rolled splice keeps getting
   * wrong. It logs and returns false when no valid point exists.
   */
  private trimHistory(): boolean {
    if (!this.agent || !this.model) return false
    if (this.agent.messages.length <= SESSION_WINDOW) return false
    return this.reduceHistory()
  }

  /**
   * Shrink history so the next model call fits — trim, never wipe.
   *
   * With `error` set the SDK first truncates the oldest large tool results (a
   * screenshot, a 200KB file read) and only then drops messages, which is the
   * cheapest possible recovery: the shape of the conversation survives.
   */
  private reduceHistory(error?: unknown): boolean {
    if (!this.agent || !this.model) return false
    const trimmer = (this.trimmer ??= new SlidingWindowConversationManager({ windowSize: SESSION_WINDOW }))
    try {
      return trimmer.reduce({
        agent: this.agent as any,
        model: this.model,
        error: error instanceof ContextWindowOverflowError ? error : undefined,
      })
    } catch {
      return false // reduction is a self-heal; a failed one must not mask the real error
    }
  }

  /**
   * Undo the messages this turn added, keeping exactly `keep`.
   *
   * A model call that throws leaves its user message already appended, so a
   * retry on top of it sends two user messages in a row — which Bedrock rejects
   * for a different reason than the one we were recovering from. Rolling back by
   * trackingId is only possible because the fork boundary is identity-based too.
   */
  private rollbackTo(keep: Set<string>): void {
    const msgs = this.agent?.messages
    if (!msgs) return
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!keep.has(msgs[i].trackingId)) msgs.splice(i, 1)
    }
  }

  /**
   * Stop the turn in flight. Real cancellation, not "stop watching": the SDK
   * flips `cancelSignal` and the loop returns at its next safe point, so an
   * in-flight model call and any tool that honours the signal actually end.
   * Safe to call on an idle agent.
   */
  cancelTurn(): void {
    try { this.agent?.cancel() } catch { /* nothing in flight, or already done */ }
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

    return `You are tiny — the user's personal AI from ${apiHost()}, running LOCALLY on their machine via tiny-tech.

Environment: ${os.platform()} ${os.arch()} · node ${process.version}
Hostname: ${os.hostname()}${deviceBlock}
CWD: ${process.cwd()}
User: ${user ? `@${user.login} (${user.name || ''})` : 'not logged in — tiny_* tools will prompt for login'}
Time: ${new Date().toISOString()}

You have LOCAL tools (bash, file editor, http) plus the tiny platform at ${apiHost()} (memory, DMs, scheduled jobs, the universe of tinys, the user's forged tools). You are the same identity that lives at ${apiHost()} — memory is shared across every surface.

Device capabilities detected: ${this.deviceLabels.length ? this.deviceLabels.join(', ') : 'none'} — you EMBODY this machine (use_apple, use_spotify, use_computer, use_flipper, use_adb, use_whatsapp, use_google, use_telegram when present).${this.deviceLabels.includes('computer') ? `
You can SEE this screen: use_computer screenshot returns the actual image. Look before you act, read coordinates straight off that image, and take a fresh shot after anything that changes the screen.` : ''}${this.deviceLabels.includes('google') || this.deviceLabels.includes('whatsapp') ? `
These tools reach the user's real mailbox, calendar and contacts. Reading is yours to do freely; anything that SENDS or DELETES gets quoted to the user for approval first (use_google needs confirm=true for exactly this reason).` : ''}

${this.loops ? `Work that will take more than a minute goes to use_loop start, which returns a loop id immediately — whoever is waiting on this turn may be a phone or the web agent on a 45s timeout, so a long job run inline is a job that gets abandoned half-done. Say the id out loud; its result reaches you in a later turn on its own. One persistent background agent takes a step, cools down, takes the next, until [LOOP_DONE] or its caps; progress reaches you every few iterations.
End the loop by emitting [LOOP_DONE] the moment the goal is met. A loop is the ONLY background rail, so it also carries the one-shot jobs ("summarise this repo") — for those, [LOOP_DONE] belongs in the FIRST iteration. A loop that never says it keeps working for hours, and only ${MAX_ACTIVE_LOOPS} can run at once.
` : `You ARE a background loop iteration: finish the work and report it. You cannot start further loops.
End your loop with the loop_done tool the moment the goal is met — a tool call, not a phrase, so it is unambiguous. For a one-shot job that is THIS iteration. Then give your final answer; it becomes the loop's result.
On a long loop, call loop_done status='progress' with one line on what you just did before you finish each iteration: that line is what the user sees as progress news, in your words instead of a slice of your prose.
`}
Be brief and direct. Use tools in parallel when independent. Store durable facts about the user with tiny_learn.${localBlock}${memoryBlock}${getHistoryContext()}`
  }

  /** DevDuck get_*_context() pattern — cheap, per-turn, non-fatal */
  private async dynamicContext(): Promise<string> {
    // A fork asks its PARENT. Finished-loop news is delivered exactly once and
    // the event cursor advances once, so three conversations starting together
    // must not each drain the news (the user would read the same completion
    // three times) or each re-poll the feed. The session owns that cursor.
    if (this.parent) return this.parent.dynamicContext()
    // ♾️ Loop progress and completions that landed while nobody was looking,
    // delivered ONCE. This is the whole point of background work: a result the
    // user has to remember to ask for is a result they never see. Local and
    // unauthenticated — it goes FIRST because the early return below (no login)
    // must not swallow it.
    let taskBlock = ''
    try { taskBlock = this.loops?.takeNews() || '' } catch { /* news is never fatal */ }
    // 💬 The blackboard's unseen lines ride the same rail as loop news: what
    // the room said since the last turn, once, capped, markup stripped.
    try { taskBlock += this.marqueeNews.take() } catch { /* never fatal */ }

    let meshBlock = ''
    if (this.opts.mesh?.isRunning) {
      const peers = this.opts.mesh.listPeers()
      if (peers.length) {
        const now = Date.now()
        const lines = peers.map((p) => `- ${p.instanceId} (${p.hostname}) — ${p.model || '?'}, seen ${Math.round((now - p.lastSeen) / 1000)}s ago`)
        const reach = this.opts.meshHop ? 'listed for context — you cannot send to them on this turn' : 'reachable via mesh_send/mesh_broadcast'
        meshBlock = `[Mesh peers — ${reach}]\n${lines.join('\n')}\n\n`
      }
    }
    // Answering FOR a peer: say so out loud. A remote agent that silently finds
    // mesh_send missing does not conclude "I'm a responder" — it concludes the
    // daemon is broken, and offers to go fix the transport. (Observed live: it
    // blamed a dead mesh module and cited a memory of using the tool earlier.)
    if (this.opts.meshHop) {
      meshBlock = `[You are answering a request that arrived OVER THE MESH from another agent (hop ${this.opts.meshHop}).`
        + ' mesh_send/mesh_broadcast are deliberately withheld on this turn so a fan-out cannot amplify per hop —'
        + ' nothing is broken, and this is not something to diagnose or repair.'
        + ' Do the work with your LOCAL tools and answer; if the request genuinely requires reaching a third agent,'
        + ` say so plainly and let the requester do it.]\n\n${meshBlock}`
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
    const before = new Set(this.agent.messages.map((m) => m.trackingId))

    try {
      const result = await this.agent.invoke(input)
      return String(result)
    } catch (e: any) {
      // DevDuck self-heal, without the nuke: context overflow → trim the oldest
      // history, retry the bare query. Clearing it outright threw away the whole
      // session to survive one turn.
      if (isContextOverflow(e)) {
        process.stderr.write('tiny: context overflow — trimming history and retrying\n')
        this.rollbackTo(before)
        const shrank = this.reduceHistory(e)
        // A fork trimming only ITS copy leaves the session's history exactly as
        // long, so the next conversation forked off the parent overflows again —
        // the heal has to reach where the history actually lives.
        const parentShrank = this.parent?.reduceHistory(e) ?? false
        if (!shrank && !parentShrank) throw e   // nothing left to give; don't retry into the same wall
        const result = await this.agent.invoke(query)
        return String(result)
      }
      // Output cap slammed shut mid-reply — halve maxTokens and retry once.
      // Sibling of the overflow heal, different axis: overflow shrinks the
      // INPUT (history), this one shrinks the OUTPUT (cap). Preserving the
      // partial reply as prior context would poison future turns (the model
      // sees its own truncated thought), so we roll it back like overflow does.
      if (isMaxTokens(e)) {
        const next = shrinkMaxTokens(this.model)
        if (next == null) throw e   // already at the floor; retrying would hit the same wall
        process.stderr.write(`tiny: hit max output tokens — retrying with maxTokens=${next}\n`)
        this.rollbackTo(before)
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

  /**
   * The CURRENT model, read off the real constructed model object — the same
   * technique test/model.test.mjs uses, because a label string can lie about
   * what config is actually in force (the whole lesson of the Bedrock env fix).
   */
  modelInfo(): string {
    if (this.serverMode || !this.model) return this.modelLabel
    const m = this.model as any
    let cfg: any
    try { cfg = typeof m.getConfig === 'function' ? m.getConfig() : undefined } catch { /* fall through */ }
    cfg = cfg ?? m.config ?? m.modelConfig ?? m._config ?? {}
    const bits = [this.modelLabel]
    if (cfg.modelId && !this.modelLabel.includes(cfg.modelId)) bits.push(`modelId ${cfg.modelId}`)
    bits.push(cfg.maxTokens ? `maxTokens ${cfg.maxTokens}` : 'maxTokens (provider default)')
    return bits.join(' · ')
  }

  /**
   * Runtime model swap — /model provider:model_id[:max_tokens].
   *
   * Parse-or-throw, build via the same factory createLocalModel uses (env
   * additionalRequestFields/caps stay in force), then assign: `Agent.model` is
   * a public mutable field, so the conversation history survives untouched.
   * ANY failure leaves the old model exactly where it was — a typo can never
   * leave the session modelless.
   *
   * Returns the result line: 'old → new (maxTokens N)'.
   */
  async swapModel(rawSpec: string): Promise<string> {
    if (this.serverMode || !this.agent || !this.model) {
      throw new Error('server mode — no local model to swap (set TINY_MODEL_* env and restart)')
    }
    const spec = parseModelSpec(rawSpec)                     // throws on bad spec
    const { createModelFromSpec } = await import('./model.js')
    const { model, label } = await createModelFromSpec(spec) // throws, old model kept
    // The conversation manager was chosen at construction from model.stateful;
    // every model this factory builds is stateless in this SDK, but if that
    // ever changes swapping across the boundary would corrupt history — refuse.
    if ((model as any).stateful !== (this.model as any).stateful) {
      throw new Error('cannot swap between stateful and stateless models mid-session')
    }
    const old = this.modelLabel
    this.agent.model = model
    this.model = model
    this.modelLabel = label
    const capNote = spec.maxTokens ? ` (maxTokens ${spec.maxTokens})` : ''
    return `${old} → ${label}${capNote}`
  }

  /**
   * The actual mounted tool OBJECTS — for surfaces that execute tools outside
   * the Agent loop (the realtime voice call runs them itself, locally, and
   * needs the same instances so a spoken "what's on my screen" is the same
   * use_computer the typed session has).
   */
  get mountedTools(): any[] {
    return this.allTools
  }

  /**
   * Run one mounted tool the way the Agent loop would — the seam for surfaces
   * that drive tools themselves (today: the realtime voice call).
   *
   * 🩹 This exists because `tool.invoke(input)` is NOT enough. The SDK's vended
   * tools take a ToolContext as their second argument and refuse without one:
   * `makeBash()` reaches for `context.agent.sandbox`, fileEditor the same.
   * Called bare they throw "Tool context is required for bash operations", which
   * a voice call then dutifully speaks back as an error — the exact symptom of
   * "the tools don't work in voice mode", with the two most useful tools in the
   * roster the ones that fail.
   *
   * What the real Agent buys is its SANDBOX, so a spoken command runs against
   * the same machine the typed session does. It does NOT buy a shared shell:
   * tiny mounts `makeBash()`, the sandbox-bound variant, and every call is a
   * fresh `sandbox.execute` — separate pid, no inherited cwd, no variables
   * (measured, not assumed). The SDK's OTHER bash — the `bash` singleton — is
   * the one that keeps a persistent session keyed off `context.agent`; this tree
   * does not use it. So: "cd /tmp && ls", never "cd /tmp" then "ls".
   */
  async invokeTool(name: string, input: any = {}): Promise<string> {
    const tool = this.allTools.find((t: any) => (t?.toolSpec?.name ?? t?.name) === name)
    if (!tool) throw new Error(`no tool named ${name} on this machine`)
    // Server mode has no local Agent, so there is no sandbox to run in. Say that
    // plainly: the alternative is `context.agent.sandbox` throwing "Cannot read
    // properties of null", which a voice call reads out as gibberish.
    if (!this.agent) throw new Error(`${name} needs a local model session — this agent is in server mode, so tools that touch this machine cannot run`)
    const toolUse = { toolUseId: `voice-${Date.now().toString(36)}`, name, input }
    const context: any = { toolUse, agent: this.agent, invocationState: {} }
    const r = await tool.invoke(input, context)
    return typeof r === 'string' ? r : JSON.stringify(r ?? {})
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
    // The OTHER way session history grows — shell escapes, cancelled turns, a
    // voice exchange. Bounding only absorb() would leave a session that never
    // absorbs (all cancelled, all voice) growing exactly as unbounded as before.
    this.trimHistory()
  }

  /**
   * Forget this session's conversation — the model side of `/clear`.
   *
   * Returns how many messages were dropped, so the UI can say a number instead
   * of claiming success it didn't verify. In server mode there is no local
   * history to drop (it lives server-side) and the honest answer is 0.
   *
   * `messages.length = 0` mutates the array the SDK Agent holds, rather than
   * assigning a new one: the Agent kept a reference to the array it was
   * constructed with, so a fresh array would leave the old history live inside
   * the SDK while this side looked empty. Forks are untouched by design — a turn
   * in flight owns its own copy, and its fold-back lands in the now-empty
   * session as a valid first exchange (seedIds is cleared so the seam is still
   * checked against nothing rather than against messages that no longer exist).
   */
  clearHistory(): number {
    this.lastAbsorbIssue = null
    if (!this.agent) return 0
    const dropped = this.agent.messages.length
    this.agent.messages.length = 0
    this.seedIds.clear()
    return dropped
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
    const before = new Set(this.agent.messages.map((m) => m.trackingId))

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
      if (isContextOverflow(e)) {
        // Self-heal: roll back the failed attempt, TRIM (never wipe), one retry,
        // still streaming.
        this.rollbackTo(before)
        const shrank = this.reduceHistory(e)
        // A fork trimming only ITS copy leaves the session's history exactly as
        // long as it was, so the next conversation forked off the parent overflows
        // again — the heal has to reach where the history actually lives. Safe in
        // both directions now that the fork boundary is a set of trackingIds:
        // whatever either trim removes, absorb() still finds exactly this turn.
        const parentShrank = this.parent?.reduceHistory(e) ?? false
        if (!shrank && !parentShrank) {
          // Nothing left to give. Retrying would hit the same wall, and claiming
          // a heal we didn't perform is worse than saying the turn failed.
          yield { kind: 'error', message: String(e?.message || e) }
          yield { kind: 'done', text: finalText }
          return
        }
        // A NOTICE, not an error: this turn is about to succeed. Reported as an
        // error, it made the fold-back call site downgrade a fully recovered turn
        // to a lossy text summary — "failed" and "recovered" are different states.
        yield { kind: 'notice', message: 'context overflow — trimmed the oldest history and retried' }
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
      // Same self-heal shape for output-cap: sibling of overflow, different axis.
      // Halve maxTokens, roll back the failed attempt (the partial reply is
      // dropped — keeping it as history would poison future turns with the
      // model's own truncated thought), retry once, keep streaming.
      if (isMaxTokens(e)) {
        const next = shrinkMaxTokens(this.model)
        if (next == null) {
          // Already at the floor. Retrying would hit the same wall; the turn
          // failed for a real reason and pretending otherwise is worse.
          yield { kind: 'error', message: String(e?.message || e) }
          yield { kind: 'done', text: finalText }
          return
        }
        this.rollbackTo(before)
        // Whatever we streamed before the cap slammed is now not in history and
        // not committed; the retry starts a fresh assistant reply. Report the
        // heal as a notice so a UI does not fold a recovered turn back as failed.
        yield { kind: 'notice', message: `hit max output tokens — retrying with maxTokens=${next}` }
        // Reset finalText: the retry produces the whole reply, and the fold-back
        // call site uses finalText as the turn's canonical output.
        finalText = ''
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
  /**
   * Something went wrong and was HANDLED — the turn continues and will land.
   * Distinct from 'error' on purpose: a UI that treats every complaint as a
   * failure throws away the exchange of a turn that actually recovered.
   */
  | { kind: 'notice'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; text: string }
