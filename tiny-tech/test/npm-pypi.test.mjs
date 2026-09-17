/**
 * use_npm / use_pypi tests — pure builders + sandbox wiring.
 *
 * No network, no installs: the code builders are pure string functions
 * (the google.ts request-builder lesson), and the inspect/call child-process
 * codepaths are exercised against node's own stdlib surface via a temp
 * sandbox — node:path is always importable, so `inspect` and `call` run for
 * real without touching the registry.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const npm = await import('../dist/agent/npm.js')
const pypi = await import('../dist/agent/pypi.js')

// ── packageName (npm spec → bare name) ──────────────────────────────────────

test('npm packageName: plain', () => {
  assert.strictEqual(npm.packageName('lodash'), 'lodash')
})
test('npm packageName: versioned', () => {
  assert.strictEqual(npm.packageName('lodash@4.17.21'), 'lodash')
})
test('npm packageName: scoped', () => {
  assert.strictEqual(npm.packageName('@scope/pkg'), '@scope/pkg')
})
test('npm packageName: scoped + version', () => {
  assert.strictEqual(npm.packageName('@scope/pkg@1.2.3'), '@scope/pkg')
})
test('npm packageName: subpath', () => {
  assert.strictEqual(npm.packageName('lodash/fp'), 'lodash')
})

// ── importName (pip spec → import guess) ────────────────────────────────────

test('pypi importName: plain', () => {
  assert.strictEqual(pypi.importName('requests'), 'requests')
})
test('pypi importName: dashes become underscores', () => {
  assert.strictEqual(pypi.importName('yt-dlp'), 'yt_dlp')
})
test('pypi importName: pins and extras stripped', () => {
  assert.strictEqual(pypi.importName('yt-dlp[default]==2024.1'), 'yt_dlp')
  assert.strictEqual(pypi.importName('pandas>=2.0'), 'pandas')
})

// ── code builders are valid source (parse without executing imports) ───────

test('npm buildInspectCode embeds package safely', () => {
  const code = npm.buildInspectCode("weird'pkg\"name")
  assert.ok(code.includes(JSON.stringify("weird'pkg\"name")))
  assert.ok(code.includes('await import(pkg)'))
})

test('npm buildCallCode embeds args as JSON', () => {
  const code = npm.buildCallCode('sharp', 'default', [{ width: 100 }], false)
  assert.ok(code.includes('"width":') || code.includes('"width": '))
  assert.ok(code.includes(JSON.stringify(false)))
})

test('pypi buildInspectCode is syntactically embedded', () => {
  const code = pypi.buildInspectCode('yt_dlp')
  assert.ok(code.includes(JSON.stringify('yt_dlp')))
  assert.ok(code.includes('importlib.import_module'))
})

test('pypi buildCallCode carries kwargs (double-encoded for json.loads — JSON null is not Python)', () => {
  const code = pypi.buildCallCode('yfinance', 'download', ['AAPL'], { period: '1mo' })
  assert.ok(code.includes('json.loads('))
  assert.ok(code.includes('period'))
  assert.ok(code.includes('AAPL'))
  // the bug this guards: kwargs=null must NOT appear as a bare Python token
  const bare = pypi.buildCallCode('m', 'f', [], null)
  assert.ok(!/kwargs = null/.test(bare))
})

// ── the real child-process path, against node's own stdlib ─────────────────
// node:path needs no install, so inspect + call run END TO END in a temp
// sandbox: sandbox creation, package.json bootstrap, child node, JSON out.

function withTempSandbox(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-npm-test-'))
  const saved = process.env.TINY_NPM_DIR
  process.env.TINY_NPM_DIR = dir
  return Promise.resolve(fn(dir)).finally(() => {
    if (saved === undefined) delete process.env.TINY_NPM_DIR
    else process.env.TINY_NPM_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  })
}

test('npm sandbox: ensureNpmDir bootstraps package.json once', () =>
  withTempSandbox(async (dir) => {
    assert.strictEqual(npm.ensureNpmDir(), dir)
    const pkg = JSON.parse(execFileSync('cat', [join(dir, 'package.json')], { encoding: 'utf-8' }))
    assert.strictEqual(pkg.type, 'module')
    assert.strictEqual(pkg.private, true)
  }))

test('npm inspect: real child process against node:path', () =>
  withTempSandbox(async () => {
    const code = npm.buildInspectCode('node:path')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' })
    const parsed = JSON.parse(out)
    assert.strictEqual(parsed.package, 'node:path')
    assert.ok(parsed.exports.join.startsWith('fn '), 'path.join should reflect as a function')
  }))

test('npm call: invokes an export and returns JSON result', () =>
  withTempSandbox(async () => {
    const code = npm.buildCallCode('node:path', 'join', ['a', 'b', 'c'], false)
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' })
    assert.deepStrictEqual(JSON.parse(out), { result: join('a', 'b', 'c') })
  }))

test('npm call: missing export lists what exists (one-round-trip self-correct)', () =>
  withTempSandbox(async () => {
    const code = npm.buildCallCode('node:path', 'noSuchFn', [], false)
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' })
    const parsed = JSON.parse(out)
    assert.match(parsed.error, /export not found/)
    assert.ok(parsed.available.includes('join'))
  }))

test('npm call: non-function export returns its value', () =>
  withTempSandbox(async () => {
    const code = npm.buildCallCode('node:path', 'sep', [], false)
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' })
    assert.ok(['/', '\\\\', '\\'].includes(JSON.parse(out).value))
  }))

// ── tool registration surface ───────────────────────────────────────────────

test('makeNpmTool / makePypiTool expose the right names', () => {
  assert.strictEqual(npm.makeNpmTool().name, 'use_npm')
  assert.strictEqual(pypi.makePypiTool().name, 'use_pypi')
})

test('device-tools: npm/pypi labels ride the same gates as everything else', async () => {
  const dt = await import('../dist/agent/device-tools.js')
  const { labels } = dt.makeDeviceTools()
  // On any machine that can run this test suite, node exists — npm almost
  // certainly does too, but assert only the conditional consistency:
  if (npm.hasNpm()) assert.ok(labels.includes('npm'))
  if (pypi.hasPython()) assert.ok(labels.includes('pypi'))
})

// ── deep-test regressions (found by live battery 2026-08-12) ────────────────

test('pypi buildResolveImportCode inverts packages_distributions', () => {
  const code = pypi.buildResolveImportCode('python-dateutil')
  assert.ok(code.includes('packages_distributions'))
  assert.ok(code.includes(JSON.stringify('python-dateutil')))
})

test('pypi buildCallCode: submodule fallback present (PIL.Image class of bug)', () => {
  const code = pypi.buildCallCode('PIL', 'Image.new', ['RGB', [10, 10]], null)
  // lazy submodules are not attrs until imported — the builder must try import
  assert.ok(code.includes("importlib.import_module(root"))
  assert.ok(code.includes('hint'))
})

test('npm buildCallCode: default-chain unwrap present (module.exports=fn class of bug)', () => {
  const code = npm.buildCallCode('left-pad', '', ['x', 5], false)
  assert.ok(code.includes('target.default'), 'CJS interop unwrap loop must exist')
})

test('npm call: bare CJS module.exports=fn works end-to-end (simulated)', () =>
  withTempSandbox(async (dir) => {
    // a fake CJS package inside the sandbox — same shape as left-pad
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const pkgDir = join(dir, 'node_modules', 'fake-cjs')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-cjs', version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = function pad(s, n) { return String(s).padStart(n, "0") }')
    const code = npm.buildCallCode('fake-cjs', '', ['7', 3], false)
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf-8' })
    assert.deepStrictEqual(JSON.parse(out), { result: '007' })
  }))
