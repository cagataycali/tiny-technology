/**
 * use_computer — mouse, keyboard, and screenshots on this Mac.
 *
 * DevDuck's tools/use_computer.py ported to TypeScript. Python leaned on
 * pyautogui; there is no equivalent for Node that doesn't need a native build,
 * so this drives the same OS APIs pyautogui does, through two shells:
 *   input       JXA (osascript -l JavaScript) → CoreGraphics CGEvent*
 *   screenshots /usr/sbin/screencapture + sips
 * Both ship with macOS, so `npx tiny-tech` stays install-free.
 *
 * COORDINATE FIDELITY — the whole reason this tool is usable on a Retina Mac:
 * CGEvent taps take *logical points* (3008×1692 here), while screencapture
 * writes *physical pixels* (6016×3384). A model reading a raw screenshot would
 * see a button at (2400, 1200) and click twice as far down-right as it meant
 * to. So every screenshot is resampled to the logical width, making the pixel
 * the model measures identical to the point a click consumes.
 *
 * Screenshots return a Strands ImageBlock — `{ image: { format, source: {
 * bytes } } }` — which the SDK turns into real multimodal content, not a file
 * path the model has to trust. That's what makes look → click → verify work.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { recognizeText, linesToText, matchLines, hasVisionOcr, type TextLine } from './vision.js'
import {
  listWindows,
  mutateWindow,
  selectWindow,
  filterWindows,
  formatWindows,
  describeGeometry,
  describeOutcome,
  snapRect,
  usableRectFor,
  SNAPS,
  type Snap,
} from './windows.js'

const isMac = os.platform() === 'darwin'

// Screenshots get resampled to logical points; a wide desktop would still
// blow past model image limits, so cap the long edge too.
const MAX_IMAGE_WIDTH = 1600

// ── JXA bridge ──────────────────────────────────────────────────────────────

/**
 * CoreGraphics prelude. Every CGEvent* symbol JXA touches must be declared
 * with an explicit signature — ObjC.bindFunction cannot infer C prototypes.
 *
 * Every CGPoint MUST use the field-named encoding '{CGPoint="x"d"y"d}'. The
 * bare '{CGPoint=dd}' form binds without error and then silently marshals
 * {x:1500,y:800} as 0,0 — clicks land in the top-left corner instead of
 * failing, which is far worse than an exception. It breaks returns the same
 * way (y dropped entirely). NSEvent.mouseLocation is separately unusable here:
 * it yields NaN through osascript. CGEventGetLocation is already top-left
 * origin, matching screenshots and click coordinates — no flip needed.
 */
const JXA_PRELUDE = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit'); ObjC.import('Foundation');
ObjC.bindFunction('CGEventCreateMouseEvent', ['void*', ['void*','uint32','{CGPoint="x"d"y"d}','uint32']]);
ObjC.bindFunction('CGEventCreate', ['void*', ['void*']]);
ObjC.bindFunction('CGEventGetLocation', ['{CGPoint="x"d"y"d}', ['void*']]);
ObjC.bindFunction('CGEventCreateScrollWheelEvent', ['void*', ['void*','uint32','uint32','int32','int32']]);
ObjC.bindFunction('CGEventCreateKeyboardEvent', ['void*', ['void*','uint16','bool']]);
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*','uint32','void*']]);
ObjC.bindFunction('CGEventSetFlags', ['void', ['void*','uint64']]);
ObjC.bindFunction('CGEventPost', ['void', ['uint32','void*']]);
ObjC.bindFunction('CGWarpMouseCursorPosition', ['int', ['{CGPoint="x"d"y"d}']]);
ObjC.bindFunction('CGAssociateMouseAndMouseCursorPosition', ['int', ['bool']]);

var TAP = 0; // kCGHIDEventTap
var LEFT_DOWN=1, LEFT_UP=2, RIGHT_DOWN=3, RIGHT_UP=4, MOVED=5, LEFT_DRAG=6, OTHER_DOWN=25, OTHER_UP=26;
var BTN_LEFT=0, BTN_RIGHT=1, BTN_CENTER=2;

