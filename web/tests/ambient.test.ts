// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// ── Browser stubs (before import) ───────────────────────────────────────────
const sstore = new Map<string, string>()
;(globalThis as any).sessionStorage = {
  getItem: (k: string) => (sstore.has(k) ? sstore.get(k)! : null),
  setItem: (k: string, v: string) => { sstore.set(k, String(v)) },
  removeItem: (k: string) => { sstore.delete(k) },
}
;(globalThis as any).window = globalThis

import { AmbientRunner, consumeAmbientFindings, getAmbientFindings, AMBIENT_IDLE_MS } from '../components/chat/ambient'

// SSE body streaming a single text delta then closing
function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'modelContentBlockDeltaEvent', textDelta: text })}\n\n`))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
  return new Response(body, { status: 200 })
}

const mkRunner = (over: Partial<ConstructorParameters<typeof AmbientRunner>[0]> = {}) =>
  new AmbientRunner({
    tinyName: 'test',
    getLastTopic: () => 'the topic',
    isStreaming: () => false,
    headers: () => ({}),
    ...over,
  })

beforeEach(() => { sstore.clear(); vi.useFakeTimers() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('hidden-tab gating (c34)', () => {
  // A controllable document stub — node env has none, so the runner's
  // `typeof document !== "undefined"` guard is exercised both ways.
  type Listener = () => void
  function stubDocument(hidden: boolean) {
    const listeners = new Set<Listener>()
    const doc = {
      hidden,
      addEventListener: (_t: string, l: Listener) => listeners.add(l),
      removeEventListener: (_t: string, l: Listener) => listeners.delete(l),
      wake() { doc.hidden = false; listeners.forEach((l) => l()) },
      listenerCount: () => listeners.size,
    }
    ;(globalThis as any).document = doc
    return doc
  }
  afterEach(() => { delete (globalThis as any).document })

  it('does not spend while the tab is hidden — parks on visibilitychange', async () => {
    const doc = stubDocument(true)
    const fetchSpy = vi.fn(async () => sseResponse('finding'))
    vi.stubGlobal('fetch', fetchSpy)
    const r = mkRunner()
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS)
    expect(fetchSpy).not.toHaveBeenCalled() // no turn, no budget slot burned
    expect(doc.listenerCount()).toBe(1)     // parked, not dead
    expect(r.state).toBe('idle-wait')
  })

  it('a wake re-arms the FULL idle window, then runs', async () => {
    const doc = stubDocument(true)
    const fetchSpy = vi.fn(async () => sseResponse('finding'))
    vi.stubGlobal('fetch', fetchSpy)
    const r = mkRunner()
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS)
    doc.wake()
    expect(fetchSpy).not.toHaveBeenCalled() // waking is not idling
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(doc.listenerCount()).toBe(0) // the parked listener consumed itself
  })

  it('cancel() while parked drops the visibility listener', async () => {
    const doc = stubDocument(true)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('x')))
    const r = mkRunner()
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS)
    expect(doc.listenerCount()).toBe(1)
    r.cancel()
    expect(doc.listenerCount()).toBe(0) // no stale re-arm after unmount
  })

  it('a visible tab runs exactly as before', async () => {
    stubDocument(false)
    const fetchSpy = vi.fn(async () => sseResponse('finding'))
    vi.stubGlobal('fetch', fetchSpy)
    mkRunner().poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('findings buffer', () => {
  it('consume returns and clears (per-tiny key)', () => {
    sstore.set('tiny_ambient_findings:test', 'a finding')
    expect(consumeAmbientFindings('test')).toBe('a finding')
    expect(getAmbientFindings('test')).toBe('')
  })

  it('findings are namespaced per tiny — no cross-tiny bleed', () => {
    sstore.set('tiny_ambient_findings:alpha', 'alpha thought')
    // consuming tiny beta must NOT see alpha's buffered finding
    expect(consumeAmbientFindings('beta')).toBe('')
    expect(getAmbientFindings('alpha')).toBe('alpha thought')
    expect(consumeAmbientFindings('alpha')).toBe('alpha thought')
  })
})

describe('AmbientRunner state machine', () => {
  it('poke() arms idle-wait; run fires after AMBIENT_IDLE_MS and stores findings', async () => {
    global.fetch = vi.fn(async () => sseResponse('an insight')) as any
    const states: string[] = []
    const r = mkRunner({ onStateChange: (s) => states.push(s) })

    r.poke()
    expect(states[states.length - 1]).toBe('idle-wait')

    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(getAmbientFindings('test')).toBe('an insight')
    expect(states).toContain('running')
    expect(states[states.length - 1]).toBe('cooldown')
  })

  it('no topic → off, timer never armed', () => {
    global.fetch = vi.fn() as any
    const r = mkRunner({ getLastTopic: () => null })
    r.poke()
    vi.advanceTimersByTime(AMBIENT_IDLE_MS * 2)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('typing (poke) during idle-wait re-arms instead of firing early', async () => {
    global.fetch = vi.fn(async () => sseResponse('x')) as any
    const r = mkRunner()
    r.poke()
    vi.advanceTimersByTime(AMBIENT_IDLE_MS - 1000)
    r.poke() // user typed — reset the countdown
    vi.advanceTimersByTime(2000) // past the ORIGINAL deadline
    expect(global.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('cooldown blocks re-arming; session cap (3) blocks permanently', async () => {
    global.fetch = vi.fn(async () => sseResponse('x')) as any
    const r = mkRunner()

    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    // Immediately after a run we're in cooldown — poke arms nothing
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    // Session cap: count is already 1; simulate reaching the cap
    sstore.set('tiny_ambient_count:test', '3')
    await vi.advanceTimersByTimeAsync(5 * 60_000) // cooldown expires
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('autonomous /auto iterations do NOT consume the idle session budget', async () => {
    // /auto is capped separately (MAX_AUTONOMOUS_ITER); it must not bump the
    // idle counter, or one /auto run would blow past MAX_PER_SESSION (3) and
    // silently kill idle ambient for the rest of the session.
    global.fetch = vi.fn(async () => sseResponse('progress')) as any
    const r = mkRunner()

    // Run autonomous to completion (agent never emits DONE → hits the iter cap)
    const out = await r.startAutonomous('do the thing')
    expect(out.text).toBe('progress')
    expect((global.fetch as any).mock.calls.length).toBeGreaterThan(1) // multiple iters

    // The idle counter must be untouched by the autonomous run
    expect(sstore.get('tiny_ambient_count:test')).toBeUndefined()

    // And idle ambient must still arm + fire (cooldown from /auto aside): after
    // the cooldown lapses, a poke still schedules and runs an idle exploration,
    // incrementing the idle counter exactly once.
    const idleCallsBefore = (global.fetch as any).mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * 60_000) // /auto set a cooldown; let it lapse
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect((global.fetch as any).mock.calls.length).toBe(idleCallsBefore + 1)
    expect(sstore.get('tiny_ambient_count:test')).toBe('1') // idle path metered once
  })

  // c70: /auto is an EXPLICIT request, so its caller has to tell "you stopped
  // it" from "the provider refused". explore() answers '' to both.
  it('startAutonomous reports WHETHER it was stopped, not just its text', async () => {
    global.fetch = vi.fn(async () => sseResponse('work')) as any
    const ran = await mkRunner().startAutonomous('t')
    expect(ran).toEqual({ text: 'work', stopped: false })

    // A failing provider: same empty text a cancel produces, different cause.
    global.fetch = vi.fn(async () => new Response('nope', { status: 402 })) as any
    const failed = await mkRunner().startAutonomous('t')
    expect(failed).toEqual({ text: '', stopped: false })

    // cancel() mid-run (typing) — stopped, and it stops asking.
    global.fetch = vi.fn(async () => sseResponse('work')) as any
    const r = mkRunner()
    const p = r.startAutonomous('t')
    r.cancel()
    const stopped = await p
    expect(stopped.stopped).toBe(true)
    expect((global.fetch as any).mock.calls.length).toBe(1) // no further iterations
  })

  it('cancel() aborts a scheduled run', async () => {
    global.fetch = vi.fn(async () => sseResponse('x')) as any
    const r = mkRunner()
    r.poke()
    r.cancel()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS * 2)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips firing while a real stream is active (defers via re-poke)', async () => {
    global.fetch = vi.fn(async () => sseResponse('x')) as any
    let streaming = true
    const r = mkRunner({ isStreaming: () => streaming })
    r.poke()
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect(global.fetch).not.toHaveBeenCalled() // deferred, re-armed

    streaming = false
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 10)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
