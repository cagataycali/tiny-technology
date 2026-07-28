// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { applyStrandsEvent, applyMessageSurgery, MAP_TOOL_NAMES, type StrandsMessage } from '../lib/chat/strands-events'

const asst = (over: Partial<StrandsMessage> = {}): StrandsMessage =>
  ({ id: 'a1', role: 'assistant', content: '', ...over })
const base = () => [{ id: 'u1', role: 'user', content: 'hi' }, asst()]

const apply = (msgs: StrandsMessage[], event: any) => applyStrandsEvent(msgs, event, 'a1', 'the prompt')

describe('applyStrandsEvent — text/reasoning', () => {
  it('appends text deltas, including falsy-but-real "0"', () => {
    let r = apply(base(), { type: 'modelContentBlockDeltaEvent', textDelta: 'Hel' })
    r = apply(r.messages, { type: 'modelContentBlockDeltaEvent', textDelta: '0' })
    expect(r.messages[1].content).toBe('Hel0')
  })

  it('leaves other messages untouched by REFERENCE (memoization contract)', () => {
    const msgs = base()
    const r = apply(msgs, { type: 'modelContentBlockDeltaEvent', textDelta: 'x' })
    expect(r.messages[0]).toBe(msgs[0])
    expect(r.messages[1]).not.toBe(msgs[1])
  })

  it('separates a new model message from previous text with a blank line', () => {
    const r = apply([asst({ content: 'first' })], { type: 'modelMessageStartEvent' })
    expect(r.messages[0].content).toBe('first\n\n')
    // no separator on empty content or when already newline-terminated
    expect(apply([asst()], { type: 'modelMessageStartEvent' }).messages[0].content).toBe('')
    expect(apply([asst({ content: 'x\n' })], { type: 'modelMessageStartEvent' }).messages[0].content).toBe('x\n')
  })

  it('accumulates reasoning deltas separately from content', () => {
    const r = apply(base(), { type: 'modelContentBlockDeltaEvent', reasoningDelta: 'hmm' })
    expect(r.messages[1].reasoning).toBe('hmm')
    expect(r.messages[1].content).toBe('')
  })
})

describe('applyStrandsEvent — tool lifecycle (immutable)', () => {
  const start = { type: 'modelContentBlockStartEvent', toolStart: { toolUseId: 't1', name: 'get_weather' } }

  it('adds a calling tool once per toolUseId', () => {
    let r = apply(base(), start)
    r = apply(r.messages, start)
    expect(r.messages[1].toolCalls).toEqual([{ id: 't1', name: 'get_weather', status: 'calling' }])
  })

  it('captures input and result WITHOUT mutating the previous tool object', () => {
    const r1 = apply(base(), start)
    const toolBefore = r1.messages[1].toolCalls![0]
    const r2 = apply(r1.messages, { type: 'beforeToolCallEvent', toolCall: { toolUseId: 't1', name: 'get_weather', input: { q: 'sf' } } })
    expect(toolBefore.input).toBeUndefined() // old reference untouched
    expect(r2.messages[1].toolCalls![0].input).toEqual({ q: 'sf' })
    const r3 = apply(r2.messages, { type: 'afterToolCallEvent', toolResult: { toolUseId: 't1', content: 'sunny' } })
    expect(r2.messages[1].toolCalls![0].status).toBe('calling') // old reference untouched
    expect(r3.messages[1].toolCalls![0]).toMatchObject({ status: 'success', result: 'sunny' })
  })

  it('marks an errored tool result', () => {
    let r = apply(base(), start)
    r = apply(r.messages, { type: 'afterToolCallEvent', toolResult: { toolUseId: 't1', error: 'boom' } })
    expect(r.messages[1].toolCalls![0]).toMatchObject({ status: 'error', error: 'boom' })
  })
})