// Modifier masks (CGEventFlags)
var FLAGS = { shift: 0x20000, ctrl: 0x40000, control: 0x40000, alt: 0x80000,
              option: 0x80000, opt: 0x80000, cmd: 0x100000, command: 0x100000,
              fn: 0x800000 };

function screenSize() {
  var f = $.NSScreen.mainScreen.frame;
  return { w: Math.round(f.size.width), h: Math.round(f.size.height) };
}
function mousePos() {
  var p = $.CGEventGetLocation($.CGEventCreate($()));
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
function post(ev) { $.CGEventPost(TAP, ev); }
function moveTo(x, y) {
  $.CGWarpMouseCursorPosition({ x: x, y: y });
  // Warp alone can leave the cursor logically detached until the next real
  // move; re-associating keeps hover states in sync.
  $.CGAssociateMouseAndMouseCursorPosition(true);
  post($.CGEventCreateMouseEvent($(), MOVED, { x: x, y: y }, BTN_LEFT));
}
function clickAt(x, y, button, count) {
  var down = button === 'right' ? RIGHT_DOWN : button === 'middle' ? OTHER_DOWN : LEFT_DOWN;
  var up   = button === 'right' ? RIGHT_UP   : button === 'middle' ? OTHER_UP   : LEFT_UP;
  var btn  = button === 'right' ? BTN_RIGHT  : button === 'middle' ? BTN_CENTER : BTN_LEFT;
  moveTo(x, y);
  delay(0.05);
  for (var i = 1; i <= (count || 1); i++) {
    var d = $.CGEventCreateMouseEvent($(), down, { x: x, y: y }, btn);
    var u = $.CGEventCreateMouseEvent($(), up,   { x: x, y: y }, btn);
    // clickState carries the double/triple-click count (field 1 = kCGMouseEventClickState)
    if (i > 1) { $.CGEventSetIntegerValueField(d, 1, i); $.CGEventSetIntegerValueField(u, 1, i); }
    post(d); delay(0.02); post(u);
    if (i < (count || 1)) delay(0.06);
  }
}
/**
 * Release every modifier key. A modifier left held down — by us, or by a
 * physical key the user was holding — turns the next keystroke into a chord,
 * so input hygiene is cheap insurance before typing.
 */
function clearModifiers() {
  var MODS = [55, 56, 58, 59, 60, 61, 62, 63]; // cmd, shift, opt, ctrl, rshift, ropt, rctrl, fn
  for (var i = 0; i < MODS.length; i++) {
    var e = $.CGEventCreateKeyboardEvent($(), MODS[i], false);
    $.CGEventSetFlags(e, 0);
    post(e);
  }
}

/**
 * Type a string as a unicode payload rather than virtual keycodes — layout
 * independent, and accents/emoji survive. The UTF-16 bytes must come from
 * NSData: a JXA Ref('uint16[1]') is rejected outright ("Ref has incompatible
 * type") and any uint16* signature fails the same way, so NSString →
 * dataUsingEncoding(10) (UTF16-LE) → .bytes is the only buffer JXA will hand
 * across. Length is in UTF-16 code units, so surrogate pairs (emoji) work.
 */
function typeText(s, interval) {
  clearModifiers();
  var chunks = interval ? s.split('') : [s];
  for (var i = 0; i < chunks.length; i++) {
    var data = $.NSString.alloc.initWithString(chunks[i]).dataUsingEncoding(10);
    var n = data.length / 2;
    var down = $.CGEventCreateKeyboardEvent($(), 0, true);
    $.CGEventKeyboardSetUnicodeString(down, n, data.bytes);
    var up = $.CGEventCreateKeyboardEvent($(), 0, false);
    $.CGEventKeyboardSetUnicodeString(up, n, data.bytes);
    post(down); post(up);
    if (interval) delay(interval);
  }
}
/**
 * A modified keystroke has to press and RELEASE the real modifier keys around
 * it, not just stamp CGEventFlags on the character event. Setting flags alone
 * leaves the modifier latched in the system's flag state: the next plain 'tab'
 * arrives as Cmd+Tab and silently switches apps mid-sequence, so the rest of a
 * form gets typed into another application.
 */
function keyStroke(code, flagMask, modCodes) {
  modCodes = modCodes || [];
  for (var i = 0; i < modCodes.length; i++) {
    var md = $.CGEventCreateKeyboardEvent($(), modCodes[i], true);
    $.CGEventSetFlags(md, flagMask); post(md); delay(0.01);
  }
  var down = $.CGEventCreateKeyboardEvent($(), code, true);
  var up = $.CGEventCreateKeyboardEvent($(), code, false);
  if (flagMask) { $.CGEventSetFlags(down, flagMask); $.CGEventSetFlags(up, flagMask); }
  post(down); delay(0.02); post(up); delay(0.01);
  for (var j = modCodes.length - 1; j >= 0; j--) {
    var mu = $.CGEventCreateKeyboardEvent($(), modCodes[j], false);
    $.CGEventSetFlags(mu, 0); post(mu); delay(0.01);
  }
}
`

/** Virtual keycodes for keys that have no useful unicode form. */
const KEYCODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, forwarddelete: 117, help: 114, home: 115, end: 119,
  pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
  q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35,
  l: 37, j: 38, k: 40, n: 45, m: 46,
  '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28,
  '9': 25, '0': 29, '-': 27, '=': 24, '[': 33, ']': 30, ';': 41, "'": 39,
  ',': 43, '.': 47, '/': 44, '\\': 42, '`': 50,
}

