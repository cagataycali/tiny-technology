#!/usr/bin/env node
/**
 * 💸 EXECUTE the stake-migration plan on chain 8470.
 *
 * ⚠️⚠️ THIS SENDS TRANSACTIONS AND SPENDS UNMINTABLE BALANCE. P3 handed TinyUSDC's
 * ownership to TinyIssuance irreversibly, so every unit moved here is a unit that
 * cannot be re-created, and posted stake cannot be withdrawn while its holder is
 * seated (unstake() reverts StillSeated()). There is no undo. Hence:
 *
 *   - the plan is read through the SAME reader the report uses
 *     (lib/read-migration-state.mjs) — a reviewed plan and an executed plan computed
 *     by two copies of the logic are two plans that merely agree today;
 *   - the transaction ORDER is built by a pure module that can refuse
 *     (funding-executor.mjs), not by a loop here;
 *   - `--dry-run` is the default posture: it prints the exact list and sends nothing;
 *   - it is SAFE TO RE-RUN. The planner subtracts stake already posted, so a second
 *     run after a full execution has nothing left to do. That is what makes re-running
 *     the honest check that the first run landed;
 *   - and success is NOT "the receipts came back". A call that does not revert has not
 *     necessarily had the effect it was for. Success is: re-read the chain, re-plan,
 *     and find nothing left to do.
 *
 * Usage:
 *   node chain/multinode/scripts/fund-migration.mjs --incoming 0x… --dry-run
 *   node chain/multinode/scripts/fund-migration.mjs --incoming 0x…     # sends
 *
 * Exit 0 = executed (or dry-run printed) and converged. Exit 1 = refused or did not
 * converge. Never edits the genesis; swap-preflight.mjs is still the gate for that.
 */
import { createWalletClient, http, defineChain, getAddress } from 'viem'
import { planStakeMigration } from '../stake-migration-plan.mjs'
import { buildFundingTxs, verifyConverged } from '../funding-executor.mjs'
import { readMigrationState, RPC, ERC20_ABI, REG_ABI, EXPECTED_CHAIN_ID } from './lib/read-migration-state.mjs'

const FREE = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
const DRY = process.argv.includes('--dry-run')

const plan1e6 = (n) => Number(n) / 1e6

