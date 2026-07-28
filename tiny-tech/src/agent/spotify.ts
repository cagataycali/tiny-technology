/**
 * use_spotify — the Spotify Web API, full library and playback control.
 *
 * DevDuck's tools/use_spotify.py ported to TypeScript. Python used spotipy;
 * this is `fetch` plus a refresh-token grant, so nothing needs installing.
 *
 * TWO BACKENDS, and the difference matters to the model:
 *   web  (SPOTIFY_CLIENT_ID/SECRET) — search, playlists, library, queue,
 *        recommendations, and playback on ANY of the user's devices (phone,
 *        speaker, another laptop). Playback control needs Premium.
 *   app  (AppleScript, macOS)       — only the Spotify app on THIS Mac, but
 *        zero config and no Premium requirement.
 * Both register as one tool: the Web API is used when credentials exist and
 * AppleScript covers local transport, so `pause` works on a free account.
 *
 * The refresh token is shared with spotipy's cache when one exists, so a
 * machine already authorized through DevDuck needs no second login.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const API = 'https://api.spotify.com/v1'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const AUTH_URL = 'https://accounts.spotify.com/authorize'

const isMac = platform() === 'darwin'

/**
 * Endpoints Spotify closed to new/standard-quota apps in November 2024. They
 * answer 403/404 regardless of scope, so a plain status code misleads.
 */
export const DEPRECATED_PATHS = [
  'recommendations',
  'audio-features',
  'audio-analysis',
  'browse/featured-playlists',
  'browse/categories',
]

/** `artists/<id>/top-tracks` and `/related-artists` are restricted the same way. */
export function isDeprecatedArtistPath(path: string): boolean {
  return /^artists\/[^/]+\/(top-tracks|related-artists)$/.test(path)
}

export const SPOTIFY_SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'user-read-recently-played', 'user-top-read', 'user-library-read', 'user-library-modify',
  'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public',
  'playlist-modify-private', 'user-follow-read', 'user-follow-modify',
  'user-read-private', 'user-read-email',
]

// ── credentials ─────────────────────────────────────────────────────────────

function tinyHome(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

export function spotifyTokenPath(): string {
  return join(tinyHome(), 'spotify-token.json')
}

/** spotipy's cache — same refresh token, so DevDuck's login carries over. */
function spotipyCachePath(): string {
  return process.env.SPOTIPY_CACHE_PATH || join(homedir(), '.cache', 'spotipy_devduck_token')
}

interface TokenCache {
  refresh_token?: string
  access_token?: string
  expires_at?: number
}

function readTokenCache(): { creds: TokenCache; path: string } | null {
  for (const path of [spotifyTokenPath(), spotipyCachePath()]) {
    try {
      const creds = JSON.parse(fs.readFileSync(path, 'utf-8')) as TokenCache
      if (creds.refresh_token) return { creds, path }
    } catch { /* try the next location */ }
  }
  return null
}

function clientCreds(): { id: string; secret: string } | null {
  const id = process.env.SPOTIFY_CLIENT_ID
  const secret = process.env.SPOTIFY_CLIENT_SECRET
  return id && secret ? { id, secret } : null
}

/** Is the Web API usable — app credentials AND a stored refresh token. */
export function hasSpotifyWebApi(): boolean {
  return clientCreds() !== null && readTokenCache() !== null
}

/** Any Spotify backend at all — the tool's registration gate. */
export function hasSpotify(): boolean {
  return hasSpotifyWebApi() || (isMac && appInstalled())
}

function appInstalled(): boolean {
  return fs.existsSync('/Applications/Spotify.app')
}

let cachedToken: { token: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.token

  const client = clientCreds()
  if (!client) throw new Error('no Spotify app credentials — run `npx tiny-tech connect spotify` (or set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET)')
  const cache = readTokenCache()
  if (!cache) throw new Error("no Spotify refresh token — run `npx tiny-tech connect spotify`, or use_spotify action='login'")

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cache.creds.refresh_token! }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!data.access_token) {
    throw new Error(`Spotify token refresh failed: ${data.error || res.status} ${data.error_description || ''} — run action='login'`)
  }
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
  cachedToken = { token: data.access_token, expiresAt }
  // Spotify may hand back a rotated refresh token; losing it means re-login
  try {
    const merged = {
      ...cache.creds,
      access_token: data.access_token,
      refresh_token: data.refresh_token || cache.creds.refresh_token,
      expires_at: Math.floor(expiresAt / 1000),
    }
    fs.mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(spotifyTokenPath(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  } catch { /* refresh still worked; we just repeat it next run */ }
  return data.access_token
}

// ── login (loopback, PKCE-free — Spotify requires the client secret here) ────

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execFileSync(cmd, [url], { stdio: 'ignore' })
  } catch { /* headless — the URL is printed instead */ }
}

