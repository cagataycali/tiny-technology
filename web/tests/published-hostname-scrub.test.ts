// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * No file published from this repo may spell out a real device hostname.
 *
 * This repo is PUBLIC, and both apps enroll their device under a name derived
 * from the account login — `"\(user?.login ?? "user")-\(model)"` in
 * Session.swift, `"${auth.login ?: "user"}-pixel"` in FleetManager.kt — so a
 * fleet screenshot, or a note describing one, publishes the mapping *this
 * person owns these machines, named thus, last seen then*. The login itself is
 * no secret (it is in the repo URL); the mapping is the leak.
 *
 * The rule already existed and was already enforced — for RENDERED ROWS.
 * FleetHarnessTest's `no row name embeds an account login or a real hostname`
 * pins what the debug harness draws into a store capture. What nothing pinned
 * was the SOURCE: three shipped files carried the leaking hostnames in prose,
 * two of them in the very comment explaining why such a list must never be
 * published (`web/scripts/gen-store-composites.mjs`'s c40 note and
 * `FleetHarness.kt`'s docblock — the file whose whole job is keeping that list
 * out of the Play upload tree, which even states "Names are generic device
 * types, never hostnames"), and the third as a column comment in
 * `worker/migrations/0013_devices.sql`. A capture was scrubbed and the
 * explanation kept the evidence.
 *
 * ⚠️ The needles are DERIVED, never typed. Writing them out here would move the
 * leak into its own regression test — and a hand-kept list of hostnames is
 * exactly what a login-derived naming scheme defeats: the next device this
 * account enrolls has a name nobody added to the list.
 */

const repoRoot = join(process.cwd(), '..')

/**
 * The account login, read out of the repo's own GitHub URL. Public by
 * construction — it is how you clone this — which is why it can be derived here
 * while the hostnames it composes cannot be written down.
 */
const owner = (() => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const m = readme.match(/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/tiny-technology/)
  return m?.[1] ?? ''
})()

/**
 * `<login>-` and the shorter prefixes of it that a hostname is also built from
 * (a machine's own name predates the app and truncates the login). Six
 * characters is the floor: shorter prefixes of a short login would match
 * ordinary hyphenated words.
 */
const needles = (() => {
  const out: string[] = []
  for (let n = 6; n <= owner.length; n++) out.push(`${owner.slice(0, n)}-`)
  return out
})()

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.wrangler', '.venv', '__pycache__',
])
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.kt', '.kts', '.swift', '.md',
  '.json', '.yml', '.yaml', '.sql', '.sh', '.py', '.plist', '.xml', '.html', '.css']

/**
 * Every text file this repo publishes. Walked rather than listed, because a
 * listed set is a set the next file joins unchecked.
 *
 * ⚠️ Symlinked directories are skipped, not followed: the public layout
 * symlinks `ios`, `android`, `worker` and `chain` into `web/`, so following
 * them would walk the whole tree twice — and, worse, report a hit at a path
 * that only exists as an alias of the real one.
 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, acc)
      continue
    }
    if (lstatSync(p).size > 4_000_000) continue
    if (EXTS.some((x) => e.name.endsWith(x))) acc.push(p)
  }
  return acc
}

describe('a published file never spells a real device hostname', () => {
  it('derived the login from the repo URL, and needles from it', () => {
    // Without this the sweep below runs with an empty needle set and passes on
    // any tree at all — the empty-scrape failure mode, which reads as a pass
    // forever.
    expect(owner.length).toBeGreaterThanOrEqual(6)
    expect(needles.length).toBeGreaterThan(0)
    // A positive control: the needles must actually catch the shape both apps
    // build. This is the assertion that fails if the naming scheme changes and
    // the derivation stops describing it.
    const shape = `${owner}-pixel`
    expect(needles.some((n) => shape.includes(n))).toBe(true)
  })

  it('both clients still derive the device name from the login, or this pin guards nothing', () => {
    // The premise. If enrollment stops embedding the login, the needles above
    // describe a hostname shape that no longer exists and the sweep is theatre.
    expect(readFileSync(join(repoRoot, 'ios/Tiny/Sources/Session.swift'), 'utf8'))
      .toContain('let name = "\\(user?.login ?? "user")-\\(model)"')
    expect(readFileSync(join(repoRoot, 'android/app/src/main/java/technology/tiny/app/fleet/FleetManager.kt'), 'utf8'))
      .toContain('val name = "${auth.login ?: "user"}-pixel"')
  })

  it('no source, doc, migration or config carries one', () => {
    const files = walk(repoRoot)
    // Guard the sweep itself: a walk that silently returns nothing satisfies
    // the assertion below on a tree full of hostnames.
    expect(files.length).toBeGreaterThan(300)
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const lower = text.toLowerCase()
      for (const n of needles) {
        if (!lower.includes(n.toLowerCase())) continue
        // Report the LINE, not the hostname: a failure message is published
        // output too (CI logs), so it names where to look and stops there.
        const line = text.split('\n').findIndex((l) => l.toLowerCase().includes(n.toLowerCase())) + 1
        hits.push(`${f.slice(repoRoot.length + 1)}:${line}`)
        break
      }
    }
    expect(hits, 'a real device hostname is published at these lines').toEqual([])
  })

  it('the harness that draws the substitute fleet still describes the names instead of quoting them', () => {
    // The sweep above goes green the moment the words are deleted, including by
    // deleting the explanation. The explanation is the reason the next capture
    // does not re-leak, so require that it still says what it is protecting.
    const kt = readFileSync(
      join(repoRoot, 'android/app/src/main/java/technology/tiny/app/ui/FleetHarness.kt'), 'utf8')
    expect(kt).toMatch(/BY HOSTNAME/)
    expect(kt).toMatch(/generic device types, never hostnames/)
    const mjs = readFileSync(join(repoRoot, 'web/scripts/gen-store-composites.mjs'), 'utf8')
    expect(mjs).toMatch(/every crop of this screen worth captioning IS the hostname\s+\/\/ list/)
  })
})