const MODIFIER_MASKS: Record<string, number> = {
  shift: 0x20000, ctrl: 0x40000, control: 0x40000, alt: 0x80000,
  option: 0x80000, opt: 0x80000, cmd: 0x100000, command: 0x100000,
  super: 0x100000, meta: 0x100000, fn: 0x800000,
}

/** Virtual keycodes for the modifier keys themselves — they must be pressed
 *  and released, not just flagged. See keyStroke() in the prelude. */
const MODIFIER_KEYCODES: Record<string, number> = {
  shift: 56, ctrl: 59, control: 59, alt: 58, option: 58, opt: 58,
  cmd: 55, command: 55, super: 55, meta: 55, fn: 63,
}

/** Resolve modifier names to [flag mask, deduped keycodes]. */
function resolveModifiers(names: string[]): { mask: number; codes: number[] } {
  let mask = 0
  const codes: number[] = []
  for (const n of names) {
    const k = n.toLowerCase()
    const m = MODIFIER_MASKS[k]
    if (!m) continue
    mask |= m
    const c = MODIFIER_KEYCODES[k]
    if (c != null && !codes.includes(c)) codes.push(c)
  }
  return { mask, codes }
}

function jxa(body: string, timeoutMs = 30_000): string {
  try {
    return execFileSync('osascript', ['-l', 'JavaScript', '-e', JXA_PRELUDE + body], {
      encoding: 'utf-8',
      timeout: timeoutMs,
    }).trim()
  } catch (e: any) {
    const err = String(e?.stderr || e?.message || e)
    // The one failure everybody hits: the host app lacks Accessibility rights,
    // so CGEvent posts are silently dropped or osascript is refused outright.
    if (/not allowed|assistive|accessibility|-1743/i.test(err)) {
      throw new Error(
        'macOS denied input control — grant Accessibility to your terminal in ' +
          'System Settings › Privacy & Security › Accessibility, then retry',
      )
    }
    throw new Error(err.slice(0, 400))
  }
}

/** Logical screen size in points (what click coordinates are measured in). */
export function screenSize(): { width: number; height: number } {
  const out = jxa('var s = screenSize(); JSON.stringify(s)', 10_000)
  const { w, h } = JSON.parse(out)
  return { width: w, height: h }
}

/** Current cursor position in screen points, top-left origin. */
export function mousePosition(): { x: number; y: number } {
  const out = jxa('var p = mousePos(); JSON.stringify(p)', 10_000)
  const { x, y } = JSON.parse(out)
  // Struct unmarshalling through osascript is fragile enough that a silent NaN
  // is a real failure mode — surface it instead of reporting it as a location.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`could not read cursor position (got ${x},${y})`)
  }
  return { x, y }
}

