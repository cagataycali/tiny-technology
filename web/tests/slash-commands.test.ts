// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { trySlashCommand, type SlashDeps } from '../lib/chat/slash-commands'

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeDeps(over: Partial<SlashDeps> = {}): SlashDeps & { shown: string[]; errors: string[] } {
  const shown: string[] = []
  const errors: string[] = []
  return {
    shown,
    errors,
    name: 'scout',
    getMessages: () => [],
    setMessages: vi.fn(),
    buildSystemMessage: () => ({ id: '0', role: 'system', content: 'sys' }),
    reconcileInterruptedTools: (m) => m,
    streamingCount: () => 0,
    toast: { show: (m: string) => { shown.push(m) }, error: (m: string) => { errors.push(m) } },
    confirm: vi.fn(async () => true),
    openPanel: vi.fn(),
    navigate: vi.fn(),
    downloadFile: vi.fn(),
    clearConversation: vi.fn(),
    share: vi.fn(),
    startLiveCall: vi.fn(),
    startAutonomous: vi.fn(async () => ({ text: 'findings', stopped: false })),
    getInput: () => '',
    setInput: vi.fn(),
    getMemories: () => [],
    // Both report whether the removal landed (v13 G2) — a bare `vi.fn()`
    // returns undefined, which now MEANS "the wipe failed".
    clearLocalMemories: vi.fn(() => true),
    clearTurnLog: vi.fn(() => true),
    downloadArchive: vi.fn(),
    pickAndLoadArchive: vi.fn(async () => ({ tiny: 'scout', exported: '2026-07-25T00:00:00Z', messages: [] })),
    estimateCost: () => null,
    formatCost: (u) => `$${u.toFixed(4)}`,
    ...over,
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('trySlashCommand — contract', () => {
  it('passes non-commands through untouched (false = send to the model)', () => {
    const deps = makeDeps()
    expect(trySlashCommand('hello world', deps)).toBe(false)
    expect(trySlashCommand('  not/a/command', deps)).toBe(false)
    expect(deps.shown).toEqual([])
  })

  it('consumes unknown commands with a note + the palette (browsable recovery)', () => {
    const deps = makeDeps()
    expect(trySlashCommand('/wat', deps)).toBe(true)
    expect(deps.shown[0]).toBe('Unknown command: /wat')
    expect(deps.openPanel).toHaveBeenCalledWith('palette')
  })

  it('is case-insensitive on the command word', () => {
    const deps = makeDeps()
    expect(trySlashCommand('/CLEAR', deps)).toBe(true)
    expect(deps.clearConversation).toHaveBeenCalled()
  })
})

describe('trySlashCommand — routing', () => {
  it.each([
    ['/settings', 'settings'], ['/model', 'settings'], ['/memory', 'memory'],
    ['/jobs', 'jobs'], ['/wallet', 'wallet'], ['/palette', 'palette'], ['/help', 'palette'],
  ])('%s opens the %s panel', (cmd, panel) => {
    const deps = makeDeps()
    expect(trySlashCommand(cmd, deps)).toBe(true)
    expect(deps.openPanel).toHaveBeenCalledWith(panel)
  })

  it.each([
    ['/devices', '/devices'], ['/map', '/map'], ['/calls', '/calls'], ['/recordings', '/calls'],
  ])('%s navigates to %s', (cmd, path) => {
    const deps = makeDeps()
    trySlashCommand(cmd, deps)
    expect(deps.navigate).toHaveBeenCalledWith(path)
  })

  it('/voice and /call start the live call in-chat', () => {
    const deps = makeDeps()
    trySlashCommand('/voice', deps)
    trySlashCommand('/call', deps)
    expect(deps.startLiveCall).toHaveBeenCalledTimes(2)
  })
})

describe('/export', () => {
  it('builds a titled, dated markdown document with named speakers', () => {
    const deps = makeDeps({
      getMessages: () => [
        { id: '0', role: 'system', content: 'sys' },
        { id: '1', role: 'user', content: 'hi' },
        { id: '2', role: 'assistant', content: 'hello!' },
      ],
    })
    trySlashCommand('/export', deps)
    const [filename, doc] = (deps.downloadFile as any).mock.calls[0]
    expect(filename).toMatch(/^scout-conversation-\d{4}-\d{2}-\d{2}\.md$/)
    expect(doc).toContain('# Conversation with scout')
    expect(doc).toContain('**you**: hi')
    expect(doc).toContain('**scout**: hello!')
    expect(doc).not.toContain('sys') // system seed is not part of the document
  })
})

describe('/cost', () => {
  it('sums tokens and prices only the turns it can price', () => {
    const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o })
    const deps = makeDeps({
      getMessages: () => [
        { id: '1', role: 'assistant', content: '', usage: usage(900, 200), modelId: 'm1' },
        { id: '2', role: 'assistant', content: '', usage: usage(50, 50) }, // unpriced
      ],
      estimateCost: (modelId) => (modelId === 'm1' ? 0.01 : null),
    })
    trySlashCommand('/cost', deps)
    expect(deps.shown[0]).toBe('📊 2 turns · 1.2K tok (950 in / 250 out) · ~$0.0100 (1/2 turns priced)')
  })
})

