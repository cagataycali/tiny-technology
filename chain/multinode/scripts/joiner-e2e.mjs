#!/usr/bin/env node
/**
 * P5 acceptance: can a STRANGER run a full node on 8470, using only what this repo
 * publishes, and end up holding the same chain we do?
 *
 * The claim under test is tier 1 of the design doc's participation table — "Full
 * node: permission needed NONE". Everything else in P1–P4 was about who may
 * *validate*; this is about whether an outsider can independently *verify*, which
 * is the more basic freedom and the one nothing had tested yet.
 *
 * What makes this a real test rather than a demo:
 *
 *  1. THE JOINER GETS NOTHING PRIVILEGED. It boots from `chain/multinode/
 *     genesis-8470.json` (the file in the repo, not the operator's copy), a
 *     bootnode enode, and a node key it generates ITSELF. No founder key, no
 *     allowlist entry, no operator action while it runs.
 *  2. IT IS NOT A VALIDATOR, and that is asserted. A joiner that got seated would
 *     mean the seat came from something other than stake.
 *  3. THE AGREEMENT CHECK IS HASH-AT-A-COMMON-HEIGHT, not "the head is rising".
 *     Four nodes on four private forks each report a rising head and look perfect;
 *     P1 learned this. Comparing block HASHES at min(heads)-1 is what distinguishes
 *     "synced with us" from "confidently alone".
 *  4. IT RE-EXECUTES rather than trusting: --sync-mode=FULL, asserted by asking the
 *     joiner for state (a balance) it could only know by running the transactions.
 *
 * Usage:
 *   bash chain/multinode/scripts/join-tiny-chain.sh --background --rpc-port 8555 --p2p-port 30500
 *   node chain/multinode/scripts/joiner-e2e.mjs
 *
 * (The suite starts the joiner itself if nothing answers on its RPC port.)
 */
import { createPublicClient, createWalletClient, http, defineChain, getAddress, parseUnits, fromRlp } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MULTINODE = dirname(HERE)
const HOME_DIR = process.env.TINY_MULTINODE_HOME || join(homedir(), '.tiny-chain/multinode')
const JOIN_HOME = process.env.TINY_JOIN_HOME || join(homedir(), '.tiny-chain/joiner')
const INSIDER_RPC = process.env.TINY_MULTINODE_RPC || 'http://127.0.0.1:8601'
const JOINER_RPC = process.env.TINY_JOINER_RPC || 'http://127.0.0.1:8555'
const JOINER_P2P = process.env.TINY_JOINER_P2P || '30500'
const EXPECTED_CHAIN_ID = 8470

const DEPLOYER_KEY = process.env.TINY_MULTINODE_DEPLOYER_KEY
  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

let pass = 0
let fail = 0
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rpc = async (url, method, params = []) => {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

const alive = async (url) => {
  try { await rpc(url, 'eth_chainId'); return true } catch { return false }
}

/** Start the joiner via the published script — the same command a stranger runs. */
async function startJoiner() {
  const script = join(HERE, 'join-tiny-chain.sh')
  const enode = await rpc(INSIDER_RPC, 'net_enode')
  console.log(`  … starting a joiner via join-tiny-chain.sh (bootnode ${enode.slice(0, 26)}…)`)
  const child = spawn('bash', [
    script, '--background', '--rpc-port', new URL(JOINER_RPC).port, '--p2p-port', JOINER_P2P,
    '--home', JOIN_HOME, '--bootnodes', enode,
  ], { stdio: 'inherit' })
  await new Promise((res, rej) => {
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`join script exited ${code}`))))
    child.on('error', rej)
  })
  for (let i = 0; i < 90; i++) {
    if (await alive(JOINER_RPC)) return true
    await sleep(2_000)
  }
  return false
}

