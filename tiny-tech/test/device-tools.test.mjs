/**
 * 🏷 device-tools.ts — the capabilities this machine ANNOUNCES, and the four that
 * have no tool of their own.
 *
 * Why this file exists at all: `windows`, `voice`, `ocr` and `see` are labels
 * riding on somebody else's tool, and every mistake this module has made was in
 * those four lines. Both were the same shape — a label NARROWER than the actions
 * the daemon actually registered:
 *
 *   · `ocr` lived inside the `hasComputerControl()` gate, which also requires
 *     /usr/sbin/screencapture. A Mac that could OCR a file perfectly well
 *     announced no ocr capability at all.
 *   · `see` required `hasSips()`, the CONVERTER. After see.ts learned to measure
 *     a header itself, showing an already-showable png needed no binary — so a
 *     Linux node announced no sight while offering working sight.
 *
 * Neither was reachable by a test, and neither is visible on a developer's Mac,
 * where every probe answers yes. That is the whole hazard: a wrong gate and a
 * right gate produce identical output here. So the decision is a pure function
 * over probed facts (labelOnlyCapabilities) and this suite is its truth table.
 *
 * The rule both failures violate, stated once: a label must appear when ANY
 * route to it registered, and never when NONE did. Too wide strands a remote
 * agent's plan on a capability that isn't there; too narrow stops it from ever
 * asking for one that is. Under-reporting is the failure that hides.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { labelOnlyCapabilities, makeDeviceTools } = await import('../dist/agent/device-tools.js')

/** Every probe false — the headless Linux box nothing resolves on. */
const NONE = {
  computer: false,
  desktop: false,
  windowControl: false,
  visionOcr: false,
  localSpeech: false,
}
const facts = (over = {}) => ({ ...NONE, ...over })

test('a machine where nothing registered announces nothing', () => {
  assert.deepEqual(labelOnlyCapabilities(NONE), [])
})

test('a full Mac announces all four', () => {
  assert.deepEqual(
    labelOnlyCapabilities({
      computer: true, desktop: true, windowControl: true, visionOcr: true, localSpeech: true,
    }),
    ['windows', 'voice', 'ocr', 'see'],
  )
})

test('THE OCR REGRESSION: a Mac with no screencapture still announces ocr', () => {
  // ⚠️ THE BUG, as it was. hasComputerControl() requires /usr/sbin/screencapture,
  //    so use_computer does not register — but read_image on use_desktop does,
  //    and it OCRs a file without ever touching the screen. The label used to sit
  //    inside the computer gate, so this machine claimed no ocr while offering it.
  const noScreen = labelOnlyCapabilities(facts({ desktop: true, visionOcr: true }))
  assert.ok(noScreen.includes('ocr'), 'read_image is registered, so ocr is real')
  assert.ok(!noScreen.includes('windows'), 'but nothing can arrange a screen it cannot see')
  // The mirror: a screen but no desktop senses. read_screen is the route now.
  const screenOnly = labelOnlyCapabilities(facts({ computer: true, visionOcr: true }))
  assert.ok(screenOnly.includes('ocr'))
  assert.ok(!screenOnly.includes('see'), 'see_image lives on use_desktop, which did not register')
})

test('ocr is never announced without Vision, whatever else registered', () => {
  // The other direction, and the one that costs a remote agent a wasted plan:
  // both tools registered, no Vision to read pixels with.
  const noVision = labelOnlyCapabilities(facts({ computer: true, desktop: true }))
  assert.ok(!noVision.includes('ocr'))
  // …and Vision with no tool to carry it is equally not a capability.
  assert.ok(!labelOnlyCapabilities(facts({ visionOcr: true })).includes('ocr'))
})

test('THE SEE REGRESSION: sight needs no converter, only the tool it rides on', () => {
  // ⚠️ THE BUG, as it was: `hasSips() && canDesktop`. sips is the CONVERTER, and
  //    see.ts measures a png/jpeg/gif/webp header itself, so an already-showable
  //    file within the caps reaches the model with no binary at all. There is
  //    deliberately no `sips` fact in this function any more — the only question
  //    sight asks is whether use_desktop registered.
  assert.ok(labelOnlyCapabilities(facts({ desktop: true })).includes('see'))
  assert.ok(!('sips' in NONE), 'sight must not be gated on the converter again')
  // And the mirror error, which is worse: a label for a tool that is not there.
  assert.ok(!labelOnlyCapabilities(facts({ computer: true })).includes('see'))
})

