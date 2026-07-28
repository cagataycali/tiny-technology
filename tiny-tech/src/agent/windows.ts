/**
 * 🪟 Window management — the daemon can arrange the screen it can already see.
 *
 * docs/e2e-gaps-report-2026-07-25.md §3.2 lists the daemon's capability gaps.
 * Window management appears NOWHERE in that table, which is exactly why it's
 * worth doing: c12/c13 gave the daemon eyes (a screenshot is a real ImageBlock),
 * c54 gave it on-device OCR (a label becomes a clickable rect) — but it still had
 * no way to say "put the terminal on the left half and the browser on the right"
 * or even "which windows are open". Every screen-driving task that spans two apps
 * starts with that, and without it the daemon's only move is to click blindly at
 * a window it hopes is on top.
 *
 * PER LENS 25 (c54): the bridge was PROBED before any port path was believed.
 * There is no dependency to add and no helper to build — System Events over the
 * same `osascript -l JavaScript` bridge computer.ts already owns enumerates every
 * window's app/title/position/size, and `w.position = […]` / `w.size = […]` both
 * mutate and read back. Measured here, not assumed: 21 real windows across 12
 * apps, and a Calendar window moved 722,121 → 700,100 and restored.
 *
 * THE GEOMETRY TRAP, MEASURED (the whole reason this file is pure and tested):
 *
 *  • System Events window positions are TOP-LEFT origin — the same space as
 *    screenshots, OCR output and clicks. A maximized Chrome reports y=30, i.e.
 *    tucked under the 30pt menu bar. So no conversion is needed to move a window
 *    to a coordinate a screenshot showed. Good news, and worth stating, because
 *    the neighbouring API is the opposite:
 *  • `NSScreen.frame` / `visibleFrame` are BOTTOM-LEFT origin. On this machine
 *    frame = [0,0,3008,1692] and visibleFrame = [0,0,3008,1662] — the 30pt
 *    difference is the menu bar, but it sits at the BOTTOM of that rect's
 *    arithmetic and at the TOP of the screen. Read naively, "the usable area
 *    starts at y=0" and a maximized window gets shoved under the menu bar with
 *    30pt spilling off the bottom of the display. [visibleRectTopLeft] is the
 *    conversion, and its test asserts the MEASUREMENT: 1692 − (0 + 1662) = 30,
 *    the exact y a really-maximized Chrome window reports.
 *
 * That is the same silent-mismatch class as c54's OCR y-flip: nothing throws,
 * every number looks plausible, and the windows land in the wrong place.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'

const isMac = os.platform() === 'darwin'

/** A rect in whatever space its producer used. x,y is the ORIGIN corner. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One window. Geometry is NULLABLE on purpose: a window whose position or size
 * the Accessibility API refuses is still a window the user can see and the model
 * should know about, so it gets listed with "position unknown" rather than
 * dropped. Move/resize refuse it — a missing coordinate treated as 0 would fling
 * a window to the corner.
 */
export interface WindowInfo {
  app: string
  /** Index within its app's window list — how a mutation re-addresses it. */
  index: number
  title: string
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  minimized: boolean
  /** Whether the OWNING APP is frontmost — not "this window has key focus". */
  frontmost: boolean
}

/** A display, in NSScreen's own bottom-left coordinates. */
export interface ScreenInfo {
  frame: Rect
  /** Screen minus menu bar and dock — still bottom-left. */
  visible: Rect
}

// ── geometry ────────────────────────────────────────────────────────────────

/**
 * NSScreen's bottom-left `visibleFrame` → the top-left rect a window goes in.
 *
 * `primaryFrameHeight` is the height of the display whose frame origin is
 * (0,0) — the global flip axis, NOT this screen's own height. Getting that wrong
 * only shows up on a multi-display setup, where a secondary screen's windows
 * land off by the difference between the two heights.
 *
 * ⚠️ Honest limit: this machine has ONE display, so the single-screen case is
 * measured (see the file docblock) and the multi-display case is derived from
 * how AppKit defines the global space, not verified against hardware.
 */
export function visibleRectTopLeft(screen: ScreenInfo, primaryFrameHeight: number): Rect {
  const v = screen.visible
  return {
    x: Math.round(v.x),
    // The flip. `v.y` is the gap BELOW the usable area (the dock, if it's
    // bottom-docked); the gap ABOVE it (the menu bar) is whatever is left over.
    y: Math.round(primaryFrameHeight - (v.y + v.height)),
    width: Math.round(v.width),
    height: Math.round(v.height),
  }
}

