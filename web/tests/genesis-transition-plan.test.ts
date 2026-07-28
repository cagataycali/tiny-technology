import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planGenesisTransition as planRaw } from '@/chain/multinode/genesis-transition-plan.mjs'

type Fork = { block: number; validatorselectionmode?: string; validatorcontractaddress?: string }
type Plan = {
  ok: boolean
  blockers: string[]
  warnings: string[]
  fork: Fork | null
  timeBasedFork: boolean
  appendTo: string
  existing: Fork[]
  summary: string
}
/** The module is plain JS; this narrows its inferred shape so the assertions type-check. */
const planGenesisTransition = planRaw as unknown as (input: Record<string, unknown>) => Plan

/**
 * c25 — the swap's EXECUTOR, not its gate.
 *
 * `swap-preflight` says the swap is survivable and exits 0. The only script in the
 * tree that writes a qbft transition refuses to, and also exits 0. These tests cover
 * the planner that stands in for it, and — at the bottom — assert the two source
 * facts that make the planner necessary, so that "just delete the guard" cannot pass
 * for a fix.
 */

// The real 8470 addresses, mixed case on purpose: an address fixture rendered from
// digits alone (`0x11…`) makes toUpperCase() a no-op, so a case-insensitivity test
// over it passes against a case-SENSITIVE comparison. A mutant survived on exactly
// that in registry-swap-policy.test.ts at c24.
const IN = '0xb2ff9d5E60d68a52ceA3cd041b32F1390a880365'
const OUT = '0x0165878A594ca255338adfa4d48449f69242Eb8F'
const THIRD = '0x4Ea0Be853219be8C9CE27200bDEeE36881612FF2'

const NOW = 1785084451 // a real 8470 head timestamp
const KEY = NOW + 900 // comfortably past MIN_TRANSITION_LEAD_S = 600

/** The shape of the live genesis: shanghaiTime present, one contract-mode fork. */
function genesis(forks: unknown = [{ block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: OUT.toLowerCase() }]) {
  return {
    config: {
      chainId: 8470,
      londonBlock: 0,
      zeroBaseFee: true,
      shanghaiTime: 0,
      qbft: { blockperiodseconds: 2, epochlength: 30000, requesttimeoutseconds: 4 },
      transitions: { qbft: forks },
    },
  }
}

const plan = (over: Record<string, unknown> = {}) =>
  planGenesisTransition({ genesis: genesis(), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW, ...over })

/** Fails the test rather than asserting `!` — a null fork is itself a defect worth naming. */
function mustFork(r: Plan): Fork {
  expect(r.fork, 'expected a planned fork, got none').not.toBeNull()
  return r.fork as Fork
}

