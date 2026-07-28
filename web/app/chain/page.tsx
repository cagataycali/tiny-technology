/**
 * /chain — the tiny-chain explorer's front door: what this chain is, whether
 * it's answering, and the latest TinyUSDC movement. Wallets and receipts all
 * over the product link into /chain/tx/… and /chain/address/… (via
 * TINY_CHAIN_EXPLORER_URL); this page is where a person starts from scratch.
 */
import SiteHeader from '@/components/SiteHeader'
import { chainIdentity, chainInfo, latestBlockNumber, recentTransfers } from '@/lib/chain/rpc'
import { Card, Row, SearchForm, TransferList, AddressLink, NotConfigured, ChainIdRow } from '../chain/ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'tiny-chain explorer' }

// ~5.5 hours of 2s blocks — inside the node's pruned history, and "recent" is
// the honest scope for a front page (see lookbackFrom).
const SPAN = 10_000

export default async function ChainPage() {
  const info = chainInfo()
  if (!info) {
    return (
      <main id="main" className="min-h-screen bg-black text-white">
        <SiteHeader />
        <div className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="mb-6 text-2xl font-bold">tiny-chain</h1>
          <NotConfigured />
        </div>
      </main>
    )
  }

  const [latest, transfers, identity] = await Promise.all([
    latestBlockNumber(),
    recentTransfers({ span: SPAN, limit: 25 }),
    chainIdentity(),
  ])

  return (
    <main id="main" className="min-h-screen bg-black text-white">
      <SiteHeader />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <h1 className="text-2xl font-bold">tiny-chain explorer</h1>
        <SearchForm />
        <Card title="Network">
          <ChainIdRow identity={identity} />
          <Row k="Latest block">{latest === null ? <span className="text-red-300">node unreachable</span> : latest.toLocaleString('en-US')}</Row>
          <Row k="TinyUSDC"><AddressLink address={info.usdc} label={info.usdc} /></Row>
          <Row k="Money note">Balances here are trial credit — spendable across tiny, not withdrawable as real USDC.</Row>
        </Card>
        <Card title="Recent TinyUSDC activity">
          <TransferList transfers={transfers} empty="No transfers in the recent block window." />
        </Card>
      </div>
    </main>
  )
}
