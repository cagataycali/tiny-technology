/**
 * Device embodiment tools — the strands-icloud / strands-adb / spotify /
 * whatsapp / telegram surface, tiny-shaped.
 *
 * Zero Python: each tool wraps the native capability directly —
 *   use_apple     osascript + sqlite (Messages/Notes/Reminders/Calendar/Mail)   [macOS]
 *   use_adb       adb binary (screenshots, taps, apps, shell)                   [adb in PATH]
 *   use_spotify   Web API [SPOTIFY_* env] + AppleScript app control [macOS]     → spotify.ts
 *   use_whatsapp  wacli binary (steipete/wacli — WhatsApp Web protocol)         → whatsapp.ts
 *   use_google    every Google API from its discovery doc (Gmail/Drive/Cal/…)   → google.ts
 *   use_telegram  Bot HTTP API                                                  [TELEGRAM_BOT_TOKEN]
 *   use_computer  CoreGraphics via JXA + screencapture (mouse/keys/screen),
 *                 plus read_screen/find_text — Vision OCR on the ANE           → computer.ts + vision.ts
 *   use_browse    a real Chrome over CDP (JS-rendered pages, logins, clicks)    → browse.ts
 *   use_flipper   Flipper Zero CLI over USB serial (stty + fs)                  → flipper.ts
 *   use_desktop   OS notifications + clipboard + open (reach the human here),
 *                 plus speak/listen — local voice, on-device Speech           → desktop.ts + speech.ts
 *
 * Tools self-register only when their backend exists — the agent's toolset
 * mirrors what this device can actually do.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync, execSync } from 'node:child_process'
import * as os from 'node:os'
import { makeComputerTool, hasComputerControl } from './computer.js'
import { hasVisionOcr } from './vision.js'
import { hasWindowControl } from './windows.js'
import { makeFlipperTool, hasFlipper } from './flipper.js'
import { makeSpotifyTool, hasSpotify } from './spotify.js'
import { makeWhatsappTool, hasWhatsapp } from './whatsapp.js'
import { makeGoogleTool, hasGoogle } from './google.js'
import { makeDesktopTool, hasDesktopSenses } from './desktop.js'
import { hasLocalSpeech } from './speech.js'
import { makeBrowseTool, hasBrowser } from './browse.js'
import { applyStoredEnv } from '../integrations.js'
import { makeIntegrationsTool } from './integrations-tool.js'

const isMac = os.platform() === 'darwin'

function has(bin: string): boolean {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true } catch { return false }
}

function sh(cmd: string, timeoutMs = 30_000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function osa(script: string, timeoutMs = 30_000): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: timeoutMs }).trim()
}

// ── use_apple ───────────────────────────────────────────────────────────────

function makeAppleTool() {
  return tool({
    name: 'use_apple',
    description: `Apple ecosystem control on this Mac (local, via osascript). Actions:
- messages.send (to=phone/email, text) — send iMessage
- messages.list (limit) — recent messages from chat.db
- notes.create (title, body) / notes.list (limit)
- reminders.create (title, due='YYYY-MM-DD HH:MM') / reminders.list
- calendar.events (days) — upcoming events
- calendar.create (title, start='YYYY-MM-DD HH:MM', end)
- mail.unread (limit) / mail.send (to, subject, body)
- contacts.search (query)`,
    inputSchema: z.object({
      action: z.string(),
      to: z.string().optional(),
      text: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      subject: z.string().optional(),
      query: z.string().optional(),
      due: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      days: z.number().optional(),
      limit: z.number().optional(),
    }),
    callback: async (a) => {
      const esc = (s?: string) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const limit = a.limit || 10
      try { switch (a.action) {
        case 'messages.send':
          if (!a.to || !a.text) return 'need to + text'
          return osa(`tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${esc(a.to)}" of targetService
  send "${esc(a.text)}" to targetBuddy
end tell`) || `sent to ${a.to}`
        case 'messages.list':
          try {
            return sh(`sqlite3 ~/Library/Messages/chat.db "SELECT datetime(m.date/1000000000 + strftime('%s','2001-01-01'),'unixepoch','localtime') as ts, h.id, substr(m.text,1,120) FROM message m JOIN handle h ON m.handle_id=h.ROWID WHERE m.text IS NOT NULL ORDER BY m.date DESC LIMIT ${limit};"`)
          } catch (e: any) { return `chat.db unreadable (need Full Disk Access): ${e.message}` }
        case 'notes.create':
          return osa(`tell application "Notes" to make new note at folder "Notes" with properties {name:"${esc(a.title)}", body:"${esc(a.body)}"}`) && `note created: ${a.title}`
        case 'notes.list':
          return osa(`tell application "Notes" to get name of notes 1 thru ${limit}`)
        case 'reminders.create': {
          const dueClause = a.due ? `, due date:date "${esc(a.due)}"` : ''
          return osa(`tell application "Reminders" to make new reminder with properties {name:"${esc(a.title)}"${dueClause}}`) && `reminder created: ${a.title}`
        }
        case 'reminders.list':
          return osa(`tell application "Reminders" to get name of reminders whose completed is false`)
        case 'calendar.events': {
          // launch hidden in background first — AppleScript 'launch' is flaky
          try { sh('open -gja Calendar'); await new Promise((r) => setTimeout(r, 2500)) } catch { /* try anyway */ }
          return osa(`set out to ""
tell application "Calendar"
  set nowD to current date
  set endD to nowD + (${a.days || 7} * days)
  repeat with c in calendars
    repeat with e in (events of c whose start date ≥ nowD and start date ≤ endD)
      set out to out & (summary of e) & " — " & ((start date of e) as string) & linefeed
    end repeat
  end repeat
end tell
return out`, 60_000) || 'no upcoming events'
        }
        case 'calendar.create':
          if (!a.title || !a.start) return 'need title + start'
          return osa(`tell application "Calendar" to tell calendar 1 to make new event with properties {summary:"${esc(a.title)}", start date:date "${esc(a.start)}"${a.end ? `, end date:date "${esc(a.end)}"` : ''}}`) && `event created: ${a.title}`
        case 'mail.unread':
          return osa(`tell application "Mail" to get subject of (messages of inbox whose read status is false)`) || 'no unread'
        case 'mail.send':
          if (!a.to || !a.subject) return 'need to + subject'
          return osa(`tell application "Mail"
  set msg to make new outgoing message with properties {subject:"${esc(a.subject)}", content:"${esc(a.body)}", visible:false}
  tell msg to make new to recipient with properties {address:"${esc(a.to)}"}
  send msg
end tell`) || `mail sent to ${a.to}`
        case 'contacts.search':
          return osa(`tell application "Contacts" to get name of (people whose name contains "${esc(a.query)}")`)
        default:
          return `unknown action: ${a.action}`
      } } catch (e: any) { return `error: ${String(e?.stderr || e?.message || e).slice(0, 500)}` }
    },
  })
}

