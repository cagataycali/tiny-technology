/**
 * use_integrations — app connections as a TOOL, not just a CLI wizard.
 *
 * `tiny-tech connect` exists for the terminal, but the person most likely to
 * ask "can you read my email?" is talking to the AGENT — which until now could
 * only answer "go run a command". This tool gives the agent the same three
 * verbs the wizard has (status / save / authorize), so onboarding becomes a
 * conversation: the agent explains what a service unlocks, tells the user
 * exactly what to paste, stores it, and kicks off the browser OAuth itself.
 *
 * What stays HUMAN-ONLY, on purpose:
 *   - WhatsApp linking (`wacli auth`) — the QR code needs a real TTY; the tool
 *     explains the step instead of pretending it can do it.
 *   - Nothing here prints a stored secret back. status shows presence, never
 *     values, so credentials can't leak into conversation history / the mesh.
 *
 * Registration: ALWAYS (see device-tools.ts) — a machine with nothing
 * connected is exactly the machine that needs this tool.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  SERVICE_KEYS, SERVICE_LABELS, isServiceKey, saveIntegration, forgetIntegration,
  serviceStatuses, renderStatuses, type ServiceKey,
} from '../integrations.js'

const SETUP_GUIDES: Record<ServiceKey, string> = {
  google: `Google setup (a Desktop-app OAuth client of YOUR own — your data never passes through tiny):
1. https://console.cloud.google.com/apis/credentials
2. Create credentials → OAuth client ID → Application type: **Desktop app** (not Web!)
3. Download the client_secret_*.json (or copy the client ID + secret)
4. Enable the APIs you want for that project (Gmail, Calendar, Drive, …)
5. If the consent screen is in Testing mode, add yourself as a test user
Then: use_integrations save google client_json_path=<path> (or client_id= + client_secret=)
Then: use_integrations login google  (opens the browser for consent)
Note: Google no longer allows the Photos scope alongside others — it's excluded by default.`,
  spotify: `Spotify setup (an app of your own):
1. https://developer.spotify.com/dashboard → Create app
2. Redirect URI: http://127.0.0.1:8888/callback  (exactly this)
3. Copy the Client ID and Client secret
Then: use_integrations save spotify client_id=... client_secret=...
Then: use_integrations login spotify  (opens the browser for consent)
Playback control needs Premium; on a Mac the local app works regardless.`,
  telegram: `Telegram setup:
1. Message @BotFather on Telegram → /newbot → it hands you a token
Then: use_integrations save telegram token=<bot token>
The token is verified against getMe before it's stored.`,
  whatsapp: `WhatsApp setup (human step — a QR code needs your phone and a real terminal):
1. Install wacli: https://github.com/steipete/wacli (brew install steipete/tap/wacli)
2. Run in a terminal:  wacli auth   — scan the QR with WhatsApp → Settings → Linked devices
3. wacli then syncs message history locally; everything stays on this machine.
The tool registers automatically once wacli reports authorized.`,
}

export function makeIntegrationsTool() {
  return tool({
    name: 'use_integrations',
    description: `Connect this device to Google, Spotify, Telegram, WhatsApp — the agent-side of \`tiny-tech connect\`. Walk the user through onboarding conversationally. Actions:
- status — every service: ready / partial / missing, with what connecting unlocks
- guide (service) — exact setup steps to read back to the user (where to click, what to paste)
- save (service + credentials) — store what the user pasted (~/.tiny/integrations.json, 0600). google: client_json_path OR client_id+client_secret · spotify: client_id+client_secret [+redirect_uri] · telegram: token (verified before storing)
- login (service) — start browser OAuth for google/spotify (needs prior save). The user finishes in the browser.
- forget (service) — remove a stored connection
Secrets are never echoed back. WhatsApp linking is guide-only (QR needs a terminal).`,
    inputSchema: z.object({
      action: z.enum(['status', 'guide', 'save', 'login', 'forget']),
      service: z.string().optional().describe('google | spotify | telegram | whatsapp'),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
      client_json_path: z.string().optional().describe('google: path to downloaded client_secret_*.json'),
      redirect_uri: z.string().optional().describe('spotify only (default http://127.0.0.1:8888/callback)'),
      token: z.string().optional().describe('telegram bot token'),
    }),
    callback: async (a) => {
      try {
        if (a.action === 'status') {
          const statuses = await serviceStatuses()
          return renderStatuses(statuses) + '\n\nUnlocks:\n'
            + statuses.map((s) => `  ${s.label}: ${s.unlocks}`).join('\n')
        }

        const service = (a.service || '').toLowerCase()
        if (!isServiceKey(service)) {
          return `need service: ${SERVICE_KEYS.join(' | ')}`
        }
        const key = service as ServiceKey

        if (a.action === 'guide') return SETUP_GUIDES[key]

        if (a.action === 'forget') {
          return forgetIntegration(key)
            ? `${SERVICE_LABELS[key]} connection removed`
            : `${SERVICE_LABELS[key]} had nothing stored`
        }

        if (a.action === 'save') {
          switch (key) {
            case 'google': {
              if (a.client_json_path) {
                const path = a.client_json_path.replace(/^~(?=\/)/, homedir())
                if (!existsSync(path)) return `no file at ${path}`
                saveIntegration('google', { GOOGLE_OAUTH_CLIENT: path })
                return `Google client saved (${path}). Next: use_integrations login google`
              }
              if (a.client_id && a.client_secret) {
                saveIntegration('google', {
                  GOOGLE_OAUTH_CLIENT_ID: a.client_id,
                  GOOGLE_OAUTH_CLIENT_SECRET: a.client_secret,
                })
                return 'Google client saved. Next: use_integrations login google'
              }
              return 'google save needs client_json_path OR client_id + client_secret'
            }
            case 'spotify': {
              if (!a.client_id || !a.client_secret) return 'spotify save needs client_id + client_secret'
              saveIntegration('spotify', {
                SPOTIFY_CLIENT_ID: a.client_id,
                SPOTIFY_CLIENT_SECRET: a.client_secret,
                SPOTIFY_REDIRECT_URI: a.redirect_uri || 'http://127.0.0.1:8888/callback',
              })
              return 'Spotify app saved. Next: use_integrations login spotify'
            }
            case 'telegram': {
              if (!a.token) return 'telegram save needs token'
              // Verify before storing — a typo'd token otherwise fails much
              // later, inside a tool call, looking like a Telegram outage.
              const who: any = await fetch(`https://api.telegram.org/bot${a.token}/getMe`)
                .then((r) => r.json()).catch(() => null)
              if (!who?.ok) return `Telegram rejected that token (${who?.description || 'no response'}) — not saved`
              saveIntegration('telegram', { TELEGRAM_BOT_TOKEN: a.token })
              return `Telegram connected as @${who.result?.username}. Restart the daemon to register use_telegram.`
            }
            case 'whatsapp':
              return 'WhatsApp has no credentials to save — linking is a QR scan:\n' + SETUP_GUIDES.whatsapp
          }
        }

        if (a.action === 'login') {
          switch (key) {
            case 'google': {
              const { googleLogin, defaultScopes, credentialSource } = await import('./google.js')
              const path = await googleLogin(defaultScopes())
              return `Google connected (${credentialSource()}) — token at ${path}. Restart the daemon to register use_google.`
            }
            case 'spotify': {
              const { spotifyLogin } = await import('./spotify.js')
              const path = await spotifyLogin()
              return `Spotify connected — token at ${path}. Restart the daemon so use_spotify picks up the Web API.`
            }
            default:
              return `${SERVICE_LABELS[key]} has no browser login — see: use_integrations guide ${key}`
          }
        }

        return `unknown action: ${a.action}`
      } catch (e: any) {
        return `use_integrations error: ${String(e?.message || e).slice(0, 400)}`
      }
    },
  })
}
