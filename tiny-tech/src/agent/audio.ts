/**
 * 🎙️🔊 Full-duplex PCM16 for a terminal — the CLI's AVAudioEngine.
 *
 * The realtime API wants exactly one thing from a client and gives back exactly
 * one thing: raw PCM16 mono @ 24 kHz, streaming, both directions. The browser
 * gets that from AudioWorklet, iOS from AVAudioEngine. A terminal has neither,
 * so a child process is the sound card: one recorder writing frames to stdout,
 * one player reading frames from stdin, both alive for the whole call.
 *
 * Two backends, probed in this order, because they cover almost every machine
 * that has a microphone at all:
 *   sox    — `rec`/`play`, the unix answer; smallest, cleanest raw-PCM contract
 *   ffmpeg — `ffmpeg`/`ffplay`; not an audio tool but everyone already has it
 * Neither present is a REFUSAL, not a degradation: see missingAudioHint().
 *
 * ── the echo problem, which is physical and has no clever fix ──────────────
 * A phone gets acoustic echo cancellation from the OS: the mic feed has the
 * speaker's own output subtracted out, so the model never hears itself. There is
 * no AEC on a laptop pipe. With semantic VAD, a tiny talking through the
 * built-in speakers into its own built-in microphone hears "someone" start
 * speaking mid-sentence, cancels its reply to listen, and transcribes its own
 * voice as the user's next turn — a call that interrupts itself into nonsense
 * within two exchanges.
 *
 * The answer to that is HALF DUPLEX — mic frames dropped while the assistant is
 * audibly speaking, plus a short tail for the speaker's own buffer to drain —
 * and it is an OPT-IN (`TINY_VOICE_HALF_DUPLEX=1`, `--half-duplex`), not the
 * default. It shipped as the default once and took barge-in with it: the model's
 * own VAD cannot honour an interruption it was never allowed to hear, so on the
 * setup almost everyone uses, talking over the tiny did nothing at all.
 *
 * And even when it is on, the gate is a threshold rather than a wall: frames
 * that stand well above the echo the mic has been measuring go upstream anyway.
 * realtime.ts BARGE_MARGIN has the reasoning. Whether the gate is worth it at
 * all is a knob and not a guess, because only the person wearing (or not
 * wearing) the headphones can know.
 *
 * ── flush means kill ───────────────────────────────────────────────────────
 * Barge-in has to make already-queued audio *not play*. Bytes handed to a
 * player process are gone — there is no unwrite. So a flush kills the player and
 * the next frame spawns a fresh one. It costs ~100 ms of silence on an interrupt
 * and it is the only implementation that actually stops the sentence.
 */
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { stream } from './exec.js'

/** The realtime API's wire rate. Not configurable — it is the contract. */
export const SAMPLE_RATE = 24000
/** PCM16 mono: 2 bytes a sample, 48 bytes a millisecond. */
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000

export type AudioBackend = 'sox' | 'ffmpeg'

/** `command -v`, without a shell — the probe is a path lookup, not a command. */
function which(bin: string): string | null {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean)
  for (const d of dirs) {
    const p = `${d}/${bin}`
    try { if (existsSync(p)) return p } catch { /* unreadable dir */ }
  }
  return null
}

/**
 * Which backend this machine can actually do speech-to-speech with.
 *
 * Both directions must come from the same probe: a machine with `ffplay` but no
 * recorder can hear the tiny and never answer it, which is worse than a clear
 * "install this first".
 */
export function detectBackend(): AudioBackend | null {
  if (process.env.TINY_VOICE_BACKEND === 'sox' || process.env.TINY_VOICE_BACKEND === 'ffmpeg') {
    return process.env.TINY_VOICE_BACKEND as AudioBackend
  }
  if (which('rec') && which('play')) return 'sox'
  if (which('ffmpeg') && which('ffplay')) return 'ffmpeg'
  return null
}

/** What to tell the person (or the model) when the machine cannot do voice. */
export function missingAudioHint(): string {
  const install = platform() === 'darwin' ? 'brew install sox' : 'apt install sox  # or: apt install ffmpeg'
  return `no streaming audio backend on this machine — a realtime voice call needs one.\nInstall either:\n  ${install}\nsox (rec/play) is preferred; ffmpeg + ffplay also works.`
}

/**
 * The recorder's argv. Raw PCM16 mono @ 24 kHz to stdout, and QUIET: any banner
 * or progress meter on stdout would be interpreted as audio and sent to the
 * model as a burst of noise.
 *
 * TINY_VOICE_INPUT picks a non-default device (ffmpeg avfoundation index like
 * ':1', or an ALSA/sox device name). Pure builder — tested without a microphone.
 */
export function recordArgs(backend: AudioBackend, device?: string): { bin: string; args: string[] } {
  if (backend === 'sox') {
    return {
      bin: 'rec',
      args: [
        '-q',
        ...(device ? ['-d', device] : []),
        '-t', 'raw', '-b', '16', '-e', 'signed-integer', '-c', '1', '-r', String(SAMPLE_RATE),
        '-', // stdout
      ],
    }
  }
  // avfoundation on macOS, alsa elsewhere. ':0' = "no video, audio device 0".
  const input = device || (platform() === 'darwin' ? ':0' : 'default')
  return {
    bin: 'ffmpeg',
    args: [
      // ⚠️ -nostdin is load-bearing: ffmpeg reads the terminal's stdin for its
      // own keyboard commands, so without it the recorder EATS the keystrokes
      // meant for the composer — a call you cannot type into, and 'q' hangs up.
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', platform() === 'darwin' ? 'avfoundation' : 'alsa',
      '-i', input,
      '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-',
    ],
  }
}

