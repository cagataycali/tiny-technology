/**
 * /chain/address/<addr> — a wallet as the chain sees it: TinyUSDC balance,
 * gas balance, and recent transfers in either direction. "Their wallet" for
 * anyone who was handed an address by a receipt, a deposit card, or a payer.
 */
import SiteHeader from '@/components/SiteHeader'
import { notFound } from 'next/navigation'
import { isAddress, usdMicro } from '@/lib/chain/explorer-core'
import { chainInfo, ethBalanceWei, recentTransfers, usdcBalanceMicro } from '@/lib/chain/rpc'
import { Card, NotConfigured, Row, SearchForm, TransferList } from '../../ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'tiny-chain address' }

// ~2 days of 2s blocks — the deeper window is worth it on a page someone
// opens to find THEIR payment; still inside the node's pruned history.
const SPAN = 80_000

export default async function AddressPage({ params }: { params: Promise<{ addr: string }> }) {
  const { addr: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!isAddress(address)) notFound()
  const info = chainInfo()

  return (
    <main id="main" className="min-h-screen bg-black text-white">
      <SiteHeader />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <h1 className="text-2xl font-bold">Address</h1>
        <SearchForm />
        {!info ? (
          <NotConfigured />
        ) : (
          <AddressBody address={address} />
        )}
      </div>
    </main>
  )
}

async function AddressBody({ address }: { address: string }) {
  const [usdc, wei, transfers] = await Promise.all([
    usdcBalanceMicro(address),
    ethBalanceWei(address),
    recentTransfers({ span: SPAN, address, limit: 25 }),
  ])
  return (
    <>
      <Card title="Wallet">
        <Row k="Address"><span className="font-mono">{address}</span></Row>
        <Row k="TinyUSDC"><span className="font-semibold">{usdMicro(usdc)}</span> <span className="text-white/40">(trial credit — not withdrawable as real USDC)</span></Row>
        <Row k="Gas">{wei === null ? '—' : `${(wei / 1e18).toLocaleString('en-US', { maximumFractionDigits: 4 })} ETH`}</Row>
      </Card>
      <Card title="Recent TinyUSDC activity">
        <TransferList transfers={transfers} empty="No transfers touching this address in the recent block window." />
      </Card>
    </>
  )
}
