// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  asNetwork,
  topUpRoute,
  usdShort,
  untilNextDrip,
  faucetCta,
  ceilingNote,
  networkLabel,
  networkShort,
  isRealMoney,
  networkChoices,
  walletIntro,
  type FaucetInfo,
} from '@/lib/x402/top-up'

/**
 * 💧 TOP-UP PRESENTATION (lib/x402/top-up.ts).
 *
 * The self-hosted chain landed server-side over c1–c15: a tiny-chain deposit
 * path, trial-credit taint at all three exits, and (c15) a reputation-scaled
 * faucet that drips $1/day inside a lifetime ceiling. Every client still shows
 * Coinbase Onramp, MoonPay and faucet.circle.com — on a chain we own, all three
 * send the user to spend real money on a token this deployment cannot credit.
 *
 * What's asserted here is the part a screenshot can't check:
 *
 *  1. **Exactly one top-up route.** A card button next to the faucet, on a chain
 *     where cards can't deliver, is the bug being deleted — so the routes are
 *     mutually exclusive and chosen from the server's own `faucet.available`
 *     rather than from a network name that can disagree with it.
 *  2. **The two refusals stay distinct.** The worker deliberately answers 429
 *     (claimed today) and 400 (lifetime ceiling) differently; collapsing them
 *     into "try again later" tells a permanently-capped user to keep pressing a
 *     button that will never work.
 *  3. **The promised number is the credited number.** The drip is MIN-clamped by
 *     the remaining ceiling, so a button that reads "$1" when $0.30 is left
 *     under-delivers on its own label.
 *  4. **Trial money is labelled as trial money** everywhere, because it is
 *     spendable but not withdrawable, and finding that out after earning on it
 *     is indistinguishable from being defrauded.
 */

const FAUCET = (over: Partial<FaucetInfo> = {}): FaucetInfo => ({
  available: true,
  network: 'tiny',
  drip_micro: 1_000_000,
  cap_micro: 1_000_000,
  granted_micro: 0,
  remaining_micro: 1_000_000,
  claimed_today: false,
  next_drip_in_seconds: 0,
  reputation: 0,
  micro_per_point: 200_000,
  max_micro: 25_000_000,
  ...over,
})

describe('asNetwork — three networks, and a safe default', () => {
  it('accepts the worker’s three PayNetwork values', () => {
    expect(asNetwork('base')).toBe('base')
    expect(asNetwork('base-sepolia')).toBe('base-sepolia')
    expect(asNetwork('tiny')).toBe('tiny')
  })

  it('normalises case and whitespace', () => {
    expect(asNetwork(' TINY ')).toBe('tiny')
    expect(asNetwork('Base-Sepolia')).toBe('base-sepolia')
  })

  it('falls back to base for anything unknown', () => {
    // 'base' is the conservative reading: it labels balance as REAL money and
    // offers no free credit. Defaulting to 'tiny' on a garbled payload would
    // promise a faucet that isn't there.
    for (const junk of [undefined, null, '', 'ethereum', 'mainnet', 42, {}]) {
      expect(asNetwork(junk)).toBe('base')
    }
  })
})

describe('topUpRoute — exactly one route, chosen from what the server can do', () => {
  it('offers the in-house faucet when the server advertises one', () => {
    expect(topUpRoute({ default_network: 'tiny', faucet: FAUCET() })).toBe('faucet')
  })

  it('does NOT offer the faucet on a half-configured tiny chain', () => {
    // The faucet needs a mintable token AND a deployer key; a tiny deployment
    // missing either reports `tiny` with `faucet.available === false`. Keying off
    // the network name here would render a claim button that 424s every time —
    // the precise failure this item exists to remove.
    expect(topUpRoute({ default_network: 'tiny', faucet: { available: false } })).toBe('fiat')
    expect(topUpRoute({ default_network: 'tiny' })).toBe('fiat')
    expect(topUpRoute({ default_network: 'tiny', faucet: null })).toBe('fiat')
  })

  it('routes Sepolia to the public testnet faucet, not to cards', () => {
    // Cards deliver MAINNET USDC; the Sepolia claim scanner would never see it.
    expect(topUpRoute({ default_network: 'base-sepolia' })).toBe('testnet')
    expect(topUpRoute({ default_network: 'base-sepolia', faucet: { available: false } })).toBe(
      'testnet',
    )
  })

  it('routes real Base to fiat on-ramps, where they actually work', () => {
    expect(topUpRoute({ default_network: 'base' })).toBe('fiat')
    expect(topUpRoute(null)).toBe('fiat')
    expect(topUpRoute(undefined)).toBe('fiat')
  })

  it('a tiny deployment WITH a faucet never shows a fiat or testnet route', () => {
    // The mutual exclusivity is the whole point — assert it as one statement so
    // a later "just add the card button back" change fails here.
    const route = topUpRoute({ default_network: 'tiny', faucet: FAUCET() })
    expect(route).not.toBe('fiat')
    expect(route).not.toBe('testnet')
  })
})

