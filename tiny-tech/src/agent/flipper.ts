/**
 * use_flipper — Flipper Zero over USB serial, zero native dependencies.
 *
 * DevDuck's tools/use_flipper.py ported to TypeScript. Same idea: the Flipper
 * exposes a text CLI over USB CDC, so no protobuf is needed — write a command,
 * read until the `>: ` prompt.
 *
 * Python had pyserial; Node has no serial API and we refuse to add a native
 * module (tiny-tech must stay `npx`-installable with no build step). Instead:
 *   `stty -f <port> 230400 raw -echo`  configures the tty
 *   `fs.open(port, O_RDWR | O_NONBLOCK)` + readSync/writeSync moves the bytes
 *
 * O_NONBLOCK is what makes timeouts possible at all — a blocking readSync on a
 * quiet tty never returns, so every read polls for EAGAIN instead.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'

const PROMPT = '>: '
const EOL = '\r\n'
const BAUD = 230_400
const CHUNK = 8192

/** Ctrl-C. The receive commands stream until interrupted; nothing else stops them. */
const ETX = '\x03'

/**
 * Pins `gpio` accepts, verbatim from its own error message on unlshd-075.
 * Checked locally because the firmware answers a bad pin with a usage blob and
 * exit code nothing — indistinguishable, to a caller, from a pin that read low.
 */
export const GPIO_PINS = ['PA7', 'PA6', 'PA4', 'PB3', 'PB2', 'PC3', 'PC1', 'PC0'] as const

/** IR protocols `ir tx` accepts (from its usage text). */
export const IR_PROTOCOLS = [
  'NEC', 'NECext', 'NEC42', 'NEC42ext', 'Samsung32', 'RC6', 'RC5', 'RC5X',
  'SIRC', 'SIRC15', 'SIRC20', 'Kaseikyo', 'RCA', 'Pioneer',
] as const

/**
 * The three answers that are true whether or not a Flipper is plugged in, kept
 * as constants so the pre-connection guard in the callback and the switch case
 * that follows a real connection cannot drift into saying different things.
 */
export const NFC_UNAVAILABLE = [
  '📱 NFC scanning is not available over this Flipper\'s CLI.',
  'Firmware unlshd-075-class builds expose `nfc` in help but with no subcommands —',
  'every form answers with a usage block, not a scan. Options:',
  '  • scan on the device: NFC → Read, then action:"ls" path:"/ext/nfc" to find the saved file',
  '  • already-saved tags: action:"read" path:"/ext/nfc/<name>.nfc"',
  'Not doing: action:"app_start" — see its note; it strands the CLI until reboot.',
].join('\n')

export const APP_START_DISABLED = [
  '🚫 app_start is disabled on purpose.',
  'This firmware\'s loader has no `close`, and once an app is running every other',
  'CLI command fails with "Other application is running". Synthetic back-presses do',
  'not dismiss it — recovery measured to require `power reboot`, which would drop',
  'the USB port mid-conversation.',
  'To run an app, open it on the device by hand, or action:"cli" command:"power reboot"',
  'if one is already stuck.',
].join('\n')

export const IR_TX_USAGE = [
  'ir_tx needs a decoded signal on this firmware: protocol + address + command',
  `  protocols: ${IR_PROTOCOLS.join(' ')}`,
  '  e.g. action:"ir_tx" protocol:"NEC" address:"00" command:"15"',
  'For a saved remote use action:"ir_universal" (remote + signal), or action:"read" the .ir',
  'file first and transmit the fields it lists. A bare file path is NOT accepted.',
].join('\n')

/** Built-in universal remotes (`ir universal <remote> <signal>`). */
export const IR_UNIVERSAL_REMOTES = ['ac', 'audio', 'fans', 'projectors', 'tv'] as const

/**
 * Directories holding scanned credentials. `read`/`receive` refuse to walk these
 * wholesale, because this Flipper's /ext/nfc contains passports, national IDs
 * and bank cards — pulling one into a chat transcript copies it to the model
 * provider, the conversation store, and anyone the user later shares the thread
 * with. A single explicit path still works; it is the blind sweep that doesn't.
 */
const SENSITIVE_DIRS = ['/ext/nfc', '/ext/lfrfid', '/ext/ibutton', '/ext/u2f', '/ext/subghz']

// ── port discovery ──────────────────────────────────────────────────────────

/** Serial ports that look like a Flipper (`/dev/cu.usbmodemflip_XXX`). */
export function findFlipperPorts(devDir = '/dev'): string[] {
  try {
    return fs
      .readdirSync(devDir)
      .filter((n) => /^(cu|tty)\..*flip/i.test(n))
      // cu.* is the call-out device: it won't block waiting for carrier detect
      .filter((n) => n.startsWith('cu.'))
      .sort()
      .map((n) => `${devDir}/${n}`)
  } catch {
    return []
  }
}

export function findFlipperPort(): string | null {
  if (process.env.FLIPPER_PORT) return process.env.FLIPPER_PORT
  return findFlipperPorts()[0] ?? null
}

