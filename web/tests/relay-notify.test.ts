// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Relay-notify fan-out (push → native devices): the envelope the worker drops
 * on the device relay must stay parseable by FleetManager.handleEnvelope
 * (type:'notify') and clamped identically to the web-push message, and the
 * targets query must keep its presence + revocation guards — a regression in
 * either silently kills native notifications or spams offline devices.
 *
 * Skips when the worker submodule is absent (CI has no .gitmodules).
 */
warnIfWorkerAbsent('relay-notify')

let buildNotifyEnvelope: (p: { title?: string; body?: string; url?: string; tag?: string }) => string
let NOTIFY_TARGETS_SQL: string
let NOTIFY_PRESENCE_S: number

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('push.ts') /* @vite-ignore */)
  buildNotifyEnvelope = mod.buildNotifyEnvelope
  NOTIFY_TARGETS_SQL = mod.NOTIFY_TARGETS_SQL
  NOTIFY_PRESENCE_S = mod.NOTIFY_PRESENCE_S
})

describe.skipIf(!present)('relay-notify envelope', () => {
  it('carries type:notify plus the full push payload', () => {
    const env = JSON.parse(buildNotifyEnvelope({
      title: '💬 Ada (@ada)', body: 'hey', url: '/tiny?dm=ada', tag: 'dm-u123',
    }))
    expect(env).toEqual({
      type: 'notify', title: '💬 Ada (@ada)', body: 'hey', url: '/tiny?dm=ada', tag: 'dm-u123',
    })
  })

  it('defaults match the web-push message (title/tag/url fallbacks)', () => {
    const env = JSON.parse(buildNotifyEnvelope({}))
    expect(env.title).toBe('tiny')
    expect(env.body).toBe('')
    expect(env.tag).toBe('tiny-notification')
    expect(env.url).toBe('/')
  })

  it('clamps title to 100 and body to 400 (web-push parity), stays ≤8KB', () => {
    const env = JSON.parse(buildNotifyEnvelope({ title: 'T'.repeat(500), body: 'B'.repeat(5000) }))
    expect(env.title).toHaveLength(100)
    expect(env.body).toHaveLength(400)
    // sanitizeRelayPayload rejects >8KB — the clamped envelope must never hit that
    expect(buildNotifyEnvelope({ title: 'T'.repeat(500), body: 'B'.repeat(5000) }).length).toBeLessThan(8192)
  })

  it('targets query keeps the revocation + presence guards', () => {
    expect(NOTIFY_TARGETS_SQL).toContain('revoked = 0')
    expect(NOTIFY_TARGETS_SQL).toContain('last_seen >= ?2')
    expect(NOTIFY_TARGETS_SQL).toContain('user_id = ?1')
    // Presence window must cover at least two 30s heartbeats, and stay well
    // under the 1h relay sweep so envelopes can't outlive their usefulness.
    expect(NOTIFY_PRESENCE_S).toBeGreaterThanOrEqual(60)
    expect(NOTIFY_PRESENCE_S).toBeLessThan(3600)
  })
})

/**
 * ── Consumer parity: iOS must handle what the worker mirrors ────────────────
 *
 * The envelope above is only half the rail. The producer side was always fine;
 * the defect was on the CONSUMER side, and only one client had it: iOS's relay
 * poll `continue`d on anything that wasn't `type == "invoke"`, so every notify
 * envelope was read and thrown away. That is not a deferral — the poll CLAIMS
 * what it returns (relay.ts RELAY_MARK_SQL: compare-and-swap on delivered = 0),
 * so the envelope is destroyed. A job finishing while the app sat idle produced
 * nothing at all on iPhone, while Android bannered it (RelayNotifier).
 *
 * This suite is the only place that can read BOTH clients, so it is where the
 * two routing tables are held to the worker's single tag contract. The native
 * suites (TinyTests RelayNotifyTests / RelayNotifierTest) prove the behaviour;
 * these assertions prove the two behaviours are the SAME one.
 */
