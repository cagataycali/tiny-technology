// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { buildJoinDoc, classifyBootnodes } from '@/lib/chain/join'
import genesis from '@/chain/multinode/genesis-8470.json'

/**
 * 🚪 /api/chain/join — the public join document.
 *
 * The gap this closes: P5 asserted "the published artifacts are sufficient" by
 * checking that `chain/multinode/genesis-8470.json` is COMMITTED. It is — to a
 * PRIVATE repo. So the one file the p2p handshake requires was reachable only by
 * people who already run the chain, and the suite was measuring our own clone.
 *
 * These tests hold the two refusals that make the document trustworthy:
 *   • never serve a bootnode a stranger cannot dial,
 *   • never serve a contract address from a different chain than the genesis.
 * Both failure modes are SILENT for us and expensive for the reader, which is
 * exactly the kind that needs a test rather than a review.
 */

const PUB = 'a'.repeat(128)
const PUB2 = 'b'.repeat(128)
const enode = (pub: string, host: string, port = 30303) => `enode://${pub}@${host}:${port}`

const inputs = (over: Partial<Parameters<typeof buildJoinDoc>[0]> = {}) => ({
  genesis: { config: { chainId: 8470, transitions: { qbft: [{ validatorcontractaddress: '0x0165878a594ca255338adfa4d48449f69242eb8f', validatorselectionmode: 'contract' }] } } },
  bootnodes: null,
  configuredChainId: 8470,
  configuredUsdc: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  deploymentNetwork: 'tiny',
  origin: 'https://tiny.technology',
  ...over,
})

describe('classifyBootnodes — a bootnode nobody can dial is worse than none', () => {
  it('withholds loopback, private and link-local hosts', () => {
    // ⚠️ THE reason this module exists. bootnodes-8470.txt today holds exactly one
    // enode, at 127.0.0.1. Serving it publicly makes a stranger's node dial THEIR
    // OWN machine, find nothing, and blame their firewall or conclude the chain is
    // dead. Neither of those is debuggable from the outside.
    const r = classifyBootnodes([
      enode(PUB, '127.0.0.1', 30401),
      enode(PUB, 'localhost'),
      enode(PUB, '10.0.0.5'),
      enode(PUB, '192.168.1.9'),
      enode(PUB, '172.16.4.4'),
      enode(PUB, '172.31.255.1'),
      enode(PUB, '169.254.1.1'),
      enode(PUB, '0.0.0.0'),
      // Bracketed, which is besu's own form — an unbracketed ::1 is unparseable
      // (the colons ARE the port separator), and my first version of this fixture
      // used one, so the case landed in `malformed` and the v6 branch was never
      // exercised. A withheld-for-the-wrong-reason enode still gets withheld,
      // which is exactly why the miscount was worth chasing.
      enode(PUB, '[::1]'),
      enode(PUB, '[fe80::1]'),
      enode(PUB, '[fd00::abcd]'),
    ].join('\n'))
    expect(r.routable).toEqual([])
    expect(r.malformed).toEqual([])
    expect(r.unroutable).toHaveLength(11)
  })

  it('publishes a GLOBAL IPv6 bootnode — v6 must not be withheld wholesale', () => {
    // The opposite error to the one above: treating every colon-host as private
    // would silently drop the only bootnode a v6-only operator can offer.
    const r = classifyBootnodes([enode(PUB, '[2001:db8::1]', 30303), enode(PUB2, '[2600:1f18::4]')].join('\n'))
    expect(r.routable).toHaveLength(2)
    expect(r.unroutable).toEqual([])
    expect(r.malformed).toEqual([])
  })

  it('publishes genuinely routable hosts, including ones just outside the private ranges', () => {
    // 172.15 and 172.32 are PUBLIC — the RFC1918 block is 172.16–172.31 only. An
    // off-by-one here silently withholds a working bootnode, which reads as "the
    // chain publishes nothing" to everyone downstream.
    const r = classifyBootnodes([
      enode(PUB, 'chain.tiny.technology', 30303),
      enode(PUB2, '203.0.113.7'),
      enode(PUB, '172.15.0.1'),
      enode(PUB, '172.32.0.1'),
      enode(PUB, '11.0.0.1'),
    ].join(','))
    expect(r.routable).toHaveLength(5)
    expect(r.unroutable).toEqual([])
  })

  it('rejects things that are not enodes at all, rather than passing them through', () => {
    const r = classifyBootnodes([
      'https://chain.tiny.technology',
      'enode://tooshort@1.2.3.4:30303',
      `enode://${PUB}@1.2.3.4`,              // no port
      `enode://${PUB}@1.2.3.4:99999`,        // port out of range
      'enode://' + 'z'.repeat(128) + '@1.2.3.4:30303', // not hex
    ].join('\n'))
    expect(r.routable).toEqual([])
    expect(r.malformed).toHaveLength(5)
  })

  it('reads the same format join-tiny-chain.sh does — comments, blanks, either separator', () => {
    // One format, one parser. A second parser here would be free to disagree with
    // the shell script about the same file, and the disagreement would only show
    // up as a joiner who cannot find peers.
    const r = classifyBootnodes(`# Bootnodes for tiny chain 8470.\n\n${enode(PUB, '203.0.113.7')}\n\n#trailing comment\n${enode(PUB2, '198.51.100.9')},\n`)
    expect(r.routable).toEqual([enode(PUB, '203.0.113.7'), enode(PUB2, '198.51.100.9')])
    expect(r.malformed).toEqual([])
  })

  it('treats absent/empty config as an empty list, not as a crash', () => {
    for (const v of [null, undefined, '', '   ', '# only a comment']) {
      expect(classifyBootnodes(v as string | null).routable).toEqual([])
    }
  })
})

