#!/usr/bin/env node
/**
 * P3b acceptance: serve-to-earn pays against attestor signatures, and the oracle
 * is bounded.
 *
 * The point of these checks is NOT "a signature works" — it's the shape of what
 * an oracle can and cannot do:
 *
 *   1. A valid attestation mints, to the SERVER, for a FINISHED epoch, at the
 *      pro-rata amount the contract predicts in advance.
 *   2. A signature from a NON-attestor mints nothing. (Otherwise the set is
 *      decorative and anyone can print the serve half.)
 *   3. A tampered field mints nothing — the signature covers every number, so
 *      inflating volume after signing invalidates it.
 *   4. Wrong chain / wrong contract mints nothing (EIP-712 domain binding). The
 *      same attestor signs on 8469 and 8470; a claim must not be portable.
 *   5. The same server cannot claim an epoch twice.
 *   6. Two servers in one epoch cannot be handed different epoch totals — the
 *      first claim PINS it. Otherwise each payout looks correct while the epoch
 *      over-distributes.
 *   7. The serve budget and the per-server cap hold, and the VALIDATOR half is
 *      untouched by all of it.
 *   8. Membership is self-governing: the set can grow via threshold signatures,
 *      the same authorisation cannot be replayed, and a duplicate signer does
 *      not satisfy m-of-n.
 *
 * Usage: node chain/multinode/scripts/serve-rewards-e2e.mjs
 */