/**
 * Spotify validates redirect URIs against the dashboard allow-list, so unlike
 * Google's loopback flow the port can't be ephemeral — it must match what the
 * user registered. SPOTIFY_REDIRECT_URI is that registered value.
 */
export async function spotifyLogin(timeoutMs = 5 * 60 * 1000): Promise<string> {
  const client = clientCreds()
  if (!client) throw new Error('no Spotify app credentials — run `npx tiny-tech connect spotify` first')
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback'
  const parsed = new URL(redirectUri)
  if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
    throw new Error(`SPOTIFY_REDIRECT_URI must be a loopback URL for this flow (got ${redirectUri})`)
  }

  const { randomBytes } = await import('node:crypto')
  const { createServer } = await import('node:http')
  const state = randomBytes(16).toString('base64url')
  const port = Number(parsed.port || 8888)

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setTimeout(() => { try { server.close() } catch {} }, 100)
      fn()
    }
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const got = url.searchParams.get('code') || ''
        const ok = got && url.searchParams.get('state') === state
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' })
        res.end(`<!doctype html><html><head><title>tiny-tech · Spotify</title><style>
body{background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
h1{color:${ok ? '#1DB954' : '#ff6b6b'}}p{color:#888}</style></head><body><div style="text-align:center">
<h1>${ok ? '✓ Spotify connected' : '✗ Failed'}</h1><p>${ok ? 'Close this tab and return to your terminal.' : url.searchParams.get('error') || 'state mismatch'}</p></div></body></html>`)
        if (ok) finish(() => resolve(got))
      } catch {
        try { res.writeHead(400).end() } catch {}
      }
    })
    const timer = setTimeout(() => finish(() => reject(new Error('Spotify login timed out'))), timeoutMs)
    timer.unref()
    server.on('error', (e: any) => finish(() => reject(
      e?.code === 'EADDRINUSE'
        ? new Error(`port ${port} is busy — free it, or point SPOTIFY_REDIRECT_URI at another registered port`)
        : e,
    )))
    server.listen(port, '127.0.0.1', () => {
      const authUrl = `${AUTH_URL}?${new URLSearchParams({
        client_id: client.id,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SPOTIFY_SCOPES.join(' '),
        state,
      })}`
      process.stderr.write(`\nAuthorize tiny-tech for Spotify:\n  ${authUrl}\n\n`)
      openBrowser(authUrl)
    })
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!data.refresh_token) throw new Error(`Spotify token exchange failed: ${data.error || res.status} ${data.error_description || ''}`)
  fs.mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(spotifyTokenPath(), JSON.stringify({
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: Math.floor((Date.now() + (data.expires_in ?? 3600) * 1000) / 1000),
  }, null, 2) + '\n', { mode: 0o600 })
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return spotifyTokenPath()
}

// ── formatting (pure — unit-tested without a network) ───────────────────────

