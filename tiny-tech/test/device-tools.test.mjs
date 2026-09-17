/**
 * 🏷 device-tools.ts — the capabilities this machine ANNOUNCES, and the one that
 * has no tool of its own.
 *
 * Why this file exists at all: `windows` is a label riding on somebody else's
 * tool, and every mistake this module has made was in lines like it. The two
 * historical bugs were the same shape — a label NARROWER than the actions the
 * daemon actually registered:
 *
 *   · `ocr` lived inside the `hasComputerControl()` gate, which also requires
 *     /usr/sbin/screencapture. A Mac that could OCR a file perfectly well
 *     announced no ocr capability at all.
 *   · `see` required `hasSips()`, the CONVERTER, so a node offering working
 *     sight announced none.
 *
 * Both those labels are gone now, along with the tools that carried them
 * (use_desktop and vision.ts were removed) — but the rule they were violating
 * outlives them, so it stays pinned here: a label must appear when ANY route to
 * it registered, and never when NONE did. Too wide strands a remote agent's plan
 * on a capability that isn't there; too narrow stops it from ever asking for one
 * that is. Under-reporting is the failure that hides.
 *
 * Neither bug was visible on a developer's Mac, where every probe answers yes.
 * That is the whole hazard: a wrong gate and a right gate produce identical
 * output here. So the decision stays a pure function over probed facts
 * (labelOnlyCapabilities) and this suite is its truth table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { labelOnlyCapabilities, makeDeviceTools } = await import('../dist/agent/device-tools.js')

/** Every probe false — the headless Linux box nothing resolves on. */
const NONE = {
  computer: false,
  windowControl: false,
}
const facts = (over = {}) => ({ ...NONE, ...over })

test('a machine where nothing registered announces nothing', () => {
  assert.deepEqual(labelOnlyCapabilities(NONE), [])
})

test('a full Mac announces windows', () => {
  assert.deepEqual(labelOnlyCapabilities({ computer: true, windowControl: true }), ['windows'])
})

test('windows rides on use_computer — never announced without it', () => {
  // The label names actions on ONE tool. Announcing it without that tool is a
  // promise nothing can keep, and the gates are different grants (Apple Events
  // for the window moves, screencapture for the tool itself), so the pairing has
  // to be pinned rather than inferred from "it's a Mac".
  assert.ok(!labelOnlyCapabilities(facts({ windowControl: true })).includes('windows'))
  assert.ok(!labelOnlyCapabilities(facts({ computer: true })).includes('windows'))
  assert.ok(labelOnlyCapabilities(facts({ computer: true, windowControl: true })).includes('windows'))
})

test('the whole matrix: no label ever appears without a tool to carry it', () => {
  // Exhaustive rather than sampled, because the two historical bugs were both in
  // combinations nobody thought to write down. `carriers` is the invariant: which
  // registered tool each label's actions actually live on.
  const carriers = {
    windows: (f) => f.computer,
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
    const required = { windows: 'windowControl' }
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
  // label-only ones may lack a tool of their own — anything else must map to a
  // registered `use_*`, or the fleet routes work to a node that cannot do it.
  const { tools, labels } = makeDeviceTools()
  const names = new Set(tools.map((t) => t.name ?? t?.config?.name))
  const LABEL_ONLY = new Set(['windows'])
  for (const label of labels) {
    if (LABEL_ONLY.has(label)) continue
    assert.ok(names.has(`use_${label}`), `label ${label} has no use_${label} tool (have: ${[...names].join(', ')})`)
  }
  // And the label-only one requires its carrier to have registered.
  if (labels.includes('windows')) assert.ok(labels.includes('computer'))
  // integrations is the one that is always on — the machine with nothing
  // connected is exactly the machine that needs a way to connect.
  assert.ok(labels.includes('integrations'))
  assert.ok(names.has('use_integrations'))
})

test('labels are unique — a duplicate would double-count in the prompt', () => {
  const { labels } = makeDeviceTools()
  assert.equal(new Set(labels).size, labels.length, labels.join(','))
})
