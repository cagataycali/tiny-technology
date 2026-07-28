/**
 * 🧾 tiny-chain explorer — WHAT A TRANSACTION ACTUALLY SAID.
 *
 * The /chain pages could show a hash, a status, and the Transfer events a tx
 * emitted, but not what was *asked for*: `input` rendered as 714 characters of
 * hex is not an explanation. This module is the pure decoder for both halves:
 *
 *   INPUT  — the function call: selector → name + named, typed arguments.
 *   OUTPUT — what the chain emitted back: the TinyUSDC events in the receipt.
 *
 * ⚠️ "Output" deliberately does NOT mean a return value. A mined transaction has
 * no retrievable return data — `eth_getTransactionReceipt` carries status, gas,
 * and logs, and nothing else. Anyone who adds a "returned" row here will be
 * inventing it. Events ARE the output of an ERC-20 call, and they are signed by
 * consensus rather than by our guess.
 *
 * 🔒 THE DECODER REFUSES RATHER THAN GUESSES. This is the page whose entire job
 * is on-chain truth, so a decode that half-works is worse than none: a wrong
 * word offset renders an amount or a counterparty that never existed, in the
 * one place a person goes to check exactly that. Every unknown selector, short
 * calldata, or malformed dynamic tail comes back `null` and the page shows the
 * raw hex it can't explain.
 *
 * Keyed on SELECTOR, never on name: TinyUSDC ships TWO
 * `transferWithAuthorization` overloads (the 7-arg `bytes signature` form the
 * facilitator uses, `0xcf092995`, and the 9-arg split-`v,r,s` form,
 * `0xe3ee160e`). They decode differently and a name-keyed table would silently
 * pick one. Selectors and topics below were computed from
 * `chain/artifacts/TinyUSDC.sol/TinyUSDC.json` — the same artifact both chains
 * deploy — and the two settlement shapes were verified against real mined
 * transactions on the live chain, not written from the ABI alone.
 */

/** One decoded argument, with the type information the UI needs to format it. */
export type ArgKind = 'address' | 'uint256' | 'micro' | 'timestamp' | 'bytes32' | 'bytes'

export type DecodedArg = {
  name: string
  kind: ArgKind
  /** Canonical text value: 0x-lowercased for hex kinds, decimal for integers. */
  value: string
}

export type DecodedCall = {
  selector: string
  /** Solidity function name — the overloads share this, hence `selector` too. */
  name: string
  /** One line of plain English: what this call does, for a non-developer. */
  summary: string
  args: DecodedArg[]
}

type ParamSpec = { name: string; kind: ArgKind }

type FnSpec = { name: string; summary: string; params: ParamSpec[] }

/**
 * Selector → shape. `micro` marks a TinyUSDC amount (6 decimals) so the UI can
 * show dollars beside the integer; `timestamp` marks unix seconds. Getting one
 * of these labels wrong misreads a number rather than losing it, which is why
 * they're declared next to the signature they came from.
 */