async function main() {
  console.log('\n🔗 multi-node tiny chain — P5 acceptance (an outsider runs a full node)\n')

  const d = JSON.parse(readFileSync(join(HOME_DIR, 'validators-deployment.json'), 'utf8'))
  const insiderChainId = await rpc(INSIDER_RPC, 'eth_chainId')
  if (parseInt(insiderChainId, 16) !== EXPECTED_CHAIN_ID) {
    console.error(`refusing: ${INSIDER_RPC} is chain ${parseInt(insiderChainId, 16)}, expected ${EXPECTED_CHAIN_ID}`)
    process.exit(1)
  }

  // ── 1. what the repo publishes is enough to boot ────────────────────────────
  section('the published artifacts are sufficient (nothing private required)')
  const repoGenesisPath = join(MULTINODE, 'genesis-8470.json')
  ok(existsSync(repoGenesisPath), 'chain/multinode/genesis-8470.json is committed — the chain has a public genesis')
  ok(existsSync(join(MULTINODE, 'bootnodes-8470.txt')), 'chain/multinode/bootnodes-8470.txt is committed — and where to find peers')
  ok(existsSync(join(HERE, 'join-tiny-chain.sh')), 'join-tiny-chain.sh is committed — one command, not a runbook')

  // The genesis in the repo must be the one the network is ACTUALLY running, or a
  // joiner boots a chain that merely resembles ours and fails to peer for reasons
  // that look like a network problem. Compare the genesis BLOCK HASH, not the file
  // bytes: the hash is what the p2p handshake checks, and a reformatted-but-
  // equivalent file would pass a diff while an inconsequential-looking config edit
  // would fail the handshake.
  const repoGenesis = JSON.parse(readFileSync(repoGenesisPath, 'utf8'))
  ok(repoGenesis.config.chainId === EXPECTED_CHAIN_ID,
    `the published genesis declares chain ${repoGenesis.config.chainId}`)
  ok(repoGenesis.config.qbft != null && repoGenesis.config.transitions?.qbft?.length > 0,
    'the published genesis carries the QBFT config AND the contract-mode transition — a joiner learns who validates from it')
  const transition = repoGenesis.config.transitions.qbft[0]
  ok(getAddress(transition.validatorcontractaddress) === getAddress(d.validatorContract),
    'the published transition names the LIVE TinyValidators address — a joiner consults the same registry we do',
    `published ${transition.validatorcontractaddress} vs deployed ${d.validatorContract}`)
  // ⚠️ Both keys, per the c2 lesson: with the address alone besu silently ignores
  // the transition and seats validators nobody consults.
  ok(transition.validatorselectionmode === 'contract',
    'the transition sets validatorselectionmode:contract — without it besu SILENTLY ignores the address')

  // ⚠️ THE c7 BUG, guarded here because it is invisible everywhere else. A qbft
  // transition's `block` is interpreted with the MILESTONE TYPE of the nearest
  // preceding hardfork, and ours is `shanghaiTime: 0` — a TIME milestone. So besu
  // reads this field as a timestamp no matter what we meant by it. A block number
  // (246) therefore means "timestamp 246", i.e. 1970, i.e. contract mode from
  // block 1 — which the founders never notice, because they already hold those
  // blocks and never re-validate them. The first party to feel it is a stranger
  // syncing from genesis, who is rejected at block 1 and stalls at 0 forever.
  //
  // A small number here is the bug; assert loudly on the FORM, because the
  // symptom appears only in someone else's log.
  ok(transition.block > 1_600_000_000,
    `the transition is keyed by TIMESTAMP (${transition.block}), not a block number — with shanghaiTime present besu reads it as a time milestone either way (c7)`,
    'a small value here means "1970" ⇒ contract mode from block 1 ⇒ no outsider can ever sync')

  // …and the timestamp must be the chain's REAL switch point, not merely large.
  // The boundary is observable: the last blockheader-mode block still carries the
  // validator list in extraData, the first contract-mode block does not.
  {
    // extraData is one RLP list: [vanity(32B), validators[], vote, round, seals[]].
    const validatorsInExtra = (extraData) => fromRlp(extraData, 'hex')[1].length
    const atOrAfter = async (ts) => {
      // Walk the insider's chain for the first block at/after the transition ts.
      let loBlk = 1n
      let hiBlk = await rpc(INSIDER_RPC, 'eth_blockNumber').then((h) => BigInt(h))
      const tsAt = async (n) =>
        BigInt((await rpc(INSIDER_RPC, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false])).timestamp)
      while (loBlk < hiBlk) {
        const mid = (loBlk + hiBlk) / 2n
        if (await tsAt(mid) < BigInt(ts)) loBlk = mid + 1n
        else hiBlk = mid
      }
      return loBlk
    }
    const first = await atOrAfter(transition.block)
    const [after, before] = await Promise.all([first, first - 1n].map((n) =>
      rpc(INSIDER_RPC, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false])))
    ok(validatorsInExtra(after.extraData) === 0 && validatorsInExtra(before.extraData) > 0,
      `the transition timestamp lands exactly on the chain's real mode switch (block ${first}) — extraData carries validators before it and none at/after`,
      `block ${first - 1n}: ${validatorsInExtra(before.extraData)} validators in extraData; block ${first}: ${validatorsInExtra(after.extraData)}`)
  }
  ok(repoGenesis.config.shanghaiTime === 0,
    'the published genesis enables shanghai — otherwise every contract deploy dies on PUSH0')
  ok(repoGenesis.config.zeroBaseFee === true && BigInt(repoGenesis.gasLimit) > 0n,
    `gas is free but METERED (gasLimit ${BigInt(repoGenesis.gasLimit)}) — free ≠ unmetered`)

  // ── 2. the joiner is running, from that genesis ────────────────────────────
  section('a stranger\'s node, booted by the published script')
  if (!(await alive(JOINER_RPC))) {
    const up = await startJoiner()
    if (!up) {
      console.error(`\n💥 the joiner never answered on ${JOINER_RPC} — see ${JOIN_HOME}/logs/joiner.log\n`)
      process.exit(1)
    }
  }
  ok(true, `the joiner answers RPC on ${JOINER_RPC}`)

  const joinerChainId = parseInt(await rpc(JOINER_RPC, 'eth_chainId'), 16)
  ok(joinerChainId === EXPECTED_CHAIN_ID, `the joiner is on chain ${joinerChainId}`)

  // A joiner holding one of OUR node keys would be a remote copy of us, not a peer.
  const insiderEnodes = []
  for (let n = 1; n <= 4; n++) {
    try {
      const e = await rpc(`http://127.0.0.1:860${n}`, 'net_enode')
      insiderEnodes.push(e.split('//')[1].split('@')[0])
    } catch { /* that node may be down; the assertion below still holds for the rest */ }
  }
  const joinerEnode = await rpc(JOINER_RPC, 'net_enode')
  const joinerPubkey = joinerEnode.split('//')[1].split('@')[0]
  ok(insiderEnodes.length > 0 && !insiderEnodes.includes(joinerPubkey),
    'the joiner\'s node key is its OWN — not a copy of any founder node\'s identity')

  // ── 3. it actually synced OUR chain (not a lookalike fork) ─────────────────
  section('it holds the SAME chain — hash agreement, not a rising head')
  const genesisHashes = await Promise.all([INSIDER_RPC, JOINER_RPC].map(async (url) =>
    (await rpc(url, 'eth_getBlockByNumber', ['0x0', false])).hash))
  ok(genesisHashes[0] === genesisHashes[1],
    'genesis block hashes match — the joiner booted the same genesis, which is what the p2p handshake enforces',
    `insider ${genesisHashes[0]}\n      joiner  ${genesisHashes[1]}`)

  // Wait for the joiner to catch up. It starts from block 0 and re-executes every
  // block, so on a chain thousands of blocks deep this is not instant.
  const insiderHead = () => rpc(INSIDER_RPC, 'eth_blockNumber').then((h) => BigInt(h))
  const joinerHead = () => rpc(JOINER_RPC, 'eth_blockNumber').then((h) => BigInt(h))
  let jh = 0n
  let ih = await insiderHead()
  for (let i = 0; i < 150; i++) {
    jh = await joinerHead()
    ih = await insiderHead()
    // "Caught up" means within a couple of blocks of a chain that is still moving.
    if (jh > 0n && ih - jh <= 2n) break
    if (i % 10 === 0) console.log(`  … syncing: joiner ${jh} / network ${ih}`)
    await sleep(2_000)
  }
  ok(jh > 0n, `the joiner synced past genesis (head ${jh})`)
  ok(ih - jh <= 2n, `the joiner is level with the network (joiner ${jh}, network ${ih})`,
    `still ${ih - jh} blocks behind`)

  // A joiner stuck at genesis is the single most informative failure this suite can
  // report, so report it HERE rather than letting the next check compute a height of
  // -1 and die inside eth_getBlockByNumber ("Invalid block number params"). That
  // masked the c7 bug behind a JSON-RPC error the first time it happened. The reason
  // is always in the joiner's own log — a rejected header names the rule that
  // rejected it — so print the way to it instead of a stack trace.
  if (jh === 0n) {
    console.error(`\n💥 the joiner never left block 0 — it is being REFUSED our chain, not merely slow.`)
    console.error(`   Look for the rejecting rule (not the disconnect) in:`)
    console.error(`     grep -E 'Invalid block|ValidationRule' ${JOIN_HOME}/logs/joiner.log | head`)
    console.error(`   If it names QbftValidatorsValidationRule, the genesis transition is being read`)
    console.error(`   as a 1970 TIMESTAMP — see the _transitions_comment in genesis-8470.json (c7).\n`)
    console.log(`\n❌ ${pass} passed, ${fail} failed`)
    process.exit(1)
  }

  // THE load-bearing check: same hash at a common height. Heads legitimately differ
  // by a block, so compare below both.
  const common = (jh < ih ? jh : ih) - 1n
  const [insiderBlock, joinerBlock] = await Promise.all([INSIDER_RPC, JOINER_RPC].map(async (url) =>
    await rpc(url, 'eth_getBlockByNumber', [`0x${common.toString(16)}`, false])))
  ok(insiderBlock.hash === joinerBlock.hash,
    `identical block hash at common height ${common} — the joiner holds OUR chain, not a fork of its own`,
    `insider ${insiderBlock.hash}\n      joiner  ${joinerBlock.hash}`)
  ok(insiderBlock.stateRoot === joinerBlock.stateRoot,
    'identical state root at that height — it computed the same state, it did not copy ours')

  // Peering is mutual: our nodes must see the stranger too, or it is a spectator
  // reading someone's cache rather than a member of the network.
  const joinerPeers = parseInt(await rpc(JOINER_RPC, 'net_peerCount'), 16)
  ok(joinerPeers > 0, `the joiner has ${joinerPeers} peer(s)`)

  // ⚠️ Do NOT assert on one founder's peer count. A joiner is introduced by the
  // bootnode but then peers by DISCOVERY, so it may well end up attached to the
  // other three and not to the node whose enode it was handed — that happened here,
  // and it failed an assertion while the network was perfectly healthy. What is
  // actually claimed is that founders see the stranger AT ALL, so measure the thing
  // that does not depend on which founder it chose: founders form a full mesh among
  // themselves (n·(n−1) directed links), and every peer they count beyond that is a
  // link to an outsider.
  const founderCounts = []
  for (let n = 1; n <= 4; n++) {
    try { founderCounts.push(parseInt(await rpc(`http://127.0.0.1:860${n}`, 'net_peerCount'), 16)) } catch { /* down */ }
  }
  const meshLinks = founderCounts.length * (founderCounts.length - 1)
  const outsiderLinks = founderCounts.reduce((a, b) => a + b, 0) - meshLinks
  ok(outsiderLinks > 0,
    `founders count ${outsiderLinks} link(s) to nodes outside their own mesh — the network GREW by the stranger`,
    `per-founder peers [${founderCounts}], own-mesh links ${meshLinks}`)
  ok(outsiderLinks === joinerPeers,
    `both sides agree on the count (${joinerPeers}) — peering is mutual, the joiner is not reading a cache`)

  // ── 4. it verified rather than trusted ────────────────────────────────────
  section('it re-executed the chain (FULL sync), it did not take our word')
  // A balance is state, not a header field: the joiner can only answer this by
  // having run every transaction that touched the account. Ask about the USDC
  // contract, whose balance mapping exists only in executed state.
  const usdcTotalSupplyCall = { to: d.usdc, data: '0x18160ddd' }
  const [insiderSupply, joinerSupply] = await Promise.all([INSIDER_RPC, JOINER_RPC].map((url) =>
    rpc(url, 'eth_call', [usdcTotalSupplyCall, `0x${common.toString(16)}`])))
  ok(BigInt(insiderSupply) === BigInt(joinerSupply) && BigInt(joinerSupply) > 0n,
    `the joiner independently computes TinyUSDC totalSupply = ${BigInt(joinerSupply)} — contract state, only knowable by executing`)

  // And it agrees about WHO VALIDATES, which it learned from the contract named in
  // the genesis, by executing the same call we do.
  const getValidatorsCall = { to: d.validatorContract, data: '0xb7ab4db5' }
  const [insiderSet, joinerSet] = await Promise.all([INSIDER_RPC, JOINER_RPC].map((url) =>
    rpc(url, 'eth_call', [getValidatorsCall, `0x${common.toString(16)}`])))
  ok(insiderSet === joinerSet && insiderSet.length > 2,
    'the joiner reads the SAME validator set from the SAME contract — it verifies consensus membership itself')

  // ── 5. what joining does NOT give you (the honest half) ───────────────────
  section('a full node is NOT a validator (asserted, not just documented)')
  const seated = (await rpc(INSIDER_RPC, 'qbft_getValidatorsByBlockNumber', ['latest'])).map((a) => getAddress(a))
  // The joiner's node key is its consensus identity; derive the address it would
  // occupy if it were seated.
  const joinerKeyPath = join(JOIN_HOME, 'data/key')
  ok(existsSync(joinerKeyPath), 'the joiner generated its own node key on disk')
  const rawKey = readFileSync(joinerKeyPath, 'utf8').trim()
  const joinerAddr = getAddress(privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`).address)
  ok(!seated.includes(joinerAddr),
    `the joiner is NOT a validator (${joinerAddr}) — syncing earns no seat; only stake does`)
  ok(seated.length >= 4, `the consensus set is unchanged at ${seated.length} — a new full node does not disturb it`)

  // The joiner can still SUBMIT work, which is the useful half of a non-validator
  // node: it has its own RPC and its own txpool, so it does not depend on our door.
  {
    // ⚠️ The c1 lesson, restated: a sender ABSENT FROM STATE cannot be included even
    // at zero gas price — the pool accepts and gossips the tx and the proposer never
    // selects it, silently. So a gas drip is a real onboarding step, and P5's claim
    // "you need no native coin" is false for a brand-new address. Prove the drip
    // works by using a fresh address that only this suite funds.
    const insiderChain = defineChain({
      id: EXPECTED_CHAIN_ID, name: 'tiny-8470',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [INSIDER_RPC] } },
    })
    const joinerChain = { ...insiderChain, rpcUrls: { default: { http: [JOINER_RPC] } } }
    const funder = createWalletClient({
      account: privateKeyToAccount(DEPLOYER_KEY), chain: insiderChain, transport: http(INSIDER_RPC),
    })
    const insiderPub = createPublicClient({ transport: http(INSIDER_RPC) })
    // A fresh key per run so the "was absent from state" premise holds every time.
    const seedHead = await insiderHead()
    const newcomerKey = `0x${'d0'.repeat(8)}${seedHead.toString(16).padStart(48, '0')}`.slice(0, 66)
    const newcomer = privateKeyToAccount(newcomerKey)
    const balBefore = await insiderPub.getBalance({ address: newcomer.address })
    ok(balBefore === 0n, `a brand-new address starts with no native balance (${newcomer.address})`)

    // The drip.
    await insiderPub.waitForTransactionReceipt({
      hash: await funder.sendTransaction({ to: newcomer.address, value: parseUnits('1', 18), gas: 30_000n, ...FREE }),
    })
    ok(await insiderPub.getBalance({ address: newcomer.address }) > 0n,
      'the gas drip funded it — zero-price gas still needs the sender to EXIST in state (c1)')

    // Now submit THROUGH THE JOINER'S OWN RPC, and require that the network mined
    // it. That is the difference between running a node and using ours: the
    // transaction enters via a door the stranger controls.
    const viaJoiner = createWalletClient({ account: newcomer, chain: joinerChain, transport: http(JOINER_RPC) })
    const txHash = await viaJoiner.sendTransaction({ to: newcomer.address, value: 0n, gas: 30_000n, ...FREE })
    let receipt = null
    for (let i = 0; i < 45; i++) {
      try { receipt = await insiderPub.getTransactionReceipt({ hash: txHash }); break } catch { /* not yet */ }
      await sleep(2_000)
    }
    ok(receipt != null && receipt.status === 'success',
      'a tx submitted through the STRANGER\'S RPC was mined by the network — an outsider has a door of their own',
      receipt ? `status ${receipt.status}` : 'never mined')
    if (receipt) {
      const minedIn = await rpc(INSIDER_RPC, 'eth_getBlockByHash', [receipt.blockHash, false])
      ok(getAddress(minedIn.miner) !== joinerAddr,
        'and it was mined by a VALIDATOR, not by the joiner — participation without a seat')
    } else fail++
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(`\n💥 ${e.shortMessage || e.message}\n${e.stack || ''}`)
  process.exit(1)
})
