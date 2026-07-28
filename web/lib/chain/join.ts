/**
 * 🚪 THE JOIN DOCUMENT — everything a stranger needs to run a node on the
 * multi-node tiny chain, assembled from public facts only.
 *
 * WHY THIS EXISTS. The P5 acceptance suite asserts that "the published artifacts
 * are sufficient" by checking that `chain/multinode/genesis-8470.json` exists in
 * the repo. That assertion is true and the conclusion it implies is false: THIS
 * REPO IS PRIVATE. A stranger cannot read the file, so the one input the p2p
 * handshake absolutely requires — the genesis — was reachable only by the people
 * who already run the chain. "Anyone can sync" was, in practice, "anyone with a
 * clone can sync". This module is what makes the word published mean published.
 *
 * Everything here is PURE and takes its inputs as arguments — genesis object,
 * bootnode string, the deployment's own chain config. The route wires env in.
 * That is deliberate: the interesting behaviour is all refusal, and refusals are
 * only worth having if they can be tested without a chain, a node or a network.
 *
 * TWO REFUSALS CARRY THE MODULE:
 *
 *  1. NO LOOPBACK BOOTNODE IS EVER SERVED. `bootnodes-8470.txt` today holds one
 *     enode at 127.0.0.1 — correct for a local devnet, actively harmful in a
 *     public document: a stranger's node would dial THEIR OWN machine, find
 *     nothing, and read it as "the tiny chain is down" or, worse, as their own
 *     firewall. An empty list plus a sentence saying why is strictly better than
 *     an address that cannot work, because only one of those two states is
 *     debuggable by the person hitting it.
 *
 *  2. NO CONTRACT ADDRESS FROM A DIFFERENT CHAIN. `TINY_CHAIN_USDC_ADDRESS` is
 *     the USDC of whatever chain THIS deployment settles on. Production settles
 *     on 8469; the genesis we publish is 8470. Copying that env value into an
 *     8470 join document would hand a joiner an address with no code on the
 *     chain they just synced — the exact silent-empty failure c9 found on the
 *     explorer (eth_getCode → '0x', no error anywhere). So the asset is included
 *     only when the deployment's chain id EQUALS the published genesis's, and
 *     otherwise omitted with both numbers named.
 *
 * Neither refusal degrades the document into uselessness: a joiner can still
 * boot from the genesis and pass a peer enode they obtained anywhere.
 */

/**
 * enode://<128 hex chars>@host:port — the id is a 64-byte secp256k1 pubkey.
 *
 * The host alternation carries IPv6 first, in brackets: an unbracketed `::1`
 * cannot be parsed at all (the colons are the port separator), so besu's own
 * form is `[::1]:30303`. A host pattern of `[^:/?#]+` silently classifies every
 * IPv6 bootnode as MALFORMED, which withholds a working peer and reports the
 * wrong reason for it.
 */
