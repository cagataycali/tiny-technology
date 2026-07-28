/**
 * 💸 /api/wallet/withdraw — self-serve automatic withdrawals (Node runtime).
 *
 * The ONLY code path in the platform that signs with the payout key.
 * Flow (all in one request — no queue, no human):
 *   1. Session auth → worker /pay/withdraw-request (atomic ledger debit,
 *      destination FORCED to the user's linked address, $1 min, $500/day cap)
 *   2. viem signs an ERC-20 USDC transfer of the net amount from the
 *      platform payout wallet and broadcasts to Base (or Base Sepolia)
 *   3. Success → /pay/withdraw-complete (tx hash recorded)
 *      Failure → /pay/withdraw-fail (full refund, fee included)
 *
 * Security:
 *   - PAYOUT_PRIVATE_KEY lives ONLY in Vercel sensitive env; Node runtime
 *     (viem needs node crypto); never logged, never in responses.
 *   - Destination address comes from the worker (linked address), NOT from
 *     the request body — a hijacked session can only send funds to the
 *     address the account holder linked (and deposits came from).
 *   - The NETWORK also comes from the worker (the chain it debited under), not
 *     from the request body — see settleNetwork(). The body's `network` is a
 *     REQUEST the worker resolves; when this route resolved it independently the
 *     two answers diverged and trial credit debited on `tiny` was paid out as
 *     real USDC on `base`.
 *   - Velocity caps are enforced worker-side inside the atomic debit.
 */
import { getSession } from '@/lib/auth'
import { usd } from '@/lib/utils'
import { createWalletClient, createPublicClient, http, erc20Abi, encodeFunctionData, keccak256, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { tinyChainConfig, tinyExplorerTxUrl } from '@/lib/x402/tiny-chain'
import { isWellKnownKey, devKeysAllowed } from '@/chain/dev-keys.mjs'

export const runtime = 'nodejs'
export const maxDuration = 60

const WORKER_URL = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const TINY = tinyChainConfig()
const USDC: Record<string, `0x${string}`> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  // Self-hosted tiny-chain (lib/x402/tiny-chain.ts) — only when configured.
  ...(TINY ? { tiny: TINY.usdc as `0x${string}` } : {}),
}

/** Explorer link for a payout tx — '' (no link) for a tiny-chain deployment
 *  without TINY_CHAIN_EXPLORER_URL, mirroring the payer/receiver helpers. */
const explorerFor = (network: string, txHash: string): string => {
  if (network === 'tiny') return tinyExplorerTxUrl(txHash)
  return `${network === 'base-sepolia' ? 'https://sepolia.basescan.org' : 'https://basescan.org'}/tx/${txHash}`
}

/**
 * ⚖️ WHICH CHAIN DOES THIS PAYOUT LAND ON? — exactly one authority: the worker.
 *
 * This route used to answer it itself, with a two-branch ternary over the raw
 * request body:
 *
 *   body.network === 'base-sepolia' ? 'base-sepolia'
 *     : body.network === 'tiny' && TINY ? 'tiny' : 'base'
 *
 * The worker answers the SAME question with `normalizeNetwork(env, requested)`
 * (deposits.ts) — which accepts aliases (`sepolia`), CAIP-2 (`eip155:8469`), a
 * bare chain id (`8469`), any case, and falls back to the DEPLOYMENT's default
 * (`PAYMENTS_NETWORK`). The ternary accepted two exact lowercase literals and
 * fell back to mainnet Base. On production, where `PAYMENTS_NETWORK=tiny`, the
 * two disagreed on almost every input — including the commonest one, an ABSENT
 * network field (Android's `/wallet withdraw 5.00 confirm` sends none):
 *
 *   worker: normalizeNetwork(env, undefined)  → 'tiny'   (the deployment default)
 *   route:  the ternary                       → 'base'
 *
 * And the disagreement was a MINT, not a mislabel. `tiny` is a TRIAL network, so
 * the worker's debit sets `trialFactor = 0` and skips the trial exclusion — $25
 * of faucet-minted TinyUSDC passes `WITHDRAW_DEBIT_SQL` happily, because on the
 * chain we own paying it out costs nobody anything. The route then read the same
 * request as `base` and signed a transfer of `USDC['base']` — real mainnet USDC
 * out of the payout hot wallet. Minted trial credit → real money, in one
 * authenticated request with no accomplice, defeating the exclusion c-d and the
 * taint propagation c-f0b were both built to enforce (they guard the LEDGER; the
 * ledger was never the thing that lied).
 *
 * The fix is not to re-derive the worker's table here — a second copy is what
 * failed, and it would fail again the next time either side learns a network.
 * `/pay/withdraw-request` already RETURNS the network it debited under, so we
 * sign on THAT: one authority, and the money moves on the chain the ledger
 * charged. Unknown/unconfigured → refuse and refund (see the call site), never
 * fall back to a chain, because "the chain I couldn't identify" must not resolve
 * to the only one holding real money.
 *
 * `table` is injectable because USDC is built at MODULE LOAD from
 * `tinyChainConfig()` — a test that imported this route could otherwise only ever
 * exercise the two-Base shape, which is exactly the deployment where the bug
 * didn't bite.
 */