/**
 * The player's argv. The flags that matter are the latency ones: a default
 * ffplay buffers for analysis before it emits a sample, which on a conversation
 * reads as the tiny thinking for a second after it has already answered.
 */
export function playArgs(backend: AudioBackend): { bin: string; args: string[] } {
  if (backend === 'sox') {
    return {
      bin: 'play',
      args: ['-q', '-t', 'raw', '-b', '16', '-e', 'signed-integer', '-c', '1', '-r', String(SAMPLE_RATE), '-'],
    }
  }
  return {
    bin: 'ffplay',
    args: [
      '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit',
      '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'mono', '-i', '-',
    ],
  }
}

/** Mean absolute amplitude of a PCM16 frame, 0..1 — the mic meter's input. */
export function frameLevel(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2)
  if (!samples) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) sum += Math.abs(buf.readInt16LE(i * 2))
  return Math.min(1, sum / samples / 8000)
}

export interface Mic {
  stop(): void
  readonly alive: boolean
}

/**
 * Open the microphone. `onFrame` fires with raw PCM16 as fast as the recorder
 * produces it; `onError` gets the recorder's own words (ffmpeg's stderr says
 * "Operation not permitted" when the terminal lacks mic consent, which is the
 * single most common failure and unrecoverable without the user's help).
 */
export function openMic(
  onFrame: (frame: Buffer) => void,
  onError?: (err: string) => void,
  backend: AudioBackend | null = detectBackend(),
): Mic | null {
  if (!backend) { onError?.(missingAudioHint()); return null }
  const { bin, args } = recordArgs(backend, process.env.TINY_VOICE_INPUT)
  let proc: ChildProcess | null
  try {
    proc = stream(bin, args)
  } catch (e: any) {
    onError?.(`could not start ${bin}: ${String(e?.message || e)}`)
    return null
  }
  proc.stdout?.on('data', (d: Buffer) => onFrame(d))
  let stderrBuf = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderrBuf += String(d)
    // Recorders narrate; only a real complaint is worth interrupting a call for.
    if (/permission|not permitted|denied|no such|cannot|invalid|unknown/i.test(stderrBuf)) {
      onError?.(stderrBuf.trim().slice(0, 300))
      stderrBuf = ''
    }
  })
  proc.on('error', (e) => onError?.(`${bin}: ${String(e?.message || e)}`))
  let alive = true
  proc.on('exit', () => { alive = false })
  return {
    get alive() { return alive },
    stop() {
      alive = false
      try { proc?.kill('SIGKILL') } catch { /* already gone */ }
      proc = null
    },
  }
}

export interface Speaker {
  /** Queue a PCM16 frame for playback. Spawns the player on first use. */
  write(frame: Buffer): void
  /** Barge-in: drop everything queued (kills the player — see the docblock). */
  flush(): void
  /** True while frames are still expected to be audible. */
  readonly speaking: boolean
  close(): void
}

/**
 * Open the speaker. Lazily spawned so a call that never gets an answer never
 * starts a player, and re-spawned after every flush.
 *
 * `speaking` is deliberately a TIME estimate rather than "is the process alive":
 * bytes written are already in the player's buffer, so the honest answer to "is
 * the tiny still audible" is derived from how much audio has been handed over
 * and when. Half-duplex mic gating reads this, and a wrong answer there is
 * either a self-interrupting call or a mic that never reopens.
 */
export function openSpeaker(
  onError?: (err: string) => void,
  backend: AudioBackend | null = detectBackend(),
): Speaker {
  let proc: ChildProcess | null = null
  let closed = false
  /** Wall-clock ms at which the audio handed over so far runs out. */
  let drainAt = 0

  const spawnPlayer = () => {
    if (!backend) return null
    const { bin, args } = playArgs(backend)
    try {
      const p = stream(bin, args)
      p.on('error', (e) => onError?.(`${bin}: ${String(e?.message || e)}`))
      // EPIPE is the normal end of a flush-kill race, not a fault to report.
      p.stdin?.on('error', () => { /* player gone; next write respawns */ })
      p.stderr?.on('data', () => { /* players narrate; ignore */ })
      p.on('exit', () => { if (p === proc) proc = null })
      return p
    } catch (e: any) {
      onError?.(`could not start ${bin}: ${String(e?.message || e)}`)
      return null
    }
  }

  return {
    get speaking() { return !closed && Date.now() < drainAt },
    write(frame: Buffer) {
      if (closed || !frame.length) return
      if (!proc) {
        proc = spawnPlayer()
        drainAt = Date.now() // a fresh player starts from now, not from a stale head
      }
      const ms = frame.length / BYTES_PER_MS
      drainAt = Math.max(drainAt, Date.now()) + ms
      try { proc?.stdin?.write(frame) } catch { /* respawns on the next frame */ }
    },
    flush() {
      drainAt = 0
      const p = proc
      proc = null
      try { p?.stdin?.end() } catch { /* already closed */ }
      try { p?.kill('SIGKILL') } catch { /* already gone */ }
    },
    close() {
      closed = true
      this.flush()
    },
  }
}
