// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { normalizeCommunity, normalizeProfile, compact, githubAvatar, hexRgb } from '../lib/community'

describe('hexRgb — accent hex → rgba() component string', () => {
  it('converts 6-digit hex', () => {
    expect(hexRgb('#8b5cf6')).toBe('139,92,246')
    expect(hexRgb('#00FF88')).toBe('0,255,136')
    expect(hexRgb('#000000')).toBe('0,0,0')
  })
})

describe('normalizeCommunity — home-page shape guard', () => {
  it('passes a well-formed response through', () => {
    const out = normalizeCommunity({
      users: [{ login: 'a', name: 'Alice', avatar: 'x', joined: 5, tinyCount: 2, tinys: [{ name: 't1', created: 1 }, { name: 't2', created: 2 }] }],
      totalPublicTinys: 2,
      totalMessages: 1880100,
    })
    expect(out.users).toHaveLength(1)
    expect(out.users[0].tinys).toHaveLength(2)
    expect(out.totalMessages).toBe(1880100)
  })

  it('non-array users → [] (the crash the render .map() would hit)', () => {
    expect(normalizeCommunity({ users: 'error' }).users).toEqual([])
    expect(normalizeCommunity({ users: null }).users).toEqual([])
    expect(normalizeCommunity({}).users).toEqual([])
    expect(normalizeCommunity(null).users).toEqual([])
    expect(normalizeCommunity('boom').users).toEqual([])
  })

  it('drops users missing a login; a user without tinys gets []', () => {
    const out = normalizeCommunity({
      users: [
        { login: 'ok', tinys: [{ name: 't' }] },
        { name: 'no login' },                       // dropped
        { login: 'notinys' },                        // kept, tinys → []
        null,                                        // dropped
      ],
    })
    expect(out.users.map((u) => u.login)).toEqual(['ok', 'notinys'])
    expect(out.users[1].tinys).toEqual([])          // .slice(0,8) is now safe
  })

  it('drops malformed tinys within a user', () => {
    const out = normalizeCommunity({
      users: [{ login: 'a', tinys: [{ name: 'good' }, { created: 1 }, null, 'junk'] }],
    })
    expect(out.users[0].tinys.map((t) => t.name)).toEqual(['good'])
  })

  it('derives tinyCount from tinys when absent; coerces bad numbers', () => {
    const out = normalizeCommunity({
      users: [{ login: 'a', tinys: [{ name: 'x' }, { name: 'y' }] }],
      totalPublicTinys: 'nope',
      totalMessages: undefined,
    })
    expect(out.users[0].tinyCount).toBe(2)
    expect(out.totalPublicTinys).toBe(0)
    expect(out.totalMessages).toBe(0)
  })

  it('tiny accents: valid 6-hex passes, junk is stripped (renders into SVG fills)', () => {
    const out = normalizeCommunity({
      users: [{ login: 'a', tinys: [
        { name: 'purple', accent: '#8b5cf6' },
        { name: 'junk', accent: 'red' },          // named color → stripped
        { name: 'short', accent: '#0f8' },        // 3-hex → stripped
        { name: 'none' },                          // absent stays absent
      ] }],
    })
    expect(out.users[0].tinys.map((t) => t.accent)).toEqual(['#8b5cf6', undefined, undefined, undefined])
  })

  it('consults: well-shaped slug pairs pass, malformed/self-loops drop, absent → []', () => {
    // These render straight into the /universe constellation SVG
    const out = normalizeCommunity({
      consults: [
        { src: 'a', dst: 'b', weight: 3 },
        { src: 'c', dst: 'd' },                       // missing weight → 1
        { src: 'e', dst: 'e', weight: 2 },            // self-loop dropped
        { src: '', dst: 'x', weight: 1 },             // empty slug dropped
        { src: 'f', dst: 'g', weight: 'NaN-ish' },    // bad weight → 1
        null, 'junk',                                  // dropped
      ],
    })
    expect(out.consults).toEqual([
      { src: 'a', dst: 'b', weight: 3 },
      { src: 'c', dst: 'd', weight: 1 },
      { src: 'f', dst: 'g', weight: 1 },
    ])
    expect(normalizeCommunity({}).consults).toEqual([]) // older worker payloads
    expect(normalizeCommunity({ consults: 'boom' }).consults).toEqual([])
  })
})