describe('/auto — c70: no ending is silent, and a failure is retryable', () => {
  it('usage note when the task is missing — nothing is started', () => {
    const deps = makeDeps()
    expect(trySlashCommand('/auto', deps)).toBe(true)
    expect(deps.shown[0]).toContain('Usage: /auto')
    expect(deps.startAutonomous).not.toHaveBeenCalled()
  })

  it('announces the run and passes only the task text to the runner', async () => {
    const deps = makeDeps()
    trySlashCommand('/auto research edge caching', deps)
    expect(deps.shown[0]).toContain('working in the background')
    expect((deps.startAutonomous as any).mock.calls[0][0]).toBe('research edge caching')
    await tick()
    expect(deps.shown[1]).toContain('findings arrive with your next message')
    expect(deps.setInput).not.toHaveBeenCalled() // succeeded — nothing to retry
  })

  // THE DEFECT: explore() returns '' for every failure (HTTP 402/429/500, no
  // network). The old `if (last) toast(...)` announced nothing, while onSubmit
  // had already cleared the composer — a dead chip and no text to retry from.
  it('an EMPTY result is reported as an error, not silence', async () => {
    const deps = makeDeps({ startAutonomous: vi.fn(async () => ({ text: '', stopped: false })) })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.errors.length).toBe(1)
    expect(deps.errors[0]).toContain('came back empty')
  })

  it('a failed run puts the WHOLE command back in the composer', async () => {
    const deps = makeDeps({ startAutonomous: vi.fn(async () => ({ text: '', stopped: false })) })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.setInput).toHaveBeenCalledWith('/auto do the thing')
  })

  it('ambient being OFF (undefined, no promise) is announced too', async () => {
    const deps = makeDeps({ startAutonomous: vi.fn(() => undefined) })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.errors[0]).toContain("isn't available")
    expect(deps.setInput).toHaveBeenCalledWith('/auto do the thing')
  })

  it('a REJECTED run is an ending, not an unhandled rejection', async () => {
    const deps = makeDeps({ startAutonomous: vi.fn(async () => { throw new Error('boom') }) })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.errors.length).toBe(1)
    expect(deps.setInput).toHaveBeenCalledWith('/auto do the thing')
  })

  it("the user's own stop is not an error and keeps partial findings", async () => {
    const deps = makeDeps({ startAutonomous: vi.fn(async () => ({ text: 'half', stopped: true })) })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.errors).toEqual([])
    expect(deps.shown[1]).toContain('stopped')
    expect(deps.setInput).not.toHaveBeenCalled()
  })

  // The composer is read LIVE at announce time, not captured at dispatch:
  // typing is what stops a run, so the common stopped case has text in it.
  it('does not clobber text typed while the run was going', async () => {
    let composer = ''
    const deps = makeDeps({
      startAutonomous: vi.fn(async () => { composer = 'a new question'; return { text: '', stopped: false } }),
      getInput: () => composer,
    })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.setInput).not.toHaveBeenCalled()
    expect(deps.errors[0]).toContain('Nothing was saved')
  })

  it('reports each iteration as it lands', async () => {
    const deps = makeDeps({
      startAutonomous: vi.fn(async (_t: string, onIter: (n: number) => void) => {
        onIter(1); onIter(2)
        return { text: 'done', stopped: false }
      }) as any,
    })
    trySlashCommand('/auto do the thing', deps)
    await tick()
    expect(deps.shown).toContain('🤖 Autonomous: iteration 1 done')
    expect(deps.shown).toContain('🤖 Autonomous: iteration 2 done')
  })
})

describe('/save', () => {
  it('refuses to snapshot mid-stream', () => {
    const deps = makeDeps({ streamingCount: () => 2 })
    trySlashCommand('/save', deps)
    expect(deps.shown[0]).toContain('Wait for the streaming replies')
    expect(deps.downloadArchive).not.toHaveBeenCalled()
  })

  it('downloads locally without the system seed', () => {
    const deps = makeDeps({
      getMessages: () => [{ id: '0', role: 'system', content: 's' }, { id: '1', role: 'user', content: 'q' }],
    })
    trySlashCommand('/save', deps)
    expect(deps.downloadArchive).toHaveBeenCalledWith('scout', [{ id: '1', role: 'user', content: 'q' }])
  })
})