/** The display that defines the global origin — the flip axis for every screen. */
export function primaryScreen(screens: ScreenInfo[]): ScreenInfo | null {
  if (!screens.length) return null
  return screens.find((s) => s.frame.x === 0 && s.frame.y === 0) ?? screens[0]
}

/** How much of `a` overlaps `b`, in square points. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Which display a window is on — by largest overlap, not by which corner its
 * origin falls in. A window dragged halfway across a seam belongs to the screen
 * showing MOST of it; snapping it to the one holding its top-left pixel would
 * yank it back across the boundary the user just dragged it over.
 *
 * Screens are compared in their TOP-LEFT form, so callers pass the converted
 * rects — mixing spaces here is the trap this whole file exists to avoid.
 */
export function pickScreenIndex(win: WindowInfo, usableRects: Rect[]): number {
  if (!usableRects.length) return -1
  if (win.x == null || win.y == null || win.width == null || win.height == null) return 0
  const r: Rect = { x: win.x, y: win.y, width: win.width, height: win.height }
  let best = 0
  let bestArea = -1
  for (let i = 0; i < usableRects.length; i++) {
    const area = overlapArea(r, usableRects[i])
    if (area > bestArea) {
      bestArea = area
      best = i
    }
  }
  return best
}

export type Snap =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'maximize'
  | 'center'
  | 'top_left'
  | 'top_right'
  | 'bottom_left'
  | 'bottom_right'

export const SNAPS: Snap[] = [
  'left',
  'right',
  'top',
  'bottom',
  'maximize',
  'center',
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
]

/**
 * Where a snap puts a window inside the usable area.
 *
 * Halves TILE EXACTLY: the second half is `total - first`, never a second
 * `round(total/2)`. On an odd 1663pt height two independent roundings give
 * 832 + 832 = 1664 — one pixel of overlap, which on a real screen is a 1px strip
 * of the bottom window peeking through the top one, or a 1px gap of desktop.
 * Cheap to get right, invisible until someone screenshots it.
 *
 * `center` is 4/5 of each axis rather than a fixed size: a "centred" window
 * sized in absolute points is either tiny on a 6K display or off-screen on a
 * laptop.
 */
export function snapRect(usable: Rect, snap: Snap): Rect {
  const { x, y, width: w, height: h } = usable
  const halfW = Math.round(w / 2)
  const halfH = Math.round(h / 2)
  const restW = w - halfW
  const restH = h - halfH
  switch (snap) {
    case 'left':
      return { x, y, width: halfW, height: h }
    case 'right':
      return { x: x + halfW, y, width: restW, height: h }
    case 'top':
      return { x, y, width: w, height: halfH }
    case 'bottom':
      return { x, y: y + halfH, width: w, height: restH }
    case 'top_left':
      return { x, y, width: halfW, height: halfH }
    case 'top_right':
      return { x: x + halfW, y, width: restW, height: halfH }
    case 'bottom_left':
      return { x, y: y + halfH, width: halfW, height: restH }
    case 'bottom_right':
      return { x: x + halfW, y: y + halfH, width: restW, height: restH }
    case 'center': {
      const cw = Math.round(w * 0.8)
      const ch = Math.round(h * 0.8)
      return { x: x + Math.round((w - cw) / 2), y: y + Math.round((h - ch) / 2), width: cw, height: ch }
    }
    case 'maximize':
    default:
      return { x, y, width: w, height: h }
  }
}

// ── selection ───────────────────────────────────────────────────────────────

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Pick the window a request means.
 *
 * Ranking, in order, each rule earning its place:
 *  1. An app-name filter is a HARD filter, not a preference — "the Chrome
 *     window" must never resolve to Safari just because Safari's title matched.
 *  2. A title substring is a hard filter for the same reason.
 *  3. Among survivors: non-minimized beats minimized (you cannot see, move or
 *     screenshot a minimized window, so it is almost never what was meant),
 *     then the frontmost app's window, then an exact title match over a partial,
 *     then the app's own window order.
 *
 * With NO filters this returns the frontmost app's first window — "the window
 * I'm looking at", which is what an unqualified `move_window` means.
 */
export function selectWindow(
  windows: WindowInfo[],
  sel?: { app?: string; text?: string },
): WindowInfo | null {
  const app = sel?.app ? norm(sel.app) : ''
  const text = sel?.text ? norm(sel.text) : ''
  let pool = windows
  if (app) pool = pool.filter((w) => norm(w.app).includes(app))
  if (text) pool = pool.filter((w) => norm(w.title).includes(text))
  if (!pool.length) return null
  const score = (w: WindowInfo): number => {
    let s = 0
    if (w.minimized) s += 8
    if (!w.frontmost) s += 4
    if (text && norm(w.title) !== text) s += 2
    return s
  }
  return [...pool].sort((a, b) => score(a) - score(b) || a.index - b.index)[0]
}

