// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🎥 A glasses recording does not outlive the account that started it.
 *
 * The recorder is a process-lifetime singleton on both phones, and it holds two
 * things that belong to ONE user:
 *
 *   1. `pending` — a clip the ~28s auto-stop finished, parked for the agent's
 *      next meta_record_video call. That is hosted video of the previous user's
 *      surroundings at a /media/ URL that needs no auth to render
 *      (worker/src/index.ts). Whoever signs in next collects it
 *      with one call and the agent narrates it as THEIRS. c39's TTL bounds that
 *      window to 180s; a bound is not ownership.
 *   2. A recording still ROLLING. Worse: the glasses keep streaming past
 *      sign-out, and the upload reads the token at CALL time — iOS
 *      `Api.post(token:)` is handed `session.token`, Android `authed()` calls
 *      `tokenProvider()` — so the clip lands in whatever account arrives next.
 *
 * Neither phone's sign-out touched the recorder. Pinned at every identity
 * boundary, because they are separate code paths that no single test covers:
 * iOS `logout()` and its `loadMe()` switch-scrub (a revoked token puts a
 * signed-out paywall card in the chat whose Sign in calls `login()` IN PLACE,
 * never logout), Android's sign-out button and its `exchangeCode` switch-scrub.
 *
 * And the drop must SURVIVE the auto-stop it races. The parking assignment sits
 * after an `await`/suspend on the upload, so a sign-out landing mid-upload can
 * clear `pending` and have the finishing task put the clip straight back — the
 * leak restored with the fix still visible in the diff.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const iosRec = read('ios/Tiny/Sources/WearablesRecorder.swift')
const iosSession = read('ios/Tiny/Sources/Session.swift')
const androidRec = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')
const androidPanels = read('android/app/src/main/java/technology/tiny/app/ui/Panels.kt')
const androidMain = read('android/app/src/main/java/technology/tiny/app/MainActivity.kt')

