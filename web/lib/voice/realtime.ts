/**
 * Web voice-call client core (docs/voice-sessions-design.md).
 *
 * Talks to the worker's VoiceSession Durable Object over a single WebSocket:
 *   - up:   mic PCM16 @ 24 kHz as binary frames (input_audio_buffer.append is
 *           done server-side; we just send raw bytes)
 *   - down: assistant audio as binary PCM16 frames → queued + played back;
 *           JSON control frames (transcripts, barge_in, error)
 *
 * The DO does semantic VAD, tool routing, and journaling — the browser stays
 * dumb: capture, send, play, render transcript. Barge-in = flush local
 * playback the moment the server says the user started talking.
 *
 * Pure of React — a small event-emitter the /voice page subscribes to.
 */

const SAMPLE_RATE = 24000

export type VoiceEvent =
  | { type: 'status'; status: VoiceStatus }
  | { type: 'user_transcript'; text: string }
  | { type: 'assistant_transcript'; delta: string }
  | { type: 'response_started' } // a fresh assistant turn began
  | { type: 'response_done' } // the assistant turn finished
  | { type: 'barge_in' }
  | { type: 'error'; error: string }
  | { type: 'level'; level: number } // mic input level 0..1 for a meter
  // The model called a tool (inline-chat bridge): execute with the same
  // client executors chat uses, then reply via sendToolResult(id, output).
  | { type: 'tool_call'; id: string; name: string; args: any }

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'ended' | 'error'

type Listener = (e: VoiceEvent) => void

/** Float32 [-1,1] → Int16 PCM little-endian. */
function floatToPCM16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

/** Int16 PCM bytes → Float32 [-1,1] for Web Audio playback. */
function pcm16ToFloat(buf: ArrayBuffer): Float32Array {
  const view = new Int16Array(buf)
  const out = new Float32Array(view.length)
  for (let i = 0; i < view.length; i++) out[i] = view[i] / 0x8000
  return out
}

export class VoiceCall {
  private ws: WebSocket | null = null
  private ctxIn: AudioContext | null = null
  private ctxOut: AudioContext | null = null
  private micStream: MediaStream | null = null
  private micNode: AudioWorkletNode | ScriptProcessorNode | null = null
  private srcNode: MediaStreamAudioSourceNode | null = null
  private listeners = new Set<Listener>()
  private status: VoiceStatus = 'idle'
  // Aborts the in-flight session fetch if the user cancels (or we time out)
  // before the WS is up — otherwise a hung request could flip status later.
  private startAbort: AbortController | null = null

  // Sequential playback scheduling.
  private playHead = 0
  private queued: AudioBufferSourceNode[] = []

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit(e: VoiceEvent) { this.listeners.forEach((l) => l(e)) }
  private setStatus(s: VoiceStatus) { this.status = s; this.emit({ type: 'status', status: s }) }

  /** Start a call: ask the app for a session, open the WS, wire mic + playback.
   *  `context` is the client-built continuity block (memories + recent turns)
   *  so the voice agent starts knowing what the chat agent knows. */
  async start(tiny: string, headers: Record<string, string>, context?: string): Promise<void> {
    if (this.status === 'connecting' || this.status === 'live') return
    this.setStatus('connecting')
    const abort = new AbortController()
    this.startAbort = abort
    // Don't let a wedged session mint hang the orb on "Connecting…" forever.
    const timeout = setTimeout(() => abort.abort(), 15000)
    try {
      const res = await fetch('/api/voice/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ tiny, ...(context ? { context } : {}) }),
        signal: abort.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.wsUrl) {
        this.emit({ type: 'error', error: data?.error || 'could not start call' })
        this.setStatus('error')
        return
      }
      await this.openMic()
      await this.connect(data.wsUrl)
    } catch (err: any) {
      // A user cancel / timeout aborts the fetch; that's not an error banner —
      // stop() has already (or will) set status to 'ended'.
      if (abort.signal.aborted) { this.stop(); return }
      this.emit({ type: 'error', error: String(err?.message || err) })
      this.setStatus('error')
      this.stop()
    } finally {
      clearTimeout(timeout)
      if (this.startAbort === abort) this.startAbort = null
    }
  }

