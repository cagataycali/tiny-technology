// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TINY_KEY_FAMILIES, tinyKeys, purgeTinyKeys } from '../lib/chat/local-keys'

/**
 * v5 D4 — "Delete this tiny forever?" promised "config, search index,
 * everything" and removed ONE key. Four cycles each added a per-tiny key
 * family (meta c41, draft c43, pending-files c45) and none joined the delete
 * path; the two that matter most, `tiny_turnlog_` and `tiny_memories_`, were
 * never there at all — and those are injected into every request as
 * "Persistent Memories… survives resets".
 */

describe('the inventory', () => {
  it('covers every family, with unique ids and keys', () => {
    const ids = TINY_KEY_FAMILIES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    const keys = TINY_KEY_FAMILIES.map((f) => f.key('scout'))
    expect(new Set(keys).size).toBe(keys.length)
    expect(TINY_KEY_FAMILIES.every((f) => f.note.length > 0)).toBe(true)
  })

  it('names the keys the rest of the app actually writes', () => {
    // Spelled out literally: a typo'd prefix here would silently orphan the
    // real key forever, and every producer of these strings is elsewhere.
    const { local, session } = tinyKeys('scout')
    expect(local).toEqual([
      'chat_messages_scout',
      'chat_meta_scout',
      'chat_draft_scout',
      'chat_pending_files_scout',
      'tiny_turnlog_scout',
      'tiny_memories_scout',
    ])
    expect(session).toEqual([
      'scout:key',
      'tiny_ambient_findings:scout',
      'tiny_ambient_count:scout',
    ])
  })

  it('keeps the continuity families in the list — they outlive /clear BY DESIGN', () => {
    // The whole point of the finding: these two survive every lesser reset,
    // so a delete is the only thing that can erase them.
    const ids = TINY_KEY_FAMILIES.map((f) => f.id)
    expect(ids).toContain('turnlog')
    expect(ids).toContain('memories')
  })
})

describe('purgeTinyKeys', () => {
  const fakeStore = () => {
    const map = new Map<string, string>()
    return { map, removeItem: vi.fn((k: string) => { map.delete(k) }) }
  }

  it('erases every family from both stores', () => {
    const local = fakeStore(), session = fakeStore()
    for (const k of tinyKeys('scout').local) local.map.set(k, 'x')
    for (const k of tinyKeys('scout').session) session.map.set(k, 'x')

    const removed = purgeTinyKeys({ local, session }, 'scout')

    expect(local.map.size).toBe(0)
    expect(session.map.size).toBe(0)
    expect(removed).toHaveLength(TINY_KEY_FAMILIES.length)
  })

  it("leaves another tiny's data completely alone", () => {
    const local = fakeStore()
    local.map.set('chat_messages_scout', 'a')
    local.map.set('chat_messages_other', 'b')
    local.map.set('tiny_memories_other', 'c')
    // Shared, non-per-tiny keys must survive too.
    local.map.set('tiny_model_config', 'cfg')
    local.map.set('tiny_mesh_ring', 'ring')

    purgeTinyKeys({ local }, 'scout')

    // Array.from, not spread: the repo's tsc target rejects iterator spread.
    expect(Array.from(local.map.keys()).sort()).toEqual([
      'chat_messages_other', 'tiny_memories_other', 'tiny_mesh_ring', 'tiny_model_config',
    ])
  })

  it('a blocked or throwing key does not strand the others', () => {
    // removeItem throws SecurityError when site data is fully blocked
    // (ModelSettings precedent). A delete confirmation must not blow up after
    // the tiny is already gone server-side, and a partial erase beats none.
    const local = fakeStore()
    for (const k of tinyKeys('scout').local) local.map.set(k, 'x')
    local.removeItem.mockImplementation((k: string) => {
      if (k === 'chat_meta_scout') throw new Error('SecurityError')
      local.map.delete(k)
    })

    const removed = purgeTinyKeys({ local }, 'scout')

    expect(local.map.has('tiny_memories_scout')).toBe(false) // reached past the throw
    expect(removed).not.toContain('chat_meta_scout')
    expect(removed.length).toBe(tinyKeys('scout').local.length - 1)
  })

  it('a missing store is skipped, not crashed on (SSR / no sessionStorage)', () => {
    const local = fakeStore()
    local.map.set('chat_draft_scout', 'x')
    expect(() => purgeTinyKeys({ local, session: null }, 'scout')).not.toThrow()
    expect(local.map.size).toBe(0)
    expect(purgeTinyKeys({}, 'scout')).toEqual([])
  })

  it('an empty name touches nothing — it would match the ambient "_" fallback', () => {
    // `tiny_ambient_findings:${name || '_'}` means an empty name resolves to
    // another tiny's key space. Refuse instead of guessing.
    const local = fakeStore(), session = fakeStore()
    session.map.set('tiny_ambient_findings:_', 'x')
    expect(purgeTinyKeys({ local, session }, '')).toEqual([])
    expect(session.map.size).toBe(1)
  })
})

/**
 * The recurrence is the bug: three key families were added in three cycles and
 * none joined the delete path. This fails the next time it happens.
 */
describe('no per-tiny key family escapes the inventory', () => {
  const repo = join(__dirname, '..')
  const ROOTS = ['app', 'components', 'lib']

  // Manual walk — the repo's @types/node predates readdirSync's `recursive`.
  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...tsFiles(p))
      else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('every per-tiny storage key in the web tree is a known family', () => {
    const known = new Set(TINY_KEY_FAMILIES.map((f) => f.key('$TINY')))
    // Storage keys built by interpolating a bare identifier: the shape every
    // per-tiny key in this repo uses. `${name}:key` included.
    const KEY_TEMPLATE = /`([a-z_]*\$\{(?:name|tiny|tinyName|nameForm|this\.opts\.tinyName)[^}]*\}[a-z_:]*)`/g
    const offenders: string[] = []

    for (const file of tsFiles(join(repo, 'app')).concat(tsFiles(join(repo, 'components')), tsFiles(join(repo, 'lib')))) {
      const src = readFileSync(file, 'utf8')
      // Only lines that actually reach a Storage — plenty of templates build
      // URLs, ids and prompts with the same interpolation.
      for (const line of src.split('\n')) {
        if (!/(local|session)Storage\.|Key\s*=\s*\(|KeyStore/.test(line)) continue
        for (const m of Array.from(line.matchAll(KEY_TEMPLATE), (x) => x[1])) {
          const normalized = m.replace(/\$\{[^}]*\}/, '$TINY')
          if (!known.has(normalized)) offenders.push(`${file.slice(repo.length + 1)}: ${normalized}`)
        }
      }
    }

    expect(
      offenders,
      'a per-tiny storage key is missing from TINY_KEY_FAMILIES — add it there so deleting a tiny erases it',
    ).toEqual([])
  })

  it('the delete path purges rather than hand-removing one key', () => {
    const src = readFileSync(join(repo, 'components/chat/Control.tsx'), 'utf8')
    expect(src).toContain('purgeTinyKeys')
    // The instance this cycle fixed, pinned so it can't come back.
    expect(src).not.toMatch(/removeItem\(`chat_messages_/)
  })
})
