#!/usr/bin/env node
/**
 * 📦 STAKE MIGRATION PLAN — read chain 8470 and answer whether the incoming
 * registry can be FUNDED into a working validator set, before anyone tries.
 *
 * This is step 2 of the c18 remediation, made checkable. c18 replaced an
 * impossible fix with "deploy a fresh registry → stake the live validators into
 * it → re-run the preflight", and probing found step 2 is not free either:
 *
 *   - the stake already posted is TRAPPED (unstake() reverts StillSeated() and
 *     every live validator is seated),
 *   - mint() belongs to TinyIssuance since P3 and reverts for every key we hold,
 *   - and some live validators hold ZERO free balance, so stake() would revert
 *     inside transferFrom with "stake transfer failed" — a message that names the
 *     symptom and hides all of the above.
 *
 * So this computes the transfers and stakes explicitly, checks BOTH moments that
 * have a seat set (the transition, which uses the constructor argument, and the
 * first rotate(), which uses the eligible candidates), and refuses when the money
 * genuinely is not there.
 *
 * ⚠️ c22: the chain reading lives in lib/read-migration-state.mjs so that this
 * report and fund-migration.mjs (which SENDS the transactions) cannot drift apart.
 * A reviewed plan and an executed plan computed by two copies of the same logic are
 * two plans that merely agree today.
 *
 * READ-ONLY. Makes no transaction, writes no file, and refuses any RPC that is not
 * chain 8470 (the LIVE chain is 8469).
 *
 * Usage:
 *   node chain/multinode/scripts/stake-migration-plan.mjs [--incoming 0x…]
 *
 * Exit 0 = a funding plan exists, printed as ordered steps. Exit 1 = REFUSE.
 */
import { planStakeMigration } from '../stake-migration-plan.mjs'
import { readMigrationState, RPC } from './lib/read-migration-state.mjs'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main() {
  const st = await readMigrationState({ incoming: arg('incoming') })
  const { validators, keys, minStake, minValidators, maxValidators } = st

  const plan = planStakeMigration({
    validators,
    minStakeMicro: minStake,
    minValidators: Number(minValidators),
    maxValidators: Number(maxValidators),
  })

  console.log(`chain ${st.chainId}  head #${st.head}  evidence window ${st.window} block(s)`)
  console.log(`outgoing ${st.outgoing}`)
  console.log(`incoming ${st.incomingRaw || '(none recorded — pass --incoming, or deploy one first)'}`)
  console.log(`minStake ${Number(minStake) / 1e6}  floor ${minValidators}  cap ${maxValidators}  (read from ${st.paramSource === st.outgoing ? 'the OUTGOING registry — no incoming to read' : 'the incoming registry'})`)
  console.log(`\nthe ${validators.length} address(es) seated at birth, from ${st.bornFrom}:`)
  for (const v of validators) {
    console.log(
      `   ${v.address}  ${v.live ? '🟢 proposing' : '⚫️ silent  '}  key ${v.hasKey ? `✓ ${keys.get(v.address).path}` : '✗ NONE'}  free ${Number(v.freeMicro) / 1e6}  staked-in ${Number(v.alreadyStakedMicro) / 1e6}  trapped ${Number(v.stakedOutgoingMicro) / 1e6}  gas ${v.nativeWei > 0n ? '✓' : '✗ ZERO'}`,
    )
  }
  console.log(`\nat the transition: ${plan.atTransition.seats} seats, quorum ${plan.atTransition.quorum}, live ${plan.atTransition.live}`)
  console.log(`after first rotate(): ${plan.afterRotation.seats} seats, quorum ${plan.afterRotation.quorum}, live ${plan.afterRotation.live} (eligible ${plan.afterRotation.eligible})`)

  console.log(`\n${plan.ok ? '✅ a funding plan exists' : '🛑 REFUSE'}`)
  for (const b of plan.blockers) console.log(`   🛑 ${b}`)
  for (const w of plan.warnings) console.log(`   ⚠️  ${w}`)
  for (const s of plan.steps) console.log(`   → ${s}`)

  if (!plan.ok) {
    console.log('\nDo NOT deploy or swap on this basis. The blockers above are facts about balances, not about code.')
    process.exit(1)
  }
  console.log(`\nExecute it with:\n  node chain/multinode/scripts/fund-migration.mjs${st.incomingRaw ? ` --incoming ${st.incomingRaw}` : ''} --dry-run\nthen drop --dry-run. After that, swap-preflight.mjs --incoming <new> must exit 0 before the genesis is touched.`)
}

main().catch((err) => {
  console.error('plan failed:', err?.shortMessage || err?.message || err)
  process.exit(1)
})