async function main() {
  const incoming = arg('incoming')
  const st = await readMigrationState({ incoming })
  if (!st.incomingRaw) {
    console.error('no incoming registry to fund — pass --incoming 0x…, or deploy one with deploy-validators-slashable.mjs first')
    process.exit(1)
  }
  const registry = getAddress(st.incomingRaw)

  const mkPlan = (state) => planStakeMigration({
    validators: state.validators,
    minStakeMicro: state.minStake,
    minValidators: Number(state.minValidators),
    maxValidators: Number(state.maxValidators),
  })

  const plan = mkPlan(st)
  console.log(`chain ${st.chainId}  head #${st.head}\nincoming registry ${registry}`)
  console.log(`birth set from ${st.bornFrom}`)
  console.log(`minStake ${plan1e6(st.minStake)}  floor ${st.minValidators}  cap ${st.maxValidators}`)
  for (const w of plan.warnings) console.log(`   ⚠️  ${w}`)
  if (!plan.ok) {
    for (const b of plan.blockers) console.error(`   🛑 ${b}`)
    console.error('\nRefusing: the plan does not hold. Nothing was sent.')
    process.exit(1)
  }

  const built = buildFundingTxs(plan)
  if (!built.ok) {
    for (const r of built.refusals) console.error(`   🛑 ${r}`)
    console.error('\nRefusing: the plan is fundable but its transaction ORDER is not safe. Nothing was sent.')
    process.exit(1)
  }

  if (!built.txs.length) {
    // Already converged. This is a success, not a no-op to be worked around: it is
    // exactly what a completed migration looks like when the check is re-run.
    console.log('\n✅ nothing to do — every seated validator already holds minStake in the incoming registry.')
    const v = verifyConverged(plan, plan.afterRotation.eligible)
    for (const p of v.problems) console.log(`   ⚠️  ${p}`)
    console.log(`\nafter first rotate(): ${plan.afterRotation.seats} seats, quorum ${plan.afterRotation.quorum}, live ${plan.afterRotation.live}`)
    console.log(`\nNext: node chain/multinode/scripts/swap-preflight.mjs --incoming ${registry}  (must exit 0)`)
    process.exit(v.converged ? 0 : 1)
  }

  console.log(`\n${built.txs.length} transaction(s)${DRY ? ' — DRY RUN, nothing will be sent' : ''}:`)
  built.txs.forEach((t, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${t.kind.padEnd(8)} ${plan1e6(t.amountMicro).toString().padStart(8)}  from ${t.from}${t.kind === 'transfer' ? ` → ${t.to}` : ''}`)
    console.log(`      ${t.note}`)
  })

  if (DRY) {
    console.log('\nDry run only. Re-run without --dry-run to send. Re-running after a real run is safe: the plan converges.')
    process.exit(0)
  }

  const chain = defineChain({
    id: EXPECTED_CHAIN_ID, name: 'tiny-multinode',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })

  console.log('')
  let sent = 0
  for (const [i, t] of built.txs.entries()) {
    const holder = st.keys.get(getAddress(t.from))
    if (!holder) {
      // Cannot happen for a plan whose stakes all have hasKey — asserted rather than
      // assumed, because signing with the wrong key is not a recoverable mistake.
      console.error(`🛑 step ${i + 1}: no key for ${t.from}. Stopping with ${sent} transaction(s) sent — re-run to resume, the plan converges.`)
      process.exit(1)
    }
    const wallet = createWalletClient({ account: holder.account, chain, transport: http(RPC) })
    let hash
    if (t.kind === 'transfer') {
      hash = await wallet.writeContract({ address: st.usdc, abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(t.to), t.amountMicro], ...FREE })
    } else if (t.kind === 'approve') {
      hash = await wallet.writeContract({ address: st.usdc, abi: ERC20_ABI, functionName: 'approve', args: [registry, t.amountMicro], ...FREE })
    } else {
      hash = await wallet.writeContract({ address: registry, abi: REG_ABI, functionName: 'stake', args: [t.amountMicro], ...FREE })
    }
    const rc = await st.pub.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') {
      console.error(`🛑 step ${i + 1} (${t.kind} from ${t.from}) REVERTED — ${hash}`)
      console.error(`Stopping with ${sent} transaction(s) landed. Re-run this script to resume: the planner subtracts stake already posted, so it will not re-charge what succeeded.`)
      process.exit(1)
    }
    sent++
    console.log(`  ✓ ${String(i + 1).padStart(2)}. ${t.kind.padEnd(8)} ${t.from} — block ${rc.blockNumber}`)
  }

  // ── the only honest success check: re-read and re-plan ─────────────────────────
  // A receipt says a call did not revert. It does not say the registry now has a
  // working validator set — c19 built the plan precisely because the two moments that
  // matter are invisible from any single call's result.
  console.log('\nre-reading the chain and re-planning (a receipt is not an effect)…')
  const after = await readMigrationState({ incoming: st.incomingRaw })
  const replan = mkPlan(after)
  const v = verifyConverged(replan, plan.afterRotation.eligible)
  for (const p of v.problems) console.error(`   🛑 ${p}`)
  console.log(`after first rotate(): ${replan.afterRotation.seats} seats, quorum ${replan.afterRotation.quorum}, live ${replan.afterRotation.live} (eligible ${replan.afterRotation.eligible})`)
  for (const a of after.validators) {
    console.log(`   ${a.address}  staked-in ${plan1e6(a.alreadyStakedMicro)}  free ${plan1e6(a.freeMicro)}`)
  }
  if (!v.converged) {
    console.error('\n🛑 executed, but did NOT converge. Do not proceed to the swap.')
    process.exit(1)
  }
  console.log(`\n✅ ${sent} transaction(s) landed and the migration CONVERGED — nothing left to fund.`)
  console.log(`\nNext, and it can still refuse:\n  node chain/multinode/scripts/swap-preflight.mjs --incoming ${registry}   (must exit 0)\n  node chain/multinode/scripts/slashable-registry-e2e.mjs\nThe genesis transition itself stays USER-GATED.`)
}

main().catch((err) => {
  console.error('\n💥', err?.shortMessage || err?.message || err)
  process.exit(1)
})
