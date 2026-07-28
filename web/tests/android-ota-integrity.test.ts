/**
 * The published Android OTA manifest — `public/android/manifest.json` — against the APK it points
 * at, and against the two things that write it.
 *
 * ## Why this exists (c45)
 *
 * `Updater.install()` verifies the downloaded APK's sha256 against `manifest.sha256` **before**
 * handing it to the system installer, and `apkIntegrityOk` is correct and unit-tested
 * (`UpdaterTest.kt`), including this line:
 *
 *     expectedSha256Hex == null || expectedSha256Hex.equals(actualSha256Hex, ignoreCase = true)
 *
 * The `null` branch is deliberate — an older manifest has no hash and must still update. But
 * **no published manifest has ever carried a hash**: `versionCode` 22 through 27, every one of
 * them, has no `sha256` key. So the intentional backwards-compatibility path is the *only* path
 * ever taken, and the integrity check has been inert for the entire life of the OTA channel.
 *
 * The cause is that two things write this file and only one of them writes the hash.
 * `android/scripts/push-ota.sh` (the local path) always computes `shasum -a 256`. The CI path,
 * `.github/workflows/android-ota.yml`, does this:
 *
 *     m = json.load(open('public/android/manifest.json'))
 *     m.update(versionCode=code, versionName=name, url=..., notes=notes)
 *
 * Four keys, no `sha256`. And because it *carries the old file forward*, the failure is worse than
 * an absent hash: had any release ever published one, the next CI release would have kept the
 * **previous version's** hash next to the **new** version's URL — and then `apkIntegrityOk` fails
 * every download, and the user gets "update didn't verify" forever with nothing in the manifest
 * looking wrong. Absent-and-inert and present-but-stale are the same one-line omission.
 *
 * ## What is checked
 *
 * That the published manifest is internally consistent and its hash actually matches the bytes of
 * the APK it advertises, and that **both** writers emit the field. All offline — the APK is in the
 * repo, so there is nothing to fetch and nothing to go flaky.
 *
 * ⚠️ This is not a store-listing test, but it is the same class of bug as the ones this directory's
 * suites exist for: a mechanism that reports success because the value it checks was never supplied.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MANIFEST = 'public/android/manifest.json'
const CI = '.github/workflows/android-ota.yml'
const LOCAL = 'android/scripts/push-ota.sh'

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// In this repo the manifest is DEPLOYMENT STATE, not source: push-ota.sh
// writes it (and stages the APK beside it) when an operator publishes. A fresh
// clone has neither, so the manifest audits arm themselves only once one
// exists — but the writer audits below always run.
const HAS_MANIFEST = existsSync(join(ROOT, MANIFEST))
const HAS_CI_WRITER = existsSync(join(ROOT, CI))

describe('the Android OTA manifest can actually be verified (c45)', () => {
  const manifest = (HAS_MANIFEST ? JSON.parse(read(MANIFEST)) : {}) as Record<string, unknown>

  it.skipIf(!HAS_MANIFEST)('names an APK that exists in the repo at the advertised versionCode', () => {
    expect(typeof manifest.versionCode, 'versionCode must be a number').toBe('number')
    const code = manifest.versionCode as number
    const url = String(manifest.url ?? '')
    expect(url, 'the OTA url must be https — Updater refuses anything else outside debug').toMatch(
      /^https:\/\//,
    )
    // The url and the versionCode are written by the same step, so a disagreement means the
    // hand-edit path was used. `Updater` trusts `versionCode` for the "is this newer" decision and
    // `url` for what it downloads, so these two disagreeing installs the WRONG build silently.
    expect(url, `url does not name tiny-${code}.apk, but versionCode says ${code}`).toContain(
      `tiny-${code}.apk`,
    )
    expect(
      existsSync(join(ROOT, 'public/android', `tiny-${code}.apk`)),
      `public/android/tiny-${code}.apk is missing — the manifest advertises a download that 404s`,
    ).toBe(true)
  })

  it.skipIf(!HAS_MANIFEST)('carries a sha256, so the integrity check is not skipped', () => {
    expect(
      manifest.sha256,
      `${MANIFEST} has no sha256. apkIntegrityOk(null, …) returns TRUE by design (for pre-hash ` +
        `manifests), so the pre-install verification in Updater.install() is INERT for this ` +
        `release — a truncated or substituted APK reaches the system installer unchecked. ` +
        `${LOCAL} computes the hash; ${CI} does not. Fix the writer, not this test.`,
    ).toBeTruthy()
    expect(String(manifest.sha256), 'sha256 must be 64 lowercase hex chars').toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  it.skipIf(!HAS_MANIFEST)('the sha256 is the hash of the APK it points at, not a stale one', () => {
    // ⚠️ The load-bearing assertion. The CI step carries the old manifest forward with
    // `m.update(4 keys)`, so the FIRST failure mode this repo would hit after adding the hash is a
    // previous release's hash beside the current release's url. That manifest is well-formed, has a
    // valid-looking 64-hex sha256, and breaks every install with "update didn't verify".
    const code = manifest.versionCode as number
    const apk = join(ROOT, 'public/android', `tiny-${code}.apk`)
    if (!manifest.sha256 || !existsSync(apk)) return // reported by the two tests above
    const actual = createHash('sha256').update(readFileSync(apk)).digest('hex')
    expect(
      String(manifest.sha256).toLowerCase(),
      `sha256 does not match public/android/tiny-${code}.apk (actual ${actual}). A hash from a ` +
        `PREVIOUS release makes every install fail "update didn't verify" while the manifest looks ` +
        `perfectly well-formed. The CI step updates 4 keys and carries the rest forward.`,
    ).toBe(actual)
  })

  /**
   * Both writers, because they drift independently and only one of them is ever run by a human.
   * The local script is the one someone reads; CI is the one that actually publishes (every
   * manifest commit from versionCode 22–27 is authored "(CI)").
   */
  it('BOTH publishers emit the hash — the one that runs is the one nobody reads', () => {
    const local = read(LOCAL)
    // ⚠️ Not `/shasum/` on the whole file: `SHA256=""` leaves the word `shasum` in a comment or a
    // neighbouring line and publishes an EMPTY hash — which is strictly worse than no hash at all,
    // because apkIntegrityOk("", actual) is `false`, not skipped, so every install fails
    // "update didn't verify". Assert the assignment is a real command substitution over the APK.
    const assign = local.match(/SHA256=(.*)/)
    expect(assign, `${LOCAL} no longer assigns SHA256 — it was the first writer to compute one`)
      .toBeTruthy()
    expect(
      /\$\(\s*shasum\s+-a\s+256\s+.*apk/.test(assign![1]),
      `${LOCAL} sets SHA256 to ${JSON.stringify(assign![1].trim())} rather than computing it from ` +
        `the APK. An empty or literal value is worse than omitting the field: null SKIPS the check, ` +
        `but a non-null wrong value FAILS it, and every user sees "update didn't verify" forever.`,
    ).toBe(true)

    // This repo publishes OTA manifests through push-ota.sh only; the CI
    // manifest-writer stayed with the hosted deployment. If one is ever added
    // back under the same path, its write is audited again automatically.
    if (!HAS_CI_WRITER) return

    const ci = read(CI)
    // ⚠️ Must target the `m.update(...)` CALL, not "the file mentions sha256 somewhere". Three
    // separate things in this file would satisfy a looser check while the defect is fully present:
    //   • `EXPECTED_CERT_SHA256` — the signing-cert pin, a different mechanism entirely;
    //   • `SHA256=$(shasum …)` — computing the hash;
    //   • `code, name, notes, sha256 = sys.argv[…]` — binding it to a variable.
    // A mutant that removed only `sha256=sha256` from the update call survived a `/sha256\s*=/`
    // check on the whole file, because the destructuring line matched. Computing a hash and then
    // not publishing it IS the bug, so the only assertion that means anything is on the write.
    const call = ci.match(/m\.update\(([\s\S]*?)\)\s*$/m)
    expect(
      call,
      `no m.update(...) call found in ${CI} — the manifest-writing step was restructured, so this ` +
        `test no longer knows where the sha256 would have to go. Re-point it before trusting it.`,
    ).toBeTruthy()
    expect(
      /\bsha256\s*=/.test(call![1]),
      `${CI} publishes the manifest but does not write sha256 into it, so every CI release ships ` +
        `an unverifiable APK — apkIntegrityOk(null, …) returns TRUE and the check silently skips. ` +
        `The m.update(...) keys are: ${call![1].replace(/\s+/g, ' ').trim()}`,
    ).toBe(true)
  })
})