describe('usdShort — the number on the button', () => {
  it('renders whole dollars without cents', () => {
    expect(usdShort(1_000_000)).toBe('$1')
    expect(usdShort(25_000_000)).toBe('$25')
  })

  it('keeps cents and sub-cents when they exist', () => {
    expect(usdShort(1_200_000)).toBe('$1.2')
    expect(usdShort(200_000)).toBe('$0.2')
    expect(usdShort(1)).toBe('$0.000001')
  })

  it('junk reads as $0 rather than $NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x', {}]) {
      expect(usdShort(bad)).toBe('$0')
    }
  })
})

describe('untilNextDrip', () => {
  it('renders hours and minutes', () => {
    expect(untilNextDrip(7500)).toBe('2h 5m')
    expect(untilNextDrip(7200)).toBe('2h')
    expect(untilNextDrip(300)).toBe('5m')
  })

  it('rounds a sub-minute wait up to 1m rather than saying 0m', () => {
    // "Next top-up in 0m" reads as a bug; the drip really is imminent.
    expect(untilNextDrip(30)).toBe('1m')
    expect(untilNextDrip(59)).toBe('1m')
  })

  it('returns empty for a non-future or junk value, so callers can fall back', () => {
    for (const bad of [0, -1, NaN, undefined, null, 'x']) {
      expect(untilNextDrip(bad)).toBe('')
    }
  })
})

describe('faucetCta — three states that must not be confused', () => {
  it('is live and names the amount when credit is claimable', () => {
    const cta = faucetCta(FAUCET())
    expect(cta.enabled).toBe(true)
    expect(cta.label).toBe('Claim $1 free credit')
    expect(cta.reason).toBe('')
  })

  it('promises the CLAMPED amount, not the nominal drip', () => {
    // The worker credits min(drip, remaining). A button reading "$1" that pays
    // $0.30 is a broken promise made by the client, not the server.
    const cta = faucetCta(FAUCET({ remaining_micro: 300_000, granted_micro: 700_000 }))
    expect(cta.enabled).toBe(true)
    expect(cta.label).toBe('Claim $0.3 free credit')
  })

  it('says "claimed today" with the wait — and that credit remains', () => {
    const cta = faucetCta(
      FAUCET({ claimed_today: true, next_drip_in_seconds: 7500, remaining_micro: 3_000_000 }),
    )
    expect(cta.enabled).toBe(false)
    expect(cta.label).toBe('Claimed today')
    expect(cta.reason).toContain('2h 5m')
    expect(cta.reason).toContain('$3')
    // NOT the ceiling message: this user has room and should come back.
    expect(cta.reason).not.toMatch(/used all/i)
  })

  it('falls back to midnight UTC when the server omits the countdown', () => {
    const cta = faucetCta(FAUCET({ claimed_today: true, next_drip_in_seconds: undefined }))
    expect(cta.reason).toContain('midnight UTC')
    expect(cta.reason).not.toContain('in  —')
  })

  it('says the LIFETIME ceiling is spent, and how to raise it', () => {
    const cta = faucetCta(FAUCET({ remaining_micro: 0, granted_micro: 1_000_000 }))
    expect(cta.enabled).toBe(false)
    expect(cta.label).toBe('Lifetime credit used')
    expect(cta.reason).toContain('$1')
    // The two actionable exits, neither of which is "wait until tomorrow".
    expect(cta.reason).toMatch(/followed/i)
    expect(cta.reason).toMatch(/real USDC/i)
    expect(cta.reason).not.toMatch(/tomorrow|midnight/i)
  })

  it('capped AND claimed today reads as capped', () => {
    // Ceiling is checked first on purpose: telling this user to come back
    // tomorrow is a lie, because tomorrow's drip is refused too.
    const cta = faucetCta(
      FAUCET({ remaining_micro: 0, claimed_today: true, next_drip_in_seconds: 3600 }),
    )
    expect(cta.label).toBe('Lifetime credit used')
    expect(cta.reason).not.toContain('1h')
  })

  it('the two refusals never share a message', () => {
    const capped = faucetCta(FAUCET({ remaining_micro: 0 }))
    const daily = faucetCta(FAUCET({ claimed_today: true, next_drip_in_seconds: 3600 }))
    expect(capped.label).not.toBe(daily.label)
    expect(capped.reason).not.toBe(daily.reason)
  })

  it('is disabled with an honest label when there is no faucet at all', () => {
    for (const f of [undefined, null, { available: false }]) {
      const cta = faucetCta(f)
      expect(cta.enabled).toBe(false)
      expect(cta.reason).toBeTruthy()
      // No dollar figures invented from an absent payload.
      expect(cta.label).not.toContain('$')
    }
  })

  it('a missing remaining_micro is treated as no credit, not as unlimited', () => {
    // Fail closed: `Number(undefined) || 0` → 0 → the ceiling message. Enabling
    // the button here would 400 on press.
    expect(faucetCta(FAUCET({ remaining_micro: undefined })).enabled).toBe(false)
    expect(faucetCta(FAUCET({ remaining_micro: -5 })).enabled).toBe(false)
  })
})