/** All windows matching a selector, best first — what `windows` lists. */
export function filterWindows(windows: WindowInfo[], sel?: { app?: string; text?: string }): WindowInfo[] {
  const app = sel?.app ? norm(sel.app) : ''
  const text = sel?.text ? norm(sel.text) : ''
  return windows.filter(
    (w) => (!app || norm(w.app).includes(app)) && (!text || norm(w.title).includes(text)),
  )
}

// ── the JXA bridge ──────────────────────────────────────────────────────────

/**
 * Enumerate every window, plus the displays.
 *
 * EVERY accessor is individually try/caught, and that is not defensive
 * boilerplate — it is the measured shape of this API. The obvious form,
 * `applicationProcesses.whose({visible: true})`, throws `-1728 Can't get
 * object` outright, and among 12 running apps several refuse `visible()`,
 * `windows()` or a per-window `name()` while their neighbours answer fine. One
 * unguarded read means ZERO windows returned, which reads as "nothing is open".
 * Guarded, the same machine returns 21.
 *
 * `AXMinimized` is read as an attribute rather than trusted to exist: not every
 * window exposes it, and a missing attribute is not a minimized window.
 */
function listScript(): string {
  return `
ObjC.import('AppKit');
var se = Application('System Events');
var out = [];
var procs = [];
try { procs = se.applicationProcesses(); } catch (e) { procs = []; }
for (var i = 0; i < procs.length; i++) {
  var p = procs[i], pname = null, front = false;
  try { pname = p.name(); } catch (e) { continue; }
  try { if (!p.visible()) continue; } catch (e) {}
  try { front = !!p.frontmost(); } catch (e) {}
  var wins = [];
  try { wins = p.windows(); } catch (e) { continue; }
  for (var j = 0; j < wins.length; j++) {
    var w = wins[j], rec = { app: pname, index: j, frontmost: front, minimized: false };
    try { rec.title = w.name(); } catch (e) { rec.title = ''; }
    try { var pos = w.position(); rec.x = pos[0]; rec.y = pos[1]; } catch (e) {}
    try { var sz = w.size(); rec.width = sz[0]; rec.height = sz[1]; } catch (e) {}
    try { rec.minimized = !!w.attributes.byName('AXMinimized').value(); } catch (e) {}
    out.push(rec);
  }
}
var screens = [];
try {
  var arr = $.NSScreen.screens;
  for (var k = 0; k < arr.count; k++) {
    var s = arr.objectAtIndex(k), f = s.frame, v = s.visibleFrame;
    screens.push({
      frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height },
      visible: { x: v.origin.x, y: v.origin.y, width: v.size.width, height: v.size.height }
    });
  }
} catch (e) {}
JSON.stringify({ ok: true, windows: out, screens: screens })
`
}

/**
 * Mutate one window, then READ THE RESULT BACK.
 *
 * The read-back is the point, not a nicety. Setting a position on a window that
 * won't take it (a fixed-size dialog, a full-screen space, an app that clamps)
 * raises NOTHING — you get a success with the window exactly where it was. The
 * only way to know a move happened is to look, so this returns the post-state
 * and the caller reports what the window actually did.
 *
 * Un-minimizing first is ordered deliberately: a minimized window accepts a
 * position and quietly keeps it in the dock, so restoring has to come before
 * geometry or the move lands on something invisible.
 */
function mutateScript(
  app: string,
  index: number,
  ops: { x?: number; y?: number; width?: number; height?: number; focus?: boolean },
): string {
  const lines: string[] = []
  if (ops.focus) {
    lines.push(`try { w.attributes.byName('AXMinimized').value = false; } catch (e) {}`)
  }
  if (ops.x != null && ops.y != null) {
    lines.push(`try { w.position = [${ops.x}, ${ops.y}]; } catch (e) { errs.push('position: ' + e.message); }`)
  }
  if (ops.width != null && ops.height != null) {
    lines.push(`try { w.size = [${ops.width}, ${ops.height}]; } catch (e) { errs.push('size: ' + e.message); }`)
  }
  if (ops.focus) {
    // AXRaise orders the window within its own app; `frontmost` brings the app
    // itself forward. Neither alone focuses a background app's back window.
    lines.push(`try { w.actions.byName('AXRaise').perform(); } catch (e) { errs.push('raise: ' + e.message); }`)
    lines.push(`try { p.frontmost = true; } catch (e) { errs.push('activate: ' + e.message); }`)
  }
  return `
var se = Application('System Events');
var errs = [];
var p = se.applicationProcesses.byName(${JSON.stringify(app)});
var w = p.windows()[${index}];
if (!w) { JSON.stringify({ ok: false, error: 'window ${index} of ' + ${JSON.stringify(app)} + ' is gone' }) } else {
${lines.join('\n')}
delay(0.05);
var after = { app: ${JSON.stringify(app)}, index: ${index}, title: '', minimized: false };
try { after.title = w.name(); } catch (e) {}
try { var pos = w.position(); after.x = pos[0]; after.y = pos[1]; } catch (e) {}
try { var sz = w.size(); after.width = sz[0]; after.height = sz[1]; } catch (e) {}
try { after.minimized = !!w.attributes.byName('AXMinimized').value(); } catch (e) {}
try { after.frontmost = !!p.frontmost(); } catch (e) {}
JSON.stringify({ ok: true, errors: errs, window: after })
}
`
}