describe('buildJoinDoc — the empty bootnode list must EXPLAIN itself', () => {
  it('says a bootnode is only an introduction, and how to get one', () => {
    const doc = buildJoinDoc(inputs({ bootnodes: null }))
    expect(doc.bootnodes).toEqual([])
    // Without this the reader concludes the chain is closed. It is not: any peer's
    // enode works, and a bootnode holds no authority over consensus.
    expect(doc.bootnodesNote).toMatch(/INTRODUCTION/)
    expect(doc.bootnodesNote).toMatch(/--bootnodes/)
  })

  it('counts withheld entries so an operator can tell "unset" from "rejected"', () => {
    // Serving 0 of 1 configured bootnodes without saying so is how an operator
    // concludes the ENDPOINT is broken instead of checking their env value.
    const one = buildJoinDoc(inputs({ bootnodes: enode(PUB, '127.0.0.1', 30401) }))
    expect(one.bootnodesNote).toMatch(/1 configured entry is loopback/)
    const two = buildJoinDoc(inputs({ bootnodes: [enode(PUB, '127.0.0.1'), 'garbage'].join('\n') }))
    expect(two.bootnodesNote).toMatch(/2 configured entries are/)
  })

  it('still notes withheld entries when SOME bootnodes are publishable', () => {
    const doc = buildJoinDoc(inputs({ bootnodes: [enode(PUB, '203.0.113.7'), enode(PUB2, '10.1.1.1')].join('\n') }))
    expect(doc.bootnodes).toEqual([enode(PUB, '203.0.113.7')])
    expect(doc.bootnodesNote).toMatch(/1 configured entry was withheld/)
  })

  it('has NO note at all when every configured bootnode is served', () => {
    // A note on a healthy list is noise, and noise is how the real warnings above
    // get skimmed past.
    const doc = buildJoinDoc(inputs({ bootnodes: enode(PUB, '203.0.113.7') }))
    expect(doc.bootnodesNote).toBeNull()
  })
})

