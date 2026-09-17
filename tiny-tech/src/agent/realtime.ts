/**
 * 📞 Real speech-to-speech in the terminal — gpt-realtime, no turn-taking fake.
 *
 * This is the CLI port of the web/iOS voice call (docs/voice-sessions-design.md
 * in tinyai-id): audio tokens in → audio tokens out, semantic VAD, barge-in,
 * mid-speech tool calls. It is deliberately NOT `speech.ts` scaled up. That path
 * is listen → transcribe → think → say, four serial round trips with a
 * transcription bottleneck in the middle; you can hear the seams, you cannot
 * interrupt it, and the model never hears HOW something was said. Realtime is
 * one socket that is always both listening and speaking.
 *
 * ── the topology is different here, and simpler ────────────────────────────
 * On the web, three parties are needed: browser ⇄ Durable Object ⇄ OpenAI. The
 * DO exists because the browser must never see the API key and the server wants
 * the durable record. A CLI collapses that:
 *
 *      terminal (mic ⇄ speaker)  ──WebSocket──▶  gpt-realtime-2.1-mini
 *              this file: relay + brain + tool executor
 *
 * The key is already local (the same OPENAI_API_KEY the CLI's model factory
 * reads), so there is nothing to hide from ourselves and no hop to pay for. And
 * unlike the browser, this client is not dumb: the tools the voice agent calls
 * are the SAME Strands tool objects this process already has mounted, so a
 * spoken "what's on my screen?" runs use_computer locally and answers in the
 * same breath — no tool_call/tool_result bridge over a wire at all.
 *
 * ── ported wholesale: the lessons that cost live debugging ──────────────────
 * Everything below is a scar from the DO (worker/src/voice.ts),
 * kept because each one only shows up on a real call:
 *
 *  1. `speech_started` is NOT always a barge-in. With semantic VAD, the first
 *     word of EVERY turn fires it while nothing is generating; answering with
 *     `response.cancel` then makes OpenAI reply "no active response", which the
 *     UI shows as an error banner on essentially every call. Gate cancel and
 *     truncate on a response actually being in flight — but ALWAYS flush local
 *     playback, because generation finishing is seconds before the speaker
 *     finishes.
 *  2. After a cancel, audio deltas keep arriving for a beat — our cancel and
 *     their stream cross on the wire. Those belong to the reply the person
 *     interrupted, so they are dropped (`suppressAudio`), or the flushed queue
 *     replays a blip of the interrupted sentence.
 *  3. `conversation.item.truncate` must report how much audio actually PLAYED
 *     (assistantAudioMs, at 48 bytes/ms) or the model's memory of the call
 *     diverges from what the human heard.
 *  4. `response_cancel_not_active` is journaled and never surfaced.
 *  5. GA event names (`response.output_audio.*`) with the beta names
 *     (`response.audio.*`) kept as fallbacks, so a pinned older model still
 *     plays.
 *  6. The session is configured with the GA nested shape — `session.audio.
 *     {input,output}`, not the old flat `modalities`/`input_audio_format`.
 *
 * ── what the terminal adds ─────────────────────────────────────────────────
 * Half-duplex mic gating (audio.ts explains the echo physics), and `onTurn`:
 * every completed exchange is handed back as text so it can be absorbed into
 * the CLI agent's own message history. That is the goal that makes voice worth
 * having in a coding agent — you talk, and the typed session KNOWS what you
 * said, because a call that leaves no trace in the transcript is a toy.
 */
import { Buffer } from 'node:buffer'
import {
  openMic, openSpeaker, detectBackend, missingAudioHint, frameLevel, BYTES_PER_MS,
  type Mic, type Speaker, type AudioBackend,
} from './audio.js'

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime'
/** The model the whole product is pinned to — cheapest true speech-to-speech. */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1-mini'
/** The API's own roster; anything else is silently ignored by the service. */
export const VOICE_NAMES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const
/** OpenAI's own cap on a realtime session. */
export const MAX_CALL_MS = 60 * 60 * 1000
/** The DO's tool cap, kept: a 200-tool roster is a session.update rejection. */
export const MAX_TOOLS = 64
/** How long after the assistant's audio drains the mic stays gated (half
 *  duplex): the speaker's own tail still reaches the microphone. */
export const ECHO_TAIL_MS = 400