// ── use_adb ─────────────────────────────────────────────────────────────────

function makeAdbTool() {
  return tool({
    name: 'use_adb',
    description: `Control a connected Android device via adb (strands-adb surface). Actions:
- devices — list connected devices
- screenshot (output_path) — capture screen, returns path
- tap (x, y) / swipe (x1,y1,x2,y2) / type (text) / key (key e.g. HOME, BACK, ENTER)
- launch (packageName) / list_packages (filter) / current_app
- shell (command) — raw adb shell
- open_url (url) / notifications / battery`,
    inputSchema: z.object({
      action: z.string(),
      x: z.number().optional(), y: z.number().optional(),
      x1: z.number().optional(), y1: z.number().optional(),
      x2: z.number().optional(), y2: z.number().optional(),
      text: z.string().optional(),
      key: z.string().optional(),
      packageName: z.string().optional(),
      filter: z.string().optional(),
      command: z.string().optional(),
      url: z.string().optional(),
      output_path: z.string().optional(),
    }),
    callback: async (a) => {
      const adb = (args: string) => sh(`adb ${args}`, 60_000)
      try { switch (a.action) {
        case 'devices': return adb('devices -l')
        case 'screenshot': {
          const out = a.output_path || `/tmp/tiny_adb_${Date.now()}.png`
          adb(`exec-out screencap -p > ${out}`)
          return `screenshot saved: ${out}`
        }
        case 'tap': return adb(`shell input tap ${a.x} ${a.y}`) || `tapped ${a.x},${a.y}`
        case 'swipe': return adb(`shell input swipe ${a.x1} ${a.y1} ${a.x2} ${a.y2} 300`) || 'swiped'
        case 'type': return adb(`shell input text "${(a.text || '').replace(/ /g, '%s').replace(/"/g, '\\"')}"`) || `typed`
        case 'key': return adb(`shell input keyevent KEYCODE_${(a.key || '').toUpperCase().replace(/^KEYCODE_/, '')}`) || `key ${a.key}`
        case 'launch': return adb(`shell monkey -p ${a.packageName} -c android.intent.category.LAUNCHER 1`)
        case 'list_packages': return adb(`shell pm list packages ${a.filter ? `| grep -i ${a.filter}` : ''}`)
        case 'current_app': return adb(`shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -2`)
        case 'shell': return adb(`shell ${a.command}`)
        case 'open_url': return adb(`shell am start -a android.intent.action.VIEW -d "${a.url}"`)
        case 'notifications': return adb(`shell dumpsys notification --noredact | grep -E 'android.title|android.text' | head -40`)
        case 'battery': return adb(`shell dumpsys battery`)
        default: return `unknown action: ${a.action}`
      } } catch (e: any) { return `error: ${String(e?.stderr || e?.message || e).slice(0, 500)}` }
    },
  })
}

