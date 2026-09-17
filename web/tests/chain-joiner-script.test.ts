// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 🚪 c26 — `join-tiny-chain.sh` RUN, not read.
 *
 * The c25 lens was "which other gated/documented step has no working executor?".
 * Applied to the one script an OUTSIDER executes, it found three, all the same
 * shape — a documented behaviour with no implementation:
 *
 *  1. `export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@26}"`. A Homebrew
 *     path, EXPORTED. besu's launcher branches on `[ -n "$JAVA_HOME" ]` before it
 *     ever consults PATH, so on any non-Homebrew host this did not fall back — it
 *     took the invalid-directory `die`, exit 1, printing OUR path at a joiner who
 *     never set the variable and had a working Java. It broke the exact case it
 *     was written to help, and it read as "this chain is macOS-only".
 *  2. The besu-not-found message told the reader PATH was sufficient. The script
 *     only ever looked in our own `~/.tiny-chain` layout.
 *  3. `--help` printed `sed -n '2,32p'` — a hardcoded range that had ALREADY gone
 *     stale and was emitting `set -euo pipefail` and variable assignments as if
 *     they were documentation.
 *
 * Why this file exists at all: `chain-join.test.ts` already had TWO assertions on
 * this script and both were about its text as a STRING (does it mention
 * genesis-8470.json, does it mention --sync-mode=FULL). Every one of the three bugs
 * above sat underneath them, untouched, because nothing ever EXECUTED the file.
 * That is the c53 rule — ask what a check asserts ABOUT, not whether one exists.
 *
 * So these tests run it. `--dry-run` makes that safe: it resolves everything and
 * prints the besu command without starting a node, touching the live chain, or
 * opening a port.
 */

const ROOT = process.cwd()
const SCRIPT = joinPath(ROOT, 'chain/multinode/scripts/join-tiny-chain.sh')
const GENESIS = joinPath(ROOT, 'chain/multinode/genesis-8470.json')

/** A JDK we know exists on this machine, used as the "joiner has Java" fixture.
 * macOS Homebrew paths, then whatever the host (e.g. a CI runner) advertises. */
const REAL_JDK = [
  '/opt/homebrew/opt/openjdk@26',
  '/opt/homebrew/opt/openjdk',
  process.env.JAVA_HOME ?? '',
  '/usr/lib/jvm/default-java',
].filter(Boolean).find((p) => existsSync(joinPath(p, 'bin/java')))

/**
 * Hermetic HOME with a stub besu at the script's fallback path. Without this,
 * the suite passed on the machine that HAS a real besu under ~/.tiny-chain and
 * failed everywhere else — the exact defect class this file was written to
 * catch, one layer up. The stub answers --version so the script's probe reads
 * something besu-shaped; --dry-run never executes it beyond that.
 */
const STUB_HOME = mkdtempSync(joinPath(tmpdir(), 'joiner-home-'))
const STUB_BESU_DIR = joinPath(STUB_HOME, '.tiny-chain/besu/besu-26.7.0/bin')
mkdirSync(STUB_BESU_DIR, { recursive: true })
writeFileSync(joinPath(STUB_BESU_DIR, 'besu'), '#!/bin/sh\necho "besu/v26.7.0"\nexit 0\n', { mode: 0o755 })

/**
 * Run the joiner script with a controlled environment.
 *
 * ⚠️ `env` REPLACES the environment rather than extending it — a test that
 * inherited the parent's PATH and JAVA_HOME would be measuring this machine's
 * setup, not the script, and would pass no matter what the script did.
 */
function run(env: Record<string, string>, args: string[] = ['--dry-run']) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      // ⚠️ Cast through `unknown`: node's ProcessEnv type demands NODE_ENV, and
      // supplying it would defeat the point — the value of this harness is that the
      // child sees ONLY what is listed here, so its env genuinely is a partial one.
      env: { ...env, HOME: env.HOME ?? STUB_HOME } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
  }
}

/**
 * PATH whose `java` is a broken stub. On macOS, bare /usr/bin/java already IS
 * one (exits 1 without a JDK) — but on Linux runners /usr/bin/java is a real
 * JDK, which silently inverted the "no working java" premise. Shadow java
 * with our own stub first on the PATH so the premise holds on every host.
 */
