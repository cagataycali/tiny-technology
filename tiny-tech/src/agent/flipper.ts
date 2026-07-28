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

/** Send one CLI command, return its response text (prompt + echo stripped). */
async function cli(conn: FlipperPort, cmd: string, timeoutMs = 15_000): Promise<string> {
  await conn.drainQuiet()
  await conn.write(`${cmd}\r`)
  // The Flipper echoes the command back before answering.
  await conn.until(EOL, timeoutMs).catch(() => '')
  const body = await conn.until(PROMPT, timeoutMs)
  return body.trim()
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
- detect — list connected Flippers / connect / disconnect
- info — firmware + hardware; power_info — battery, charge state, temp; uptime; datetime
- ls (path, default /ext) / tree (path, depth) — browse the SD card
- read (path) — file contents (hex preview when binary)
- write (path, data) / send (local_path, path) / receive (path, local_path)
- mkdir (path) / rm (path) / stat (path) / md5 (path) / df (path)
- led (data="r 255"|"g 128"|"b 0"|"bl 255") / vibro (data="1"|"0") / speaker (frequency, duration) / alert
- ir_tx (path to .ir on the Flipper) / subghz_tx (path to .sub) / nfc_detect
- app_list / app_start (command=app path)
- cli (command) — any raw Flipper CLI command
Only transmit signals (ir_tx/subghz_tx) the user owns and asked for.`,
    inputSchema: z.object({
      action: z.string(),
      path: z.string().optional(),
      local_path: z.string().optional(),
      data: z.string().optional(),
      command: z.string().optional(),
      port: z.string().optional(),
      frequency: z.number().optional(),
      duration: z.number().optional(),
      depth: z.number().optional(),
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
              return `🐬 uptime: ${(await cli(conn, 'uptime')).replace(/^Uptime:\s*/i, '')}`

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

            case 'ir_tx': {
              if (!a.path) return 'need path to a .ir file on the Flipper'
              const out = await cli(conn, a.command ? `ir tx "${a.path}" ${a.command}` : `ir tx "${a.path}"`, 20_000)
              return `📡 ir tx ${a.path}${out ? `\n${out}` : ''}`
            }
            case 'subghz_tx': {
              if (!a.path) return 'need path to a .sub file on the Flipper'
              const out = await cli(conn, `subghz tx "${a.path}"`, 20_000)
              return `📡 subghz tx ${a.path}${out ? `\n${out}` : ''}`
            }
            case 'nfc_detect':
              return `📱 nfc: ${await cli(conn, 'nfc detect', 15_000)}`

            case 'app_list':
              return `🐬 apps:\n${await cli(conn, 'loader list', 15_000)}`
            case 'app_start':
              if (!a.command) return 'need command (app name or path)'
              return `🚀 ${a.command}\n${await cli(conn, `loader open "${a.command}"`, 15_000)}`
            case 'bt_info':
              // `bt info` prints usage; `bt hci_info` is the real command
              return `🔵 bluetooth:\n${await cli(conn, 'bt hci_info', 10_000)}`

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
