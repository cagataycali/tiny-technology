// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('upsert-merge')

let mergeUpsertPayload: (body: any, existing: any, owner: string, nextPrivate: boolean, canonicalName: string) => any
let normalizeLogo: (v: any) => string | undefined
let normalizeIntroVibe: (v: any) => string | undefined
let normalizeChips: (v: any) => string[] | '' | undefined
let normalizeTagline: (v: any) => string | undefined
let normalizeVoice: (v: any) => string | undefined
beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('upsert.ts') /* @vite-ignore */)
  mergeUpsertPayload = mod.mergeUpsertPayload
  normalizeLogo = mod.normalizeLogo
  normalizeIntroVibe = mod.normalizeIntroVibe
  normalizeChips = mod.normalizeChips
  normalizeTagline = mod.normalizeTagline
  normalizeVoice = mod.normalizeVoice
})

// This is the guard against a partial UPDATE blanking a tiny's config.
// modify_ai makes worker/data/schema/skills OPTIONAL, so a model refining just
// the prompt sends a body WITHOUT them — they must survive from the stored row.
describe.skipIf(!present)('mergeUpsertPayload', () => {
  const existing = {
    systemPrompt: 'old prompt', systemKnowledge: 'old kb',
    data: 'old data', worker: 'https://w.example/openapi.json',
    schema: { paths: {} }, skills: [{ name: 's1' }],
    mcpServers: { srv: { url: 'https://mcp.example' } }, hook: 'https://hook.example',
    hero: 'https://img.example/banner.jpg', theme: { accent: '#ff00ff', bg: '#0a0a1a' },
    logo: 'https://img.example/logo.svg', intro_vibe: 'heartbeat', chips: ['What can you do?'],
    tagline: 'Yerli ve açık kaynaklı robotik.',
    private: false,
  }

  it('KEEPS every omitted optional field (the wipe bug)', () => {
    // caller updates only the prompt — everything else omitted
    const out = mergeUpsertPayload({ name: 't', systemPrompt: 'new prompt' }, existing, 'owner-1', false, 't')
    expect(out.systemPrompt).toBe('new prompt')            // updated
    expect(out.systemKnowledge).toBe('old kb')             // preserved
    expect(out.data).toBe('old data')                      // preserved
    expect(out.worker).toBe('https://w.example/openapi.json') // preserved (the headline bug)
    expect(out.schema).toEqual({ paths: {} })              // preserved
    expect(out.skills).toEqual([{ name: 's1' }])           // preserved
    expect(out.mcpServers).toEqual({ srv: { url: 'https://mcp.example' } }) // preserved
    expect(out.hook).toBe('https://hook.example')          // preserved
    expect(out.hero).toBe('https://img.example/banner.jpg') // preserved (branding)
    expect(out.theme).toEqual({ accent: '#ff00ff', bg: '#0a0a1a' }) // preserved
    expect(out.logo).toBe('https://img.example/logo.svg')   // preserved (identity)
    expect(out.intro_vibe).toBe('heartbeat')                 // preserved
    expect(out.chips).toEqual(['What can you do?'])          // preserved
    expect(out.tagline).toBe('Yerli ve açık kaynaklı robotik.') // preserved
  })

  it('branding clears with explicit empty string, like every preserved field', () => {
    const out = mergeUpsertPayload({ name: 't', hero: '', theme: '', logo: '', intro_vibe: '', chips: '', tagline: '' }, existing, 'owner-1', false, 't')
    expect(out.hero).toBe('')
    expect(out.theme).toBe('')
    expect(out.logo).toBe('')
    expect(out.intro_vibe).toBe('')
    expect(out.chips).toBe('')
    expect(out.tagline).toBe('')
  })

  it('an EXPLICIT value (incl. empty string) overwrites — clearing is intentional', () => {
    const out = mergeUpsertPayload({ name: 't', worker: '', data: 'fresh' }, existing, 'owner-1', false, 't')
    expect(out.worker).toBe('')       // '' is an explicit clear, not "keep"
    expect(out.data).toBe('fresh')    // explicit update
    expect(out.hook).toBe('https://hook.example') // still preserved (omitted)
  })

  it('always stamps owner/active/private from the args, not the body', () => {
    const out = mergeUpsertPayload({ name: 't', owner: 'SPOOFED', active: false, private: false }, existing, 'real-owner', true, 't')
    expect(out.owner).toBe('real-owner') // caller can't spoof owner via body
    expect(out.active).toBe(true)
    expect(out.private).toBe(true)       // nextPrivate arg wins
  })

  it('stamps the CANONICAL slug name over the raw body name', () => {
    // /get builds vcard/QR/stats URLs from the stored name — it must be the
    // slug (the KV key), not the raw input, or those URLs break.
    const out = mergeUpsertPayload({ name: 'My Tiny!!!' }, existing, 'o', false, 'my-tiny')
    expect(out.name).toBe('my-tiny')
  })

  it('tolerates a missing/empty existing row (first-write-shaped)', () => {
    const out = mergeUpsertPayload({ name: 't', systemPrompt: 'p' }, {}, 'o', false, 't')
    expect(out.systemPrompt).toBe('p')
    expect(out.worker).toBeUndefined() // nothing to preserve → stays undefined
    expect(() => mergeUpsertPayload({ name: 't' }, null, 'o', false, 't')).not.toThrow()
  })
})