// ── use_telegram ────────────────────────────────────────────────────────────

function makeTelegramTool(token: string) {
  const api = async (method: string, params: Record<string, any> = {}) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    return JSON.stringify(await res.json())
  }
  return tool({
    name: 'use_telegram',
    description: `Telegram bot (TELEGRAM_BOT_TOKEN). Actions:
- send (chat_id, text) — send message (HTML parse mode)
- updates (limit) — recent incoming messages
- me — bot identity`,
    inputSchema: z.object({
      action: z.string(),
      chat_id: z.union([z.string(), z.number()]).optional(),
      text: z.string().optional(),
      limit: z.number().optional(),
    }),
    callback: async (a) => {
      switch (a.action) {
        case 'send':
          if (!a.chat_id || !a.text) return 'need chat_id + text'
          return api('sendMessage', { chat_id: a.chat_id, text: a.text, parse_mode: 'HTML' })
        case 'updates': return api('getUpdates', { limit: a.limit || 10 })
        case 'me': return api('getMe')
        default: return `unknown action: ${a.action}`
      }
    },
  })
}

// ── the label-only capabilities ─────────────────────────────────────────────

/**
 * Which capabilities are announced that have no tool of their OWN.
 *
 * Extracted as a pure function over probed facts for one reason: every mistake
 * this file has made was here, and none of them was reachable by a test. `ocr`
 * lived inside the screencapture gate and so denied itself on a Mac that could
 * OCR a file; `see` required sips and so denied itself on a machine that could
 * show a png. Both are the same error — a label narrower than the actions the
 * daemon actually registered — and both are invisible on the developer's Mac,
 * where every probe answers yes. Now they are a table, and the table is tested.
 *
 * The rule the whole function encodes: a label must be announced when ANY route
 * to it registered, and never when NONE did. Wider than the truth strands a
 * remote agent's plan on a capability that isn't there; narrower stops it from
 * ever asking for one that is.
 */
export function labelOnlyCapabilities(f: {
  /** use_computer registered — the screen is readable and clickable. */
  computer: boolean
  /** use_desktop registered — at least one sense resolved. */
  desktop: boolean
  /** Apple Events exist, so windows can be arranged. */
  windowControl: boolean
  /** macOS Vision exists, so pixels can become text locally. */
  visionOcr: boolean
  /** A local synthesiser or speech model exists. */
  localSpeech: boolean
}): string[] {
  const out: string[] = []
  // Actions ON use_computer — they share its top-left coordinate space, so an
  // OCR centre and a window rect are directly comparable. Gated separately
  // because Apple Events and screencapture are different grants, and "can
  // ARRANGE its screen, not just look at it" is what a remote agent needs
  // before planning a task that spans two apps.
  if (f.computer && f.windowControl) out.push('windows')
  // Actions ON use_desktop: speak/listen belong with notify, the channels that
  // don't go through the screen. `desktop` alone doesn't say "this machine can be
  // TALKED TO and can answer out loud" — a synthesiser and an on-device speech
  // model are gated on different things than a clipboard.
  if (f.desktop && f.localSpeech) out.push('voice')
  // The only one spanning TWO tools. Vision reads text in two places:
  // read_screen/find_text on use_computer (coordinates you can click) and
  // read_image on use_desktop (a file's own coordinates, which you cannot). They
  // ride different tools because they answer different questions, but "this
  // machine can read pixels into text locally, for free" is ONE fact — so it is
  // announced when EITHER route exists.
  if (f.visionOcr && (f.computer || f.desktop)) out.push('ocr')
  // Deliberately SEPARATE from `ocr`: a remote agent that sees `ocr` but not
  // `see` knows to ask this node what a file SAYS and not what it LOOKS LIKE,
  // and one that sees `see` knows a picture on this disk can reach a model at
  // all — which is the whole point of routing the work here. Needs no binary
  // (see.ts measureHeader), so the only question left is whether the tool
  // carrying see_image registered.
  if (f.desktop) out.push('see')
  return out
}