export const FUNCTIONS: Record<string, FnSpec> = {
  // transfer(address,uint256)
  '0xa9059cbb': {
    name: 'transfer',
    summary: 'Moved TinyUSDC from the sender to a recipient.',
    params: [
      { name: 'to', kind: 'address' },
      { name: 'value', kind: 'micro' },
    ],
  },
  // transferFrom(address,address,uint256)
  '0x23b872dd': {
    name: 'transferFrom',
    summary: 'Moved TinyUSDC on the owner’s behalf, using an allowance.',
    params: [
      { name: 'from', kind: 'address' },
      { name: 'to', kind: 'address' },
      { name: 'value', kind: 'micro' },
    ],
  },
  // approve(address,uint256)
  '0x095ea7b3': {
    name: 'approve',
    summary: 'Allowed another address to spend TinyUSDC on the sender’s behalf.',
    params: [
      { name: 'spender', kind: 'address' },
      { name: 'value', kind: 'micro' },
    ],
  },
  // mint(address,uint256) — owner-only; on 8470 the owner is TinyIssuance.
  '0x40c10f19': {
    name: 'mint',
    summary: 'Created new TinyUSDC. Only the token’s owner can do this.',
    params: [
      { name: 'to', kind: 'address' },
      { name: 'value', kind: 'micro' },
    ],
  },
  // transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)
  // The EIP-3009 form the x402 facilitator submits: the PAYER signed it offline
  // and the relayer paid the gas, which is why `from` is not the tx sender.
  '0xcf092995': {
    name: 'transferWithAuthorization',
    summary:
      'Settled a signed payment (EIP-3009): the payer authorized this transfer offline and someone else submitted it.',
    params: [
      { name: 'from', kind: 'address' },
      { name: 'to', kind: 'address' },
      { name: 'value', kind: 'micro' },
      { name: 'validAfter', kind: 'timestamp' },
      { name: 'validBefore', kind: 'timestamp' },
      { name: 'nonce', kind: 'bytes32' },
      { name: 'signature', kind: 'bytes' },
    ],
  },
  // transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
  '0xe3ee160e': {
    name: 'transferWithAuthorization',
    summary:
      'Settled a signed payment (EIP-3009, split v/r/s signature): the payer authorized this transfer offline.',
    params: [
      { name: 'from', kind: 'address' },
      { name: 'to', kind: 'address' },
      { name: 'value', kind: 'micro' },
      { name: 'validAfter', kind: 'timestamp' },
      { name: 'validBefore', kind: 'timestamp' },
      { name: 'nonce', kind: 'bytes32' },
      { name: 'v', kind: 'uint256' },
      { name: 'r', kind: 'bytes32' },
      { name: 's', kind: 'bytes32' },
    ],
  },
  // cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)
  '0x5a049a70': {
    name: 'cancelAuthorization',
    summary: 'Cancelled a signed payment authorization before anyone settled it.',
    params: [
      { name: 'authorizer', kind: 'address' },
      { name: 'nonce', kind: 'bytes32' },
      { name: 'v', kind: 'uint256' },
      { name: 'r', kind: 'bytes32' },
      { name: 's', kind: 'bytes32' },
    ],
  },
  // transferOwnership(address) — on 8470 this is the tx that made issuance a rule.
  '0xf2fde38b': {
    name: 'transferOwnership',
    summary: 'Handed the token’s minting authority to another address.',
    // `next`, not `newOwner` — the ABI cross-check below caught this on its
    // first run. The UI prints these names as labels, so the plausible guess
    // would have been a wrong explanation of a correct decode.
    params: [{ name: 'next', kind: 'address' }],
  },

  // ── PARTICIPATION (chain/multinode/contracts) ───────────────────────────────
  // These are the calls by which a stranger joins the network, and on a chain
  // whose whole premise is that anyone can, they are the transactions most worth
  // explaining. Found by decoding the live 8470 devnet: 61 of its transactions
  // were "not decoded" and every one was a stake / unstake / reward claim — the
  // participation history was the part the explorer couldn't read.
  //
  // Selectors computed from chain/multinode/artifacts/*, asserted against those
  // artifacts in tests/chain-calldata.test.ts. Amounts here are the STAKE asset,
  // which is TinyUSDC — hence `micro`, same 6 decimals.

  // TinyValidators.stake(uint256)
  '0xa694fc3a': {
    name: 'stake',
    summary: 'Posted stake to become eligible as a validator — this is how anyone joins block production.',
    params: [{ name: 'amount', kind: 'micro' }],
  },
  // TinyValidators.unstake(uint256)
  '0x2e17de78': {
    name: 'unstake',
    summary: 'Withdrew stake. Stake is returned after exiting the validator set — leaving is not a forfeiture.',
    params: [{ name: 'amount', kind: 'micro' }],
  },
  // TinyIssuance.claimValidatorReward(uint256,address)
  '0xab0aec63': {
    name: 'claimValidatorReward',
    summary: 'Claimed validate-to-earn issuance for a finished epoch. Anyone may claim on a validator’s behalf.',
    params: [
      { name: 'epoch', kind: 'uint256' },
      { name: 'validator', kind: 'address' },
    ],
  },
  // TinyServeRewards.claimServeReward(address,uint256,uint256,uint256,uint256,bytes[])
  // ⚠️ NOT modelled: the trailing `bytes[] sigs`. A dynamic ARRAY of dynamic
  // bytes is a second level of indirection this decoder doesn't walk, and the
  // five static words before it are the ones that explain the claim. Declaring
  // fewer params than the ABI has is safe — decoding stops after `epochTotal`,
  // and the leading-words layout is fixed regardless of what follows. The ABI
  // cross-check below is therefore length-aware rather than length-equal, and
  // says so.
  '0x6b055035': {
    name: 'claimServeReward',
    summary:
      'Claimed serve-to-earn issuance for a finished epoch, against signed attestations of work served (this part is oracle-attested, not chain-proven).',
    params: [
      { name: 'server', kind: 'address' },
      { name: 'epoch', kind: 'uint256' },
      { name: 'requestCount', kind: 'uint256' },
      { name: 'volumeMicro', kind: 'micro' },
      { name: 'epochTotalVolumeMicro', kind: 'micro' },
    ],
  },
  // TinyValidators.requestExit() / cancelExit() / rotate() and
  // TinyIssuance.creditBlock() take no arguments — the name and the summary ARE
  // the whole explanation, which is exactly what an explorer should say.
  '0x7f8e3b4e': {
    name: 'requestExit',
    summary: 'Asked to leave the validator set at the next epoch boundary.',
    params: [],
  },
  '0xfdf364e4': {
    name: 'cancelExit',
    summary: 'Withdrew a pending exit request and stayed in the validator set.',
    params: [],
  },
  '0xd992818d': {
    name: 'rotate',
    summary: 'Recomputed the validator set from stake at an epoch boundary. Permissionless — anyone may call it.',
    params: [],
  },
  '0xf00541e0': {
    name: 'creditBlock',
    summary:
      'Credited the current block to its proposer for validate-to-earn. Permissionless and safe because the caller cannot choose the beneficiary — consensus wrote it.',
    params: [],
  },
  // TinySlashing.submitEquivocation(uint256,bytes,bytes,bytes,bytes)
  // The court. Four dynamic `bytes` tails, all walked: this is the transaction a
  // reader is most likely to want to check for themselves, and "not decoded" on
  // the page that records a conviction would be the worst place to be silent.
  '0x906a494b': {
    name: 'submitEquivocation',
    summary:
      'Submitted proof that a validator signed two conflicting blocks at the same height. Permissionless, and unrewarded on purpose — a bounty for convictions is a bounty for entrapment.',
    params: [
      { name: 'height', kind: 'uint256' },
      { name: 'canonicalHeader', kind: 'bytes' },
      { name: 'canonicalSeal', kind: 'bytes' },
      { name: 'conflictingHeader', kind: 'bytes' },
      { name: 'conflictingSeal', kind: 'bytes' },
    ],
  },
  // TinyIssuance.setServeDistributor(address)
  '0x4501fe6d': {
    name: 'setServeDistributor',
    summary:
      'Named the contract allowed to mint serve-to-earn rewards. Settable once, then locked — after that no one can redirect issuance.',
    params: [{ name: 'distributor', kind: 'address' }],
  },
  // ⚠️ KNOWN GAP, deliberately left undecoded: TinyServeRewards.setAttestors(
  // address[],uint256,bytes[]). Both dynamic ARRAYS, a second indirection this
  // decoder doesn't walk (see claimServeReward). Its words could be read
  // partially, but a partial attestor-set change is the one thing worth being
  // exact about, so the page shows raw data and says it wasn't decoded.
}