// ── screenshots ─────────────────────────────────────────────────────────────

function pixelSize(file: string): { width: number; height: number } | null {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
      encoding: 'utf-8',
      timeout: 10_000,
    })
    const w = /pixelWidth:\s*(\d+)/.exec(out)
    const h = /pixelHeight:\s*(\d+)/.exec(out)
    return w && h ? { width: Number(w[1]), height: Number(h[1]) } : null
  } catch {
    return null
  }
}

export interface ShotResult {
  path: string
  bytes: Buffer
  /** Image dimensions as delivered to the model. */
  width: number
  height: number
  /** Origin of the captured area, in logical points. */
  originX: number
  originY: number
  /** Multiply a coordinate measured in this image by this to get screen points. */
  scale: number
}

/**
 * Capture the screen (or a region) and normalize it to logical points.
 * `region` is [left, top, width, height] in logical points.
 */
export function capture(region?: number[], outPath?: string): ShotResult {
  const dir = join(os.homedir(), '.tiny', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  const file = outPath || join(dir, `shot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`)

  // -x silences the shutter sound; -o drops window shadows from region grabs.
  const args = ['-x', '-o', '-t', 'png']
  if (region && region.length === 4) args.push('-R', region.join(','))
  args.push(file)
  execFileSync('/usr/sbin/screencapture', args, { timeout: 30_000 })

  if (!fs.existsSync(file)) throw new Error('screencapture produced no file — screen-recording permission may be denied')

  const physical = pixelSize(file)
  const logical = region && region.length === 4 ? { width: region[2], height: region[3] } : screenSize()
  const target = Math.min(logical.width, MAX_IMAGE_WIDTH)

  if (physical && physical.width > target) {
    execFileSync('sips', ['--resampleWidth', String(target), file, '--out', file], {
      encoding: 'utf-8',
      timeout: 30_000,
    })
  }
  const finalSize = pixelSize(file) || logical
  return {
    path: file,
    bytes: fs.readFileSync(file),
    width: finalSize.width,
    height: finalSize.height,
    originX: region?.length === 4 ? region[0] : 0,
    originY: region?.length === 4 ? region[1] : 0,
    // Screens wider than MAX_IMAGE_WIDTH can't be delivered 1:1, so report the
    // residual factor instead of pretending it's 1 — callers convert with it.
    scale: finalSize.width ? logical.width / finalSize.width : 1,
  }
}

/** Strands image content block from PNG bytes. */
export function imageBlock(bytes: Buffer): any {
  return { image: { format: 'png', source: { bytes: bytes.toString('base64') } } }
}

/**
 * Geometry of the most recent screenshot, so coordinates read off that image
 * can be converted back to screen points by the tool instead of by the model.
 * Asking a model to multiply every coordinate by 1.88 is a reliable way to get
 * clicks in the wrong place.
 */
let lastShot: { originX: number; originY: number; scale: number } | null = null

/** Test seam: the transform is pure, but its input is module state. */
export function __setLastShotForTest(shot: typeof lastShot): void {
  lastShot = shot
}

/** Convert a point measured in the last screenshot into screen points. */
export function imageToScreen(x: number, y: number): { x: number; y: number } {
  if (!lastShot) return { x, y }
  return {
    x: Math.round(lastShot.originX + x * lastShot.scale),
    y: Math.round(lastShot.originY + y * lastShot.scale),
  }
}

// ── OCR ─────────────────────────────────────────────────────────────────────

/**
 * Capture, then read the text in what was captured — and register the shot so
 * the coordinates OCR reports are directly clickable.
 *
 * This is the join that makes on-device OCR worth having: `capture()` resamples
 * to logical points and records the residual `scale`/origin in `lastShot`, and
 * Vision's boxes are normalized, so scaling them by the DELIVERED image size
 * lands them in exactly the coordinate space `imageToScreen()` already converts
 * from. A caller can pass an OCR centre straight into `click` — no arithmetic on
 * either side, and region screenshots work for free.
 */
export function readScreenText(
  region?: number[],
  opts?: { fast?: boolean },
): { shot: ShotResult; lines: TextLine[] } {
  const shot = capture(region)
  lastShot = { originX: shot.originX, originY: shot.originY, scale: shot.scale }
  const lines = recognizeText(shot.path, shot.width, shot.height, { fast: opts?.fast })
  return { shot, lines }
}

/** Cap on lines rendered into a tool result — a dense screen OCRs to hundreds. */
export const OCR_LINE_LIMIT = 120

/**
 * Render matched lines with their clickable centres.
 *
 * Truncation is REPORTED, not silent: a model told "3 matches" that only sees 3
 * of 40 will click the wrong one confidently. Same reason the count comes first.
 */
export function formatTextLines(lines: TextLine[], limit = OCR_LINE_LIMIT): string {
  if (!lines.length) return 'no text found'
  const shown = lines.slice(0, limit)
  const body = shown
    .map((l) => `- "${l.text}" @ ${l.centerX},${l.centerY} (${l.width}×${l.height}, conf ${l.confidence.toFixed(2)})`)
    .join('\n')
  const more = lines.length > shown.length ? `\n… ${lines.length - shown.length} more not shown` : ''
  return `${lines.length} line${lines.length === 1 ? '' : 's'}:\n${body}${more}`
}

// ── the tool ────────────────────────────────────────────────────────────────

export function makeComputerTool() {
  return tool({
    name: 'use_computer',
    description: `🖥️ Control this Mac's screen, mouse and keyboard — look at the screen, then act on what you see.
Measure coordinates directly on the latest screenshot and pass those numbers: mouse actions
convert screenshot coordinates into screen coordinates themselves, including for region
screenshots. Never scale or offset coordinates yourself. Origin is top-left.

- screenshot (region=[left,top,width,height] optional) — returns the image itself as context
- read_screen (region optional) — on-device OCR: every line of text with a CLICKABLE centre
- find_text (text, regex=false, region optional) — where a label is; click its centre directly
- screen_size / mouse_position
- click (x, y, button=left|right|middle, clicks=1) / double_click (x, y) / right_click (x, y)
- move_mouse (x, y) / drag (x, y → to_x, to_y)
- scroll (direction=up|down|left|right, amount, x, y optional to scroll under a point)
- type (text, interval) — types into whatever is focused; click the field first
- key (key=enter|tab|escape|up|down|…, modifiers=["cmd"]) — one keystroke
- hotkey (keys=["cmd","c"]) — a chord
- open_app (app_name) — activate/launch an app; front_app — what's focused now
- windows (app, text optional) — every open window: app, title, size @ position
- focus_window (app, text optional) — raise a window and bring its app forward
- move_window (app, text optional, x, y) / resize_window (app, text optional, width, height)
- snap_window (app, text optional, snap=left|right|top|bottom|maximize|center|top_left|…)

Arranging the screen: list windows first to see what's open and how it's addressed
(app[index]), then snap_window to tile — snap fits the display's usable area, so it never
tucks a window under the menu bar. Two apps side by side is snap left + snap right. A window
is picked by app name plus an optional title substring; with neither, the frontmost one.
Moves are READ BACK, so the result says where the window actually ended up — apps are allowed
to refuse or adjust a size, and a dialog may not move at all.

Filling a form: screenshot → click the field → type → key tab → … → screenshot to verify.
Prefer find_text over eyeballing a screenshot when you're after a labelled control ("Sign In",
"Save") — it runs locally on the Neural Engine, costs no tokens, and returns the exact centre
to click, so it doesn't miss by a few pixels the way reading an image does. read_screen is the
cheap way to answer "what does it say" without spending an image.
Prefer keyboard navigation (tab/enter) over clicking when the layout allows it: it survives
layout shifts that coordinates don't. Take a fresh screenshot after anything that changes
the screen — never click from a stale one.`,
    inputSchema: z.object({
      action: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      to_x: z.number().optional(),
      to_y: z.number().optional(),
      text: z.string().optional(),
      key: z.string().optional(),
      keys: z.array(z.string()).optional(),
      modifiers: z.array(z.string()).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      clicks: z.number().optional(),
      amount: z.number().optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      interval: z.number().optional(),
      region: z.array(z.number()).optional(),
      app_name: z.string().optional(),
      output_path: z.string().optional(),
      regex: z.boolean().optional(),
      fast: z.boolean().optional(),
      // Window selection + geometry. `app` is separate from `app_name` (which
      // open_app uses to LAUNCH something) so a model can't half-match one
      // action's argument into another's.
      app: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      snap: z.string().optional(),
    }),
    callback: async (a) => {
      if (!isMac) return 'use_computer needs macOS (CoreGraphics + screencapture)'
      const needXY = (): string | null =>
        a.x == null || a.y == null ? `need x + y for ${a.action}` : null

      try {
        switch (a.action) {
          case 'screenshot': {
            const shot = capture(a.region, a.output_path)
            lastShot = { originX: shot.originX, originY: shot.originY, scale: shot.scale }
            const scope = a.region ? `region ${a.region.join(',')}` : 'full screen'
            const exact = Math.abs(shot.scale - 1) < 0.001 && !shot.originX && !shot.originY
            return [
              {
                text:
                  `🖥️ ${scope} — image is ${shot.width}×${shot.height}\n` +
                  (exact
                    ? 'Read coordinates straight off this image: they are already screen coordinates.'
                    : 'Read coordinates off THIS IMAGE and pass them as-is — click/move/drag/scroll ' +
                      'convert them to screen points for you. Do not scale them yourself.') +
                  `\nSaved: ${shot.path}`,
              },
              imageBlock(shot.bytes),
            ]
          }

          case 'read_screen':
          case 'ocr': {
            if (!hasVisionOcr()) return 'on-device OCR needs macOS (Vision framework)'
            const { shot, lines } = readScreenText(a.region, { fast: a.fast })
            const scope = a.region ? `region ${a.region.join(',')}` : 'full screen'
            // The coordinates are already screen-clickable (readScreenText
            // registers the shot), so say so — otherwise a model that knows
            // about the Retina scaling will helpfully "correct" them.
            return (
              `👁️ ${scope}, ${shot.width}×${shot.height} — read on-device (no image spent)\n` +
              `Coordinates below are ready to pass to click/move_mouse as-is.\n\n` +
              formatTextLines(lines)
            )
          }

          case 'find_text': {
            if (!hasVisionOcr()) return 'on-device OCR needs macOS (Vision framework)'
            const needle = a.text || a.key
            if (!needle) return 'need text to find, e.g. {action:"find_text", text:"Sign In"}'
            const { lines } = readScreenText(a.region, { fast: a.fast })
            const hits = matchLines(lines, needle, { regex: a.regex })
            if (!hits.length) {
              // A miss must not read as "the text isn't on screen" when it might
              // be "OCR read it differently" — hand back the size of the haystack
              // so the model can fall back to read_screen instead of retrying.
              return `🔍 no match for ${JSON.stringify(needle)} among ${lines.length} recognized line${lines.length === 1 ? '' : 's'} — try action:'read_screen' to see what the text actually says`
            }
            const best = hits[0]
            return (
              `🔍 best match "${best.text}" — click ${best.centerX},${best.centerY}\n` +
              formatTextLines(hits)
            )
          }

          case 'screen_size': {
            const s = screenSize()
            return `🖥️ screen: ${s.width}×${s.height} logical points`
          }
          case 'mouse_position': {
            const p = mousePosition()
            return `🖱️ mouse at ${p.x},${p.y} (screen points, top-left origin)`
          }

          case 'click':
          case 'double_click':
          case 'right_click':
          case 'middle_click': {
            const bad = needXY()
            if (bad) return bad
            const p = imageToScreen(a.x!, a.y!)
            const button =
              a.action === 'right_click' ? 'right' : a.action === 'middle_click' ? 'middle' : a.button || 'left'
            const count = a.action === 'double_click' ? 2 : Math.max(1, a.clicks ?? 1)
            jxa(`clickAt(${p.x}, ${p.y}, ${JSON.stringify(button)}, ${count})`)
            return `🖱️ ${count > 1 ? `${count}× ` : ''}${button} click at ${p.x},${p.y}`
          }

          case 'move_mouse': {
            const bad = needXY()
            if (bad) return bad
            const p = imageToScreen(a.x!, a.y!)
            jxa(`moveTo(${p.x}, ${p.y})`)
            return `🖱️ moved to ${p.x},${p.y}`
          }

          case 'drag': {
            const bad = needXY()
            if (bad) return bad
            if (a.to_x == null || a.to_y == null) return 'need to_x + to_y for drag'
            const from = imageToScreen(a.x!, a.y!)
            const to = imageToScreen(a.to_x, a.to_y)
            // Interpolated intermediate moves — apps that track drag deltas
            // ignore a single teleporting event.
            jxa(`
              moveTo(${from.x}, ${from.y}); delay(0.1);
              post($.CGEventCreateMouseEvent($(), LEFT_DOWN, {x:${from.x}, y:${from.y}}, BTN_LEFT)); delay(0.1);
              var steps = 20;
              for (var i = 1; i <= steps; i++) {
                var nx = ${from.x} + (${to.x} - ${from.x}) * i / steps;
                var ny = ${from.y} + (${to.y} - ${from.y}) * i / steps;
                post($.CGEventCreateMouseEvent($(), LEFT_DRAG, {x:nx, y:ny}, BTN_LEFT));
                delay(0.01);
              }
              delay(0.1);
              post($.CGEventCreateMouseEvent($(), LEFT_UP, {x:${to.x}, y:${to.y}}, BTN_LEFT));
            `)
            return `🖱️ dragged ${from.x},${from.y} → ${to.x},${to.y}`
          }

          case 'scroll': {
            const dir = a.direction || 'down'
            const amount = Math.max(1, a.amount ?? 3)
            const p = a.x != null && a.y != null ? imageToScreen(a.x, a.y) : null
            const at = p ? `moveTo(${p.x}, ${p.y}); delay(0.05);` : ''
            // Unit 1 = kCGScrollEventUnitLine, so `amount` is wheel clicks the
            // way pyautogui counts them. Unit 0 (pixel) makes amount=10 scroll
            // ten *pixels*, which reads as "scroll silently did nothing".
            // Axes are (vertical, horizontal); positive is up/left.
            const v = dir === 'up' ? amount : dir === 'down' ? -amount : 0
            const h = dir === 'left' ? amount : dir === 'right' ? -amount : 0
            jxa(`${at} post($.CGEventCreateScrollWheelEvent($(), 1, 2, ${v}, ${h}));`)
            return `🖱️ scrolled ${dir} ${amount}${a.x != null ? ` at ${a.x},${a.y}` : ''}`
          }

          case 'type': {
            if (!a.text) return 'need text'
            const interval = Math.min(Math.max(a.interval ?? 0, 0), 1)
            jxa(`typeText(${JSON.stringify(a.text)}, ${interval})`, 120_000)
            return `⌨️ typed ${a.text.length} chars${a.text.length <= 80 ? `: ${a.text}` : ''}`
          }

          case 'key':
          case 'key_press': {
            if (!a.key) return `need key (e.g. enter, tab, escape, up) — available: ${Object.keys(KEYCODES).slice(0, 24).join(', ')}…`
            const code = KEYCODES[a.key.toLowerCase()]
            if (code == null) return `unknown key: ${a.key}`
            const { mask, codes } = resolveModifiers(a.modifiers || [])
            jxa(`keyStroke(${code}, ${mask}, ${JSON.stringify(codes)})`)
            const pretty = [...(a.modifiers || []), a.key].join('+')
            return `⌨️ ${pretty}`
          }

          case 'hotkey': {
            if (!a.keys?.length) return 'need keys, e.g. ["cmd","c"]'
            const mods = a.keys.filter((k) => MODIFIER_MASKS[k.toLowerCase()] != null)
            const plain = a.keys.filter((k) => MODIFIER_MASKS[k.toLowerCase()] == null)
            if (plain.length !== 1) return 'hotkey needs exactly one non-modifier key, e.g. ["cmd","shift","4"]'
            const code = KEYCODES[plain[0].toLowerCase()]
            if (code == null) return `unknown key: ${plain[0]}`
            const { mask, codes } = resolveModifiers(mods)
            jxa(`keyStroke(${code}, ${mask}, ${JSON.stringify(codes)})`)
            return `⌨️ ${a.keys.join('+')}`
          }

          case 'open_app': {
            if (!a.app_name) return 'need app_name'
            // `open -a` launches or activates; more reliable than Spotlight typing.
            execFileSync('open', ['-a', a.app_name], { timeout: 20_000 })
            return `🚀 activated ${a.app_name}`
          }
          case 'front_app':
            return `🪟 front app: ${jxa(
              `var se = Application('System Events'); se.applicationProcesses.whose({frontmost: true})[0].name()`,
              15_000,
            )}`

          // ── windows ──────────────────────────────────────────────────────
          case 'windows':
          case 'list_windows': {
            const { windows } = listWindows()
            const sel = { app: a.app, text: a.text }
            const hits = filterWindows(windows, sel)
            // When a filter matched nothing, say what IS open rather than just
            // "no windows found" — the app name is usually slightly off ("chrome
            // canary", "Code" vs "Visual Studio Code") and the list is the fix.
            if (!hits.length && (a.app || a.text)) {
              const apps = [...new Set(windows.map((w) => w.app))].sort()
              return `🪟 no window matched${a.app ? ` app "${a.app}"` : ''}${
                a.text ? ` title "${a.text}"` : ''
              }. Apps with windows: ${apps.join(', ') || 'none'}`
            }
            return `🪟 ${formatWindows(hits)}`
          }

          case 'focus_window':
          case 'move_window':
          case 'resize_window':
          case 'snap_window': {
            const { windows, screens } = listWindows()
            const win = selectWindow(windows, { app: a.app, text: a.text })
            if (!win) {
              const apps = [...new Set(windows.map((w) => w.app))].sort()
              return `no window matched${a.app ? ` app "${a.app}"` : ''}${
                a.text ? ` title "${a.text}"` : ''
              }. Apps with windows: ${apps.join(', ') || 'none'}`
            }
            const label = `${win.app}[${win.index}]${win.title ? ` "${win.title}"` : ''}`

            if (a.action === 'focus_window') {
              const r = mutateWindow(win.app, win.index, { focus: true })
              // Errors are reported, not swallowed: "focused" for a window that
              // refused to raise sends the next click at the wrong app.
              const trouble = r.errors.length ? ` (${r.errors.join('; ')})` : ''
              return `🪟 focused ${label} — ${describeGeometry(r.window ?? win)}${trouble}`
            }

            let want: { x?: number; y?: number; width?: number; height?: number }
            if (a.action === 'snap_window') {
              const snap = String(a.snap || 'maximize') as Snap
              if (!SNAPS.includes(snap)) return `unknown snap "${a.snap}" — use one of: ${SNAPS.join(', ')}`
              const usable = usableRectFor(win, screens)
              // No screens means no usable area, and inventing one would move the
              // window onto a display that doesn't exist.
              if (!usable) return 'no display geometry available — snap needs a screen to fit into'
              want = snapRect(usable, snap)
            } else if (a.action === 'move_window') {
              if (a.x == null || a.y == null) return 'need x + y for move_window'
              want = { x: a.x, y: a.y }
            } else {
              if (a.width == null || a.height == null) return 'need width + height for resize_window'
              want = { width: a.width, height: a.height }
            }

            const r = mutateWindow(win.app, win.index, want)
            const trouble = r.errors.length ? ` (${r.errors.join('; ')})` : ''
            // describeOutcome reads the window back — so this line distinguishes
            // "moved" from "the app kept it where it was", which look identical
            // from the setter's point of view.
            return `🪟 ${label}: ${describeOutcome(want, r.window)}${trouble}`
          }

          default:
            return `unknown action: ${a.action}`
        }
      } catch (e: any) {
        return `computer error: ${String(e?.message || e).slice(0, 500)}`
      }
    },
  })
}

export function hasComputerControl(): boolean {
  return isMac && fs.existsSync('/usr/sbin/screencapture')
}
