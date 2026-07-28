// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { normalizeAgentEvent, isDeliveredOutput } from '../lib/chat/events'

const MODEL = 'test-model-id'
const wrap = (inner: any) => ({ type: 'modelStreamUpdateEvent', event: inner })

describe('normalizeAgentEvent — model stream', () => {
  it('text deltas pass through, including falsy-but-real "0"', () => {
    expect(normalizeAgentEvent(wrap({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'hi' } }), MODEL))
      .toEqual({ type: 'modelContentBlockDeltaEvent', textDelta: 'hi' })
    expect(normalizeAgentEvent(wrap({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: '0' } }), MODEL))
      .toEqual({ type: 'modelContentBlockDeltaEvent', textDelta: '0' })
    // empty string is a real delta too (the falsy-delta bug)
    expect(normalizeAgentEvent(wrap({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: '' } }), MODEL))
      .toEqual({ type: 'modelContentBlockDeltaEvent', textDelta: '' })
  })

  it('reasoning and tool-input deltas map to their fields', () => {
    expect(normalizeAgentEvent(wrap({ type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'think' } }), MODEL))
      .toEqual({ type: 'modelContentBlockDeltaEvent', reasoningDelta: 'think' })
    expect(normalizeAgentEvent(wrap({ type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"a"' } }), MODEL))
      .toEqual({ type: 'modelContentBlockDeltaEvent', toolInputDelta: '{"a"' })
  })

  it('tool start carries name + id; message stop carries stopReason', () => {
    expect(normalizeAgentEvent(wrap({ type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'http', toolUseId: 't1' } }), MODEL))
      .toEqual({ type: 'modelContentBlockStartEvent', toolStart: { name: 'http', toolUseId: 't1' } })
    expect(normalizeAgentEvent(wrap({ type: 'modelMessageStopEvent', stopReason: 'endTurn' }), MODEL))
      .toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
  })

  it('metadata gets the resolved model id stamped on', () => {
    const out = normalizeAgentEvent(wrap({ type: 'modelMetadataEvent', usage: { totalTokens: 5 } }), MODEL)
    expect(out).toMatchObject({ type: 'modelMetadataEvent', modelId: MODEL })
  })

  it('empty wrapper and unknown inner types drop to null', () => {
    expect(normalizeAgentEvent({ type: 'modelStreamUpdateEvent' }, MODEL)).toBeNull()
    expect(normalizeAgentEvent(wrap({ type: 'someFutureEvent' }), MODEL)).toBeNull()
  })
})

describe('normalizeAgentEvent — tool + agent lifecycle', () => {
  it('before/after tool calls carry ids, inputs, results, errors', () => {
    expect(normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: 'http', toolUseId: 't1', input: { url: 'x' } } }, MODEL))
      .toEqual({ type: 'beforeToolCallEvent', toolCall: { name: 'http', toolUseId: 't1', input: { url: 'x' } } })

    const after = normalizeAgentEvent({
      type: 'afterToolCallEvent',
      toolUse: { name: 'http', toolUseId: 't1' },
      result: { status: 'error', content: [{ text: 'boom' }] },
      error: new Error('fail'),
    }, MODEL)
    expect(after).toMatchObject({ type: 'afterToolCallEvent', toolResult: { status: 'error', error: 'fail' } })
  })

  it('toolUseId falls back to result when toolUse is absent', () => {
    const out = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'r9', status: 'success' } }, MODEL)
    expect((out as any).toolResult.toolUseId).toBe('r9')
  })

  it('unknown top-level events forward as type-only markers', () => {
    expect(normalizeAgentEvent({ type: 'messageAddedEvent', payload: { huge: 'x'.repeat(9999) } }, MODEL))
      .toEqual({ type: 'messageAddedEvent' })
    expect(normalizeAgentEvent({}, MODEL)).toBeNull()
    expect(normalizeAgentEvent(null, MODEL)).toBeNull()
  })
})

/**
 * 🏷️ THE TOOL-NAME FALLBACK (loop item p-a).
 *
 * The gaps report ranked "fragile event keying" as cause 3 of the iOS payment UI
 * never appearing: iOS detects a quote with
 * `afterToolCallEvent.toolResult.name == "pay_x402"` and drops the ENTIRE branch
 * when the name is absent (`if let n = tr["name"]`), while web survives because
 * it keys off the toolUseId it captured at the BEFORE event. `toolUseId` already
 * had a `?? e.result?.toolUseId` fallback here; `name` had none.
 *
 * So the server now remembers the pairing the before/start event always carries
 * and resolves it at the result — giving natives the same robustness web had.
 */