describe('ceilingNote — why the ceiling is what it is', () => {
  it('shows used-of-cap and the path to more', () => {
    const note = ceilingNote(FAUCET({ granted_micro: 400_000 }))
    expect(note).toContain('$0.4 of $1 used')
    expect(note).toContain('$0.2 per point')
    expect(note).toContain('$25')
  })

  it('credits existing reputation instead of telling that user to earn some', () => {
    const note = ceilingNote(FAUCET({ reputation: 3, cap_micro: 1_600_000 }))
    expect(note).toContain('3 reputation points add $0.2 each')
    expect(note).not.toMatch(/Earn reputation/)
  })

  it('says "point adds" for exactly one', () => {
    // A wallet that says "1 points" undermines the numbers next to it.
    expect(ceilingNote(FAUCET({ reputation: 1 }))).toContain('1 reputation point adds')
  })

  it('is empty when there is no faucet, so no caller renders a stray line', () => {
    expect(ceilingNote(undefined)).toBe('')
    expect(ceilingNote({ available: false })).toBe('')
  })

  it('is shown in every faucet state — including right after a claim', () => {
    // Separate from the CTA precisely so the just-claimed user still learns what
    // raises their ceiling.
    expect(ceilingNote(FAUCET({ claimed_today: true, granted_micro: 1_000_000 }))).toContain(
      'used',
    )
    expect(ceilingNote(FAUCET({ remaining_micro: 0 }))).toContain('used')
  })
})

describe('network labels — trial credit is never mistaken for money', () => {
  it('marks both trial networks as trial', () => {
    expect(networkLabel('tiny')).toContain('trial')
    expect(networkLabel('base-sepolia')).toContain('trial')
  })

  it('marks only real Base as real USDC', () => {
    expect(networkLabel('base')).toContain('real USDC')
    expect(networkLabel('base')).not.toContain('trial')
    expect(isRealMoney('base')).toBe(true)
    expect(isRealMoney('tiny')).toBe(false)
    expect(isRealMoney('base-sepolia')).toBe(false)
  })

  it('never calls the tiny chain "Sepolia" — they are different chains', () => {
    // c14's taint rules treat them alike, but a tx hash from one is invisible to
    // the other's scanner, so the user must be able to tell them apart.
    expect(networkShort('tiny')).toBe('Tiny Chain')
    expect(networkShort('base-sepolia')).toBe('Sepolia')
    expect(networkLabel('tiny')).not.toContain('Sepolia')
  })
})

