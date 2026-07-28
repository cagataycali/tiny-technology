/**
 * TickerCache — ambient data store for the menu-bar rotating ticker.
 *
 * NEVER makes live API calls. Only passively collects data that other parts of
 * the system already produce (Spotify now_playing, wallet balance, event counts)
 * and assembles it into TrayTickerCards on demand.
 *
 * The daemon calls `buildCards()` once per tray `status` poll (every 5s).
 * All data sources are optional: a card is omitted if its backing data is stale
 * or absent, so the ticker degrades gracefully on a machine with no integrations.
 *
 * Staleness rules (all configurable):
 *   nowPlaying  → 30s  (track changes fast)
 *   wallet      → 5min (balance changes on purchases)
 *   events      → 60s  (unread count — rough)
 *   peers       → live (comes from the mesh node directly)
 */

import type { TrayTickerCard, TrayMood, TrayEventCard } from '../tray.js'

export interface NowPlayingData {
  title: string
  artist: string
  isPlaying: boolean
}

export interface WalletData {
  balance: number   // USDC
  currency: string  // 'USDC'
}

export interface EventData {
  unreadCount: number
  lastSummary?: string
  /** Recent event summaries, newest first — shown in the menu's Activity section. */
  items?: TrayEventCard[]
}

const STALE_NOW_PLAYING_MS  = 30_000
const STALE_WALLET_MS       = 5 * 60_000
const STALE_EVENTS_MS       = 60_000

interface CachedValue<T> {
  value: T
  at: number  // Date.now()
}

function fresh<T>(c: CachedValue<T> | null, ttlMs: number): T | null {
  if (!c) return null
  return (Date.now() - c.at) < ttlMs ? c.value : null
}

export class TickerCache {
  private _nowPlaying: CachedValue<NowPlayingData | null> | null = null
  private _wallet: CachedValue<WalletData> | null = null
  private _events: CachedValue<EventData> | null = null
  /** Urgent alert strings — shown with ◉, stop rotation, persist until cleared */
  private _urgentAlerts: string[] = []

  // ── setters (called by whoever just fetched fresh data) ──────────────────

  setNowPlaying(data: NowPlayingData | null): void {
    this._nowPlaying = { value: data, at: Date.now() }
  }

  setWallet(data: WalletData): void {
    this._wallet = { value: data, at: Date.now() }
  }

  setEvents(data: EventData): void {
    this._events = { value: data, at: Date.now() }
  }

  /** Push an urgent alert. Deduped by text. */
  pushAlert(text: string): void {
    if (!this._urgentAlerts.includes(text)) {
      this._urgentAlerts.push(text)
    }
  }

  /** Dismiss an urgent alert by text. */
  dismissAlert(text: string): void {
    this._urgentAlerts = this._urgentAlerts.filter(a => a !== text)
  }

  clearAlerts(): void {
    this._urgentAlerts = []
  }

  // ── card assembly ─────────────────────────────────────────────────────────

  /**
   * Build the current set of TrayTickerCards for the status payload.
   * Called on every tray poll — must be synchronous and O(1).
   * `peers` is passed in live from the mesh node.
   */
  buildCards(peers?: number): TrayTickerCard[] {
    const cards: TrayTickerCard[] = []

    // Urgent alerts first — they stop rotation on the helper side
    for (const alert of this._urgentAlerts) {
      cards.push({ text: alert, icon: '⚠️', priority: 'urgent', ttl: 0 })
    }

    // Now playing
    const np = fresh(this._nowPlaying, STALE_NOW_PLAYING_MS)
    if (np) {
      if (np.isPlaying) {
        const track = truncate(`${np.title} · ${np.artist}`, 28)
        cards.push({ text: track, icon: '♫', priority: 'normal', ttl: 8 })
      }
      // If not playing, omit — silence is not worth a card
    }

    // Wallet balance
    const wallet = fresh(this._wallet, STALE_WALLET_MS)
    if (wallet) {
      cards.push({
        text: `$${wallet.balance.toFixed(3)} ${wallet.currency}`,
        icon: '💰',
        priority: 'normal',
        ttl: 5,
      })
    }

    // Unread events
    const events = fresh(this._events, STALE_EVENTS_MS)
    if (events && events.unreadCount > 0) {
      const label = events.unreadCount === 1 ? '1 event' : `${events.unreadCount} events`
      cards.push({ text: label, icon: '📬', priority: 'normal', ttl: 5 })
    }

    // Peer fleet
    if (typeof peers === 'number' && peers > 0) {
      cards.push({
        text: `${peers} peer${peers === 1 ? '' : 's'} online`,
        icon: '🕸',
        priority: 'normal',
        ttl: 5,
      })
    }

    return cards
  }

  /**
   * Compute the current mood from cached state + live task counts.
   * The mood drives the glyph + tint in the menu-bar helper.
   */
  computeMood(runningTasks: number, failedTools: number): TrayMood {
    if (this._urgentAlerts.length > 0) return 'urgent'
    if (runningTasks > 0) return 'working'
    if (failedTools > 0) return 'attention'
    // Unread events → attention if meaningful
    const events = fresh(this._events, STALE_EVENTS_MS)
    if (events && events.unreadCount >= 3) return 'attention'
    return 'idle'
  }

  /** Recent events for the menu's Activity section (fresh within the events TTL). */
  getRecentEvents(): TrayEventCard[] {
    const events = fresh(this._events, STALE_EVENTS_MS)
    return events?.items?.slice(0, 5) || []
  }

  // ── snapshot for nowPlaying field in TrayStatus ──────────────────────────

  getNowPlaying(): { title: string; artist: string } | null {
    const np = fresh(this._nowPlaying, STALE_NOW_PLAYING_MS)
    if (!np || !np.isPlaying) return null
    return { title: np.title, artist: np.artist }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/** Singleton — one cache per daemon process. */
export const tickerCache = new TickerCache()