function ms(duration: number): string {
  const total = Math.round(duration / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatTrack(t: any, idx?: number): string {
  if (!t) return '(unavailable)'
  const artists = (t.artists || []).map((x: any) => x.name).filter(Boolean).join(', ')
  const album = t.album?.name
  const prefix = idx === undefined ? '•' : `${idx}.`
  return `${prefix} ${t.name}${artists ? ` — ${artists}` : ''}${album ? ` [${album}]` : ''}` +
    `${t.duration_ms ? ` (${ms(t.duration_ms)})` : ''}${t.uri ? `  ${t.uri}` : ''}`
}

export function formatArtist(a: any, idx?: number): string {
  const prefix = idx === undefined ? '•' : `${idx}.`
  const followers = a.followers?.total
  const genres = (a.genres || []).slice(0, 3).join(', ')
  return `${prefix} ${a.name}${followers ? ` (${followers.toLocaleString('en-US')} followers)` : ''}` +
    `${genres ? ` · ${genres}` : ''}${a.uri ? `  ${a.uri}` : ''}`
}

export function formatAlbum(a: any, idx?: number): string {
  const prefix = idx === undefined ? '•' : `${idx}.`
  const artists = (a.artists || []).map((x: any) => x.name).join(', ')
  return `${prefix} ${a.name}${artists ? ` — ${artists}` : ''}` +
    `${a.release_date ? ` (${a.release_date})` : ''}${a.total_tracks ? ` · ${a.total_tracks} tracks` : ''}${a.uri ? `  ${a.uri}` : ''}`
}

/** `now_playing` from a /me/player payload. Handles the 204 (nothing on). */
export function formatPlayback(p: any): string {
  if (!p || !p.item) return 'nothing playing'
  const t = p.item
  const artists = (t.artists || []).map((x: any) => x.name).join(', ')
  const pos = p.progress_ms ? `${ms(p.progress_ms)}/${ms(t.duration_ms || 0)}` : ms(t.duration_ms || 0)
  const device = p.device ? ` on ${p.device.name}${p.device.volume_percent != null ? ` (vol ${p.device.volume_percent}%)` : ''}` : ''
  const flags = [p.shuffle_state ? 'shuffle' : null, p.repeat_state && p.repeat_state !== 'off' ? `repeat:${p.repeat_state}` : null]
    .filter(Boolean).join(' ')
  return `${p.is_playing ? '▶' : '⏸'} ${t.name} — ${artists}${t.album?.name ? ` [${t.album.name}]` : ''}` +
    ` ${pos}${device}${flags ? ` · ${flags}` : ''}${t.uri ? `\n${t.uri}` : ''}`
}

/**
 * A bare name is not a Spotify URI, and passing one to the API 400s. Turn
 * whatever the model has — URI, open.spotify.com link, or bare id — into a URI.
 */
export function toUri(value: string, kind = 'track'): string {
  const v = value.trim()
  if (v.startsWith('spotify:')) return v
  const link = v.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]+)/)
  if (link) return `spotify:${link[1]}:${link[2]}`
  if (/^[A-Za-z0-9]{22}$/.test(v)) return `spotify:${kind}:${v}`
  return v
}

/** The id of a URI/link/bare id — path params take ids, not URIs. */
export function toId(value: string): string {
  const uri = toUri(value)
  const parts = uri.split(':')
  return parts.length > 1 ? parts[parts.length - 1] : uri
}

// ── the tool ────────────────────────────────────────────────────────────────

function osa(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 15_000 }).trim()
}