describe('buildJoinDoc — never serve an address from a DIFFERENT chain', () => {
  it('withholds the USDC address when the deployment is on another chain, naming both ids', () => {
    // ⚠️ The c9 failure shape. TINY_CHAIN_USDC_ADDRESS is the USDC of whatever
    // chain this deployment settles on — in production, the LIVE 8469. Publishing
    // it in an 8470 join document hands the joiner an address with no code on the
    // chain they just synced: eth_getCode returns '0x', every call returns empty,
    // and NOTHING anywhere reports an error.
    const doc = buildJoinDoc(inputs({ configuredChainId: 8469, configuredUsdc: '0x5fbdb2315678afecb367f032d93f642f64180aa3' }))
    expect(doc.contracts.usdc).toBeNull()
    expect(doc.contracts.usdcNote).toMatch(/8469/)
    expect(doc.contracts.usdcNote).toMatch(/8470/)
    expect(doc.contracts.usdcNote).toMatch(/no code/)
  })

  it('serves it when the deployment IS the published chain', () => {
    const doc = buildJoinDoc(inputs({ configuredChainId: 8470 }))
    expect(doc.contracts.usdc).toBe('0x5fbdb2315678afecb367f032d93f642f64180aa3')
    expect(doc.contracts.usdcNote).toBeNull()
  })

  it('withholds a malformed USDC even on a matching chain', () => {
    for (const bad of ['', '0x123', 'not-an-address', null]) {
      const doc = buildJoinDoc(inputs({ configuredUsdc: bad }))
      expect(doc.contracts.usdc, `${bad} should not be published`).toBeNull()
    }
  })

  it('takes the validator contract from the GENESIS, not from env', () => {
    // The genesis is the only source a joiner and besu both consult, so it is the
    // only one that cannot disagree with what the chain actually enforces.
    const doc = buildJoinDoc(inputs({ configuredChainId: 8469, configuredUsdc: null }))
    expect(doc.contracts.validators).toBe('0x0165878a594ca255338adfa4d48449f69242eb8f')
  })

  it('reports null validators (not a guess) when the genesis has no contract transition', () => {
    const doc = buildJoinDoc(inputs({ genesis: { config: { chainId: 8470 } } }))
    expect(doc.contracts.validators).toBeNull()
    // And the validator steps stay honest — no "on undefined".
    expect(doc.validating.steps.join(' ')).not.toMatch(/undefined|null/)
  })
})

describe('buildJoinDoc — syncing this chain is not the same as being paid on it', () => {
  it('warns when the deployment settles somewhere else', () => {
    // A joiner who assumes their synced chain is where x402 money lands would look
    // for it on the wrong ledger and find nothing wrong with either chain.
    const doc = buildJoinDoc(inputs({ deploymentNetwork: 'base', configuredChainId: 8453 }))
    expect(doc.payments.settlesOnThisChain).toBe(false)
    expect(doc.payments.note).toMatch(/NOT on chain 8470/)
  })

  it('warns even when PAYMENTS_NETWORK is tiny but the chain id differs', () => {
    // The production case exactly: PAYMENTS_NETWORK=tiny, TINY_CHAIN_ID=8469,
    // published genesis 8470. "tiny" alone must not be read as "this chain".
    const doc = buildJoinDoc(inputs({ deploymentNetwork: 'tiny', configuredChainId: 8469 }))
    expect(doc.payments.settlesOnThisChain).toBe(false)
    expect(doc.payments.note).toMatch(/NOT on chain 8470/)
  })

  it('confirms it when they are the same chain', () => {
    const doc = buildJoinDoc(inputs({ deploymentNetwork: 'tiny', configuredChainId: 8470 }))
    expect(doc.payments.settlesOnThisChain).toBe(true)
    expect(doc.payments.note).not.toMatch(/⚠️/)
  })
})