const WORD = 64 // one 32-byte ABI word, in hex characters

/** Strict hex-body reader: `null` for anything that isn't 0x + even hex. */
const hexBody = (input: unknown): string | null => {
  const s = String(input ?? '')
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) return null
  return s.slice(2).toLowerCase()
}

/** The nth 32-byte word of the argument area, or null if it isn't there. */
const word = (body: string, index: number): string | null => {
  const start = 8 + index * WORD
  return body.length >= start + WORD ? body.slice(start, start + WORD) : null
}

/** A word holding a left-padded address → 0x-address. Null if the pad is dirty:
 *  nonzero high bytes mean this word is not an address, and rendering it as one
 *  would silently truncate a different value into a plausible counterparty. */
const addressFromWord = (w: string): string | null =>
  /^0{24}[0-9a-f]{40}$/.test(w) ? `0x${w.slice(24)}` : null

const uintFromWord = (w: string): string => BigInt(`0x${w}`).toString(10)

/**
 * Decode a dynamic `bytes` parameter given its head word (an offset, measured
 * from the start of the argument area). Returns the 0x payload.
 *
 * Refuses on: an offset past the end, a length that overruns the calldata, or a
 * non-word-aligned offset. A dynamic tail is the one place a decoder can be led
 * out of bounds by the transaction it's describing.
 */