describe('networkChoices — one trial chain plus real Base, never both trial chains', () => {
  it('offers the deployment’s own trial chain and Base', () => {
    expect(networkChoices('tiny')).toEqual(['tiny', 'base'])
    expect(networkChoices('base-sepolia')).toEqual(['base-sepolia', 'base'])
  })

  it('never offers the OTHER trial chain', () => {
    // Pasting a tiny-chain hash into a Sepolia claim (or the reverse) 400s
    // permanently with "no matching USDC transfer" — a dead end the picker
    // shouldn't be able to create.
    expect(networkChoices('tiny')).not.toContain('base-sepolia')
    expect(networkChoices('base-sepolia')).not.toContain('tiny')
  })

  it('a mainnet deployment shows Base alone', () => {
    expect(networkChoices('base')).toEqual(['base'])
    expect(networkChoices(undefined)).toEqual(['base'])
    expect(networkChoices('nonsense')).toEqual(['base'])
  })

  it('the deployment’s default is always selectable — the c-g bug', () => {
    // The web wallet's unions were literally `"base" | "base-sepolia"`, so a
    // tiny-chain deployment could not select its own chain at all.
    for (const net of ['tiny', 'base-sepolia', 'base'] as const) {
      expect(networkChoices(net)).toContain(net)
      expect(networkChoices(net)[0]).toBe(net)
    }
  })
})

/**
 * 📖 walletIntro — the longest money copy we ship, and the last of it still
 * written as if every deployment were real Base.
 *
 * These are ABSENCE assertions on purpose. The bug class (c-g, c27) is never a
 * missing sentence; it's a confident sentence about the wrong chain. A user
 * reads this card BEFORE they earn, so "real USDC on Base" on a chain we mint
 * decides for them that the balance is cash-outable — and they find out it
 * isn't at the withdrawal, which is the worst possible moment.
 */
describe('walletIntro', () => {
  it('real Base keeps the real-money promise', () => {
    const i = walletIntro('base')
    expect(i.custodyTitle).toBe('Real money, your custody')
    expect(i.custody).toContain('real USDC on Base')
    expect(i.quickStart).toContain('Buy or send USDC on Base')
    expect(i.reach).toContain('no tiny.technology account needed')
  })

  it('a chain we mint NEVER claims THIS balance is real money', () => {
    // The distinction that matters: naming Base as somewhere the user could GO
    // for withdrawable money is help, not a lie. Describing the balance they
    // already hold as real USDC is the bug. So the assertion is about the claim
    // ("deposits/withdrawals ARE real USDC"), not about the word "Base".
    for (const net of ['tiny', 'base-sepolia'] as const) {
      const i = walletIntro(net)
      for (const field of [i.custody, i.reach, i.quickStart, i.custodyTitle]) {
        expect(field).not.toMatch(/(deposits and withdrawals|balance here) (are|is) real/i)
        expect(field).not.toMatch(/real money, your custody/i)
      }
      // It must say what the money IS, not merely omit what it isn't.
      expect(i.custody).toContain('trial credit')
      expect(i.custody).toMatch(/cannot be withdrawn/i)
      expect(i.custodyTitle).toMatch(/trial credit/i)
      // And the one mention of real money must be an onward route, phrased as a
      // condition the user opts into — never as a description of what they have.
      expect(i.custody).toMatch(/Deposit real USDC on Base if you want/)
    }
  })

  it('earning does not launder trial credit — the c14 taint rule, in prose', () => {
    // The server enforces this (taint propagation); the copy must not imply the
    // opposite, or a creator prices their tiny expecting a payout.
    expect(walletIntro('tiny').custody).toMatch(/earning it doesn’t make it withdrawable/i)
  })

  it('stops promising the open internet as an audience (report item 10)', () => {
    // x402 is open, but an external agent cannot hold a token only we mint, so
    // "the whole internet" oversells reach on our own chain.
    const i = walletIntro('tiny')
    expect(i.reach).not.toMatch(/whole internet|no tiny\.technology account needed/i)
    expect(i.reach).toMatch(/only source|we’ve issued credit/i)
    // Still honest about x402 itself being open — the protocol isn't the limit.
    expect(i.reach).toMatch(/x402/)
  })

  it('a faucet deployment is never told to buy a token nobody sells', () => {
    const q = walletIntro('tiny').quickStart
    expect(q).not.toMatch(/buy|send USDC|on-ramp|card/i)
    expect(q).toMatch(/free daily credit/i)
  })

  it('unknown networks fall back to the real-money wording', () => {
    // asNetwork defaults to 'base', which is the SAFE default here: overstating
    // caution ("this is only trial credit") on a real-money deployment would
    // scare a user off funds that genuinely are theirs.
    expect(walletIntro(undefined).custodyTitle).toBe('Real money, your custody')
    expect(walletIntro('nonsense').custody).toContain('real USDC on Base')
  })

  it('names the chain it is talking about', () => {
    expect(walletIntro('tiny').custody).toContain('Tiny Chain')
    expect(walletIntro('base-sepolia').custody).toContain('Sepolia')
  })
})
