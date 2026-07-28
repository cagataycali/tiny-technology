/**
 * Shared presentation for the /chain explorer pages (server components).
 * The look borrows the site's grammar: black canvas, hairline cards, mono hex.
 */
import Link from 'next/link'
import { shortHex, transferKind, usdMicro, type TransferLog } from '@/lib/chain/explorer-core'
import {
  microToNumber,
  timestampLabel,
  type DecodedArg,
  type DecodedCall,
  type DecodedEvent,
} from '@/lib/chain/calldata'

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      {title ? <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/50">{title}</h2> : null}
      {children}
    </section>
  )
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <Link href={`/chain/address/${address}`} className="font-mono text-sky-300 hover:underline">
      {label ?? shortHex(address)}
    </Link>
  )
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <Link href={`/chain/tx/${hash}`} className="font-mono text-sky-300 hover:underline">
      {shortHex(hash, 8, 6)}
    </Link>
  )
}

export function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/5 py-2 last:border-0">
      <span className="w-28 shrink-0 text-sm text-white/50">{k}</span>
      <span className="min-w-0 break-all text-sm">{children}</span>
    </div>
  )
}

const KIND_BADGE: Record<ReturnType<typeof transferKind>, string> = {
  mint: '🌱 mint',
  burn: '🔥 burn',
  transfer: '→',
}