/** Slice a named region and PROVE both anchors were found (see c34 M1/c36 N10). */
const region = (src: string, from: string, to: string, label: string) => {
  const at = src.indexOf(from)
  expect(at, `${label}: could not find "${from}"`).toBeGreaterThan(-1)
  const end = src.indexOf(to, at + from.length)
  expect(end, `${label}: could not find the end anchor "${to}"`).toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('the recorder can be told the session is over', () => {
  it('iOS endSession drops the parked clip AND stops a rolling recording', () => {
    const body = region(iosRec, 'func endSession() {', '\n    }', 'iOS endSession')
    // Both halves, not one: dropping `pending` alone leaves the glasses
    // streaming for the next account; teardown() alone leaves the clip.
    expect(body, 'endSession no longer drops the parked clip').toMatch(/pending = nil/)
    expect(body, 'endSession no longer stops a rolling recording').toMatch(/teardown\(\)/)
  })

  it('Android endSession does the same, under the mutex every other path takes', () => {
    const body = region(androidRec, 'suspend fun endSession()', '\n    suspend fun runTool', 'Android endSession')
    expect(body, 'Android endSession no longer drops the parked clip').toMatch(/pending = null/)
    expect(body, 'Android endSession no longer stops a rolling recording')
      .toMatch(/active\?\.teardown\(\)/)
    expect(body, 'Android endSession no longer clears the active handle').toMatch(/active = null/)
    // ⚠️ The mutex is the whole reason this is a `suspend fun`: `pending` and
    // `active` are guarded on every other path, and the auto-stop coroutine
    // parks its clip inside `mutex.withLock`. Unguarded, losing that race
    // re-parks a clip we just dropped and nothing in the diff shows it.
    expect(body, 'Android endSession mutates guarded state without the mutex')
      .toMatch(/mutex\.withLock/)
  })
})

describe('every identity boundary calls it', () => {
  it('iOS sign-out calls it, before the session-ended notification', () => {
    const logout = region(iosSession, 'func logout() {', '\n    private func webAuth', 'iOS logout')
    expect(logout, 'iOS sign-out no longer drops the glasses recording')
      .toMatch(/GlassesRecorder\.shared\.endSession\(\)/)
    // The MWDAT slice is absent on Catalyst, where this file's whole class is
    // compiled out — an unguarded call there is a build error, not a leak.
    expect(logout, 'the call is not guarded for the platforms without the MWDAT SDK')
      .toMatch(/#if canImport\(MWDATCore\) && canImport\(MWDATCamera\)/)
  })

  it('iOS also calls it on a switch that never goes through logout', () => {
    // A revoked/expired token leaves the chat's signed-out paywall card, whose
    // Sign in runs login() in place (Views.swift onSignIn). loadMe()'s
    // identity-change branch is the ONLY place that path notices a new user.
    const scrub = region(
      iosSession,
      'if let prev, !prev.isEmpty, prev != login {',
      'store.set(login, forKey: key)',
      'iOS identity-change scrub',
    )
    expect(scrub, 'the iOS switch path keeps the prior user\'s glasses clip')
      .toMatch(/GlassesRecorder\.shared\.endSession\(\)/)
    expect(scrub, 'the switch-path call is not SDK-guarded')
      .toMatch(/#if canImport\(MWDATCore\) && canImport\(MWDATCamera\)/)
  })

  it('Android sign-out calls it BEFORE the token is cleared', () => {
    const signOut = region(
      androidPanels,
      'technology.tiny.app.fleet.RelayService.stop(app)',
      '{ Text("sign out"',
      'Android sign-out',
    )
    expect(signOut, 'Android sign-out no longer drops the glasses recording')
      .toMatch(/GlassesRecorderBridge\.endSession\(\)/)
    // Ordering matters for the ROLLING half: after logout() the token provider
    // returns null and a mid-upload clip would fail unauthenticated rather than
    // be abandoned deliberately — and a re-login mid-teardown could still land
    // it. Drop first, then take the token away.
    const dropAt = signOut.indexOf('GlassesRecorderBridge.endSession()')
    const logoutAt = signOut.indexOf('app.auth.logout()')
    expect(dropAt, 'the drop is missing from the sign-out block').toBeGreaterThan(-1)
    expect(logoutAt, 'sign-out no longer calls logout()').toBeGreaterThan(-1)
    expect(dropAt, 'the recording is dropped AFTER the token is cleared').toBeLessThan(logoutAt)
  })

  it('Android calls it on an account switch too, which never calls logout', () => {
    const scrub = region(
      androidMain,
      'if (technology.tiny.app.widget.WidgetStore.recordLoginDetectSwitch(',
      'authError = null',
      'Android switch scrub',
    )
    expect(scrub, 'the Android switch path keeps the prior user\'s glasses clip')
      .toMatch(/GlassesRecorderBridge\.endSession\(\)/)
    // Sanity that we sliced the real scrub block and not some prefix of it.
    expect(scrub, 'did not slice the identity-scrub block').toMatch(/scrubIdentity\(\)/)
  })
})

describe('the drop survives the auto-stop it races', () => {
  it('iOS stamps the session it started in and re-checks it after the upload', () => {
    expect(iosRec, 'the iOS session epoch is gone — nothing marks a clip stale mid-upload')
      .toMatch(/private var epoch = 0/)
    const end = region(iosRec, 'func endSession() {', '\n    }', 'iOS endSession')
    expect(end, 'endSession no longer invalidates in-flight work').toMatch(/epoch \+= 1/)

    const auto = region(
      iosRec,
      'autoStopTask = Task',
      'return ["ok": true, "recording": true]',
      'iOS auto-stop',
    )
    // The captured value must be read BEFORE the sleep — capturing `self.epoch`
    // inside the task would read it after the sign-out and always match.
    const captureAt = iosRec.indexOf('let epoch = self.epoch')
    const taskAt = iosRec.indexOf('autoStopTask = Task')
    expect(captureAt, 'the auto-stop does not capture the epoch it started in').toBeGreaterThan(-1)
    expect(captureAt, 'the epoch is captured inside the task, after the sign-out could land')
      .toBeLessThan(taskAt)

    // ⚠️ The check has to be AFTER the await that produces the artefact: c39
    // made this task nil its own handle before stopping (self-cancellation broke
    // the upload), so from that point teardown() cannot reach it. The guard is
    // the only seam. (c41 changed the callee from stop() to finalizeClip() — the
    // await is still the seam, which is what this pins.)
    const stopAt = auto.indexOf('await self.finalizeClip()')
    const guardAt = auto.indexOf('guard self.epoch == epoch else { return }')
    const parkAt = auto.search(/self\.pending = \(\w+, Date\(\)\)/)
    expect(stopAt, 'the auto-stop no longer awaits the finalizer').toBeGreaterThan(-1)
    expect(guardAt, 'no epoch guard between the finalize and the park — a sign-out mid-finalize re-parks the clip')
      .toBeGreaterThan(stopAt)
    expect(parkAt, 'the clip is parked before the epoch is re-checked').toBeGreaterThan(guardAt)
  })

  it('Android is safe by its mutex — the park re-checks the handle endSession cleared', () => {
    const auto = region(androidRec, 'delay(MAX_SECONDS * 1000)', 'private fun encode(', 'Android auto-stop')
    // Android needs no epoch: the park happens INSIDE mutex.withLock and
    // re-reads `active`, which endSession() nulls under the same mutex. Losing
    // that identity check is exactly as bad as losing iOS's guard.
    expect(auto, 'the Android park is not under the mutex').toMatch(/mutex\.withLock/)
    expect(auto, 'the Android park no longer checks it is still the active recording')
      .toMatch(/if \(active === this@Recording\)/)
  })
})
