// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { walletAction, faucetClaim, getWallet, parseWalletSnapshot, microAmount, priceMicroOf } from '../lib/x402/wallet-client'

afterEach(() => vi.unstubAllGlobals())

const resp = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

describe('parseWalletSnapshot (the 401/424/error classification both surfaces re-derived)', () => {
  it('401 = signed out', () => {
    expect(parseWalletSnapshot(401, {})).toEqual({ status: 'unauthorized' })
  })

  it('424 or an error body = wallet service unavailable', () => {
    expect(parseWalletSnapshot(424, {})).toEqual({ status: 'unavailable' })
    expect(parseWalletSnapshot(200, { error: 'not configured' })).toEqual({ status: 'unavailable' })
  })

  it('parses a snapshot with guarded numerics — junk never becomes $NaN', () => {
    expect(parseWalletSnapshot(200, { balance_micro: 1_500_000, history: [{ delta_micro: 1, kind: 'deposit' }] }))
      .toEqual({ status: 'ok', balanceMicro: 1_500_000, history: [{ delta_micro: 1, kind: 'deposit' }] })
    expect(parseWalletSnapshot(200, { balance_micro: 'garbage', history: 'nope' }))
      .toEqual({ status: 'ok', balanceMicro: 0, history: [] })
    expect(parseWalletSnapshot(200, {}))
      .toEqual({ status: 'ok', balanceMicro: 0, history: [] })
  })
})

describe('microAmount / priceMicroOf', () => {
  it('coerces numeric strings and guards non-finite junk to 0', () => {
    expect(microAmount('500000')).toBe(500_000)
    expect(microAmount(250)).toBe(250)
    for (const junk of [undefined, null, 'abc', NaN, Infinity]) expect(microAmount(junk)).toBe(0)
  })

  it('priceMicroOf reads price_micro through the same guard', () => {
    expect(priceMicroOf({ price_micro: '750000' })).toBe(750_000)
    expect(priceMicroOf({})).toBe(0)
    expect(priceMicroOf(null)).toBe(0)
  })
})

describe('walletAction / faucetClaim (plumbing)', () => {
  it('POSTs the action body to /api/wallet and returns the parsed JSON', async () => {
    const spy = vi.fn(async (..._args: unknown[]) => resp({ price_micro: 5 }))
    vi.stubGlobal('fetch', spy)
    const d = await walletAction({ action: 'pricing', resource: 'tiny:scout' })
    expect(d).toEqual({ price_micro: 5 })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/wallet')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ action: 'pricing', resource: 'tiny:scout' })
  })

  it('propagates network failure — callers keep their own retry/degrade strategies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(walletAction({ action: 'deposit_info' })).rejects.toThrow('offline')
  })

  it('faucetClaim POSTs to the faucet route', async () => {
    const spy = vi.fn(async (..._args: unknown[]) => resp({ ok: true, credited_micro: 100 }))
    vi.stubGlobal('fetch', spy)
    expect(await faucetClaim()).toEqual({ ok: true, credited_micro: 100 })
    expect(spy.mock.calls[0]?.[0]).toBe('/api/wallet/faucet')
  })
})

describe('getWallet', () => {
  it('classifies via parseWalletSnapshot on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp({ balance_micro: 7 }, 200)))
    expect(await getWallet()).toEqual({ status: 'ok', balanceMicro: 7, history: [] })
  })

  it('degrades a network failure to status failed (page keeps a populated wallet on a blip)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await getWallet()).toEqual({ status: 'failed' })
  })

  it('survives a non-JSON body on an HTTP status that matters (401 with an empty body)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => { throw new Error('empty') } }) as unknown as Response))
    expect(await getWallet()).toEqual({ status: 'unauthorized' })
  })
})
