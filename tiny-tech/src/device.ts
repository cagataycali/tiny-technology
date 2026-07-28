/**
 * Device identity for tiny-tech (tiny-node PR2 — docs/tiny-node-goal.md §3).
 *
 * Separate from user credentials by design: the user JWT enrolls, the
 * device token operates. ~/.tiny/device.json (0600) holds:
 *   { version, deviceId, token, name, apiUrl, enrolledAt }
 *
 * Heartbeats go to /api/devices/heartbeat with the DEVICE token in-body
 * (no session, off the IP limiter). Revoking the device on the web
 * /devices page 401s the next heartbeat — we surface that and stop.
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'
import { homedir, hostname, platform, arch } from 'node:os'
import { join } from 'node:path'
import type { TinyApi } from './api.js'

export interface DeviceIdentity {
  version: 1
  deviceId: string
  token: string
  name: string
  apiUrl: string
  enrolledAt: number
}

function tinyHome(): string {
  return process.env.TINY_HOME || join(homedir(), '.tiny')
}

function devicePath(): string {
  return join(tinyHome(), 'device.json')
}

export function loadDevice(): DeviceIdentity | null {
  try {
    const d = JSON.parse(readFileSync(devicePath(), 'utf8')) as DeviceIdentity
    return d?.deviceId && d?.token ? d : null
  } catch {
    return null
  }
}

export function saveDevice(d: DeviceIdentity): void {
  mkdirSync(tinyHome(), { recursive: true, mode: 0o700 })
  writeFileSync(devicePath(), JSON.stringify(d, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(devicePath(), 0o600) } catch {}
}

export function clearDevice(): boolean {
  try {
    if (existsSync(devicePath())) { unlinkSync(devicePath()); return true }
  } catch {}
  return false
}

export function defaultDeviceName(): string {
  const user = process.env.USER || process.env.USERNAME || 'device'
  return `${user}-${hostname().split('.')[0]}`.toLowerCase().slice(0, 64)
}

export function devicePlatform(): string {
  return `${platform()}-${arch()}`
}

/**
 * The floor every enrolled CLI node has: it speaks MCP and it can touch files.
 * Everything past that depends on the machine — see deviceCapabilities().
 */
export const CLI_CAPABILITIES = ['mcp', 'files']

/**
 * Server-side clamps, copied from the worker's sanitizeCapabilities
 * (chatgpt-plugin-tinyai/src/devices.ts): 32 entries, 32 chars each. Declaring
 * past them isn't an error — it's silent truncation of the tail, so a machine
 * with many integrations would lose exactly the capabilities that distinguish
 * it. Clamp here, where we can pick WHAT to drop.
 */
const CAP_MAX = 32
const CAP_LEN = 32

/**
 * What this node can do, as one declared list. The base pair plus a label for
 * every device tool that actually registered on this machine — so `apple`,
 * `computer`, `desktop`, `spotify`, `adb`… ride along with enroll and every
 * heartbeat.
 *
 * Why it matters: the web agent's system prompt lists enrolled devices before
 * it ever calls use_device. Until now every device declared the same two
 * strings, so a Mac that can drive the screen, notify its human and read its
 * clipboard was indistinguishable from a bare CLI on a headless box — the agent
 * had to guess, and guessing wrong means a plan built on tools that aren't there.
 */
