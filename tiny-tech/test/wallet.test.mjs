/**
 * 💧 The daemon's money copy — what an AGENT is told about funding a wallet.
 *
 * The other three clients render a button, so a wrong on-ramp there is a dead
 * link. Here the consumer is a language model that will act on the sentence, and
 * fill any silence with what it already knows about USDC — which on a chain we
 * own means walking the user to Coinbase to buy a token nobody sells.
 *
 * So the assertions are mostly ABSENCE assertions: on the faucet route no
 * external rail may be named, and the prohibition must be explicit rather than
 * implied by omission. Plus the two refusals stay two different instructions,
 * because an agent that merges them will loop a permanently-capped user back to
 * the same call every day.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  WALLET_NETWORKS, asNetwork, isTrialNetwork, fundsPhrase, usdShort, untilNextDrip,
  topUpRoute, topUpAdvice, faucetOutcome,
} = await import('../dist/wallet.js')

const faucet = (over = {}) => ({
  available: true,
  network: 'tiny',
  drip_micro: 1_000_000,
  cap_micro: 5_000_000,
  granted_micro: 2_000_000,
  remaining_micro: 3_000_000,
  claimed_today: false,
  next_drip_in_seconds: 0,
  reputation: 4,
  micro_per_point: 200_000,
  max_micro: 25_000_000,
  ...over,
})

const tinyInfo = (over = {}) => ({
  default_network: 'tiny',
  deposit_address: '0x' + 'ab'.repeat(20),
  configured: true,
  faucet: faucet(),
  ...over,
})

// ── routing ───────────────────────────────────────────────────────────────

test('route: the server flag decides, not the network name', () => {
  assert.equal(topUpRoute(tinyInfo()), 'faucet')
  // A half-configured tiny deployment (no deployer key / no mintable token)
  // reports `tiny` with no faucet — a claim call there 424s every time.
  assert.equal(topUpRoute(tinyInfo({ faucet: { available: false } })), 'fiat')
  // …and the reverse disagreement: a faucet on a chain we didn't hard-code.
  assert.equal(topUpRoute({ default_network: 'base-sepolia', faucet: faucet() }), 'faucet')
  assert.equal(topUpRoute({ default_network: 'some-future-l2', faucet: faucet() }), 'faucet')
  assert.equal(topUpRoute({ default_network: 'base-sepolia' }), 'testnet')
  assert.equal(topUpRoute({ default_network: 'base' }), 'fiat')
  assert.equal(topUpRoute(null), 'fiat')
})

test('networks: unknown reads as REAL money, and the enum admits our own chain', () => {
  // Guessing "trial" for an unknown name would have an agent describe real,
  // withdrawable money as play credit.
  assert.equal(asNetwork('moonbeam'), 'base')
  assert.equal(asNetwork(undefined), 'base')
  assert.equal(asNetwork(' TINY '), 'tiny')
  assert.equal(asNetwork('Base-Sepolia'), 'base-sepolia')
  assert.equal(isTrialNetwork('tiny'), true)
  assert.equal(isTrialNetwork('base-sepolia'), true)
  assert.equal(isTrialNetwork('base'), false)
  // The bug the schema enforced: `tiny` missing here made the documented flow
  // (deposit_info says 'tiny' → claim on 'tiny') impossible to express.
  assert.deepEqual(WALLET_NETWORKS, ['base', 'base-sepolia', 'tiny'])
})

test('both trial networks say so, out loud', () => {
  for (const n of ['tiny', 'base-sepolia']) {
    assert.match(fundsPhrase(n), /not withdrawable as real USDC/)
  }
  assert.equal(fundsPhrase('base'), 'real USDC on Base')
})

// ── the sentence an agent acts on ─────────────────────────────────────────

test('faucet route names NO external rail and forbids inventing one', () => {
  const a = topUpAdvice(tinyInfo())
  assert.match(a, /action 'faucet'/)
  assert.match(a, /one claim per UTC day \(\$1\)/)
  assert.match(a, /\$3 left/, 'the remaining ceiling is the figure that explains both states')
  // The whole point of the cycle.
  assert.doesNotMatch(a, /coinbase/i)
  assert.doesNotMatch(a, /bridge\.base\.org/i)
  assert.doesNotMatch(a, /faucet\.circle\.com/i)
  assert.doesNotMatch(a, /moonpay/i)
  // Omission is not enough — a model fills the gap from its own USDC priors.
  assert.match(a, /NEVER tell the user to buy, bridge, exchange or faucet USDC anywhere else/)
  assert.match(a, /cannot be credited/)
  assert.match(a, /reputation/, 'the ceiling grows — say how')
})

test('faucet route never mentions claiming a tx hash', () => {
  // There is no on-chain deposit path for a user here: the token is unbuyable, so
  // "send it to the deposit address" is an instruction that cannot be followed.
  const a = topUpAdvice(tinyInfo())
  assert.doesNotMatch(a, /txHash/)
  assert.doesNotMatch(a, /action 'claim'/)
})

test('sepolia route sends them to the public faucet and forbids real USDC', () => {
  const a = topUpAdvice({ default_network: 'base-sepolia', deposit_address: '0xdead' })
  assert.match(a, /faucet\.circle\.com/)
  assert.match(a, /0xdead/)
  assert.match(a, /Do NOT tell the user to buy real USDC/)
  assert.match(a, /base-sepolia/)
})

test('mainnet route keeps the real rails — a faucet there would be nonsense', () => {
  const a = topUpAdvice({ default_network: 'base', deposit_address: '0xbeef' })
  assert.match(a, /buy or bridge USDC on Base/)
  assert.match(a, /real USDC on Base/)
  assert.doesNotMatch(a, /faucet/i)
  assert.match(a, /withdraw self-serve/)
})

test('the three routes are mutually exclusive in what they instruct', () => {
  const cases = [tinyInfo(), { default_network: 'base-sepolia' }, { default_network: 'base' }, null]
  for (const info of cases) {
    const a = topUpAdvice(info)
    const buys = /buy or bridge|faucet\.circle\.com/.test(a)
    const drips = /action 'faucet'/.test(a)
    assert.notEqual(buys, drips, `route for ${JSON.stringify(info)} offered both or neither`)
  }
})

test('a missing deposit address degrades to a pointer, not to "undefined"', () => {
  for (const net of ['base', 'base-sepolia']) {
    const a = topUpAdvice({ default_network: net })
    assert.doesNotMatch(a, /undefined|null/)
    assert.match(a, /the deposit address from deposit_info/)
  }
})

// ── the claim reply ───────────────────────────────────────────────────────

test('a credited drip says what the credit is NOT', () => {
  const o = faucetOutcome({ ok: true, credited_micro: 1_000_000, reserve_backed: true }, 200)
  assert.equal(o.ok, true)
  assert.equal(o.kind, 'credited')
  assert.match(o.message, /Credited \$1/)
  assert.match(o.message, /NOT withdrawable as real USDC/)
  assert.match(o.message, /Backed 1:1/)
})

test('credit without a reserve mint is still credit', () => {
  // The mint is best-effort by design; reporting it as a failure would send an
  // agent to re-claim an allowance that is already spent for the day.
  const o = faucetOutcome({ ok: true, credited_micro: 300_000 }, 200)
  assert.equal(o.ok, true)
  assert.match(o.message, /Credited \$0\.3/)
  assert.match(o.message, /credit is real and spendable regardless/)
})

test('the two refusals stay OPPOSITE instructions', () => {
  const capped = faucetOutcome({ ok: false, ceiling_reached: true, error: 'trial ceiling reached ($5 lifetime)' }, 400)
  const daily = faucetOutcome({ ok: false, already_claimed: true, error: "already claimed today's credit", next_drip_in_seconds: 7_500 }, 429)
  assert.equal(capped.kind, 'ceiling_reached')
  assert.equal(daily.kind, 'already_claimed')
  assert.match(capped.message, /waiting will not help/)
  assert.match(capped.message, /followed raises the ceiling/)
  assert.doesNotMatch(capped.message, /midnight|next drip/i, "tomorrow's drip is refused too")
  assert.match(daily.message, /in 2h 5m/)
  assert.doesNotMatch(daily.message, /followed/, 'waiting is the fix today, not reputation')
  assert.notEqual(capped.message, daily.message)
})

test('capped AND claimed today is CAPPED', () => {
  const o = faucetOutcome({ ok: false, ceiling_reached: true, already_claimed: true, error: 'cap' }, 400)
  assert.equal(o.kind, 'ceiling_reached')
})

test('a flagless 429 is still a daily refusal, and says when', () => {
  // A proxy that stripped the body's flags still leaves the status.
  const o = faucetOutcome({ ok: false, error: 'slow down' }, 429)
  assert.equal(o.kind, 'already_claimed')
  assert.match(o.message, /after midnight UTC/)
  assert.doesNotMatch(o.message, /in 0m/)
})

test('the 424 no-faucet-here case is classified, not retold as a failure', () => {
  // This is the case `post()` could not distinguish: the route answers a bare 424
  // with no flag, so a status-blind caller says "faucet failed" and an agent
  // retries a deployment that will never have one.
  const o = faucetOutcome({ ok: false, error: 'the in-house faucet needs a tiny-chain deployment' }, 424)
  assert.equal(o.kind, 'unavailable')
  assert.match(o.message, /do not invent an on-ramp/)
})

test("the server's own sentence survives every refusal", () => {
  const msg = 'trial ceiling reached ($25 lifetime) — get followed to earn more room'
  for (const [body, status] of [
    [{ ok: false, ceiling_reached: true, error: msg }, 400],
    [{ ok: false, already_claimed: true, error: msg }, 429],
    [{ ok: false, error: msg }, 424],
    [{ ok: false, error: msg }, 500],
  ]) {
    assert.ok(faucetOutcome(body, status).message.includes(msg), `status ${status} dropped the server's wording`)
  }
})

test('no body at all is a transport failure, not a refusal', () => {
  assert.deepEqual(faucetOutcome(null, 502), { ok: false, kind: 'failed', message: "couldn't reach the faucet" })
  assert.equal(faucetOutcome({ ok: false }, 500).message, 'faucet failed')
  assert.equal(faucetOutcome({ ok: false, error: '   ' }, 500).message, 'faucet failed')
})

// ── formatting ────────────────────────────────────────────────────────────

test('amounts read like a sentence, and junk reads as zero', () => {
  assert.equal(usdShort(1_000_000), '$1')
  assert.equal(usdShort(1_200_000), '$1.2')
  assert.equal(usdShort(25_000), '$0.025')
  assert.equal(usdShort(0), '$0')
  assert.equal(usdShort(undefined), '$0')
  assert.equal(usdShort('nonsense'), '$0')
  assert.equal(usdShort(Infinity), '$0', 'an infinite balance is a bug, not a fortune')
})

test('waits read like time', () => {
  assert.equal(untilNextDrip(7_500), '2h 5m')
  assert.equal(untilNextDrip(7_200), '2h')
  assert.equal(untilNextDrip(300), '5m')
  assert.equal(untilNextDrip(20), '1m')
  assert.equal(untilNextDrip(0), '')
  assert.equal(untilNextDrip(-5), '')
  assert.equal(untilNextDrip('x'), '')
})