export function makeSpotifyTool() {
  const webApi = hasSpotifyWebApi()

  const api = async (path: string, init: { method?: string; body?: unknown; query?: Record<string, any> } = {}) => {
    const token = await accessToken()
    const url = new URL(`${API}/${path.replace(/^\//, '')}`)
    for (const [k, v] of Object.entries(init.query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    const res = await fetch(url.toString(), {
      method: init.method || 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (res.status === 204) return null // playback commands succeed with no body
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const reason = json?.error?.reason || ''
      const msg = json?.error?.message || text.slice(0, 300) || res.status
      // Spotify's two chronic 403/404s deserve their real explanation
      if (reason === 'NO_ACTIVE_DEVICE' || res.status === 404 && /player/.test(path)) {
        throw new Error("no active Spotify device — open Spotify somewhere (or use action='devices' then 'transfer'). On this Mac, playback actions fall back to the app automatically.")
      }
      if (reason === 'PREMIUM_REQUIRED') throw new Error('Spotify Premium is required for playback control via the Web API')
      // Spotify's Nov-2024 change 403/404s the algorithmic endpoints for apps
      // without extended quota. The raw "403 Forbidden" reads like a scope or
      // token problem, which sends the model off re-authorizing for nothing.
      if ((DEPRECATED_PATHS.some((p) => path.startsWith(p)) || isDeprecatedArtistPath(path)) && (res.status === 403 || res.status === 404)) {
        throw new Error(
          `Spotify no longer serves /${path} to this app (the Nov-2024 API restriction — not an auth problem). ` +
          `Use search, top_tracks/top_artists, or an artist's albums instead.`,
        )
      }
      throw new Error(`Spotify ${res.status}: ${msg}`)
    }
    return json
  }

  /** Local app control — works without Premium, only on this Mac. */
  const appTell = (cmd: string) => osa(`tell application "Spotify" to ${cmd}`)
  const canApp = isMac && appInstalled()

  const lines = (items: any[], fmt: (x: any, i: number) => string, empty = 'none') =>
    items?.length ? items.map((x, i) => fmt(x, i + 1)).join('\n') : empty

  return tool({
    name: 'use_spotify',
    description: `Spotify — ${webApi ? 'full Web API (library, search, playlists, any device)' : 'local app control via AppleScript'}${canApp ? ' + this Mac\'s Spotify app' : ''}.

Playback: now_playing, play (uri|context_uri), pause, next, previous, seek (position_ms), volume (volume 0-100), shuffle (state), repeat (state=track|context|off), transfer (device_id)
Queue: queue.add (uri), queue.list
Search: search (query, search_type=track|artist|album|playlist, limit)
Devices: devices — list where playback can go
Playlists: playlists, playlist.tracks (playlist_id), playlist.create (name, description, public), playlist.add (playlist_id, uris), playlist.remove (playlist_id, uris)
Library: liked, like (uris), unlike (uris)
Discovery: recent, top_tracks (time_range=short|medium|long_term), top_artists, recommendations (seed_tracks|seed_artists|seed_genres), genres
  — recommendations/genres and an artist's top-tracks are restricted by Spotify for most apps now; if they fail, reach for search + top_tracks/top_artists instead.
Browse: artist (artist_id) — info + top tracks + albums; album (album_id) — info + tracklist
User: profile, following, follow (artist_id), unfollow (artist_id)
Auth: auth — which backend is live; login — browser authorization for the Web API

uri/id fields accept a Spotify URI, an open.spotify.com link, or a bare id. To play something by name: search first, then play with the uri it returns.${canApp ? '\nplay/pause/next/previous/volume fall back to the local app when no Web API device is active, so they work on a free account.' : ''}`,
    inputSchema: z.object({
      action: z.string(),
      query: z.string().optional(),
      search_type: z.string().optional(),
      uri: z.string().optional().describe('track/episode URI, link, or id'),
      uris: z.string().optional().describe('comma-separated URIs/links/ids'),
      context_uri: z.string().optional().describe('album/playlist/artist to play'),
      offset: z.number().optional().describe('index within a context'),
      device_id: z.string().optional(),
      position_ms: z.number().optional(),
      volume: z.number().optional(),
      state: z.union([z.boolean(), z.string()]).optional().describe('shuffle: true/false · repeat: track|context|off'),
      playlist_id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      public: z.boolean().optional(),
      artist_id: z.string().optional(),
      album_id: z.string().optional(),
      time_range: z.string().optional(),
      seed_tracks: z.string().optional(),
      seed_artists: z.string().optional(),
      seed_genres: z.string().optional(),
      limit: z.number().optional(),
    }),
    callback: async (a) => {
      const limit = Math.min(a.limit || 20, 50)
      const uriList = (raw?: string, kind = 'track') =>
        (raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => toUri(s, kind))

      /**
       * Web API first, local app as the fallback. Not just for errors: a free
       * account or a Mac with no "active device" registered still has a running
       * Spotify.app, and the user means "pause the music", not "pause the API".
       */
      const withAppFallback = async (web: () => Promise<string>, app: () => string): Promise<string> => {
        if (!webApi) {
          if (!canApp) return 'no Spotify backend — set SPOTIFY_CLIENT_ID/SECRET, or install Spotify'
          return app()
        }
        try { return await web() } catch (e: any) {
          if (!canApp) throw e
          const out = app()
          // Say WHY it fell back in a clause, not by pasting a truncated
          // sentence — 'no active device' is the near-universal cause.
          const why = /no active Spotify device/.test(String(e.message)) ? 'no active Web API device'
            : String(e.message).replace(/\s+/g, ' ').slice(0, 80)
          return `${out} — via this Mac's Spotify app (${why})`
        }
      }

      try { switch (a.action) {
        // ── auth ────────────────────────────────────────────────────────────
        case 'auth': {
          const client = clientCreds()
          const cache = readTokenCache()
          const rows = [
            `Web API: ${webApi ? 'ready' : 'not configured'}`,
            `  client credentials: ${client ? 'set' : 'missing (SPOTIFY_CLIENT_ID/SECRET)'}`,
            `  refresh token: ${cache ? cache.path : "missing (run action='login')"}`,
            `Local app: ${canApp ? 'available (AppleScript, no Premium needed)' : 'not available'}`,
          ]
          if (webApi) {
            const me: any = await api('me')
            rows.push(`Account: ${me.display_name || me.id}${me.email ? ` <${me.email}>` : ''} · ${me.product}${me.country ? ` · ${me.country}` : ''}`)
          }
          return rows.join('\n')
        }
        case 'login':
          return `✓ Spotify authorized — refresh token saved to ${await spotifyLogin()}`

        // ── playback ────────────────────────────────────────────────────────
        case 'now_playing':
          return withAppFallback(
            async () => formatPlayback(await api('me/player')),
            () => osa(`tell application "Spotify"
  if player state is playing then
    return "▶ " & (name of current track) & " — " & (artist of current track) & " [" & (album of current track) & "]"
  else if player state is paused then
    return "⏸ " & (name of current track) & " — " & (artist of current track)
  else
    return "nothing playing"
  end if
end tell`),
          )
        case 'play': {
          const body: Record<string, unknown> = {}
          if (a.uri) body.uris = [toUri(a.uri)]
          if (a.context_uri) {
            body.context_uri = toUri(a.context_uri, 'playlist')
            if (a.offset !== undefined) body.offset = { position: a.offset }
          }
          return withAppFallback(
            async () => {
              await api('me/player/play', {
                method: 'PUT',
                query: a.device_id ? { device_id: a.device_id } : {},
                body: Object.keys(body).length ? body : undefined,
              })
              return `▶ playing${a.uri ? ` ${toUri(a.uri)}` : a.context_uri ? ` ${toUri(a.context_uri, 'playlist')}` : ''}`
            },
            () => {
              const target = a.uri || a.context_uri
              if (target) { appTell(`play track "${toUri(target)}"`); return `▶ playing ${toUri(target)}` }
              appTell('play')
              return '▶ playing'
            },
          )
        }
        case 'pause':
          return withAppFallback(
            async () => { await api('me/player/pause', { method: 'PUT', query: a.device_id ? { device_id: a.device_id } : {} }); return '⏸ paused' },
            () => { appTell('pause'); return '⏸ paused' },
          )
        case 'next':
          return withAppFallback(
            async () => { await api('me/player/next', { method: 'POST' }); return '⏭ skipped' },
            () => { appTell('next track'); return '⏭ skipped' },
          )
        case 'previous':
          return withAppFallback(
            async () => { await api('me/player/previous', { method: 'POST' }); return '⏮ previous' },
            () => { appTell('previous track'); return '⏮ previous' },
          )
        case 'seek': {
          if (a.position_ms === undefined) return 'need position_ms'
          const pos = a.position_ms
          return withAppFallback(
            async () => { await api('me/player/seek', { method: 'PUT', query: { position_ms: pos } }); return `⏩ seeked to ${ms(pos)}` },
            () => { appTell(`set player position to ${Math.round(pos / 1000)}`); return `⏩ seeked to ${ms(pos)}` },
          )
        }
        case 'volume': {
          if (a.volume === undefined) return 'need volume (0-100)'
          const vol = Math.max(0, Math.min(100, Math.round(a.volume)))
          return withAppFallback(
            async () => { await api('me/player/volume', { method: 'PUT', query: { volume_percent: vol, ...(a.device_id ? { device_id: a.device_id } : {}) } }); return `🔊 volume ${vol}%` },
            () => { appTell(`set sound volume to ${vol}`); return `🔊 volume ${vol}%` },
          )
        }
        case 'shuffle': {
          const on = typeof a.state === 'string' ? a.state === 'true' || a.state === 'on' : !!a.state
          return withAppFallback(
            async () => { await api('me/player/shuffle', { method: 'PUT', query: { state: on } }); return `🔀 shuffle ${on ? 'on' : 'off'}` },
            () => { appTell(`set shuffling to ${on}`); return `🔀 shuffle ${on ? 'on' : 'off'}` },
          )
        }
        case 'repeat': {
          const mode = String(a.state ?? 'off')
          if (!['track', 'context', 'off'].includes(mode)) return "state must be 'track', 'context', or 'off'"
          return withAppFallback(
            async () => { await api('me/player/repeat', { method: 'PUT', query: { state: mode } }); return `🔁 repeat ${mode}` },
            () => { appTell(`set repeating to ${mode !== 'off'}`); return `🔁 repeat ${mode !== 'off' ? 'on' : 'off'} (the app has no track/context distinction)` },
          )
        }
        case 'transfer':
          if (!a.device_id) return 'need device_id (action=devices lists them)'
          await api('me/player', { method: 'PUT', body: { device_ids: [a.device_id], play: true } })
          return `📻 playback moved to ${a.device_id}`

        // ── queue ───────────────────────────────────────────────────────────
        case 'queue.add':
          if (!a.uri) return 'need uri'
          await api('me/player/queue', { method: 'POST', query: { uri: toUri(a.uri), ...(a.device_id ? { device_id: a.device_id } : {}) } })
          return `➕ queued ${toUri(a.uri)}`
        case 'queue.list': {
          const q: any = await api('me/player/queue')
          return [
            q?.currently_playing ? `now: ${formatTrack(q.currently_playing)}` : 'now: nothing',
            'next:', lines((q?.queue || []).slice(0, limit), (t, i) => formatTrack(t, i), '  (empty)'),
          ].join('\n')
        }

        // ── search ──────────────────────────────────────────────────────────
        case 'search': {
          if (!a.query) return 'need query'
          const type = a.search_type || 'track'
          const r: any = await api('search', { query: { q: a.query, type, limit } })
          const key = `${type}s`
          const items = r?.[key]?.items || []
          const fmt = type === 'artist' ? formatArtist : type === 'album' ? formatAlbum
            : type === 'playlist' ? (p: any, i: number) => `${i}. ${p?.name} — ${p?.owner?.display_name || '?'} (${p?.tracks?.total ?? '?'} tracks)  ${p?.uri}`
            : formatTrack
          return `${type} results for "${a.query}":\n${lines(items, fmt as any, '  (nothing found)')}`
        }

        // ── devices ─────────────────────────────────────────────────────────
        case 'devices': {
          const d: any = await api('me/player/devices')
          return lines(d?.devices || [],
            (x, i) => `${i}. ${x.is_active ? '● ' : '○ '}${x.name} [${x.type}]${x.volume_percent != null ? ` vol ${x.volume_percent}%` : ''}  id: ${x.id}`,
            'no devices — open Spotify on a phone/speaker/desktop first')
        }

        // ── playlists ───────────────────────────────────────────────────────
        case 'playlists': {
          const r: any = await api('me/playlists', { query: { limit } })
          // /me/playlists returns the count under `items.total`; a single
          // playlist fetch calls the same thing `tracks.total`. Accept both.
          return lines(r?.items || [], (p, i) =>
            `${i}. ${p.name} (${p.tracks?.total ?? p.items?.total ?? '?'} tracks)${p.public ? '' : ' · private'}  ${p.uri}`)
        }
        case 'playlist.tracks': {
          if (!a.playlist_id) return 'need playlist_id'
          const r: any = await api(`playlists/${toId(a.playlist_id)}/tracks`, { query: { limit } })
          return lines(r?.items || [], (it, i) => formatTrack(it.track, i))
        }
        case 'playlist.create': {
          if (!a.name) return 'need name'
          const me: any = await api('me')
          const p: any = await api(`users/${encodeURIComponent(me.id)}/playlists`, {
            method: 'POST',
            body: { name: a.name, description: a.description || '', public: a.public ?? false },
          })
          return `✓ created playlist "${p.name}" — ${p.uri}`
        }
        case 'playlist.add': {
          if (!a.playlist_id || !a.uris) return 'need playlist_id + uris'
          const uris = uriList(a.uris)
          await api(`playlists/${toId(a.playlist_id)}/tracks`, { method: 'POST', body: { uris } })
          return `✓ added ${uris.length} track(s)`
        }
        case 'playlist.remove': {
          if (!a.playlist_id || !a.uris) return 'need playlist_id + uris'
          const uris = uriList(a.uris)
          await api(`playlists/${toId(a.playlist_id)}/tracks`, { method: 'DELETE', body: { tracks: uris.map((uri) => ({ uri })) } })
          return `✓ removed ${uris.length} track(s)`
        }

        // ── library ─────────────────────────────────────────────────────────
        case 'liked': {
          const r: any = await api('me/tracks', { query: { limit } })
          return lines(r?.items || [], (it, i) => formatTrack(it.track, i))
        }
        case 'like': {
          if (!a.uris) return 'need uris'
          const ids = uriList(a.uris).map(toId)
          await api('me/tracks', { method: 'PUT', query: { ids: ids.join(',') } })
          return `♥ saved ${ids.length} track(s)`
        }
        case 'unlike': {
          if (!a.uris) return 'need uris'
          const ids = uriList(a.uris).map(toId)
          await api('me/tracks', { method: 'DELETE', query: { ids: ids.join(',') } })
          return `✓ removed ${ids.length} track(s) from your library`
        }

        // ── discovery ───────────────────────────────────────────────────────
        case 'recent': {
          const r: any = await api('me/player/recently-played', { query: { limit } })
          return lines(r?.items || [], (it, i) => `${formatTrack(it.track, i)}${it.played_at ? `  @ ${it.played_at.slice(0, 16).replace('T', ' ')}` : ''}`)
        }
        case 'top_tracks': {
          const r: any = await api('me/top/tracks', { query: { limit, time_range: a.time_range || 'medium_term' } })
          return lines(r?.items || [], (t, i) => formatTrack(t, i))
        }
        case 'top_artists': {
          const r: any = await api('me/top/artists', { query: { limit, time_range: a.time_range || 'medium_term' } })
          return lines(r?.items || [], (x, i) => formatArtist(x, i))
        }
        case 'recommendations': {
          const query: Record<string, any> = { limit }
          if (a.seed_tracks) query.seed_tracks = uriList(a.seed_tracks).map(toId).join(',')
          if (a.seed_artists) query.seed_artists = uriList(a.seed_artists, 'artist').map(toId).join(',')
          if (a.seed_genres) query.seed_genres = a.seed_genres
          if (!query.seed_tracks && !query.seed_artists && !query.seed_genres) {
            return 'need at least one of seed_tracks, seed_artists, seed_genres'
          }
          const r: any = await api('recommendations', { query })
          return lines(r?.tracks || [], (t, i) => formatTrack(t, i))
        }
        case 'genres': {
          const r: any = await api('recommendations/available-genre-seeds')
          return (r?.genres || []).join(', ') || 'none'
        }

        // ── browse ──────────────────────────────────────────────────────────
        case 'artist': {
          if (!a.artist_id) return 'need artist_id'
          const id = toId(a.artist_id)
          // top-tracks may be restricted for this app — a 403 there shouldn't
          // cost the caller the artist info and albums that DO come back.
          const [info, top, albums] = await Promise.all([
            api(`artists/${id}`),
            api(`artists/${id}/top-tracks`, { query: { market: 'from_token' } }).catch((e) => ({ unavailable: String(e.message) })),
            api(`artists/${id}/albums`, { query: { limit: 10, include_groups: 'album,single' } }),
          ]) as any[]
          return [
            formatArtist(info),
            '\ntop tracks:', top?.unavailable ? `  (unavailable — ${top.unavailable})` : lines((top?.tracks || []).slice(0, 10), (t, i) => formatTrack(t, i)),
            '\nalbums:', lines(albums?.items || [], (x, i) => formatAlbum(x, i)),
          ].join('\n')
        }
        case 'album': {
          if (!a.album_id) return 'need album_id'
          const info: any = await api(`albums/${toId(a.album_id)}`)
          return [formatAlbum(info), '\ntracks:', lines(info?.tracks?.items || [], (t, i) => formatTrack(t, i))].join('\n')
        }

        // ── user ────────────────────────────────────────────────────────────
        case 'profile': {
          const me: any = await api('me')
          return [
            `${me.display_name || me.id} (${me.id})`,
            me.email ? `email: ${me.email}` : null,
            `plan: ${me.product}${me.country ? ` · ${me.country}` : ''}`,
            me.followers?.total != null ? `followers: ${me.followers.total}` : null,
            me.uri,
          ].filter(Boolean).join('\n')
        }
        case 'following': {
          const r: any = await api('me/following', { query: { type: 'artist', limit } })
          return lines(r?.artists?.items || [], (x, i) => formatArtist(x, i))
        }
        case 'follow': {
          if (!a.artist_id) return 'need artist_id'
          const ids = uriList(a.artist_id, 'artist').map(toId)
          await api('me/following', { method: 'PUT', query: { type: 'artist', ids: ids.join(',') } })
          return `✓ following ${ids.length} artist(s)`
        }
        case 'unfollow': {
          if (!a.artist_id) return 'need artist_id'
          const ids = uriList(a.artist_id, 'artist').map(toId)
          await api('me/following', { method: 'DELETE', query: { type: 'artist', ids: ids.join(',') } })
          return `✓ unfollowed ${ids.length} artist(s)`
        }

        default:
          return `unknown action: ${a.action}`
      } } catch (e: any) {
        return `error: ${String(e?.stderr || e?.message || e).slice(0, 500)}`
      }
    },
  })
}