/** A number that is actually a number — see parseOcrPayload for the same guard. */
function num(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

/**
 * Tolerant reader for the enumeration payload.
 *
 * A window with no usable title is KEPT (many tool palettes and panels are
 * untitled, and they're still windows you might want to move) but one with no
 * app name is dropped — without it there is nothing to address the window by, so
 * it could be listed and never acted on.
 */
export function parseWindowPayload(raw: string): { ok: boolean; windows: WindowInfo[]; screens: ScreenInfo[] } {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, windows: [], screens: [] }
  }
  const windows: WindowInfo[] = []
  for (const w of Array.isArray(parsed?.windows) ? parsed.windows : []) {
    const app = typeof w?.app === 'string' ? w.app.trim() : ''
    if (!app) continue
    const idx = num(w?.index)
    windows.push({
      app,
      index: idx ?? 0,
      title: typeof w?.title === 'string' ? w.title : '',
      x: num(w?.x),
      y: num(w?.y),
      width: num(w?.width),
      height: num(w?.height),
      minimized: w?.minimized === true,
      frontmost: w?.frontmost === true,
    })
  }
  const screens: ScreenInfo[] = []
  for (const s of Array.isArray(parsed?.screens) ? parsed.screens : []) {
    const f = readRect(s?.frame)
    const v = readRect(s?.visible)
    // A screen missing either rect can't be snapped INTO, and guessing one from
    // the other would silently reintroduce the menu-bar bug this file fixes.
    if (f && v) screens.push({ frame: f, visible: v })
  }
  return { ok: parsed?.ok === true, windows, screens }
}

function readRect(r: any): Rect | null {
  const vals = [r?.x, r?.y, r?.width, r?.height]
  if (vals.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
  return { x: vals[0], y: vals[1], width: vals[2], height: vals[3] }
}

/** Parse the mutation payload — same tolerance, and `errors` is surfaced. */
export function parseMutatePayload(raw: string): { ok: boolean; error?: string; errors: string[]; window: WindowInfo | null } {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'unreadable response', errors: [], window: null }
  }
  const errors = (Array.isArray(parsed?.errors) ? parsed.errors : []).map((e: any) => String(e))
  const w = parsed?.window
  const window: WindowInfo | null =
    w && typeof w?.app === 'string'
      ? {
          app: w.app,
          index: num(w.index) ?? 0,
          title: typeof w.title === 'string' ? w.title : '',
          x: num(w.x),
          y: num(w.y),
          width: num(w.width),
          height: num(w.height),
          minimized: w.minimized === true,
          frontmost: w.frontmost === true,
        }
      : null
  return { ok: parsed?.ok === true, error: parsed?.error ? String(parsed.error) : undefined, errors, window }
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Cap on listed windows — a busy Mac has dozens across a dozen apps. */
export const WINDOW_LIST_LIMIT = 40

/** `1024×768 @ 244,34` — or an honest "position unknown". */
export function describeGeometry(w: WindowInfo): string {
  if (w.width == null || w.height == null || w.x == null || w.y == null) return 'geometry unavailable'
  return `${w.width}×${w.height} @ ${w.x},${w.y}`
}

/**
 * Render the window list.
 *
 * Truncation is REPORTED for the same reason as OCR's (formatTextLines): a model
 * told "12 windows" that sees 12 of 40 will confidently conclude the one it
 * wants isn't open. The app name comes first because that is the handle a
 * follow-up call uses.
 */