export const settleNetwork = (
  workerNetwork: unknown,
  table: Record<string, string> = USDC,
): string | null => {
  // typeof, not String(): `["base"]` stringifies to exactly "base", so a coercing
  // guard would accept a JSON array as a network name. The worker's field is a
  // string; anything else is not the worker's answer and must not be signed for.
  if (typeof workerNetwork !== 'string') return null
  // hasOwnProperty, not `table[n]`: a reply of "constructor" or "toString" would
  // otherwise resolve truthy off the prototype and be signed for.
  return Object.prototype.hasOwnProperty.call(table, workerNetwork) ? workerNetwork : null
}

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return json({ ok: false, error: 'login required' }, 401)

  const pk = process.env.PAYOUT_PRIVATE_KEY || ''
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    return json({ ok: false, error: 'withdrawals not configured on this deployment' }, 424)
  }
  // This key has no unsafe DEFAULT (unset → the 424 above), but it is the one
  // place in the app that signs a transfer of real balance, and a devnet operator
  // reaching for "a key that already has ETH" reaches for anvil's. Anyone can
  // drain a wallet whose key is published, so treat it as unconfigured rather
  // than debit a ledger for a payout that will be stolen or bounce.
  if (isWellKnownKey(pk) && !devKeysAllowed()) {
    return json({ ok: false, error: 'withdrawals not configured on this deployment' }, 424)
  }

  const body = await req.json().catch(() => ({} as any))
  const amountMicro = Math.floor(Number(body.amount_micro))
  if (!Number.isFinite(amountMicro) || amountMicro <= 0) {
    return json({ ok: false, error: 'amount_micro required' }, 400)
  }

  // 1. Atomic ledger debit + pending row (worker enforces destination/caps).
  //    The requested network is FORWARDED RAW — normalizing it here would be the
  //    second copy of the table that `settleNetwork` exists to delete. The worker
  //    resolves it (aliases, CAIP-2, chain id, the deployment default) and tells
  //    us what it actually debited.
  const reqRes = await fetch(`${WORKER_URL}/pay/withdraw-request`, {
    method: 'POST', headers: ikey(),
    body: JSON.stringify({
      userId: session.sub,
      amount_micro: amountMicro,
      ...(body.network === undefined || body.network === null ? {} : { network: String(body.network) }),
    }),
  }).catch(() => null)
  if (!reqRes) return json({ ok: false, error: 'wallet service unreachable' }, 424)
  const wr = await reqRes.json().catch(() => ({} as any))
  if (!wr.ok) {
    // Humanize the worker's most common rejection. `insufficient_withdrawable_
    // balance` is the ONE withdraw error the worker returns as a raw snake_case
    // machine token (every other — "minimum withdrawal is $1", "daily
    // withdrawal cap is $500" — is already a human sentence), and it uniquely
    // ships withdrawable_micro + balance_micro SPECIFICALLY to explain the
    // shortfall. All 3 clients render `error` verbatim, so without this they
    // show "insufficient_withdrawable_balance" and drop those figures — worst
    // when unspent testnet-trial credits lock real USDC out of withdrawal
    // (balance looks sufficient but withdrawable is lower). Rewrite it here in
    // the one route all 3 clients share, naming the actual withdrawable amount.
    if (wr.error === 'insufficient_withdrawable_balance') {
      const withdrawable = Number(wr.withdrawable_micro || 0)
      const balance = Number(wr.balance_micro || 0)
      const trialLocked = balance > withdrawable
      const human = `You can withdraw ${usd(withdrawable)} right now` +
        (trialLocked
          ? ` — your balance is ${usd(balance)} but testnet trial credits aren't withdrawable as real USDC.`
          : `. Lower the amount or add funds.`)
      // `error` AFTER the spread so the human message wins — `...wr` carries the
      // raw `insufficient_withdrawable_balance` token that would otherwise clobber it.
      return json({ ok: false, ...wr, error: human }, reqRes.status)
    }
    return json({ ok: false, ...wr, error: wr.error || 'withdrawal request rejected' }, reqRes.status)
  }

  // 1b. The chain the LEDGER charged — the only network this route will sign for.
  //     Checked after the debit because the debit is what decides it, so the
  //     refusal path must REFUND (a debit that outlives an unsignable payout is
  //     money the user lost to a config mismatch). Reachable two ways, both
  //     configuration rather than input: the worker names a network this
  //     deployment has no USDC address for (e.g. it resolved 'tiny' from
  //     PAYMENTS_NETWORK while the app's TINY_CHAIN_* env is unset or malformed —
  //     `tinyChainConfig()` fails closed, so `USDC.tiny` is absent), or an older
  //     worker omits `network` entirely. Refusing beats the old behaviour of
  //     signing on `base`: mainnet is precisely the wrong guess, since it's the
  //     only entry in USDC that moves real money.
  const network = settleNetwork(wr.network)
  if (!network) {
    await fetch(`${WORKER_URL}/pay/withdraw-fail`, {
      method: 'POST', headers: ikey(),
      body: JSON.stringify({ id: wr.id, error: `unsupported settlement network (${String(wr.network ?? 'none')})` }),
    }).catch(() => { /* pending row + debit remain — visible in withdrawals for repair */ })
    console.error(`[wallet/withdraw] worker debited on '${String(wr.network ?? '')}' — no USDC address configured for it; refunded ${wr.id}`)
    return json({ ok: false, error: 'withdrawals are not configured for this network on this deployment (refunded)' }, 424)
  }

  // 2. Sign + broadcast the USDC transfer (net amount). CRITICAL refund rule:
  //    a refund is safe ONLY when no USDC can have moved — i.e. the broadcast
  //    never happened, or the tx was mined and REVERTED. Once the signed tx is
  //    in the mempool it may confirm at any time; auto-refunding on a mere
  //    confirmation timeout would double-pay (USDC lands on-chain AND the ledger
  //    is credited back) — a real platform loss. So `txHash` gates the catch:
  //    unset → refund; set → never refund.
  //
  //    We SIGN LOCALLY FIRST, then broadcast as a separate step — instead of
  //    writeContract (which bundles sign+send). The tx hash is keccak256 of the
  //    signed serialized tx, deterministic and known the instant we sign, BEFORE
  //    any network I/O. That closes the response-loss double-pay tail of the
  //    bundled call: writeContract signs+sends atomically, so if the node
  //    ACCEPTS the broadcast but the HTTP response is lost (a drop after the
  //    node has it), it throws with txHash still unset → the catch refunds while
  //    the tx confirms on-chain = double-pay. Signing first means a lost
  //    sendRawTransaction ack still has txHash set → the pending/never-refund
  //    path. Purely tightens the gate: a signed-but-unsent tx that genuinely
  //    never reached any node lands pending (reconciliation confirms it dropped
  //    and refunds out-of-band) — the safe direction for an irreversible payout.
  let txHash: `0x${string}` | undefined
  try {
    const account = privateKeyToAccount(pk as `0x${string}`)
    // `TINY!` is sound here: `network` came through settleNetwork, so it is a KEY
    // of USDC, and the `tiny` key exists only when `tinyChainConfig()` returned
    // non-null. (Before, this leaned on the request body having said 'tiny'.)
    const chain = network === 'tiny'
      ? defineChain({
          id: TINY!.chainId, name: 'tiny-chain',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [TINY!.rpc] } },
        })
      : network === 'base-sepolia' ? baseSepolia : base
    const rpc = network === 'tiny' ? TINY!.rpc
      : network === 'base-sepolia'
        ? (process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
        : (process.env.BASE_RPC_URL || 'https://mainnet.base.org')

    const walletClient = createWalletClient({ account, chain, transport: http(rpc) })
    const publicClient = createPublicClient({ chain, transport: http(rpc) })

    // Build the ERC-20 transfer calldata; destination from the WORKER (linked
    // address), never the request body.
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [wr.to_address as `0x${string}`, BigInt(wr.net_micro)],
    })
    // Prepare (nonce/gas/fees) + sign — no broadcast yet. prepareTransactionRequest
    // does read-only RPC (nonce, gas estimate); a failure here throws with txHash
    // still unset → safe refund (nothing signed, nothing sent).
    const request = await walletClient.prepareTransactionRequest({
      to: USDC[network], data,
    })
    const serializedTransaction = await walletClient.signTransaction(request as any)
    // The hash is fixed at signing: keccak256 of the signed serialized tx is
    // EXACTLY the hash the network will index it under. Set txHash NOW so any
    // failure past this line is "signed — may have been broadcast" → never refund.
    txHash = keccak256(serializedTransaction)

    // Broadcast the pre-signed tx. If the node accepts it but the ack is lost,
    // this throws — but txHash is already set, so the catch takes the pending
    // path (no refund), and the tx confirms under the hash we already have.
    await walletClient.sendRawTransaction({ serializedTransaction })

    // Wait for inclusion so "paid" means on-chain, not just broadcast.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 45_000 })

    if (receipt.status !== 'success') {
      // Mined but REVERTED — the USDC never left the payout wallet, so the
      // debit must be undone. This is the one broadcast outcome that's safe to
      // refund (distinct from the timeout path in the catch below).
      await fetch(`${WORKER_URL}/pay/withdraw-fail`, {
        method: 'POST', headers: ikey(),
        body: JSON.stringify({ id: wr.id, error: `reverted on-chain (${txHash})` }),
      }).catch(() => { /* pending row + debit remain — visible for repair */ })
      return json({ ok: false, error: 'payout reverted on-chain (refunded)' }, 502)
    }

    // 3a. Mark paid
    await fetch(`${WORKER_URL}/pay/withdraw-complete`, {
      method: 'POST', headers: ikey(),
      body: JSON.stringify({ id: wr.id, txHash }),
    }).catch(() => { /* tx IS on-chain; status repair is idempotent + auditable via tx_hash */ })

    const explorer = explorerFor(network, txHash)
    return json({
      ok: true, id: wr.id, tx_hash: txHash, network,
      net_micro: wr.net_micro, fee_micro: wr.fee_micro,
      // Omitted (not '') when the chain has no explorer — clients render links
      // only for a present field, so no dead <a> on a tiny-chain deployment.
      ...(explorer ? { explorer } : {}),
    })
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 200)
    if (txHash) {
      // Broadcast SUCCEEDED but we couldn't confirm (receipt timeout / RPC
      // blip). The transfer is in the mempool and will likely confirm — we
      // must NOT refund (that would double-pay a landing tx). Leave the row
      // pending with the hash logged for reconciliation to resolve (complete
      // if it confirmed, fail+refund only if it truly dropped/reverted).
      console.error('withdraw-reconcile', JSON.stringify({ id: wr.id, txHash, userId: session.sub, reason: msg }))
      const explorer = explorerFor(network, txHash)
      return json({
        ok: false, pending_confirmation: true, id: wr.id, tx_hash: txHash, network,
        error: `payout broadcast but not yet confirmed — do not retry; it'll be verified shortly (tx ${txHash})`,
        ...(explorer ? { explorer } : {}),
      }, 202)
    }
    // Nothing broadcast → the debit must never outlive a failed broadcast.
    await fetch(`${WORKER_URL}/pay/withdraw-fail`, {
      method: 'POST', headers: ikey(),
      body: JSON.stringify({ id: wr.id, error: msg }),
    }).catch(() => { /* worst case: pending row + debit remain — visible in withdrawals table for repair */ })
    return json({ ok: false, error: `payout failed (refunded): ${msg}` }, 502)
  }
}
