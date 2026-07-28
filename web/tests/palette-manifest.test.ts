// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trySlashCommand, PALETTE_COMMANDS, type SlashDeps } from '../lib/chat/slash-commands'

/**
 * The palette list and the slash dispatch are ONE artifact now — these tests
 * are the seam that keeps them from re-drifting in either direction.
 */

function stubDeps(): SlashDeps & { shown: string[] } {
  const shown: string[] = []
  return {
    shown,
    name: 'scout',
    getMessages: () => [],
    setMessages: vi.fn(),
    buildSystemMessage: () => ({ id: '0', role: 'system', content: 's' }),
    reconcileInterruptedTools: (m) => m,
    streamingCount: () => 0,
    toast: { show: (m: string) => shown.push(m), error: () => {} },
    confirm: vi.fn(async () => false), // never confirm — commands must still be consumed
    openPanel: vi.fn(),
    navigate: vi.fn(),
    downloadFile: vi.fn(),
    clearConversation: vi.fn(),
    share: vi.fn(),
    startLiveCall: vi.fn(),
    startAutonomous: vi.fn(async () => ({ text: 'x', stopped: false })),
    getInput: () => '',
    setInput: vi.fn(),
    getMemories: () => [],
    clearLocalMemories: vi.fn(),
    clearTurnLog: vi.fn(),
    downloadArchive: vi.fn(),
    pickAndLoadArchive: vi.fn(async () => ({ tiny: 'scout', exported: '', messages: [] })),
    estimateCost: () => null,
    formatCost: () => '$0',
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('palette → dispatch (every listed command really exists)', () => {
  for (const entry of PALETTE_COMMANDS) {
    if (entry.invoke.kind !== 'slash') continue
    const cmd = entry.invoke.command
    it(`"${entry.name}" (${cmd}) is consumed WITHOUT the unknown-command fallback`, () => {
      const deps = stubDeps()
      expect(trySlashCommand(cmd, deps)).toBe(true)
      expect(deps.shown.find((m) => m.startsWith('Unknown command'))).toBeUndefined()
    })
  }

  it('prefill entries are templates for the two argument-taking commands', () => {
    const prefills = PALETTE_COMMANDS.filter((c) => c.invoke.kind === 'prefill')
    expect(prefills.map((c) => c.name).sort()).toEqual(['auto', 'loop'])
    for (const p of prefills) {
      expect((p.invoke as { text: string }).text).toMatch(/^\/(auto|loop) $/)
    }
  })
})

describe('dispatch → palette (every case is listed or deliberately hidden)', () => {
  // Aliases and self-referential commands the palette intentionally omits:
  // help/palette OPEN the palette (useless from inside it), call/recordings
  // are aliases of voice//calls which are listed.
  const HIDDEN = new Set(['help', 'palette', 'call', 'recordings'])

  it('finds no dispatch case missing from the manifest', () => {
    const src = readFileSync(join(__dirname, '../lib/chat/slash-commands.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function trySlashCommand'))
    // Array.from, not spread — the repo's tsc target predates iterator spread
    const cases = Array.from(body.matchAll(/case '([a-z]+)':/g), (m) => m[1])
    expect(cases.length).toBeGreaterThan(20) // the switch is really there
    const covered = new Set(
      PALETTE_COMMANDS.flatMap((c) =>
        c.invoke.kind === 'slash'
          ? [c.invoke.command.slice(1).split(/\s+/)[0]]
          : [(c.invoke as { text: string }).text.slice(1).trim().split(/\s+/)[0]]),
    )
    const missing = cases.filter((c) => !covered.has(c) && !HIDDEN.has(c))
    expect(missing, `dispatch cases missing from PALETTE_COMMANDS: ${missing.join(', ')}`).toEqual([])
  })
})
