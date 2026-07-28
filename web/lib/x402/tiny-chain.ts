/**
 * 🔗 TINY-CHAIN — the self-hosted EVM network (chain/ directory) as a payments
 * target. Pure env reads, edge-safe, zero imports — both the edge receiver and
 * the node payer/withdraw routes consume this one module so the "which chain
 * is this deployment on?" answer can never fork between them.
 *
 * Configured entirely by env (values come from chain/deployment.json):
 *   TINY_CHAIN_ID           — numeric chain id (e.g. 31337)
 *   TINY_CHAIN_USDC_ADDRESS — the TinyUSDC contract (EIP-3009, domain USDC/2)
 *   TINY_CHAIN_RPC_URL      — RPC endpoint (default http://127.0.0.1:8545)
 *   TINY_CHAIN_EXPLORER_URL — optional explorer base; no env → no tx links
 *   PAYMENTS_NETWORK        — 'tiny' | 'base' | 'base-sepolia' — replaces the
 *                             PAYMENTS_TESTNET boolean (which stays honored for
 *                             backward compat when PAYMENTS_NETWORK is unset).
 *
 * Fail-closed: a partial/malformed tiny config (bad chain id, junk address)
 * yields null, and paymentsNetwork() then refuses to select 'tiny' — a typo'd
 * deployment degrades to the legacy Base selector instead of advertising a
 * chain nothing can settle on.
 */

export interface TinyChainConfig {
  /** CAIP-2 id — the network string used across x402 (eip155:<chainId>). */
  caip2: string
  chainId: number
  /** TinyUSDC contract address — the EIP-3009 verifyingContract. */
  usdc: string
  rpc: string
  /** Short name used where base/base-sepolia use theirs (tables, worker rows). */
  short: 'tiny'
  /** EIP-712 domain name TinyUSDC.sol was deployed with. */
  domainName: 'USDC'
}

export function tinyChainConfig(): TinyChainConfig | null {
  const chainId = Number(process.env.TINY_CHAIN_ID || 0)
  const usdc = String(process.env.TINY_CHAIN_USDC_ADDRESS || '')
  if (!Number.isInteger(chainId) || chainId <= 0) return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdc)) return null
  return {
    caip2: `eip155:${chainId}`,
    chainId,
    usdc,
    rpc: process.env.TINY_CHAIN_RPC_URL || 'http://127.0.0.1:8545',
    short: 'tiny',
    domainName: 'USDC',
  }
}

/** Explorer link for a tiny-chain tx — '' when no explorer is configured, so
 *  callers emit no link rather than a dead one (same contract as the base
 *  explorerTxUrl helpers). */
export function tinyExplorerTxUrl(txHash: string): string {
  const base = String(process.env.TINY_CHAIN_EXPLORER_URL || '').replace(/\/$/, '')
  return base && txHash ? `${base}/tx/${txHash}` : ''
}

/**
 * THE single-network selector — which chain this deployment settles on.
 * PAYMENTS_NETWORK wins when set (and, for 'tiny', valid); otherwise the
 * legacy PAYMENTS_TESTNET boolean keeps meaning what it always meant, so
 * existing deploys need no env change.
 */
export function paymentsNetwork(): 'base' | 'base-sepolia' | 'tiny' {
  const n = String(process.env.PAYMENTS_NETWORK || '').toLowerCase().trim()
  if (n === 'tiny' && tinyChainConfig()) return 'tiny'
  if (n === 'base' || n === 'base-sepolia') return n
  return process.env.PAYMENTS_TESTNET === '1' ? 'base-sepolia' : 'base'
}
