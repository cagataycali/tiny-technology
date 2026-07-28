#!/usr/bin/env node
/**
 * P4 acceptance: does the equivocation court convict the guilty and — much more
 * importantly — refuse to convict the innocent?
 *
 * Two things make this suite worth trusting rather than merely green:
 *
 *  1. IT USES REAL BLOCKS. The Solidity header parser is checked against blocks
 *     the running 4-node devnet actually produced, and the recovered signers are
 *     compared to the addresses in getValidators(). A parser tested only on
 *     fixtures written by the same author agrees with itself and nothing else.
 *
 *  2. IT MANUFACTURES A GENUINE FAULT. We can't ask a Besu node to equivocate, but
 *     we don't have to: equivocation is "one key, two signatures, same height and
 *     round". So a throwaway key signs the real canonical block AND a doctored
 *     variant of it at the same height/round — cryptographically indistinguishable
 *     from a validator that double-signed. If the court convicts that, it convicts
 *     the real thing.
 *
 * Usage: node chain/multinode/scripts/slashing-e2e.mjs
 */
import {
  createPublicClient, createWalletClient, http, defineChain, keccak256, toRlp, fromRlp,
  numberToHex, getAddress, hexToBytes, bytesToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { seallessHeader, anchorOf, sealsOf, roundOf, sealWith } from './lib/qbft-header.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

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
 * Runs `fn` and returns the CUSTOM ERROR NAME it reverted with, or null if it did
 * not revert.
 *
 * ⚠️ Reads `errorName` off the cause chain, not the message. viem's
 * `shortMessage` for a custom-error revert is only "the contract function
 * reverted" — the decoded name lives on the nested ContractFunctionRevertedError.
 * Asserting on the message therefore never matches a name, and the tempting
 * workaround (`assert it reverted at all`) is worse than useless here: every
 * negative case in this suite is trying to prove a SPECIFIC guard fired, and a
 * bare "it reverted" would pass just as happily on a typo'd argument. A slashing
 * test that can't tell "refused because the round differs" from "refused because
 * my test is broken" is not testing the guard.
 */
async function reverted(fn) {
  try {
    await fn()
    return null
  } catch (e) {
    for (let c = e; c; c = c.cause) {
      if (c.data?.errorName) return c.data.errorName
      if (c.name === 'ContractFunctionRevertedError' && c.reason) return c.reason
    }
    return e.shortMessage || e.message
  }
}

// ── header encoding ───────────────────────────────────────────────────────────
//
// Moved to ./lib/qbft-header.mjs when slashable-registry-e2e.mjs needed the same
// rule. Deliberately NOT copied: the seal-digest / anchor split is invisible at
// round 0, so a drifted second copy would agree with this one on every block a
// quiet devnet produces and diverge only during a real round change — i.e. only
// when a conviction is actually at stake. The reasoning that cost a cycle to find
// lives in that file's docblock.

async function main() {
  const deployPath = join(HOME_DIR, 'validators-deployment.json')
  if (!existsSync(deployPath)) {
    console.error(`no ${deployPath} — run the deploy scripts first`)
    process.exit(1)
  }
  const d = JSON.parse(readFileSync(deployPath, 'utf8'))
  if (!d.slashing) {
    console.error('no slashing in the deployment file — run deploy-slashing.mjs first')
    process.exit(1)
  }
  const abi = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinySlashing.sol/TinySlashing.json'), 'utf8')).abi
  const valAbi = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinyValidators.sol/TinyValidators.json'), 'utf8')).abi
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
  const read = (functionName, args = []) =>
    pub.readContract({ address: d.slashing, abi, functionName, args })

  console.log(`chain ${chainId} @ ${RPC}`)
  console.log(`TinySlashing ${d.slashing}`)

  /**
   * A FRESH culprit key per run.
   *
   * Convictions are permanent by design, so a hardcoded culprit would make this
   * suite a one-shot: the second run would fail at "starts unconvicted", and every
   * later cycle would read as a regression in the contract rather than a
   * limitation of the test. Deriving the key from the current head keeps each run
   * independent without weakening anything — the court does not care who the
   * accused is, only what they signed.
   */
  const nonceSeed = await pub.getBlockNumber()
  const CULPRIT_KEY = process.env.TINY_CULPRIT_KEY || keccak256(`0x${'c0'.repeat(8)}${nonceSeed.toString(16)}`)
  const OTHER_KEY = process.env.TINY_OTHER_KEY || keccak256(`0x${'0e'.repeat(8)}${nonceSeed.toString(16)}`)

  const seated = (await pub.readContract({
    address: d.validatorContract, abi: valAbi, functionName: 'getValidators',
  })).map((a) => getAddress(a))
  console.log(`seated validators: ${seated.length}`)

  // ── 1. the header parser agrees with the real chain ────────────────────────
  section('the Solidity header parser vs. blocks this chain actually produced')
  const head = await pub.getBlockNumber()
  let parsedAll = true
  let sealsAll = true
  let anchorAll = true
  // Scan a wide enough window to be sure of catching BOTH round kinds. Five blocks
  // was the old sample size and it happened to contain only round-0 blocks, which is
  // precisely how the two digests passed for one being the other.
  let sawRound0 = 0
  let sawRoundN = 0
  const samples = []
  for (let k = 2n; k <= 60n && k < head; k++) {
    const n = head - k
    const raw = await pub.request({ method: 'eth_getBlockByNumber', params: [numberToHex(n), false] })
    const header = seallessHeader(raw)
    if (anchorOf(raw) !== raw.hash) anchorAll = false
    if (roundOf(raw) === 0n) sawRound0++; else sawRoundN++
    const [number, round] = await read('headerFields', [header])
    if (number !== n || round !== roundOf(raw)) parsedAll = false
    samples.push({ n, raw, header, digest: keccak256(header) })
  }
  ok(anchorAll,
    `the round-EMPTIED re-encoding reproduces every block hash (${samples.length} blocks: ${sawRound0} at round 0, ${sawRoundN} at round ≠ 0)`)
  ok(parsedAll, `headerFields() returns the right height and round for ${samples.length} real blocks`)

  // The contract's own anchorDigest() must agree with the client on both kinds, and
  // must NOT equal the seal digest where the round is non-zero. Without the second
  // half, a contract that simply returned keccak256(header) would pass the first.
  {
    const r0 = samples.find((s) => roundOf(s.raw) === 0n)
    const rN = samples.find((s) => roundOf(s.raw) !== 0n)
    if (r0) {
      const a = await read('anchorDigest', [r0.header])
      ok(a === r0.raw.hash, `anchorDigest() == blockhash for a round-0 block (${r0.n})`)
      ok(a === r0.digest, 'at round 0 the two digests coincide — which is why this bug hid for a whole cycle')
    }
    if (rN) {
      const a = await read('anchorDigest', [rN.header])
      ok(a === rN.raw.hash, `anchorDigest() == blockhash for a round-${roundOf(rN.raw)} block (${rN.n})`)
      ok(a !== rN.digest,
        'at round ≠ 0 the anchor DIFFERS from the seal digest — the contract keeps them apart')
    } else {
      console.log('  … no round ≠ 0 block in the window; the divergence case is unexercised this run')
    }
  }

  // Recover the real seals against the contract's own notion of the digest.
  //
  // Prefer a round ≠ 0 block: that is the case where the seal digest and the block
  // hash diverge, so it is the only sample that can catch the digests being swapped.
  // On a round-0 block both work and the check proves nothing about the split.
  {
    const { raw, digest } = samples.find((s) => roundOf(s.raw) !== 0n) || samples[0]
    const recovered = []
    for (const seal of sealsOf(raw)) {
      const bytes = hexToBytes(seal)
      const r = bytesToHex(bytes.slice(0, 32))
      const s = bytesToHex(bytes.slice(32, 64))
      let v = bytes[64]
      if (v < 27) v += 27
      // Use the chain to recover, via a throwaway ecrecover call on the court's
      // digest: if these don't land on validators, the digest rule is wrong.
      const addr = await pub.request({
        method: 'eth_call',
        params: [{
          to: '0x0000000000000000000000000000000000000001',
          data: digest + v.toString(16).padStart(64, '0') + r.slice(2) + s.slice(2),
        }, 'latest'],
      })
      recovered.push(getAddress('0x' + addr.slice(-40)))
    }
    const allSeated = recovered.every((a) => seated.includes(a))
    ok(allSeated && recovered.length > 0,
      `all ${recovered.length} real commit seals on block ${raw.number} (round ${roundOf(raw)}) recover to seated validators`)
    sealsAll = allSeated
    ok(new Set(recovered).size === recovered.length, 'each seal on a block is from a DIFFERENT validator')
  }
  ok(sealsAll, 'the digest the CONTRACT verifies is the one real validators actually sign')

  // ── 2. manufacture a genuine equivocation ─────────────────────────────────
  section('convicting a real double-signature')
  const culprit = privateKeyToAccount(CULPRIT_KEY)
  const other = privateKeyToAccount(OTHER_KEY)
  console.log(`  culprit ${culprit.address}`)
  ok(!seated.includes(getAddress(culprit.address)),
    'the culprit key is NOT a seated validator — so a conviction here cannot disturb consensus')

  /**
   * Give the culprit REAL stake before convicting it.
   *
   * Otherwise the "conviction does not burn stake" assertion at the end compares
   * zero to zero and would hold just as well if the contract did burn — the test
   * would be green for a reason that has nothing to do with the behaviour it
   * claims to check.
   *
   * Deliberately BELOW minStake: enough to be a real balance the court could have
   * taken, too little to ever be seated. A test that seats a fifth validator on a
   * 4-node QBFT devnet is a test that can hang the chain it is measuring.
   */
  const minStake = await pub.readContract({
    address: d.validatorContract, abi: valAbi, functionName: 'minStake',
  })
  const bond = minStake / 4n
  {
    const funderBal = await pub.readContract({
      address: d.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [deployer.address],
    })
    if (funderBal < bond) {
      console.error(`\nthe deployer holds ${funderBal} but needs ${bond} to bond the culprit.`)
      console.error('TinyIssuance owns TinyUSDC now (P3), so nothing can be minted for this —')
      console.error('the founders\' grant is the only source. Re-run the devnet from scratch.')
      process.exit(1)
    }
    await wait(await wallet.sendTransaction({
      to: culprit.address, value: 10n ** 18n, gas: 30_000n, ...FREE,
    }))
    await wait(await wallet.writeContract({
      address: d.usdc, abi: usdcAbi, functionName: 'transfer', args: [culprit.address, bond], ...FREE,
    }))
    const culpritWallet = createWalletClient({ account: culprit, chain, transport: http(RPC) })
    await wait(await culpritWallet.writeContract({
      address: d.usdc, abi: usdcAbi, functionName: 'approve', args: [d.validatorContract, bond], ...FREE,
    }))
    await wait(await culpritWallet.writeContract({
      address: d.validatorContract, abi: valAbi, functionName: 'stake', args: [bond], ...FREE,
    }))
    const staked = await pub.readContract({
      address: d.validatorContract, abi: valAbi, functionName: 'stakeOf', args: [culprit.address],
    })
    ok(staked === bond, `the culprit holds real stake (${staked}) — so "not burned" is a claim with teeth`)
    ok(staked < minStake, `and it is below minStake (${minStake}) — it can never be seated by a rotation`)
  }

  // Fetch a FRESH canonical block (blockhash only reaches 256 back, and the suite
  // must not be racing that edge).
  //
  // PREFER a recent round ≠ 0 block, because convicting on one is the case that a
  // contract conflating the two digests gets wrong: the anchor it computes would not
  // match blockhash and the proof would die as NotCanonical. A round-0 target
  // convicts happily either way, so it cannot tell a fixed court from a broken one.
  let target = await pub.getBlockNumber()
  let canonRaw = await pub.request({ method: 'eth_getBlockByNumber', params: [numberToHex(target), false] })
  {
    const divergent = samples.find((s) => roundOf(s.raw) !== 0n)
    if (divergent) {
      target = divergent.n
      canonRaw = divergent.raw
    }
    console.log(`  target block ${target}, round ${roundOf(canonRaw)}${divergent ? ' (the divergent case)' : ' (no round ≠ 0 block available)'}`)
  }
  const canonHeader = seallessHeader(canonRaw)
  const canonHeaderForParserTests = canonHeader
  const canonHash = keccak256(canonHeader)
  ok(anchorOf(canonRaw) === canonRaw.hash, `block ${target}'s anchor is its own hash`)

  const ex = fromRlp(canonRaw.extraData, 'hex')
  // The conflicting block: same height, SAME ROUND, different content. Changing
  // the vanity bytes is enough — a different block that any honest validator would
  // have had no business signing alongside the canonical one.
  const conflictExtra = toRlp([
    keccak256('0xdeadbeef'), ex[1], ex[2], ex[3], [],
  ])
  const conflictHeader = seallessHeader(canonRaw, { extraOverride: conflictExtra })
  const conflictHash = keccak256(conflictHeader)
  ok(conflictHash !== canonHash, 'the conflicting header hashes differently')
  {
    const [n2, r2] = await read('headerFields', [conflictHeader])
    ok(n2 === target && r2 === roundOf(canonRaw),
      'the conflicting header parses to the SAME height and round — the definition of the fault')
  }

  const canonSeal = await sealWith(CULPRIT_KEY, canonHash)
  const conflictSeal = await sealWith(CULPRIT_KEY, conflictHash)

  ok(await read('isEquivocator', [culprit.address]) === false, 'culprit starts unconvicted')
  const before = await read('convictionCount')

  await wait(await wallet.writeContract({
    address: d.slashing, abi, functionName: 'submitEquivocation',
    args: [target, canonHeader, canonSeal, conflictHeader, conflictSeal], ...FREE,
  }))
  ok(await read('isEquivocator', [culprit.address]) === true,
    'CONVICTED — two seals by one key at one height and round is adjudicated on-chain')
  ok(await read('convictionCount') === before + 1n, 'convictionCount incremented')
  const conv = await read('convictions', [culprit.address])
  ok(conv[1] === target, `the verdict records the fault height (${conv[1]})`)
  ok(conv[2] === roundOf(canonRaw), `the verdict records the fault round (${conv[2]})`)
  ok(conv[5] === getAddress(deployer.address), 'the verdict records who reported it')
  ok(conv[0] > 0n, 'the verdict records when it was proven')

  // ── 3. the false-positive traps — the part that protects honest validators ──
  section('refusing to convict the innocent')

  const dup = await reverted(() => pub.simulateContract({
    address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
    args: [target, canonHeader, canonSeal, canonHeader, canonSeal], ...FREE,
  }))
  ok(dup?.includes('SameBlock'), `the same block twice is not a conflict (${dup?.match(/\w+\(/)?.[0] || dup})`)

  // Trap A: a different ROUND is a legitimate QBFT round change.
  {
    const roundBump = toRlp([ex[0], ex[1], ex[2], '0x07', []])
    const roundHeader = seallessHeader(canonRaw, { extraOverride: roundBump })
    const roundSeal = await sealWith(CULPRIT_KEY, keccak256(roundHeader))
    const [, r] = await read('headerFields', [roundHeader])
    ok(r === 7n, 'the round-change header parses as round 7')
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [target, canonHeader, canonSeal, roundHeader, roundSeal], ...FREE,
    }))
    ok(e?.includes('RoundMismatch'),
      'a signature at a DIFFERENT ROUND is refused — round changes are honest QBFT behaviour, not equivocation')
  }

  // The regression this cycle exists for: evidence must be rejected when the
  // CANONICAL header is presented in its ANCHOR form (round emptied) rather than the
  // form its seals actually signed. At round ≠ 0 those are different bytes, and a
  // court that hashed one where it meant the other would either convict on bytes
  // nobody signed or throw out a genuine proof.
  //
  // It is refused as RoundMismatch, which is a better answer than the ones this test
  // was first written to expect: emptying the round doesn't just change the digest,
  // it makes the preimage CLAIM round 0. So the two headers no longer describe the
  // same round, and trap A rejects them before any signature is examined — the
  // narrowest true reason. (Its anchor does still match blockhash, so the anchor
  // check cannot be what fires.)
  if (roundOf(canonRaw) !== 0n) {
    const anchorForm = seallessHeader(canonRaw, { forAnchor: true })
    ok(keccak256(anchorForm) !== canonHash,
      'the anchor-form preimage differs from the seal-form one at round ≠ 0')
    const [, anchorFormRound] = await read('headerFields', [anchorForm])
    ok(anchorFormRound === 0n, 'the anchor-form preimage reads as round 0 — emptying the round changes the claim')
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [target, anchorForm, canonSeal, conflictHeader, conflictSeal], ...FREE,
    }))
    ok(e?.includes('RoundMismatch') || e?.includes('DifferentSigners') || e?.includes('NotCanonical'),
      `a header presented in the WRONG one of the two forms convicts nobody (${e})`)
  }

  // A round too large to anchor by in-place substitution is refused explicitly,
  // rather than being reported as fake evidence.
  {
    // RLP-encodes as 0x81 0x80 — a one-byte payload whose byte is 0x80, i.e. the
    // first round that cannot be emptied without shortening the header.
    const bigRound = toRlp([ex[0], ex[1], ex[2], '0x80', []])
    const bigHeader = seallessHeader(canonRaw, { extraOverride: bigRound })
    const [, parsedRound] = await read('headerFields', [bigHeader])
    ok(parsedRound === 128n, `a round-128 header still PARSES as round 128 (${parsedRound})`)
    const e = await reverted(() => read('anchorDigest', [bigHeader]))
    ok(e === 'RoundNotAnchorable',
      `round ≥ 128 is refused as unanchorable rather than mis-hashed (${e}) — 128 consecutive timeouts at one height`)
  }

  // Trap B: a header that is not a real block of this chain cannot anchor a proof.
  {
    const foreign = seallessHeader(canonRaw, {
      extraOverride: toRlp([keccak256('0xfeed'), ex[1], ex[2], ex[3], []]),
    })
    const s1 = await sealWith(CULPRIT_KEY, keccak256(foreign))
    const s2 = await sealWith(CULPRIT_KEY, conflictHash)
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [target, foreign, s1, conflictHeader, s2], ...FREE,
    }))
    ok(e?.includes('NotCanonical'),
      'neither header being a real block of THIS chain is refused — a foreign chain cannot convict here')
  }

  // Two different signers is two validators disagreeing, which is just consensus.
  {
    const s2 = await sealWith(OTHER_KEY, conflictHash)
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [target, canonHeader, canonSeal, conflictHeader, s2], ...FREE,
    }))
    ok(e?.includes('DifferentSigners'),
      'two DIFFERENT validators signing different blocks is not a fault — that is just a disagreement')
    void other
  }

  // A seal over the wrong digest recovers to a stranger, so it can't implicate anyone.
  {
    const wrong = await sealWith(CULPRIT_KEY, keccak256('0x1234'))
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [target, canonHeader, wrong, conflictHeader, conflictSeal], ...FREE,
    }))
    ok(e?.includes('DifferentSigners'), 'a seal over some other digest implicates nobody')
  }

  // Age bounds.
  {
    const future = (await pub.getBlockNumber()) + 5n
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [future, canonHeader, canonSeal, conflictHeader, conflictSeal], ...FREE,
    }))
    ok(e?.includes('EvidenceFromTheFuture'), 'evidence for a block that has not happened is refused')
  }
  {
    const old = 1n
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [old, canonHeader, canonSeal, conflictHeader, conflictSeal], ...FREE,
    }))
    ok(e?.includes('EvidenceTooOld'),
      `evidence older than the ${d.maxEvidenceAge}-block blockhash window is refused — the honest limit, enforced`)
  }

  // Malformed input must revert, never mis-parse into a conviction.
  // Malformed input must revert with BadHeader specifically — "it errored" would
  // also be satisfied by a broken test, and by a parser that ran off the end.
  {
    const e = await reverted(() => read('headerFields', ['0xc0']))
    ok(e === 'BadHeader', `an empty RLP list is rejected rather than read as height 0 (${e})`)
    const e2 = await reverted(() => read('headerFields', ['0x80']))
    ok(e2 === 'BadHeader', `a non-list preimage is rejected (${e2})`)
    // extraData claiming an inner list longer than itself would let the parser
    // read the "round" out of the following header field.
    const truncated = canonHeaderForParserTests.slice(0, canonHeaderForParserTests.length - 40)
    const e3 = await reverted(() => read('headerFields', [truncated]))
    ok(e3 === 'BadHeader', `a truncated header is rejected rather than mis-parsed (${e3})`)
  }

  // Double jeopardy: the verdict cannot be overwritten.
  {
    const e = await reverted(() => pub.simulateContract({
      address: d.slashing, abi, functionName: 'submitEquivocation', account: deployer,
      args: [target, canonHeader, canonSeal, conflictHeader, conflictSeal], ...FREE,
    }))
    ok(e?.includes('AlreadyConvicted'),
      're-submitting the same evidence is refused — a verdict cannot be rewritten by a later reporter')
  }

  // ── 4. the honest limit, asserted rather than described ────────────────────
  section('what a conviction does NOT do (asserted, not just documented)')
  {
    const stakeStill = await pub.readContract({
      address: d.validatorContract, abi: valAbi, functionName: 'stakeOf', args: [culprit.address],
    })
    ok(stakeStill === conv[3] && stakeStill === bond,
      `the culprit's stake is UNCHANGED by conviction (${stakeStill}) — this court records, it does not burn`)
    ok(conv[3] === bond, 'the verdict recorded the stake that SHOULD have been burned — the missing enforcement, on the record')
    const stillSeatedCount = (await pub.readContract({
      address: d.validatorContract, abi: valAbi, functionName: 'getValidators',
    })).length
    ok(stillSeatedCount === seated.length,
      'the validator set is untouched by a conviction — enforcement needs a registry that reads isEquivocator()')
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n${e.stack || ''}`)
  process.exit(1)
})