const bytesFromHead = (body: string, head: string): string | null => {
  const offsetBytes = BigInt(`0x${head}`)
  if (offsetBytes > BigInt(1_000_000)) return null // no legitimate calldata is this large
  const offset = Number(offsetBytes)
  if (offset % 32 !== 0) return null
  const lenStart = 8 + offset * 2
  if (body.length < lenStart + WORD) return null
  const len = Number(BigInt(`0x${body.slice(lenStart, lenStart + WORD)}`))
  if (!Number.isSafeInteger(len) || len > 100_000) return null
  const dataStart = lenStart + WORD
  if (body.length < dataStart + len * 2) return null
  return `0x${body.slice(dataStart, dataStart + len * 2)}`
}

/**
 * Decode a transaction's `input`. Null when it can't be explained: no calldata
 * (a plain ETH send), an unknown selector, or arguments that don't fit.
 *
 * Length is checked as a MINIMUM, matching the EVM: solidity ignores trailing
 * calldata, so a padded-but-valid transaction really did execute with these
 * arguments and refusing it would hide a settlement that happened. Too SHORT is
 * always refused — those words simply aren't there to read.
 */
export function decodeCalldata(input: unknown): DecodedCall | null {
  const body = hexBody(input)
  if (body === null || body.length < 8) return null
  const selector = `0x${body.slice(0, 8)}`
  const spec = FUNCTIONS[selector]
  if (!spec) return null

  const args: DecodedArg[] = []
  for (let i = 0; i < spec.params.length; i++) {
    const p = spec.params[i]
    const w = word(body, i)
    if (w === null) return null // short calldata — refuse the whole decode
    if (p.kind === 'address') {
      const a = addressFromWord(w)
      if (a === null) return null
      args.push({ name: p.name, kind: p.kind, value: a })
    } else if (p.kind === 'bytes32') {
      args.push({ name: p.name, kind: p.kind, value: `0x${w}` })
    } else if (p.kind === 'bytes') {
      const b = bytesFromHead(body, w)
      if (b === null) return null
      args.push({ name: p.name, kind: p.kind, value: b })
    } else {
      args.push({ name: p.name, kind: p.kind, value: uintFromWord(w) })
    }
  }
  return { selector, name: spec.name, summary: spec.summary, args }
}

/**
 * The event side. Topics were computed from the same artifact; each entry says
 * how many arguments are INDEXED, because that decides where the values live.
 *
 * ⚠️ `AuthorizationUsed` and `AuthorizationCanceled` have BOTH arguments
 * indexed, so their `data` is `0x` and they carry NO amount. A decoder that
 * expected a value in `data` there would read `0x` as zero and render a $0.00
 * settlement. The amount for a settlement lives in the paired Transfer event.
 */
