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

export interface MeshPeer {
  instanceId: string
  hostname: string
  model?: string
  lastSeen: number
  cwd?: string
  platform?: string
}

export interface MeshOptions {
  /** Answer incoming commands with this factory's agent (fresh per command) */
  agentFactory?: () => Promise<{ invoke: (q: string) => Promise<string> }>
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
}

const PEER_STALE_MS = 30_000
const HEARTBEAT_MS = 5_000

export class MeshNode {
  readonly instanceId: string
  private startedAt = new Date().toISOString()
  private session: any = null
  private peers = new Map<string, MeshPeer>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
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

    // Subscriptions — same shapes as devduck's four subscribers
    await this.subscribe('devduck/presence/*', (d) => this.onPresence(d))
    await this.subscribe('devduck/broadcast', (d) => this.onCommand(d))
    await this.subscribe(`devduck/cmd/${this.instanceId}`, (d) => this.onCommand(d))
    await this.subscribe(`devduck/response/${this.instanceId}/*`, (d) => this.onResponse(d))

    // Presence heartbeat
    const beat = () => {
      const tools = this.opts.tools || []
      this.publish(`devduck/presence/${this.instanceId}`, {
        instance_id: this.instanceId,
        hostname: hostname(),
        model: this.opts.modelLabel || 'tiny-tech',
        timestamp: Date.now() / 1000,
        platform: `${process.platform}-${process.arch}`,
        cwd: process.cwd(),
        // devduck-compatible enrichment (matches zenoh_peer heartbeat shape)
        started: this.startedAt,
        tools,
        tool_count: tools.length,
        system_prompt: this.opts.systemPromptSummary || '',
        python_version: '',           // n/a — node runtime
        node_version: process.version,
      })
    }
    beat()
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_MS)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // NOTE: we deliberately do NOT dispose subscribers or close the native
    // session here — dialtone's rust runtime panics (mutex poison → SIGSEGV)
    // when close() races an in-flight sub.recv(). The OS reclaims the session
    // at process exit, and peers age us out via the 30s presence staleness.
    this.subs.length = 0
    this.session = null
  }

  listPeers(): MeshPeer[] {
    const now = Date.now()
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_STALE_MS) this.peers.delete(id)
    }
    return [...this.peers.values()]
  }

  /** Broadcast a command to every peer; resolves with streamed responses. */
  async broadcast(message: string, waitTimeMs = 60_000, onChunk?: (responder: string, chunk: string) => void): Promise<{ responder: string; result: string }[]> {
    return this.dispatch('devduck/broadcast', message, waitTimeMs, onChunk)
  }

  /** Send a command to one peer. */
  async send(peerId: string, message: string, waitTimeMs = 60_000, onChunk?: (responder: string, chunk: string) => void): Promise<{ responder: string; result: string }[]> {
    return this.dispatch(`devduck/cmd/${peerId}`, message, waitTimeMs, onChunk)
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

  private onPresence(d: any): void {
    const id = d?.instance_id
    if (!id || id === this.instanceId) return
    this.peers.set(id, {
      instanceId: id,
      hostname: d.hostname || 'unknown',
      model: d.model,
      lastSeen: Date.now(),
      cwd: d.cwd,
      platform: d.platform,
    })
  }

  private async onCommand(d: any): Promise<void> {
    const senderId = d?.sender_id
    const turnId = d?.turn_id
    const command = d?.command
    if (!senderId || !turnId || !command || senderId === this.instanceId) return

    const responseKey = `devduck/response/${senderId}/${turnId}`
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

    try {
      // Fresh agent per command — same reason devduck news up a DevDuck:
      // concurrent invocations on one agent throw.
      const agent = await this.opts.agentFactory()
      const result = await agent.invoke(command)
      // Single stream chunk (buffered) + turn_end — readers accept both
      // fully-streamed and buffered responders.
      this.publish(responseKey, {
        type: 'stream', chunk_type: 'text', responder_id: this.instanceId,
        turn_id: turnId, chunk_num: 1, data: result, timestamp: Date.now() / 1000,
      })
      this.publish(responseKey, {
        type: 'turn_end', responder_id: this.instanceId, turn_id: turnId,
        result, chunks_sent: 1, timestamp: Date.now() / 1000,
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

  private async dispatch(keyExpr: string, message: string, waitTimeMs: number, onChunk?: (responder: string, chunk: string) => void): Promise<{ responder: string; result: string }[]> {
    if (!this.running) throw new Error('mesh not started')
    const turnId = randomBytes(4).toString('hex')

    let resolveOuter: () => void = () => {}
    const done = new Promise<void>((res) => { resolveOuter = res })
    const entry = {
      chunks: new Map<string, string>(),
      results: [] as { responder: string; result: string }[],
      resolve: () => resolveOuter(),
      onChunk,
    }
    this.pending.set(turnId, entry)

    this.publish(keyExpr, {
      sender_id: this.instanceId, turn_id: turnId, command: message, timestamp: Date.now() / 1000,
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