const ENODE = /^enode:\/\/([0-9a-fA-F]{128})@(\[[0-9a-fA-F:.]+\]|[^:/?#[\]]+):(\d{1,5})(\?.*)?$/

/**
 * Hosts that are meaningless to a stranger: loopback, link-local, and the RFC1918
 * ranges. A node reachable only inside our LAN is not a bootnode for the public,
 * and 0.0.0.0 is a bind address that was never a destination.
 */
function isUnroutable(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7) are the v6 analogues
  // of 169.254 and RFC1918 — routable on a LAN, undialable from anywhere else.
  if (/^fe[89ab][0-9a-f]?:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 127 || a === 0) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

export type Bootnodes = {
  /** Safe to publish: a stranger can actually dial these. */
  routable: string[]
  /** Present in config but private/loopback — counted, never served. */
  unroutable: string[]
  /** Lines that aren't enodes at all. */
  malformed: string[]
}

/**
 * Split a bootnode list (comma- or newline-separated, `#` comments allowed) into
 * what may be published and what may not.
 *
 * Accepts the same file format `join-tiny-chain.sh` reads, so one env value or
 * one file can feed both without a second parser to disagree with this one.
 */
export function classifyBootnodes(input: string | null | undefined): Bootnodes {
  const out: Bootnodes = { routable: [], unroutable: [], malformed: [] }
  // ⚠️ ORDER MATTERS, and getting it wrong was a live defect (c27). This used to
  // be `.split(/[\n,]+/)` and only drop lines that STARTED with `#`. Measured on
  // the real `bootnodes-8470.txt` — the actual bytes, which nothing had ever run
  // this function on — that produced FOUR malformed entries out of thin air:
  // splitting on commas first shreds the file's own explanatory prose ("…, and it
  // has no authority over consensus") into fragments that no longer begin with a
  // `#`, so each one arrives here looking like a broken enode. The file holds ONE
  // bootnode; `buildJoinDoc` was therefore publishing "5 configured entries are
  // loopback/private/malformed" to a stranger. A wrong number in the one document
  // an outsider reads is worse than no number: it describes a chain in disrepair.
  //
  // So: comments die per LINE first, and only then do commas split. The same pass
  // fixes INLINE comments — `<enode> # frankfurt` is the shape the file's own
  // header invites, and it used to land in `malformed`, silently withholding a
  // working peer.
  //
  // ⚠️ `\r` is in the split class deliberately. JS treats CR as a line terminator,
  // so `.` does NOT match it and `/#.*$/` fails outright on `"# fra\r"` — a CRLF
  // file (a joiner on Windows, or anything that round-tripped through Notepad)
  // had every annotated enode classified malformed. Splitting first strips it.
  //
  // This pipeline must stay equivalent to the one in join-tiny-chain.sh; the
  // differential tests in tests/chain-join.test.ts run BOTH on the same bytes.
  const lines = String(input || '')
    .split(/[\r\n]+/)
    .map((l) => l.replace(/#.*$/, ''))
    .flatMap((l) => l.split(','))
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  for (const line of lines) {
    const m = ENODE.exec(line)
    if (!m) {
      out.malformed.push(line)
      continue
    }
    const port = Number(m[3])
    if (port < 1 || port > 65535) {
      out.malformed.push(line)
      continue
    }
    ;(isUnroutable(m[2]) ? out.unroutable : out.routable).push(line)
  }
  return out
}

/** The subset of the genesis this module reads. Anything else passes through. */
export type GenesisLike = {
  config?: {
    chainId?: number
    transitions?: { qbft?: { validatorcontractaddress?: string; validatorselectionmode?: string }[] }
  }
}

export type JoinDoc = {
  chain: { id: number; caip2: string; role: string }
  /** Does the chain below is where this deployment's x402 payments settle? */
  payments: { settlesOnThisChain: boolean; deploymentNetwork: string; note: string }
  bootnodes: string[]
  bootnodesNote: string | null
  contracts: { validators: string | null; usdc: string | null; usdcNote: string | null }
  requirements: string[]
  /** Copy-pasteable, in order. `{{genesis}}` is never a placeholder — real URL. */
  steps: string[]
  validating: { permissionless: boolean; steps: string[]; caveats: string[] }
  genesis: unknown
}

export type JoinInputs = {
  genesis: GenesisLike & Record<string, unknown>
  /** Raw bootnode config — env or file contents. */
  bootnodes?: string | null
  /** The chain id this deployment is configured for (null = no chain configured). */
  configuredChainId?: number | null
  /** The deployment's USDC — used ONLY if configuredChainId matches the genesis. */
  configuredUsdc?: string | null
  /** 'tiny' | 'base' | 'base-sepolia' — what paymentsNetwork() returned. */
  deploymentNetwork: string
  /** Absolute base URL of this deployment, for the curl line in `steps`. */
  origin: string
}

/**
 * Assemble the join document.
 *
 * Throws on a genesis with no chain id rather than serving `chain.id: 0`: a join
 * document is a boot instruction, and a wrong one costs the reader a full sync
 * before it fails. There is no useful degraded version of this.
 */
export function buildJoinDoc(input: JoinInputs): JoinDoc {
  const chainId = Number(input.genesis?.config?.chainId || 0)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error('published genesis has no chainId — refusing to serve boot instructions for an unnamed chain')
  }

  const boots = classifyBootnodes(input.bootnodes)
  // The note explains an EMPTY list, and also explains a non-empty one that
  // dropped entries — silently shipping 0 of 1 configured bootnodes is how an
  // operator concludes the endpoint is broken instead of their env value.
  const dropped = boots.unroutable.length + boots.malformed.length
  const bootsNote = boots.routable.length === 0
    ? `No publicly reachable bootnode is published yet${dropped ? ` (${dropped} configured entr${dropped === 1 ? 'y is' : 'ies are'} loopback/private/malformed and cannot help you)` : ''}. `
      + 'A bootnode is only an INTRODUCTION — it has no authority over consensus and cannot decide what your node accepts. '
      + 'Any peer\'s enode works: ask an operator or another node runner, then pass --bootnodes enode://…'
    : dropped
      ? `${dropped} configured entr${dropped === 1 ? 'y was' : 'ies were'} withheld as loopback/private/malformed — they would be undialable from your machine.`
      : null

  // ⚠️ Same-chain check before publishing any address from this deployment's env.
  const sameChain = input.configuredChainId === chainId
  const usdc = sameChain && /^0x[0-9a-fA-F]{40}$/.test(String(input.configuredUsdc || ''))
    ? String(input.configuredUsdc)
    : null
  const usdcNote = usdc
    ? null
    : input.configuredChainId && !sameChain
      ? `Withheld: this deployment is configured for chain ${input.configuredChainId}, not ${chainId}, `
        + `so its TinyUSDC address would have no code on the chain you are joining. Read the stake asset off the `
        + `validator contract or from an operator instead.`
      : 'Not configured on this deployment.'

  const transition = input.genesis?.config?.transitions?.qbft?.[0]
  const validators = typeof transition?.validatorcontractaddress === 'string'
    ? transition.validatorcontractaddress
    : null

  const base = input.origin.replace(/\/$/, '')
  const genesisUrl = `${base}/api/chain/join?format=genesis`

  return {
    chain: {
      id: chainId,
      caip2: `eip155:${chainId}`,
      role: 'the multi-node tiny chain — QBFT, zero-price gas, permissionless validator entry',
    },
    payments: {
      settlesOnThisChain: input.deploymentNetwork === 'tiny' && sameChain,
      deploymentNetwork: input.deploymentNetwork,
      // The mislabelling trap, said out loud. A joiner who assumes their synced
      // chain is where their x402 payments land would look for their money on
      // the wrong ledger and find nothing wrong with either chain.
      note: input.deploymentNetwork === 'tiny' && sameChain
        ? `This deployment settles x402 payments on chain ${chainId} — the chain you are joining.`
        : `⚠️ This deployment settles x402 payments on ${input.deploymentNetwork}`
          + (input.configuredChainId ? ` (chain ${input.configuredChainId})` : '')
          + `, NOT on chain ${chainId}. Joining chain ${chainId} lets you verify and propose blocks there; it does not put you on the payment path.`,
    },
    bootnodes: boots.routable,
    bootnodesNote: bootsNote,
    contracts: { validators, usdc, usdcNote },
    requirements: [
      'Hyperledger Besu 26.7.0 or newer. Not geth, not anvil: this chain runs QBFT, which they cannot follow.',
      'Java 25+ — besu 26.7.0 is class file 69.0, and Java 21 fails with UnsupportedClassVersionError whose first line names neither Java nor a version.',
      'No key, no allowlist entry, no signup, and no action from us. If joining ever needs one of those, the chain has stopped being open.',
    ],
    steps: [
      `curl -fsSL '${genesisUrl}' -o tiny-${chainId}-genesis.json`,
      `besu --genesis-file=tiny-${chainId}-genesis.json --data-path=./tiny-node `
        + `--bootnodes=<enode of any peer> --sync-mode=FULL --data-storage-format=BONSAI `
        + `--min-gas-price=0 --rpc-http-enabled --rpc-http-port=8545 --rpc-http-api=ETH,NET,WEB3,QBFT,TXPOOL`,
      // FULL is the participation claim, not a performance preference: a
      // snap-synced node trusts someone else's state root, while a full node
      // re-executes every block and can therefore contradict us.
      `Confirm you hold OUR chain, not a lookalike: compare eth_getBlockByNumber('0x0').hash against any other node's. `
        + `The p2p handshake enforces it, so a mismatch shows up as "cannot peer", never as a fork.`,
      `If your node peers but never leaves block 0 you are being REFUSED the chain, not merely syncing slowly — `
        + `grep -E 'Invalid block|ValidationRule' in your besu log names the rule that rejected it.`,
    ],
    validating: {
      permissionless: true,
      steps: [
        `Hold at least MIN_STAKE of the chain's TinyUSDC. This is the honest bottleneck: no stake, no seat, and no endpoint can hand you the asset.`,
        `approve(TinyValidators, amount) then stake(amount)${validators ? ` on ${validators}` : ''}.`,
        `Call rotate() yourself at an epoch boundary. Not us — you. If it needed our key the chain would not be open.`,
        `You are seated if you rank in the top MAX_VALIDATORS by stake. Entry is permissionless; SEATS are capped, because QBFT is O(n²) in messages.`,
      ],
      caveats: [
        'Your stake is a DEPOSIT, not a bond. Equivocation is convicted on-chain and permanently, but nothing burns stake yet — TinyValidators has no slashing hook and no admin to add one. Until a registry swap ships, nobody (including us) should call this stake slashable.',
        'unstake() returns it in full after the unbonding period. Leaving works, and that is tested rather than assumed.',
        'Running a full node earns no seat. Syncing and validating are different permissions, and only the second one needs stake.',
      ],
    },
    genesis: input.genesis,
  }
}