describe('normalizeProfile — profile-page shape guard', () => {
  it('null when there is no usable login (the 404 path)', () => {
    expect(normalizeProfile(null)).toBeNull()
    expect(normalizeProfile({})).toBeNull()
    expect(normalizeProfile({ login: 42 })).toBeNull()
    expect(normalizeProfile('boom')).toBeNull()
  })

  it('guarantees tinys/tools arrays even when the response omits them', () => {
    const out = normalizeProfile({ login: 'alice' })!
    expect(out.tinys).toEqual([])
    expect(out.tools).toEqual([])          // .map()/.length now safe
    expect(out.name).toBe('')
    expect(out.followers).toBe(0)          // absent → 0, never NaN
  })

  it('followers: numeric passthrough, garbage/negative → 0 (renders on the page)', () => {
    expect(normalizeProfile({ login: 'a', followers: 3 })!.followers).toBe(3)
    expect(normalizeProfile({ login: 'a', followers: '7' })!.followers).toBe(7)
    expect(normalizeProfile({ login: 'a', followers: -2 })!.followers).toBe(0)
    expect(normalizeProfile({ login: 'a', followers: 'lots' })!.followers).toBe(0)
  })

  it('non-array tinys/tools → [] (the crash the render would hit)', () => {
    const out = normalizeProfile({ login: 'a', tinys: 'x', tools: { junk: 1 } })!
    expect(out.tinys).toEqual([])
    expect(out.tools).toEqual([])
  })

  it('keeps well-formed entries, drops malformed ones', () => {
    const out = normalizeProfile({
      login: 'a',
      tinys: [{ name: 't1', created: 1 }, { created: 2 }, null],
      tools: [{ name: 'my_x', description: 'd', code: '(a)=>a' }, 'junk', { description: 'no name' }],
    })!
    expect(out.tinys.map((t) => t.name)).toEqual(['t1'])
    expect(out.tools.map((t) => t.name)).toEqual(['my_x'])
  })

  it('coerces joined to a number', () => {
    expect(normalizeProfile({ login: 'a', joined: '1700000000' })!.joined).toBe(1700000000)
    expect(normalizeProfile({ login: 'a' })!.joined).toBe(0)
  })

  it('coerces tinys[].created to a finite number so the "alive since" render never hits Invalid Date', () => {
    // Profile.tsx renders `new Date(created * …)` guarded only by `created ?`.
    // A non-numeric TRUTHY string ("2024-01") passes that guard and yields NaN
    // → "alive since Invalid Date". Coerce here so only a real ts reaches it.
    const out = normalizeProfile({
      login: 'a',
      tinys: [
        { name: 'num', created: 1700000000 }, // real ts — kept
        { name: 'str', created: '1700000000' }, // numeric string — coerced
        { name: 'bad', created: '2024-01' }, // truthy non-number — → 0 (URL fallback)
        { name: 'nul', created: null }, // → 0
        { name: 'abs' }, // absent → 0
      ],
    })!
    expect(out.tinys.map((t) => t.created)).toEqual([1700000000, 1700000000, 0, 0, 0])
    // every value is a finite number — the date math can never produce NaN
    expect(out.tinys.every((t) => Number.isFinite(t.created))).toBe(true)
  })
})