test('voice rides on use_desktop, and windows on use_computer — never swapped', () => {
  // Each label names actions on ONE tool. Announcing either without its tool is
  // a promise nothing can keep, and the gates are different grants (Apple Events
  // for windows, a synthesiser or speech model for voice), so the pairing has to
  // be pinned rather than inferred from "it's a Mac".
  const speechNoDesktop = labelOnlyCapabilities(facts({ computer: true, localSpeech: true }))
  assert.ok(!speechNoDesktop.includes('voice'), 'no use_desktop, no voice actions')
  const windowsNoComputer = labelOnlyCapabilities(facts({ desktop: true, windowControl: true }))
  assert.ok(!windowsNoComputer.includes('windows'), 'no use_computer, no window actions')
  // Present when their own tool is.
  assert.ok(labelOnlyCapabilities(facts({ desktop: true, localSpeech: true })).includes('voice'))
  assert.ok(labelOnlyCapabilities(facts({ computer: true, windowControl: true })).includes('windows'))
})

test('the whole 32-case matrix: no label ever appears without a tool to carry it', () => {
  // Exhaustive rather than sampled, because the two historical bugs were both in
  // combinations nobody thought to write down. `carriers` is the invariant: which
  // registered tool each label's actions actually live on.
  const carriers = {
    windows: (f) => f.computer,
    voice: (f) => f.desktop,
    ocr: (f) => f.computer || f.desktop,
    see: (f) => f.desktop,
  }
  const keys = Object.keys(NONE)
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const f = Object.fromEntries(keys.map((k, i) => [k, Boolean(mask & (1 << i))]))
    const got = labelOnlyCapabilities(f)
    for (const label of got) {
      assert.ok(carriers[label](f), `${label} announced with no tool: ${JSON.stringify(f)}`)
    }
    // The under-reporting direction, which is the one that hides: each label's
    // own requirement plus a carrier means it MUST be announced.
    const required = { windows: 'windowControl', voice: 'localSpeech', ocr: 'visionOcr', see: null }
    for (const [label, need] of Object.entries(required)) {
      const able = carriers[label](f) && (need === null || f[need])
      assert.equal(got.includes(label), able, `${label} on ${JSON.stringify(f)}`)
    }
  }
})

test('makeDeviceTools announces no label whose tool is absent', () => {
  // The integration check, run against whatever THIS machine really is: the
  // registry and the label list are two statements about one machine, and a
  // remote agent reads the labels to decide what to send here. Only the
  // label-only four may lack a tool of their own — anything else must map to a
  // registered `use_*`, or the fleet routes work to a node that cannot do it.
  const { tools, labels } = makeDeviceTools()
  const names = new Set(tools.map((t) => t.name ?? t?.config?.name))
  const LABEL_ONLY = new Set(['windows', 'voice', 'ocr', 'see'])
  for (const label of labels) {
    if (LABEL_ONLY.has(label)) continue
    assert.ok(names.has(`use_${label}`), `label ${label} has no use_${label} tool (have: ${[...names].join(', ')})`)
  }
  // And each label-only one requires its carrier to have registered.
  if (labels.includes('windows')) assert.ok(labels.includes('computer'))
  if (labels.includes('voice')) assert.ok(labels.includes('desktop'))
  if (labels.includes('see')) assert.ok(labels.includes('desktop'))
  if (labels.includes('ocr')) assert.ok(labels.includes('computer') || labels.includes('desktop'))
  // integrations is the one that is always on — the machine with nothing
  // connected is exactly the machine that needs a way to connect.
  assert.ok(labels.includes('integrations'))
  assert.ok(names.has('use_integrations'))
})

test('labels are unique — a duplicate would double-count in the prompt', () => {
  const { labels } = makeDeviceTools()
  assert.equal(new Set(labels).size, labels.length, labels.join(','))
})
