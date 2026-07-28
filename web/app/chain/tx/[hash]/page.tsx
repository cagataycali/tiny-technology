/**
 * /chain/tx/<hash> — one transaction: status, block, participants, and every
 * TinyUSDC Transfer it emitted. This is where TINY_CHAIN_EXPLORER_URL points
 * (`${base}/tx/${hash}` — tinyExplorerTxUrl), i.e. the page behind every
 * "view transaction" link on a payment receipt.
 */
import SiteHeader from '@/components/SiteHeader'
import { notFound } from 'next/navigation'
import { decodeTransferLog, hexToNumber, isTxHash, type TransferLog } from '@/lib/chain/explorer-core'
import { decodeCalldata, decodeEventLog, type DecodedEvent } from '@/lib/chain/calldata'
import { chainInfo, getBlock, getReceipt, getTransaction } from '@/lib/chain/rpc'
import { AddressLink, Card, NotConfigured, Row, SearchForm, TransferList, CallCard, EventList } from '../../ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'tiny-chain transaction' }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="min-h-screen bg-black text-white">
      <SiteHeader />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <h1 className="text-2xl font-bold">Transaction</h1>
        <SearchForm />
        {children}
      </div>
    </main>
  )
}

export default async function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash: raw } = await params
  const hash = decodeURIComponent(raw).toLowerCase()
  if (!isTxHash(hash)) notFound()
  const info = chainInfo()
  if (!info) return <Shell><NotConfigured /></Shell>

  const [tx, receipt] = await Promise.all([getTransaction(hash), getReceipt(hash)])
  if (!tx && !receipt) {
    return (
      <Shell>
        <Card>
          <p className="text-sm text-white/60">
            <span className="font-mono break-all">{hash}</span> isn&apos;t known to this node — it may be pending, pruned, or from another chain.
          </p>
        </Card>
      </Shell>
    )
  }

  const blockNumber = hexToNumber(receipt?.blockNumber ?? tx?.blockNumber)
  const block = blockNumber !== null ? await getBlock(`0x${blockNumber.toString(16)}`) : null
  const timestamp = hexToNumber(block?.timestamp)
  const status = receipt ? (receipt.status === '0x1' ? 'success' : 'reverted') : 'pending'
  const allLogs = Array.isArray(receipt?.logs) ? receipt.logs : []
  // The MONEY list stays scoped to TinyUSDC: a Transfer from another token is
  // not TinyUSDC moving, and showing it in the balance-affecting list would
  // overstate what happened to this chain's money.
  const transfers = allLogs
    .filter((l: any) => String(l?.address ?? '').toLowerCase() === info.usdc)
    .map(decodeTransferLog)
    .filter((t: TransferLog | null): t is TransferLog => t !== null)

  // 🧾 INPUT: what the transaction asked the contract to do. Null for a plain
  // value send or a contract we don't model — the page then shows raw hex
  // rather than a confident wrong reading (see lib/chain/calldata.ts).
  const call = decodeCalldata(tx?.input)
  // 🧾 OUTPUT: what the chain emitted back. NOT a return value — a mined tx has
  // none retrievable; events are the output, and consensus signed them.
  //
  // ⚠️ Deliberately NOT filtered to the USDC address, unlike `transfers` above:
  // staking, exits, rotations and reward claims are emitted by TinyValidators /
  // TinyIssuance / TinyServeRewards, so a USDC-only filter would silently drop
  // every participation event — the ones that matter most on a chain whose
  // premise is that anyone can join. The decoder is keyed on topic, so a log
  // from an unrelated contract that happens to match a known topic decodes as
  // that event; its emitter is shown so the reader can tell whose it was.
  const events = allLogs
    .map(decodeEventLog)
    .filter((e: DecodedEvent | null): e is DecodedEvent => e !== null)
  const gasUsed = hexToNumber(receipt?.gasUsed)
  const valueWei = hexToNumber(tx?.value)
  // A DEPLOYMENT: no `to`, and the receipt names the address it created. Either
  // signal alone is enough (a pending tx has no receipt; an old node may omit
  // contractAddress), and neither can be true of an ordinary call.
  const created = typeof receipt?.contractAddress === 'string' ? receipt.contractAddress.toLowerCase() : null
  const isCreation = Boolean(created) || Boolean(tx && !tx.to)

  return (
    <Shell>
      <Card title="Transaction">
        <Row k="Hash"><span className="font-mono">{hash}</span></Row>
        <Row k="Status">
          <span className={status === 'success' ? 'text-emerald-300' : status === 'reverted' ? 'text-red-300' : 'text-amber-300'}>
            {status}
          </span>
        </Row>
        <Row k="Block">{blockNumber === null ? '—' : blockNumber.toLocaleString('en-US')}</Row>
        {timestamp !== null ? <Row k="Time">{new Date(timestamp * 1000).toUTCString()}</Row> : null}
        {tx?.from ? <Row k="From"><AddressLink address={String(tx.from).toLowerCase()} label={String(tx.from).toLowerCase()} /></Row> : null}
        {tx?.to ? <Row k="To"><AddressLink address={String(tx.to).toLowerCase()} label={String(tx.to).toLowerCase()} /></Row> : null}
        {created ? <Row k="Deployed"><AddressLink address={created} label={created} /></Row> : null}
        {gasUsed !== null ? <Row k="Gas used">{gasUsed.toLocaleString('en-US')} <span className="text-white/40">(gas is free on this chain — the limit still bounds work)</span></Row> : null}
      </Card>
      {/* Input before output: what was asked, then what happened. */}
      <CallCard
        call={call}
        rawInput={typeof tx?.input === 'string' ? tx.input : ''}
        valueWei={valueWei}
        // No `to` means this transaction CREATED a contract; its input is
        // creation bytecode. Calling that "not decoded" would be a wrong
        // reading rather than an absent one, so the card is told which it is.
        isCreation={isCreation}
      />
      <Card title="Output — what the chain emitted">
        <EventList
          events={events}
          empty={
            events.length === 0 && transfers.length === 0
              ? 'This transaction emitted no TinyUSDC events.'
              : 'No decodable events.'
          }
        />
      </Card>
      <Card title="TinyUSDC transfers in this transaction">
        <TransferList transfers={transfers} empty="This transaction moved no TinyUSDC." />
      </Card>
    </Shell>
  )
}
