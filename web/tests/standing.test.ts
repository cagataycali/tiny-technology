// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  standingFor, normalizeStanding, allowancePhrase, standingDetail, standingNextStep,
} from '../lib/standing'
import { reputationAllowance, REQUESTS_PER_POINT, MAX_REPUTATION_BONUS } from '../lib/rate-limit-curve'

/**
 * 🏅 STANDING BEFORE THE WALL (the standing ask, third pass).
 *
 * c8 built the curve, c31 made the base configurable, c37 made the 429 say what
 * standing is worth. Every one of those speaks at the moment of refusal. Before
 * that, the platform quoted an allowance in exactly one place — ModelSettings'
 * "free but limited to 50 requests a day" — via `freeTierRequestsPhrase()`,
 * which resolves the DEPLOYMENT's base and knows nothing about the caller. So a
 * builder with 40 points, whose enforced window was 250, was told 50: a correct
 * number under a label naming something else (the c30 explorer bug), on the one
 * screen whose whole job is explaining the free tier.
 *
 * The invariant that makes this safe to display at all is the first test below:
 * the number shown before the wall is computed by the SAME function the limiter
 * builds its window with. A second copy of `base + score × 5` in a component
 * would be right today and wrong the first time the curve moves.
 */

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/**
 * Source WITHOUT comments — three cycles running (c37, c38, c39) a "this file
 * must not contain X" assertion has been tripped by the doc comment explaining
 * why the file doesn't contain X. A prose mention isn't code; strip prose.
 */
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('standingFor — the same arithmetic the limiter enforces', () => {
  it('NEVER disagrees with reputationAllowance, across the curve', () => {
    // The drift this module exists to prevent. If someone changes the curve,
    // this table follows automatically — a hardcoded expectation would not.
    for (const base of [1, 20, 50, 300, 5000]) {
      for (const score of [0, 1, 7, 10, 39, 40, 45, 200]) {
        expect(standingFor(base, score, true).allowance).toBe(reputationAllowance(base, score))
      }
    }
  })

  it('an anonymous caller gets the base and no bonus — the window is SHARED', () => {
    // Signed out the window is IP-keyed at the base allowance, so there is no
    // personal number to report (lib/rate-limit: `identified` gates all of it).
    const s = standingFor(50, 40, false)
    expect(s.allowance).toBe(50)
    expect(s.bonus).toBe(0)
    expect(s.score).toBe(0)
    expect(s.identified).toBe(false)
  })

  it('reports the bonus and the cap flag', () => {
    const mid = standingFor(50, 10, true)
    expect(mid.bonus).toBe(10 * REQUESTS_PER_POINT)
    expect(mid.atCap).toBe(false)
    const capped = standingFor(50, 9_999, true)
    expect(capped.bonus).toBe(MAX_REPUTATION_BONUS)
    expect(capped.atCap).toBe(true)
    // Exactly at the cap counts as capped — the boundary the copy branches on.
    expect(standingFor(50, MAX_REPUTATION_BONUS / REQUESTS_PER_POINT, true).atCap).toBe(true)
  })

  it('follows the deployment base, not a hardcoded 50', () => {
    expect(standingFor(500, 10, true).allowance).toBe(500 + 10 * REQUESTS_PER_POINT)
  })

  it('carries the CURVE on the wire, for the clients that cannot import it', () => {
    // c39: iOS/Android can't call reputationAllowance, and a hardcoded 5/200 in
    // Swift or Kotlin is a fork of the limiter that lies from an installed build
    // the moment the curve moves. So the numbers travel with the standing —
    // exactly what the faucet already does (micro_per_point / max_micro).
    const s = standingFor(50, 10, true)
    expect(s.perPoint).toBe(REQUESTS_PER_POINT)
    expect(s.maxBonus).toBe(MAX_REPUTATION_BONUS)
    // Present even when there's nothing earned yet — that's the case where the
    // client needs them most (it's the "here's what a point buys" invitation).
    expect(standingFor(50, 0, true).perPoint).toBe(REQUESTS_PER_POINT)
    expect(standingFor(50, 0, false).maxBonus).toBe(MAX_REPUTATION_BONUS)
  })

  it('junk in never yields NaN out', () => {
    for (const junk of [NaN, Infinity, undefined, null, 'lots', -5] as any[]) {
      const s = standingFor(junk, junk, true)
      expect(Number.isFinite(s.allowance)).toBe(true)
      expect(s.allowance).toBeGreaterThanOrEqual(1)
      expect(s.bonus).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('normalizeStanding — an older server must degrade, not render NaN', () => {
  it('missing / junk payload → null, so the caller falls back to the base phrase', () => {
    for (const junk of [undefined, null, 'nope', 42, {}, { base: 0 }, { base: 'lots' }] as any[]) {
      expect(normalizeStanding(junk)).toBeNull()
    }
  })

  it('recomputes from base+score rather than trusting the wire', () => {
    // A stale or hand-edited `allowance` must not be able to make the pre-wall
    // number disagree with the enforced one.
    const s = normalizeStanding({ base: 50, score: 10, allowance: 99999, identified: true })
    expect(s!.allowance).toBe(50 + 10 * REQUESTS_PER_POINT)
  })

  it('honours identified:false but defaults missing identified to true', () => {
    // /api/me only answers for a session, so the absent-field case is a signed-in
    // caller on an older payload — not an anonymous one.
    expect(normalizeStanding({ base: 50, score: 10 })!.identified).toBe(true)
    expect(normalizeStanding({ base: 50, score: 10, identified: false })!.allowance).toBe(50)
  })
})

describe('the copy — true at every point on the curve', () => {
  it('quotes the caller’s own allowance, pluralized', () => {
    expect(allowancePhrase(standingFor(50, 10, true))).toBe('100 requests a day')
    expect(allowancePhrase(standingFor(1, 0, true))).toBe('1 request a day')
  })

  it('no standing yet → no breakdown, just the invitation', () => {
    // "50 = 50 free plus 0 earned from 0 points" is noise; the honest message is
    // what earning would get them.
    const s = standingFor(50, 0, true)
    expect(standingDetail(s)).toBe('')
    expect(standingNextStep(s)).toMatch(/adds 5 more a day/)
    expect(standingNextStep(s)).toMatch(/followed/)
  })

  it('mid-curve → the split, so the earned part is visible', () => {
    const d = standingDetail(standingFor(50, 10, true))
    expect(d).toContain('50 free')
    expect(d).toContain(`${10 * REQUESTS_PER_POINT} earned`)
    expect(d).toContain('10 points of reputation')
  })

  it('AT THE CAP the next-step line is EMPTY — never dangle a spent lever', () => {
    // Same rule the 429 follows (lib/limit-message.ts): "each point adds 5 more"
    // is false here, and it's something a user could act on for weeks.
    const s = standingFor(50, 500, true)
    expect(standingNextStep(s)).toBe('')
    expect(standingDetail(s)).toContain(`the full ${MAX_REPUTATION_BONUS}`)
  })

  it('the remaining-to-earn figure shrinks as it is earned, and never goes negative', () => {
    const mid = standingNextStep(standingFor(50, 10, true))
    expect(mid).toContain(`${MAX_REPUTATION_BONUS - 10 * REQUESTS_PER_POINT} still to earn`)
    for (const score of [0, 1, 10, 39, 40, 41, 500]) {
      const s = standingFor(50, score, true)
      const line = standingNextStep(s)
      expect(line).not.toMatch(/-\d/)
      if (s.atCap) expect(line).toBe('')
    }
  })

  it('says nothing to an anonymous caller — it has no standing to report', () => {
    const s = standingFor(50, 0, false)
    expect(standingDetail(s)).toBe('')
    expect(standingNextStep(s)).toBe('')
  })

  it('count grammar holds at 1 everywhere', () => {
    const one = standingFor(50, 1, true)
    expect(standingDetail(one)).toContain('1 point of reputation')
    expect(standingDetail(one)).not.toContain('1 points')
  })

  it('no branch ever prints NaN / undefined', () => {
    for (const score of [0, 1, 10, 40, 999, NaN as any]) {
      for (const identified of [true, false]) {
        const s = standingFor(50, score, identified)
        for (const line of [allowancePhrase(s), standingDetail(s), standingNextStep(s)]) {
          expect(line).not.toMatch(/NaN|undefined|null|Infinity/)
        }
      }
    }
  })
})

describe('the wiring — where the number has to come from', () => {
  it('/api/me reports standing, computed from the deployment base + the worker score', () => {
    const me = src('app/api/me/route.ts')
    expect(me).toMatch(/standing: standingFor\(freeTierRequestsPerDay\(\), score, true\)/)
    // Parallel, not sequential: this probe gates several mount-time fetches, so
    // a 2s-worst-case worker read must not be added to their critical path.
    expect(me).toMatch(/Promise\.all\(\[/)
  })

  it('reputationFor lives KV-free, so an edge route can read standing', () => {
    // lib/rate-limit imports @vercel/kv at module load; /api/me only wants a
    // number. Same split as lib/rate-limit-curve at c37.
    const imports = /^\s*import .*(@vercel\/kv|@upstash)/m
    expect(src('lib/reputation.ts')).not.toMatch(imports)
    expect(src('lib/standing.ts')).not.toMatch(imports)
    // …and re-exported, so every existing `from './rate-limit'` still resolves.
    expect(src('lib/rate-limit.ts')).toMatch(/export \{ reputationFor \}/)
  })

  it('ModelSettings prefers the caller’s allowance and falls back to the base phrase', () => {
    const ms = src('components/chat/ModelSettings.tsx')
    expect(ms).toMatch(/standing \? allowancePhrase\(standing\) : freeTierRequestsPhrase\(\)/)
    // Rides the SHARED probe (one /api/me per page — lib/chat/whoami), not a
    // second request: c12 counted seven wasted authenticated fetches per anon view.
    // Since v6 E4 that read goes through useAuthValue, which reads the same
    // cache AND re-reads on `tiny:auth` — the panel used to keep quoting the
    // anonymous number after a sign-in with Settings open.
    expect(ms).toMatch(/useAuthValue/)
    expect(ms).not.toMatch(/fetch\(["'`]\/api\/me/)
    expect(ms).toContain('normalizeStanding')
  })

  it('iOS reads the wire keys /api/me actually sends, and invents no curve', () => {
    // c39. The Swift port is unreachable from vitest, so what's checkable here is
    // the CONTRACT between the two files — the half that breaks silently. A
    // renamed key doesn't crash iOS, it just makes the footer quote nothing.
    const swift = src('ios/Tiny/Sources/Standing.swift')
    for (const key of ['base', 'allowance', 'score', 'perPoint', 'maxBonus', 'identified']) {
      expect(swift).toContain(`"${key}"`)
      // …and every key it reads is one standingFor really writes.
      expect(Object.keys(standingFor(50, 10, true))).toContain(key)
    }
    // The load-bearing rule: no literal curve in Swift CODE. iOS can't be pinned
    // against `reputationAllowance` the way lib/standing.ts is, so its only
    // defence is to compute nothing. (Comments may name the numbers while
    // explaining this — hence `code()`.)
    expect(code('ios/Tiny/Sources/Standing.swift')).not.toMatch(
      new RegExp(`(perPoint|maxBonus|PerPoint|MaxBonus)\\s*[:=]\\s*(${REQUESTS_PER_POINT}|${MAX_REPUTATION_BONUS})\\b`))
    // A curve-less payload must go quiet rather than guess.
    expect(swift).toMatch(/perPoint > 0, maxBonus > 0 else \{ return "" \}/)
  })

  it('Android reads the same wire keys, and invents no curve either', () => {
    // c40, the last of the three clients. Same unreachable-from-vitest problem as
    // Swift, same checkable half: the CONTRACT. Plus one Kotlin-only hazard —
    // org.json's optBoolean returns the DEFAULT for an integer 0/1 flag, so
    // `identified` must go through truthyFlag or a signed-out payload could read
    // as identified (JsonFlags documents the trap).
    const kt = src('android/app/src/main/java/technology/tiny/app/net/Standing.kt')
    for (const key of ['base', 'allowance', 'score', 'perPoint', 'maxBonus', 'identified']) {
      expect(kt).toContain(`"${key}"`)
      expect(Object.keys(standingFor(50, 10, true))).toContain(key)
    }
    expect(kt).toMatch(/truthyFlag\("identified", true\)/)
    // No literal curve in Kotlin CODE (comments may name it while explaining why).
    expect(code('android/app/src/main/java/technology/tiny/app/net/Standing.kt')).not.toMatch(
      new RegExp(`(perPoint|maxBonus|PerPoint|MaxBonus)\\s*[:=]\\s*(${REQUESTS_PER_POINT}|${MAX_REPUTATION_BONUS})\\b`))
    // A curve-less payload must go quiet rather than guess.
    expect(kt).toMatch(/atCap \|\| perPoint <= 0 \|\| maxBonus <= 0\) return ""/)
    // …and the panel must actually render it, on the free branch only (a BYOK
    // user isn't rate-limited, so quoting an allowance there would be a lie).
    const panels = src('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
    expect(panels).toMatch(/Standing\.freeTierFooter\(standing\)/)
    expect(panels).toMatch(/Standing\.parse\(me\?\.optJSONObject\("standing"\)\)/)
  })

  it('the display module holds no second copy of the curve', () => {
    // The whole point: one arithmetic. A literal 5 or 200 in here would be a
    // fork of the limiter that agrees with it only until the curve moves.
    const st = src('lib/standing.ts')
    expect(st).toContain("from './rate-limit-curve'")
    expect(st).not.toMatch(/=\s*(base|b)\s*\+\s*.*\*\s*\d/)
  })
})
