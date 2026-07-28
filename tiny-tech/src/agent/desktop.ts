/**
 * use_desktop — the daemon's senses at the machine it lives on: notifications,
 * the clipboard, and opening things in the user's own apps.
 *
 * use_computer already gives eyes and hands (screenshot / click / type). What
 * was missing is the pair of channels that don't go through the screen at all:
 *
 *   notify   reach the HUMAN — the daemon runs headless under launchd/systemd,
 *            so a finished background task otherwise leaves no trace anywhere
 *            near the person sitting at the keyboard
 *   copy /   move data between the agent and every app on the machine without
 *   paste    driving a UI: the clipboard is the one interface everything shares
 *   open     hand a URL or file to the user's default app (browser, editor, …)
 *
 * Two more joined later, both the same shape — an ON-DEVICE model reading a file
 * the user already has, which is a different job from use_computer's "look at
 * the screen right now":
 *
 *   transcribe   audio  → text (Speech, speech.ts)
 *   read_image   pixels → text (Vision OCR, vision.ts)
 *
 * Zero dependencies, same rule as the rest of device-tools: shell out to what
 * the OS already ships, and register only when a backend actually exists.
 *
 * Everything is built as PURE command descriptions ({bin, args}) so the
 * platform matrix is unit-testable without touching the real clipboard or
 * firing real notifications — the one thing a test suite must never do on a
 * developer's machine.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync, execSync } from 'node:child_process'
import * as os from 'node:os'
import {
  speak, listen, transcribeFile, formatListenResult, speechErrorMessage,
  hasSpeechOut, hasSpeechIn, speechModes, LISTEN_MAX_SECONDS, LISTEN_DEFAULT_SECONDS,
  type PathProbe,
} from './speech.js'
import {
  recognizeTextInFile, formatFileOcr, hasVisionOcr,
} from './vision.js'
import { prepareImage, realSeeIo } from './see.js'
import * as fs from 'node:fs'

/** A resolved command: the binary plus its argv. */
export interface Cmd { bin: string; args: string[] }

/**
 * Notification clamps, deliberately the SAME numbers as the worker's
 * buildNotifyEnvelope (chatgpt-plugin-tinyai/src/push.ts) — a notification the
 * user sees should read the same whether it came from the cloud or from the
 * daemon standing next to them.
 */
export const NOTIFY_TITLE_MAX = 100
export const NOTIFY_BODY_MAX = 400

/**
 * Cap on a clipboard READ. The daemon's answer travels back to the web agent as
 * a relay reply, which relay-poller clamps at 8000 chars before it even reaches
 * the mailbox — so a 2MB clipboard would be silently sheared off mid-word
 * downstream. Clamping here instead lets us SAY it was truncated.
 */
export const CLIPBOARD_READ_MAX = 6000

/** Is this binary on PATH? Injectable so the platform matrix is testable. */
export type HasBin = (bin: string) => boolean

const realHas: HasBin = (bin) => {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true } catch { return false }
}

/** The voice halves are probed by PATH, not by `command -v` — see speech.ts. */
const realPathProbe: PathProbe = (p) => {
  try { return fs.existsSync(p) } catch { return false }
}

/**
 * Wayland and X11 have different clipboard daemons and neither one can talk to
 * the other's selection, so the display server in play decides the tool — not
 * the distro, and not whichever binary happens to be installed. A Wayland
 * session with xclip present would copy into an X selection nothing reads.
 */
function linuxClipboard(env: NodeJS.ProcessEnv, hasBin: HasBin, read: boolean): Cmd | null {
  if (env.WAYLAND_DISPLAY && hasBin(read ? 'wl-paste' : 'wl-copy')) {
    return read ? { bin: 'wl-paste', args: ['--no-newline'] } : { bin: 'wl-copy', args: [] }
  }
  if (hasBin('xclip')) {
    return { bin: 'xclip', args: read ? ['-selection', 'clipboard', '-o'] : ['-selection', 'clipboard'] }
  }
  if (hasBin('xsel')) {
    return { bin: 'xsel', args: read ? ['--clipboard', '--output'] : ['--clipboard', '--input'] }
  }
  return null
}

