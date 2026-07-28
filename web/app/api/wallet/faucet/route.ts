/**
 * 🚰 /api/wallet/faucet — the in-house daily top-up (Node runtime).
 *
 * This is what replaces the Coinbase Onramp / MoonPay / faucet.circle.com links
 * on a self-hosted-chain deployment: those all point at real-money rails, and a
 * private chain's USDC can't be bought from anyone (docs/e2e-gaps-report-
 * 2026-07-25.md §1.2 item 10). Owning the chain is exactly what lets us issue the
 * credit ourselves (chain/contracts/TinyUSDC.sol, owner-only `mint`).
 *
 * Two steps, and the ORDER is the whole design:
 *
 *   1. Worker `/pay/faucet` grants the ledger credit — one drip per UTC day,
 *      inside a reputation-scaled lifetime ceiling, both enforced in the write.
 *   2. THEN we mint the matching TinyUSDC on-chain to the deployment's deposit
 *      address, so the credit the user can spend is backed 1:1 by a token that
 *      exists.
 *
 * Ledger first, mint second, because the two failure directions are not
 * symmetric. A mint that lands with no ledger row is unbacked-in-reverse: real
 * TinyUSDC in the treasury nobody was credited for, invisible, and repeated
 * retries inflate the token's supply against a ledger that never moved. A ledger
 * credit whose mint failed is bounded, visible in the response, and harmless —
 * trial credit is not withdrawable and not spendable outbound (the three exits
 * are closed: c-d withdrawals, c-f0 outbound x402 spend, c-f0b taint), so
 * nothing here promises on-chain redemption in the first place. The reserve
 * exists to make the tiny-chain a faithful x402 sandbox, not to secure the
 * credit — so a drip that gets credit without reserve is degraded, not wrong.
 *
 * Which is also why the mint failing does NOT fail the request: refusing a drip
 * the user has already been credited for would be the worst outcome of the three
 * (the daily ref is spent; they'd see an error and no money until tomorrow).
 *
 * The signer lives here, not in the worker: the worker has no secp256k1 signer
 * and no deployer key, the same split that puts payout signing in
 * /api/wallet/withdraw.
 */
import { getSession } from '@/lib/auth'
import { enforceIpDailyLimit } from '@/lib/rate-limit'
import { createWalletClient, createPublicClient, http, defineChain, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tinyChainConfig, tinyExplorerTxUrl } from '@/lib/x402/tiny-chain'
import { isWellKnownKey, devKeysAllowed } from '@/chain/dev-keys.mjs'

export const runtime = 'nodejs'
export const maxDuration = 30

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const TINY = tinyChainConfig()

/** TinyUSDC.mint(address,uint256) — owner-only; the deployer key IS the authority. */
const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

/**
 * Mint the drip's backing TinyUSDC into the platform deposit address (the same
 * treasury an on-chain claim credits FROM, so reserve accounting has one home).
 *
 * Returns the tx hash, or null with a reason — never throws, because the caller
 * has already granted the credit and must report success regardless.
 */
async function mintReserve(micro: number): Promise<{ txHash?: string; error?: string }> {
  const pk = process.env.TINY_CHAIN_DEPLOYER_KEY || ''
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { error: 'no deployer key configured' }
  // A published anvil key here means the token's mint authority is public — the
  // reserve it would create is one anyone can mint too, so it isn't a reserve.
  // Reported as un-backed rather than thrown, like every other failure on this
  // path: the credit is already granted and the response must still succeed.
  if (isWellKnownKey(pk) && !devKeysAllowed()) return { error: 'deployer key is a published dev key' }
  const to = String(process.env.DEPOSIT_ADDRESS || '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { error: 'no deposit address configured' }
  if (!TINY) return { error: 'tiny-chain not configured' }

  try {
    const account = privateKeyToAccount(pk as `0x${string}`)
    const chain = defineChain({
      id: TINY.chainId,
      name: 'tiny-chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [TINY.rpc] } },
    })
    const walletClient = createWalletClient({ account, chain, transport: http(TINY.rpc) })
    const publicClient = createPublicClient({ chain, transport: http(TINY.rpc) })
    const hash = await walletClient.sendTransaction({
      to: TINY.usdc as `0x${string}`,
      data: encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [to as `0x${string}`, BigInt(micro)] }),
    })
    // Wait for inclusion: an un-mined mint is not a reserve, and on a 2s-block
    // devnet this costs one block. A timeout is reported as un-backed rather
    // than assumed good — under-claiming the reserve is the safe direction.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 20_000 })
    if (receipt.status !== 'success') return { error: `mint reverted (${hash})` }
    return { txHash: hash }
  } catch (e: any) {
    return { error: String(e?.message || e).slice(0, 200) }
  }
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  // The worker's per-day ledger ref already makes a second drip a no-op, so this
  // limiter isn't the money guard — it's an abuse guard on the mint path, which
  // does real RPC work per call. Keyed on the user (with their reputation
  // widening it) exactly like the chat route, per c8.
  const limited = await enforceIpDailyLimit(req, {
    requests: 20,
    keyPrefix: 'faucet_',
    userId: session.sub,
    json: true,
    message: 'Too many top-up attempts today.',
  })
  if (limited) return limited

  if (!TINY) return json({ ok: false, error: 'the in-house faucet needs a tiny-chain deployment' }, 424)

  // 1. Grant the ledger credit (day ref + lifetime ceiling both enforced in the write).
  const res = await fetch(`${WORKER_URL}/pay/faucet`, {
    method: 'POST',
    headers: ikey(),
    body: JSON.stringify({ userId: session.sub }),
  }).catch(() => null)
  if (!res) return json({ ok: false, error: 'wallet service unreachable' }, 424)
  const fr = await res.json().catch(() => ({} as any))
  // Pass the worker's refusals through verbatim — `already_claimed` /
  // `ceiling_reached` and their figures are what the clients render, and both are
  // already human sentences (unlike withdraw's one snake_case token).
  if (!fr.ok) return json({ ok: false, ...fr }, res.status)

  // 2. Back it with minted TinyUSDC. Best-effort by design (see the header).
  const reserve = await mintReserve(Number(fr.credited_micro || 0))
  if (reserve.error) {
    console.error('faucet-reserve', JSON.stringify({ userId: session.sub, micro: fr.credited_micro, reason: reserve.error }))
  }
  const explorer = reserve.txHash ? tinyExplorerTxUrl(reserve.txHash) : ''

  return json({
    ok: true,
    ...fr,
    // `reserve_backed` is the honest bit: the credit is real either way, but only
    // a landed mint means a matching token exists on-chain.
    reserve_backed: !!reserve.txHash,
    ...(reserve.txHash ? { reserve_tx: reserve.txHash } : {}),
    ...(explorer ? { explorer } : {}),
  })
}