describe('/loop schedule parsing', () => {
  const jobsBody = async (cmd: string) => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', spy)
    trySlashCommand(cmd, makeDeps())
    await tick()
    return JSON.parse((spy.mock.calls[0] as any)[1].body)
  }

  it('parses an explicit interval', async () => {
    expect((await jobsBody('/loop 30m check the deploy')).schedule).toBe('*/30m')
    expect((await jobsBody('/loop 2h check')).schedule).toBe('*/2h')
  })

  it('defaults to every 5 minutes and keeps the whole prompt', async () => {
    const body = await jobsBody('/loop watch the queue')
    expect(body.schedule).toBe('*/5m')
    expect(body.prompt).toBe('watch the queue')
  })

  it('a lone interval-looking word is the PROMPT, not an interval', async () => {
    const body = await jobsBody('/loop 30m')
    expect(body.schedule).toBe('*/5m')
    expect(body.prompt).toBe('30m')
  })
})

describe('destructive commands gate behind the async confirm', () => {
  it('/forgetall wipes only after confirm resolves true', async () => {
    const deps = makeDeps()
    expect(trySlashCommand('/forgetall', deps)).toBe(true) // consumed synchronously
    await tick()
    expect(deps.clearLocalMemories).toHaveBeenCalledWith('scout')
    expect(deps.clearTurnLog).toHaveBeenCalledWith('scout')
  })

  it('/forgetall does nothing when the user cancels', async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => false) })
    trySlashCommand('/forgetall', deps)
    await tick()
    expect(deps.clearLocalMemories).not.toHaveBeenCalled()
  })

  it('/forgetall claims a wipe only when BOTH wipes landed', async () => {
    const deps = makeDeps()
    trySlashCommand('/forgetall', deps)
    await tick()
    expect(deps.shown).toEqual(['🧠 All memories + turn log wiped'])
    expect(deps.errors).toEqual([])
  })

  it('🔴 /forgetall attempts the SECOND wipe even when the first fails', async () => {
    // The old code let `removeItem`'s SecurityError (site data blocked) throw
    // out of the async IIFE: the turn log was never touched, the toast never
    // fired, and the user saw nothing at all.
    const deps = makeDeps({ clearLocalMemories: vi.fn(() => false) })
    trySlashCommand('/forgetall', deps)
    await tick()
    expect(deps.clearTurnLog).toHaveBeenCalledWith('scout')
    expect(deps.shown).toEqual([])
    expect(deps.errors[0]).toContain('some memories are still there')
  })

  it('🔴 a failed TURN-LOG wipe is reported too, not just the memories', async () => {
    // The half that a `if (!memsWiped) …` guard would miss.
    const deps = makeDeps({ clearTurnLog: vi.fn(() => false) })
    trySlashCommand('/forgetall', deps)
    await tick()
    expect(deps.clearLocalMemories).toHaveBeenCalledWith('scout')
    expect(deps.shown).toEqual([])
    expect(deps.errors[0]).toContain('still there')
  })
})

describe('/load', () => {
  it('restores a local archive through reconcile + the system seed', async () => {
    const restored = [{ id: 'x', role: 'user', content: 'old' }]
    const deps = makeDeps({
      pickAndLoadArchive: vi.fn(async () => ({ tiny: 'scout', exported: '2026-07-20T00:00:00Z', messages: restored })),
    })
    trySlashCommand('/load', deps)
    await tick()
    expect(deps.setMessages).toHaveBeenCalledWith([{ id: '0', role: 'system', content: 'sys' }, ...restored])
    expect(deps.shown[0]).toBe('📂 Restored 1 messages from scout (2026-07-20)')
  })

  it('asks before replacing a live conversation and aborts on cancel', async () => {
    const deps = makeDeps({
      getMessages: () => [{ id: '1', role: 'user', content: 'live' }],
      confirm: vi.fn(async () => false),
    })
    trySlashCommand('/load', deps)
    await tick()
    expect(deps.confirm).toHaveBeenCalled()
    expect(deps.setMessages).not.toHaveBeenCalled()
  })
})

describe('/archives', () => {
  it('falls through to the cloud list when not deleting', async () => {
    const spy = vi.fn(async (..._args: unknown[]) => ({ ok: true, json: async () => ({ archives: [] }) }))
    vi.stubGlobal('fetch', spy)
    const deps = makeDeps()
    expect(trySlashCommand('/archives', deps)).toBe(true)
    await tick()
    expect(String(spy.mock.calls[0]?.[0])).toBe('/api/archives')
    expect(deps.shown[0]).toContain('No cloud archives yet')
  })
})
