import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SportPage } from '../src/pages/SportPage'
import { OverviewPage } from '../src/pages/Overview'
import { api } from '../src/lib/api'

const overview = { initialBankroll: 100000, bankroll: 100000, totalProfit: 0, roi: null, betCount: 0, settledCount: 0, hitRate: null, maxDrawdown: 0, maxDrawdownPct: 0, equityCurve: [] }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function mockReads() {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/performance/overview') ? overview : []), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
it('boat loads only saved purchases and sport overview in StrictMode; exploration is opt-in', async () => {
  const fetcher = mockReads()
  render(<StrictMode><MemoryRouter><SportPage sport="boat" /></MemoryRouter></StrictMode>)
  await screen.findByText('全期間の購入履歴')
  await waitFor(() => expect(screen.getByText('累計損益')).toBeTruthy())
  expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual(['/api/bets?sport=boat&origin=all', '/api/performance/overview?sport=boat&origin=all'])
  expect(screen.getByText('全期間・仮想購入レビュー')).toBeTruthy()
  fireEvent.click(screen.getByText(/レースを調べる/, { selector: 'summary' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4))
  expect(fetcher.mock.calls.some(([url]) => url.includes('/rankings?'))).toBe(true)
})
it('overview leaves sport comparisons and models unloaded until requested', async () => {
  const fetcher = mockReads()
  render(<StrictMode><MemoryRouter><OverviewPage /></MemoryRouter></StrictMode>)
  await screen.findByText('競馬 vs ボートレースを比較')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.some(([url]) => url.includes('/models'))).toBe(false)
  fireEvent.click(screen.getByText('競馬 vs ボートレースを比較'))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5))
})
it('shares in-flight identical reads but refreshes settled data and separates origin', async () => {
  const fetcher = mockReads()
  await Promise.all([api.bets('real', 'boat'), api.bets('real', 'boat'), api.bets('sample', 'boat')])
  expect(fetcher).toHaveBeenCalledTimes(2)
  await api.bets('real', 'boat')
  expect(fetcher).toHaveBeenCalledTimes(3)
})
