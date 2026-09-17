/**
 * Zenoh mesh node — WIRE-COMPATIBLE with devduck's zenoh_peer protocol.
 *
 * A tiny-tech node joins the same multicast-scouted peer mesh as every
 * DevDuck instance on the LAN (224.0.0.224:7446). Same key vocabulary:
 *
 *   devduck/presence/{id}                heartbeat every 5s
 *   devduck/broadcast                    {sender_id, turn_id, command}
 *   devduck/cmd/{id}                     direct command
 *   devduck/response/{sender}/{turn_id}  ack | stream | turn_end | error
 *
 * Incoming commands run through a FRESH TinyAgent per command (the SDK
 * throws ConcurrentInvocationError on a busy agent — devduck spawns a new
 * DevDuck per command for the same reason), streaming chunks back.
 *
 * Native transport: @diskette/dialtone (prebuilt napi — darwin arm64/x64,
 * linux x64, win32 x64; no build step, npx stays instant).
 */
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { registry as defaultRegistry, IDENTITY_MAX_CHARS, TOOLS_MAX, type MeshRegistry } from './registry.js'

export interface MeshPeer {
  instanceId: string
  hostname: string
  model?: string
  lastSeen: number
  cwd?: string
  platform?: string
  /** Rich presence (devduck heartbeat shape) */
  tools?: string[]
  toolCount?: number
  systemPrompt?: string
  started?: string
  nodeVersion?: string
  pythonVersion?: string
  /** How we learned about this peer */
  source?: 'zenoh' | 'registry'
}

/** A remote agent answering commands — buffered, or streaming if it can. */
export interface MeshAgent {
  invoke: (q: string) => Promise<string>
  streamTurn?: (q: string) => AsyncGenerator<any>
}

/**
 * Where an incoming command came from, so the responder can build an agent
 * that is allowed to do less than the local one. `hop` is how many mesh legs
 * the request has already travelled: 0 is impossible (that's a local turn),
 * 1 means "a human asked a peer, the peer asked me".
 */
export interface MeshCommandContext {
  hop: number
  from: string
  turnId: string
}

/**
 * How many mesh legs a request may travel. At the cap the responder's agent is
 * built WITHOUT mesh_send/mesh_broadcast, which is the whole point: a peer that
 * answers a broadcast by broadcasting is an N-per-hop amplifier, and every
 * copy costs a real model call on every node. Raise it only if you actually
 * want delegation chains (2 = a peer may ask one further peer).
 */
export const MESH_MAX_HOPS = Math.max(1, Number(process.env.TINY_MESH_MAX_HOPS) || 1)

export interface MeshOptions {
  /** Answer incoming commands with this factory's agent (fresh per command) */
  agentFactory?: (ctx?: MeshCommandContext) => Promise<MeshAgent>
  /** Instance id override (default: {host}-{6 hex}) */
  instanceId?: string
  /** Presence label for the model field */
  modelLabel?: string
  /** Tool names advertised in presence (devduck-compatible heartbeat) */
  tools?: string[]
  /** Short system-prompt/identity summary for presence */
  systemPromptSummary?: string
  /** Remote endpoints to connect (ZENOH_CONNECT) / listen (ZENOH_LISTEN) */
  connect?: string[]
  listen?: string[]
  /** Auto-discovery notifications — a peer appeared / aged out */
  onPeerJoin?: (peer: MeshPeer) => void
  onPeerLeave?: (peer: MeshPeer) => void
  /** A peer's command just arrived and is about to run on our agent */
  onPeerCommand?: (info: { from: string; turnId: string; command: string }) => void
  /** File-based registry so other local processes see the mesh (default: on) */
  registry?: MeshRegistry | false
}

const PEER_STALE_MS = 30_000
const HEARTBEAT_MS = 5_000
/** How often we age out peers even when nobody calls listPeers() */
const SWEEP_MS = 5_000

export class MeshNode {
  readonly instanceId: string
  private startedAt = new Date().toISOString()
  private session: any = null
  private peers = new Map<string, MeshPeer>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private registry: MeshRegistry | null
  private pending = new Map<string, {
    chunks: Map<string, string>
    results: { responder: string; result: string }[]
    resolve: () => void
    expected?: number
    onChunk?: (responder: string, chunk: string) => void
  }>()
  private opts: MeshOptions
  private running = false
  private subs: any[] = []