/**
 * ── who decides an interruption: the model. Full duplex is the default ──────
 *
 * The server's semantic VAD hears you talk over a reply, cancels that reply
 * itself (`interrupt_response`) and answers the new thing. That is native
 * behaviour, it is what the iOS app relies on, and it is strictly better than
 * anything a client can infer from frame amplitudes. It has exactly one
 * requirement: the audio has to reach it.
 *
 * The first port got that backwards. It shipped half duplex ON — every mic frame
 * dropped while the speaker was audible — to stop a laptop hearing itself. The
 * cost was the feature: you could not interrupt at all, and not because the
 * model ignored you. It never heard you. Reported from a real call, "when I
 * started speaking the model should handle the interrupt", and that is right.
 *
 * So the mic now streams continuously and the native VAD does its job. Echo
 * suppression is the opt-IN (`TINY_VOICE_HALF_DUPLEX=1`, `--half-duplex`), for
 * the one setup where physics beats us: built-in speaker into built-in mic, no
 * OS acoustic echo cancellation, where the tiny transcribes itself as your next
 * turn (audio.ts has the physics).
 *
 * ── and in that mode the gate is a DOOR, not a wall ─────────────────────────
 * Even there, dropping everything is too blunt. While our speaker is audible the
 * only thing the mic should hear is that speaker leaking back, so every frame we
 * drop is also a MEASUREMENT of the echo — an adaptive floor. A frame well above
 * that floor is a person leaning in; it opens the door for the rest of the turn.
 *
 * Two guards keep an echo peak or a keyboard click from opening it:
 *   · BARGE_MARGIN — how far above the measured echo a frame must be
 *   · BARGE_FRAMES — how many in a row (a click is one frame; a syllable is many)
 * and one keeps a false positive cheap: opening the door does NOT cancel the
 * reply. It decides one thing only — "is this frame worth sending" — and the
 * server still decides what it means. A wrong guess costs a few frames of echo
 * sent to OpenAI; a wrong guess in the other direction would truncate an answer
 * nobody interrupted.
 *
 * All of them are env-tunable because the right numbers depend on a room, a mic
 * gain and a speaker volume — things this process cannot see.
 */
export const BARGE_MARGIN = Number(process.env.TINY_VOICE_BARGE_MARGIN || 2.5)
/** Absolute floor (frameLevel units) below which nothing counts as speech —
 *  stops a silent room's noise from ratioing its way past a near-zero echo. */
export const BARGE_FLOOR = Number(process.env.TINY_VOICE_BARGE_FLOOR || 0.05)
/** Consecutive loud frames needed. At 20 ms a frame, 3 ≈ 60 ms — a syllable. */
export const BARGE_FRAMES = Number(process.env.TINY_VOICE_BARGE_FRAMES || 3)
/** How fast the measured echo floor forgets a loud passage, per frame. */
export const ECHO_DECAY = 0.97
/**
 * Frames at the top of each spoken reply that are measured and never believed.
 *
 * Cold start is the one way this scheme could self-destruct: the instant the
 * speaker opens up, the measured floor is stale-low, so the reply's own first
 * syllables clear any margin and the tiny interrupts itself on every sentence —
 * the exact failure half duplex exists to prevent. So the first ~200 ms of every
 * speaking window is measurement only. It costs a barge-in nobody attempts (a
 * person is not talking over a word that has not been said yet) and it buys a
 * floor that is about this room, this volume, right now.
 */
export const ECHO_LEARN_FRAMES = Number(process.env.TINY_VOICE_ECHO_LEARN || 10)

/**
 * How long a turn may hang between "you started talking" and any sign the model
 * intends to answer, before we close it ourselves.
 *
 * Scar 5, and the only one found by talking to the real API rather than reading
 * the DO: semantic VAD does not always close a turn. On some utterances the
 * server sends `input_audio_buffer.speech_started` and then nothing — no
 * speech_stopped, no commit, no response, no error, forever, with the socket
 * healthy and still billing. Reproduced on a bare WebSocket with no client code
 * in the path, so it is not ours to fix, only ours to survive: an unanswered
 * turn is the single worst thing voice can do, because the person has no way to
 * tell "thinking" from "wedged" and their only move is to hang up.
 */