export function buildCapabilities(labels: string[] = []): string[] {
  const out: string[] = []
  for (const c of [...CLI_CAPABILITIES, ...labels]) {
    const clean = String(c || '').trim().toLowerCase().slice(0, CAP_LEN)
    // Base capabilities first and deduped: an integration label must never
    // push `mcp`/`files` off the end of the clamp.
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out.slice(0, CAP_MAX)
}

let declaredLabels: string[] | null = null

/**
 * Publish the tool labels this process resolved (agent.init passes
 * makeDeviceTools().labels). Heartbeats read this LIVE, so a Flipper plugged in
 * — or a `tiny-tech connect spotify` — shows up on /devices at the next beat
 * instead of requiring a re-enroll.
 */
export function setDeviceCapabilities(labels: string[]): void {
  declaredLabels = Array.isArray(labels) ? labels : []
}

/** The capability list to declare right now. */
export function deviceCapabilities(): string[] {
  return buildCapabilities(declaredLabels || [])
}

/**
 * Probe this machine's device tools and publish the result. Lazy import on
 * purpose: device.ts is loaded by the login path, which has no business pulling
 * in the agent SDK. Never throws — an unprobeable machine just declares the base.
 */
export async function refreshDeviceCapabilities(): Promise<string[]> {
  try {
    const { makeDeviceTools } = await import('./agent/device-tools.js')
    setDeviceCapabilities(makeDeviceTools().labels)
  } catch { /* no tools resolvable here — the base pair is still true */ }
  return deviceCapabilities()
}

/**
 * Enroll this machine as a device on the user's account. Idempotent-ish:
 * an existing valid identity is kept (heartbeat proves liveness) unless
 * force is set. Requires a logged-in TinyApi.
 */
export async function enrollDevice(api: TinyApi, opts?: { name?: string; kind?: string; force?: boolean }): Promise<DeviceIdentity> {
  const existing = loadDevice()
  if (existing && !opts?.force) {
    // Prove the token still works before trusting the file — the device
    // may have been revoked from the web UI
    if (await heartbeat(existing)) return existing
  }

  const r = await api.post('/api/devices', {
    name: opts?.name || defaultDeviceName(),
    platform: devicePlatform(),
    kind: opts?.kind || 'cli',
    // Whatever this process has already probed (agent.init publishes it); the
    // base pair otherwise. Heartbeats correct it within 30s either way, so
    // enroll stays a fast path and never drags in the agent SDK.
    capabilities: deviceCapabilities(),
  })
  if (r?.ok === false || !r?.device_id || !r?.device_token) {
    throw new Error(`device enroll failed: ${r?.error || 'unexpected response'}`)
  }

  const identity: DeviceIdentity = {
    version: 1,
    deviceId: r.device_id,
    token: r.device_token,
    name: opts?.name || defaultDeviceName(),
    apiUrl: api.baseUrl,
    enrolledAt: Math.floor(Date.now() / 1000),
  }
  saveDevice(identity)
  return identity
}

/** One heartbeat. Returns false on 401 (revoked/unknown) — caller decides. */
export async function heartbeat(d: DeviceIdentity, capabilities?: string[]): Promise<boolean> {
  try {
    const base = process.env.TINY_API_URL || d.apiUrl
    const res = await fetch(`${base}/api/devices/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: d.deviceId,
        token: d.token,
        ...(capabilities ? { capabilities } : {}),
      }),
    })
    if (res.status === 401) return false
    const data: any = await res.json().catch(() => ({}))
    return !!data.ok
  } catch {
    // Network blips are not revocation — treat as alive, retry next tick
    return true
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Background presence loop for long-lived processes (MCP serve, daemon).
 * Stops itself on revocation (401) and reports via onRevoked. unref'd —
 * never keeps the process alive on its own.
 */
export function startHeartbeatLoop(d: DeviceIdentity, onRevoked?: () => void): () => void {
  let stopped = false
  // Probe once at start; every beat then re-reads the live list, so an
  // integration connected mid-session reaches /devices at the next tick.
  void refreshDeviceCapabilities()
  const tick = async () => {
    if (stopped) return
    const alive = await heartbeat(d, deviceCapabilities())
    if (!alive) {
      stopped = true
      clearInterval(timer)
      onRevoked?.()
    }
  }
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS)
  timer.unref()
  void tick() // immediate first beat — presence dot goes green now, not in 30s
  return () => { stopped = true; clearInterval(timer) }
}
