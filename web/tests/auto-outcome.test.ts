// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { announceAutoResult, type AutoOutcomeInput } from '../lib/chat/auto-outcome'

const CMD = '/auto research edge caching strategies'

const input = (over: Partial<AutoOutcomeInput> = {}): AutoOutcomeInput => ({
  command: CMD,
  result: { text: 'findings', stopped: false },
  currentInput: '',
  ...over,
})

describe('announceAutoResult — every ending is announced', () => {
  // The defect: the old call site was `if (last) toast(...)`, so the empty
  // result — the shape of EVERY failure inside explore() — said nothing.
  it.each([
    ['never started (ambient off)', { result: undefined }],
    ['ran out and produced nothing', { result: { text: '', stopped: false } }],
    ['stopped with nothing', { result: { text: '', stopped: true } }],
    ['stopped with partials', { result: { text: 'half', stopped: true } }],
    ['finished with findings', { result: { text: 'findings', stopped: false } }],
  ] as [string, Partial<AutoOutcomeInput>][])('%s still gets a message', (_label, over) => {
    const say = announceAutoResult(input(over))
    expect(say.message.trim().length).toBeGreaterThan(0)
  })

  it('distinguishes the five endings — no two share wording', () => {
    const messages = [
      announceAutoResult(input({ result: undefined })),
      announceAutoResult(input({ result: { text: '', stopped: false } })),
      announceAutoResult(input({ result: { text: '', stopped: true } })),
      announceAutoResult(input({ result: { text: 'half', stopped: true } })),
      announceAutoResult(input({ result: { text: 'done', stopped: false } })),
    ].map((s) => s.message)
    expect(new Set(messages).size).toBe(5)
  })
})

describe('tone — only a real failure is an error', () => {
  it('a never-started run and an empty finish are errors', () => {
    expect(announceAutoResult(input({ result: undefined })).tone).toBe('error')
    expect(announceAutoResult(input({ result: { text: '', stopped: false } })).tone).toBe('error')
  })

  it("the user's own stop is NOT an error, with or without partials", () => {
    expect(announceAutoResult(input({ result: { text: '', stopped: true } })).tone).toBe('info')
    expect(announceAutoResult(input({ result: { text: 'half', stopped: true } })).tone).toBe('info')
  })

  it('a successful finish is info', () => {
    expect(announceAutoResult(input({ result: { text: 'done', stopped: false } })).tone).toBe('info')
  })
})

describe('restore — the retry path', () => {
  it('a failed run puts the WHOLE command back, not the bare task', () => {
    // '/auto ' included: retrying is Enter, not a retype-and-remember-the-prefix.
    expect(announceAutoResult(input({ result: undefined })).restore).toBe(CMD)
    expect(announceAutoResult(input({ result: { text: '', stopped: false } })).restore).toBe(CMD)
    expect(announceAutoResult(input({ result: { text: '', stopped: true } })).restore).toBe(CMD)
  })

  it('a run that PRODUCED something never restores — the work is not lost', () => {
    expect(announceAutoResult(input({ result: { text: 'done', stopped: false } })).restore).toBe(null)
    expect(announceAutoResult(input({ result: { text: 'half', stopped: true } })).restore).toBe(null)
  })

  it('never overwrites what the user has typed since (draftRestore rule)', () => {
    // Typing is what STOPS a run, so a non-empty composer is the common case
    // for the stopped endings specifically.
    for (const result of [undefined, { text: '', stopped: false }, { text: '', stopped: true }]) {
      const say = announceAutoResult(input({ result, currentInput: 'a new question' }))
      expect(say.restore).toBe(null)
    }
  })

  it('whitespace-only composer counts as empty — it still restores', () => {
    expect(announceAutoResult(input({ result: undefined, currentInput: '   \n ' })).restore).toBe(CMD)
  })

  it('a whitespace-only RESULT is nothing produced, not a success', () => {
    // ambient.ts happens to assign `lastText = text.trim()` today, so this can
    // only arrive from a future caller — which is exactly why a pure module
    // decides it here instead of trusting upstream.
    const say = announceAutoResult(input({ result: { text: '  \n\t ', stopped: false } }))
    expect(say.tone).toBe('error')
    expect(say.restore).toBe(CMD)
  })
})

describe('the message never promises a side effect that did not happen', () => {
  it('claims the composer only when it actually restored', () => {
    const restored = announceAutoResult(input({ result: { text: '', stopped: false } }))
    expect(restored.restore).toBe(CMD)
    expect(restored.message).toContain('composer')

    const blocked = announceAutoResult(input({ result: { text: '', stopped: false }, currentInput: 'typing' }))
    expect(blocked.restore).toBe(null)
    expect(blocked.message).not.toContain('composer')
    // …and says so, rather than going quiet about the text it dropped.
    expect(blocked.message).toContain('Nothing was saved')
  })

  it('holds for the never-started ending too', () => {
    expect(announceAutoResult(input({ result: undefined })).message).toContain('composer')
    expect(
      announceAutoResult(input({ result: undefined, currentInput: 'x' })).message
    ).not.toContain('composer')
  })

  // Invariant across the whole space: mentioning the composer and restoring
  // are the same fact. A future ending can't drift them apart.
  it.each([
    [undefined, ''],
    [undefined, 'typed'],
    [{ text: '', stopped: false }, ''],
    [{ text: '', stopped: false }, 'typed'],
    [{ text: '', stopped: true }, ''],
    [{ text: '', stopped: true }, 'typed'],
    [{ text: 'half', stopped: true }, ''],
    [{ text: 'done', stopped: false }, ''],
  ] as [AutoOutcomeInput['result'], string][])(
    'restore and the wording agree (%j, typed=%s)',
    (result, currentInput) => {
      const say = announceAutoResult(input({ result, currentInput }))
      const mentions = /composer|restored/i.test(say.message)
      expect(mentions).toBe(say.restore !== null)
    }
  )
})