describe('normalizeAgentEvent — the tool-name fallback', () => {
  it('names a result whose toolUse is missing, from the BEFORE event', () => {
    const names = new Map<string, string>()
    normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: 'pay_x402', toolUseId: 'tu-1', input: {} } }, MODEL, names)
    // The SDK omitted toolUse on the after event — the exact shape that made the
    // iOS quote card silently never render.
    const after = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'tu-1', status: 'success', content: [] } }, MODEL, names)
    expect((after as any).toolResult).toMatchObject({ name: 'pay_x402', toolUseId: 'tu-1' })
  })

  it('learns the pairing from toolUseStart too (before-event may never fire)', () => {
    const names = new Map<string, string>()
    normalizeAgentEvent(wrap({ type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'spawn_agents', toolUseId: 'tu-2' } }), MODEL, names)
    const after = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'tu-2', status: 'success' } }, MODEL, names)
    expect((after as any).toolResult.name).toBe('spawn_agents')
  })

  it('the SDK-provided name always WINS over the remembered one', () => {
    // The fallback must never rewrite a name the SDK actually sent.
    const names = new Map<string, string>([['tu-3', 'stale']])
    const after = normalizeAgentEvent({ type: 'afterToolCallEvent', toolUse: { name: 'http', toolUseId: 'tu-3' }, result: { status: 'success' } }, MODEL, names)
    expect((after as any).toolResult.name).toBe('http')
  })

  it('progress frames get the same fallback — they route by name mid-tool', () => {
    const names = new Map<string, string>()
    normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: 'use_device', toolUseId: 'tu-4', input: {} } }, MODEL, names)
    const upd = normalizeAgentEvent({ type: 'toolStreamUpdateEvent', toolUse: { toolUseId: 'tu-4' }, event: { pct: 50 } }, MODEL, names)
    expect((upd as any).toolStream).toMatchObject({ name: 'use_device', toolUseId: 'tu-4' })
  })

  it('names never cross between tool calls', () => {
    const names = new Map<string, string>()
    normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: 'pay_x402', toolUseId: 'tu-a', input: {} } }, MODEL, names)
    normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: 'http', toolUseId: 'tu-b', input: {} } }, MODEL, names)
    const a = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'tu-a' } }, MODEL, names)
    const b = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'tu-b' } }, MODEL, names)
    expect((a as any).toolResult.name).toBe('pay_x402')
    expect((b as any).toolResult.name).toBe('http')
    // An id we never saw stays undefined rather than borrowing a neighbor's name —
    // a WRONG name would render the wrong card, worse than none.
    const c = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'tu-never' } }, MODEL, names)
    expect((c as any).toolResult.name).toBeUndefined()
  })

  it('works without a registry at all (the parameter is optional)', () => {
    // Any caller that doesn't pass one keeps the exact previous behavior.
    const out = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'x', status: 'success' } }, MODEL)
    expect((out as any).toolResult).toMatchObject({ toolUseId: 'x', name: undefined })
  })

  it('a missing toolUseId cannot poison the registry or the lookup', () => {
    const names = new Map<string, string>()
    normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: 'ghost' } }, MODEL, names)
    expect(names.size).toBe(0)
    const after = normalizeAgentEvent({ type: 'afterToolCallEvent', result: { status: 'success' } }, MODEL, names)
    expect((after as any).toolResult.name).toBeUndefined()
  })

  it('the registry is bounded — a runaway loop cannot grow it without limit', () => {
    const names = new Map<string, string>()
    for (let i = 0; i < 600; i++) {
      normalizeAgentEvent({ type: 'beforeToolCallEvent', toolUse: { name: `t${i}`, toolUseId: `id-${i}` } }, MODEL, names)
    }
    expect(names.size).toBeLessThanOrEqual(512)
    // Early entries are KEPT rather than evicted: eviction could drop the very
    // pairing a still-pending result needs.
    expect(names.get('id-0')).toBe('t0')
  })

  it('still counts as delivered output — the refund gate is unaffected', () => {
    const names = new Map<string, string>([['tu-5', 'pay_x402']])
    expect(isDeliveredOutput(normalizeAgentEvent({ type: 'afterToolCallEvent', result: { toolUseId: 'tu-5', status: 'success' } }, MODEL, names))).toBe(true)
  })
})

describe('isDeliveredOutput — the paid-turn refund gate', () => {
  const norm = (inner: any) => normalizeAgentEvent(wrap(inner), MODEL)

  it('non-empty text/reasoning counts as delivery', () => {
    expect(isDeliveredOutput(norm({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'hi' } }))).toBe(true)
    expect(isDeliveredOutput(norm({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: '0' } }))).toBe(true)
    expect(isDeliveredOutput(norm({ type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'think' } }))).toBe(true)
  })

  it('a completed tool call is delivered work', () => {
    expect(isDeliveredOutput(normalizeAgentEvent({ type: 'afterToolCallEvent', toolUse: { name: 'http', toolUseId: 't1' }, result: { status: 'success', content: [] } }, MODEL))).toBe(true)
  })

  it('empty deltas, tool-input deltas, metadata, lifecycle markers, and null do NOT count', () => {
    // An empty text delta is a real wire event but delivers nothing readable —
    // a turn that only emitted these is still refundable.
    expect(isDeliveredOutput(norm({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: '' } }))).toBe(false)
    // Tool INPUT deltas are the model typing a call it may never complete.
    expect(isDeliveredOutput(norm({ type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"a"' } }))).toBe(false)
    expect(isDeliveredOutput(norm({ type: 'modelMetadataEvent', usage: { inputTokens: 5 } }))).toBe(false)
    expect(isDeliveredOutput(norm({ type: 'modelMessageStartEvent' }))).toBe(false)
    expect(isDeliveredOutput({ type: 'beforeToolCallEvent', toolCall: { name: 'http' } })).toBe(false)
    expect(isDeliveredOutput(null)).toBe(false)
  })
})