export const TURN_STALL_MS = Number(process.env.TINY_VOICE_TURN_STALL_MS || 8000)

export type RealtimeStatus = 'idle' | 'connecting' | 'live' | 'ended' | 'error'

/** What a surface (TUI strip, REPL printer, headless log) renders. Mirrors the
 *  web client's VoiceEvent so all four surfaces speak one vocabulary. */
export type RealtimeEvent =
  | { type: 'status'; status: RealtimeStatus }
  | { type: 'user_transcript'; text: string }
  | { type: 'assistant_transcript'; delta: string }
  | { type: 'response_started' }
  | { type: 'response_done' }
  | { type: 'barge_in' }
  | { type: 'level'; level: number }
  | { type: 'tool_call'; id: string; name: string; args: any }
  | { type: 'tool_result'; id: string; name: string; output: string }
  | { type: 'error'; error: string }
  /** A completed exchange, for absorbing into the typed session's history.
   *  `continuation` = the model spoke again without the person saying anything
   *  new (it answered, ran a tool, then kept talking). Those turns have no user
   *  side, and a surface that pretends otherwise writes a fake question into the
   *  history — seen on the very first live call. */
  | { type: 'turn'; user: string; assistant: string; continuation: boolean }

export type RealtimeTool = {
  type: 'function'
  name: string
  description: string
  parameters: any
}

/** Strands tool → realtime function tool. `toolSpec.inputSchema` is already
 *  plain JSON Schema, so there is no zod at this call site (same conversion
 *  the web app's lib/voice/tools.ts does). */
export function toRealtimeTool(t: any): RealtimeTool {
  return {
    type: 'function',
    name: String(t?.toolSpec?.name ?? t?.name ?? ''),
    description: String(t?.toolSpec?.description ?? t?.description ?? '').slice(0, 1024),
    parameters: t?.toolSpec?.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
  }
}

/** Resolve the requested voice, falling back to the product default. */
export function resolveVoice(want?: string): string {
  const v = String(want || process.env.TINY_VOICE || '').toLowerCase()
  return (VOICE_NAMES as readonly string[]).includes(v) ? v : 'marin'
}

/** Which of the API's own noise-reduction profiles to ask for, or null for raw. */
export function resolveNoiseReduction(): 'near_field' | 'far_field' | null {
  const v = String(process.env.TINY_VOICE_NOISE_REDUCTION || 'near_field').toLowerCase()
  if (v === 'off' || v === 'none' || v === '0') return null
  return v === 'far_field' ? 'far_field' : 'near_field'
}

/**
 * Is the mic allowed to stream while the tiny is talking? Default YES.
 *
 * One place, because this is the policy the barge-in bug was hiding in: the
 * native VAD cannot honour an interruption it was never sent. `--interrupt` and
 * TINY_VOICE_FULL_DUPLEX=1 remain as explicit yeses (they used to be the only
 * way), TINY_VOICE_HALF_DUPLEX=1 / `--half-duplex` is the opt-out for a machine
 * whose speaker feeds its own microphone.
 */
export function resolveFullDuplex(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit
  if (process.env.TINY_VOICE_FULL_DUPLEX === '1') return true
  return process.env.TINY_VOICE_HALF_DUPLEX !== '1'
}

/**
 * The `session.update` frame — GA schema, nested audio config.
 *
 * A pure builder so the shape is testable without a socket: getting this frame
 * wrong is not a soft failure, it is a call where the model answers in text
 * while the person waits for a voice.
 */
export function buildSessionUpdate(opts: {
  instructions: string
  voice?: string
  tools?: RealtimeTool[]
}): any {
  const tools = (opts.tools || []).slice(0, MAX_TOOLS)
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: opts.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          // The model decides when the user is done talking — the whole reason
          // this feels like a conversation instead of a walkie-talkie.
          //
          // Both flags are the server's defaults and both are written down
          // anyway, because interruption is NATIVE: when the model hears speech
          // over its own reply it cancels that reply itself and answers the new
          // thing. That is the behaviour to lean on — a client-side barge-in
          // detector would be a second, worse VAD racing this one. Our job is
          // only to (a) ask for it in the frame instead of inheriting a default
          // we do not control, and (b) not starve it of the audio it needs to
          // notice, which is what the half-duplex gate used to do.
          turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
          // The API's OWN noise reduction, on the input it is about to run VAD
          // over — off by default, which is the wrong default for a laptop in a
          // room. near_field is the mic-at-arms-length case (built-in, headset);
          // TINY_VOICE_NOISE_REDUCTION=far_field for a speakerphone across a
          // desk, =off to send the raw feed. This is the native answer to a
          // noisy input, and it runs where the VAD is rather than in our process.
          ...(resolveNoiseReduction() ? { noise_reduction: { type: resolveNoiseReduction() } } : {}),
          // Transcribe the USER side too: that text is what lands in the CLI's
          // own context (onTurn), so it is not optional here.
          transcription: { model: 'gpt-4o-mini-transcribe' },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: resolveVoice(opts.voice),
        },
      },
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    },
  }
}

