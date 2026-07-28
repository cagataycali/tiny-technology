// 🔑 THE WELL-KNOWN DEV KEYS — one list, so nothing can silently ship with one.
//
// anvil (and hardhat, and ganache) derive their accounts from a PUBLISHED test
// mnemonic: "test test test test test test test test test test test junk". Every
// private key below is in that mnemonic's first ten accounts, printed in anvil's
// startup banner, and pasted in thousands of public tutorials. They are not
// secrets and were never meant to be — they exist so a local devnet needs zero
// setup.
//
// Which is exactly why they made such comfortable DEFAULTS in this directory:
//
//   chain/scripts/deploy.mjs      TINY_CHAIN_DEPLOYER_KEY  || anvil #0
//   chain/facilitator/server.mjs  FACILITATOR_RELAYER_KEY  || anvil #9
//
// On a throwaway devnet that is correct and convenient. On the chain we actually
// run it is the c32 failure mode again, and worse: **a missing env is easy to
// guard, but a wrong default reads as configured.** The deployer default is the
// most dangerous value in the repo, because TinyUSDC's `mint` is owner-only and
// the owner is fixed AT DEPLOY TIME — deploy once with anvil #0 and the token's
// monetary authority is a keypair the entire internet has. Nothing can revoke
// it afterwards; the only remedy is redeploying the token and migrating every
// balance. The relayer default is milder (it only pays gas, and holds no USDC by
// design) but it signs the transactions that settle other people's payments, so
// anyone can drain its ETH and stop settlement.
//
// This module is deliberately plain `.mjs` with no imports: `chain/`'s scripts
// are ESM run by bare node, while this repo's suite is TypeScript, and both
// consume this file directly (tsconfig `allowJs`, and tests/dev-keys.test.ts
// imports it). One list, both worlds — a TS copy would be a second place to
// forget an address.

/** anvil / hardhat's published test mnemonic. Not a secret; the point is that. */
export const WELL_KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk'

/**
 * The private keys of that mnemonic's first ten accounts, lowercased. Compared
 * as strings so this file needs no crypto library — a key is either literally
 * one of these or it isn't, and deriving addresses to compare would be a slower
 * way to get the same answer.
 */
export const WELL_KNOWN_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // #0
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // #1
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // #2
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // #3
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // #4
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // #6
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', // #7
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // #8
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // #9
]

/**
 * The matching addresses, lowercased — so a caller holding only an address (a
 * deployment.json's `deployer`, a token's on-chain `owner()`) can check it
 * without a key. Index-aligned with WELL_KNOWN_KEYS.
 */
export const WELL_KNOWN_ADDRESSES = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', // #0
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', // #1
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', // #2
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906', // #3
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', // #4
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', // #5
  '0x976ea74026e726554db657fa54763abd0c3a0aa9', // #6
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955', // #7
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', // #8
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720', // #9
]

const norm = (s) => String(s ?? '').trim().toLowerCase()

/**
 * Is this private key one of the published dev keys?
 *
 * Whitespace- and case-tolerant, because the realistic way one of these arrives
 * in production is pasted into a dashboard env field with a stray newline, and a
 * guard that a trailing space defeats is not a guard.
 */
export function isWellKnownKey(key) {
  const k = norm(key)
  return k !== '' && WELL_KNOWN_KEYS.includes(k)
}

/** Is this ADDRESS one of the published dev accounts? (For key-less checks.) */
export function isWellKnownAddress(addr) {
  const a = norm(addr)
  return a !== '' && WELL_KNOWN_ADDRESSES.includes(a)
}

/**
 * Which account index, or -1. Only for messages — "this is anvil #0, the account
 * every tutorial uses" tells an operator far more than "this key is unsafe", and
 * an operator who doesn't understand the warning will override it.
 */
export function wellKnownIndex(keyOrAddress) {
  const v = norm(keyOrAddress)
  const k = WELL_KNOWN_KEYS.indexOf(v)
  if (k !== -1) return k
  return WELL_KNOWN_ADDRESSES.indexOf(v)
}

/**
 * Does this deployment consider a dev key acceptable?
 *
 * TINY_CHAIN_ALLOW_DEV_KEYS=1 is the deliberate opt-in for what dev keys are
 * FOR: `npm run e2e`, `e2e:facilitator` and `devnet.sh` spin up a scratch anvil
 * whose accounts are these accounts, and demanding a generated key there would
 * make the test suite worse with no safety gained.
 *
 * An env var rather than a code flag because the honest signal is "who started
 * this process", which only the environment knows. Explicit opt-IN, never
 * opt-out: the safe state has to be the one you get by doing nothing, since the
 * whole bug being fixed is a default nobody chose.
 *
 * The `env` parameter is what keeps that grant from leaking: chain/'s
 * scratch-anvil scripts set it process-wide, so a caller that wants to ask about
 * a DIFFERENT environment (a test, or a future per-request check) must be able to
 * hand one in. Typed loosely on purpose — `process.env`'s own type demands
 * NODE_ENV, which a caller passing `{}` obviously doesn't have.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function devKeysAllowed(env = process.env) {
  return norm(env?.TINY_CHAIN_ALLOW_DEV_KEYS) === '1'
}

/**
 * The refusal message for a well-known key in `label`'s slot. Names the account
 * index, the override, and — for the deployer — why it is unrecoverable.
 */
export function devKeyRefusal(label, keyOrAddress) {
  const i = wellKnownIndex(keyOrAddress)
  const who = i >= 0 ? `anvil account #${i}` : 'a well-known dev key'
  return `refusing to use ${who} as ${label}: its private key is published in ` +
    `anvil's default mnemonic, so anyone can sign with it. Set a generated key, ` +
    `or export TINY_CHAIN_ALLOW_DEV_KEYS=1 for a throwaway devnet.`
}
