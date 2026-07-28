// 🖊️ Sender screening for the ONE write method the public endpoint allows.
//
// rpc-proxy.mjs allows `eth_sendRawTransaction` on purpose: unlike
// `eth_sendTransaction` (which anvil signs with its own unlocked accounts), a raw
// transaction arrives already signed, so the caller must hold the key. That is a
// real security property on every chain — except ours, where ten of the keys are
// published.
//
// anvil funds the ten accounts of its default mnemonic with 10,000 ETH each and
// prints the mnemonic in its startup banner. `web3_clientVersion` (also
// allowlisted, because wallets ask) answers `anvil/vX` through the tunnel, so
// finding the endpoint is finding the keys. Nothing can be STOLEN with them —
// TinyUSDC's `mint` is owner-only and none of the ten holds a cent of it — but
// 80,000 ETH of gas is a free, unauthenticated, permanent write channel into the
// chain: unbounded contract deploys and storage writes, all of which land in
// `~/.tiny-chain/state` on one Mac mini that also serves the facilitator, the
// proxy and the tunnel. The abuse is availability and disk, not theft, and it
// costs the attacker nothing.
//
// So: c33's rule, one layer out. A transaction signed with a published key isn't
// a transaction, and the only surface the internet can reach is where that gets
// enforced. `TINY_CHAIN_ALLOW_DEV_KEYS=1` opts a throwaway devnet back in.
import { recoverTransactionAddress } from 'viem'
import { isWellKnownAddress, wellKnownIndex, devKeysAllowed } from './dev-keys.mjs'

export const RAW_TX_METHOD = 'eth_sendRawTransaction'

// EIP-1474's "transaction rejected". NOT -32601 (method not found) — the method
// IS available here; this particular transaction is the thing being refused, and
// a client that reads -32601 as "old node, retry differently" would retry forever.
//
// anvil uses this same code for its own rejections ("Insufficient funds for gas
// * price + value"), which is correct — both mean "this transaction is rejected"
// — so the MESSAGE is what tells them apart. A private code would be worse: any
// client special-casing it would break as soon as the node grew the same case.
export const RAW_TX_REJECTED = -32003

/** The raw hex of an eth_sendRawTransaction item, or null if it isn't one. */
export function rawTxParam(item) {
  if (!item || item.method !== RAW_TX_METHOD) return null
  const p = Array.isArray(item.params) ? item.params[0] : undefined
  return typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? p : null
}

/**
 * Recover the signer of a raw transaction. Returns a lowercased address, or null
 * if this cannot be determined — never throws.
 *
 * ⚠️ Null means "don't know", and the caller must FORWARD on null (fail open).
 * A tx type viem cannot parse yet but the node can (blob txs, EIP-7702
 * set-code, whatever ships next) must not be refused by a proxy that is not a
 * validator: the node is the authority on what is a valid transaction, and
 * turning "my viem is old" into "your payment is rejected" breaks real users to
 * defend against a case that is no worse than today's behaviour.
 */
export async function recoverRawTxSender(hex) {
  try {
    const addr = await recoverTransactionAddress({ serializedTransaction: hex })
    return typeof addr === 'string' ? addr.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Screen one JSON-RPC item. Resolves to a JSON-RPC error RESPONSE to answer
 * locally, or null to forward it upstream.
 *
 * @param {any} item
 * @param {Record<string, string | undefined>} [env]
 */
export async function screenRawTx(item, env = process.env) {
  const hex = rawTxParam(item)
  if (hex === null) return null // not a raw tx (or malformed — the node says so)
  if (devKeysAllowed(env)) return null

  // No size shortcut on purpose: skipping the check for a large payload would be
  // a bypass anyone could pad their way into, and RLP decoding is linear in a
  // body the proxy already caps at 1MB.
  const sender = await recoverRawTxSender(hex)
  if (sender === null || !isWellKnownAddress(sender)) return null

  const i = wellKnownIndex(sender)
  return {
    jsonrpc: '2.0',
    id: item?.id ?? null,
    error: {
      code: RAW_TX_REJECTED,
      // Names the account, not the key: an operator who typo'd their env sees
      // immediately what happened, and there is nothing here a prober did not
      // already know (they signed it).
      message: `transactions signed by anvil account #${i < 0 ? '?' : i} are not accepted: `
        + 'its private key is published in anvil\'s default mnemonic. Use a key you generated.',
    },
  }
}

/**
 * Screen a whole forward list. Returns `{ forward, refused }` — refused items are
 * answered locally and NEVER reach the node, exactly like an off-allowlist method.
 *
 * @param {any[]} items
 * @param {Record<string, string | undefined>} [env]
 */
export async function screenRawTxBatch(items, env = process.env) {
  const forward = []
  const refused = []
  // Sequential, not Promise.all: the common batch has at most one raw tx in it,
  // and an unbounded parallel ecrecover fan-out on a public endpoint is its own
  // little amplifier.
  for (const item of items) {
    const bad = await screenRawTx(item, env)
    if (bad) refused.push(bad)
    else forward.push(item)
  }
  return { forward, refused }
}