// `ios/` and `android/` resolve through the web/ios and web/android symlinks.
const repoFile = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Swift/Kotlin comments explain what NOT to do — a docstring warning against
 *  `continue`-ing past a notify contains the very string being searched for, so
 *  every structural assertion below runs on code with comments removed. */
const stripComments = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')

describe('relay-notify consumers (iOS ↔ Android parity)', () => {
  const swift = stripComments(repoFile('ios/Tiny/Sources/Session.swift'))
  const kotlin = stripComments(repoFile('android/app/src/main/java/technology/tiny/app/fleet/RelayNotifier.kt'))
  const fleet = stripComments(repoFile('android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt'))

  it('iOS relay loop routes notify BEFORE the invoke guard', () => {
    // Order is the whole bug: the invoke guard is a `continue`, so anything
    // reaching it that isn't an invoke is gone. Handling notify after it is
    // dead code.
    const loop = swift.slice(swift.indexOf('relayTask = Task {'))
    expect(loop).not.toBe('')
    const notifyAt = loop.indexOf('== "notify"')
    const invokeAt = loop.indexOf('== "invoke"')
    expect(notifyAt).toBeGreaterThan(-1)
    expect(invokeAt).toBeGreaterThan(-1)
    expect(notifyAt).toBeLessThan(invokeAt)
    // …and the branch must actually consume the envelope (call + continue)
    // rather than fall through into the invoke guard.
    const branch = loop.slice(notifyAt, invokeAt)
    expect(branch).toContain('handleNotifyEnvelope')
    expect(branch).toContain('continue')
  })

  it('both clients read the same four payload fields off the envelope', () => {
    // buildNotifyEnvelope emits exactly {type,title,body,tag,url}; a consumer
    // reading a field the producer never sets is a silent nothing.
    for (const f of ['tag', 'url', 'title', 'body']) {
      expect(swift).toContain(`payload["${f}"]`)
      expect(kotlin).toContain(`optString("${f}")`)
    }
    expect(fleet).toContain('"notify"')
    expect(fleet).toContain('RelayNotifier.handle')
  })

  it('DM tags poke the unread poll on both clients — never a second banner', () => {
    // refreshUnread()/syncUnread() is the single DM banner path (unread GROWTH,
    // per-login, inline reply). Bannering the payload here as well double-posts
    // every DM, which is why both clients route DMs away from their banner.
    expect(kotlin).toContain('tag.startsWith("dm-") || url.contains("?dm=") -> Route.DmPoke')
    expect(swift).toContain('if tag.hasPrefix("dm-") || url.contains("?dm=") { return .dmPoke }')
    const handler = swift.slice(swift.indexOf('func handleNotifyEnvelope'))
    const dmCase = handler.slice(handler.indexOf('case .dmPoke'), handler.indexOf('case .banner'))
    expect(dmCase).toContain('onDmPoke')
    expect(dmCase).not.toContain('Notify.post')
    // And the live call site wires that closure to the real unread refresh.
    expect(swift).toContain('handleNotifyEnvelope(payload) { await self.refreshUnread() }')
  })

  it('an unknown tag still reaches the user on both clients (visible default)', () => {
    // Defaulting to silent is exactly how the iOS hole existed: a future push
    // kind nobody taught the client about must show up, not vanish.
    expect(kotlin).toContain('else -> Route.Banner(CHANNEL_ACTIVITY')
    const classify = swift.slice(swift.indexOf('func classifyNotify'))
    const end = classify.indexOf('\n    }')
    expect(classify.slice(0, end)).toMatch(/return \.banner\s*$/m)
  })

  it('iOS clamps title/body to the worker’s own limits', () => {
    // Same numbers as buildNotifyEnvelope (asserted above), applied again
    // because this is untrusted-shaped JSON off the wire.
    const handler = swift.slice(swift.indexOf('func handleNotifyEnvelope'))
    expect(handler).toContain('title.prefix(100)')
    expect(handler).toContain('body.prefix(400)')
    // A body-only push must still render — an empty title falls back.
    expect(handler).toContain('title.isEmpty ? "tiny"')
  })
})
