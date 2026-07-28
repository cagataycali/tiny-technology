#!/usr/bin/env node
/**
 * P4-enforcement acceptance: does a conviction actually COST the convict
 * anything, and does it cost the chain nothing?
 *
 * TinySlashing proved equivocation and recorded verdicts; TinyValidatorsSlashable
 * is the registry that reads the docket. Three claims to establish, each with a
 * matching way of being false:
 *
 *  1. A convict cannot be seated, cannot withdraw, and can be stripped by anyone.
 *     False if the eligibility check is cosmetic — which is why every one of these
 *     runs a REAL rotate() with a REAL convict in the candidate pool, rather than
 *     reading isConvicted() and calling it enforcement.
 *
 *  2. The floor still beats enforcement: rotate() refuses rather than commit a set
 *     below minValidators, even to unseat a cheat. False if excluding convicts can
 *     halt a chain, which would make the mechanism a weapon.
 *
 *  3. A broken court cannot freeze the registry. False if any court failure shape
 *     makes rotate() revert — and "the court is broken" is a silent state, so the
 *     only proof is to BREAK one on purpose. Three shapes: an EOA (staticcall
 *     succeeds, empty return), a wrong contract (no such selector, reverts), and a
 *     gas bomb (answers, but tries to burn the frame). The third needs MockCourt.
 *
 * The convictions used here are real: a throwaway key double-signs a real block
 * this devnet produced and TinySlashing adjudicates it. Nothing is stubbed on the
 * court side.
 *
 * ⚠️ Runs entirely against a SCRATCH REGISTRY IT DEPLOYS ITSELF, seeded with the
 * validators actually producing blocks and sharing the real court. Every seating
 * claim below is therefore about a real contract on a real chain with real
 * consensus history, and about consensus for nobody.
 *
 * ⚠️⚠️ IT USED TO REUSE `validatorContractSlashable`, AND THAT WAS A LEAK. The suite
 * stakes keys that exist only inside this process and then rotates; afterwards their
 * stake can never be removed by anyone (unstake() reverts StillSeated(), requestExit()
 * needs their signature, forfeit() needs a conviction they never earn). Every run
 * therefore added permanent eligible ghosts to whatever registry it was aimed at,
 * raising quorum with no matching increase in live processes. Once that field became
 * the funded, preflight-green SWAP TARGET (c22), one more run would have turned a
 * survivable transition into an unrecoverable halt — while reporting success, because
 * staking and rotating is what the suite is for. Ownership of the fixture is the fix;
 * see chain/multinode/e2e-registry-target.mjs.
 *
 * Usage:
 *   node chain/multinode/scripts/slashable-registry-e2e.mjs
 *   node chain/multinode/scripts/slashable-registry-e2e.mjs --registry 0x…  # a superseded instance
 */