/**
 * A spoken-style brief. A voice call wants a tight instruction, not the CLI's
 * full multi-thousand-token system prompt: read aloud, that prompt produces a
 * tiny that narrates its tool use and speaks in bullet points.
 */
export function buildVoiceInstructions(extra?: string): string {
  const parts = [
    'You are tiny, a living AI running on the user\'s own machine, speaking out loud in a live voice call. ' +
    'Be warm, natural and brief — one or two sentences unless asked for more. Never narrate tool use, never ' +
    'read out code or long paths; do the thing and say what happened. You have the user\'s real local tools: ' +
    'their shell, files, screen, devices. If a request needs one, call it and answer in the same breath.',
  ]
  if (extra?.trim()) parts.push(extra.trim().slice(0, 6000))
  return parts.join('\n\n')
}

/** The minimum of a WebSocket this file uses — so a test can be a plain object. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev?: any) => void) | null
  onmessage: ((ev: { data: any }) => void) | null
  onclose: ((ev?: any) => void) | null
  onerror: ((ev?: any) => void) | null
}

export interface RealtimeCallOptions {
  apiKey: string
  model?: string
  voice?: string
  /** Extra context appended to the spoken-style brief (memories, cwd, task). */
  context?: string
  /** The Strands tools this process has mounted — the voice agent gets them all. */
  tools?: any[]
  /** Runs a tool by name. Defaults to invoking the matching object in `tools`. */
  executeTool?: (name: string, args: any) => Promise<string> | string
  /** The Strands Agent the tools belong to. Only needed when `executeTool` is
   *  absent: the vended tools (bash, fileEditor, notebook) demand a ToolContext
   *  carrying a real agent and throw without one, so a call given `tools` but
   *  neither of these can talk but cannot DO anything. */
  agent?: any
  onEvent?: (e: RealtimeEvent) => void
  /** Stream the mic even while the tiny is talking, so the model's own VAD can
   *  interrupt it. Default ON (resolveFullDuplex) — leave it undefined unless a
   *  flag was passed; `false` here turns on echo gating (audio.ts physics). */
  fullDuplex?: boolean
  /** Test seams. */
  /** Stall budget override (ms); 0 disables the watchdog. Tests and tuning. */
  stallMs?: number
  socketFactory?: (url: string, protocols: string[]) => SocketLike
  micFactory?: (onFrame: (b: Buffer) => void, onError: (e: string) => void) => Mic | null
  speakerFactory?: (onError: (e: string) => void) => Speaker
  backend?: AudioBackend | null
}

export class RealtimeCall {
  private opts: RealtimeCallOptions
  private ws: SocketLike | null = null
  private mic: Mic | null = null
  private speaker: Speaker | null = null
  private status: RealtimeStatus = 'idle'
  private toolMap = new Map<string, any>()
  private capTimer: ReturnType<typeof setTimeout> | null = null

  // ── the barge-in state machine (scars 1–3) ───────────────────────────────
  private responseActive = false
  private suppressAudio = false
  private lastAssistantItemId: string | null = null
  private assistantAudioMs = 0

  // ── turn pairing, for the CLI's own transcript ───────────────────────────
  private userLast = ''
  private assistantBuf = ''

