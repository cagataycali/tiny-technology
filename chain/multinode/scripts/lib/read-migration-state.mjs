/**
 * 📖 THE ONE READER both the plan and its execution go through.
 *
 * ⚠️⚠️ WHY EXTRACTED. c22 needed an executor for the funding plan, and the obvious
 * shape — a script that reads the chain and sends the transactions — gives the
 * executor its OWN copy of the reading logic. Then the plan a human reviewed and the
 * plan the machine executes are two different computations that merely agree today,
 * and the whole c17→c21 arc was about exactly this class of drift. Worse here: the
 * reader is where the two hard-won facts live (the birth set is a FACT when the
 * incoming registry exists, and stake already posted must be subtracted), so a
 * second copy is a second chance to re-make both mistakes with real money.
 *
 * So there is one reader. `--dry-run` and execution differ only in whether the
 * transactions get sent.
 *
 * READ-ONLY: no writes, no signing, no fs writes.
 */
import { createPublicClient, http, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const EXPECTED_CHAIN_ID = 8470

export const REG_ABI = [
  { name: 'getValidators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { name: 'stakeOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'minStake', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'minValidators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxValidators', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'stake', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
]
export const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
]

export const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
export const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'

/**
 * Every private key on this machine that could sign a stake(). Node keys live under
 * the multinode home; the 8555 joiner lives OUTSIDE it, which is exactly the kind of
 * thing a scan rooted at one directory reports as "keyless" — so search both, and
 * treat "we hold no key" as a claim that needed looking rather than a default.
 *
 * Returns address → {path, account}. The account is needed to SIGN; nothing writes it
 * anywhere and it never leaves this process.
 */
export function localKeys() {
  const roots = [HOME_DIR, join(homedir(), '.tiny-chain/joiner'), join(homedir(), '.tiny-chain')]
  const found = new Map()
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    const candidates = [join(root, 'data/key'), ...entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name, 'data/key'))]
    for (const kp of candidates) {
      if (!existsSync(kp)) continue
      try {
        const raw = readFileSync(kp, 'utf8').trim()
        const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`)
        found.set(getAddress(account.address), { path: kp.replace(homedir(), '~'), account })
      } catch {
        /* not a key file */
      }
    }
  }
  return found
}

/**
 * Read everything the planner needs, once.
 *
 * @param {object} [opts]
 * @param {string} [opts.incoming]  override the recorded validatorContractSlashable
 * @returns state suitable for planStakeMigration(), plus the provenance strings the
 *   report needs so a FACT is never printed as though it were a PREDICTION.
 */
export async function readMigrationState(opts = {}) {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) throw new Error(`no ${deployPath} — nothing to plan`)
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  const outgoing = getAddress(d.validatorContract)
  const incomingRaw = opts.incoming || d.validatorContractSlashable

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}. The LIVE chain is 8469 — never point this at it.`)
  }

  const rd = (address, functionName, args = []) => pub.readContract({ address, abi: REG_ABI, functionName, args })

  /**
   * The set Besu inherits at the transition.
   *
   * ⚠️ c21: this has two cases, and conflating them reports a set nobody will
   * actually get. If the incoming registry is ALREADY DEPLOYED, its seated set is a
   * FACT — read it. Only when there is nothing to read is it a PREDICTION, and then
   * the honest model of the prediction is the outgoing registry's seated set, because
   * that is what deploy-validators-slashable seeds from.
   *
   * Predicting when the answer exists was actively wrong here: after c20's deploy the
   * prediction still contained a ghost the real registry does NOT seat, so the plan
   * warned about a keyless seat that no longer existed and computed quorum over 6
   * addresses when the chain would inherit 5. It erred toward refusing, so nothing
   * broke — which is exactly why it could have gone unnoticed.
   */
  let bornSeats
  let bornFrom
  if (incomingRaw) {
    bornSeats = (await rd(getAddress(incomingRaw), 'getValidators')).map((a) => getAddress(a))
    bornFrom = 'the INCOMING registry (deployed — this is a fact, not a prediction)'
  } else {
    bornSeats = (await rd(outgoing, 'getValidators')).map((a) => getAddress(a))
    bornFrom = 'the OUTGOING seated set (predicted — no incoming registry deployed yet; this is what deploy-validators-slashable would seed from, ghosts included)'
  }

  // If an incoming registry already exists, read ITS parameters — they are what a
  // rotate() there will actually enforce, and they need not match the outgoing.
  const paramSource = incomingRaw ? getAddress(incomingRaw) : outgoing
  const [minStake, minValidators, maxValidators] = await Promise.all([
    rd(paramSource, 'minStake'),
    rd(paramSource, 'minValidators'),
    rd(paramSource, 'maxValidators'),
  ])

  const head = await pub.getBlockNumber()
  // Cover at least one round-robin of the larger set, ×3 — the c15 rule: a healthy
  // validator that has not had its turn reads as silent.
  const window = Math.max(bornSeats.length, 1) * 3
  const proposers = new Set()
  for (let i = 0; i < window; i++) {
    const b = await pub.getBlock({ blockNumber: head - BigInt(i) })
    proposers.add(b.miner.toLowerCase())
  }

  const keys = localKeys()
  const usdc = getAddress(d.usdc)
  const outgoingSeated = new Set((await rd(outgoing, 'getValidators')).map((a) => getAddress(a).toLowerCase()))
  const validators = []
  for (const address of bornSeats) {
    const [freeMicro, stakedOutgoingMicro, alreadyStakedMicro, nativeWei] = await Promise.all([
      pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
      rd(outgoing, 'stakeOf', [address]),
      // Stake already posted in the INCOMING registry. Re-running after executing
      // part of the plan must not re-plan what already landed — `stake()` is
      // cumulative, so ignoring this asks for double and then refuses when the
      // balance ran out.
      incomingRaw ? rd(getAddress(incomingRaw), 'stakeOf', [address]) : Promise.resolve(0n),
      // ⚠️ Gas is priced at zero here, but a ZERO-BALANCE sender is not the same as
      // free gas: its transaction is accepted, then never mined AND never rejected.
      // The invariant is `balance > 0`, and it is invisible in token balances.
      pub.getBalance({ address }),
    ])
    validators.push({
      address,
      live: proposers.has(address.toLowerCase()),
      hasKey: keys.has(address),
      freeMicro,
      alreadyStakedMicro,
      nativeWei,
      // ⚠️ Only true for addresses the outgoing registry actually seats — a live
      // newcomer seated by the incoming registry has nothing trapped, and claiming
      // otherwise would report stake as lost that was never there.
      seatedOutgoing: outgoingSeated.has(address.toLowerCase()),
      stakedOutgoingMicro,
    })
  }

  return {
    pub, deployment: d, deployPath, chainId, head, window,
    outgoing, incomingRaw, paramSource, bornFrom,
    usdc, minStake, minValidators, maxValidators,
    keys, validators,
  }
}