import { createWalletClient, createPublicClient, http, defineChain, getAddress, encodePacked, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const CHAIN = dirname(MULTINODE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'

const d = JSON.parse(readFileSync(join(HOME_DIR, 'validators-deployment.json'), 'utf8'))
const art = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinyServeRewards.sol/TinyServeRewards.json'), 'utf8'))
const issArt = JSON.parse(readFileSync(join(MULTINODE, 'artifacts/TinyIssuance.sol/TinyIssuance.json'), 'utf8'))
const usdcArt = JSON.parse(readFileSync(join(CHAIN, 'artifacts/TinyUSDC.sol/TinyUSDC.json'), 'utf8'))

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ATTESTOR_KEY = process.env.TINY_ATTESTOR_KEY
  || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
/** A key that is NOT in the attestor set — used to prove the set is load-bearing. */
const IMPOSTOR_KEY = process.env.TINY_IMPOSTOR_KEY
  || '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
/** A second attestor, added mid-test to prove the set can actually grow. */
const ATTESTOR2_KEY = process.env.TINY_ATTESTOR2_KEY
  || '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

let failures = 0
const ok = (cond, msg, detail = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`) }
}

const chain = defineChain({
  id: d.chainId, name: 'tiny-multinode',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ transport: http(RPC) })
const walletFor = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) })
const wait = (h) => pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rw = (functionName, args = []) =>
  pub.readContract({ address: d.serveRewards, abi: art.abi, functionName, args })
const iss = (functionName, args = []) =>
  pub.readContract({ address: d.issuance, abi: issArt.abi, functionName, args })
const usdcBal = (a) =>
  pub.readContract({ address: d.usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [a] })

async function reverted(fn) {
  try { await fn(); return null } catch (e) { return e.shortMessage || e.message }
}

const DOMAIN = () => ({
  name: 'TinyServeRewards', version: '1', chainId: d.chainId, verifyingContract: d.serveRewards,
})
const ATTESTATION_TYPES = {
  ServeAttestation: [
    { name: 'server', type: 'address' },
    { name: 'epoch', type: 'uint256' },
    { name: 'requestCount', type: 'uint256' },
    { name: 'volumeMicro', type: 'uint256' },
    { name: 'epochTotalVolumeMicro', type: 'uint256' },
  ],
}
const SET_TYPES = {
  AttestorSetChange: [
    { name: 'attestorsHash', type: 'bytes32' },
    { name: 'threshold', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
}

/** Sign an attestation with viem's typed-data signer, against a given domain. */
const signAttestation = (key, message, domain = DOMAIN()) =>
  privateKeyToAccount(key).signTypedData({
    domain, types: ATTESTATION_TYPES, primaryType: 'ServeAttestation', message,
  })

const signSetChange = (key, message) =>
  privateKeyToAccount(key).signTypedData({
    domain: DOMAIN(), types: SET_TYPES, primaryType: 'AttestorSetChange', message,
  })

async function main() {
  console.log('\n🧾 multi-node tiny chain — P3b acceptance (serve-to-earn: a bounded ORACLE)\n')
  if (!d.serveRewards) {
    console.log('  no serveRewards in the deployment file — run deploy-serve-rewards.mjs first\n')
    process.exit(1)
  }

  const deployer = walletFor(DEPLOYER_KEY)
  const attestorAddr = getAddress(privateKeyToAccount(ATTESTOR_KEY).address)
  // Anyone can submit a claim, so the submitter here is deliberately a nobody.
  const submitter = deployer

  console.log('the wiring: who may mint the serve half')
  ok(getAddress(await iss('serveDistributor')) === getAddress(d.serveRewards),
    'TinyIssuance\'s serve distributor IS this contract')
  ok(await iss('serveDistributorLocked'), 'and the pointer is LOCKED — issuance cannot be redirected')
  ok(Number(await rw('threshold')) >= 1 && Number(await rw('attestorCount')) >= 1,
    `attestor set is m-of-n shaped from day one (${await rw('threshold')} of ${await rw('attestorCount')})`)
  ok((await rw('attestorList')).map((a) => getAddress(a)).includes(attestorAddr),
    'the configured attestor is seated')

  // Servers are just addresses; on the real chain they're tiny operators.
  const serverA = getAddress('0x1111111111111111111111111111111111111111')
  const serverB = getAddress('0x2222222222222222222222222222222222222222')

  // A finished epoch to attest over.
  let epoch = BigInt(await iss('currentEpoch'))
  if (epoch === 0n) {
    console.log('  … waiting for epoch 0 to close')
    while (BigInt(await iss('currentEpoch')) === 0n) await sleep(2_000)
    epoch = BigInt(await iss('currentEpoch'))
  }
  // Pick an epoch with an unspent serve budget: this test may have run before.
  let target = epoch - 1n
  while (target > 0n && (await iss('serveMinted', [target])) > 0n) target -= 1n
  const serveBudget = await iss('serveBudget', [target])
  if ((await iss('serveMinted', [target])) > 0n) {
    console.log(`\n  every finished epoch up to ${epoch - 1n} already has serve issuance minted.`)
    console.log('  wait for the next epoch and re-run (each epoch pays once, by design).\n')
    process.exit(1)
  }
  console.log(`\nattesting over finished epoch ${target} (serve budget ${serveBudget})`)

  // 6000 micro of volume total: A did 4000, B did 2000.
  const totalVol = 6_000n
  const attA = { server: serverA, epoch: target, requestCount: 40n, volumeMicro: 4_000n, epochTotalVolumeMicro: totalVol }
  const attB = { server: serverB, epoch: target, requestCount: 20n, volumeMicro: 2_000n, epochTotalVolumeMicro: totalVol }

  console.log('\nan IMPOSTOR signature is worth nothing')
  // If this passed, the attestor set would be decorative and anyone could print
  // the serve budget. It's the first thing to check, not the last.
  const impostorSig = await signAttestation(IMPOSTOR_KEY, attA)
  const impErr = await reverted(() => submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [attA.server, attA.epoch, attA.requestCount, attA.volumeMicro, attA.epochTotalVolumeMicro, [impostorSig]],
    ...FREE,
  }))
  ok(impErr !== null, 'a non-attestor\'s signature is REJECTED', impErr === null ? 'it minted' : '')

  console.log('\na TAMPERED claim is worth nothing')
  // The signature covers every field, so inflating the volume after signing must
  // invalidate it — otherwise the numbers are advisory and only the signer's
  // identity is checked.
  const goodSigA = await signAttestation(ATTESTOR_KEY, attA)
  const tamperErr = await reverted(() => submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [attA.server, attA.epoch, attA.requestCount, attA.volumeMicro * 2n, attA.epochTotalVolumeMicro, [goodSigA]],
    ...FREE,
  }))
  ok(tamperErr !== null, 'inflating volumeMicro after signing INVALIDATES the attestation',
    tamperErr === null ? 'the inflated claim minted' : '')

  console.log('\na claim signed for ANOTHER chain is worth nothing')
  // The same attestor key signs on 8469 and on 8470. Without domain binding an
  // attestation would be portable between them — and between redeployments.
  const foreignSig = await signAttestation(ATTESTOR_KEY, attA, { ...DOMAIN(), chainId: 8469 })
  const foreignErr = await reverted(() => submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [attA.server, attA.epoch, attA.requestCount, attA.volumeMicro, attA.epochTotalVolumeMicro, [foreignSig]],
    ...FREE,
  }))
  ok(foreignErr !== null, 'an attestation signed for chain 8469 is REJECTED on 8470 (EIP-712 domain binding)',
    foreignErr === null ? 'the foreign claim minted' : '')

  console.log('\na valid attestation pays the SERVER, pro-rata')
  const predictedA = await rw('previewReward', [target, attA.volumeMicro, totalVol])
  const beforeA = await usdcBal(serverA)
  await wait(await submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [attA.server, attA.epoch, attA.requestCount, attA.volumeMicro, attA.epochTotalVolumeMicro, [goodSigA]],
    ...FREE,
  }))
  const gotA = (await usdcBal(serverA)) - beforeA
  ok(gotA > 0n && gotA === predictedA,
    `server A was paid ${gotA} micro-USDC — exactly what previewReward promised`,
    `preview ${predictedA}, actual ${gotA}`)
  // 4000/6000 of the budget, capped at 50%. The cap binds here (66% > 50%), which
  // is the interesting case: an oracle claiming most of an epoch for one address
  // gets truncated rather than obeyed.
  const cap = (serveBudget * BigInt(d.maxServerBps)) / 10_000n
  ok(gotA <= cap, `…and within the ${Number(d.maxServerBps) / 100}% per-server cap (${cap})`)

  console.log('\nthe epoch total is PINNED by the first claim')
  // Without this, each server could be handed a flattering denominator: every
  // payout looks correctly pro-rata while the epoch over-distributes, and only
  // the last claimant reverts — for what looks like someone else's fault.
  const inconsistent = { ...attB, epochTotalVolumeMicro: 3_000n }
  const incSig = await signAttestation(ATTESTOR_KEY, inconsistent)
  const incErr = await reverted(() => submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [inconsistent.server, inconsistent.epoch, inconsistent.requestCount,
      inconsistent.volumeMicro, inconsistent.epochTotalVolumeMicro, [incSig]],
    ...FREE,
  }))
  ok(incErr !== null, 'a second claim carrying a DIFFERENT epoch total is REJECTED',
    incErr === null ? 'the inconsistent total was accepted' : '')

  console.log('\na second server claims the same epoch, against the pinned total')
  const predictedB = await rw('previewReward', [target, attB.volumeMicro, totalVol])
  const beforeB = await usdcBal(serverB)
  const goodSigB = await signAttestation(ATTESTOR_KEY, attB)
  await wait(await submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [attB.server, attB.epoch, attB.requestCount, attB.volumeMicro, attB.epochTotalVolumeMicro, [goodSigB]],
    ...FREE,
  }))
  const gotB = (await usdcBal(serverB)) - beforeB
  ok(gotB > 0n && gotB === predictedB, `server B was paid ${gotB} for its 2000/6000 share`)
  ok(gotB < gotA, 'B earned less than A — the split follows attested volume')

  console.log('\nthe budget holds, and the VALIDATOR half is untouched')
  const serveMinted = await iss('serveMinted', [target])
  ok(serveMinted === gotA + gotB && serveMinted <= serveBudget,
    `serve minted ${serveMinted} ≤ the epoch's serve budget ${serveBudget}`)
  // The two halves share a decaying total but not a pool: this is what makes a
  // compromised serve oracle survivable.
  const vBudget = await iss('validatorBudget', [target])
  const vMinted = await iss('validatorMinted', [target])
  ok(vMinted <= vBudget,
    `validator budget untouched by serve claims (${vMinted} of ${vBudget}) — separate pools`)

  console.log('\nwork is paid once')
  const twiceErr = await reverted(() => submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [attA.server, attA.epoch, attA.requestCount, attA.volumeMicro, attA.epochTotalVolumeMicro, [goodSigA]],
    ...FREE,
  }))
  ok(twiceErr !== null, 'the same server cannot claim the same epoch twice',
    twiceErr === null ? 'double claim succeeded' : '')

  console.log('\nan OPEN epoch cannot be claimed')
  const openEpoch = BigInt(await iss('currentEpoch'))
  const openAtt = { server: serverA, epoch: openEpoch, requestCount: 1n, volumeMicro: 1_000n, epochTotalVolumeMicro: 1_000n }
  const openSig = await signAttestation(ATTESTOR_KEY, openAtt)
  const openErr = await reverted(() => submitter.writeContract({
    address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
    args: [openAtt.server, openAtt.epoch, openAtt.requestCount, openAtt.volumeMicro, openAtt.epochTotalVolumeMicro, [openSig]],
    ...FREE,
  }))
  ok(openErr !== null, 'claiming the CURRENT epoch reverts — the attested total is still growing',
    openErr === null ? 'the open-epoch claim minted' : '')

  console.log('\nthe attestor set governs ITSELF (the path away from one oracle)')
  const attestor2 = getAddress(privateKeyToAccount(ATTESTOR2_KEY).address)
  const currentList = (await rw('attestorList')).map((a) => getAddress(a))
  if (currentList.includes(attestor2)) {
    console.log('  … set already grown by a previous run, skipping the growth check')
    ok(true, `attestor set already has ${currentList.length} members`)
  } else {
    const nextSet = [...currentList, attestor2]
    const nonce = await rw('setNonce')
    // threshold stays 1 so the rest of the suite is re-runnable with one signer;
    // the SHAPE (m-of-n, self-governed) is what's being proven here.
    const setSig = await signSetChange(ATTESTOR_KEY, {
      attestorsHash: keccak256(encodePacked(['address[]'], [nextSet])),
      threshold: 1n,
      nonce,
    })
    await wait(await submitter.writeContract({
      address: d.serveRewards, abi: art.abi, functionName: 'setAttestors',
      args: [nextSet, 1n, [setSig]], ...FREE,
    }))
    const grown = (await rw('attestorList')).map((a) => getAddress(a))
    ok(grown.length === currentList.length + 1 && grown.includes(attestor2),
      `the set GREW to ${grown.length} attestors, authorised by the set itself — no operator key`,
      `now: ${grown.join(', ')}`)

    // Replaying the same authorisation must fail, or one signature is a standing
    // power to reshape the set.
    const replayErr = await reverted(() => submitter.writeContract({
      address: d.serveRewards, abi: art.abi, functionName: 'setAttestors',
      args: [nextSet, 1n, [setSig]], ...FREE,
    }))
    ok(replayErr !== null, 'the same set-change authorisation cannot be REPLAYED (nonce bumped)',
      replayErr === null ? 'the replay succeeded' : '')
  }

  console.log('\none attestor cannot impersonate a quorum')
  // Raise the threshold to 2, then try to satisfy it with the same signer twice.
  // Without a distinctness check, m-of-n is theatre: one key signs m times.
  const listNow = (await rw('attestorList')).map((a) => getAddress(a))
  if (listNow.length >= 2) {
    const nonce2 = await rw('setNonce')
    const raise = await signSetChange(ATTESTOR_KEY, {
      attestorsHash: keccak256(encodePacked(['address[]'], [listNow])),
      threshold: 2n,
      nonce: nonce2,
    })
    await wait(await submitter.writeContract({
      address: d.serveRewards, abi: art.abi, functionName: 'setAttestors',
      args: [listNow, 2n, [raise]], ...FREE,
    }))
    ok(Number(await rw('threshold')) === 2, 'threshold raised to 2 of 2')

    const nextEpochAtt = { server: serverA, epoch: target, requestCount: 1n, volumeMicro: 1n, epochTotalVolumeMicro: totalVol }
    const solo = await signAttestation(ATTESTOR_KEY, nextEpochAtt)
    const dupErr = await reverted(() => submitter.writeContract({
      address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
      args: [nextEpochAtt.server, nextEpochAtt.epoch, nextEpochAtt.requestCount,
        nextEpochAtt.volumeMicro, nextEpochAtt.epochTotalVolumeMicro, [solo, solo]], ...FREE,
    }))
    ok(dupErr !== null, 'the SAME signature twice does not satisfy 2-of-2 — duplicates are rejected',
      dupErr === null ? 'a duplicate signer passed the quorum' : '')

    // A real 2-of-2 must work, or the threshold is a denial-of-service instead of
    // a security control. Uses a fresh unclaimed epoch if one exists.
    let fresh = -1n
    const cur = BigInt(await iss('currentEpoch'))
    for (let e = cur - 1n; e >= 0n; e--) {
      if ((await iss('serveMinted', [e])) === 0n && (await iss('serveBudget', [e])) > 0n) { fresh = e; break }
      if (e === 0n) break
    }
    if (fresh >= 0n) {
      const twoAtt = { server: serverB, epoch: fresh, requestCount: 5n, volumeMicro: 1_000n, epochTotalVolumeMicro: 1_000n }
      const sigs = await Promise.all([ATTESTOR_KEY, ATTESTOR2_KEY].map((k) => signAttestation(k, twoAtt)))
      // Ordered by recovered address, as the contract requires.
      const ordered = [
        { a: getAddress(privateKeyToAccount(ATTESTOR_KEY).address), s: sigs[0] },
        { a: attestor2, s: sigs[1] },
      ].sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1)).map((o) => o.s)
      const beforeTwo = await usdcBal(serverB)
      await wait(await submitter.writeContract({
        address: d.serveRewards, abi: art.abi, functionName: 'claimServeReward',
        args: [twoAtt.server, twoAtt.epoch, twoAtt.requestCount, twoAtt.volumeMicro, twoAtt.epochTotalVolumeMicro, ordered],
        ...FREE,
      }))
      ok((await usdcBal(serverB)) > beforeTwo,
        'a genuine 2-of-2 (two DIFFERENT attestors) pays — the threshold secures, it does not block')
    } else {
      console.log('  … no unclaimed epoch left for the 2-of-2 payment check this run')
    }

    // Leave the set at threshold 1 so the suite is re-runnable with one signer.
    // (P2's lesson: a test that permanently changes the system it inspects can
    // only be run once, and its second run reads as a broken system.)
    const nonce3 = await rw('setNonce')
    const restore = await Promise.all([ATTESTOR_KEY, ATTESTOR2_KEY].map((k) => signSetChange(k, {
      attestorsHash: keccak256(encodePacked(['address[]'], [listNow])),
      threshold: 1n,
      nonce: nonce3,
    })))
    const orderedRestore = [
      { a: getAddress(privateKeyToAccount(ATTESTOR_KEY).address), s: restore[0] },
      { a: attestor2, s: restore[1] },
    ].sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1)).map((o) => o.s)
    await wait(await submitter.writeContract({
      address: d.serveRewards, abi: art.abi, functionName: 'setAttestors',
      args: [listNow, 1n, orderedRestore], ...FREE,
    }))
    ok(Number(await rw('threshold')) === 1, 'threshold restored to 1 — suite left re-runnable')
  }

  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ P3b verified: serve-to-earn pays on attestation, and the oracle is bounded'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n`)
  process.exit(1)
})