describe('buildJoinDoc — the instructions are runnable and honest', () => {
  const doc = buildJoinDoc(inputs())

  it('names besu specifically, and Java 25+', () => {
    const reqs = doc.requirements.join(' ')
    // Both are first-contact failures. "Use an EVM node" sends people to geth,
    // which cannot follow QBFT; Java 21 dies with an error naming neither Java
    // nor a version.
    expect(reqs).toMatch(/Besu/)
    expect(reqs).toMatch(/[Nn]ot geth, not anvil/)
    expect(reqs).toMatch(/Java 25\+/)
  })

  it('states that joining needs nothing from us — the actual openness claim', () => {
    expect(doc.requirements.join(' ')).toMatch(/No key, no allowlist entry, no signup/)
  })

  it('gives a real genesis URL built from the request origin, not a placeholder', () => {
    // A doc with `<your-host>` in the curl line is a runbook, not one command.
    expect(doc.steps[0]).toContain('https://tiny.technology/api/chain/join?format=genesis')
    expect(doc.steps.join(' ')).not.toMatch(/\{\{|<your|YOUR_/)
  })

  it('asks for FULL sync — the participation claim, not a performance setting', () => {
    // A snap-synced node trusts someone else's state root. A full node re-executes
    // every block and can therefore CONTRADICT us, which is the whole point of
    // letting strangers run nodes.
    expect(doc.steps.join(' ')).toContain('--sync-mode=FULL')
  })

  it('tells the reader how to detect being REFUSED the chain vs merely syncing slowly', () => {
    // The c7 symptom: peered, genesis hash matches, stuck at block 0 forever. It
    // is invisible to us (we already hold those blocks) and only ever hurts a
    // newcomer, so the newcomer is who has to be told where to look.
    const s = doc.steps.join(' ')
    expect(s).toMatch(/never leaves block 0/)
    expect(s).toMatch(/ValidationRule/)
  })

  it('separates "full node" from "validator", and does not pretend stake is at risk', () => {
    expect(doc.validating.permissionless).toBe(true)
    expect(doc.validating.steps.join(' ')).toMatch(/MIN_STAKE/)
    expect(doc.validating.steps.join(' ')).toMatch(/rotate\(\) yourself/)
    const caveats = doc.validating.caveats.join(' ')
    // The honest half: conflating "convicted on-chain" with "slashable" would be
    // the dishonest version of this document.
    expect(caveats).toMatch(/DEPOSIT, not a bond/)
    expect(caveats).toMatch(/nothing burns stake yet/)
    expect(caveats).toMatch(/earns no seat/)
  })

  it('refuses to serve boot instructions for a genesis with no chain id', () => {
    // chain.id: 0 would cost the reader a full sync before failing.
    for (const bad of [{}, { config: {} }, { config: { chainId: 0 } }, { config: { chainId: -1 } }]) {
      expect(() => buildJoinDoc(inputs({ genesis: bad as any }))).toThrow(/no chainId/)
    }
  })
})

describe('the route serves the REAL genesis, the one our own nodes boot from', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    process.env.TINY_CHAIN_ID = '8470'
    process.env.TINY_CHAIN_USDC_ADDRESS = '0x5fbdb2315678afecb367f032d93f642f64180aa3'
    process.env.PAYMENTS_NETWORK = 'tiny'
    delete process.env.TINY_CHAIN_PUBLIC_BOOTNODES
  })
  afterEach(() => { process.env = { ...ORIGINAL } })

  it('?format=genesis returns the committed genesis byte-for-byte in content', async () => {
    const { GET } = await import('@/app/api/chain/join/route')
    const res = await GET(new Request('https://tiny.technology/api/chain/join?format=genesis'))
    expect(res.status).toBe(200)
    const served = await res.json()
    // Not a hand-maintained copy: the file itself. A copy would drift, and the
    // drift shows up only as a stranger who cannot peer.
    const onDisk = JSON.parse(readFileSync(joinPath(process.cwd(), 'chain/multinode/genesis-8470.json'), 'utf8'))
    expect(served).toEqual(onDisk)
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=300/)
  })

  it('the served genesis carries what besu needs to accept the chain at all', async () => {
    const { GET } = await import('@/app/api/chain/join/route')
    const g: any = await (await GET(new Request('https://tiny.technology/api/chain/join?format=genesis'))).json()
    expect(g.config.chainId).toBe(8470)
    // ⚠️ Both transition keys (the c2 lesson): with the address alone besu SILENTLY
    // ignores the transition and seats validators nobody consults.
    expect(g.config.transitions.qbft[0].validatorselectionmode).toBe('contract')
    expect(g.config.transitions.qbft[0].validatorcontractaddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // ⚠️ The c7 bug: this field is read as a TIMESTAMP because shanghaiTime is a
    // time milestone. A small number means 1970 ⇒ contract mode from block 1 ⇒ no
    // outsider can ever sync, and we would never notice.
    expect(g.config.transitions.qbft[0].block).toBeGreaterThan(1_600_000_000)
    expect(g.config.shanghaiTime).toBe(0) // else every contract deploy dies on PUSH0
  })

  it('the JSON document names the chain from the genesis and echoes the curl URL', async () => {
    const { GET } = await import('@/app/api/chain/join/route')
    const res = await GET(new Request('https://tiny.technology/api/chain/join'))
    expect(res.status).toBe(200)
    const doc: any = await res.json()
    expect(doc.chain.id).toBe(genesis.config.chainId)
    expect(doc.chain.caip2).toBe(`eip155:${genesis.config.chainId}`)
    expect(doc.steps[0]).toContain('https://tiny.technology/api/chain/join?format=genesis')
    // The whole document must be enough on its own — genesis inlined too, so one
    // fetch answers both "what chain" and "how".
    expect(doc.genesis.config.chainId).toBe(genesis.config.chainId)
  })

  it('publishes NO bootnode when TINY_CHAIN_PUBLIC_BOOTNODES is unset', async () => {
    // And in particular does not fall back to bootnodes-8470.txt, which is
    // loopback-only by design (see its header) — that fallback is precisely the
    // undialable-address failure this endpoint exists to avoid.
    const { GET } = await import('@/app/api/chain/join/route')
    const doc: any = await (await GET(new Request('https://tiny.technology/api/chain/join'))).json()
    expect(doc.bootnodes).toEqual([])
    expect(doc.bootnodesNote).toMatch(/INTRODUCTION/)
    // ⚠️ And it must say "nothing is configured", NOT "we rejected something".
    // Found by mutation: giving the route a hardcoded 127.0.0.1 fallback still
    // produced an empty list — the pure layer withheld it, so every other
    // assertion here passed. The only visible difference was the note flipping to
    // "1 configured entry is loopback", i.e. an operator would go hunting for an
    // env value they never set. Defense-in-depth is not a reason to stop
    // asserting on the layer that reports WHY.
    expect(doc.bootnodesNote).not.toMatch(/configured entr/)
  })

  it('serves a routable bootnode from env, and still withholds a loopback one', async () => {
    process.env.TINY_CHAIN_PUBLIC_BOOTNODES = `${enode(PUB, '203.0.113.7', 30303)},${enode(PUB2, '127.0.0.1', 30401)}`
    const { GET } = await import('@/app/api/chain/join/route')
    const doc: any = await (await GET(new Request('https://tiny.technology/api/chain/join'))).json()
    expect(doc.bootnodes).toEqual([enode(PUB, '203.0.113.7', 30303)])
    expect(doc.bootnodesNote).toMatch(/withheld/)
  })

  it('withholds the production USDC when the deployment is the LIVE 8469', async () => {
    // The real production env: 8469's USDC must never appear in an 8470 doc.
    process.env.TINY_CHAIN_ID = '8469'
    const { GET } = await import('@/app/api/chain/join/route')
    const doc: any = await (await GET(new Request('https://tiny.technology/api/chain/join'))).json()
    expect(doc.contracts.usdc).toBeNull()
    expect(doc.payments.settlesOnThisChain).toBe(false)
  })

  it('works on a deployment with NO chain configured at all', async () => {
    // The join document is about a chain that exists independently of whether this
    // particular deployment settles on it — a docs-only host must still serve it.
    delete process.env.TINY_CHAIN_ID
    delete process.env.TINY_CHAIN_USDC_ADDRESS
    delete process.env.PAYMENTS_NETWORK
    const { GET } = await import('@/app/api/chain/join/route')
    const res = await GET(new Request('https://tiny.technology/api/chain/join'))
    expect(res.status).toBe(200)
    const doc: any = await res.json()
    expect(doc.chain.id).toBe(genesis.config.chainId)
    expect(doc.contracts.usdc).toBeNull()
    expect(doc.contracts.usdcNote).toMatch(/Not configured/)
  })

  it('runs on the EDGE — a filesystem read of the genesis would be aliased away', async () => {
    // next.config.js aliases node:fs to an empty module for the edge runtime, so a
    // readFileSync here would not fail at build time; it would return undefined at
    // request time and serve an empty genesis. Hence the static import.
    const src = readFileSync(joinPath(process.cwd(), 'app/api/chain/join/route.ts'), 'utf8')
    expect(src).toMatch(/export const runtime = 'edge'/)
    // Anchored to IMPORTS AND CALLS, not to the words: the route's own docblock
    // explains the node:fs hazard on purpose, and a file-wide /node:fs/ match
    // fails on that prose while a `readFileSync` added later inside a string
    // would slip past it. Match the shapes that would actually execute.
    expect(src).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/)
    expect(src).not.toMatch(/readFileSync\s*\(/)
    expect(src).toMatch(/^import genesis from '@\/chain\/multinode\/genesis-8470\.json'$/m)
  })
})

