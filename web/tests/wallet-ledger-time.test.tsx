// @vitest-environment jsdom
/**
 * Ledger rows carry the ABSOLUTE time alongside the relative one (backlog
 * v4 C10): hover title, a print-only span (a "3d ago" on paper is anchored
 * to an unknown moment — the ledger is the money page users print), and
 * the SR row label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import WalletPage from '../app/wallet/page'

const CREATED = 1_753_000_000 // fixed epoch seconds

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    // getWallet's GET passes {cache:"no-store"} — detect POST by method,
    // never by init presence.
    if (u === '/api/wallet' && init?.method !== 'POST') {
      return { status: 200, json: async () => ({ balance_micro: 5_000_000, history: [{ delta_micro: -250_000, kind: 'invoke_debit', created: CREATED }] }) }
    }
    if (u === '/api/wallet') return { status: 200, json: async () => ({ ok: false }) } // deposit_info: not configured
    return { ok: false, status: 401, json: async () => ({}) } // /api/me etc.
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('wallet ledger timestamps', () => {
  it('every relative time carries its absolute twin (title + print span + SR label)', async () => {
    render(<WalletPage />)
    const row = await screen.findByRole('listitem')
    const when = new Date(CREATED * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    // SR label reads relative AND absolute
    expect(row.getAttribute('aria-label')).toContain(`(${when})`)
    // hover reveals the absolute
    const time = row.querySelector(`[title="${when}"]`)
    expect(time).not.toBeNull()
    // print renders it inline (hidden on screen)
    const printSpan = time!.querySelector('.print\\:inline') || time!.querySelector('[class*="print:inline"]')
    expect(printSpan?.textContent).toContain(when)
    expect(printSpan?.className).toContain('hidden')
  })
})