export function copyCommand(
  plat: string = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
  hasBin: HasBin = realHas,
): Cmd | null {
  if (plat === 'darwin') return { bin: 'pbcopy', args: [] }
  if (plat === 'win32') return { bin: 'clip', args: [] }
  return linuxClipboard(env, hasBin, false)
}

export function pasteCommand(
  plat: string = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
  hasBin: HasBin = realHas,
): Cmd | null {
  if (plat === 'darwin') return { bin: 'pbpaste', args: [] }
  // Windows: `clip` writes but has no read twin, so the read side goes through
  // PowerShell's Get-Clipboard (Windows PowerShell 5.1 ships in-box on every
  // supported Windows, and `-Raw` is 5.0+). Not gated on hasBin: realHas asks
  // `command -v`, which does not exist in cmd.exe, so every probe there answers
  // "no" — gating the one guaranteed interpreter on a broken probe is how a
  // working sense reports itself missing.
  //
  // -NoProfile because a user profile can print banners into our stdout (and
  // costs a second of startup); -NonInteractive so a profile prompt can never
  // hang the 15s runner. `-Raw` returns the clipboard as ONE string: without it
  // Get-Clipboard emits an array and the formatter wraps long lines, i.e. the
  // text comes back with line breaks the user never copied.
  if (plat === 'win32') {
    return { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'] }
  }
  return linuxClipboard(env, hasBin, true)
}

/**
 * AppleScript string literal for `display notification`. AppleScript has no
 * escape for a raw newline inside a literal — an un-collapsed one is a SYNTAX
 * ERROR, not a two-line notification — and an unescaped quote ends the string
 * early, which is how an innocent notification body becomes injected script.
 */
export function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]+/g, ' ')
}

export function appleScriptNotify(p: { title: string; body: string; sound?: string }): string {
  const parts = [`display notification "${appleScriptString(p.body)}"`]
  parts.push(`with title "${appleScriptString(p.title)}"`)
  if (p.sound) parts.push(`sound name "${appleScriptString(p.sound)}"`)
  return parts.join(' ')
}

export function notifyCommand(
  p: { title: string; body: string; sound?: string },
  plat: string = os.platform(),
  hasBin: HasBin = realHas,
): Cmd | null {
  const title = String(p.title || 'tiny').slice(0, NOTIFY_TITLE_MAX)
  const body = String(p.body || '').slice(0, NOTIFY_BODY_MAX)
  if (plat === 'darwin') return { bin: 'osascript', args: ['-e', appleScriptNotify({ ...p, title, body })] }
  if (hasBin('notify-send')) {
    // Args, never a shell string — a body containing `;` or backticks must not
    // become a command on the machine we were asked to put a message on.
    return { bin: 'notify-send', args: ['-a', 'tiny', title, body] }
  }
  return null
}

export function openCommand(
  target: string,
  plat: string = os.platform(),
  hasBin: HasBin = realHas,
): Cmd | null {
  if (plat === 'darwin') return { bin: 'open', args: [target] }
  if (plat === 'win32') return { bin: 'cmd', args: ['/c', 'start', '', target] }
  if (hasBin('xdg-open')) return { bin: 'xdg-open', args: [target] }
  return null
}

/**
 * `open` hands a string to the OS launcher, so the scheme is a real capability
 * boundary. http(s) and a filesystem path are the two things the agent has a
 * reason to open; `file://`-adjacent tricks and exotic schemes (`javascript:`,
 * `smb:`, custom app handlers registered by anything installed) are how "open
 * this link" turns into "run this". Refuse rather than guess.
 */