  constructor(opts: MeshOptions = {}) {
    this.opts = opts
    this.registry = opts.registry === false ? null : (opts.registry || defaultRegistry)
    this.instanceId = opts.instanceId
      || `${hostname().split('.')[0]}-${randomBytes(3).toString('hex')}`
  }

  get isRunning(): boolean { return this.running }

  async start(): Promise<void> {
    if (this.running) return
    const { Config, Session } = await import('@diskette/dialtone')

    const conf: any = { mode: 'peer', scouting: { multicast: { enabled: true } } }
    const connect = this.opts.connect || (process.env.ZENOH_CONNECT ? process.env.ZENOH_CONNECT.split(',') : [])
    const listen = this.opts.listen || (process.env.ZENOH_LISTEN ? process.env.ZENOH_LISTEN.split(',') : [])
    if (connect.length) conf.connect = { endpoints: connect }
    if (listen.length) conf.listen = { endpoints: listen }

    this.session = await Session.open(Config.fromJson5(JSON.stringify(conf)))
    this.running = true
    this.registry?.register(this.instanceId, 'zenoh', {
      hostname: hostname(),
      model: this.opts.modelLabel || 'tiny-tech',
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      is_self: true,   // → pid stamp; the flag itself is not persisted
      answers: !!this.opts.agentFactory,
    })

    // Subscriptions — same shapes as devduck's four subscribers
    await this.subscribe('devduck/presence/*', (d) => this.onPresence(d))
    await this.subscribe('devduck/broadcast', (d) => this.onCommand(d))
    await this.subscribe(`devduck/cmd/${this.instanceId}`, (d) => this.onCommand(d))
    await this.subscribe(`devduck/response/${this.instanceId}/*`, (d) => this.onResponse(d))

    // Presence heartbeat
    this.beat()
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS)