  private async openMic() {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    })
    // Capture context at 24 kHz so frames match the model's PCM rate exactly —
    // no resampling on the wire.
    this.ctxIn = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.ctxOut = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.srcNode = this.ctxIn.createMediaStreamSource(this.micStream)

    // Prefer an AudioWorklet; fall back to ScriptProcessor on older browsers.
    try {
      await this.ctxIn.audioWorklet.addModule('/voice-capture-worklet.js')
      const node = new AudioWorkletNode(this.ctxIn, 'voice-capture')
      node.port.onmessage = (ev) => this.onMicFrame(ev.data as Float32Array)
      this.srcNode.connect(node)
      // Worklet needs a sink to pull; a muted gain keeps it running silently.
      const sink = this.ctxIn.createGain()
      sink.gain.value = 0
      node.connect(sink).connect(this.ctxIn.destination)
      this.micNode = node
    } catch {
      const node = this.ctxIn.createScriptProcessor(2048, 1, 1)
      node.onaudioprocess = (ev) => this.onMicFrame(ev.inputBuffer.getChannelData(0))
      this.srcNode.connect(node)
      node.connect(this.ctxIn.destination)
      this.micNode = node
    }
  }

  private onMicFrame(frame: Float32Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Cheap RMS level for a mic meter.
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    this.emit({ type: 'level', level: Math.min(1, Math.sqrt(sum / frame.length) * 4) })
    this.ws.send(floatToPCM16(frame))
  }

  private connect(wsUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      ws.onopen = () => { this.setStatus('live'); resolve() }
      ws.onmessage = (ev) => this.onServerMessage(ev.data)
      ws.onerror = () => { this.emit({ type: 'error', error: 'connection error' }) }
      ws.onclose = () => { if (this.status === 'live') this.setStatus('ended'); this.stop() }
    })
  }

  private onServerMessage(data: any) {
    if (typeof data === 'string') {
      let msg: any
      try { msg = JSON.parse(data) } catch { return }
      switch (msg?.type) {
        case 'user_transcript': this.emit({ type: 'user_transcript', text: msg.text || '' }); break
        case 'assistant_transcript': this.emit({ type: 'assistant_transcript', delta: msg.delta || '' }); break
        case 'response_started': this.emit({ type: 'response_started' }); break
        case 'response_done': this.emit({ type: 'response_done' }); break
        case 'barge_in': this.flushPlayback(); this.emit({ type: 'barge_in' }); break
        case 'tool_call':
          this.emit({ type: 'tool_call', id: msg.id || '', name: msg.name || '', args: msg.args ?? {} })
          break
        case 'error': this.emit({ type: 'error', error: msg.error || 'error' }); break
      }
      return
    }
    // Binary = assistant PCM16 audio → schedule playback.
    this.playAudio(data as ArrayBuffer)
  }

  private playAudio(buf: ArrayBuffer) {
    const ctx = this.ctxOut
    if (!ctx) return
    const float = pcm16ToFloat(buf)
    if (!float.length) return
    const audioBuf = ctx.createBuffer(1, float.length, SAMPLE_RATE)
    audioBuf.copyToChannel(float, 0)
    const src = ctx.createBufferSource()
    src.buffer = audioBuf
    src.connect(ctx.destination)
    // Schedule back-to-back so frames stitch without gaps.
    const now = ctx.currentTime
    const at = Math.max(now, this.playHead)
    src.start(at)
    this.playHead = at + audioBuf.duration
    this.queued.push(src)
    src.onended = () => { this.queued = this.queued.filter((s) => s !== src) }
  }

  /** True while the socket is up — the chat surface routes composer text
   *  into the call (sendUserText) instead of the normal chat turn. */
  get live(): boolean {
    return this.status === 'live' && this.ws?.readyState === WebSocket.OPEN
  }

  /** Composer→call bridge: a TYPED message joins the live conversation as a
   *  user turn — the tiny hears it and answers in voice. The caller renders
   *  its own local copy; nothing echoes back. */
  sendUserText(text: string): boolean {
    if (!this.live || !text.trim()) return false
    try { this.ws!.send(JSON.stringify({ type: 'user_text', text: text.trim() })); return true } catch { return false }
  }

  /** Reply to a tool_call event once the client executor finishes. */
  sendToolResult(id: string, output: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const out = typeof output === 'string' ? output : JSON.stringify(output ?? {})
    try { this.ws.send(JSON.stringify({ type: 'tool_result', id, output: out })) } catch { /* closing */ }
  }

  /** Barge-in: stop everything queued and reset the play head to "now". */
  private flushPlayback() {
    this.queued.forEach((s) => { try { s.stop() } catch { /* already stopped */ } })
    this.queued = []
    this.playHead = this.ctxOut?.currentTime || 0
  }

  stop() {
    try { this.startAbort?.abort() } catch { }
    this.startAbort = null
    try { this.ws?.close() } catch { }
    this.ws = null
    this.flushPlayback()
    try { this.micNode?.disconnect() } catch { }
    try { this.srcNode?.disconnect() } catch { }
    try { this.micStream?.getTracks().forEach((t) => t.stop()) } catch { }
    try { this.ctxIn?.close() } catch { }
    try { this.ctxOut?.close() } catch { }
    this.micNode = this.srcNode = this.micStream = this.ctxIn = this.ctxOut = null
    if (this.status !== 'error') this.setStatus('ended')
  }
}
