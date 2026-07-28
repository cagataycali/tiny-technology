/**
 * 🔗 Pin the DEPLOYMENT a payments test means.
 *
 * `paymentsNetwork()` (lib/x402/tiny-chain.ts) reads TWO env vars in precedence
 * order: `PAYMENTS_NETWORK` wins, and only when it's unset does the legacy
 * `PAYMENTS_TESTNET` boolean decide. So a test that says "a MAINNET deployment"
 * and only does `delete process.env.PAYMENTS_TESTNET` has pinned the LOWER-
 * precedence half of the selector and inherited the higher one from whatever the
 * shell exported. That was invisible while the only two values were base and
 * base-sepolia — a repo where nobody sets `PAYMENTS_NETWORK` and everybody
 * toggles `PAYMENTS_TESTNET`. Configure the self-hosted chain (`PAYMENTS_NETWORK
 * =tiny`, the deployment mode the whole chain/ directory exists for) and ten
 * tests across two files fail: not because the code is wrong, but because they
 * were reading the ambient environment as if it were a fixture.
 *
 * That is exactly the failure mode report §1.2 item 9 names ("tests pinning the
 * current chains"), and the danger is the direction it fails in. These are the
 * MINT GUARD tests — "a mainnet deployment must not accept faucet USDC on
 * sepolia and mint it into withdrawable earnings". On the deployment the report
 * asks us to build, they don't guard anything; they just go red, and a red suite
 * whose failures are all explained by "oh, that's just the env" is a suite
 * nobody reads. The next real cross-chain settle bug lands in the noise.
 *
 * So: name the deployment, always, and pin BOTH vars. `asDeployment` restores
 * the previous values afterwards (vitest's `stubEnv` needs an `unstubAllEnvs`
 * that these files don't all call, and `delete` is not a restore) so files that
 * mix deployments stay order-independent.
 *
 * Not exported as a vitest fixture on purpose: these routes freeze nothing at
 * module load — receiver/registration read the selector per CALL — so a plain
 * env swap is all that's needed and the tests keep reading as straight-line
 * code. (`tests/x402-tiny-network.test.ts` is the one file that DOES need
 * `vi.resetModules()`, because the TABLES there are module-load constants.)
 */

/** The three deployments a payments test can be about. */
export type Deployment = 'base' | 'base-sepolia' | 'tiny'

/** Deterministic anvil deploy address for TinyUSDC — same value chain/ uses. */
export const TINY_USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
export const TINY_CHAIN_ID = '31337'
export const TINY_CAIP2 = 'eip155:31337'

/** Where a correctly-configured self-hosted deployment runs chain/facilitator. */
export const TINY_FACILITATOR = 'http://127.0.0.1:8546'

const KEYS = [
  'PAYMENTS_NETWORK', 'PAYMENTS_TESTNET', 'TINY_CHAIN_ID', 'TINY_CHAIN_USDC_ADDRESS',
  // Part of what makes a deployment self-hosted: the public x402.org facilitator
  // cannot settle a chain we own, so `facilitatorUrl()` returns null (and the
  // payment door 424s) until the operator points this at their own facilitator.
  // A fixture that pinned the chain but not the facilitator would describe a
  // MISCONFIGURED deployment, and every paid-tiny assertion on it would be
  // testing the misconfiguration rather than the feature.
  'X402_FACILITATOR_URL',
] as const

const set = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

/**
 * Make the process look like `deployment`, and return the restore function.
 *
 * Both selector vars are always written, never merely cleared: on a `base`
 * deployment `PAYMENTS_NETWORK` must be *absent or 'base'*, and leaving an
 * inherited `tiny` in place is the whole bug. The tiny-chain vars are cleared
 * for the two Base deployments too, so `tinyChainConfig()` returns null and the
 * network TABLES stay two-entry — a `base` test must not see a third door just
 * because the developer has a devnet configured.
 */
export function asDeployment(deployment: Deployment): () => void {
  const saved = KEYS.map((k) => [k, process.env[k]] as const)

  if (deployment === 'tiny') {
    set('TINY_CHAIN_ID', TINY_CHAIN_ID)
    set('TINY_CHAIN_USDC_ADDRESS', TINY_USDC)
    set('PAYMENTS_NETWORK', 'tiny')
    set('PAYMENTS_TESTNET', undefined)
    // Our own facilitator — the only kind that can settle our own chain.
    set('X402_FACILITATOR_URL', TINY_FACILITATOR)
  } else {
    set('TINY_CHAIN_ID', undefined)
    set('TINY_CHAIN_USDC_ADDRESS', undefined)
    set('PAYMENTS_NETWORK', deployment)
    // Cleared, not set: on the Base chains an unset value IS the working
    // configuration (the public x402.org facilitator settles both), and a
    // facilitator inherited from a self-hosted shell would be a devnet URL.
    set('X402_FACILITATOR_URL', undefined)
    // Explicitly cleared rather than left alone: PAYMENTS_NETWORK already wins,
    // but a stale '1' here would make the intent of the fixture ambiguous to the
    // next reader, and any future selector that consults it would silently flip.
    set('PAYMENTS_TESTNET', undefined)
  }

  return () => saved.forEach(([k, v]) => set(k, v))
}