describe('applyStrandsEvent — client-side tools become effects', () => {
  const before = (name: string, input: any) =>
    ({ type: 'beforeToolCallEvent', toolCall: { toolUseId: 't1', name, input } })

  it('remember/forget → memory effects', () => {
    expect(apply(base(), before('remember', { content: 'likes tea', tags: ['pref'] })).effects)
      .toEqual([{ kind: 'memory-add', content: 'likes tea', tags: ['pref'] }])
    expect(apply(base(), before('forget', { match: 'tea' })).effects)
      .toEqual([{ kind: 'memory-forget', match: 'tea' }])
  })

  it('suggest_followups caps at 4 chips (pure message state, no effect)', () => {
    const r = apply(base(), before('suggest_followups', { chips: ['a', 'b', 'c', 'd', 'e'] }))
    expect(r.messages[1].followups).toEqual(['a', 'b', 'c', 'd'])
    expect(r.effects).toEqual([])
  })

  it('every map tool routes to a map effect', () => {
    for (const name of MAP_TOOL_NAMES) {
      const r = apply(base(), before(name, { lat: 1 }))
      expect(r.effects).toEqual([{ kind: 'map', name, input: { lat: 1 } }])
    }
  })

  it('manage_messages/customize_page pass their input through as effects', () => {
    expect(apply(base(), before('manage_messages', { action: 'drop', from: 1, to: 2 })).effects[0])
      .toEqual({ kind: 'message-surgery', input: { action: 'drop', from: 1, to: 2 } })
    expect(apply(base(), before('customize_page', { css: 'body{}' })).effects[0])
      .toEqual({ kind: 'customize-page', input: { css: 'body{}' } })
  })

  it('set_theme: reset and the tiny preset emit; an unresolvable theme does not', () => {
    expect(apply(base(), before('set_theme', { reset: true })).effects)
      .toEqual([{ kind: 'set-theme', theme: null }])
    expect(apply(base(), before('set_theme', { preset: 'tiny' })).effects[0]?.kind).toBe('set-theme')
    expect(apply(base(), before('set_theme', { preset: 'no-such-preset' })).effects).toEqual([])
  })

  it('speak adds a playback card AND an autoplay effect', () => {
    const r = apply(base(), before('speak', { text: 'hello', voice: 'nova' }))
    expect(r.messages[1].speech).toEqual([{ id: 't1', text: 'hello', voice: 'nova' }])
    expect(r.effects).toEqual([{ kind: 'speak', id: 't1', text: 'hello', voice: 'nova' }])
  })

  it('render_ui appends a component (pure, no effect)', () => {
    const r = apply(base(), before('render_ui', { componentCode: 'code', title: 'T' }))
    expect(r.messages[1].uiComponents).toEqual([{ id: 't1', componentCode: 'code', props: undefined, title: 'T' }])
    expect(r.effects).toEqual([])
  })
})

describe('applyStrandsEvent — usage + errors', () => {
  it('accumulates usage across model calls and keeps the modelId', () => {
    let r = apply(base(), { type: 'modelMetadataEvent', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, modelId: 'm1' })
    r = apply(r.messages, { type: 'modelMetadataEvent', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadInputTokens: 7 } })
    expect(r.messages[1].usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadInputTokens: 7 })
    expect(r.messages[1].modelId).toBe('m1')
  })

  it('error events append the warning, remember the prompt, and log', () => {
    const r = apply([asst({ content: 'part' })], { type: 'error', error: 'provider down' })
    expect(r.messages[0].content).toBe('part\n\n⚠️ provider down')
    expect(r.messages[0].failedPrompt).toBe('the prompt')
    expect(r.effects).toEqual([{ kind: 'log-error', error: 'provider down' }])
  })
})

describe('applyMessageSurgery', () => {
  const mk = (content: string) => ({ id: 'sum', content })
  const five = () => [
    { id: '1', content: 'aaaa' }, { id: '2', content: 'bb' }, { id: '3', content: '' },
    { id: 'live', content: 'streaming' }, { id: '5', content: 'e' },
  ]

  it('stats reports counts without changing the list', () => {
    const r = applyMessageSurgery(five(), { action: 'stats' }, 'live', mk)
    expect(r.messages).toBeNull()
    expect(r.note).toBe('✂️ 5 messages, ~0.0K chars')
  })

  it('drop removes the 1-based range but never the protected message', () => {
    const r = applyMessageSurgery(five(), { action: 'drop', from: 3, to: 5 }, 'live', mk)
    expect(r.messages!.map((m) => m.id)).toEqual(['1', '2', 'live'])
    expect(r.note).toBe('✂️ Dropped 3 messages')
  })

  it('compact replaces the range with a summary at `from`, keeping the protected message', () => {
    const r = applyMessageSurgery(five(), { action: 'compact', from: 1, to: 4, summary: 'intro' }, 'live', mk)
    expect(r.messages!.map((m) => m.id)).toEqual(['sum', 'live', '5'])
    expect(r.messages![0].content).toBe('📜 Compacted (1-4): intro')
  })

  it('rejects an invalid range; compact without a summary is silent', () => {
    expect(applyMessageSurgery(five(), { action: 'drop', from: 4, to: 2 }, 'live', mk))
      .toEqual({ messages: null, note: '✂️ Invalid range', error: true })
    expect(applyMessageSurgery(five(), { action: 'compact', from: 1, to: 2 }, 'live', mk))
      .toEqual({ messages: null, note: '' })
  })
})
