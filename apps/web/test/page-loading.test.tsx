import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Layout } from '../src/components/Layout'
import { SportPage } from '../src/pages/SportPage'
import { OverviewPage } from '../src/pages/Overview'
import { api } from '../src/lib/api'
import { OriginProvider } from '../src/lib/origin'
import type { Bet } from '@edgelab/shared/src/types'

const overview = { initialBankroll: 100000, bankroll: 100000, totalProfit: 0, roi: null, betCount: 0, settledCount: 0, hitRate: null, maxDrawdown: 0, maxDrawdownPct: 0, equityCurve: [] }
const boatOverview = { ...overview, equityCurve: [{ at: '2026-10-01T00:00:00.000Z', bankroll: 100000 }, { at: '2026-10-02T00:00:00.000Z', bankroll: 100100 }] }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function mockReads(purchasedBets: Bet[] = []) {
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/races/detail-race') return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    if (url === '/api/performance/experimental') return new Response(JSON.stringify({ experimentKey: 'boat-trifecta-small-sample-v1', state: 'unavailable', model: null, bankroll: { initial: 100000, available: 100000 }, metrics: { races: 0, bets: 0, stake: 0, payout: 0, profit: 0, roi: null }, decisions: [], sizing: { method: 'fractional-kelly-portfolio', perRaceCombinedCap: 1000, dailyCap: null, balanceGuard: 'nonnegative-virtual-balance' } }), { headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/api/bets')) return new Response(JSON.stringify(purchasedBets), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(url.includes('/performance/overview') ? url.includes('sport=boat') ? boatOverview : overview : []), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
function renderLayout(path: string) {
  return render(<OriginProvider><MemoryRouter initialEntries={[path]}><Routes><Route element={<Layout />}>
    <Route path="/boat" element={<div>boat page</div>} />
    <Route path="/boat/:raceId" element={<div>boat race</div>} />
    <Route path="/performance" element={<div>performance page</div>} />
  </Route></Routes></MemoryRouter></OriginProvider>)
}
it('boat main page loads only real purchases and performance without exploration', async () => {
  const fetcher = mockReads()
  render(<StrictMode><MemoryRouter><SportPage sport="boat" /></MemoryRouter></StrictMode>)
  await screen.findByText(/仮想購入はまだありません/)
  await waitFor(() => expect(screen.getByText('累計損益')).toBeTruthy())
  expect(screen.queryByText(/全国24場・仮想購入とレース結果の確認/)).toBeNull()
  expect(screen.getByRole('heading', { name: '仮想運用成績' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '全期間の仮想運用成績' })).toBeNull()
  const performance = screen.getByRole('region', { name: '全期間の仮想運用成績' })
  expect(performance.querySelector('aside')).toBeNull()
  expect(performance.textContent).toContain('損益 / 回収率は確定分')
  expect(performance.textContent).toContain('確定払戻 ÷ 確定購入額（返還除外）')
  expect(performance.className).toContain('min-w-0')
  expect(performance.querySelectorAll(':scope > *')).toHaveLength(3)
  expect([...performance.querySelectorAll('div')].some((node) => node.className.includes('h-[168px]'))).toBe(true)
  const purchaseBlock = screen.getByText(/仮想購入はまだありません/).closest('section')
  const summaryLayout = performance.parentElement
  expect(summaryLayout).toBe(purchaseBlock?.parentElement)
  expect(summaryLayout?.className).toContain('space-y-5')
  expect(summaryLayout?.className).not.toMatch(/\bgrid\b/)
  expect(performance.className).toContain('w-full')
  expect(purchaseBlock?.className).toContain('w-full')
  expect(purchaseBlock?.className).toContain('min-w-0')
  expect(screen.queryByRole('heading', { name: '購入したレース' })).toBeNull()
  expect(screen.queryByRole('group', { name: '購入履歴の期間' })).toBeNull()
  expect(screen.queryByRole('button', { name: '全期間の購入履歴' })).toBeNull()
  expect(screen.queryByText(/レースを調べる/)).toBeNull()
  expect(screen.queryByText(/レースを調べるから購入できます/)).toBeNull()
  expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual(['/api/bets?sport=boat&origin=real', '/api/performance/overview?sport=boat&origin=real'])
})
it('hides origin controls and sample notice on boat routes only', () => {
  const stored = new Map([['edgelab.origin', 'sample']])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
    removeItem: (key: string) => { stored.delete(key) },
  })
  const boat = renderLayout('/boat')
  expect(screen.getByText('boat page')).toBeTruthy()
  expect(screen.queryByText('表示データ')).toBeNull()
  expect(screen.queryByRole('group', { name: '表示データ' })).toBeNull()
  expect(screen.queryByText(/サンプルデータのみを表示中です/)).toBeNull()
  boat.unmount()
  const performance = renderLayout('/performance')
  expect(screen.getByText('performance page')).toBeTruthy()
  expect(screen.getByText('表示データ')).toBeTruthy()
  expect(screen.getByRole('group', { name: '表示データ' })).toBeTruthy()
  expect(screen.getByText(/サンプルデータのみを表示中です/)).toBeTruthy()
  performance.unmount()
})
it('keeps boat race detail links available with real-source research at race URLs', async () => {
  const fetcher = mockReads()
  render(<MemoryRouter initialEntries={['/boat/detail-race']}><Routes><Route path="/boat/:raceId" element={<SportPage sport="boat" />} /></Routes></MemoryRouter>)
  expect(await screen.findByText(/レースを調べる/, { selector: 'summary' })).toBeTruthy()
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/rankings?') && url.includes('origin=real'))).toBe(true))
  expect(fetcher.mock.calls.some(([url]) => url === '/api/races/detail-race')).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => url === '/api/bets?sport=boat&origin=real')).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => url === '/api/performance/overview?sport=boat&origin=real')).toBe(true)
})
it('board shows operational performance and only races with recorded purchases', async () => {
  const fetcher = mockReads()
  render(<StrictMode><MemoryRouter><OverviewPage /></MemoryRouter></StrictMode>)
  await screen.findByRole('heading', { name: '購入したレース' })
  expect(screen.getByRole('heading', { name: '運用成績' })).toBeTruthy()
  expect(screen.queryByText('競馬 vs ボートレースを比較')).toBeNull()
  await screen.findByText('実験用仮想残高')
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(fetcher.mock.calls.some(([url]) => /\/models|\/races\?|\/rankings|\/collection/.test(url))).toBe(false)
  expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual(['/api/bets?origin=all', '/api/performance/experimental', '/api/performance/overview?origin=all'])
})
it('board lists a bought race and links only that race to its detail', async () => {
  const bet: Bet = { id: 'bought-1', raceId: 'boat-20261011-18-07', sport: 'boat', betType: 'trifecta', selection: '1-2-3', stake: 100,
    mode: 'manual', predictedProb: 0.1, oddsAtBet: 12, expectedRoi: 0.2, edgeLabel: 'POSITIVE_EDGE', modelId: 'trifecta-test',
    placedAt: '2026-10-11T01:00:00.000Z', status: 'open', payout: null, profit: null, finalOdds: null, settledAt: null,
    dataOrigin: 'real', groupId: null, candidateRank: null, candidateCount: null, oddsCapturedAt: '2026-10-11T00:59:00.000Z',
    predictedAtAtBet: '2026-10-11T00:58:00.000Z', venueName: '徳山', raceNo: 7, raceDate: '2026-10-11' }
  mockReads([bet])
  render(<StrictMode><MemoryRouter><OverviewPage /></MemoryRouter></StrictMode>)
  const link = await screen.findByRole('link', { name: /徳山 7R/ })
  expect(link.getAttribute('href')).toBe('/boat/boat-20261011-18-07')
  expect(screen.getByText('3連単 1-2-3')).toBeTruthy()
  expect(screen.getByText('未確定 1点')).toBeTruthy()
  expect(screen.queryByText('この表示条件では仮想購入がありません。未購入レースは表示しません。')).toBeNull()
})
it('shares in-flight identical reads but refreshes settled data and separates origin', async () => {
  const fetcher = mockReads()
  await Promise.all([api.bets('real', 'boat'), api.bets('real', 'boat'), api.bets('sample', 'boat')])
  expect(fetcher).toHaveBeenCalledTimes(2)
  await api.bets('real', 'boat')
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('keeps the date controls while boat uses all purchases and horse filters by selected date', async () => {
  mockReads()
  const view = render(<MemoryRouter><SportPage sport="boat" /></MemoryRouter>)
  await screen.findByText(/仮想購入はまだありません/)
  const dateInput = view.container.querySelector<HTMLInputElement>('input[type="date"]')!
  expect(dateInput).toBeTruthy()
  expect(screen.getByRole('button', { name: '前日' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '翌日' })).toBeTruthy()
  fireEvent.change(dateInput, { target: { value: '2026-10-10' } })
  expect(dateInput.value).toBe('2026-10-10')
  expect(screen.queryByText(/この日付の仮想購入はありません/)).toBeNull()
  view.rerender(<MemoryRouter><SportPage sport="horse" /></MemoryRouter>)
  await screen.findByText(/この日付の仮想購入はありません/)
  expect(screen.queryByText(/仮想購入はまだありません/)).toBeNull()
  expect(view.container.querySelector('input[type="date"]')?.value).toBe('2026-10-10')
  view.rerender(<MemoryRouter><SportPage sport="boat" /></MemoryRouter>)
  await screen.findByText(/仮想購入はまだありません/)
  expect(screen.queryByText(/この日付の仮想購入はありません/)).toBeNull()
})