const STUB_JAVA_BIN = mkdtempSync(joinPath(tmpdir(), 'joiner-stubjava-'))
writeFileSync(joinPath(STUB_JAVA_BIN, 'java'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
const STUB_PATH = `${STUB_JAVA_BIN}:/usr/bin:/bin`
const JDK_PATH = REAL_JDK ? `${REAL_JDK}/bin:/usr/bin:/bin` : STUB_PATH

describe('the joiner script is executable by a stranger, not just by us', () => {
  it('resolves and prints a besu command with a JDK on PATH and no JAVA_HOME', () => {
    // The plain case, and the one that used to FAIL on every non-Homebrew host.
    const r = run({ PATH: JDK_PATH, TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/--sync-mode=FULL/)
    expect(r.stdout).toMatch(/--genesis-file=/)
  })

  it('does NOT force our Homebrew JAVA_HOME onto a joiner who has Java already', () => {
    // ⚠️ THE BUG. besu's launcher (bin/besu ~line 84) reads JAVA_HOME FIRST and only
    // falls back to PATH in the else branch, so exporting a path that does not exist
    // on the joiner's machine is not a harmless default — it is a hard failure with
    // our directory name in the message. The script must leave the variable alone.
    const r = run({ PATH: JDK_PATH, TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(0)
    const src = readFileSync(SCRIPT, 'utf8')
    const live = src.split('\n').filter((l) => !l.trim().startsWith('#'))
    // Anchored to the LINE THAT EXECUTES, not to the file: the docblock quotes the
    // old line on purpose (it is the explanation), and a whole-file match would be
    // satisfied by that prose forever.
    expect(live.join('\n')).not.toMatch(/export JAVA_HOME="\$\{JAVA_HOME:-/)
  })

  it('respects a JAVA_HOME the joiner set themselves', () => {
    if (!REAL_JDK) return
    const r = run({ PATH: STUB_PATH, JAVA_HOME: REAL_JDK, TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/--sync-mode=FULL/)
  })

  it('takes TINY_JOIN_JDK_HINT when PATH has no working java', () => {
    if (!REAL_JDK) return
    // Non-vacuity: STUB_PATH alone must NOT be what makes this pass — the hint is.
    const r = run({ PATH: STUB_PATH, TINY_JOIN_JDK_HINT: REAL_JDK, TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(0)
  })

  it('fails LOUDLY, naming Java and the version, when no JDK exists anywhere', () => {
    // ⚠️ Reached by remapping every hint path — otherwise this box's real JDK
    // rescues it and the branch is never exercised. A guard no input can reach is
    // not a guard (c61), and this is the one branch a machine WITH java cannot
    // otherwise enter.
    const src = readFileSync(SCRIPT, 'utf8')
      .replace(/\/opt\/homebrew\/opt\/openjdk@26 \/opt\/homebrew\/opt\/openjdk/, '/nope/a /nope/b')
      .replace(/\/usr\/lib\/jvm\/java-26-openjdk-amd64 \/usr\/lib\/jvm\/default-java/, '/nope/c /nope/d')
    expect(src).toMatch(/\/nope\/a/) // the remap LANDED (c61: confirm the mutant lands)
    const dir = mkdtempSync(joinPath(tmpdir(), 'joiner-nojdk-'))
    const copy = joinPath(dir, 'join.sh')
    writeFileSync(copy, src)
    let code = 0
    let stderr = ''
    let stdout = ''
    try {
      // ⚠️ --bootnodes is supplied on purpose. The copy lives in a tmpdir, so the
      // script's sibling `bootnodes-8470.txt` does not resolve there and the
      // bootnode check fails too. A mutant that deleted this branch's `exit 1`
      // SURVIVED on exactly that: the Java message still printed, execution fell
      // through, and exit 1 arrived from the bootnode check further down — so the
      // test asserted the right code for the wrong reason. Removing the second
      // failure makes Java the ONLY thing that can end this run.
      stdout = execFileSync('bash', [copy, '--dry-run', '--bootnodes', `enode://${'a'.repeat(128)}@203.0.113.7:30303`], {
        env: { PATH: STUB_PATH, TINY_JOIN_GENESIS: GENESIS, HOME: STUB_HOME } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
      })
    } catch (e: any) {
      code = e.status ?? 1
      stderr = String(e.stderr || '')
      stdout = String(e.stdout || '')
    }
    expect(code).toBe(1)
    // …and it STOPPED. Printing a warning and running besu anyway would hand the
    // joiner besu's indeterminate-version death instead of this message.
    expect(stdout).not.toMatch(/--sync-mode=FULL/)
    expect(stderr).not.toMatch(/no bootnodes/)
    // The message must name JAVA and the VERSION. besu's own failure here says
    // "Unable to determine Java version" (its awk reads the stub's empty output),
    // which tells the reader neither what is missing nor where to put it.
    expect(stderr).toMatch(/Java/)
    expect(stderr).toMatch(/25\+/)
    expect(stderr).toMatch(/JAVA_HOME=/)
  })

  it('does not trust `command -v java` — the macOS stub satisfies it and cannot run', () => {
    // /usr/bin/java exists and is executable on every mac while having no runtime:
    // `java -version` exits 1. A lookup-based check hands besu that stub and besu
    // dies with "Unable to determine Java version", strictly less debuggable than
    // the bug being fixed. The predicate must be "does it RUN".
    const src = readFileSync(SCRIPT, 'utf8')
    const live = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(live).toMatch(/java -version >\/dev\/null 2>&1/)
    expect(live).not.toMatch(/command -v java/)
  })
})

describe('besu is found where the joiner installed it, not only where we did', () => {
  it('uses a besu on PATH — which the failure message has always promised', () => {
    if (!REAL_JDK) return
    const dir = mkdtempSync(joinPath(tmpdir(), 'joiner-besu-'))
    const fake = joinPath(dir, 'besu')
    writeFileSync(fake, '#!/usr/bin/env bash\necho FAKE_BESU_RAN\n', { mode: 0o755 })
    const r = run({ PATH: `${dir}:${JDK_PATH}`, TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(0)
    // --dry-run prints the command it WOULD run, so the resolved path is visible
    // without executing anything.
    expect(r.stdout).toContain(fake)
  })

  it('BESU_BIN still wins over PATH', () => {
    if (!REAL_JDK) return
    const dir = mkdtempSync(joinPath(tmpdir(), 'joiner-besu2-'))
    const onPath = joinPath(dir, 'besu')
    const explicit = joinPath(dir, 'besu-explicit')
    for (const f of [onPath, explicit]) {
      writeFileSync(f, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    }
    const r = run({ PATH: `${dir}:${JDK_PATH}`, BESU_BIN: explicit, TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(explicit)
    expect(r.stdout).not.toContain(`${onPath} `)
  })

  it('still names our install path when besu is nowhere', () => {
    if (!REAL_JDK) return
    const r = run({ PATH: JDK_PATH, HOME: mkdtempSync(joinPath(tmpdir(), 'joiner-home-')), TINY_JOIN_GENESIS: GENESIS })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/besu not found/)
    // And it must still say WHY besu specifically — geth/anvil cannot follow QBFT.
    expect(r.stderr).toMatch(/QBFT/)
  })
})

describe('--help documents what the script actually does', () => {
  it('prints prose only — never shell code', () => {
    // ⚠️ `sed -n '2,32p'` was a hardcoded range and had already drifted: line 29 is
    // `set -euo pipefail`, so --help emitted shell. A line number is a claim about a
    // file's shape that no edit invalidates loudly (c47), and the first edit to this
    // header re-broke it. Derived from the comment block instead.
    const r = run({ PATH: JDK_PATH }, ['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/Usage:/)
    for (const leak of ['set -euo pipefail', 'BASH_SOURCE', 'REPO_GENESIS=', 'JOIN_HOME=']) {
      expect(r.stdout, `--help leaked shell: ${leak}`).not.toContain(leak)
    }
  })

  it('documents every environment variable the script reads', () => {
    // A knob with no mention is a knob nobody uses; the c51 inverse (a documented
    // knob that does not exist) is what this whole cycle was about.
    const r = run({ PATH: JDK_PATH }, ['--help'])
    const src = readFileSync(SCRIPT, 'utf8')
    const live = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    // `Array.from`, not spread: this project's tsconfig target predates
    // downlevelIteration, so spreading an iterator fails `tsc` while vitest — which
    // strips types — runs it happily. Green tests are not a typecheck (web-ui c70).
    const read = Array.from(live.matchAll(/\$\{(TINY_JOIN_[A-Z_]+|BESU_BIN)[:-]/g), (m) => m[1])
    expect(read.length).toBeGreaterThan(3) // non-vacuous: the regex found the knobs
    for (const name of Array.from(new Set(read))) {
      expect(r.stdout, `${name} is read but undocumented`).toContain(name)
    }
  })

  it('--print-validator-steps still refuses to call the stake slashable', () => {
    // The honesty claim the design doc leans on. It is prose, so nothing else can
    // catch it drifting, and this script is where a stranger reads it.
    const r = run({ PATH: JDK_PATH }, ['--print-validator-steps'])
    expect(r.code).toBe(0)
    // ⚠️ Whitespace-normalised, because the heredoc HARD-WRAPS its prose: the real
    // text is "but nothing burns\n    stake yet". A raw /nothing burns stake yet/
    // fails on a phrase that is present, i.e. it reports drift that did not happen
    // — the same false accusation as c51's partial derivation.
    const flat = r.stdout.replace(/\s+/g, ' ')
    expect(flat).toMatch(/DEPOSIT, not a bond/)
    expect(flat).toMatch(/nothing burns stake yet/)
    expect(flat).toMatch(/rotate\(\) yourself/)
  })

  it('rejects an unknown flag instead of silently ignoring it', () => {
    const r = run({ PATH: JDK_PATH }, ['--sync-mode=SNAP'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/unknown argument/)
  })
})

describe('the other operator scripts are RIGHT to hardcode the path', () => {
  it('gen-network.sh and start-devnet.sh keep their local JAVA_HOME', () => {
    // ⚠️ NOT a copy-paste omission — the point of the finding. Those two run only on
    // the operators' machine, so a local path is correct there; this script is the
    // only file in the tree a stranger executes, which is what makes the identical
    // line a bug in ONE of the three. Two callers sharing a mechanism do not
    // necessarily share its warrant (web-ui c70's rule). If a future cycle
    // "fixes" them for consistency, that is a decision to make deliberately.
    for (const f of ['gen-network.sh', 'start-devnet.sh']) {
      const src = readFileSync(joinPath(ROOT, 'chain/multinode/scripts', f), 'utf8')
      expect(src, `${f} changed — was that deliberate?`).toMatch(/export JAVA_HOME="\$\{JAVA_HOME:-/)
    }
  })
})