  /** Wall clock until which the mic is gated (half duplex). */
  private micGatedUntil = 0
  /** Frames the model never heard, for an honest status line. */
  public gatedFrames = 0
  /** The measured echo level: how loud our own speaker comes back in. */
  private echoFloor = 0
  /** Frames left in the measure-only window at the top of a spoken reply. */
  private echoLearn = 0
  /** Whether the previous frame was inside a speaking window (edge detection). */
  private wasGated = false
  /** Frames held while deciding whether a loud burst is a person or a peak. */
  private bargeHold: Buffer[] = []
  /** The door is open: someone talked over the tiny, so stop gating this turn. */
  private bargeOpen = false
  /** Times the local gate opened for a person talking over a reply. */
  public bargeIns = 0

  // ── scar 5: the turn that never closes ───────────────────────────────────
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  /** Turns we had to close ourselves — surfaced by the CLI, like gatedFrames. */
  public stalledTurns = 0

  /** Resolved once: surfaces render it, and the gate reads it per frame. */
  public readonly fullDuplex: boolean

  constructor(opts: RealtimeCallOptions) {
    this.opts = opts
    this.fullDuplex = resolveFullDuplex(opts.fullDuplex)
    for (const t of opts.tools || []) {
      const name = t?.toolSpec?.name ?? t?.name
      if (name) this.toolMap.set(String(name), t)
    }
  }

  get live(): boolean { return this.status === 'live' }
  get state(): RealtimeStatus { return this.status }
  /** The roster actually mounted, after the cap — for the status line. */
  get toolNames(): string[] { return [...this.toolMap.keys()].slice(0, MAX_TOOLS) }

  private emit(e: RealtimeEvent) { try { this.opts.onEvent?.(e) } catch { /* a surface's bug is not the call's */ } }
  private setStatus(s: RealtimeStatus) { this.status = s; this.emit({ type: 'status', status: s }) }
  private send(obj: any) { try { this.ws?.send(JSON.stringify(obj)) } catch { /* socket closing */ } }

  /**
   * Dial, configure, and open the audio devices. Resolves once the socket is
   * live (or rejects with a reason a person can act on).
   *
   * The mic opens BEFORE the socket on purpose: a missing backend or a denied
   * microphone should not first burn a realtime session that then sits silent.
   */
  async start(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'live') return
    if (!this.opts.apiKey) throw new Error('a realtime call needs an OpenAI key — set OPENAI_API_KEY (voice is OpenAI-only today)')
    const backend = this.opts.backend ?? detectBackend()
    if (!backend && !this.opts.micFactory) throw new Error(missingAudioHint())
    this.setStatus('connecting')

    const model = this.opts.model || process.env.TINY_VOICE_MODEL || DEFAULT_REALTIME_MODEL
    const url = `${REALTIME_URL}?model=${encodeURIComponent(model)}`
    // The key rides as a subprotocol, which is how the OpenAI SDK dials from a
    // WebSocket-only environment: Node's global WebSocket sends no custom
    // headers. "insecure" names the browser risk of shipping a key to a page —
    // here the key is already on this machine, in this process's own env.
    // ⚠️ NO 'openai-beta.realtime-v1' subprotocol. The OpenAI SDK's browser
    // helper still sends it, and sending it puts the socket on the beta API,
    // which now answers every session.update with "The Realtime Beta API is no
    // longer supported" — a call that connects, reports live, and can never
    // speak. GA is the bare 'realtime' subprotocol plus the key.
    const protocols = ['realtime', `openai-insecure-api-key.${this.opts.apiKey}`]