import {
  createPublicClient, createWalletClient, http, defineChain, keccak256, numberToHex, getAddress,
  toFunctionSelector,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { roundOf, forgeEquivocation } from './lib/qbft-header.mjs'
import { chooseE2ERegistry } from '../e2e-registry-target.mjs'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const EXPECTED_CHAIN_ID = 8470

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n── ${t}`)

/**
 * The custom-error NAME a call reverted with — see slashing-e2e.mjs for why the
 * name, and not "did it revert", is the only useful answer.
 *
 * `abi` is optional and only needed for CONSTRUCTOR reverts. viem decodes custom
 * errors for function calls but not for a deploy: `shortMessage` is the useless
 * "Execution reverted with reason: Execution reverted." while `e.cause.data`
 * carries the bare 4-byte selector. Without this fallback a constructor guard
 * cannot be told from a broken test — and the first version of section 7 was
 * exactly that, reporting a working `BadConfig` check as a failure twice.
 */
async function reverted(fn, abi) {
  try {
    await fn()
    return null
  } catch (e) {
    for (let c = e; c; c = c.cause) {
      if (c.data?.errorName) return c.data.errorName
      if (c.name === 'ContractFunctionRevertedError' && c.reason) return c.reason
    }
    if (abi) {
      for (let c = e; c; c = c.cause) {
        const raw = typeof c.data === 'string' ? c.data : c.raw
        if (typeof raw === 'string' && raw.startsWith('0x') && raw.length >= 10) {
          const sel = raw.slice(0, 10).toLowerCase()
          for (const item of abi) {
            if (item.type !== 'error') continue
            const sig = `${item.name}(${(item.inputs || []).map((i) => i.type).join(',')})`
            if (toFunctionSelector(sig).toLowerCase() === sel) return item.name
          }
          return raw
        }
      }
    }
    return e.shortMessage || e.message
  }
}

const artifact = (name) =>
  JSON.parse(readFileSync(join(MULTINODE, `artifacts/${name}.sol/${name}.json`), 'utf8'))

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) {
    console.error(`no ${deployPath} — run the deploy scripts first`)
    process.exit(1)
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  for (const [k, hint] of [
    ['slashing', 'deploy-slashing.mjs'],
    ['validatorContractSlashable', 'deploy-validators-slashable.mjs'],
  ]) {
    if (!d[k]) { console.error(`no ${k} in the deployment file — run ${hint} first`); process.exit(1) }
  }

  const regArt = artifact('TinyValidatorsSlashable')
  const reg = regArt.abi
  const court = artifact('TinySlashing').abi
  // Foundry flattens the artifact path — contracts/mocks/MockCourt.sol lands at
  // artifacts/MockCourt.sol/, not artifacts/mocks/….
  const mockArt = artifact('MockCourt')
  const usdcAbi = JSON.parse(
    readFileSync(join(dirname(MULTINODE), 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8')
  ).abi

  const pub = createPublicClient({ transport: http(RPC) })
  const chainId = await pub.getChainId()
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${RPC} is chain ${chainId}, expected ${EXPECTED_CHAIN_ID}`)
    process.exit(1)
  }
  const chain = defineChain({
    id: chainId, name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
  const wait = (hash) => pub.waitForTransactionReceipt({ hash })
  const C = (functionName, args = []) =>
    pub.readContract({ address: d.slashing, abi: court, functionName, args })

  console.log(`chain ${chainId} @ ${RPC}`)
  console.log(`TinySlashing            ${d.slashing}`)
  console.log(`authoritative registry  ${d.validatorContract}  ← what Besu actually reads`)
  console.log(`designated swap target  ${d.validatorContractSlashable}  ← funded; this suite must NOT touch it`)

  /**
   * ⚠️⚠️ WHICH REGISTRY THIS SUITE OWNS — the c23 fix.
   *
   * This suite stakes throwaway keys, convicts one, and calls a REAL rotate(). That
   * is deliberate and correct: reading isConvicted() and calling it enforcement is
   * exactly what it was written to avoid. But it means the suite RESHAPES the
   * validator set of whatever registry it is pointed at.
   *
   * It used to point at `d.validatorContractSlashable` and carry one guard: refuse if
   * that equals the authoritative registry. The premise was "not authoritative ⇒ safe
   * to reshape", and c22 falsified it. That field is now the DESIGNATED SWAP TARGET —
   * funded with 5000 units and `swap-preflight` green with a quorum margin of 1.
   * Staking four ephemeral candidates into it and rotating would seat 9, taking quorum
   * from 4 to 6 against 5 live processes: the transition would halt the chain, and the
   * stake cannot be undone by anyone (the keys exist only inside this process,
   * unstake() reverts StillSeated(), forfeit() needs a conviction they never earn).
   *
   * 🔑 And it has ALREADY HAPPENED once. The registry c21 abandoned for being
   * "ghost-laden" — 8 seats, 15 candidates, 6000 forfeited — was made that way by this
   * suite. c20 and c21 diagnosed the state and deployed a clean instance; neither asked
   * where the ghosts came from, so the clean instance was shipped straight back to the
   * factory. A remediation that does not identify the source repeats the damage.
   *
   * So a destructive suite OWNS ITS FIXTURE: it deploys a scratch registry, seeded
   * with the same live set, sharing the real court. Every enforcement claim below is
   * still about a real contract on a real chain with real consensus history — only the
   * leftovers are now nobody's inheritance. `--registry 0x…` still exists for probing a
   * superseded instance, and refuses the two addresses that matter.
   */
  const liveRef = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinyValidators.sol/TinyValidators.json'), 'utf8')).abi
  const target = chooseE2ERegistry({ deployment: d, requested: arg('registry') })
  for (const w of target.warnings) console.log(`  ⚠️  ${w}`)
  if (!target.ok) {
    for (const r of target.refusals) console.error(`\n🛑 ${r}`)
    console.error('\nRefusing. Run it with no --registry and it deploys its own fixture.')
    process.exit(1)
  }

  // Config is read from the AUTHORITATIVE registry: the scratch fixture must be born
  // with the same rules, and reading them off the fixture would make section 0's
  // "config matches" assertion compare a contract to itself.
  const [minStake, maxV, minV, epochBlocks] = await Promise.all(
    ['minStake', 'maxValidators', 'minValidators', 'epochBlocks'].map((f) =>
      pub.readContract({ address: d.validatorContract, abi: liveRef, functionName: f })),
  )

  /**
   * Seed the fixture with the set that is actually PRODUCING BLOCKS, not the set some
   * registry seats — the c20 lesson, and it matters here for a second reason: section
   * 8 asserts the running chain was untouched, so the fixture has to be born from the
   * same observable reality that section checks.
   */
  const liveSeed = await (async () => {
    const head = await pub.getBlockNumber()
    const seen = new Set()
    for (let i = 0; i < 15; i++) {
      const b = await pub.getBlock({ blockNumber: head - BigInt(i) })
      seen.add(getAddress(b.miner))
    }
    return [...seen]
  })()

  let underTest
  if (target.mode === 'explicit') {
    underTest = getAddress(target.address)
    console.log(`registry under test    ${underTest}  (explicit --registry)`)
  } else {
    if (liveSeed.length < Number(minV)) {
      console.error(`\nrefusing: only ${liveSeed.length} live proposer(s) observed, below the floor of ${minV} — a fixture seeded with them could not rotate, and the failure would look like a contract bug`)
      process.exit(1)
    }
    const h = await wallet.deployContract({
      abi: regArt.abi, bytecode: regArt.bytecode.object,
      args: [d.usdc, d.slashing, minStake, maxV, minV, epochBlocks, liveSeed], ...FREE,
    })
    underTest = (await wait(h)).contractAddress
    console.log(`registry under test    ${underTest}  (scratch fixture, seeded with ${liveSeed.length} live proposer(s))`)
  }
  const R = (functionName, args = []) =>
    pub.readContract({ address: underTest, abi: reg, functionName, args })

  // Baseline for the section-8 assertion that the swap target was left alone. Taken
  // BEFORE anything is staked, and read from the deployment file's address rather than
  // from `underTest`, so it stays meaningful even when --registry points elsewhere.
  const swapTargetCandidatesAtStart = await pub.readContract({
    address: d.validatorContractSlashable, abi: reg, functionName: 'candidateCount',
  })

  /**
   * The registry under test must NOT be the one Besu reads.
   *
   * Kept even though the fixture is now self-deployed: `--registry` can still name
   * anything, and a later cutover cycle will make the deployment file's two addresses
   * equal. Failing here is the correct behaviour then, not an obstacle.
   */
  if (getAddress(underTest) === getAddress(d.validatorContract)) {
    console.error('\nrefusing: the registry under test IS the authoritative one.')
    console.error('This suite stakes, convicts and rotates. Against a live registry that reshapes consensus.')
    process.exit(1)
  }

  // ── 0. it is the same registry, plus enforcement ───────────────────────────
  section('the seating rule is unchanged — enforcement is additive')
  const oldCfg = await Promise.all(['minStake', 'maxValidators', 'minValidators', 'epochBlocks'].map((f) =>
    pub.readContract({ address: d.validatorContract, abi: liveRef, functionName: f })))
  ok(minStake === oldCfg[0] && maxV === oldCfg[1] && minV === oldCfg[2] && epochBlocks === oldCfg[3],
    `config matches the live registry exactly (minStake ${minStake}, max ${maxV}, min ${minV}, epoch ${epochBlocks})`)
  ok(getAddress(await R('court')) === getAddress(d.slashing), 'court is TinySlashing, and immutable')
  ok(await R('courtHealthy') === true, 'courtHealthy() — the docket answers')
  /**
   * A BASELINE, not zero.
   *
   * `forfeitedTotal === 0n` was green on the first run and failed on the second,
   * against an unchanged contract — because run 1 forfeited a bond into this same
   * registry and forfeits are permanent by design. Asserting an absolute here makes
   * the suite a one-shot whose second run reads as a regression. Section 4 asserts
   * the DELTA instead, which is the claim that was meant.
   */
  const forfeitedAtStart = await R('forfeitedTotal')
  ok(typeof forfeitedAtStart === 'bigint',
    `forfeitedTotal baseline is ${forfeitedAtStart}${forfeitedAtStart > 0n ? ' (earlier runs left convictions — they are permanent)' : ''}`)

  const seatedAtStart = (await R('getValidators')).map((a) => getAddress(a))
  ok(seatedAtStart.length >= Number(minV),
    `seeded with the ${seatedAtStart.length} live validators, at or above the floor of ${minV}`)

  // ── 1. convict a real key, then watch the registry act on it ───────────────
  section('a conviction the court actually issued')

  /**
   * A fresh culprit per run, derived from the head — convictions are permanent, so
   * a hardcoded key would make this suite a one-shot whose second run reads as a
   * contract regression. (Same reasoning as slashing-e2e.mjs.)
   */
  const seed = await pub.getBlockNumber()
  const CULPRIT_KEY = process.env.TINY_SLASHABLE_CULPRIT_KEY
    || keccak256(`0x${'5a'.repeat(8)}${seed.toString(16)}`)
  const culprit = privateKeyToAccount(CULPRIT_KEY)
  console.log(`  culprit ${culprit.address}`)

  const authoritative = (await pub.readContract({
    address: d.validatorContract, abi: liveRef, functionName: 'getValidators',
  })).map((a) => getAddress(a))
  ok(!authoritative.includes(getAddress(culprit.address)),
    'the culprit is not a validator of the running chain — convicting it cannot disturb consensus')

  /**
   * Stake ABOVE minStake this time, unlike slashing-e2e.
   *
   * That suite deliberately bonded below the minimum so its culprit could never be
   * seated — correct there, because it was operating on the authoritative registry.
   * Here the whole claim is "a convict with enough stake to win a seat still
   * doesn't get one", and a culprit below minStake would be excluded by the stake
   * rule alone. The test would pass with the conviction check deleted.
   */
  const bond = minStake * 3n
  {
    const bal = await pub.readContract({ address: d.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [deployer.address] })
    if (bal < bond) {
      console.error(`\nthe deployer holds ${bal} but needs ${bond}. TinyIssuance owns TinyUSDC (P3) so nothing can be minted.`)
      process.exit(1)
    }
    await wait(await wallet.sendTransaction({ to: culprit.address, value: 10n ** 18n, gas: 30_000n, ...FREE }))
    await wait(await wallet.writeContract({
      address: d.usdc, abi: usdcAbi, functionName: 'transfer', args: [culprit.address, bond], ...FREE,
    }))
    const cw = createWalletClient({ account: culprit, chain, transport: http(RPC) })
    await wait(await cw.writeContract({
      address: d.usdc, abi: usdcAbi, functionName: 'approve', args: [underTest, bond], ...FREE,
    }))
    await wait(await cw.writeContract({
      address: underTest, abi: reg, functionName: 'stake', args: [bond], ...FREE,
    }))
  }
  ok(await R('stakeOf', [culprit.address]) === bond,
    `the culprit staked ${bond} — ${bond / minStake}× minStake, so only a conviction can keep it out`)
  ok(await R('isConvicted', [culprit.address]) === false, 'and starts unconvicted')

  // Eligible while innocent. Without this the later "ineligible" assertion could
  // be true for any reason at all — a typo in the address, an unfunded approve.
  const eligibleInnocent = await R('eligibleCount')
  ok(eligibleInnocent > 0n, `eligibleCount() is ${eligibleInnocent} while the culprit is innocent`)

  // Now the real conviction: a real block, a real double-signature, adjudicated by
  // the court contract.
  {
    const target = await pub.getBlockNumber()
    const raw = await pub.request({ method: 'eth_getBlockByNumber', params: [numberToHex(target), false] })
    const ev = await forgeEquivocation(raw, CULPRIT_KEY)
    await wait(await wallet.writeContract({
      address: d.slashing, abi: court, functionName: 'submitEquivocation',
      args: [target, ev.canonHeader, ev.canonSeal, ev.conflictHeader, ev.conflictSeal], ...FREE,
    }))
    ok(await C('isEquivocator', [culprit.address]) === true,
      `convicted for equivocating at height ${target} (round ${roundOf(raw)})`)
  }

  section('the registry reads the docket')
  ok(await R('isConvicted', [culprit.address]) === true,
    'the registry sees the conviction — no admin call, no relay, no oracle')
  ok(await R('eligibleCount') === eligibleInnocent - 1n,
    `eligibleCount() dropped by exactly one (${eligibleInnocent} → ${eligibleInnocent - 1n})`)
  ok(await R('stakeOf', [culprit.address]) === bond,
    'stake is still recorded — the conviction is not itself the punishment')

  // ── 2. rotate() with a rich convict in the pool ────────────────────────────

  /**
   * Spawn a registry with a chosen court, and stake an account into a chosen
   * registry. Shared by the seating sections and the fail-open section — `court` is
   * immutable (the property that keeps this registry admin-free), so testing any
   * court behaviour means deploying a whole registry. That is the price of not
   * having a setter, paid here once.
   */
  const founders = seatedAtStart.slice(0, Number(minV))
  const spawn = async (courtAddr) => {
    const h = await wallet.deployContract({
      abi: regArt.abi, bytecode: regArt.bytecode.object,
      args: [d.usdc, courtAddr, minStake, maxV, minV, epochBlocks, founders], ...FREE,
    })
    return (await wait(h)).contractAddress
  }
  const enroll = async (registry, acct, amount) => {
    await wait(await wallet.sendTransaction({ to: acct.address, value: 10n ** 18n, gas: 30_000n, ...FREE }))
    await wait(await wallet.writeContract({
      address: d.usdc, abi: usdcAbi, functionName: 'transfer', args: [acct.address, amount], ...FREE,
    }))
    const w = createWalletClient({ account: acct, chain, transport: http(RPC) })
    await wait(await w.writeContract({
      address: d.usdc, abi: usdcAbi, functionName: 'approve', args: [registry, amount], ...FREE,
    }))
    await wait(await w.writeContract({
      address: registry, abi: reg, functionName: 'stake', args: [amount], ...FREE,
    }))
  }
  /**
   * Wait for an epoch boundary. rotate() is once-per-epoch by design (mid-epoch set
   * changes are what BFT safety proofs exclude), so there is no way to test seating
   * without waiting — and no way to fake it, since block.number is the clock.
   */
  const waitForEpoch = async (registry) => {
    const at = (fn) => pub.readContract({ address: registry, abi: reg, functionName: fn })
    const deadline = Date.now() + 180_000
    const last = await at('lastRotatedEpoch')
    let cur = await at('currentEpoch')
    while (cur <= last && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      cur = await at('currentEpoch')
    }
    return { last, cur }
  }

  const honest = Array.from({ length: Number(minV) }, (_, i) =>
    privateKeyToAccount(keccak256(`0x${'7a'.repeat(8)}${seed.toString(16)}${i.toString(16).padStart(2, '0')}`)))

  section('the floor beats enforcement — a set below minValidators is never committed')

  /**
   * On a FRESH registry, because the shared one cannot be put into this state.
   *
   * The case that matters is exactly `minValidators` candidates of whom one is
   * convicted: enforcement and the floor disagree, and that is the only place a
   * mechanism like this could halt a chain. Producing it needs a pool of a known
   * size — and the shared registry accumulates candidates permanently across runs
   * (stake is only removable by unstake, and convicts cannot unstake), so run 2
   * inherited run 1's four stakers and simply had enough eligible candidates. The
   * absolute assertion went green→red against an unchanged contract, which is how a
   * suite that seemed deterministic proves it was reading its own leftovers.
   */
  {
    /**
     * The convict is SEATED here, and that is the whole construction.
     *
     * The first version staked the convict as a mere candidate and asserted
     * blockedByFloor() reports stuck — it reports (0, false), correctly, because
     * nothing convicted was seated. The assertion was wrong; worse, it meant the
     * case blockedByFloor() EXISTS for went untested, and that case is the realistic
     * one: a validator equivocates while holding a seat, not before applying for one.
     *
     * Seating it is free — the constructor's `initial` set is arbitrary addresses, so
     * a registry born with the convict in its validator set reproduces "convicted
     * while seated" with no rotation and no epoch wait. Then minValidators-1 honest
     * candidates leave the floor unsatisfiable without it, which is precisely the
     * standoff: the registry can neither seat a cheat nor unseat it without dropping
     * below fault tolerance. It must keep running, and it must SAY so.
     */
    const floorHonest = honest.slice(0, Number(minV) - 1)
    const h = await wallet.deployContract({
      abi: regArt.abi, bytecode: regArt.bytecode.object,
      args: [d.usdc, d.slashing, minStake, maxV, minV, epochBlocks,
        [culprit.address, ...floorHonest.map((a) => a.address)]], ...FREE,
    })
    const floorReg = (await wait(h)).contractAddress
    console.log(`  fresh registry ${floorReg}, seated WITH the convict`)
    for (const a of floorHonest) await enroll(floorReg, a, minStake)
    const at = (fn, args = []) => pub.readContract({ address: floorReg, abi: reg, functionName: fn, args })

    ok(await at('isConvicted', [culprit.address]) === true, 'the same court convicts on the fresh registry too')
    ok(await at('isActive', [culprit.address]) === true,
      'and the convict is SEATED — signing blocks, which is how equivocation happens in the first place')
    ok(await at('eligibleCount') === minV - 1n,
      `eligibleCount() is ${minV - 1n}, one short of the floor of ${minV} — the convict is the missing one`)
    ok(await at('rotatable') === false,
      'rotatable() is false: it counts eligibility, not candidates, so it agrees with the rotation it predicts')

    const [convictedSeated, stuck] = await at('blockedByFloor')
    ok(convictedSeated === 1n && stuck === true,
      `blockedByFloor() names the standoff: ${convictedSeated} convict seated, stuck=${stuck} — not left to be inferred from a revert`)

    const { last, cur } = await waitForEpoch(floorReg)
    ok(cur > last, `epoch advanced (${last} → ${cur}) — rotation is now permitted`)

    const e = await reverted(() => pub.simulateContract({
      address: floorReg, abi: reg, functionName: 'rotate', account: deployer, args: [], ...FREE,
    }))
    ok(e === 'BelowValidatorFloor',
      `rotate() refuses (${e}) rather than seat ${minV - 1n} — unseating a cheat must not cost the chain its fault tolerance`)
    const seated = (await at('getValidators')).map((a) => getAddress(a))
    ok(seated.length === Number(minV) && seated.includes(getAddress(culprit.address)),
      `the convict KEEPS its seat (${seated.length} seats) — the honest outcome, because a chain halted to punish someone has punished everyone`)

    // And the standoff ends the moment enough honest candidates exist — it is a
    // deadlock, not a permanent immunity.
    await enroll(floorReg, honest[Number(minV) - 1], minStake)
    ok(await at('eligibleCount') === minV, `one more honest candidate → eligibleCount() ${minV}`)
    ok(await at('rotatable') === true, 'and the rotation unblocks')
    const { last: l2, cur: c2 } = await waitForEpoch(floorReg)
    if (c2 > l2) {
      await wait(await wallet.writeContract({ address: floorReg, abi: reg, functionName: 'rotate', args: [], ...FREE }))
      const after = (await at('getValidators')).map((a) => getAddress(a))
      ok(!after.includes(getAddress(culprit.address)),
        'the convict is UNSEATED — the deadlock protected the chain, not the cheat')
      ok(after.length === Number(minV), `and the set is back to ${minV} honest validators`)
    }
  }

  section('rotate() refuses to seat a convict, however rich')
  {
    // Deltas, not absolutes: this registry's pool carries over between runs.
    const before = await R('eligibleCount')
    for (const a of honest) {
      if (await R('stakeOf', [a.address]) < minStake) await enroll(underTest, a, minStake)
    }
    const after = await R('eligibleCount')
    console.log(`  eligible ${before} → ${after} (${honest.length} honest candidates at minStake)`)
    ok(after >= minV, `eligibleCount() is ${after} ≥ the floor of ${minV} — satisfiable without the convict`)
    ok(after === before + BigInt(honest.length) || after === before,
      'each newly staked candidate became eligible; already-staked ones did not double-count')

    const richest = await R('stakeOf', [culprit.address])
    const anyHonest = await R('stakeOf', [honest[0].address])
    ok(richest > anyHonest,
      `the convict holds the largest stake (${richest} vs ${anyHonest}) — top of the sort, if it were eligible`)

    const { last, cur } = await waitForEpoch(underTest)
    ok(cur > last, `epoch advanced (${last} → ${cur})`)
    ok(await R('rotatable') === true, 'rotatable() is true')

    await wait(await wallet.writeContract({
      address: underTest, abi: reg, functionName: 'rotate', args: [], ...FREE,
    }))
    const seated = (await R('getValidators')).map((a) => getAddress(a))
    console.log(`  seated ${seated.length}: ${seated.map((a) => a.slice(0, 10)).join(' ')}`)
    ok(!seated.includes(getAddress(culprit.address)),
      'THE POINT: a real rotation ran and the richest candidate was left out because it is convicted')
    ok(await R('isActive', [culprit.address]) === false, 'and isActive() agrees with getValidators()')
    ok(honest.every((h) => seated.includes(getAddress(h.address))),
      `every one of the ${honest.length} honest candidates got a seat — enforcement excluded one address, not a population`)
    ok(BigInt(seated.length) === after,
      `the seated count equals eligibleCount() (${seated.length} = ${after}) — nobody eligible was dropped and nobody ineligible slipped in`)
    ok(seated.length >= Number(minV) && seated.length <= Number(maxV),
      `the set is within [${minV}, ${maxV}]`)
    ok(seated.length > 0, 'and never empty — an empty getValidators() halts Besu')
    const [convictedSeated, stuck] = await R('blockedByFloor')
    ok(convictedSeated === 0n && stuck === false,
      'blockedByFloor() reports the clean steady state: no convict seated, nothing stuck')
  }

  // ── 3. the convict cannot walk away with the bond ──────────────────────────
  section('a convict cannot withdraw ahead of the verdict')
  {
    const cw = createWalletClient({ account: culprit, chain, transport: http(RPC) })
    const e = await reverted(() => pub.simulateContract({
      address: underTest, abi: reg, functionName: 'unstake',
      account: culprit, args: [bond], ...FREE,
    }))
    ok(e === 'ConvictedCannotUnstake',
      `unstake() is refused (${e}) — otherwise enforcement is a footrace the cheat wins`)
    // requestExit is still allowed: exiting is not an escape, it only removes the
    // convict from seating consideration, which is where we want them anyway.
    await wait(await cw.writeContract({
      address: underTest, abi: reg, functionName: 'requestExit', args: [], ...FREE,
    }))
    ok(await R('exiting', [culprit.address]) === true, 'requestExit() still works — leaving the queue is not escaping')
    const e2 = await reverted(() => pub.simulateContract({
      address: underTest, abi: reg, functionName: 'unstake',
      account: culprit, args: [bond], ...FREE,
    }))
    ok(e2 === 'ConvictedCannotUnstake', 'and exiting does not unlock the withdrawal either')
  }

  // ── 4. anyone may execute the verdict ──────────────────────────────────────
  section('forfeit() — permissionless execution')
  {
    /**
     * Execute from a THIRD party, not the deployer and not the reporter.
     *
     * "Permissionless" is the claim; calling it as the deployer would pass on a
     * contract that checked `msg.sender == owner`, because the deployer is the one
     * account that would satisfy such a check. The address that proves it is one
     * with no relationship to anything.
     */
    const strangerKey = keccak256(`0x${'11'.repeat(8)}${seed.toString(16)}`)
    const stranger = privateKeyToAccount(strangerKey)
    await wait(await wallet.sendTransaction({ to: stranger.address, value: 10n ** 18n, gas: 30_000n, ...FREE }))
    const sw = createWalletClient({ account: stranger, chain, transport: http(RPC) })

    const totalBefore = await R('forfeitedTotal')
    await wait(await sw.writeContract({
      address: underTest, abi: reg, functionName: 'forfeit', args: [culprit.address], ...FREE,
    }))
    ok(await R('stakeOf', [culprit.address]) === 0n,
      `a stranger (${stranger.address.slice(0, 10)}…) stripped the bond — no admin, no owner, no permission`)
    ok(await R('forfeitedOf', [culprit.address]) === bond, `forfeitedOf records the ${bond} taken`)
    ok(await R('forfeitedTotal') === totalBefore + bond,
      'forfeitedTotal is public — locked-vs-circulating supply stays auditable')

    const dup = await reverted(() => pub.simulateContract({
      address: underTest, abi: reg, functionName: 'forfeit',
      account: stranger, args: [culprit.address], ...FREE,
    }))
    ok(dup === 'NothingToForfeit',
      `a second forfeit reverts (${dup}) instead of silently no-op'ing — "already done" is distinguishable from "did something"`)
  }

  // ── 5. the innocent are untouched ──────────────────────────────────────────
  section('refusing to punish the innocent')
  {
    const innocent = privateKeyToAccount(keccak256(`0x${'99'.repeat(8)}${seed.toString(16)}`))
    const e = await reverted(() => pub.simulateContract({
      address: underTest, abi: reg, functionName: 'forfeit',
      account: deployer, args: [innocent.address], ...FREE,
    }))
    ok(e === 'NotConvicted', `forfeit() on an unconvicted address reverts (${e})`)

    // And the founders — the keys actually running the chain — are untouched by
    // someone else's conviction. A slashing mechanism whose blast radius is wider
    // than the culprit is worse than none.
    let allClean = true
    for (const v of authoritative) {
      if (await R('isConvicted', [v])) allClean = false
    }
    ok(allClean, `none of the ${authoritative.length} real validators is convicted by this run`)
  }

  // ── 6. a broken court must not freeze the registry ─────────────────────────
  section('fail-open: three ways for the court to be broken')
  {
    // Each variant is a WHOLE REGISTRY with a different court (spawn(), above) —
    // `court` is immutable, and that immutability is the property keeping this
    // registry admin-free. The fixture cost is the price of not having a setter.
    /**
     * `probe` swallows a revert into the string 'REVERTED' rather than throwing.
     *
     * This whole section tests that reads DON'T revert, so a throwing probe kills
     * the process at the first broken-court variant and takes the remaining sections
     * with it — the run reports a crash instead of a failed assertion, and the
     * mutation that removed the return-length check looked like a harness bug rather
     * than a killed mutant. A guard's absence has to read as a ✗ on the line that
     * asserts it.
     */
    const probe = (addr, fn, args = []) => pub
      .readContract({ address: addr, abi: reg, functionName: fn, args })
      .catch(() => 'REVERTED')

    // (a) an EOA: staticcall SUCCEEDS and returns nothing. The shape that would
    //     make a naive abi.decode revert — the one thing _convicted promises not
    //     to do.
    const eoa = await spawn(deployer.address)
    ok(await probe(eoa, 'isConvicted', [culprit.address]) === false,
      'an EOA court: reads answer false rather than reverting on an empty return')
    ok(await probe(eoa, 'courtHealthy') === false, 'and courtHealthy() says so — the failure is visible')
    ok(await probe(eoa, 'eligibleCount') >= 0n, 'eligibleCount() still computes')

    // (b) a contract with no such selector: the staticcall REVERTS.
    const wrong = await spawn(d.usdc)
    ok(await probe(wrong, 'isConvicted', [culprit.address]) === false,
      'a wrong-contract court: a reverting staticcall is caught, not propagated')
    ok(await probe(wrong, 'courtHealthy') === false, 'courtHealthy() false')

    // (c) the gas bomb — the shape that needs a fixture. A court that ANSWERS but
    //     tries to consume the entire frame. Without COURT_GAS, "the court cannot
    //     revert us" would still leave "the court can make rotate() unaffordable".
    const bombArt = mockArt
    const bombHash = await wallet.deployContract({
      abi: bombArt.abi, bytecode: bombArt.bytecode.object, args: [1], ...FREE,
    })
    const bomb = (await wait(bombHash)).contractAddress
    const bombed = await spawn(bomb)
    ok(await probe(bombed, 'isConvicted', [culprit.address]) === false,
      'a gas-bomb court: the 50k bound contains it, the read returns false')
    ok(await probe(bombed, 'courtHealthy') === false, 'courtHealthy() false')
    // (d) a short return: 31 bytes, one byte short of a bool. Distinct from (a)
    //     because `success` is TRUE here — only the length check catches it.
    const shortHash = await wallet.deployContract({
      abi: bombArt.abi, bytecode: bombArt.bytecode.object, args: [2], ...FREE,
    })
    const shortCourt = (await wait(shortHash)).contractAddress
    const shorted = await spawn(shortCourt)
    ok(await probe(shorted, 'isConvicted', [culprit.address]) === false,
      'a 31-byte return: caught by the length check, where success alone would have passed')
    ok(await probe(shorted, 'courtHealthy') === false, 'courtHealthy() false')

    // (e) an HONEST mock still enforces — otherwise every check above would
    //     pass on a registry that ignores its court entirely.
    const honestHash = await wallet.deployContract({
      abi: bombArt.abi, bytecode: bombArt.bytecode.object, args: [0], ...FREE,
    })
    const honestCourt = (await wait(honestHash)).contractAddress
    const good = await spawn(honestCourt)
    ok(await probe(good, 'courtHealthy') === true,
      'an honest court reads healthy — so "false" above is a detected fault, not a broken probe')

    /**
     * THE assertion of this section: the registry is still USABLE, not merely
     * non-reverting. COURT_GAS is what separates "the court cannot revert us" from
     * "the court cannot price us out", and those are the same denial of service.
     *
     * Measured on blockedByFloor(), and getting here took two wrong probes:
     *
     *  - rotate() reverts EmptySetRefused on a freshly spawned registry (candidates
     *    with no stake), for a reason that has nothing to do with gas. That revert
     *    read as "the bomb priced it out".
     *  - eligibleCount() short-circuits: `stakeOf[c] >= minStake` is false for every
     *    unstaked founder, so `_convicted` is never reached. It measured 51612 gas
     *    for four candidates — i.e. the bomb never fired, and the check passed while
     *    proving nothing. A number that looks like a pass is how a vacuous test
     *    survives.
     *
     * blockedByFloor() calls the court UNCONDITIONALLY, once per seated validator,
     * so the bomb is guaranteed to detonate `active.length` times.
     *
     * Bounded above (the ceiling COURT_GAS enforces) AND above the honest baseline —
     * the second half is what proves the bomb actually went off. Without it, a bound
     * this loose passes on a court that does nothing at all.
     */
    {
      const g = (addr) => pub.estimateContractGas({
        address: addr, abi: reg, functionName: 'blockedByFloor', account: deployer, args: [],
      }).catch(() => null)
      const bombGas = await g(bombed)
      const honestGas = await g(good)
      ok(bombGas !== null, `blockedByFloor() survives a gas bomb (${bombGas ?? 'reverted'} gas)`)
      ok(bombGas !== null && honestGas !== null && bombGas > honestGas,
        `the bomb DID detonate — ${bombGas} vs ${honestGas} against an honest court`)
      // active.length × COURT_GAS + loop overhead. Remove the {gas: COURT_GAS} and
      // each call takes 63/64 of everything remaining, blowing far past this.
      const ceiling = BigInt(seatedAtStart.slice(0, Number(minV)).length) * 50_000n + 150_000n
      ok(bombGas !== null && bombGas < ceiling,
        `and is contained: ${bombGas} < ${ceiling} (${Number(minV)}×COURT_GAS + overhead)`)
    }

  }

  // ── 7. the constructor refuses to lie about being slashable ────────────────
  section('a slashable registry with no court is a name that lies')
  {
    /**
     * A constructor cannot be simulateContract'd — there is no function on the ABI
     * to name, which is what the first version of this check tripped over ("Function
     * not found on ABI"), a harness error that reads exactly like a missing guard.
     * Deploy it for real and let the revert land.
     */
    const e = await reverted(() => wallet.deployContract({
      abi: regArt.abi, bytecode: regArt.bytecode.object,
      args: [d.usdc, '0x0000000000000000000000000000000000000000', minStake, maxV, minV, epochBlocks, founders],
      ...FREE,
    }), regArt.abi)
    ok(e === 'BadConfig', `court = address(0) is refused at construction (${e})`)
    // And the same guard on the stake token, so BadConfig isn't just an address(0)
    // check that happens to sit in front of both.
    const e2 = await reverted(() => wallet.deployContract({
      abi: regArt.abi, bytecode: regArt.bytecode.object,
      args: ['0x0000000000000000000000000000000000000000', d.slashing, minStake, maxV, minV, epochBlocks, founders],
      ...FREE,
    }), regArt.abi)
    ok(e2 === 'BadConfig', `stakeToken = address(0) is refused too (${e2})`)
  }

  // ── 8. the authoritative chain is exactly as we found it ───────────────────
  section('the running chain was not touched')
  {
    const nowSeated = (await pub.readContract({
      address: d.validatorContract, abi: liveRef, functionName: 'getValidators',
    })).map((a) => getAddress(a))
    ok(nowSeated.length === authoritative.length && nowSeated.every((a, i) => a === authoritative[i]),
      `the authoritative registry still seats the same ${nowSeated.length} validators`)
    ok(await pub.readContract({
      address: d.validatorContract, abi: liveRef, functionName: 'stakeOf', args: [culprit.address],
    }) === 0n, 'and the culprit never staked into it')
    /**
     * POLL, don't sample once.
     *
     * A single sleep-then-compare failed one mutation run on a chain that was
     * provably healthy — four nodes all in sync and producing, verified
     * independently. A ~2s block time against a fixed 5s window is tight enough
     * that an RPC hiccup or a round change reads as a halt, and a flaky liveness
     * check is worse than none: it makes every real failure arguable.
     */
    const head = await pub.getBlockNumber()
    const deadline = Date.now() + 30_000
    let now = head
    while (now <= head && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      now = await pub.getBlockNumber().catch(() => now)
    }
    ok(now > head, `the chain is still producing blocks (${head} → ${now})`)

    /**
     * ⚠️ AND THE SWAP TARGET IS UNTOUCHED — the assertion whose ABSENCE let this suite
     * quietly wreck a registry for several cycles.
     *
     * "The authoritative registry is unchanged" was the only after-the-fact check, and
     * it was true every single time: the damage was never to the registry Besu reads,
     * it was to the one it is going to read NEXT. A suite that verifies it left the
     * present alone while silently reshaping the future is worse than one that checks
     * nothing, because it certifies safety it did not measure.
     *
     * Compared by CANDIDATE COUNT, not seats: seats only move at a rotation, so a
     * seat-count check would have stayed green through every leak. The candidate queue
     * is where a stake lands the instant it is posted, and it is append-only, so this
     * catches the harm at the moment it is done rather than an epoch later.
     */
    const targetCandidates = await pub.readContract({
      address: d.validatorContractSlashable, abi: reg, functionName: 'candidateCount',
    })
    ok(targetCandidates === swapTargetCandidatesAtStart,
      `the DESIGNATED SWAP TARGET still has exactly ${swapTargetCandidatesAtStart} candidate(s) — this suite added no unremovable ghost to the registry the chain is about to depend on`)
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail === 0) {
    console.log(`
Enforcement WORKS — and is still not ACTIVE. Besu reads ${d.validatorContract};
the registry under test (${underTest}) is
authoritative for nobody, and is a scratch fixture this run created. Until a genesis
transition points every node at a slashable registry, a conviction still costs
reputation only, and stake must not be described as slashable on the live chain.

The designated swap target ${d.validatorContractSlashable}
was not touched: ${swapTargetCandidatesAtStart} candidate(s) before and after.`)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