// 🎭 Per-tiny identity normalizers — pure, exported from upsert.ts. Shared
// semantics: '' = explicit clear (overwrites), invalid = undefined (preserve).
describe.skipIf(!present)('identity field normalizers', () => {
  it('normalizeLogo: same https regex/limits as hero, any media type', () => {
    expect(normalizeLogo('https://cdn.example/logo.svg')).toBe('https://cdn.example/logo.svg')
    expect(normalizeLogo('https://cdn.example/loop.mp4')).toBe('https://cdn.example/loop.mp4')
    expect(normalizeLogo('https://cdn.example/no-extension')).toBe('https://cdn.example/no-extension') // no extension enforcement
    expect(normalizeLogo('  https://cdn.example/l.png  ')).toBe('https://cdn.example/l.png') // trimmed
    expect(normalizeLogo('')).toBe('')          // explicit clear
    expect(normalizeLogo('   ')).toBe('')       // whitespace-only = clear
    expect(normalizeLogo('http://cdn.example/l.png')).toBeUndefined()  // https only
    expect(normalizeLogo('https://a b.example/l.png')).toBeUndefined() // no whitespace
    expect(normalizeLogo(`https://x.example/l.png"onerror="x`)).toBeUndefined() // no quotes
    expect(normalizeLogo(`https://x.example/${'a'.repeat(500)}`)).toBeUndefined() // >500 chars after scheme
    expect(normalizeLogo(null)).toBe('')        // stringified nullish → clear (matches hero's String(v||''))
  })

  it('normalizeIntroVibe: allowlisted vibrate pattern names only', () => {
    for (const p of ['tap', 'double', 'success', 'warning', 'error', 'heartbeat', 'sos', 'long', 'escalate', 'wave']) {
      expect(normalizeIntroVibe(p)).toBe(p)
    }
    expect(normalizeIntroVibe('')).toBe('')             // explicit clear
    expect(normalizeIntroVibe('  tap  ')).toBe('tap')   // trimmed
    expect(normalizeIntroVibe('TAP')).toBeUndefined()   // case-sensitive canonical names
    expect(normalizeIntroVibe('rumble')).toBeUndefined()// unknown → preserve
    expect(normalizeIntroVibe(42)).toBeUndefined()
  })

  it('normalizeChips: 1-4 trimmed strings, 1-60 chars, control chars stripped', () => {
    expect(normalizeChips(['What can you do?'])).toEqual(['What can you do?'])
    expect(normalizeChips(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd'])
    expect(normalizeChips(['  padded  '])).toEqual(['padded'])
    expect(normalizeChips(['line\u0000one\u001Ftwo'])).toEqual(['lineonetwo']) // control chars stripped
    // itty declares chips as Str — a JSON-array string parses
    expect(normalizeChips('["from json","string"]')).toEqual(['from json', 'string'])
    // clears
    expect(normalizeChips('')).toBe('')
    expect(normalizeChips([])).toBe('')
    // invalid → undefined (preserve existing)
    expect(normalizeChips(['a', 'b', 'c', 'd', 'e'])).toBeUndefined() // >4
    expect(normalizeChips(['ok', ''])).toBeUndefined()                // empty element
    expect(normalizeChips(['ok', '   '])).toBeUndefined()             // trims to empty
    expect(normalizeChips(['x'.repeat(61)])).toBeUndefined()          // >60 chars
    expect(normalizeChips(['x'.repeat(60)])).toEqual(['x'.repeat(60)]) // 60 exactly is fine
    expect(normalizeChips(['ok', 42])).toBeUndefined()                // non-string element
    expect(normalizeChips('not json')).toBeUndefined()
    expect(normalizeChips({ 0: 'a' })).toBeUndefined()                // non-array
  })

  it('normalizeTagline: free text, trimmed, control chars stripped, ≤200 chars', () => {
    expect(normalizeTagline('Yerli ve açık kaynaklı robotik çözümler.')).toBe('Yerli ve açık kaynaklı robotik çözümler.')
    expect(normalizeTagline('  padded tagline  ')).toBe('padded tagline')  // trimmed
    expect(normalizeTagline('line\u0000one\u001Ftwo')).toBe('lineonetwo')  // control chars stripped
    expect(normalizeTagline('x'.repeat(200))).toBe('x'.repeat(200))        // 200 exactly is fine
    expect(normalizeTagline('')).toBe('')          // explicit clear
    expect(normalizeTagline('   ')).toBe('')       // whitespace-only = clear
    expect(normalizeTagline(null)).toBe('')        // stringified nullish → clear
    expect(normalizeTagline('x'.repeat(201))).toBeUndefined() // >200 → preserve, not truncate
  })

  it('normalizeVoice: allowlisted OpenAI Realtime voices only', () => {
    for (const v of ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']) {
      expect(normalizeVoice(v)).toBe(v)
    }
    expect(normalizeVoice('MARIN')).toBe('marin')   // case-normalized to canonical
    expect(normalizeVoice('  cedar  ')).toBe('cedar')// trimmed
    expect(normalizeVoice('')).toBe('')             // explicit clear → default at session-create
    expect(normalizeVoice('   ')).toBe('')          // whitespace-only = clear
    expect(normalizeVoice(null)).toBe('')           // stringified nullish → clear
    expect(normalizeVoice('nova')).toBeUndefined()  // not in the realtime set → preserve
    expect(normalizeVoice(42)).toBeUndefined()      // non-string junk → preserve
  })
})
