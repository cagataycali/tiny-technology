/**
 * Device embodiment tools — the strands-icloud / strands-adb / spotify /
 * whatsapp / telegram surface, tiny-shaped.
 *
 * Zero Python: each tool wraps the native capability directly —
 *   use_apple     osascript + sqlite (Messages/Reminders/Calendar/Mail)         [macOS]
 *   use_mcp       every MCP server this machine is already configured for,
 *                 read from the files Claude Desktop/Code and Cursor wrote      → mcp.ts
 *   use_adb       adb binary (screenshots, taps, apps, shell)                   [adb in PATH]
 *   use_spotify   Web API [SPOTIFY_* env] + AppleScript app control [macOS]     → spotify.ts
 *   use_whatsapp  wacli binary (steipete/wacli — WhatsApp Web protocol)         → whatsapp.ts
 *   use_google    every Google API from its discovery doc (Gmail/Drive/Cal/…)   → google.ts
 *   use_telegram  Bot HTTP API                                                  [TELEGRAM_BOT_TOKEN]
 *   use_github    repos/issues/PRs/CI/code over REST + a GraphQL escape hatch,
 *                 token from env, gh, hosts.yml or the keychain               → github.ts
 *   use_computer  CoreGraphics via JXA + screencapture (mouse/keys/screen)      → computer.ts
 *   use_flipper   Flipper Zero CLI over USB serial (stty + fs)                  → flipper.ts
 *   use_image     a file's pixels into the conversation (sips/magick shrink)  → image.ts
 *
 * Tools self-register only when their backend exists — the agent's toolset
 * mirrors what this device can actually do.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync, execSync } from 'node:child_process'
import * as os from 'node:os'
import { makeComputerTool, hasComputerControl } from './computer.js'
import { hasWindowControl } from './windows.js'
import { makeFlipperTool, hasFlipper } from './flipper.js'
import { makeSpotifyTool, hasSpotify } from './spotify.js'
import { makeWhatsappTool, hasWhatsapp } from './whatsapp.js'
import { makeGoogleTool, hasGoogle } from './google.js'
import { applyStoredEnv } from '../integrations.js'
import { makeIntegrationsTool } from './integrations-tool.js'
import { makeNpmTool, hasNpm } from './npm.js'
import { makeOpenapiTool, hasOpenapi } from './openapi.js'
import { makeMemoryTool, hasMemory } from './memory.js'
import { makeMcpTool, hasMcp } from './mcp.js'
import { makeGithubTool, hasGithub } from './github.js'
import { makePypiTool, hasPython } from './pypi.js'
import { makeImageTool } from './image.js'

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
  /** Apple Events exist, so windows can be arranged. */
  windowControl: boolean
}): string[] {
  const out: string[] = []
  // Actions ON use_computer — they share its top-left coordinate space, so a
  // window rect and a click are directly comparable. Gated separately because
  // Apple Events and screencapture are different grants, and "can ARRANGE its
  // screen, not just look at it" is what a remote agent needs before planning a
  // task that spans two apps.
  if (f.computer && f.windowControl) out.push('windows')
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
  if (canComputer) {
    tools.push(makeComputerTool())
    labels.push('computer')
    // `windows` rides on this tool — decided below, in labelOnlyCapabilities.
  }
  // LABEL WITH NO TOOL OF ITS OWN — `windows`. It is an action ON use_computer,
  // but it is a fact a REMOTE agent needs before it plans: "this machine can
  // ARRANGE its screen", which the tool's own name doesn't carry.
  //
  // ⚠️ Decided in labelOnlyCapabilities, not here, because every mis-gating this
  //    file has had was in these lines and none of it was testable. Pure
  //    function, real test. Do not re-inline: on a developer's Mac every probe
  //    answers yes, so a wrong gate here looks exactly like a right one.
  labels.push(...labelOnlyCapabilities({
    computer: canComputer,
    windowControl: hasWindowControl(),
  }))
  // Hardware gate: a Flipper is either on a serial port right now or it isn't.
  if (hasFlipper()) { tools.push(makeFlipperTool()); labels.push('flipper') }
  if (has('adb')) { tools.push(makeAdbTool()); labels.push('adb') }
  if (hasWhatsapp()) { tools.push(makeWhatsappTool()); labels.push('whatsapp') }
  // OAuth token, service account, or API key — any one is enough.
  if (hasGoogle()) { tools.push(makeGoogleTool()); labels.push('google') }
  if (process.env.TELEGRAM_BOT_TOKEN) { tools.push(makeTelegramTool(process.env.TELEGRAM_BOT_TOKEN)); labels.push('telegram') }

  // 📦 The package universes — any npm/pypi package as a native tool, on
  // demand. Gated the same way everything else is: on the binary existing.
  // npm is guaranteed wherever tiny-tech was npx-installed, but an embedder
  // might not have it on PATH; python3 genuinely varies.
  if (hasNpm()) { tools.push(makeNpmTool()); labels.push('npm') }
  if (hasPython()) { tools.push(makePypiTool()); labels.push('pypi') }

  // 🔗 The same idea aimed at the rest of the internet: any HTTP API that ships
  // an OpenAPI spec, called by operation name with real validation. Nothing to
  // install and no binary to gate on — it's fetch and a parser — so it's on
  // unless TINY_OPENAPI=0.
  if (hasOpenapi()) { tools.push(makeOpenapiTool()); labels.push('openapi') }

  // 🧠 Memory that survives being logged out. tiny_learn/tiny_recall are better
  // — semantic, cross-device, linked — and need an account and a network; this
  // is a file on this machine, so the daemon on a box that never signed in
  // still remembers what it was told. Nothing to probe for: it's a file.
  if (hasMemory()) { tools.push(makeMemoryTool()); labels.push('memory') }


  // 🧩 The other direction of MCP. src/server.ts makes THIS machine an MCP
  // server; this makes it a client of every server the user already configured
  // for Claude Desktop, Claude Code or Cursor — 10 of them on the author's Mac,
  // read from the files those clients already wrote (devduck reads one env var
  // and so finds none of them). Gated on a server being configured somewhere: a
  // tool whose every answer is "nothing is configured" is prompt with no
  // capability behind it. Connections are lazy, so the gate costs six failed
  // stats and one 0.2 ms parse, not ten child processes.
  if (hasMcp()) { tools.push(makeMcpTool()); labels.push('mcp') }

  // 🐙 GitHub. devduck's version is one raw GraphQL endpoint behind a
  // GITHUB_TOKEN env var; this one also finds the token gh CLI or the keychain
  // already has, which is how a developer machine is actually authenticated.
  // The gate spawns nothing — an env read, one stat for gh's hosts.yml and a
  // PATH walk for `gh` — because the alternative is 29 ms of `gh auth token`
  // on every tiny start, whether or not anyone asks about a repo.
  if (hasGithub()) { tools.push(makeGithubTool()); labels.push('github') }

  // 👀 Sight for FILES. use_computer shows the model the screen; this shows it
  // a photo, a render, a downloaded image. Always on: reading png/jpeg/gif/webp
  // needs only fs, and the header parser sizes them without a binary. Only
  // converting heic/tiff or shrinking a 12MP photo needs sips or ImageMagick,
  // and the tool says so on that path instead of gating the whole capability
  // on it (the mistake the old `see` label made).
  tools.push(makeImageTool()); labels.push('image')


  // Always on: the machine with NOTHING connected is exactly the machine
  // that needs a way to connect — see integrations-tool.ts.
  tools.push(makeIntegrationsTool()); labels.push('integrations')

  return { tools, labels }
}