describe('the joiner script and this endpoint describe the SAME chain', () => {
  const root = process.cwd()

  it('join-tiny-chain.sh boots the same genesis file this route serves', () => {
    // If the script ever pointed at a different file, the doc would be advertising
    // a chain our own tooling does not join.
    const sh = readFileSync(joinPath(root, 'chain/multinode/scripts/join-tiny-chain.sh'), 'utf8')
    expect(sh).toMatch(/genesis-8470\.json/)
    expect(sh).toMatch(/--sync-mode=FULL/)
  })

  /**
   * 🔬 c27 — THE TWO PARSERS, RUN ON THE SAME BYTES.
   *
   * `bootnodes-8470.txt` documents its own format in its header ("One enode:// URL
   * per line; blank lines and #comments are ignored"), and TWO independent programs
   * implement that sentence: `classifyBootnodes` above, and a sed/grep/paste
   * pipeline inside `join-tiny-chain.sh`. `classifyBootnodes`'s docblock has always
   * asserted they agree — "Accepts the same format join-tiny-chain.sh reads, so one
   * env value or one file can feed both without a second parser to disagree with
   * this one" — and until this suite existed, that was a comment, not a fact. The
   * test above it only ever matched the SCRIPT AS A STRING (does it mention
   * genesis-8470.json). c26's lens, turned on the next artifact: which artifact is
   * asserted about only as a string and never PARSED?
   *
   * They disagreed three ways, and one of the three was on the real file:
   *
   *  1. `classifyBootnodes` split on commas BEFORE stripping `#`, so the file's own
   *     explanatory prose — which contains commas — shredded into fragments that no
   *     longer started with `#` and each became a `malformed` entry. Four of them,
   *     for a file holding ONE bootnode, feeding `buildJoinDoc`'s "N configured
   *     entries are loopback/private/malformed" straight into the public join doc.
   *  2. An INLINE `<enode> # frankfurt` was malformed in TS (peer silently dropped)
   *     and was handed to besu WITH the comment text in shell (whole list rejected).
   *  3. A trailing comma left an empty element in the shell's output, which besu
   *     reads as a peer and refuses.
   *
   * Why RUN the script instead of re-implementing its pipeline here: a copy of the
   * pipeline in the test is a third parser, and it agrees with whichever of the two
   * I wrote it from. So the script executes, under `--dry-run` (resolves everything,
   * prints the besu command, starts no node and opens no port), reading a bootnodes
   * file we control — via a temp copy of the real script, because `BOOTNODES_FILE`
   * is derived from `$BASH_SOURCE`'s directory and is deliberately not env-tunable.
   */
  const REAL_JDK = ['/opt/homebrew/opt/openjdk@26', '/opt/homebrew/opt/openjdk']
    .find((p) => existsSync(joinPath(p, 'bin/java')))

  /** The enode list `join-tiny-chain.sh` would hand besu for `text`, in order. */
  function shellBootnodes(text: string): string[] {
    const dir = mkdtempSync(joinPath(tmpdir(), 'c27-boot-'))
    mkdirSync(joinPath(dir, 'scripts'))
    // The real script's bytes — not a paraphrase of them.
    writeFileSync(
      joinPath(dir, 'scripts/join-tiny-chain.sh'),
      readFileSync(joinPath(root, 'chain/multinode/scripts/join-tiny-chain.sh'))
    )
    writeFileSync(joinPath(dir, 'bootnodes-8470.txt'), text)
    const fakeBesu = joinPath(dir, 'besu')
    writeFileSync(fakeBesu, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    let stdout = ''
    try {
      stdout = execFileSync('bash', [joinPath(dir, 'scripts/join-tiny-chain.sh'), '--dry-run'], {
        env: {
          PATH: `${REAL_JDK}/bin:/usr/bin:/bin`,
          HOME: dir,
          BESU_BIN: fakeBesu,
          TINY_JOIN_GENESIS: joinPath(root, 'chain/multinode/genesis-8470.json'),
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: root,
      })
    } catch (e: any) {
      // An empty list is a legitimate outcome: the script refuses to start a node
      // with no peers. But it must SAY SO — and it demonstrably did not. Requiring
      // the message here, rather than accepting any non-zero exit as "empty", is
      // what caught the `grep -v`/`pipefail` abort described below: a silent exit 1
      // and a diagnosed one produce the identical [] on this side.
      if (/no bootnodes/.test(String(e.stderr || ''))) return []
      throw new Error(
        `joiner script exited ${e.status} without the "no bootnodes" diagnosis` +
          ` — stderr(${String(e.stderr || '').length}b): ${JSON.stringify(String(e.stderr || ''))}`
      )
    }
    // --dry-run prints `printf '%q '` of the argv, so the value may be shell-quoted.
    const m = /--bootnodes=(\S*)/.exec(stdout)
    if (!m) throw new Error(`no --bootnodes in dry-run output: ${stdout}`)
    const raw = m[1].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1')
    return raw === '' ? [] : raw.split(',')
  }

  /** Every enode TS accepted, in the order it read them — routable or not. */
  const tsBootnodes = (text: string) => {
    const c = classifyBootnodes(text)
    expect(c.malformed, 'a case in this table produced a malformed entry — see the list below').toEqual([])
    return [...c.routable, ...c.unroutable]
  }

  const A = enode(PUB, '203.0.113.7')
  const B = enode(PUB2, '198.51.100.9')

  it.each([
    // The real file. This is the case that was broken, and the only one whose bytes
    // we do not choose — so it must stay first.
    ['the real bootnodes-8470.txt', readFileSync(joinPath(root, 'chain/multinode/bootnodes-8470.txt'), 'utf8')],
    ['an inline #comment after an enode', `${A} # frankfurt\n`],
    ['two annotated enodes under a header', `# tiny 8470\n${A} # fra\n${B} # ore\n`],
    ['a trailing comma', `${A},\n`],
    ['comma-separated on one line', `${A},${B}\n`],
    ['CRLF line endings', `# header\r\n${A}\r\n${B}\r\n`],
    ['leading indentation', `   ${A}\n\t${B}\n`],
    ['a #-only file', '# nothing here yet\n#\n'],
    ['an empty file', ''],
    ['blank lines everywhere', `\n\n${A}\n\n\n`],
  ])('the shell and the TS parser agree on %s', (_label, text) => {
    if (!REAL_JDK) return
    expect(shellBootnodes(text)).toEqual(tsBootnodes(text))
  })

  it('🔴 a bootnodes file with nothing but comments is DIAGNOSED, not a silent exit 1', () => {
    if (!REAL_JDK) return
    // The bug the table above found, stated on its own because it is not about the
    // two parsers agreeing — it is about what a joiner sees. `grep -v` exits 1 when
    // it filters every line, and `set -euo pipefail` turned that into an abort AT
    // the parse line, three lines above the `fail "no bootnodes: …"` written for
    // exactly this case. Measured pre-c27: exit=1, stdout=0 bytes, stderr=0 bytes.
    // Someone whose file is a header plus a TODO got no output whatsoever.
    //
    // shellBootnodes() returns [] only for the diagnosed path and throws with the
    // byte count otherwise, so this asserts the message exists by construction.
    for (const text of ['# nothing here yet\n#\n', '', '\n\n\n', '   \n#\n']) {
      expect(shellBootnodes(text), JSON.stringify(text)).toEqual([])
    }
  })

  it('the shell parser never emits an EMPTY element, whatever the file looks like', () => {
    if (!REAL_JDK) return
    // Separate from the table because it is a claim about besu's argument, not about
    // agreement: besu parses an empty element as a peer and rejects the whole
    // --bootnodes value, so `enode://…,` costs a joiner every peer in the file.
    for (const text of [`${A},\n`, `${A},,${B}\n`, `${A}\n#\n`, `${A} #x\n,\n`]) {
      expect(shellBootnodes(text).filter((s) => s.trim() === ''), text).toEqual([])
    }
  })

  it('the repo bootnodes file is still loopback-only — so the endpoint must not use it', () => {
    // A guard on the PREMISE, not on the file: the day someone adds a routable
    // enode there, this test fails and points at the note in the route that
    // explains why env (not this file) is the public source. That is a decision to
    // make deliberately, not to inherit.
    const txt = readFileSync(joinPath(root, 'chain/multinode/bootnodes-8470.txt'), 'utf8')
    const enodes = txt.split('\n').filter((l) => l.trim().startsWith('enode://'))
    expect(enodes.length).toBeGreaterThan(0)
    const c = classifyBootnodes(enodes.join('\n'))
    expect(c.routable, 'a routable enode exists now — decide whether to publish it').toEqual([])
  })
})