// ── response parsers (pure — unit-testable without hardware) ────────────────

export interface StorageEntry {
  type: 'dir' | 'file'
  name: string
  size?: string
}

/** Parse `storage list` output into entries. */
export function parseStorageList(raw: string): StorageEntry[] {
  const out: StorageEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s === 'Empty' || s.includes('Storage error:')) continue
    if (s.startsWith('[D]')) {
      out.push({ type: 'dir', name: s.slice(3).trim() })
    } else if (s.startsWith('[F]')) {
      const info = s.slice(3).trim()
      const at = info.lastIndexOf(' ')
      if (at > 0) out.push({ type: 'file', name: info.slice(0, at), size: info.slice(at + 1) })
      else out.push({ type: 'file', name: info, size: '?' })
    }
  }
  return out
}

/** Parse `key: value` CLI output (device_info, info power) into a record. */
export function parseKeyValues(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const k = line.slice(0, at).trim()
    const v = line.slice(at + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** Listen windows are bounded: the serial lock is held for the whole capture. */
export function clampSecs(v: number | undefined, dflt: number, max: number): number {
  const n = Number.isFinite(v) ? Number(v) : dflt
  return Math.max(1, Math.min(Math.round(n), max))
}

/**
 * True when `path` names a directory of scanned credentials rather than one file
 * inside it. Guards the bulk verbs only — `read` of an explicit .nfc still works,
 * because the user asking for one card by name is a different act from an agent
 * walking the whole wallet into a transcript.
 */
export function isSensitiveSweep(path: string): boolean {
  const p = String(path || '').replace(/\/+$/, '').toLowerCase()
  return SENSITIVE_DIRS.some((d) => p === d || p === `${d}/`)
}

function formatKeyValues(title: string, kv: Record<string, string>): string {
  const lines = Object.entries(kv).map(([k, v]) => `  ${k}: ${v}`)
  return lines.length ? `${title}\n${lines.join('\n')}` : `${title}\n  (no data)`
}

// ── serial transport ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class FlipperPort {
  readonly port: string
  private fd: number
  private buf: Buffer = Buffer.alloc(0)

  private constructor(port: string, fd: number) {
    this.port = port
    this.fd = fd
  }

  static async open(port: string): Promise<FlipperPort> {
    // `raw -echo` so the Flipper's bytes arrive verbatim; -crtscts because USB
    // CDC has no real flow-control lines and waiting on them hangs the open.
    execFileSync('stty', ['-f', port, String(BAUD), 'raw', '-echo', '-crtscts'], { timeout: 5000 })
    const fd = fs.openSync(port, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)
    const p = new FlipperPort(port, fd)
    // Opening the CDC port makes the Flipper print its ~1KB dolphin banner,
    // and a bare CR reprints the prompt. Both stream in over several ms, so
    // discard by waiting for silence rather than for a delimiter — stopping at
    // the first `>: ` would leave the rest to be misread as the next reply.
    await p.write('\r')
    await p.drainQuiet(200, 3000)
    return p
  }

  get isOpen(): boolean {
    return this.fd >= 0
  }

  /**
   * Write everything, respecting tty backpressure.
   *
   * O_NONBLOCK cuts both ways: a write bigger than the kernel's tty output
   * buffer (~1-8KB) doesn't block, it fails with EAGAIN partway. File transfer
   * pushes 8KB chunks, so every write must be a retry loop, not one syscall.
   */
  async write(s: string | Buffer): Promise<void> {
    const b = typeof s === 'string' ? Buffer.from(s, 'ascii') : s
    let off = 0
    const deadline = Date.now() + 30_000
    while (off < b.length) {
      try {
        off += fs.writeSync(this.fd, b, off, b.length - off)
      } catch (e: any) {
        if (e?.code !== 'EAGAIN') throw e
        // Buffer full — let the device drain, then continue where we stopped.
        if (Date.now() > deadline) throw new Error(`write stalled at ${off}/${b.length} bytes`)
        await sleep(5)
      }
    }
  }

  /** Pull whatever bytes are available into the buffer. Returns bytes read. */
  private drain(): number {
    const scratch = Buffer.alloc(65536)
    let got = 0
    for (;;) {
      let n = 0
      try {
        n = fs.readSync(this.fd, scratch, 0, scratch.length, null)
      } catch (e: any) {
        // EAGAIN = nothing to read right now (the normal quiet-line case)
        if (e?.code === 'EAGAIN') break
        throw e
      }
      if (n <= 0) break
      this.buf = Buffer.concat([this.buf, scratch.subarray(0, n)])
      got += n
    }
    return got
  }

  /** Read until `delim`, returning everything before it. */
  async until(delim: string, timeoutMs = 15_000, cutDelim = true): Promise<string> {
    const needle = Buffer.from(delim, 'ascii')
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const at = this.buf.indexOf(needle)
      if (at >= 0) {
        const end = cutDelim ? at : at + needle.length
        const out = this.buf.subarray(0, end).toString('utf8')
        this.buf = this.buf.subarray(at + needle.length)
        return out
      }
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${JSON.stringify(delim)} from ${basename(this.port)}`)
      }
      if (this.drain() === 0) await sleep(10)
    }
  }

  /** Read exactly n raw bytes (binary file transfer). */
  async readExact(n: number, timeoutMs = 30_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs
    while (this.buf.length < n) {
      if (Date.now() > deadline) throw new Error(`timeout reading ${n} bytes (got ${this.buf.length})`)
      if (this.drain() === 0) await sleep(5)
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return Buffer.from(out)
  }

  /**
   * Swallow everything the device is still sending, until the line has been
   * quiet for `quietMs`. This is the only reliable resync: leftover bytes from
   * a previous command would otherwise be returned as the *next* command's
   * reply, silently shifting every answer by one.
   */
  async drainQuiet(quietMs = 120, maxMs = 2000): Promise<void> {
    const deadline = Date.now() + maxMs
    let lastByteAt = Date.now()
    for (;;) {
      if (this.drain() > 0) lastByteAt = Date.now()
      this.buf = Buffer.alloc(0)
      if (Date.now() - lastByteAt >= quietMs) return
      if (Date.now() > deadline) return
      await sleep(20)
    }
  }

  close(): void {
    if (this.fd >= 0) {
      try {
        fs.closeSync(this.fd)
      } catch {
        /* already gone */
      }
      this.fd = -1
    }
  }
}

// ── connection pool + serialized access ─────────────────────────────────────

const pool = new Map<string, FlipperPort>()

/** Serialize all serial I/O — two interleaved commands corrupt the stream. */
let lock: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function connection(portOverride?: string): Promise<FlipperPort> {
  const port = portOverride || findFlipperPort()
  if (!port) {
    throw new Error('no Flipper Zero found — connect it over USB (or set FLIPPER_PORT)')
  }
  const live = pool.get(port)
  if (live?.isOpen) return live
  pool.delete(port)
  const conn = await FlipperPort.open(port)
  pool.set(port, conn)
  return conn
}

function closeAll(port?: string): number {
  const targets = port ? [port] : [...pool.keys()]
  let n = 0
  for (const p of targets) {
    const c = pool.get(p)
    if (c) {
      c.close()
      pool.delete(p)
      n++
    }
  }
  return n
}

/** The reply every app-claiming command gives while a GUI app holds the device. */
const APP_BUSY = 'Other application is running'

/**
 * What to tell the caller when the device is stuck behind a running app.
 *
 * This state is reachable without us: the user can open an app on the device by
 * hand. It reads as a broken tool ("uptime failed"?) unless it is named, and the
 * remedy is non-obvious because this firmware's loader cannot close anything.
 */
export function appBusyHelp(cmd: string): string {
  return [
    `🐬 "${cmd}" cannot run: an app is open on the Flipper, and it holds the hardware.`,
    'Press Back on the device until you are at the desktop, then retry.',
    'This firmware has no `loader close`, and synthetic back-presses do not work;',
    'if the device is unattended, action:"cli" command:"power reboot" clears it',
    '(the USB port drops and re-enumerates a few seconds later).',
  ].join('\n')
}

/** Send one CLI command, return its response text (prompt + echo stripped). */
async function cli(conn: FlipperPort, cmd: string, timeoutMs = 15_000): Promise<string> {
  await conn.drainQuiet()
  await conn.write(`${cmd}\r`)
  // The Flipper echoes the command back before answering.
  await conn.until(EOL, timeoutMs).catch(() => '')
  const body = await conn.until(PROMPT, timeoutMs)
  return body.trim()
}

/** cli(), but a busy-app reply becomes actionable guidance instead of a puzzle. */
async function cliChecked(conn: FlipperPort, cmd: string, timeoutMs = 15_000): Promise<string> {
  const out = await cli(conn, cmd, timeoutMs)
  if (out.includes(APP_BUSY)) throw new Error(appBusyHelp(cmd))
  return out
}

/**
 * Run a command that streams until interrupted, for `secs`, then Ctrl-C it.
 *
 * `ir rx`, `subghz rx`, `rfid read` and `ikey read` all print "Press Ctrl+C to
 * abort" and then never return to the prompt — they are listeners, not queries.
 * Handing one to cli() waits for a `>: ` that only arrives after an interrupt,
 * so it burns its whole timeout and then throws with the capture still running.
 *
 * The Ctrl-C is what makes these safe to expose: without it the radio stays on
 * and the CLI is left mid-command, which desyncs every later reply by one.
 */
async function listen(conn: FlipperPort, cmd: string, secs: number): Promise<string> {
  await conn.drainQuiet()
  await conn.write(`${cmd}\r`)
  const out: string[] = []
  const deadline = Date.now() + Math.round(secs * 1000)
  while (Date.now() < deadline) {
    try {
      // Short hops so the Ctrl-C lands on time even when nothing is arriving.
      out.push(await conn.until(EOL, Math.min(500, Math.max(50, deadline - Date.now())), false))
    } catch {
      /* quiet window — expected while waiting for a signal */
      continue
    }
    // A busy app refuses instantly. Bail now rather than listening to a radio
    // that was never switched on and then reporting "nothing received".
    if (out[out.length - 1]?.includes(APP_BUSY)) {
      await conn.drainQuiet(200, 2000)
      throw new Error(appBusyHelp(cmd))
    }
  }
  await conn.write(ETX)
  // Drain the tail: the interrupt handler prints its own closing line ("Reading
  // stopped", "Packets received N") after the Ctrl-C, and that line is often the
  // only part of the reply that carries the result.
  try {
    out.push(await conn.until(PROMPT, 3000))
  } catch {
    await conn.drainQuiet(250, 2500)
  }
  return out
    .join('')
    // strip the ANSI colour the keystore loader emits
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^.*\r?\n/, '') // drop the echoed command
    .trim()
}

async function readFileFromFlipper(conn: FlipperPort, path: string): Promise<Buffer> {
  await conn.drainQuiet()
  await conn.write(`storage read_chunks "${path}" ${CHUNK}\r`)
  await conn.until(EOL, 10_000).catch(() => '')
  const answer = await conn.until(EOL, 10_000)
  if (answer.includes('Storage error:')) {
    await conn.until(PROMPT, 5000).catch(() => '')
    throw new Error(answer.trim())
  }
  const size = Number.parseInt(answer.split(': ')[1] ?? '', 10)
  if (!Number.isFinite(size)) throw new Error(`unexpected read reply: ${answer.trim()}`)

  const parts: Buffer[] = []
  let read = 0
  while (read < size) {
    await conn.until(`Ready?${EOL}`, 15_000)
    await conn.write('y')
    const want = Math.min(size - read, CHUNK)
    parts.push(await conn.readExact(want))
    read += want
  }
  await conn.until(PROMPT, 5000).catch(() => '')
  return Buffer.concat(parts)
}

async function writeFileToFlipper(conn: FlipperPort, path: string, data: Buffer): Promise<void> {
  // write_chunk APPENDS to whatever is already there — it is not a truncating
  // write. Without this remove, re-sending a file doubles it, and a multi-chunk
  // transfer would concatenate onto the previous attempt's bytes.
  const removed = await cli(conn, `storage remove "${path}"`)
  if (removed.includes('Storage error:') && !/does not exist|not exist|Storage error: file\/dir not exist/i.test(removed)) {
    throw new Error(`cannot overwrite ${path}: ${removed.trim()}`)
  }

  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, off + CHUNK)
    await conn.drainQuiet()
    await conn.write(`storage write_chunk "${path}" ${chunk.length}\r`)
    await conn.until(EOL, 10_000).catch(() => '')
    const answer = await conn.until(EOL, 10_000)
    if (answer.includes('Storage error:')) {
      await conn.until(PROMPT, 5000).catch(() => '')
      throw new Error(answer.trim())
    }
    await conn.write(Buffer.from(chunk))
    await conn.until(PROMPT, 30_000)
  }
  // A zero-byte source still has to create the file.
  if (data.length === 0) {
    await conn.drainQuiet()
    await conn.write(`storage write_chunk "${path}" 0\r`)
    await conn.until(PROMPT, 10_000).catch(() => '')
  }
}

async function listTree(conn: FlipperPort, path: string, prefix = '', maxDepth = 4, depth = 0): Promise<string[]> {
  if (depth >= maxDepth) return [`${prefix}… (max depth)`]
  const entries = parseStorageList(await cli(conn, `storage list "${path}"`))
  const lines: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const last = i === entries.length - 1
    lines.push(`${prefix}${last ? '└── ' : '├── '}${e.type === 'dir' ? `📂 ${e.name}/` : `📄 ${e.name} (${e.size})`}`)
    if (e.type === 'dir') {
      const child = `${path.replace(/\/$/, '')}/${e.name}`
      lines.push(...(await listTree(conn, child, `${prefix}${last ? '    ' : '│   '}`, maxDepth, depth + 1)))
    }
  }
  return lines
}

// ── the tool ────────────────────────────────────────────────────────────────

export function makeFlipperTool() {
  return tool({
    name: 'use_flipper',
    description: `🐬 Flipper Zero over USB serial (its built-in text CLI — no qFlipper needed). Actions:
- detect / connect / disconnect
- info — firmware + hardware; power_info — battery, charge state, temp; uptime; datetime; free
- ls (path, default /ext) / tree (path, depth) — browse the SD card
- read (path) — file contents (hex preview when binary)
- write (path, data) / send (local_path, path) / receive (path, local_path)
- mkdir (path) / rm (path) / stat (path) / md5 (path) / df (path)
- led (data="r 255"|"g 128"|"b 0"|"bl 255") / vibro (data="1"|"0") / speaker (frequency, duration) / alert
INFRARED
- ir_rx (duration=5, raw?) — LISTEN for a remote and decode it (protocol/address/command)
- ir_tx (protocol, address, command) — send a decoded signal. A FILE PATH IS NOT ACCEPTED here.
- ir_universal (path=remote name: tv/ac/audio/fans/projectors, command=signal) — omit command to list signals
SUB-GHZ (433/868MHz)
- subghz_rx (frequency=433920000, duration=5, external?) — listen and report packets
- subghz_tx (path to a .sub file, repeat=1) — replay a saved capture
125kHz RFID / iButton / 1-Wire
- rfid_read (duration=5) / ikey_read (duration=5) / onewire_search
GPIO / I2C
- gpio_read (path=PIN) / gpio_set (path=PIN, data="0"|"1") — pins: PA7 PA6 PA4 PB3 PB2 PC3 PC1 PC0
- i2c_scan — scan the external bus on PC0/PC1
SCRIPTING / INPUT / CHAT
- js (path) — run a .js file on the Flipper (e.g. /ext/apps_scripts/example.js)
- input_dump (duration=3) — capture button/navigation events
- input_send (command) — send key: "back short", "ok press", "up release", "left long"
- subghz_chat (frequency=433920000, duration=5, external?) — short-range text messaging (type on device)
- app_list, bt_info, cli (command) — any raw Flipper CLI command
The *_rx/*_read actions hold the radio for their whole window (max 30s), then stop it.
RF and IR transmission is physical action on the world: only transmit what the user owns and
explicitly asked for in this conversation, and never sweep/brute-force. Saved credentials under
/ext/nfc, /ext/lfrfid, /ext/ibutton are the user's own IDs and cards — read one by name if asked,
never enumerate the folder's contents into the conversation unprompted.`,
    inputSchema: z.object({
      action: z.string(),
      path: z.string().optional().describe('Flipper path, or a pin/remote name for gpio_*/ir_universal'),
      local_path: z.string().optional(),
      data: z.string().optional(),
      command: z.string().optional().describe('raw CLI command, or the signal name for ir_universal'),
      port: z.string().optional(),
      frequency: z.number().optional().describe('Hz — speaker tone, or subghz_rx frequency (default 433920000)'),
      duration: z.number().optional().describe('seconds — tone length, or listen window for the *_rx/*_read actions (max 30)'),
      depth: z.number().optional(),
      protocol: z.string().optional().describe('IR protocol for ir_tx, e.g. NEC / Samsung32 / RC5'),
      address: z.string().optional().describe('hex IR address for ir_tx'),
      raw: z.boolean().optional().describe('ir_rx: capture raw timings instead of decoded signals'),
      repeat: z.number().optional().describe('subghz_tx: send count (1-10)'),
      external: z.boolean().optional().describe('use the external CC1101 module instead of the built-in radio'),
    }),
    callback: async (a) =>
      withLock(async () => {
        try {
          // ── no connection needed ──
          if (a.action === 'detect') {
            const ports = findFlipperPorts()
            const env = process.env.FLIPPER_PORT
            if (env) return `🐬 FLIPPER_PORT=${env}${ports.length ? ` (autodetected: ${ports.join(', ')})` : ''}`
            if (!ports.length) return 'no Flipper Zero detected — connect over USB (and make sure it is not in DFU mode)'
            return `🐬 found ${ports.length} Flipper(s): ${ports.join(', ')}`
          }
          if (a.action === 'disconnect') {
            const n = closeAll(a.port)
            return n ? `🐬 disconnected (${n})` : '🐬 nothing was open'
          }

          // ── refusals and argument checks that DO NOT need the hardware ──
          // These answers are true with nothing plugged in: NFC-over-CLI is
          // absent from the firmware, app_start is disabled by policy, and a
          // bogus IR protocol or GPIO pin is a caller mistake. They used to sit
          // below `connection()`, so on a machine with no Flipper the user was
          // told "no Flipper Zero found" — a hardware problem — instead of the
          // real reason, and an agent would go looking for a cable it doesn't need.
          if (a.action === 'nfc_detect' || a.action === 'nfc_read') return NFC_UNAVAILABLE
          if (a.action === 'app_start') return APP_START_DISABLED
          if (a.action === 'ir_tx') {
            if (!(a.protocol && a.address && a.command)) return IR_TX_USAGE
            if (!IR_PROTOCOLS.includes(String(a.protocol) as any)) {
              return `unknown IR protocol ${a.protocol}. Available: ${IR_PROTOCOLS.join(' ')}`
            }
          }
          if (a.action === 'gpio_read' || a.action === 'gpio_set') {
            const pin = String(a.path || (a.action === 'gpio_read' ? a.data : '') || '').toUpperCase()
            if (!GPIO_PINS.includes(pin as any)) return `need a pin: ${GPIO_PINS.join(' ')}`
          }

          const conn = await connection(a.port)

          switch (a.action) {
            case 'connect':
              return `🐬 connected on ${conn.port}`

            case 'info':
              return formatKeyValues('🐬 Flipper Zero:', parseKeyValues(await cli(conn, 'device_info')))
            case 'power_info':
              // `power info` prints usage; `info power` is the real command
              return formatKeyValues('🐬 power:', parseKeyValues(await cli(conn, 'info power')))
            case 'datetime':
              return `🐬 datetime: ${await cli(conn, 'date')}`
            case 'uptime':
              return `🐬 uptime: ${(await cliChecked(conn, 'uptime')).replace(/^Uptime:\s*/i, '')}`
            case 'free':
              return formatKeyValues('🐬 memory:', parseKeyValues(await cliChecked(conn, 'free')))

            case 'ls': {
              const path = a.path || '/ext'
              const entries = parseStorageList(await cli(conn, `storage list "${path}"`))
              if (!entries.length) return `📁 ${path}: (empty)`
              const lines = entries.map((e) =>
                e.type === 'dir' ? `  📂 ${e.name}/` : `  📄 ${e.name} (${e.size})`,
              )
              return `📁 ${path}:\n${lines.join('\n')}`
            }
            case 'tree': {
              const path = a.path || '/ext'
              const lines = await listTree(conn, path, '', Math.max(1, Math.min(a.depth ?? 4, 8)))
              return lines.length ? `🌲 ${path}:\n${lines.join('\n')}` : `🌲 ${path}: (empty)`
            }
            case 'read': {
              if (!a.path) return 'need path'
              if (isSensitiveSweep(a.path)) {
                return `${a.path} is a directory of the user's scanned cards and IDs — name a single file to read (use action:"ls" to see them).`
              }
              const bytes = await readFileFromFlipper(conn, a.path)
              const text = bytes.toString('utf8')
              // U+FFFD means the bytes weren't valid UTF-8 → show hex instead
              if (text.includes('�')) {
                return `📄 ${a.path} (${bytes.length} bytes, binary)\n${bytes.subarray(0, 1024).toString('hex')}${bytes.length > 1024 ? '…' : ''}`
              }
              return `📄 ${a.path} (${bytes.length} bytes)\n${text}`
            }
            case 'write': {
              if (!a.path || a.data == null) return 'need path + data'
              const buf = Buffer.from(a.data, 'utf8')
              await writeFileToFlipper(conn, a.path, buf)
              return `✅ wrote ${buf.length} bytes → ${a.path}`
            }
            case 'send': {
              if (!a.path || !a.local_path) return 'need local_path + path'
              const full = resolvePath(a.local_path.replace(/^~(?=\/)/, process.env.HOME || '~'))
              const buf = fs.readFileSync(full)
              await writeFileToFlipper(conn, a.path, buf)
              return `✅ sent ${basename(full)} (${buf.length} bytes) → ${a.path}`
            }
            case 'receive': {
              if (!a.path || !a.local_path) return 'need path + local_path'
              const bytes = await readFileFromFlipper(conn, a.path)
              const full = resolvePath(a.local_path.replace(/^~(?=\/)/, process.env.HOME || '~'))
              fs.mkdirSync(resolvePath(full, '..'), { recursive: true })
              fs.writeFileSync(full, bytes)
              return `✅ received ${a.path} (${bytes.length} bytes) → ${full}`
            }
            case 'mkdir':
            case 'rm':
            case 'stat':
            case 'md5':
            case 'df': {
              if (a.action !== 'df' && !a.path) return 'need path'
              const path = a.path || '/ext'
              const cmd =
                a.action === 'mkdir' ? `storage mkdir "${path}"`
                : a.action === 'rm' ? `storage remove "${path}"`
                : a.action === 'stat' ? `storage stat "${path}"`
                : a.action === 'md5' ? `storage md5 "${path}"`
                : `storage info "${path}"`
              const out = await cli(conn, cmd)
              if (out.includes('Storage error:')) return `🐬 ${out}`
              const verb = { mkdir: '✅ created', rm: '✅ removed', stat: '🐬 stat', md5: '🐬 md5', df: '🐬 storage' } as Record<string, string>
              return `${verb[a.action]} ${path}${out ? `: ${out}` : ''}`
            }

            case 'led':
              if (!a.data) return `need data, e.g. "r 255" / "g 128" / "b 0" / "bl 255"`
              await cli(conn, `led ${a.data}`)
              return `💡 led ${a.data}`
            case 'vibro': {
              const on = (a.data ?? '1').trim() !== '0'
              await cli(conn, `vibro ${on ? 1 : 0}`)
              return `📳 vibro ${on ? 'on' : 'off'}`
            }
            case 'speaker': {
              const hz = Math.round(a.frequency ?? 440)
              const secs = a.duration ?? 0.5
              await cli(conn, `tone ${hz} ${Math.round(secs * 1000)}`)
              return `🔊 ${hz}Hz for ${secs}s`
            }
            case 'alert':
              await cli(conn, 'led r 255')
              await cli(conn, 'vibro 1')
              await sleep(300)
              await cli(conn, 'vibro 0')
              await cli(conn, 'led r 0')
              return '🚨 alert (led + vibro)'

            // ── IR ────────────────────────────────────────────────────────
            case 'ir_rx': {
              const secs = clampSecs(a.duration, 5, 30)
              const out = await listen(conn, a.raw ? 'ir rx raw' : 'ir rx', secs)
              const hits = out.split(/\r?\n/).filter((l) => /^[A-Za-z0-9]+, A:/.test(l.trim()))
              if (!hits.length) {
                return `📡 ir rx: listened ${secs}s, nothing received. Point the remote at the Flipper's top edge and press a button while this runs.`
              }
              return `📡 ir rx (${secs}s), ${hits.length} signal(s):\n${hits.map((h) => `  ${h.trim()}`).join('\n')}`
            }
            case 'ir_tx': {
              // This firmware's `ir tx` takes a DECODED signal, not a file:
              //   ir tx <protocol> <address> <command>      (hex address/command)
              // `ir tx "/ext/infrared/Remote.ir"` answers "Wrong arguments." —
              // it never transmitted. To send a saved remote, use ir_universal
              // (built-in remotes) or read the .ir file and pass its fields.
              if (a.protocol && a.address && a.command) {
                const proto = String(a.protocol)
                if (!IR_PROTOCOLS.includes(proto as any)) {
                  return `unknown IR protocol ${proto}. Available: ${IR_PROTOCOLS.join(' ')}`
                }
                const out = await cliChecked(conn, `ir tx ${proto} ${a.address} ${a.command}`, 20_000)
                if (/Wrong arguments|Usage:/i.test(out)) return `🐬 ir tx rejected:\n${out}`
                return `📡 ir tx ${proto} A:${a.address} C:${a.command}${out ? `\n${out}` : ''}`
              }
              return IR_TX_USAGE
            }
            case 'ir_universal': {
              const remote = String(a.path || a.data || '')
              if (!remote) return `need a remote name: ${IR_UNIVERSAL_REMOTES.join(' ')}`
              if (!a.command) {
                return `🐬 signals on universal remote "${remote}":\n${await cli(conn, `ir universal list ${remote}`, 15_000)}`
              }
              const out = await cliChecked(conn, `ir universal ${remote} ${a.command}`, 30_000)
              return `📡 ir universal ${remote} ${a.command}${out ? `\n${out}` : ''}`
            }

            // ── Sub-GHz ───────────────────────────────────────────────────
            case 'subghz_rx': {
              const hz = Math.round(a.frequency ?? 433_920_000)
              const secs = clampSecs(a.duration, 5, 30)
              const out = await listen(conn, `subghz rx ${hz} ${a.external ? 1 : 0}`, secs)
              return `📡 subghz rx ${(hz / 1e6).toFixed(5)}MHz for ${secs}s:\n${out || '(no output)'}`
            }
            case 'subghz_tx': {
              // `subghz tx` here is <3-byte key> <freq> <te> <repeat> <device>;
              // sending a FILE is a different verb entirely (tx_from_file).
              if (!a.path) return 'need path to a .sub file on the Flipper (or use action:"cli" for raw key tx)'
              const repeat = Math.max(1, Math.min(a.repeat ?? 1, 10))
              const out = await cliChecked(conn, `subghz tx_from_file "${a.path}" ${repeat} ${a.external ? 1 : 0}`, 30_000)
              if (/Usage:|Wrong/i.test(out)) return `🐬 subghz tx rejected:\n${out}`
              return `📡 subghz tx_from_file ${a.path} ×${repeat}${out ? `\n${out}` : ''}`
            }

            // ── 125kHz RFID / iButton / 1-Wire ────────────────────────────
            case 'rfid_read': {
              const secs = clampSecs(a.duration, 5, 30)
              const out = await listen(conn, a.data ? `rfid read ${a.data}` : 'rfid read', secs)
              const body = out.replace(/Reading RFID\.\.\.|Press Ctrl\+C to abort|Reading stopped/g, '').trim()
              return body
                ? `🏷️  rfid read (${secs}s):\n${body}`
                : `🏷️  rfid read: listened ${secs}s, no card. Hold the card flat against the Flipper's back.`
            }
            case 'ikey_read': {
              const secs = clampSecs(a.duration, 5, 30)
              const out = await listen(conn, 'ikey read', secs)
              const body = out.replace(/Reading iButton\.\.\.|Press Ctrl\+C to abort/g, '').trim()
              return body
                ? `🔑 ikey read (${secs}s):\n${body}`
                : `🔑 ikey read: listened ${secs}s, nothing. Touch the iButton to the Flipper's two contacts.`
            }
            case 'onewire_search':
              return `🔗 onewire: ${await cliChecked(conn, 'onewire search', 15_000) || '(nothing found)'}`

            // ── NFC ───────────────────────────────────────────────────────
            case 'nfc_detect':
            case 'nfc_read':
              // Deliberately not wired to a command. `nfc` exists in `help` on
              // unlshd-075 but its subcommand list is EMPTY: `nfc detect`,
              // `nfc read` and `nfc field` all print the same bare usage block.
              // The old nfc_detect returned that blob as though it were a scan
              // result, so "no tag found" and "this firmware cannot scan from
              // the CLI" were indistinguishable. Reading a tag needs the on-screen
              // NFC app, and `loader open` cannot be undone from here (see below).
              return NFC_UNAVAILABLE

            case 'app_list':
              return `🐬 apps:\n${await cli(conn, 'loader list', 15_000)}`
            case 'app_start':
              // `loader open` WORKS, and that is the problem: this firmware's
              // loader has only list/open/info — no `close`. Once an app is up,
              // every app-claiming command (uptime, rfid, ikey, sysctl…) answers
              // "Other application is running, close it first", and neither
              // `input send back short|long|press|release` nor a 12-event burst
              // dismisses it. Measured: the only way back was `power reboot`.
              // So an agent calling this would silently disable its own toolset.
              return APP_START_DISABLED

            // ── GPIO ──────────────────────────────────────────────────────
            case 'gpio_read': {
              const pin = String(a.path || a.data || '').toUpperCase()
              if (!GPIO_PINS.includes(pin as any)) return `need a pin: ${GPIO_PINS.join(' ')}`
              // A pin last used as an output answers "Err: pin PC0 is not set as
              // an input" — measured. Reading means switching it to input first,
              // otherwise the first read after any gpio_set always fails.
              await cli(conn, `gpio mode ${pin} 0`, 10_000)
              const out = await cliChecked(conn, `gpio read ${pin}`, 10_000)
              return `📌 gpio ${pin}: ${out}`
            }
            case 'gpio_set': {
              const pin = String(a.path || '').toUpperCase()
              if (!GPIO_PINS.includes(pin as any)) return `need a pin: ${GPIO_PINS.join(' ')}`
              const level = (a.data ?? '').trim() === '1' ? 1 : 0
              // A pin left as an input ignores `set` silently, so set the mode first.
              await cli(conn, `gpio mode ${pin} 1`, 10_000)
              const out = await cli(conn, `gpio set ${pin} ${level}`, 10_000)
              return `📌 gpio ${pin} = ${level}${out ? `\n${out}` : ''}`
            }
            case 'i2c_scan':
              return `🔌 i2c (PC0=SCL, PC1=SDA):\n${await cliChecked(conn, 'i2c', 15_000)}`

            case 'bt_info':
              // `bt info` prints usage; `bt hci_info` is the real command
              return `🔵 bluetooth:\n${await cli(conn, 'bt hci_info', 10_000)}`

            // ── JS scripting ──────────────────────────────────────────────
            case 'js': {
              if (!a.path) return 'need path to a .js file on the Flipper'
              const out = await cliChecked(conn, `js ${a.path}`, 30_000)
              return `🟨 js ${a.path}:\n${out}`
            }

            // ── Input control ─────────────────────────────────────────────
            case 'input_dump': {
              const secs = clampSecs(a.duration, 3, 30)
              const out = await listen(conn, 'input dump', secs)
              const lines = out.split(/\r?\n/).filter((l) => l.trim() && !l.includes('Press Ctrl+C'))
              return lines.length
                ? `🎮 input dump (${secs}s), ${lines.length} event(s):\n${lines.map((l) => `  ${l.trim()}`).join('\n')}`
                : `🎮 input dump: listened ${secs}s, no input.`
            }
            case 'input_send': {
              if (!a.command) return 'need command, e.g. "back short" / "up press" / "ok release" / "left long"'
              const out = await cliChecked(conn, `input send ${a.command}`, 10_000)
              return `🎮 input send ${a.command}${out ? `\n${out}` : ''}`
            }

            // ── Sub-GHz chat ──────────────────────────────────────────────
            case 'subghz_chat': {
              const hz = Math.round(a.frequency ?? 433_920_000)
              const secs = clampSecs(a.duration, 5, 30)
              // subghz chat <frequency> <device>
              const out = await listen(conn, `subghz chat ${hz} ${a.external ? 1 : 0}`, secs)
              return `💬 subghz chat on ${(hz / 1e6).toFixed(5)}MHz for ${secs}s:\n${out || '(no messages)'}`
            }

            case 'cli':
              if (!a.command) return 'need command'
              return `🐬> ${a.command}\n${await cli(conn, a.command, 30_000)}`

            default:
              return `unknown action: ${a.action}`
          }
        } catch (e: any) {
          // A yanked cable leaves a dead fd behind — drop it so the next call reconnects.
          closeAll(a.port)
          return `flipper error: ${String(e?.message || e).slice(0, 500)}`
        }
      }),
  })
}

/** True when a Flipper is plugged in (registry gate). */
export function hasFlipper(): boolean {
  return findFlipperPort() !== null
}