export function TransferList({ transfers, empty }: { transfers: TransferLog[]; empty: string }) {
  if (!transfers.length) return <p className="text-sm text-white/40">{empty}</p>
  return (
    <ul className="divide-y divide-white/5">
      {transfers.map((t, i) => (
        <li key={`${t.txHash}:${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
          <span className="font-semibold tabular-nums">{usdMicro(t.micro)}</span>
          <AddressLink address={t.from} />
          <span className="text-white/40">{KIND_BADGE[transferKind(t)]}</span>
          <AddressLink address={t.to} />
          {t.txHash ? (
            <span className="ml-auto">
              <TxLink hash={t.txHash} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function SearchForm({ initial = '' }: { initial?: string }) {
  return (
    <form action="/chain/lookup" method="get" className="flex gap-2" role="search">
      <input
        type="search"
        name="q"
        defaultValue={initial}
        placeholder="tx hash or address (0x…)"
        aria-label="Search by transaction hash or address"
        className="w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2 font-mono text-sm outline-none placeholder:text-white/30 focus:border-white/30"
      />
      <button type="submit" className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm hover:bg-white/15">
        Look up
      </button>
    </form>
  )
}

/**
 * The chain's identity, as CONFIRMED by the node rather than as configured.
 *
 * A mismatch is stated in full — both numbers, and what it means — because it is
 * silent by nature: `TINY_CHAIN_RPC_URL` defaults to the live node's port, so a
 * deployment naming a different chain id shows real data under a wrong label
 * (see chainIdentity in lib/chain/rpc.ts). `unknown` reads as plain configured
 * text: an unreachable node is already reported by the block row, and repeating
 * it as a warning here would cry wolf every time the chain is merely down.
 */
export function ChainIdRow({
  identity,
}: {
  identity: { state: 'match' | 'unknown' | 'mismatch'; chainId: number; reported?: number } | null
}) {
  if (!identity) return null
  if (identity.state === 'mismatch') {
    return (
      <Row k="Chain">
        <span className="text-red-300">
          ⚠️ configured as eip155:{identity.chainId}, but this node reports eip155:{identity.reported}
        </span>
        <span className="block text-white/50">
          Everything below comes from chain {identity.reported}, not {identity.chainId}. Fix{' '}
          <code className="font-mono">TINY_CHAIN_RPC_URL</code> or <code className="font-mono">TINY_CHAIN_ID</code> —
          until then this page is labelled with the wrong network.
        </span>
      </Row>
    )
  }
  return (
    <Row k="Chain">
      eip155:{identity.chainId}
      {identity.state === 'match' ? <span className="text-white/40"> — confirmed by the node</span> : null}
    </Row>
  )
}

/**
 * One decoded argument or event field. Addresses become links (the person
 * reading a settlement wants the counterparty's page); amounts show dollars
 * BESIDE the raw integer rather than instead of it — the explorer's job is the
 * on-chain value, and a formatted-only amount can't be checked against it.
 */
function ArgValue({ arg }: { arg: DecodedArg }) {
  if (arg.kind === 'address') {
    return <AddressLink address={arg.value} label={arg.value} />
  }
  if (arg.kind === 'micro') {
    return (
      <span>
        <span className="font-semibold">{usdMicro(microToNumber(arg.value))}</span>{' '}
        <span className="text-white/40 font-mono">({arg.value} micro)</span>
      </span>
    )
  }
  if (arg.kind === 'timestamp') {
    const label = timestampLabel(arg.value)
    return (
      <span>
        <span className="font-mono">{arg.value}</span>
        {label ? <span className="text-white/40"> — {label}</span> : <span className="text-white/40"> (no limit)</span>}
      </span>
    )
  }
  // bytes / bytes32 / uint256: hex stays hex, long payloads truncate visibly.
  const v = arg.value
  return <span className="font-mono break-all">{v.length > 74 ? shortHex(v, 20, 12) : v}</span>
}

function ArgRows({ args }: { args: DecodedArg[] }) {
  return (
    <>
      {args.map((a) => (
        <Row key={a.name} k={a.name}>
          <ArgValue arg={a} />
        </Row>
      ))}
    </>
  )
}

/**
 * The INPUT half of a transaction: the function it called and the arguments it
 * carried. When the calldata can't be decoded the raw hex is shown and SAID to
 * be undecoded — the alternative (a plausible guess) would be a wrong claim on
 * the page whose whole job is on-chain truth.
 */
export function CallCard({
  call,
  rawInput,
  valueWei,
  isCreation = false,
}: {
  call: DecodedCall | null
  rawInput: string
  valueWei: number | null
  /** True when the transaction has no `to` — it DEPLOYED a contract. Its
   *  calldata is creation bytecode, not a call, so "not decoded" would be a
   *  wrong reading rather than a missing one. */
  isCreation?: boolean
}) {
  const hasCalldata = rawInput.length > 2
  return (
    <Card title="Input — what this transaction asked for">
      {call ? (
        <>
          <Row k="Function">
            <span className="font-mono font-semibold">{call.name}</span>{' '}
            <span className="text-white/40 font-mono">{call.selector}</span>
          </Row>
          <Row k="In plain words">{call.summary}</Row>
          <ArgRows args={call.args} />
        </>
      ) : (
        <>
          <Row k="Function">
            {isCreation ? (
              <span className="text-white/60">none — this transaction deployed a contract</span>
            ) : hasCalldata ? (
              <span className="text-amber-300">not decoded</span>
            ) : (
              <span className="text-white/60">none — a plain transfer of the native coin</span>
            )}
          </Row>
          {hasCalldata ? (
            <>
              <Row k="In plain words">
                {isCreation
                  ? 'The data below is the contract’s creation bytecode — the code itself, not a call to it. Its first four bytes are not a function selector.'
                  : 'This transaction called a contract this explorer doesn’t model, so its arguments are shown as raw data rather than guessed at.'}
              </Row>
              <Row k={isCreation ? 'Bytecode' : 'Raw data'}>
                <span className="font-mono break-all text-white/60">
                  {rawInput.length > 138 ? shortHex(rawInput, 34, 20) : rawInput}
                </span>
                {/* Size, because for a deployment it's the one number a reader
                    can compare against a build they did themselves. */}
                <span className="text-white/40"> ({Math.floor((rawInput.length - 2) / 2).toLocaleString('en-US')} bytes)</span>
              </Row>
            </>
          ) : null}
          {valueWei !== null && valueWei > 0 ? (
            <Row k="Value">{(valueWei / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH</Row>
          ) : null}
        </>
      )}
    </Card>
  )
}

/** The OUTPUT half: the events the chain emitted, each with its own fields. */
export function EventList({ events, empty }: { events: DecodedEvent[]; empty: string }) {
  if (!events.length) return <p className="text-sm text-white/40">{empty}</p>
  return (
    <ul className="space-y-4">
      {events.map((e, i) => (
        <li key={`${e.name}:${i}`}>
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm font-semibold text-emerald-300">{e.name}</span>
            <span className="text-sm text-white/50">{e.summary}</span>
          </div>
          <div className="pl-3 border-l border-white/10">
            <ArgRows args={e.args} />
            {/* Whose event this is. The decoder matches on topic alone, so the
                emitter is what distinguishes a real Staked from a lookalike. */}
            {e.emitter ? (
              <Row k="emitted by">
                <AddressLink address={e.emitter} label={e.emitter} />
              </Row>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function NotConfigured() {
  return (
    <Card>
      <p className="text-sm text-white/60">
        This deployment isn&apos;t running a self-hosted chain (no <code className="font-mono">TINY_CHAIN_*</code> configuration), so there is nothing to explore here.
      </p>
    </Card>
  )
}
