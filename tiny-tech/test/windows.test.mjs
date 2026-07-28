/**
 * Window management — the pure half of src/agent/windows.ts.
 *
 * The load-bearing test in here is the COORDINATE-SPACE one. Everything else
 * would fail loudly if it broke; a wrong menu-bar flip fails silently, with
 * every window landing 30pt off and nothing raising. So `visibleRectTopLeft` is
 * pinned against a MEASUREMENT taken on this machine, not against a range:
 *
 *   NSScreen  frame = [0,0,3008,1692]   visibleFrame = [0,0,3008,1662]
 *   a really-maximized Chrome window reports  position [0,30], size 3008×1662
 *
 * 1692 − (0 + 1662) = 30 — so the conversion has to produce y=30, and any test
 * that merely asserts "y ≥ 0" would pass on the broken version too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  visibleRectTopLeft,
  primaryScreen,
  pickScreenIndex,
  snapRect,
  SNAPS,
  selectWindow,
  filterWindows,
  parseWindowPayload,
  parseMutatePayload,
  formatWindows,
  describeGeometry,
  describeOutcome,
  usableRectFor,
  WINDOW_LIST_LIMIT,
} from '../dist/agent/windows.js'

// The real numbers off this Mac — see the docblock.
const THIS_MAC = {
  frame: { x: 0, y: 0, width: 3008, height: 1692 },
  visible: { x: 0, y: 0, width: 3008, height: 1662 },
}
const MAXIMIZED_CHROME = { x: 0, y: 30, width: 3008, height: 1662 }

const win = (o = {}) => ({
  app: 'Calendar',
  index: 0,
  title: 'Calendar',
  x: 722,
  y: 121,
  width: 935,
  height: 598,
  minimized: false,
  frontmost: false,
  ...o,
})

// ── the measured conversion ─────────────────────────────────────────────────

test('visibleRectTopLeft reproduces the position a really-maximized window reports', () => {
  const r = visibleRectTopLeft(THIS_MAC, THIS_MAC.frame.height)
  assert.deepEqual(r, MAXIMIZED_CHROME)
})

test('the menu-bar offset comes out as 30, not 0 — the silent-failure case', () => {
  // The broken version (`y: v.y`) yields 0 here and looks entirely plausible:
  // windows would sit UNDER the menu bar with 30pt spilling off the bottom.
  const r = visibleRectTopLeft(THIS_MAC, THIS_MAC.frame.height)
  assert.equal(r.y, 30)
  assert.notEqual(r.y, THIS_MAC.visible.y)
})

test('a bottom dock takes space from the BOTTOM, not the top', () => {
  // Dock shown: visibleFrame origin rises off the bottom and height shrinks.
  // Menu bar 30 + dock 80 → usable y is still 30, height 1582.
  const docked = {
    frame: { x: 0, y: 0, width: 3008, height: 1692 },
    visible: { x: 0, y: 80, width: 3008, height: 1582 },
  }
  const r = visibleRectTopLeft(docked, 1692)
  assert.equal(r.y, 30)
  assert.equal(r.height, 1582)
})

test('a secondary display flips about the PRIMARY height, not its own', () => {
  // A 1080p screen placed above the primary: NSScreen gives it a positive frame
  // y. Flipping about its own 1080 height instead of the primary's 1692 puts its
  // windows 612pt off — on-screen, plausible, and wrong.
  const secondary = {
    frame: { x: 0, y: 1692, width: 1920, height: 1080 },
    visible: { x: 0, y: 1692, width: 1920, height: 1080 },
  }
  const r = visibleRectTopLeft(secondary, 1692)
  assert.equal(r.y, 1692 - (1692 + 1080))
  assert.equal(r.y, -1080)
})

test('fractional screen metrics round to whole points', () => {
  const s = {
    frame: { x: 0, y: 0, width: 1440.5, height: 900.4 },
    visible: { x: 0, y: 0.5, width: 1440.5, height: 875.2 },
  }
  const r = visibleRectTopLeft(s, 900.4)
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y))
  assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height))
})

// ── primaryScreen / pickScreenIndex ─────────────────────────────────────────

test('primaryScreen is the one at the global origin, whatever its list position', () => {
  const secondary = { frame: { x: -1920, y: 0, width: 1920, height: 1080 }, visible: { x: -1920, y: 0, width: 1920, height: 1080 } }
  assert.equal(primaryScreen([secondary, THIS_MAC]), THIS_MAC)
})

test('primaryScreen falls back to the first screen when none sits at the origin', () => {
  const a = { frame: { x: 100, y: 100, width: 800, height: 600 }, visible: { x: 100, y: 100, width: 800, height: 600 } }
  assert.equal(primaryScreen([a]), a)
})

test('primaryScreen of nothing is null — not a fabricated screen', () => {
  assert.equal(primaryScreen([]), null)
})

test('pickScreenIndex chooses by largest overlap, not by which corner the origin is in', () => {
  const left = { x: 0, y: 0, width: 1000, height: 1000 }
  const right = { x: 1000, y: 0, width: 1000, height: 1000 }
  // Origin is on the LEFT screen, but 900 of its 1000pt width is on the right.
  const straddling = win({ x: 900, y: 0, width: 1000, height: 1000 })
  assert.equal(pickScreenIndex(straddling, [left, right]), 1)
})

test('pickScreenIndex on a window with unknown geometry falls back to the primary', () => {
  const rects = [{ x: 0, y: 30, width: 3008, height: 1662 }]
  assert.equal(pickScreenIndex(win({ x: null, y: null }), rects), 0)
})

test('pickScreenIndex with no screens is -1, so callers can refuse', () => {
  assert.equal(pickScreenIndex(win(), []), -1)
})

test('a window entirely off every display still resolves to a screen', () => {
  // Overlap is 0 everywhere. Returning -1 here would make snap refuse to rescue
  // a window that has been dragged off-screen — the case where snap helps most.
  const rects = [{ x: 0, y: 30, width: 3008, height: 1662 }]
  const lost = win({ x: 9000, y: 9000, width: 400, height: 300 })
  assert.equal(pickScreenIndex(lost, rects), 0)
})

// ── snapRect ────────────────────────────────────────────────────────────────

test('left and right halves tile EXACTLY — no overlapping or gapped pixel', () => {
  // Odd width is the case two independent round(w/2) calls get wrong.
  const usable = { x: 0, y: 30, width: 3007, height: 1663 }
  const l = snapRect(usable, 'left')
  const r = snapRect(usable, 'right')
  assert.equal(l.x, usable.x)
  assert.equal(r.x, l.x + l.width)
  assert.equal(l.width + r.width, usable.width)
  assert.equal(r.x + r.width, usable.x + usable.width)
})

test('top and bottom halves tile exactly on an odd height', () => {
  const usable = { x: 0, y: 30, width: 3008, height: 1663 }
  const t = snapRect(usable, 'top')
  const b = snapRect(usable, 'bottom')
  assert.equal(b.y, t.y + t.height)
  assert.equal(t.height + b.height, usable.height)
  assert.equal(b.y + b.height, usable.y + usable.height)
})

test('the four quarters tile the usable area exactly', () => {
  const usable = { x: 5, y: 31, width: 1001, height: 667 }
  const q = ['top_left', 'top_right', 'bottom_left', 'bottom_right'].map((s) => snapRect(usable, s))
  const area = q.reduce((n, r) => n + r.width * r.height, 0)
  assert.equal(area, usable.width * usable.height)
  // And the far corner is reached, not undershot by a rounding pixel.
  const br = q[3]
  assert.equal(br.x + br.width, usable.x + usable.width)
  assert.equal(br.y + br.height, usable.y + usable.height)
})

test('maximize is the usable area itself — including its 30pt top inset', () => {
  const usable = visibleRectTopLeft(THIS_MAC, THIS_MAC.frame.height)
  assert.deepEqual(snapRect(usable, 'maximize'), MAXIMIZED_CHROME)
})

test('every snap stays inside the usable area', () => {
  const usable = { x: 100, y: 30, width: 1001, height: 667 }
  for (const s of SNAPS) {
    const r = snapRect(usable, s)
    assert.ok(r.x >= usable.x, `${s} x`)
    assert.ok(r.y >= usable.y, `${s} y`)
    assert.ok(r.x + r.width <= usable.x + usable.width, `${s} right edge`)
    assert.ok(r.y + r.height <= usable.y + usable.height, `${s} bottom edge`)
    assert.ok(r.width > 0 && r.height > 0, `${s} non-empty`)
  }
})

test('snaps respect a non-zero usable origin (dock on the left, second display)', () => {
  const usable = { x: 1920, y: 30, width: 1000, height: 1000 }
  assert.equal(snapRect(usable, 'left').x, 1920)
  assert.equal(snapRect(usable, 'right').x, 2420)
})

test('center is proportional and centred, not a fixed size', () => {
  const r = snapRect({ x: 0, y: 0, width: 1000, height: 1000 }, 'center')
  assert.deepEqual(r, { x: 100, y: 100, width: 800, height: 800 })
  const big = snapRect({ x: 0, y: 0, width: 6000, height: 3000 }, 'center')
  assert.equal(big.width, 4800)
})

test('an unknown snap string degrades to maximize rather than a zero rect', () => {
  const usable = { x: 0, y: 30, width: 800, height: 600 }
  assert.deepEqual(snapRect(usable, 'sideways'), usable)
})

// ── selectWindow ────────────────────────────────────────────────────────────

test('with no selector, the frontmost app wins', () => {
  const pool = [win({ app: 'Calendar' }), win({ app: 'Simulator', frontmost: true })]
  assert.equal(selectWindow(pool).app, 'Simulator')
})

test('an app filter is HARD — a title match in another app never wins', () => {
  const pool = [
    win({ app: 'Safari', title: 'GitHub', frontmost: true }),
    win({ app: 'Google Chrome', title: 'GitHub' }),
  ]
  assert.equal(selectWindow(pool, { app: 'chrome' }).app, 'Google Chrome')
})

test('an unmatched app filter returns null instead of some other window', () => {
  assert.equal(selectWindow([win({ app: 'Calendar' })], { app: 'Emacs' }), null)
})

test('a non-minimized window beats a frontmost minimized one', () => {
  // You cannot move, see or screenshot a minimized window, so "front" loses here.
  const pool = [
    win({ app: 'Preview', index: 0, minimized: true, frontmost: true }),
    win({ app: 'Preview', index: 1, minimized: false }),
  ]
  assert.equal(selectWindow(pool, { app: 'preview' }).index, 1)
})

test('an exact title match outranks a partial one', () => {
  const pool = [
    win({ app: 'Preview', index: 0, title: 'notes draft 2' }),
    win({ app: 'Preview', index: 1, title: 'notes' }),
  ]
  assert.equal(selectWindow(pool, { text: 'notes' }).index, 1)
})

test('ties fall back to the app own window order', () => {
  const pool = [
    win({ app: 'Preview', index: 2, title: 'c' }),
    win({ app: 'Preview', index: 0, title: 'a' }),
    win({ app: 'Preview', index: 1, title: 'b' }),
  ]
  assert.equal(selectWindow(pool, { app: 'preview' }).index, 0)
})

test('selection is case- and whitespace-insensitive on both sides', () => {
  const pool = [win({ app: 'Google  Chrome', title: 'GitHub  —  PRs' })]
  assert.ok(selectWindow(pool, { app: 'google chrome' }))
  assert.ok(selectWindow(pool, { text: 'github — prs' }))
})

test('selectWindow of an empty list is null', () => {
  assert.equal(selectWindow([], { app: 'Calendar' }), null)
})

test('filterWindows keeps every match, unlike selectWindow', () => {
  const pool = [win({ app: 'Preview', index: 0 }), win({ app: 'Preview', index: 1 }), win({ app: 'Finder' })]
  assert.equal(filterWindows(pool, { app: 'preview' }).length, 2)
  assert.equal(filterWindows(pool).length, 3)
})

// ── parseWindowPayload ─────────────────────────────────────────────────────

const payload = (o) => JSON.stringify({ ok: true, windows: [], screens: [], ...o })

test('a real enumeration parses through', () => {
  const raw = payload({
    windows: [{ app: 'Calendar', index: 0, title: 'Calendar', x: 722, y: 121, width: 935, height: 598, minimized: false, frontmost: true }],
    screens: [THIS_MAC],
  })
  const res = parseWindowPayload(raw)
  assert.equal(res.ok, true)
  assert.equal(res.windows.length, 1)
  assert.equal(res.windows[0].frontmost, true)
  assert.deepEqual(res.screens[0], THIS_MAC)
})

test('unparseable output is ok:false, not a throw', () => {
  const res = parseWindowPayload('execution error: -1728')
  assert.equal(res.ok, false)
  assert.deepEqual(res.windows, [])
})

test('a window with no app name is dropped — nothing could address it', () => {
  const res = parseWindowPayload(payload({ windows: [{ index: 0, title: 'ghost', x: 0, y: 0 }] }))
  assert.equal(res.windows.length, 0)
})

test('an untitled window is KEPT — panels and palettes are real windows', () => {
  const res = parseWindowPayload(payload({ windows: [{ app: 'Xcode', index: 3, x: 10, y: 10, width: 200, height: 100 }] }))
  assert.equal(res.windows.length, 1)
  assert.equal(res.windows[0].title, '')
})

test('a window whose geometry the API refused keeps null, never 0', () => {
  // 0 would place it in the top-left corner and, worse, make it look movable.
  const res = parseWindowPayload(payload({ windows: [{ app: 'Dock', index: 0, title: 'x' }] }))
  const w = res.windows[0]
  assert.equal(w.x, null)
  assert.equal(w.y, null)
  assert.equal(w.width, null)
  assert.equal(w.height, null)
})

test('a boolean where a coordinate belongs is rejected, not coerced to 1', () => {
  // Number(true) === 1 — the same trap parseOcrPayload guards.
  const res = parseWindowPayload(payload({ windows: [{ app: 'A', index: 0, title: 't', x: true, y: 0, width: 100, height: 100 }] }))
  assert.equal(res.windows[0].x, null)
})

test('a non-boolean minimized/frontmost flag reads as false, not truthy', () => {
  // `"false"` and `1` are both truthy in JS — a string flag must not minimize.
  const res = parseWindowPayload(payload({ windows: [{ app: 'A', index: 0, title: 't', minimized: 'false', frontmost: 1 }] }))
  assert.equal(res.windows[0].minimized, false)
  assert.equal(res.windows[0].frontmost, false)
})

test('a screen missing either rect is dropped rather than half-guessed', () => {
  // Deriving visibleFrame from frame is exactly how the menu-bar bug returns.
  const res = parseWindowPayload(payload({ screens: [{ frame: { x: 0, y: 0, width: 100, height: 100 } }] }))
  assert.equal(res.screens.length, 0)
})

test('ok:false in the payload is respected even with windows present', () => {
  const res = parseWindowPayload(JSON.stringify({ ok: false, windows: [{ app: 'A', index: 0, title: 't' }] }))
  assert.equal(res.ok, false)
})

test('a missing windows array is empty, not a throw', () => {
  assert.deepEqual(parseWindowPayload(JSON.stringify({ ok: true })).windows, [])
})

// ── parseMutatePayload ─────────────────────────────────────────────────────

test('a successful mutation returns the post-state', () => {
  const raw = JSON.stringify({ ok: true, errors: [], window: { app: 'Calendar', index: 0, title: 'Calendar', x: 700, y: 100, width: 900, height: 600 } })
  const res = parseMutatePayload(raw)
  assert.equal(res.ok, true)
  assert.equal(res.window.x, 700)
})

test('a vanished window comes back as ok:false with its reason', () => {
  const res = parseMutatePayload(JSON.stringify({ ok: false, error: 'window 3 of Preview is gone' }))
  assert.equal(res.ok, false)
  assert.match(res.error, /is gone/)
  assert.equal(res.window, null)
})

test('per-op errors survive alongside a successful read-back', () => {
  // The case that matters: the size was refused but the move landed. Reporting
  // only one of those tells the caller the wrong thing about the screen.
  const raw = JSON.stringify({ ok: true, errors: ['size: not settable'], window: { app: 'A', index: 0, title: 't', x: 10, y: 20, width: 500, height: 400 } })
  const res = parseMutatePayload(raw)
  assert.deepEqual(res.errors, ['size: not settable'])
  assert.equal(res.window.x, 10)
})

test('garbage from osascript is ok:false, not a throw', () => {
  const res = parseMutatePayload('')
  assert.equal(res.ok, false)
  assert.equal(res.window, null)
})

// ── formatting ──────────────────────────────────────────────────────────────

test('formatWindows leads with the count and the addressable handle', () => {
  const out = formatWindows([win({ app: 'Calendar', index: 0, frontmost: true })])
  assert.match(out, /^1 window:/)
  assert.match(out, /Calendar\[0\]/)
  assert.match(out, /935×598 @ 722,121/)
  assert.match(out, /\[front\]/)
})

test('formatWindows reports truncation instead of silently cutting', () => {
  const many = Array.from({ length: WINDOW_LIST_LIMIT + 5 }, (_, i) => win({ index: i }))
  const out = formatWindows(many)
  assert.match(out, new RegExp(`^${WINDOW_LIST_LIMIT + 5} windows:`))
  assert.match(out, /… 5 more not shown/)
})

test('formatWindows on nothing says so plainly', () => {
  assert.equal(formatWindows([]), 'no windows found')
})

test('an untitled window renders as untitled, not as an empty quote', () => {
  assert.match(formatWindows([win({ title: '' })]), /\(untitled\)/)
})

test('describeGeometry admits when it does not know', () => {
  assert.equal(describeGeometry(win({ x: null })), 'geometry unavailable')
})

test('describeOutcome confirms a landed move', () => {
  const got = win({ x: 700, y: 100, width: 900, height: 600 })
  assert.equal(describeOutcome({ x: 700, y: 100 }, got), 'now 900×600 @ 700,100')
})

test('describeOutcome names the axis an app adjusted', () => {
  // A terminal snapping to character cells: width kept, height clamped.
  const got = win({ x: 0, y: 30, width: 1504, height: 1400 })
  const out = describeOutcome({ x: 0, y: 30, width: 1504, height: 1662 }, got)
  assert.match(out, /the app adjusted/)
  assert.match(out, /height 1400 \(asked 1662\)/)
  assert.doesNotMatch(out, /width/)
})

test('describeOutcome names a refused WIDTH too, not only height', () => {
  // Mutation-found: the "names the axis" test above asserts width is ABSENT, so
  // deleting the width check entirely passed it. Every axis needs its own
  // positive case, or a whole dimension can stop being reported.
  const got = win({ x: 0, y: 30, width: 1000, height: 1662 })
  const out = describeOutcome({ x: 0, y: 30, width: 1504, height: 1662 }, got)
  assert.match(out, /width 1000 \(asked 1504\)/)
  assert.doesNotMatch(out, /height/)
})

test('describeOutcome names a refused x and y independently', () => {
  const out = describeOutcome({ x: 700, y: 100 }, win({ x: 0, y: 100 }))
  assert.match(out, /x 0 \(asked 700\)/)
  assert.doesNotMatch(out, /y \d/)
})

test('describeOutcome tolerates a 2pt adjustment but not a refusal', () => {
  assert.doesNotMatch(describeOutcome({ x: 700 }, win({ x: 702 })), /adjusted/)
  assert.match(describeOutcome({ x: 700 }, win({ x: 722 })), /adjusted/)
})

test('describeOutcome only judges what was asked for', () => {
  // A move must not report the untouched size as "adjusted".
  const out = describeOutcome({ x: 700, y: 100 }, win({ x: 700, y: 100, width: 935, height: 598 }))
  assert.doesNotMatch(out, /adjusted/)
})

test('describeOutcome on a vanished window says so rather than claiming success', () => {
  assert.match(describeOutcome({ x: 0 }, null), /vanished/)
})

// ── usableRectFor ───────────────────────────────────────────────────────────

test('usableRectFor joins screen pick and flip — the maximize rect for this Mac', () => {
  assert.deepEqual(usableRectFor(win(), [THIS_MAC]), MAXIMIZED_CHROME)
})

test('usableRectFor with no screens is null, so snap refuses instead of guessing', () => {
  assert.equal(usableRectFor(win(), []), null)
})

test('usableRectFor picks the display the window mostly occupies', () => {
  const right = {
    frame: { x: 3008, y: 0, width: 1920, height: 1080 },
    visible: { x: 3008, y: 0, width: 1920, height: 1055 },
  }
  const onRight = win({ x: 3200, y: 700, width: 800, height: 600 })
  const r = usableRectFor(onRight, [THIS_MAC, right])
  assert.equal(r.x, 3008)
  // Flipped about the PRIMARY height: 1692 − (0 + 1055) = 637.
  assert.equal(r.y, 637)
})