export function formatWindows(windows: WindowInfo[], limit = WINDOW_LIST_LIMIT): string {
  if (!windows.length) return 'no windows found'
  const shown = windows.slice(0, limit)
  const body = shown
    .map((w) => {
      const flags = [w.frontmost ? 'front' : '', w.minimized ? 'minimized' : ''].filter(Boolean).join(', ')
      const title = w.title ? ` "${w.title}"` : ' (untitled)'
      return `- ${w.app}[${w.index}]${title} — ${describeGeometry(w)}${flags ? ` [${flags}]` : ''}`
    })
    .join('\n')
  const more = windows.length > shown.length ? `\n… ${windows.length - shown.length} more not shown` : ''
  return `${windows.length} window${windows.length === 1 ? '' : 's'}:\n${body}${more}`
}

/**
 * Did the window end up where we asked? Reported, never assumed.
 *
 * A 2pt tolerance, because apps LEGITIMATELY adjust: a terminal snaps to
 * character cells, some windows enforce a minimum size. That is a different
 * answer from "the move did nothing", and the caller says which happened instead
 * of claiming success either way.
 */
export function describeOutcome(want: Partial<Rect>, got: WindowInfo | null): string {
  if (!got) return 'window vanished before it could be read back'
  const off: string[] = []
  const near = (a: number | null, b: number | undefined) =>
    b == null || (a != null && Math.abs(a - b) <= 2)
  if (!near(got.x, want.x)) off.push(`x ${got.x} (asked ${want.x})`)
  if (!near(got.y, want.y)) off.push(`y ${got.y} (asked ${want.y})`)
  if (!near(got.width, want.width)) off.push(`width ${got.width} (asked ${want.width})`)
  if (!near(got.height, want.height)) off.push(`height ${got.height} (asked ${want.height})`)
  if (!off.length) return `now ${describeGeometry(got)}`
  return `now ${describeGeometry(got)} — the app adjusted: ${off.join(', ')}`
}

// ── spawn ───────────────────────────────────────────────────────────────────

function osa(script: string, timeoutMs: number): string {
  try {
    return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e)
    if (/not allowed|assistive|accessibility|-1743/i.test(msg)) {
      throw new Error(
        'macOS blocked window access — grant Accessibility to your terminal in System Settings › Privacy & Security › Accessibility',
      )
    }
    throw new Error(`window query failed: ${msg.slice(0, 300)}`)
  }
}

export function listWindows(): { windows: WindowInfo[]; screens: ScreenInfo[] } {
  if (!isMac) throw new Error('window management needs macOS (System Events)')
  // 30s: enumerating a dozen apps' windows over Apple Events is slow, and an app
  // that's beachballing makes its own read hang until this timeout.
  const res = parseWindowPayload(osa(listScript(), 30_000))
  if (!res.ok) throw new Error('System Events returned no window list')
  return { windows: res.windows, screens: res.screens }
}

export function mutateWindow(
  app: string,
  index: number,
  ops: { x?: number; y?: number; width?: number; height?: number; focus?: boolean },
): { errors: string[]; window: WindowInfo | null; error?: string } {
  if (!isMac) throw new Error('window management needs macOS (System Events)')
  const res = parseMutatePayload(osa(mutateScript(app, index, ops), 20_000))
  if (!res.ok) throw new Error(res.error || 'window mutation returned nothing readable')
  return { errors: res.errors, window: res.window }
}

/**
 * Can this machine arrange its own windows?
 *
 * Gated on osascript, NOT on screencapture like hasComputerControl — they are
 * genuinely different capabilities on the same tool: a machine could in
 * principle screenshot without Apple Events, and window management needs the
 * bridge rather than the camera. Both also need the Accessibility grant, which
 * cannot be probed without triggering the prompt, so a refusal is REPORTED by
 * the tool (osa() maps -1743 to the grant instructions) rather than predicted
 * here — claiming the capability is absent when it's merely ungranted would stop
 * a remote agent from ever asking.
 */
export function hasWindowControl(): boolean {
  return isMac && fs.existsSync('/usr/bin/osascript')
}

/**
 * The usable rect a window should be snapped into, in top-left coordinates.
 *
 * Joins the two halves this file keeps apart: pick the display the window mostly
 * lives on, then convert THAT display's visibleFrame out of bottom-left. Returns
 * null when there are no screens to reason about (a headless session), because a
 * fabricated fallback rect would move windows onto a display that isn't there.
 */
export function usableRectFor(win: WindowInfo, screens: ScreenInfo[]): Rect | null {
  const primary = primaryScreen(screens)
  if (!primary) return null
  const rects = screens.map((s) => visibleRectTopLeft(s, primary.frame.height))
  const i = pickScreenIndex(win, rects)
  return i >= 0 ? rects[i] : null
}