// ── registry ────────────────────────────────────────────────────────────────

/** Build device tools for whatever this machine can actually do. */
export function makeDeviceTools(): { tools: any[]; labels: string[] } {
  // What `tiny-tech connect` stored, in env form — every gate below reads env
  // vars, so this is what makes a connection outlive the terminal it was made
  // in. cli.ts does it too; doing it here keeps embedders honest.
  applyStoredEnv()
  const tools: any[] = []
  const labels: string[] = []

  if (isMac && has('osascript')) { tools.push(makeAppleTool()); labels.push('apple') }
  // Spotify gates on either backend: Web API credentials OR the local app.
  if (hasSpotify()) { tools.push(makeSpotifyTool()); labels.push('spotify') }
  const canComputer = hasComputerControl()
  let canDesktop = false
  if (canComputer) {
    tools.push(makeComputerTool())
    labels.push('computer')
    // `windows` rides on this tool — decided below, in labelOnlyCapabilities.
  }
  // A real browser — gated on a Chromium-based binary EXISTING, not on being
  // able to launch one: launching costs ~300MB and a second, so the probe is a
  // path check and the failure (a browser that won't start) is reported by the
  // tool. Cross-platform, unlike use_computer: CDP is the same on all three.
  if (hasBrowser()) { tools.push(makeBrowseTool()); labels.push('browse') }
  // Notifications + clipboard: how a HEADLESS daemon reaches the person at this
  // machine, and how it shares data with apps without driving a UI. Registered
  // when at least one sense resolves — see hasDesktopSenses.
  if (hasDesktopSenses()) {
    tools.push(makeDesktopTool())
    labels.push('desktop')
    // `voice` and `see` ride on this tool — decided below, same reason.
    canDesktop = true
  }
  // LABELS WITH NO TOOL OF THEIR OWN — `windows`, `voice`, `ocr`, `see`. They
  // are actions ON the tools above, but each is a fact a REMOTE agent needs
  // before it plans, and the tool's own name doesn't carry it: "this machine can
  // ARRANGE its screen", "can be TALKED TO", "can read pixels into text for
  // free", "can put a picture in front of a model".
  //
  // ⚠️ Decided in labelOnlyCapabilities, not here, because EVERY mis-gating this
  //    file has had was in these four lines and none of it was testable — `ocr`
  //    sat inside the screencapture gate and denied itself on a Mac that could
  //    OCR a file; `see` required sips and denied itself on a machine that could
  //    show a png. Pure function, real test, whole matrix. Do not re-inline
  //    these: on a developer's Mac every probe answers yes, so a wrong gate here
  //    looks exactly like a right one.
  labels.push(...labelOnlyCapabilities({
    computer: canComputer,
    desktop: canDesktop,
    windowControl: hasWindowControl(),
    visionOcr: hasVisionOcr(),
    localSpeech: hasLocalSpeech(),
  }))
  // Hardware gate: a Flipper is either on a serial port right now or it isn't.
  if (hasFlipper()) { tools.push(makeFlipperTool()); labels.push('flipper') }
  if (has('adb')) { tools.push(makeAdbTool()); labels.push('adb') }
  if (hasWhatsapp()) { tools.push(makeWhatsappTool()); labels.push('whatsapp') }
  // OAuth token, service account, or API key — any one is enough.
  if (hasGoogle()) { tools.push(makeGoogleTool()); labels.push('google') }
  if (process.env.TELEGRAM_BOT_TOKEN) { tools.push(makeTelegramTool(process.env.TELEGRAM_BOT_TOKEN)); labels.push('telegram') }

  // Always on: the machine with NOTHING connected is exactly the machine
  // that needs a way to connect — see integrations-tool.ts.
  tools.push(makeIntegrationsTool()); labels.push('integrations')

  return { tools, labels }
}