describe('planGenesisTransition — the happy path produces a fork besu will accept', () => {
  it('plans a single append, leaving the existing transition alone', () => {
    const r = plan()
    expect(r.ok).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.appendTo).toBe('config.transitions.qbft')
    expect(r.existing).toHaveLength(1)
    expect(r.fork).toEqual({
      block: KEY,
      validatorselectionmode: 'contract',
      validatorcontractaddress: IN.toLowerCase(),
    })
  })

  it('carries BOTH keys — mode without address makes besu throw (constraint 4)', () => {
    // "QBFT transition has config with contract mode but no contract address"
    const f = mustFork(plan())
    expect(Object.keys(f).sort()).toEqual(['block', 'validatorcontractaddress', 'validatorselectionmode'])
    expect(f.validatorselectionmode).toBe('contract')
    expect(f.validatorcontractaddress).toBeTruthy()
  })

  it('does not mutate the genesis it was handed', () => {
    const g = genesis()
    const before = JSON.stringify(g)
    planGenesisTransition({ genesis: g, incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(JSON.stringify(g)).toBe(before)
    expect(g.config.transitions.qbft).toHaveLength(1)
  })

  it('names the INCOMING registry — the bug the old writer would have shipped', () => {
    // switch-to-contract-mode.sh writes `contract = d['validatorContract']`, which is
    // the outgoing one. A swap that writes the outgoing address is a no-op fork that
    // burns a key and reports success.
    expect(mustFork(plan()).validatorcontractaddress).not.toBe(OUT.toLowerCase())
    expect(mustFork(plan()).validatorcontractaddress).toBe(IN.toLowerCase())
  })
})

describe('constraint 2 — a duplicate key makes EVERY node refuse to start', () => {
  it('refuses a key that collides with an existing transition', () => {
    const r = plan({ transitionKey: 1785028028 })
    expect(r.ok).toBe(false)
    expect(r.fork).toBeNull()
    const j = r.blockers.join(' ')
    expect(j).toContain('1785028028')
    expect(j).toContain('Duplicate transitions cannot be created for the same block')
    expect(j).toMatch(/REFUSE TO START/i)
  })

  it('the collision is judged by KEY, not by array position', () => {
    // besu sorts (TreeSet + Comparator.comparing), so a clash with a fork that is
    // not last in the array is just as fatal.
    const forks = [
      { block: KEY, validatorselectionmode: 'contract', validatorcontractaddress: THIRD.toLowerCase() },
      { block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: OUT.toLowerCase() },
    ]
    const r = planGenesisTransition({ genesis: genesis(forks), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toContain('Duplicate transitions')
  })

  it('a string key in the genesis still counts as a collision', () => {
    // JSON has been hand-edited before; `"block": "1785028028"` must not read as free.
    const forks = [{ block: String(KEY), validatorselectionmode: 'contract', validatorcontractaddress: OUT.toLowerCase() }]
    const r = planGenesisTransition({ genesis: genesis(forks), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.blockers.join(' ')).toContain('Duplicate transitions')
  })

  it('a nearby-but-distinct key is fine', () => {
    expect(plan({ transitionKey: 1785028029 + 600_000 }).ok).toBe(true)
  })
})

describe('constraint 5 — the key must be read the way we mean it', () => {
  it('refuses a block number when a *Time hardfork precedes it', () => {
    const r = plan({ transitionKey: 19000 })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/BLOCK NUMBER/)
    expect(r.blockers.join(' ')).toMatch(/1970/)
  })

  it('derives timeBasedFork from the genesis rather than assuming it', () => {
    // ⚠️ The assumption would be CORRECT today. This asserts it is still derived, so
    // that removing shanghaiTime changes the verdict instead of silently keeping a
    // rule that no longer applies.
    expect(plan().timeBasedFork).toBe(true)

    const g = genesis()
    delete (g.config as Record<string, unknown>).shanghaiTime
    const r = planGenesisTransition({ genesis: g, incoming: IN, outgoing: OUT, transitionKey: 19000, nowSec: NOW, nowBlock: 18534 })
    expect(r.timeBasedFork).toBe(false)
    // Now 19000 is a block number and legal — 466 blocks × 2s = 932s of lead.
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('BLOCK NUMBER')
  })

  it('reads the block period out of the genesis for the block-number lead', () => {
    const g = genesis()
    delete (g.config as Record<string, unknown>).shanghaiTime
    g.config.qbft.blockperiodseconds = 2
    // 18534 + 100 blocks × 2s = 200s < the 600s floor → refused.
    const r = planGenesisTransition({ genesis: g, incoming: IN, outgoing: OUT, transitionKey: 18634, nowSec: NOW, nowBlock: 18534 })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/600s is the minimum|block\(s\)/)
  })

  it('refuses too little lead — nodes restart at different moments and fork', () => {
    const r = plan({ transitionKey: NOW + 30 })
    expect(r.ok).toBe(false)
    expect(r.fork).toBeNull()
  })

  it('refuses a key already in the past', () => {
    expect(plan({ transitionKey: NOW - 5000 }).ok).toBe(false)
  })
})

describe('the plan refuses when the genesis disagrees with the caller', () => {
  it('blocks when the highest-keyed fork already names the incoming registry', () => {
    const forks = [{ block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: IN.toLowerCase() }]
    const r = planGenesisTransition({ genesis: genesis(forks), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/already (names|been written)/)
  })

  it('blocks when the genesis names a registry the caller did not call outgoing', () => {
    const forks = [{ block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: THIRD.toLowerCase() }]
    const r = planGenesisTransition({ genesis: genesis(forks), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(false)
    const j = r.blockers.join(' ')
    expect(j).toContain(THIRD.toLowerCase())
    expect(j).toMatch(/GENESIS is what besu obeys/)
    // The consequence that matters: the preflight measured the wrong contract.
    expect(j).toMatch(/preflight/)
  })

  it('reads the HIGHEST-KEYED fork, not the last array element', () => {
    // ⚠️ The shape a SECOND swap leaves behind, and the one no other fixture here has:
    // two contract-mode forks at different keys, with the highest one NOT last in the
    // array. besu sorts by key (TreeSet + Comparator.comparing), so the fork in effect
    // is the highest — reading array order, or the lowest key, reports the wrong
    // current registry and waves the swap through. A mutant survived on exactly this.
    const highNamesIn = [
      { block: KEY + 50_000, validatorselectionmode: 'contract', validatorcontractaddress: IN.toLowerCase() },
      { block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: OUT.toLowerCase() },
    ]
    const r = planGenesisTransition({ genesis: genesis(highNamesIn), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/already/)
    expect(r.blockers.join(' ')).toContain(String(KEY + 50_000))

    // Same shape, but the highest names a THIRD registry: the disagreement blocker
    // must fire off the highest fork too, not off the lower one that happens to agree.
    const highNamesThird = [
      { block: KEY + 50_000, validatorselectionmode: 'contract', validatorcontractaddress: THIRD.toLowerCase() },
      { block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: OUT.toLowerCase() },
    ]
    const r2 = planGenesisTransition({ genesis: genesis(highNamesThird), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r2.ok).toBe(false)
    expect(r2.blockers.join(' ')).toContain(THIRD.toLowerCase())
  })

  it('compares registries case-insensitively in both directions', () => {
    for (const [a, b] of [
      [IN, IN.toLowerCase()],
      [IN.toLowerCase(), IN.toUpperCase().replace('0X', '0x')],
      [IN, IN.toUpperCase().replace('0X', '0x')],
    ]) {
      const forks = [{ block: 1785028028, validatorselectionmode: 'contract', validatorcontractaddress: b }]
      const r = planGenesisTransition({ genesis: genesis(forks), incoming: a, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
      expect(r.ok).toBe(false)
      expect(r.blockers.join(' ')).toMatch(/already/)
    }
    // …and the outgoing side, spelled differently from the genesis.
    const r = planGenesisTransition({ genesis: genesis(), incoming: IN, outgoing: OUT.toUpperCase().replace('0X', '0x'), transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(true)
  })

  it('guards that the fixtures carry letters, or the casing test proves nothing', () => {
    for (const a of [IN, OUT, THIRD]) {
      expect(a).toMatch(/[A-F]/)
      expect(a.toLowerCase()).not.toBe(a)
    }
  })
})

describe('the plan refuses rather than guessing on a malformed request', () => {
  it('refuses with no genesis', () => {
    const r = planGenesisTransition({ incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(false)
    expect(r.fork).toBeNull()
    expect(r.blockers.join(' ')).toMatch(/no genesis/)
  })

  it('refuses when transitions.qbft is not an array', () => {
    // ⚠️ Not `undefined` in this list: genesis()'s default parameter would swallow it
    // and hand back the healthy fixture, so the case would pass without being tested.
    // The absent case is covered separately below, by deleting the key.
    for (const forks of [{}, 'contract', 7, null]) {
      const g = genesis(forks as unknown)
      const r = planGenesisTransition({ genesis: g, incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
      expect(r.ok).toBe(false)
      expect(r.blockers.join(' ')).toMatch(/not an array|missing/)
    }
  })

  it('refuses when transitions is absent entirely', () => {
    for (const strip of ['qbft', 'transitions'] as const) {
      const g = genesis()
      if (strip === 'qbft') delete (g.config.transitions as Record<string, unknown>).qbft
      else delete (g.config as Record<string, unknown>).transitions
      const r = planGenesisTransition({ genesis: g, incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
      expect(r.ok).toBe(false)
      expect(r.blockers.join(' ')).toMatch(/not an array|missing/)
      expect(r.fork).toBeNull()
    }
  })

  it('refuses with no incoming address (constraint 4)', () => {
    for (const bad of [undefined, '', '   ', null]) {
      const r = plan({ incoming: bad })
      expect(r.ok).toBe(false)
      expect(r.blockers.join(' ')).toContain('no contract address')
    }
  })

  it('refuses when incoming === outgoing', () => {
    const r = plan({ outgoing: IN })
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/nothing to swap/)
  })

  it('never returns a fork alongside a blocker', () => {
    for (const over of [{ transitionKey: 19000 }, { incoming: '' }, { outgoing: IN }, { transitionKey: 1785028028 }]) {
      const r = plan(over)
      expect(r.ok).toBe(false)
      expect(r.fork).toBeNull()
      expect(r.summary).toMatch(/REFUSE/)
    }
  })

  it('warns (not blocks) on a header-mode chain, and names the right tool', () => {
    const forks = [{ block: 1785028028, requesttimeoutseconds: 8 }]
    const r = planGenesisTransition({ genesis: genesis(forks), incoming: IN, outgoing: OUT, transitionKey: KEY, nowSec: NOW })
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toContain('switch-to-contract-mode.sh')
  })
})

describe('c25: the source facts that make this planner necessary', () => {
  const root = join(__dirname, '..')
  const sh = readFileSync(join(root, 'chain/multinode/scripts/switch-to-contract-mode.sh'), 'utf8')

  it('switch-to-contract-mode.sh still bails on any existing contract-mode fork', () => {
    // The no-op. 8470's genesis HAS such a fork, so this script cannot perform the
    // swap — and it exits 0, which is why nothing noticed.
    expect(sh).toContain("if any(t.get('validatorcontractaddress') for t in existing):")
    expect(sh).toContain('already has a contract-mode transition — nothing to do')
    expect(sh).toContain('sys.exit(0)')
  })

  it('…and would write the OUTGOING registry if that guard were removed', () => {
    // So "delete the guard" is not the fix: the script has one registry, a swap has
    // two. If this assertion ever fails because the script learned about swaps, this
    // test should be revisited — not deleted.
    expect(sh).toContain("contract = d['validatorContract']")
    expect(sh).not.toContain('validatorContractSlashable')
  })

  it('the planner is REACHABLE — a CLI calls it, refuses non-8470, and writes nothing', () => {
    // A pure planner nothing invokes is the same defect one layer up: the reason the
    // no-op survived is that nobody ran the executor.
    const cli = readFileSync(join(root, 'chain/multinode/scripts/plan-registry-swap.mjs'), 'utf8')
    expect(cli).toContain("import { planGenesisTransition } from '../genesis-transition-plan.mjs'")
    expect(cli).toContain('planGenesisTransition({')
    // Refuses the LIVE chain.
    expect(cli).toContain('EXPECTED_CHAIN_ID = 8470')
    expect(cli).toMatch(/chainId !== EXPECTED_CHAIN_ID/)
    expect(cli).toContain('The LIVE chain is 8469')
    // Read-only: no write path at all. This is the assertion that keeps a future
    // cycle from "helpfully" making it apply the edit, which is user-gated.
    for (const w of ['writeFileSync', 'appendFileSync', 'sendTransaction', 'writeContract', 'execSync', 'spawnSync']) {
      expect(cli).not.toContain(w)
    }
    // ⚠️ Assert the line the OPERATOR sees, not merely that the file says
    // "USER-GATED" — that phrase is also in the docblock, so a whole-file match is
    // satisfied by a comment while the printed warning is gone. A mutant survived on
    // exactly that. Strip comments first, then require it inside a console.log.
    const runtime = cli.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(runtime).toMatch(/console\.log\([^)]*USER-GATED[^)]*will not do it/)
    // …and that it is printed on the SUCCESS path, after the fork is shown.
    // ⚠️ Bind the anchor FIRST. `indexOf` returns -1 for an absent needle, so
    // `indexOf(warning) > indexOf(anchor)` passes trivially once the anchor is
    // renamed away — an ordering assertion over an anchor that no longer exists
    // asserts nothing. A mutant survived on exactly that.
    const anchor = runtime.indexOf('Append this ONE object')
    expect(anchor).toBeGreaterThan(-1)
    expect(runtime.indexOf('USER-GATED')).toBeGreaterThan(anchor)
    // The outgoing registry comes from the GENESIS, not the deployment file's note.
    expect(cli).toMatch(/config\?\.transitions\?\.qbft/)
    expect(cli).toContain('validatorContractSlashable')
  })

  it('the live genesis is exactly the state the writer refuses', () => {
    // Read the real file when it is present; skip cleanly on a machine without the
    // devnet rather than asserting on a fixture that could drift from it.
    const p = join(process.env.TINY_MULTINODE_HOME || join(process.env.HOME || '', '.tiny-chain/multinode'), 'network/genesis.json')
    let raw: string
    try {
      raw = readFileSync(p, 'utf8')
    } catch {
      return
    }
    const forks = JSON.parse(raw)?.config?.transitions?.qbft
    expect(Array.isArray(forks)).toBe(true)
    expect(forks.some((f: Record<string, unknown>) => f.validatorcontractaddress)).toBe(true)

    // And the planner agrees the swap is still an append against that real file.
    const r = planGenesisTransition({
      genesis: JSON.parse(raw),
      incoming: IN,
      outgoing: forks.reduce((a: Record<string, unknown> | null, f: Record<string, unknown>) => (f.validatorcontractaddress && (!a || Number(f.block) > Number(a.block)) ? f : a), null).validatorcontractaddress,
      transitionKey: NOW + 100_000_000,
      nowSec: NOW,
    })
    expect(r.ok).toBe(true)
    expect(mustFork(r).validatorcontractaddress).toBe(IN.toLowerCase())
  })
})
