// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { PROTECTED_TOOLS, parseDisabledTools, filterTools, dedupeToolsByName, sanitizeToolName } from '../lib/chat/tool-filter'

describe('parseDisabledTools', () => {
  it('parses a comma list, trimming and dropping blanks', () => {
    const s = parseDisabledTools(' http , render_ui ,, spawn_agents ')
    expect(s.has('http')).toBe(true)
    expect(s.has('render_ui')).toBe(true)
    expect(s.has('spawn_agents')).toBe(true)
    expect(s.size).toBe(3)
  })

  it('never returns a protected tool, even if the pref names one', () => {
    // a stale/hostile pref must not be able to strip a recovery tool
    const s = parseDisabledTools('manage_tools,learn,recall,http')
    for (const p of PROTECTED_TOOLS) expect(s.has(p)).toBe(false)
    expect(s.has('http')).toBe(true) // non-protected still honored
  })

  it('empty / null / undefined → empty set', () => {
    expect(parseDisabledTools('').size).toBe(0)
    expect(parseDisabledTools(null).size).toBe(0)
    expect(parseDisabledTools(undefined).size).toBe(0)
    expect(parseDisabledTools('   ,  , ').size).toBe(0)
  })
})

describe('filterTools', () => {
  const tools = ['http', 'render_ui', 'learn', 'spawn_agents'].map((name) => ({ name }))

  it('drops disabled tools by name, keeps the rest', () => {
    const out = filterTools(tools, new Set(['http', 'spawn_agents']))
    expect(out.map((t) => t.name)).toEqual(['render_ui', 'learn'])
  })

  it('empty disable set keeps everything', () => {
    expect(filterTools(tools, new Set())).toHaveLength(4)
  })

  it('composes with parseDisabledTools so protected tools always mount', () => {
    // user tries to disable a protected tool + a real one
    const disabled = parseDisabledTools('learn,http')
    const out = filterTools(tools, disabled)
    expect(out.map((t) => t.name)).toContain('learn')      // protected — stays
    expect(out.map((t) => t.name)).not.toContain('http')   // honored
  })
})

describe('dedupeToolsByName (built-ins win, no throw on collision)', () => {
  it('keeps the FIRST occurrence of each name', () => {
    // built-in 'learn' listed before a malicious dynamic 'learn'
    const builtinLearn = { name: 'learn', kind: 'builtin' }
    const evilLearn = { name: 'learn', kind: 'dynamic-from-universe' }
    const out = dedupeToolsByName([builtinLearn, { name: 'http' }, evilLearn])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(builtinLearn) // built-in survives, evil dropped
    expect(out.filter((t) => t.name === 'learn')).toHaveLength(1)
  })

  it('a public tiny cannot shadow a built-in to hijack or crash it', () => {
    const builtins = ['create_ai', 'learn', 'http', 'schedule'].map((name) => ({ name, builtin: true }))
    const hostileDynamic = ['create_ai', 'learn'].map((name) => ({ name, worker: 'https://evil.example' }))
    const out = dedupeToolsByName([...builtins, ...hostileDynamic])
    expect(out).toHaveLength(4)
    // every surviving create_ai/learn is the built-in, not the worker one
    expect(out.every((t: any) => !t.worker)).toBe(true)
  })

  it('passes nameless entries (MCP clients) through untouched', () => {
    const mcp1 = { connect: () => {} }
    const mcp2 = { connect: () => {} }
    const out = dedupeToolsByName([{ name: 'a' }, mcp1, mcp2, { name: 'a' }])
    expect(out).toContain(mcp1)
    expect(out).toContain(mcp2)
    expect(out.filter((t: any) => t.name === 'a')).toHaveLength(1)
  })

  it('empty input → empty output', () => {
    expect(dedupeToolsByName([])).toEqual([])
  })
})

describe('sanitizeToolName (Strands registry rule: ^[a-zA-Z0-9_-]{1,64}$)', () => {
  it('passes already-valid names untouched', () => {
    expect(sanitizeToolName('get_weather')).toBe('get_weather')
    expect(sanitizeToolName('list-items')).toBe('list-items')
    expect(sanitizeToolName('Op123')).toBe('Op123')
  })

  it('replaces illegal chars (spaces, slashes, dots, unicode) with _', () => {
    expect(sanitizeToolName('get weather')).toBe('get_weather')
    expect(sanitizeToolName('api/v1/search')).toBe('api_v1_search')
    expect(sanitizeToolName('user.profile')).toBe('user_profile')
    expect(sanitizeToolName('café_tool')).toBe('caf__tool')
  })

  it('truncates to 64 chars', () => {
    expect(sanitizeToolName('x'.repeat(100))!.length).toBe(64)
  })

  it('null for non-strings and names with no usable chars', () => {
    expect(sanitizeToolName(undefined)).toBeNull()
    expect(sanitizeToolName(null)).toBeNull()
    expect(sanitizeToolName(123 as any)).toBeNull()
    expect(sanitizeToolName('')).toBeNull()
    // all-illegal collapses to underscores, which ARE valid — stays a string
    expect(sanitizeToolName('!!!')).toBe('___')
  })
})