export const EVENTS: Record<string, { name: string; summary: string; topicArgs: ParamSpec[]; dataArgs: ParamSpec[] }> = {
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': {
    name: 'Transfer',
    summary: 'TinyUSDC moved.',
    topicArgs: [
      { name: 'from', kind: 'address' },
      { name: 'to', kind: 'address' },
    ],
    dataArgs: [{ name: 'value', kind: 'micro' }],
  },
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': {
    name: 'Approval',
    summary: 'A spending allowance was set.',
    topicArgs: [
      { name: 'owner', kind: 'address' },
      { name: 'spender', kind: 'address' },
    ],
    dataArgs: [{ name: 'value', kind: 'micro' }],
  },
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5': {
    name: 'AuthorizationUsed',
    summary: 'A signed payment authorization was consumed — it can never be replayed.',
    topicArgs: [
      { name: 'authorizer', kind: 'address' },
      { name: 'nonce', kind: 'bytes32' },
    ],
    dataArgs: [],
  },
  '0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81': {
    name: 'AuthorizationCanceled',
    summary: 'A signed payment authorization was cancelled before use.',
    topicArgs: [
      { name: 'authorizer', kind: 'address' },
      { name: 'nonce', kind: 'bytes32' },
    ],
    dataArgs: [],
  },

  // ── PARTICIPATION EVENTS (chain/multinode/contracts) ────────────────────────
  // Topics computed from chain/multinode/artifacts/*, asserted there in tests.
  // ⚠️ ARGUMENT NAMES AND ORDER BELOW ARE COPIED FROM THE ARTIFACTS, NOT GUESSED.
  // The cross-check in tests/chain-calldata.test.ts caught three wrong names
  // (`account` for `validator`) and — worse — two wrong ORDERS on its first run:
  // both reward events put `amount` FIRST, where I had written it last. That
  // would have rendered a payout as a request count and a request count as
  // dollars, on the page whose job is to say what was paid. Read the ABI.

  // Staked(address,uint256,uint256) — 1 indexed
  '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90': {
    name: 'Staked',
    summary: 'Stake was posted.',
    topicArgs: [{ name: 'validator', kind: 'address' }],
    dataArgs: [
      { name: 'amount', kind: 'micro' },
      { name: 'total', kind: 'micro' },
    ],
  },
  // Unstaked(address,uint256,uint256) — 1 indexed
  '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e': {
    name: 'Unstaked',
    summary: 'Stake was withdrawn and returned.',
    topicArgs: [{ name: 'validator', kind: 'address' }],
    dataArgs: [
      { name: 'amount', kind: 'micro' },
      { name: 'remaining', kind: 'micro' },
    ],
  },
  // ExitRequested(address) / ExitCancelled(address) — 1 indexed, no data
  '0xcc46cab6fe8ee1d4e3f4459cbdb1a495ebade5f5321a8e6442d81ed5a97522cc': {
    name: 'ExitRequested',
    summary: 'A validator asked to leave at the next epoch boundary.',
    topicArgs: [{ name: 'validator', kind: 'address' }],
    dataArgs: [],
  },
  '0x91c2e943be9b1896a63fd826425c05548b2a5583446fe30c455ed129c89f86a3': {
    name: 'ExitCancelled',
    summary: 'A pending exit was withdrawn.',
    topicArgs: [{ name: 'validator', kind: 'address' }],
    dataArgs: [],
  },
  // Rotated(uint256,uint256) — 1 indexed (epoch), then how many were seated
  '0xce4d090fec9163a095735c2391d4860f82f6abc8a9e3225c1d430fe56f2dff3e': {
    name: 'Rotated',
    summary: 'The validator set was recomputed from stake.',
    topicArgs: [{ name: 'epoch', kind: 'uint256' }],
    dataArgs: [{ name: 'seated', kind: 'uint256' }],
  },
  // BlockCredited(uint256,address,uint256) — 2 indexed. `proposer`, not
  // `validator`: consensus wrote it, which is why crediting needs no trust.
  '0x56f858e6cffad5128dcf868f38bb0f5c653b65899482d7455480076ae7b16c40': {
    name: 'BlockCredited',
    summary: 'A block was credited to the validator that proposed it.',
    topicArgs: [
      { name: 'epoch', kind: 'uint256' },
      { name: 'proposer', kind: 'address' },
    ],
    dataArgs: [{ name: 'blockNumber', kind: 'uint256' }],
  },
  // ValidatorRewardClaimed(uint256,address,uint256,uint256) — 2 indexed
  '0x70dda355409de1640ac632558a2bd94973f5a12e40fd31e4886520f36b522f72': {
    name: 'ValidatorRewardClaimed',
    summary: 'Validate-to-earn issuance was paid out — new TinyUSDC, created by rule.',
    topicArgs: [
      { name: 'epoch', kind: 'uint256' },
      { name: 'validator', kind: 'address' },
    ],
    dataArgs: [
      { name: 'amount', kind: 'micro' },
      { name: 'blocks_', kind: 'uint256' },
    ],
  },
  // ServeRewardClaimed(uint256,address,uint256,uint256,uint256) — 2 indexed
  '0x45eb2223833df8582e4a661456177fb73c192886630574a8a798abc46c61ffc1': {
    name: 'ServeRewardClaimed',
    summary: 'Serve-to-earn issuance was paid out against attested work.',
    topicArgs: [
      { name: 'epoch', kind: 'uint256' },
      { name: 'server', kind: 'address' },
    ],
    dataArgs: [
      { name: 'amount', kind: 'micro' },
      { name: 'requestCount', kind: 'uint256' },
      { name: 'volumeMicro', kind: 'micro' },
    ],
  },
  // ServeDistributorSet(address) — 1 indexed, no data. Small event, large
  // meaning: it is the record of issuance being bound to a single minter, which
  // is what makes "no one can redirect issuance" checkable rather than claimed.
  '0xb213eb539d7e707d53a0572acf930275cba2db8ac754914c28256364f161204e': {
    name: 'ServeDistributorSet',
    summary: 'The one contract allowed to mint serve rewards was named — and thereafter locked.',
    topicArgs: [{ name: 'distributor', kind: 'address' }],
    dataArgs: [],
  },
  // ⚠️ KNOWN GAP, matching setAttestors above: AttestorSetChanged(address[],
  // uint256,uint256) leads with a dynamic array in `data`, so its threshold and
  // nonce are not at fixed word offsets. Naming the event while misreading the
  // threshold would be worse than showing the raw log.

  // ServeRewardMinted(uint256,address,uint256) — 2 indexed
  '0x53b9482dc2314b3a839f2c606e0c983e9c9459fd56910a7059a0c018f93fa52e': {
    name: 'ServeRewardMinted',
    summary: 'The issuance contract minted a serve reward.',
    topicArgs: [
      { name: 'epoch', kind: 'uint256' },
      { name: 'server', kind: 'address' },
    ],
    dataArgs: [{ name: 'amount', kind: 'micro' }],
  },
  // Equivocation(address,uint256,uint256,bytes32,bytes32,uint256,address) — 2 indexed
  '0xcd6805dcd379b183528a991f0fc8fc0b0edc68e5cf4304d3dc57a5a6bfa51f4e': {
    name: 'Equivocation',
    summary:
      'A validator was convicted of signing two conflicting blocks at the same height and round. This court records the fault; it burns no stake (see design §3.3).',
    topicArgs: [
      { name: 'validator', kind: 'address' },
      { name: 'height', kind: 'uint256' },
    ],
    dataArgs: [
      { name: 'round', kind: 'uint256' },
      { name: 'canonicalHash', kind: 'bytes32' },
      { name: 'conflictingHash', kind: 'bytes32' },
      // The stake the culprit held when convicted — recorded, NOT burned.
      { name: 'stakeAtConviction', kind: 'micro' },
      { name: 'reporter', kind: 'address' },
    ],
  },
}