export function isOpenableTarget(target: string): boolean {
  const t = String(target || '').trim()
  if (!t || /[\r\n]/.test(t)) return false
  if (/^https?:\/\//i.test(t)) return true
  // A bare scheme is anything before the first ':' with no slash in it.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t)
  if (scheme) return false
  return t.startsWith('/') || t.startsWith('./') || t.startsWith('~/')
}

// ── exec seam ───────────────────────────────────────────────────────────────

export type Runner = (cmd: Cmd, input?: string) => string

const realRun: Runner = (cmd, input) =>
  execFileSync(cmd.bin, cmd.args, {
    encoding: 'utf-8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(input == null ? {} : { input }),
  }).toString()

let run: Runner = realRun

/** Test seam: swap the process runner so tests never touch the real desktop. */
export function __setRunnerForTest(fn: Runner | null): void {
  run = fn || realRun
}

// ── the tool ────────────────────────────────────────────────────────────────

export interface DesktopArgs {
  action: 'notify' | 'copy' | 'paste' | 'open' | 'speak' | 'listen' | 'transcribe' | 'read_image' | 'see_image'
  title?: string
  body?: string
  sound?: string
  text?: string
  target?: string
  voice?: string
  rate?: number
  seconds?: number
  locale?: string
  fast?: boolean
}

/**
 * A tool result: prose, or prose PLUS pixels.
 *
 * Every action but `see_image` returns a plain string, and deliberately keeps
 * doing so — `agent.ts` calls runDesktop directly for task notifications and
 * three test files assert on strings. Only the one action that has an image to
 * hand back returns blocks, so `typeof result === 'string'` stays true wherever
 * it was true before.
 */
export type DesktopResult = string | Array<{ text: string } | { image: { format: string; source: { bytes: string } } }>

/**
 * The whole tool body, as a plain exported function — the Strands `tool()`
 * wrapper keeps its callback private, and this behavior (what gets refused,
 * what reaches the OS, what the agent is told) is exactly what needs pinning.
 */
export async function runDesktop(a: DesktopArgs): Promise<DesktopResult> {
  try {
    switch (a.action) {
      case 'notify': {
        if (!a.title && !a.body) return 'need title or body to notify'
        const title = a.title || 'tiny'
        const body = a.body || ''
        const cmd = notifyCommand({ title, body, sound: a.sound })
        if (!cmd) return 'no notification backend on this machine (macOS osascript or notify-send)'
        run(cmd)
        return `🔔 notified: ${title}${body ? ` — ${body.slice(0, 120)}` : ''}`
      }

      case 'copy': {
        // An empty string is a legitimate copy (clearing the clipboard);
        // a MISSING text field is a mistake worth naming.
        if (a.text == null) return 'need text to copy'
        const cmd = copyCommand()
        if (!cmd) return 'no clipboard backend on this machine (install wl-clipboard, xclip or xsel)'
        // Text goes over STDIN, never argv: the process table is world-readable
        // and ARG_MAX would truncate anything sizable.
        run(cmd, a.text)
        return `📋 copied ${a.text.length} chars to the clipboard`
      }

      case 'paste': {
        const cmd = pasteCommand()
        if (!cmd) return 'cannot read the clipboard on this machine'
        // Drop ONE trailing newline. PowerShell's Get-Clipboard terminates its
        // output with CRLF, so an empty Windows clipboard would otherwise come
        // back as a 2-char "clipboard" instead of the "empty" answer, and every
        // real read would carry a break the user never copied. pbpaste, xclip -o
        // and wl-paste --no-newline emit none, so this is a no-op for them.
        const out = run(cmd).replace(/\r?\n$/, '')
        if (!out) return '📋 clipboard is empty'
        const clipped = out.length > CLIPBOARD_READ_MAX
        return `📋 clipboard (${out.length} chars${clipped ? `, showing first ${CLIPBOARD_READ_MAX}` : ''}):\n${out.slice(0, CLIPBOARD_READ_MAX)}`
      }

      case 'open': {
        if (!a.target) return 'need target (https URL or absolute path)'
        if (!isOpenableTarget(a.target)) {
          return `refused: open takes an https URL or an absolute path, not ${a.target.slice(0, 60)}`
        }
        const cmd = openCommand(a.target)
        if (!cmd) return 'no opener on this machine (install xdg-utils)'
        run(cmd)
        return `🚀 opened ${a.target}`
      }

      // ── voice ──────────────────────────────────────────────────────────
      // Lives on use_desktop rather than in a tool of its own for the reason in
      // this file's docblock: speak/listen are the same channel as notify — how
      // the daemon reaches the person standing at this machine — just the half
      // that works when they aren't looking at the screen. See speech.ts.
      case 'speak': {
        const say = a.text || a.body
        if (!say) return 'need text to speak'
        if (!hasSpeechOut()) return 'this machine has no speech synthesiser (macOS `say`) — use notify instead'
        const r = speak(say, { voice: a.voice, rate: a.rate })
        return `🔊 said aloud${r.truncated ? ` (first ${r.spoken.length} of ${say.length} chars — speak the rest in another call, or notify instead)` : ''}: ${r.spoken.slice(0, 160)}`
      }

      case 'listen': {
        if (!hasSpeechIn()) return 'this machine cannot transcribe locally (needs macOS Speech)'
        const p = listen({ seconds: a.seconds, locale: a.locale })
        return p.ok ? formatListenResult(p) : speechErrorMessage(p)
      }

      case 'transcribe': {
        if (!a.target) return 'need target (absolute path to an audio file)'
        if (!hasSpeechIn()) return 'this machine cannot transcribe locally (needs macOS Speech)'
        const p = transcribeFile(a.target, { locale: a.locale })
        return p.ok ? `🎙️ transcript of ${a.target}:\n${(p.text || '').trim() || '(empty)'}` : speechErrorMessage(p)
      }

      // The VISUAL twin of transcribe, and it sits here for the same reason:
      // both are an on-device model reading a file the user ALREADY HAS, which
      // is a different job from use_computer's "look at the screen right now".
      // Keeping them together is also what keeps their coordinate contracts
      // apart — see formatFileOcr on why these positions must not be clicked.
      case 'read_image': {
        if (!a.target) return 'need target (path to an image file)'
        if (!hasVisionOcr()) return 'this machine cannot read images locally (needs macOS Vision)'
        // Errors are RETURNED, not thrown: the outer catch would flatten "no
        // such file" and "that PDF is not a bitmap" into one `desktop error:`,
        // and those send the caller to different fixes.
        try {
          const res = recognizeTextInFile(a.target, { fast: a.fast })
          // `fast` is passed through so an EMPTY fast result can name its own
          // retry: measured here, a fast pass finds NO lines at all in text
          // Vision reads fine when accurate (see formatFileOcr).
          return formatFileOcr(a.target, res, { fast: a.fast })
        } catch (e: any) {
          return `👁️ could not read ${a.target}: ${String(e?.message || e).slice(0, 300)}`
        }
      }

      // 👀 The other half of read_image, and the two are NOT interchangeable:
      // read_image answers "what does it SAY" on-device for free, see_image
      // answers everything else by putting the actual picture in front of the
      // model. See see.ts on why this was never the plumbing problem the report
      // described.
      case 'see_image': {
        if (!a.target) return 'need target (path to an image file)'
        const prepared = prepareImage(a.target, realSeeIo)
        // A refusal is a STRING, never an empty block list: a tool result with
        // no content reads to the model as a successful look at nothing.
        if (!prepared.ok) return prepared.message
        return [
          { text: prepared.value.note },
          { image: { format: prepared.value.format, source: { bytes: prepared.value.base64 } } },
        ]
      }

      default:
        return `unknown action: ${(a as any).action}`
    }
  } catch (e: any) {
    // A thrown tool aborts the agent's turn; a reported failure lets it adapt.
    return `desktop error: ${String(e?.stderr || e?.message || e).slice(0, 500)}`
  }
}

export const DESKTOP_DESCRIPTION = `🖥️ The senses of the machine this agent runs on — reach the person at it, and share data with every app on it. Actions:
- notify (title, body, sound optional) — a real OS notification. Use it when a background/long task finishes, or when you need the user's attention while they're in another app.
- copy (text) — put text on the system clipboard, ready to paste anywhere
- paste — read the system clipboard (what the user just copied — often exactly the context they meant to give you)
- open (target) — open an https URL or an absolute file path in the user's default app
- speak (text, voice optional, rate optional) — SAY IT OUT LOUD through the speakers. Reaches someone across the room who isn't looking at a screen; a notification cannot.
- listen (seconds optional ≤${LISTEN_MAX_SECONDS}, default ${LISTEN_DEFAULT_SECONDS}, locale optional) — open the microphone and transcribe what's said, ON THIS MACHINE. Stops on its own when the speaker pauses. The recording is deleted before you see the result.
- transcribe (target = absolute path to an audio file, locale optional) — on-device transcript of audio the user already has
- read_image (target = path to an image file, fast optional) — ON-DEVICE OCR of an image the user already has (a photo, a mock, a saved screenshot). Costs no tokens and no network, and needs no image in the conversation. Positions it reports are inside that FILE, never screen coordinates.
- see_image (target = path to an image file) — ACTUALLY LOOK at a file on this machine: the picture itself enters the conversation, so you can answer questions about layout, colour, objects, people, quality — anything that isn't lettering. Converts heic/tiff/bmp and resamples oversized images for you.

read_image and see_image are not interchangeable. If the question is "what does it say", use read_image: it is free, private and needs no image in the conversation. If the question needs you to SEE it — is this aligned, which of these is newer, what is in this photo — use see_image and pay the vision tokens. To look at what is on the screen RIGHT NOW, use use_computer read_screen/find_text (or its screenshot) instead — those coordinates are clickable, these are not.
Prefer notify over "I'll let you know" and paste over asking the user to re-type something they already copied. Use speak + listen together to hold an actual spoken exchange — say a question, then listen for the answer. Never claim you heard something listen did not return.`

export function makeDesktopTool() {
  return tool({
    name: 'use_desktop',
    description: DESKTOP_DESCRIPTION,
    inputSchema: z.object({
      action: z.enum(['notify', 'copy', 'paste', 'open', 'speak', 'listen', 'transcribe', 'read_image', 'see_image']),
      title: z.string().optional(),
      body: z.string().optional(),
      sound: z.string().optional().describe('macOS notification sound name, e.g. "Ping"'),
      text: z.string().optional().describe('Text to put on the clipboard (action:copy) or to say aloud (action:speak).'),
      target: z.string().optional().describe('https URL or absolute file path (action:open), an audio file path (action:transcribe), or an image file path (action:read_image / action:see_image). `~/` is expanded.'),
      voice: z.string().optional().describe('macOS voice name for action:speak, e.g. "Samantha". Omit for the system voice.'),
      rate: z.number().optional().describe('Speaking rate in words per minute (action:speak). System default is 175.'),
      seconds: z.number().optional().describe(`Max seconds to hold the mic (action:listen), ≤${LISTEN_MAX_SECONDS}. It stops earlier when the speaker pauses.`),
      locale: z.string().optional().describe('Speech locale for listen/transcribe, e.g. "en-US", "tr-TR". Defaults to en-US.'),
      fast: z.boolean().optional().describe('action:read_image — trade accuracy for speed (~3x quicker). Off by default: the fast pass mangles small labels and misses rotated text entirely, and those are usually the point.'),
    }),
    callback: async (a) => runDesktop(a as DesktopArgs),
  })
}

/**
 * Register only if at least one sense works here. A tool that exists and always
 * answers "no backend" is worse than an absent one: the model plans around a
 * capability the machine doesn't have.
 */
export function hasDesktopSenses(
  plat: string = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
  hasBin: HasBin = realHas,
  probe: PathProbe = realPathProbe,
): boolean {
  return Boolean(
    notifyCommand({ title: 't', body: 'b' }, plat, hasBin) ||
    copyCommand(plat, env, hasBin) ||
    pasteCommand(plat, env, hasBin) ||
    // Voice counts. A Mac stripped of every clipboard and notification backend
    // is hypothetical, but the principle isn't: if the only channel to the human
    // is the speakers, the tool that owns the speakers must still register.
    speechModes(plat, probe).length > 0,
  )
  // 👀 Sight is deliberately NOT a term here, even though see_image now works on
  // every machine (measureHeader needs no binary). Adding it would make this
  // gate constant-true and register use_desktop on a bare headless box for the
  // sake of one action — a wider change than the capability it would announce,
  // and one whose value is a product call, not a correctness fix. The honest
  // consequence is recorded in desktopSenses: no tool, no sight claim.
}

/** Which senses actually resolved — for `tiny-tech` startup output + labels. */
export function desktopSenses(
  plat: string = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
  hasBin: HasBin = realHas,
  probe: PathProbe = realPathProbe,
): string[] {
  const out: string[] = []
  if (notifyCommand({ title: 't', body: 'b' }, plat, hasBin)) out.push('notify')
  if (copyCommand(plat, env, hasBin)) out.push('copy')
  if (pasteCommand(plat, env, hasBin)) out.push('paste')
  if (openCommand('https://x', plat, hasBin)) out.push('open')
  // speak/listen resolve independently of every other sense (a synthesiser and
  // a speech model are different grants from a clipboard), so they're probed
  // separately rather than folded into the darwin branch above.
  out.push(...speechModes(plat, probe))
  // 👀 TWO words, for the same reason speak and listen are two: showing a file
  // and CONVERTING one are different capabilities, gated on different things.
  //
  // `see` is unconditional because see_image now is: measureHeader sizes a
  // png/jpeg/gif/webp from its header, so an already-showable file within the
  // caps reaches the model with no binary at all (see.ts). Gating this word on
  // sips is what the ⚠️ on `ocr` in device-tools warns about — a label denying a
  // capability the daemon is actually offering, which stops the agent (and any
  // remote agent reading it) from ever trying the tool that would have worked.
  //
  // `convert` is the sips-shaped half: heic/tiff/bmp, and anything oversized.
  // Probed separately from `ocr` because those are different capabilities on the
  // same files — OCR needs Vision, showing needs only bytes.
  //
  // ⚠️ Conditional on some OTHER sense having resolved, which is not a statement
  //    about sight at all: it is what keeps this list honest on a machine where
  //    hasDesktopSenses refused and use_desktop was never registered. A sense
  //    named for an absent tool is the same defect as a label for one — the tray
  //    would show it and the prompt would promise it, with no action behind it.
  if (out.length) {
    out.push('see')
    if (probe('/usr/bin/sips')) out.push('convert')
  }
  return out
}

/**
 * The system-prompt line for the senses this machine really has (agent.ts).
 *
 * The tool DESCRIPTION teaches all four actions on every machine, but which of
 * them resolve is per-machine — a Wayland box without wl-clipboard has no
 * clipboard, a Windows one has no notifier, a headless Linux one has neither —
 * and without this the agent discovers that only by calling and being told "no
 * backend". The cost isn't the wasted call: it's a daemon that says "I'll let
 * you know when the build finishes" on a machine that cannot tell anyone
 * anything, which is precisely the promise use_desktop exists to keep.
 *
 * Pure and separate from buildSystemPrompt so the wording that carries that
 * distinction is testable without standing up an Agent.
 */
export function desktopSenseBlock(senses: string[]): string {
  const list = senses.length ? senses.join(', ') : 'none'
  const reach = senses.includes('notify')
    ? 'You CAN reach the person at this keyboard: when long or background work finishes, notify instead of promising to follow up.'
    : 'You cannot notify from this machine — say so rather than promising to tell them later.'
  // Voice is the one sense whose ABSENCE is easy to promise around ("I'll read
  // it out to you"), and whose PRESENCE changes what the agent should offer at
  // all — a spoken answer is only a good idea if the machine can hear a reply.
  // 👀 The one sense whose presence changes which of TWO tools is right, rather
  // than whether a tool works at all. Without this line a model that knows about
  // read_image will keep OCR'ing a mock to answer a question about its layout.
  const sight = senses.includes('see')
    ? ` You can also LOOK at an image file with see_image (the picture itself enters the conversation) — but read_image first when the question is only about text: it is free and needs no vision tokens.${
      senses.includes('convert')
        ? ''
        // Without a resampler this machine can show png/jpeg/gif/webp as they
        // are, and nothing else. Saying so beats letting the agent discover it
        // per file: "convert it first" is advice it can act on for the user.
        : ' This machine has no image converter, so see_image only works on png/jpeg/gif/webp files already small enough to send — a heic or an oversized image has to be converted first.'
    }`
    : ''
  const voice = senses.includes('speak') && senses.includes('listen')
    ? ' This machine can speak out loud AND hear a spoken reply, so you may hold a real voice exchange (speak a question, then listen).'
    : senses.includes('speak')
      ? ' This machine can speak out loud but cannot hear a reply — never ask a spoken question expecting an answer.'
      : senses.includes('listen')
        ? ' This machine can hear and transcribe locally but has no voice — answer in text.'
        : ' This machine has no voice and no microphone; never offer to say something out loud or to listen.'
  return `\nuse_desktop senses that resolved on THIS machine: ${list} — anything not listed is unavailable here, so don't plan around it. ${reach}${voice}${sight}`
}