describe('compact — headline number formatting (never emits NaN)', () => {
  it('formats the K/M/B tiers', () => {
    expect(compact(0)).toBe('0')
    expect(compact(999)).toBe('999')
    expect(compact(45_300)).toBe('45K')
    expect(compact(1_880_100)).toBe('1.9M')
    expect(compact(1_500_000_000)).toBe('1.5B')
  })

  it('never renders NaN / negative / Infinity on a card or the OG image', () => {
    // stats.x ?? 0 only guards null/undefined — a NaN from a bad upstream
    // Number(...) would otherwise print "NaN views" on the public OG card.
    expect(compact(NaN)).toBe('0')
    expect(compact(-5)).toBe('0')
    expect(compact(Infinity)).toBe('0')
    expect(compact(undefined as any)).toBe('0')
  })

  it('rounds fractional counts', () => {
    expect(compact(12.7)).toBe('13')
  })

  it('promotes a tier when rounding would overflow it (no "1000K"/"1000.0M")', () => {
    // K tier tops out cleanly just below the promote point
    expect(compact(999_499)).toBe('999K')
    // 999_500..999_999 would Math.round to "1000K" — must read "1.0M"
    expect(compact(999_500)).toBe('1.0M')
    expect(compact(999_999)).toBe('1.0M')
    // M tier tops out at 999.9M just below the billion promote point
    expect(compact(999_949_999)).toBe('999.9M')
    // 999_950_000+ would .toFixed(1) to "1000.0M" — must read "1.0B"
    expect(compact(999_950_000)).toBe('1.0B')
  })
})

describe('githubAvatar — source-side avatar sizing', () => {
  it('appends ?s=<2×size> to a bare githubusercontent URL', () => {
    expect(githubAvatar('https://avatars.githubusercontent.com/u/1', 40))
      .toBe('https://avatars.githubusercontent.com/u/1?s=80')
    expect(githubAvatar('https://avatars.githubusercontent.com/u/1', 32))
      .toBe('https://avatars.githubusercontent.com/u/1?s=64')
  })

  it('uses & when the URL already carries a query string', () => {
    expect(githubAvatar('https://avatars.githubusercontent.com/u/1?v=4', 40))
      .toBe('https://avatars.githubusercontent.com/u/1?v=4&s=80')
  })

  it('leaves non-GitHub avatar hosts (and data: URIs) untouched', () => {
    expect(githubAvatar('https://cdn.example.com/a.png', 40)).toBe('https://cdn.example.com/a.png')
    expect(githubAvatar('data:image/png;base64,AAAA', 40)).toBe('data:image/png;base64,AAAA')
  })

  it('empty / non-string input → "" so the caller initial-letter fallback fires', () => {
    expect(githubAvatar('', 40)).toBe('')
    expect(githubAvatar(null, 40)).toBe('')
    expect(githubAvatar(undefined, 40)).toBe('')
    expect(githubAvatar(42 as any, 40)).toBe('')
  })

  it('clamps a 0 / negative / NaN size to s=1 (never ?s=0, which serves full-res)', () => {
    const base = 'https://avatars.githubusercontent.com/u/1'
    expect(githubAvatar(base, 0)).toBe(`${base}?s=1`)
    expect(githubAvatar(base, -10)).toBe(`${base}?s=1`)
    expect(githubAvatar(base, NaN)).toBe(`${base}?s=1`)
  })
})

describe('normalizeCommunity — trust map (graph stage 6)', () => {
  it('passes well-shaped slug→score entries', () => {
    const out = normalizeCommunity({ users: [], trust: { strands: 0.82, tiny: 1 } })
    expect(out.trust).toEqual({ strands: 0.82, tiny: 1 })
  })

  it('drops malformed entries — this renders on the home page', () => {
    const out = normalizeCommunity({ users: [], trust: {
      good: 0.5,
      nan: 'not-a-number',
      negative: -1,
      overflow: 7,        // scores are max-normalized to 1
      zero: 0,            // no signal — don't badge
    } })
    expect(out.trust).toEqual({ good: 0.5 })
  })

  it('missing / non-object trust → {}', () => {
    expect(normalizeCommunity({ users: [] }).trust).toEqual({})
    expect(normalizeCommunity({ users: [], trust: [0.5] }).trust).toEqual({})
    expect(normalizeCommunity({ users: [], trust: 'high' }).trust).toEqual({})
    expect(normalizeCommunity(null).trust).toEqual({})
  })
})