    const ws = (this.opts.socketFactory ?? defaultSocketFactory)(url, protocols)
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      let settled = false
      ws.onopen = () => {
        if (settled) return
        settled = true
        this.send(buildSessionUpdate({
          instructions: buildVoiceInstructions(this.opts.context),
          voice: this.opts.voice,
          tools: [...this.toolMap.values()].slice(0, MAX_TOOLS).map(toRealtimeTool),
        }))
        this.openAudio(backend)
        this.setStatus('live')
        // A wedged call is a metered call: OpenAI cuts the session at 60 min
        // anyway, so hang up on our own terms and say why.
        this.capTimer = setTimeout(() => {
          this.emit({ type: 'error', error: 'the call hit the one-hour limit' })
          this.stop()
        }, MAX_CALL_MS)
        // A one-hour timer must not be a reason for the process to stay alive:
        // the socket and the mic are what hold a call open. Without this, any
        // host that ends its own work (a test, a one-shot script) hangs for the
        // full hour after hanging up.
        this.capTimer.unref?.()
        resolve()
      }
      ws.onerror = (ev: any) => {
        const why = String(ev?.message || 'could not reach the realtime API')
        if (!settled) { settled = true; this.setStatus('error'); reject(new Error(why)); return }
        this.emit({ type: 'error', error: why })
      }
      ws.onclose = (ev: any) => {
        if (!settled) {
          settled = true
          // A 401/403 arrives as a close, not an error — name the likely cause
          // instead of leaving "call ended" as the only clue (the exact bug the
          // DO's upstream-close handler exists to avoid).
          const code = ev?.code ?? '?'
          this.setStatus('error')
          reject(new Error(`the realtime API closed the connection (${code}) — check that OPENAI_API_KEY has realtime access`))
          return
        }
        this.teardown('ended')
      }
      ws.onmessage = (ev) => this.onUpstream(ev.data)
    })
  }

  private openAudio(backend: AudioBackend | null) {
    const onErr = (err: string) => this.emit({ type: 'error', error: err })
    this.speaker = this.opts.speakerFactory
      ? this.opts.speakerFactory(onErr)
      : openSpeaker(onErr, backend)
    this.mic = this.opts.micFactory
      ? this.opts.micFactory((b) => this.onMicFrame(b), onErr)
      : openMic((b) => this.onMicFrame(b), onErr, backend)
    if (!this.mic) this.emit({ type: 'error', error: 'the microphone did not open — you can still type into the call' })
  }

  /**
   * A mic frame: gate it if the tiny is talking, else append it upstream.
   *
   * The gate is the half-duplex rule from audio.ts. It is applied HERE rather
   * than by muting the recorder because stopping and restarting a recorder
   * process per sentence loses the first word of every reply to device warm-up.
   *
   * It is a door, not a wall — see BARGE_MARGIN. Frames loud enough to be a
   * person rather than our own echo push it open and go upstream like any other.
   */
  private onMicFrame(frame: Buffer) {
    if (!this.live) return
    const level = frameLevel(frame)
    if (!this.fullDuplex && !this.bargeOpen) {
      const speaking = !!this.speaker?.speaking
      if (speaking) this.micGatedUntil = Date.now() + ECHO_TAIL_MS
      if (speaking || Date.now() < this.micGatedUntil) {
        // Entering a speaking window: measure before believing anything.
        if (!this.wasGated) { this.wasGated = true; this.echoLearn = ECHO_LEARN_FRAMES }
        this.tryBargeIn(frame, level)
        return   // tryBargeIn forwards the held onset itself if it opens up
      }
      this.wasGated = false
    }
    this.sendFrame(frame, level)
  }

  private sendFrame(frame: Buffer, level = frameLevel(frame)) {
    this.emit({ type: 'level', level })
    this.send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') })
  }

  /**
   * A frame arrived while our own speaker was audible. Person, or echo?
   *
   * Returns true once it has decided "person" — and in that case it has already
   * forwarded the whole held burst, so the first syllable of the interruption
   * survives. The onset matters: the server's VAD needs the start of a word to
   * fire, and a barge-in that swallows "stop—" reads as being ignored.
   */
  private tryBargeIn(frame: Buffer, level: number): boolean {
    if (this.echoLearn > 0) {
      this.echoLearn--
      this.echoFloor = Math.max(level, this.echoFloor * ECHO_DECAY)
      this.gatedFrames++
      return false
    }
    if (level < Math.max(BARGE_FLOOR, this.echoFloor * BARGE_MARGIN)) {
      // Not a person. So this frame IS the echo, and the best measurement of it
      // we will ever get. The floor is frozen while a burst is in flight, so a
      // person's own voice can never raise the bar they have to clear.
      if (!this.bargeHold.length) this.echoFloor = Math.max(level, this.echoFloor * ECHO_DECAY)
      this.bargeHold = []
      this.gatedFrames++
      return false
    }
    this.bargeHold.push(frame)
    if (this.bargeHold.length < BARGE_FRAMES) { this.gatedFrames++; return false }
    this.bargeOpen = true
    this.bargeIns++
    const onset = this.bargeHold
    this.bargeHold = []
    this.gatedFrames -= onset.length - 1   // they were held, not lost
    for (const f of onset) this.sendFrame(f)
    return true
  }

  /**
   * Arm the stall watchdog: the server has heard speech start and now owes us
   * either a speech_stopped/commit or a response.
   */
  private armStall() {
    this.clearStall()
    const budget = this.opts.stallMs ?? TURN_STALL_MS
    if (!this.live || budget <= 0) return
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      if (!this.live || this.responseActive) return
      this.stalledTurns++
      // Close the turn by hand, exactly as the server would have: commit what
      // is in the input buffer, then ask for the answer. Silent on purpose —
      // this recovers into a normal turn, and "your turn stalled" is a sentence
      // about our plumbing, not about what the person asked.
      this.send({ type: 'input_audio_buffer.commit' })
      this.send({ type: 'response.create' })
    }, budget)
    this.stallTimer.unref?.()
  }

  private clearStall() {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null }
  }

  /** Frames from OpenAI. Audio to the speaker; everything else to the surface. */
  private onUpstream(data: any) {
    let msg: any
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)) } catch { return }
    if (!msg?.type) return

    switch (msg.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        // Scar 2: residual deltas of a reply the person talked over.
        if (this.suppressAudio) break
        if (typeof msg.delta === 'string') {
          const bytes = Buffer.from(msg.delta, 'base64')
          // Scar 3: what actually played, for the truncate.
          this.assistantAudioMs += Math.floor(bytes.length / BYTES_PER_MS)
          this.speaker?.write(bytes)
        }
        if (msg.item_id) this.lastAssistantItemId = String(msg.item_id)
        break
      }
      case 'input_audio_buffer.speech_started': {
        // The server has already cancelled the reply itself (interrupt_response).
        // What it cannot do is stop OUR speaker — bytes are in a player process,
        // seconds ahead of generation — or know how much of the sentence the
        // person actually heard. That is what the rest of this branch is for.
        // Scar 1: only a real barge-in gets a cancel.
        if (this.responseActive) {
          this.send({ type: 'response.cancel' })
          if (this.lastAssistantItemId && this.assistantAudioMs > 0) {
            this.send({
              type: 'conversation.item.truncate',
              item_id: this.lastAssistantItemId,
              content_index: 0,
              audio_end_ms: this.assistantAudioMs,
            })
          }
          this.responseActive = false
          this.suppressAudio = true
          // The interrupted half is what the person actually heard — keep it in
          // the transcript rather than dropping the turn on the floor.
          this.finishTurn()
        }
        // Always flush: generation ends seconds before the speaker does.
        this.speaker?.flush()
        this.assistantAudioMs = 0
        this.emit({ type: 'barge_in' })
        // Scar 5: from here the server owes us a turn. Start counting.
        this.armStall()
        break
      }
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed': {
        // The server closed the turn on its own — nothing to rescue.
        this.clearStall()
        break
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const delta = String(msg.delta || '')
        this.assistantBuf += delta
        this.emit({ type: 'assistant_transcript', delta })
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.userLast = String(msg.transcript || '').trim()
        this.emit({ type: 'user_transcript', text: this.userLast })
        break
      }
      case 'response.function_call_arguments.done': {
        void this.runTool(String(msg.call_id || ''), String(msg.name || ''), msg.arguments)
        break
      }
      case 'response.created': {
        this.clearStall()
        this.responseActive = true
        this.assistantAudioMs = 0
        this.suppressAudio = false
        this.assistantBuf = ''
        // A new answer is starting, so the echo is about to come back: close the
        // door again and re-measure the room. Held frames belonged to the turn
        // that just ended.
        this.bargeOpen = false
        this.bargeHold = []
        this.wasGated = false
        this.emit({ type: 'response_started' })
        break
      }
      case 'response.done': {
        this.responseActive = false
        this.assistantAudioMs = 0
        this.emit({ type: 'response_done' })
        this.finishTurn()
        break
      }
      case 'error': {
        // Scar 4: the benign barge-in race, on every interrupted call.
        if (msg.error?.code === 'response_cancel_not_active') break
        // A stall nudge can land on an already-empty buffer (the server committed
        // as our commit crossed the wire). Recovering is not worth a red line.
        if (msg.error?.code === 'input_audio_buffer_commit_empty') break
        this.emit({ type: 'error', error: String(msg.error?.message || 'realtime error') })
        break
      }
      default: /* reasoning items, buffer commits, rate limits — nothing to do */ break
    }
  }

  /**
   * Execute a tool the model called — locally, with the real tool object.
   *
   * Two rules, both learned from the DO: the model must ALWAYS get a
   * function_call_output (a thrown tool that answers nothing leaves the call
   * hanging in silence forever, which is the worst failure mode voice has), and
   * the output must be a string, clamped — it is spoken context, not a payload.
   */
  private async runTool(id: string, name: string, rawArgs: any) {
    let args: any = {}
    try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs ?? {}) } catch { /* keep {} */ }
    this.emit({ type: 'tool_call', id, name, args })
    let output: string
    try {
      if (this.opts.executeTool) {
        output = String(await this.opts.executeTool(name, args))
      } else {
        const t = this.toolMap.get(name)
        if (!t) throw new Error(`no tool named ${name} on this machine`)
        // A ToolContext, not a bare input: the SDK's vended tools take it as
        // their second argument and refuse without it ("Tool context is required
        // for bash operations"), which this method would then hand to the model
        // as spoken prose — a wiring failure that sounds like a polite apology.
        const ctx = { toolUse: { toolUseId: id || `voice-${Date.now().toString(36)}`, name, input: args }, agent: this.opts.agent, invocationState: {} }
        const r = await t.invoke(args, ctx as any)
        output = typeof r === 'string' ? r : JSON.stringify(r ?? {})
      }
    } catch (e: any) {
      output = `error: ${String(e?.message || e)}`
    }
    output = output.slice(0, 32_000)
    this.emit({ type: 'tool_result', id, name, output })
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: id, output },
    })
    this.send({ type: 'response.create' })
  }

  /**
   * Type into a live call. The tiny hears the text and answers out loud — the
   * composer bridge the web/iOS surfaces have, which matters more in a terminal:
   * a file path or an error message is something you paste, never something you
   * read aloud.
   */
  sendUserText(text: string): boolean {
    const t = text.trim()
    if (!this.live || !t) return false
    this.userLast = t.slice(0, 4000)
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: this.userLast }] },
    })
    this.send({ type: 'response.create' })
    return true
  }

  /** Pair the last user turn with what the assistant said and hand it over. */
  private finishTurn() {
    const user = this.userLast.trim()
    const assistant = this.assistantBuf.trim()
    this.assistantBuf = ''
    if (!user && !assistant) return // a tool-only turn has nothing to transcribe
    // A response that only ran a tool is not an exchange YET: the model is about
    // to speak the result in a second response. Emitting here splits one spoken
    // turn into two history entries — the question paired with silence, then the
    // real answer paired with a user turn nobody took. Hold the question; the
    // next response claims it. (Seen on the first live tool call.)
    if (user && !assistant) return
    this.userLast = ''
    this.emit({ type: 'turn', user, assistant, continuation: !user })
  }

  /** Hang up. Idempotent — a close event and a user hangup can race. */
  stop() { this.teardown('ended') }

  private teardown(status: RealtimeStatus, error?: string) {
    if (this.status === 'ended' || (this.status === 'error' && !error)) {
      // Still make sure the devices are shut: a half-closed call keeps the
      // microphone light on, which is the one bug a user never forgives.
      this.closeDevices()
      this.clearStall()
      return
    }
    if (this.capTimer) { clearTimeout(this.capTimer); this.capTimer = null }
    this.clearStall()
    // A question still in the air when the line drops (held above, waiting for
    // the model to speak): record it, or the typed session never learns it was
    // asked at all.
    const held = this.userLast.trim()
    if (held) { this.userLast = ''; this.emit({ type: 'turn', user: held, assistant: this.assistantBuf.trim(), continuation: false }) }
    this.closeDevices()
    const ws = this.ws
    this.ws = null
    try { ws?.close() } catch { /* already closed */ }
    if (error) this.emit({ type: 'error', error })
    this.setStatus(status)
  }

  private closeDevices() {
    try { this.mic?.stop() } catch { /* already dead */ }
    try { this.speaker?.close() } catch { /* already dead */ }
    this.mic = null
    this.speaker = null
  }
}

/** The real dial: Node's global WebSocket, no dependency, no headers needed. */
function defaultSocketFactory(url: string, protocols: string[]): SocketLike {
  return new WebSocket(url, protocols) as unknown as SocketLike
}
