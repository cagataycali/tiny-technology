#!/usr/bin/env python3 -P
"""
c67 mutation harness — does anything actually FAIL when the route honesty breaks?

Run:  python3 -P scripts/c67-mutation-harness.py

Every mutant is a plausible regression a future edit could make (a read moved one
line, a default filled in, a second copy of the two words, a field dropped from
one of two writers). A mutant that SURVIVES means the pin claiming to catch it is
decoration.

Rules this harness obeys, all of them paid for in earlier cycles:
  * GOLD copies of every target under /tmp, restored in a `finally`, and `cmp`d at
    the end — a cleanup step is the UNDO of its setup, not the last item in a list.
  * NEVER open(p,"w") before reading — read first, into memory, then write.
  * Dry-check every needle at its expected COUNT before mutating. A needle that
    matches 0 times mutates nothing and the "kill" is the pin failing on something
    else entirely; a needle matching more than expected mutates code we did not
    mean to touch.
  * NO-OP CONTROLS: a comment-only edit to each target must leave the suite GREEN.
    Without them a suite that is red for an unrelated reason reads as 100% kill.
  * A SKIP is not a pass — the tally refuses to print a verdict if any run's test
    count drops below the green baseline.
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUITE = 'tests/wearables-android.test.ts'
JAVA_HOME = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home'

# ── targets ──────────────────────────────────────────────────────────────────
REC = 'android/app/src/main/java/technology/tiny/app/fleet/PhoneRecorder.kt'
NIC = 'ios/Tiny/Sources/NiclaRecorder.swift'
SPE = 'ios/Tiny/Sources/Speech.swift'
LIV = 'ios/Tiny/Sources/WearablesLive.swift'
SES = 'ios/Tiny/Sources/Session.swift'
TOOL = 'lib/chat/tools/nicla-voice.ts'
TARGETS = [REC, NIC, SPE, LIV, SES, TOOL]

# (name, file, needle, replacement, expected_needle_count, what_should_die)
MUTANTS = [
    # ── the timing bug, the whole reason this cycle exists ───────────────────
    ('android: route read AFTER the link came down', REC,
     '        Heard(snapshot(), route(BtMic.active))\n        } finally {\n',
     '        } finally {\n', 1,
     'the take carries its route out'),
    ('android: reply reads the LIVE link instead of the carried field', REC,
     'take.micRoute?.let { o.put("micRoute", it) }',
     'o.put("micRoute", route(BtMic.active))', 1,
     'the take carries its route out'),
    ('ios: route read AFTER setActive(false)', NIC,
     '        let heardVia = MicRoute.current()\n'
     '        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)',
     '        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)\n'
     '        let heardVia = MicRoute.current()', 1,
     'the iOS take reads its route BEFORE it deactivates'),
    ('ios: an executable line slips into the one honest gap', NIC,
     '        let heardVia = MicRoute.current()\n',
     '        let heardVia = MicRoute.current()\n        engine.reset()\n', 1,
     'the iOS take reads its route BEFORE it deactivates'),

    # ── unknown becomes a claim ─────────────────────────────────────────────
    ('android: absent route defaults to the built-in mic', REC,
     '        val micRoute: String? = null,',
     '        val micRoute: String = "phone",', 1,
     'the take carries its route out'),
    ('ios: the failure path claims the phone heard it', NIC,
     'micRoute: nil)', 'micRoute: "phone")', 1,
     'the iOS take reads its route BEFORE it deactivates'),
    ('tool: an unparsed route defaults to "phone"', TOOL,
     "const micRoute = p.micRoute === 'bluetooth' || p.micRoute === 'phone' ? p.micRoute : undefined",
     "const micRoute = p.micRoute ?? 'phone'", 1,
     'the take carries its route out'),

    # ── the spelling drifts ─────────────────────────────────────────────────
    ('ios: MicRoute says "headset" instead of "bluetooth"', SPE,
     'return bt ? "bluetooth" : "phone"', 'return bt ? "headset" : "phone"', 1,
     'BOTH phones spell the route the same two ways'),
    ('android: route() says "bt" instead of "bluetooth"', REC,
     'if (viaBluetooth) "bluetooth" else "phone"', 'if (viaBluetooth) "bt" else "phone"', 1,
     'BOTH phones spell the route the same two ways'),
    ('ios: the glasses rail keeps its OWN copy of the two words', LIV,
     'private static func micRoute() -> String { MicRoute.current() }',
     'private static func micRoute() -> String {\n'
     '        AVAudioSession.sharedInstance().currentRoute.inputs\n'
     '            .contains { $0.portType == .bluetoothHFP } ? "bluetooth" : "phone"\n'
     '    }', 1,
     'BOTH phones spell the route the same two ways'),

    # ── the field never reaches the agent ───────────────────────────────────
    ('ios: NEITHER relay writer posts the route', SES,
     'if let r = res.micRoute { reply["micRoute"] = r }',
     '// route omitted', 2,
     'the captured route survives the trip'),
    # ⚠️ The one that matters more, and the reason the pin counts instead of
    # matching: losing ONE of two writers is the realistic regression. It makes
    # the reply depend on whether the app happened to be backgrounded — a bug no
    # `toMatch` can see, because the other site still matches.
    ('ios: only ONE relay writer posts the route (the background beat loses it)', SES,
     'if let r = res.micRoute { reply["micRoute"] = r }',
     '// route omitted', 2,
     'the captured route survives the trip', 2),   # nth=2: the LAST writer only
    ('tool: the field is parsed and then dropped', TOOL,
     'mic_route: micRoute,', 'mic_route_unused: micRoute,', 1,
     'the captured route survives the trip'),
    ('tool: the description promises the phone\'s own mic again', TOOL,
     'The phone may capture through its own built-in mic OR through a Bluetooth headset',
     'The phone records N seconds through its own mic', 1,
     'the captured route survives the trip'),

    # ── a new answering rail arrives silent (the derived roster) ────────────
    ('android: an answering rail loses its route entirely', REC,
     'take.micRoute?.let { o.put("micRoute", it) }\n        return o',
     'return o', 1,
     'a rail that can hear the GLASSES says which mic heard it'),

    # ── the JVM half: the words themselves ──────────────────────────────────
    ('android: route() inverted (JVM must catch, not just the source pin)', REC,
     'if (viaBluetooth) "bluetooth" else "phone"', 'if (viaBluetooth) "phone" else "bluetooth"', 1,
     'JVM: the route words are meta_listen\'s words, exactly'),
]

# Comment-only no-ops: green must stay green, or a "kill" means nothing.
NOOPS = [
    (REC, 'internal fun route(viaBluetooth: Boolean)',
     '// c67 no-op control\n    internal fun route(viaBluetooth: Boolean)'),
    (NIC, '        let heardVia = MicRoute.current()',
     '        // c67 no-op control\n        let heardVia = MicRoute.current()'),
    (SPE, 'enum MicRoute {', '// c67 no-op control\nenum MicRoute {'),
    (LIV, '    private static func micRoute()',
     '    // c67 no-op control\n    private static func micRoute()'),
    (SES, 'if let r = res.micRoute { reply["micRoute"] = r }',
     '/* c67 no-op control */ if let r = res.micRoute { reply["micRoute"] = r }'),
    (TOOL, '            mic_route: micRoute,',
     '            // c67 no-op control\n            mic_route: micRoute,'),
]

JVM_MUTANTS = {'android: route() inverted (JVM must catch, not just the source pin)'}


def gold_dir() -> Path:
    d = Path('/tmp/c67-gold')
    if d.exists():
        shutil.rmtree(d)
    for rel in TARGETS:
        dst = d / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)
    return d


def restore(gold: Path) -> None:
    for rel in TARGETS:
        shutil.copy2(gold / rel, ROOT / rel)


def vitest() -> tuple[bool, int]:
    """(passed, tests_run) — a run whose count dropped is a SKIP, not a pass."""
    p = subprocess.run(
        # No --reporter=basic: vitest 4 removed it and EXITS NONZERO on the
        # unknown flag, which would read as "every mutant killed".
        ['npx', 'vitest', 'run', SUITE],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = p.stdout + p.stderr
    m = re.search(r'Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)? \((\d+)\)', out)
    total = int(m.group(4)) if m else -1
    skipped = int(m.group(3) or 0) if m else 0
    if skipped:
        print(f'    ⚠️  {skipped} SKIPPED — a skip reads exactly like a pass. Chase it.')
    return p.returncode == 0, total


def jvm() -> tuple[bool, int]:
    """
    ⚠️ Two traps live in these ten lines.

    `gradlew -q` under a non-login shell has NO JAVA_HOME here and dies with
    "Unable to locate a Java Runtime" — while still EXITING 0. That is a mutant
    that "survives" for a reason having nothing to do with the code, so the JDK
    goes in the environment explicitly.

    And a kill read from a stale result file is not a kill: the XML is deleted
    before every run, so `not xml.exists()` means the tests did not run at all.
    """
    xml = ROOT / ('android/app/build/test-results/testDebugUnitTest/'
                  'TEST-technology.tiny.app.fleet.PhoneRecorderTest.xml')
    xml.unlink(missing_ok=True)
    env = {**os.environ, 'JAVA_HOME': JAVA_HOME}
    p = subprocess.run(
        ['./gradlew', ':app:testDebugUnitTest', '--rerun-tasks',
         '--tests', 'technology.tiny.app.fleet.PhoneRecorderTest', '-q'],
        cwd=ROOT / 'android', capture_output=True, text=True, env=env,
    )
    out = p.stdout + p.stderr
    if 'Unable to locate a Java Runtime' in out:
        raise SystemExit('❌ no JDK — gradle exits 0 without running anything. '
                         f'JAVA_HOME={JAVA_HOME} is wrong.')
    if not xml.exists():
        # No file after a --rerun-tasks run: nothing executed. Refuse the verdict
        # rather than report the compile failure as a kill.
        return False, 0
    m = re.search(r'tests="(\d+)"', xml.read_text())
    skips = re.search(r'skipped="(\d+)"', xml.read_text())
    if skips and int(skips.group(1)):
        print(f'    ⚠️  JVM reports {skips.group(1)} skipped — chase it, a skip reads as a pass.')
    return p.returncode == 0, int(m.group(1)) if m else -1


def mutate(rel: str, needle: str, repl: str, expect_n: int, nth: int | None = None) -> None:
    """
    Replace every occurrence, or — with `nth` — exactly the nth one (1-based).

    `nth` exists for the site-count pins: breaking ONE of N identical call sites
    is the realistic regression, and a mutant that breaks all of them cannot tell
    a counting pin from a matching one.
    """
    path = ROOT / rel
    src = path.read_text()               # READ FIRST. Never open(...,'w') before this.
    n = src.count(needle)
    if n != expect_n:
        raise SystemExit(
            f'❌ needle count {n} != expected {expect_n} in {rel}\n'
            f'   The needle no longer describes the code, so this mutant would\n'
            f'   prove nothing. Fix the harness, do not lower the bar.\n   {needle[:90]!r}'
        )
    if nth is None:
        path.write_text(src.replace(needle, repl))
        return
    at = -1
    for _ in range(nth):
        at = src.index(needle, at + 1)
    path.write_text(src[:at] + repl + src[at + len(needle):])


def main() -> int:
    gold = gold_dir()
    results = []
    try:
        print('── baseline ───────────────────────────────────────────────')
        ok, base_v = vitest()
        if not ok:
            print(f'❌ baseline vitest RED ({base_v} tests) — no verdict is possible.')
            return 1
        print(f'   vitest GREEN, {base_v} tests')
        ok, base_j = jvm()
        if not ok or base_j < 1:
            print(f'❌ baseline JVM RED / no results ({base_j} tests).')
            return 1
        print(f'   JVM GREEN, {base_j} tests')

        print('\n── no-op controls (green must stay green) ─────────────────')
        for rel, needle, repl in NOOPS:
            mutate(rel, needle, repl, (ROOT / rel).read_text().count(needle))
            ok, n = vitest()
            restore(gold)
            flag = 'ok' if (ok and n == base_v) else 'FALSE RED'
            if flag != 'ok':
                print(f'   ❌ {rel}: comment-only edit turned the suite {"red" if not ok else f"to {n} tests"}')
            else:
                print(f'   ✅ {rel}')
            results.append(('noop', rel, flag))

        print('\n── mutants ────────────────────────────────────────────────')
        for name, rel, needle, repl, cnt, dies, *rest in MUTANTS:
            mutate(rel, needle, repl, cnt, rest[0] if rest else None)
            if name in JVM_MUTANTS:
                ok, n = jvm()
                base = base_j
                gate = 'JVM'
            else:
                ok, n = vitest()
                base = base_v
                gate = 'vitest'
            restore(gold)
            if n < base and n != -1:
                verdict = f'SKIP-SUSPECT ({n} < {base})'
            elif ok:
                verdict = 'SURVIVED'
            else:
                verdict = 'killed'
            icon = '✅' if verdict == 'killed' else '❌'
            print(f'   {icon} [{gate}] {name}\n        → {verdict}  (expects: {dies})')
            results.append(('mutant', name, verdict))
    finally:
        restore(gold)
        bad = [rel for rel in TARGETS
               if subprocess.run(['cmp', '-s', str(gold / rel), str(ROOT / rel)]).returncode != 0]
        print('\n── restore ────────────────────────────────────────────────')
        print('   ✅ all targets byte-identical to GOLD' if not bad
              else f'   ❌ NOT RESTORED: {bad}')

    survived = [n for k, n, v in results if k == 'mutant' and v != 'killed']
    falsered = [n for k, n, v in results if k == 'noop' and v != 'ok']
    total = sum(1 for k, _, _ in results if k == 'mutant')
    print(f'\n── tally ──────────────────────────────────────────────────')
    print(f'   {total - len(survived)}/{total} mutants killed')
    if falsered:
        print(f'   ❌ {len(falsered)} false-red control(s): {falsered}')
    if survived:
        print('   ❌ SURVIVORS — each is a test gap, an equivalent mutant, the')
        print('      WRONG GATE, or a missing mutation. Decide which, in writing:')
        for s in survived:
            print(f'        · {s}')
    return 1 if (survived or falsered) else 0


if __name__ == '__main__':
    sys.exit(main())
