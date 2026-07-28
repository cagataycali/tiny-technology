/**
 * GET /chain/lookup?q=… — route the search box. A tx hash and an address are
 * distinguishable by shape alone (lookupTarget), so this is a redirect, not a
 * page. Anything that is neither goes back to /chain — never into a dynamic
 * segment, because the segment IS an RPC parameter on the target pages.
 */
import { redirect } from 'next/navigation'
import { lookupTarget } from '@/lib/chain/explorer-core'

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  const target = lookupTarget(q)
  if (target === 'tx') redirect(`/chain/tx/${q.toLowerCase()}`)
  if (target === 'address') redirect(`/chain/address/${q.toLowerCase()}`)
  redirect('/chain')
}