export type DecodedEvent = {
  name: string
  summary: string
  args: DecodedArg[]
  /** The contract that emitted it. Shown because the decoder is keyed on topic
   *  alone: an unrelated contract emitting a matching topic would decode as this
   *  event, and the emitter is what lets a reader tell whose event it was. */
  emitter: string
}

/**
 * Decode one receipt log. Null for unknown topics and for logs whose topic
 * count disagrees with the ABI — an indexed-argument miscount shifts every
 * value by one position, which is exactly how a decoder attributes a payment to
 * the wrong address while looking entirely successful.
 */
export function decodeEventLog(log: unknown): DecodedEvent | null {
  const l = log as any
  const topics: unknown[] = Array.isArray(l?.topics) ? l.topics : []
  const topic0 = String(topics[0] ?? '').toLowerCase()
  const spec = EVENTS[topic0]
  if (!spec) return null
  if (topics.length !== spec.topicArgs.length + 1) return null

  const args: DecodedArg[] = []
  for (let i = 0; i < spec.topicArgs.length; i++) {
    const p = spec.topicArgs[i]
    const t = String(topics[i + 1] ?? '').toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(t)) return null
    const w = t.slice(2)
    if (p.kind === 'address') {
      const a = addressFromWord(w)
      if (a === null) return null
      args.push({ name: p.name, kind: p.kind, value: a })
    } else if (p.kind === 'bytes32') {
      args.push({ name: p.name, kind: p.kind, value: t })
    } else {
      args.push({ name: p.name, kind: p.kind, value: uintFromWord(w) })
    }
  }

  const data = hexBody(l?.data)
  if (data === null) return null
  // Non-indexed args are packed in order from the start of `data`. Minimum, not
  // exact: future ABI additions append, and a log we can partly read honestly
  // is better than one dropped entirely.
  if (data.length < spec.dataArgs.length * WORD) return null
  for (let i = 0; i < spec.dataArgs.length; i++) {
    const p = spec.dataArgs[i]
    const w = data.slice(i * WORD, (i + 1) * WORD)
    // Non-indexed args are not all integers: TinySlashing's Equivocation puts
    // two bytes32 digests and the reporter's address in `data`. Decoding those
    // as uint256 would print a 78-digit number where an address belongs.
    if (p.kind === 'address') {
      const a = addressFromWord(w)
      if (a === null) return null
      args.push({ name: p.name, kind: p.kind, value: a })
    } else if (p.kind === 'bytes32') {
      args.push({ name: p.name, kind: p.kind, value: `0x${w}` })
    } else {
      args.push({ name: p.name, kind: p.kind, value: uintFromWord(w) })
    }
  }
  const emitter = String(l?.address ?? '').toLowerCase()
  return {
    name: spec.name,
    summary: spec.summary,
    args,
    emitter: /^0x[0-9a-f]{40}$/.test(emitter) ? emitter : '',
  }
}

/** Decimal micro-USDC string → the clamped number `usdMicro` formats, so huge
 *  values reach the SAME visible clamp the rest of the explorer uses instead of
 *  quietly becoming Infinity. */
export function microToNumber(decimal: string): number | null {
  if (!/^[0-9]+$/.test(decimal)) return null
  const big = BigInt(decimal)
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big)
}

/** Unix seconds (decimal string) → a UTC string, or null when it isn't a
 *  plausible second-precision timestamp. EIP-3009 `validBefore` is often
 *  `uint256` max meaning "no deadline" — that must not render as a date. */
export function timestampLabel(decimal: string): string | null {
  if (!/^[0-9]+$/.test(decimal)) return null
  const big = BigInt(decimal)
  // 0 means "no lower bound" in EIP-3009; above ~year 4000 it's a sentinel.
  if (big === BigInt(0) || big > BigInt(64_060_588_800)) return null
  return new Date(Number(big) * 1000).toUTCString()
}