    // Age peers out on a timer (not only when someone asks) so onPeerLeave
    // fires the moment a peer goes quiet — devduck does this in its heartbeat.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.registry?.unregister(this.instanceId)
    // NOTE: we deliberately do NOT dispose subscribers or close the native
    // session here — dialtone's rust runtime panics (mutex poison → SIGSEGV)
    // when close() races an in-flight sub.recv(). The OS reclaims the session
    // at process exit, and peers age us out via the 30s presence staleness.
    this.subs.length = 0
    this.session = null
  }

  listPeers(): MeshPeer[] {
    this.sweep()
    return [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * Peers from THIS session plus any the file registry knows about (other tiny
   * processes on this machine, e.g. the daemon while you are in the repl).
   * Zenoh-seen peers win; registry-only ones are marked source:'registry'.
   */
  listAllPeers(): MeshPeer[] {
    const out = new Map<string, MeshPeer>()
    for (const p of this.listPeers()) out.set(p.instanceId, p)
    for (const e of this.registry?.live() || []) {
      if (e.id === this.instanceId || out.has(e.id)) continue
      const m = e.metadata || {}
      out.set(e.id, {
        instanceId: e.id,
        hostname: m.hostname || 'unknown',
        model: m.model,
        lastSeen: e.last_seen,
        cwd: m.cwd,
        platform: m.platform,
        tools: m.tools,
        toolCount: m.tool_count,
        systemPrompt: m.system_prompt,
        started: m.started,
        nodeVersion: m.node_version,
        pythonVersion: m.python_version,
        source: 'registry',
      })
    }
    return [...out.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** Expire stale peers, firing onPeerLeave for each. */
  private sweep(): void {
    const now = Date.now()
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_STALE_MS) {
        this.peers.delete(id)
        try { this.opts.onPeerLeave?.(p) } catch {}
      }
    }
  }

  /**
   * Broadcast a command to every peer; resolves when EVERY peer that was known
   * at send time has finished (or the timeout hits) — not on the first reply,
   * which is what devduck settles for and why fan-out answers got lost.
   */
  async broadcast(message: string, waitTimeMs = 60_000, onChunk?: (responder: string, chunk: string) => void, hop = 0): Promise<{ responder: string; result: string }[]> {
    // Count the peers the CALLER can see (mesh_peers shows listAllPeers), not
    // just the zenoh-session ones — otherwise a fan-out settles early and the
    // registry-only nodes' answers arrive after we stopped listening.
    const expected = this.listAllPeers().length || 1
    return this.dispatch('devduck/broadcast', message, waitTimeMs, onChunk, expected, hop)
  }

  /** Send a command to one peer. */
  async send(peerId: string, message: string, waitTimeMs = 60_000, onChunk?: (responder: string, chunk: string) => void, hop = 0): Promise<{ responder: string; result: string }[]> {
    return this.dispatch(`devduck/cmd/${peerId}`, message, waitTimeMs, onChunk, 1, hop)
  }

  /**
   * Update what presence advertises and beat immediately.
   *
   * Tools are announced from a snapshot taken when the node was constructed,
   * but the daemon starts its mesh BEFORE any agent exists — so it announced
   * `tool_count: 0` forever and stayed that way, which made capability-based
   * routing skip a fully loaded node. Whoever learns the real surface calls
   * this, and the next heartbeat (this one) tells the mesh.
   */
  /**
   * Swap the peer-event handlers after construction. The TUI needs this: the
   * mesh is started BEFORE Ink renders (repl.ts owns maybeStartMesh), but the
   * stderr announcements it installs there corrupt an Ink-owned screen — so
   * the TUI silences them at start and re-points the events at React state.
   */
  setHandlers(h: { onPeerJoin?: MeshOptions['onPeerJoin'] | null; onPeerLeave?: MeshOptions['onPeerLeave'] | null; onPeerCommand?: MeshOptions['onPeerCommand'] | null }): void {
    if (h.onPeerJoin !== undefined) this.opts.onPeerJoin = h.onPeerJoin || undefined
    if (h.onPeerLeave !== undefined) this.opts.onPeerLeave = h.onPeerLeave || undefined
    if (h.onPeerCommand !== undefined) this.opts.onPeerCommand = h.onPeerCommand || undefined
  }

  setPresence(p: { tools?: string[]; modelLabel?: string; systemPromptSummary?: string }): void {
    if (p.tools) this.opts.tools = p.tools
    if (p.modelLabel) this.opts.modelLabel = p.modelLabel
    if (p.systemPromptSummary) this.opts.systemPromptSummary = p.systemPromptSummary
    if (this.running) this.beat()
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async subscribe(keyExpr: string, handler: (data: any) => void): Promise<void> {
    const sub = await this.session.declareSubscriber(keyExpr)
    this.subs.push(sub)
    ;(async () => {
      while (this.running) {
        let sample: any
        try { sample = await sub.recv() } catch { break }
        if (!sample) break
        try {
          const payload = Buffer.from(sample.payload.toBytes()).toString('utf8')
          handler(JSON.parse(payload))
        } catch { /* non-JSON or foreign sample — ignore */ }
      }
    })()
  }

  private publish(keyExpr: string, data: any): void {
    try { this.session?.put(keyExpr, JSON.stringify(data)) } catch {}
  }

  /** Publish presence once — to the mesh and to the local file registry. */
  private beat(): void {
    const tools = this.opts.tools || []
    const presence = {
      instance_id: this.instanceId,
      hostname: hostname(),
      model: this.opts.modelLabel || 'tiny-tech',
      timestamp: Date.now() / 1000,
      platform: `${process.platform}-${process.arch}`,
      cwd: process.cwd(),
      // devduck-compatible enrichment (matches zenoh_peer heartbeat shape)
      started: this.startedAt,
      tools: tools.slice(0, 50),     // cap — heartbeats stay small
      tool_count: tools.length,
      system_prompt: this.opts.systemPromptSummary || '',
      python_version: '',           // n/a — node runtime
      node_version: process.version,
    }
    this.publish(`devduck/presence/${this.instanceId}`, presence)
    // Local registry: let every other tiny process on this box see us
    this.registry?.heartbeat(this.instanceId, {
      hostname: presence.hostname,
      model: presence.model,
      platform: presence.platform,
      cwd: presence.cwd,
      tools: presence.tools,
      tool_count: presence.tool_count,
      system_prompt: presence.system_prompt,
      node_version: presence.node_version,
      started: presence.started,
      is_self: true,   // → pid stamp; the flag itself is not persisted
      peers_count: this.peers.size,
    })
  }

  private onPresence(d: any): void {
    const id = d?.instance_id
    if (!id || id === this.instanceId) return
    // Clamp foreign presence BEFORE it enters our peer map or the registry:
    // devduck heartbeats carry a whole system prompt (source code included —
    // 356 KB measured), and the registry re-serializes every entry every 5s.
    const identity = typeof d.system_prompt === 'string'
      ? (d.system_prompt.length > IDENTITY_MAX_CHARS ? d.system_prompt.slice(0, IDENTITY_MAX_CHARS) + '…' : d.system_prompt)
      : undefined
    const tools = Array.isArray(d.tools) ? d.tools.slice(0, TOOLS_MAX) : undefined
    const prev = this.peers.get(id)
    const isNew = !prev
    // Merge, don't clobber: a lean heartbeat must not erase rich presence a
    // peer sent earlier (foreign nodes don't all resend tools every 5s).
    const peer: MeshPeer = {
      ...(prev || {} as MeshPeer),
      instanceId: id,
      hostname: d.hostname || prev?.hostname || 'unknown',
      model: d.model || prev?.model,
      lastSeen: Date.now(),
      cwd: d.cwd || prev?.cwd,
      platform: d.platform || prev?.platform,
      tools: tools || prev?.tools,
      toolCount: typeof d.tool_count === 'number' ? d.tool_count : prev?.toolCount,
      systemPrompt: identity || prev?.systemPrompt,
      started: d.started || prev?.started,
      nodeVersion: d.node_version || prev?.nodeVersion,
      pythonVersion: d.python_version || prev?.pythonVersion,
      source: 'zenoh',
    }
    this.peers.set(id, peer)

    if (isNew) {
      // Mirror the discovery into the local registry so processes that never
      // opened a session (MCP server, `tiny-tech mesh peers`) still see it.
      this.registry?.register(id, 'zenoh', {
        hostname: peer.hostname, model: peer.model, platform: peer.platform,
        cwd: peer.cwd, tools: peer.tools, tool_count: peer.toolCount,
        system_prompt: peer.systemPrompt, started: peer.started,
        node_version: peer.nodeVersion, python_version: peer.pythonVersion,
        discovered_by: this.instanceId,
      })
      try { this.opts.onPeerJoin?.(peer) } catch {}
    } else {
      this.registry?.heartbeat(id)
    }
  }

  private async onCommand(d: any): Promise<void> {
    const senderId = d?.sender_id
    const turnId = d?.turn_id
    const command = d?.command
    if (!senderId || !turnId || !command || senderId === this.instanceId) return

    const responseKey = `devduck/response/${senderId}/${turnId}`
    try { this.opts.onPeerCommand?.({ from: senderId, turnId, command }) } catch {}
    this.publish(responseKey, {
      type: 'ack', responder_id: this.instanceId, turn_id: turnId, timestamp: Date.now() / 1000,
    })

    if (!this.opts.agentFactory) {
      this.publish(responseKey, {
        type: 'error', responder_id: this.instanceId, turn_id: turnId,
        error: 'tiny-tech node has no agent attached (mesh-only mode)', timestamp: Date.now() / 1000,
      })
      return
    }

    // How far this request has already travelled. A foreign sender (devduck)
    // sends no hop field at all — treat that as leg 1, the common case: a human
    // asked one node, that node asked us.
    const hop = Math.max(1, Number(d.hop) || 1)
    if (hop > MESH_MAX_HOPS) {
      // Refuse politely instead of silently doing it anyway: the requester sees
      // WHY the chain stopped, and the mesh cannot amplify past the cap.
      this.publish(responseKey, {
        type: 'error', responder_id: this.instanceId, turn_id: turnId,
        error: `mesh hop limit reached (hop ${hop} > TINY_MESH_MAX_HOPS ${MESH_MAX_HOPS}) — refusing to relay further`,
        timestamp: Date.now() / 1000,
      })
      return
    }

    try {
      // Fresh agent per command — same reason devduck news up a DevDuck:
      // concurrent invocations on one agent throw.
      const agent = await this.opts.agentFactory({ hop, from: senderId, turnId })
      let chunks = 0
      const emit = (data: string, chunkType: 'text' | 'reasoning' | 'tool') => {
        if (!data) return
        this.publish(responseKey, {
          type: 'stream', chunk_type: chunkType, responder_id: this.instanceId,
          turn_id: turnId, chunk_num: ++chunks, data, timestamp: Date.now() / 1000,
        })
      }

      let result = ''
      if (typeof agent.streamTurn === 'function') {
        // Real streaming — the requester sees text as it is generated, and the
        // same 🛠️ tool lines devduck's callback handler publishes.
        for await (const ev of agent.streamTurn(command)) {
          if (ev?.kind === 'text' && ev.text) { result += ev.text; emit(ev.text, 'text') }
          else if (ev?.kind === 'reasoning' && ev.text) emit(ev.text, 'reasoning')
          else if (ev?.kind === 'tool_start' && ev.name) emit(`\n🛠️  ${ev.name}\n`, 'tool')
          else if (ev?.kind === 'tool_end') emit(ev.error ? `❌ ${ev.name}: ${ev.error}\n` : `✅ ${ev.name}\n`, 'tool')
          // A notice is a handled hiccup, an error is a failed turn — both worth
          // saying out loud to whoever is watching from the other end of the mesh.
          else if ((ev?.kind === 'notice' || ev?.kind === 'error') && ev.message) emit(`\n⚠️  ${ev.message}\n`, 'text')
          else if (ev?.kind === 'done' && ev.text) result = ev.text
        }
      } else {
        result = await agent.invoke(command)
        emit(result, 'text') // buffered responder — one chunk, then turn_end
      }

      this.publish(responseKey, {
        type: 'turn_end', responder_id: this.instanceId, turn_id: turnId,
        result, chunks_sent: chunks, timestamp: Date.now() / 1000,
      })
    } catch (e: any) {
      this.publish(responseKey, {
        type: 'error', responder_id: this.instanceId, turn_id: turnId,
        error: String(e?.message || e), timestamp: Date.now() / 1000,
      })
    }
  }

  private onResponse(d: any): void {
    const turnId = d?.turn_id
    const responder = d?.responder_id
    const entry = turnId ? this.pending.get(turnId) : undefined
    if (!entry || !responder) return

    if (d.type === 'stream' && d.data) {
      entry.chunks.set(responder, (entry.chunks.get(responder) || '') + d.data)
      entry.onChunk?.(responder, d.data)
    } else if (d.type === 'turn_end') {
      entry.results.push({ responder, result: d.result || entry.chunks.get(responder) || '' })
      entry.resolve()
    } else if (d.type === 'error') {
      entry.results.push({ responder, result: `Error: ${d.error}` })
      entry.resolve()
    }
  }

  private async dispatch(keyExpr: string, message: string, waitTimeMs: number, onChunk?: (responder: string, chunk: string) => void, expected = 1, hop = 0): Promise<{ responder: string; result: string }[]> {
    if (!this.running) throw new Error('mesh not started')
    const turnId = randomBytes(4).toString('hex')

    let resolveOuter: () => void = () => {}
    const done = new Promise<void>((res) => { resolveOuter = res })
    const entry = {
      chunks: new Map<string, string>(),
      results: [] as { responder: string; result: string }[],
      // Only settle once every expected responder is in
      resolve: () => { if (entry.results.length >= (entry.expected || 1)) resolveOuter() },
      expected,
      onChunk,
    }
    this.pending.set(turnId, entry)

    this.publish(keyExpr, {
      sender_id: this.instanceId, turn_id: turnId, command: message,
      // One more leg than the turn that asked for it. Foreign nodes ignore the
      // field; tiny-tech peers use it to decide what the responder may do.
      hop: hop + 1,
      timestamp: Date.now() / 1000,
    })

    // Resolve on first turn_end/error OR timeout — matches devduck broadcast
    await Promise.race([done, new Promise((r) => setTimeout(r, waitTimeMs))])
    // Small grace window for stragglers already mid-stream
    await new Promise((r) => setTimeout(r, 250))

    this.pending.delete(turnId)
    // Merge chunk-only responders (streamed but no turn_end within window)
    for (const [responder, text] of entry.chunks) {
      if (!entry.results.find((x) => x.responder === responder)) {
        entry.results.push({ responder, result: text })
      }
    }
    return entry.results
  }
}
