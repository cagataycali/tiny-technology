/**
 * CI actually typechecks `web/`.
 *
 * ## Why this exists (c41)
 *
 * `.github/workflows/ci.yml` is the fresh-clone rehearsal, and it had a hole shaped exactly like
 * the bugs the rest of this directory guards against: a mechanism reporting success because the
 * thing it checks was never handed to it.
 *
 * The web job ran `npm run build` and `npm test`. Neither one typechecks a test file:
 *
 *   - **`next build`** runs TypeScript over the *app graph* — the files reachable from a route.
 *     `web/tests/` (209 suites) is not reachable from any route, so nothing in it is ever visited.
 *     Measured: a `const x: number = 'nope'` at the top of `tests/memory-wipe.test.ts` builds
 *     **exit 0**; the same line in `lib/chat/event-icons.ts` fails the build, which is precisely
 *     why the hole is invisible — the gate works for app code and silently doesn't for tests.
 *   - **`vitest run`** transpiles and discards types (esbuild), so it never sees a type error at all.
 *
 * And the worker job DID run `npx tsc --noEmit`, which made the coverage look symmetric when it
 * wasn't: the tree with 209 test files was the untypechecked one.
 *
 * This is not hypothetical. The commit that motivated this test exists: a `for (const [i, c] of
 * contents.entries())` in `tests/memory-wipe.test.ts` — legal-looking, and rejected by this
 * tsconfig (`"target": "es5"`, no `downlevelIteration`, error TS2802). Replayed through the exact
 * CI web job: build 0, test 0, `tsc --noEmit` **fails**. It would have merged.
 *
 * ## What is checked
 *
 * That the gate exists in the workflow and is really a typecheck of `web` — not that a human wrote
 * the word "typecheck" somewhere. Both halves matter: the step, and the script it invokes.
 *
 * ⚠️ Parsed by regex rather than a YAML library on purpose: `web/` has no yaml dependency and
 * adding one to check its own CI file is a bad trade. The assertions below therefore target the
 * step's *shape* (a `run:` whose `working-directory` is `web`), which is what a mutation to this
 * workflow would have to defeat.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(process.cwd(), '..')
const CI = '.github/workflows/ci.yml'
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8')

// A fresh clone always has ci.yml; a shallow export of web/ alone would not.
// Absent file → the audit reports rather than passing vacuously (see below).
const HAS_CI = existsSync(join(repoRoot, CI))

/**
 * Every `- run: <cmd>` step paired with the `working-directory:` in force for it.
 * Written out because the two facts live on separate lines and a naive
 * `/npm run typecheck/` on the whole file cannot tell the WEB typecheck from the
 * WORKER one — the worker job has had `npx tsc --noEmit` since the workflow was
 * written, so a file-wide match was already green before this cycle's fix.
 */
const steps = (yaml: string): { run: string; dir: string }[] => {
  const out: { run: string; dir: string }[] = []
  const lines = yaml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+run:\s*(.+?)\s*$/)
    if (!m) continue
    let dir = ''
    // `working-directory` may precede or follow `run` within the same step; a
    // step ends at the next `- ` list item.
    for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]); j++) {
      const d = lines[j].match(/^\s*working-directory:\s*(.+?)\s*$/)
      if (d) dir = d[1]
    }
    out.push({ run: m[1], dir })
  }
  return out
}

describe('CI typechecks web, not just the app graph (c41)', () => {
  it('ci.yml is present — an absent workflow is an ungated repo, not a passing test', () => {
    expect(HAS_CI, `${CI} is missing: nothing runs the fresh-clone rehearsal`).toBe(true)
  })

  it('a step typechecks web — build and test both let type errors in tests/ through', () => {
    if (!HAS_CI) return // reported above
    const webSteps = steps(read(CI)).filter((s) => s.dir === 'web')
    expect(webSteps.length, `no steps run in web/ at all in ${CI}`).toBeGreaterThan(0)
    const gate = webSteps.filter((s) => /\btsc\b|\btypecheck\b/.test(s.run))
    expect(
      gate.length,
      `no step in ${CI} typechecks web/. \`next build\` only visits files reachable from a route, ` +
        `so none of the ${209} suites in web/tests are checked, and vitest strips types rather ` +
        `than checking them — a type error in a test file passes both. web steps found: ` +
        JSON.stringify(webSteps.map((s) => s.run)),
    ).toBeGreaterThan(0)
  })

  it('the script it calls really runs tsc over the whole program', () => {
    const pkg = JSON.parse(read('web/package.json')) as { scripts?: Record<string, string> }
    const script = pkg.scripts?.typecheck
    expect(
      script,
      `web/package.json has no "typecheck" script, so CI's typecheck step cannot run. ` +
        `Scripts: ${Object.keys(pkg.scripts ?? {}).join(', ')}`,
    ).toBeTruthy()
    // ⚠️ `--noEmit` is the load-bearing flag, not decoration: without it tsc
    // WRITES .js next to every source and — worse for a gate — a plain `tsc`
    // with this tsconfig still exits non-zero, so the mutant that drops it
    // looks fine until someone's tree fills with emitted output.
    expect(
      /(^|\s|\/)tsc(\s|$)/.test(script!) && /--noEmit/.test(script!),
      `web "typecheck" is ${JSON.stringify(script)} — it must invoke tsc with --noEmit, or the ` +
        `CI step's name is the only typechecking that happens.`,
    ).toBe(true)
  })

  /**
   * The docs make this promise to contributors in three places. A gate nobody
   * documented is forgotten; a documented gate that doesn't exist is worse than
   * either, because it stops people running it themselves.
   */
  it('the contributor docs name the WEB typecheck — not just the worker\'s', () => {
    const contributing = read('CONTRIBUTING.md')
    // ⚠️ `/npm run typecheck/` on the whole file is NOT enough, and a surviving
    // mutant proved it: CONTRIBUTING already told people to typecheck the
    // WORKER, so deleting the web half kept a file-wide match green. The
    // assertion has to bind `web` to the command, the same distinction the
    // ci.yml step check makes with `working-directory`.
    expect(
      /\bweb\b[^\n]{0,60}(npm run typecheck|tsc --noEmit)/.test(contributing),
      `CONTRIBUTING.md tells contributors which suite owns their change but never tells them to ` +
        `typecheck WEB — it names only the worker's. That asymmetry is what hid the gap: the tree ` +
        `with ${209} test files was the one nothing typechecked.`,
    ).toBe(true)
  })
})
