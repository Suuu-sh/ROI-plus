import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Bet } from '@edgelab/shared/src/types'
import type { ExperimentalBet } from '../src/lib/api'
import { mergePurchaseHistory } from '../src/lib/purchaseHistory'
import { PurchasedRaces, SportPage } from '../src/pages/SportPage'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ api: { bets: vi.fn(), experimentalBets: vi.fn(), historicalBets: vi.fn(), overview: vi.fn(), race: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const normal = { id: 'same-id', raceId: 'old', sport: 'boat', betType: 'win', selection: '1', stake: 100, mode: 'manual', placedAt: '2026-10-13T00:00:00Z', status: 'open', dataOrigin: 'real', venueName: '通常場', raceDate: '2026-10-13' } as Bet
const experiment: ExperimentalBet = { id: 'same-id', recordKind: 'experimental_paper', experimentKey: 'boat-trifecta-small-sample-v1', decisionId: 'd', raceId: 'new', sport: 'boat', betType: 'trifecta', selection: '1-2-3', stake: 100, predictedProb: .2, probabilityStd: null, oddsAtBet: 8, expectedRoi: .6, modelId: 'candidate', placedAt: '2026-10-14T00:00:00Z', status: 'lost', payout: 0, profit: -100, settledAt: '2026-10-14T01:00:00Z', dataOrigin: 'real', venueName: '実験場', raceNo: 2, raceDate: '2026-10-14', finalOdds: 9, officialSelection: '2-1-3' }

describe('unified purchase history', () => {
  it('sorts both ledgers chronologically without mutating source or colliding ids', () => {
    const merged = mergePurchaseHistory([normal], [experiment])
    expect(merged.map(b => b.raceId)).toEqual(['new', 'old'])
    expect(new Set(merged.map(b => b.id)).size).toBe(2)
    expect(experiment.id).toBe('same-id')
    expect(merged[0].finalOdds).toBe(9)
  })
  it('shows one history, both sources, and saved final odds / official result', () => {
    render(<MemoryRouter><PurchasedRaces bets={mergePurchaseHistory([normal], [experiment])} loading={false} error={null} onRetry={() => {}} /></MemoryRouter>)
    expect(screen.getAllByText('仮想購入履歴')).toHaveLength(1)
    expect(screen.queryByText('実験購入履歴（別台帳）')).toBeNull()
    expect(screen.queryByText('実験・通常成績対象外')).toBeNull()
    expect(screen.getByText('仮想・自動')).toBeTruthy()
    expect(screen.getByText('公式結果 三連単 2-1-3')).toBeTruthy()
    expect(screen.getByText('9.0')).toBeTruthy()
    expect(screen.getAllByRole('article').map(el => el.textContent?.slice(0, 3))).toEqual(['実験場', '通常場'])
    expect(api.race).not.toHaveBeenCalled()
  })
  it('retains void refund reason and suppresses invalid final odds', () => {
    render(<MemoryRouter><PurchasedRaces bets={mergePurchaseHistory([], [{...experiment, status: 'void', repairReason: 'invalid_stake_unit', finalOdds: 99, payout: 100, profit: 0}])} loading={false} error={null} onRetry={() => {}} /></MemoryRouter>)
    expect(screen.getByText(/返金済み（購入額が100円単位/)).toBeTruthy()
    expect(screen.getByText('対象外（無効）')).toBeTruthy()
    expect(screen.queryByText('99.0')).toBeNull()
  })
  it('fetches both former experiment ledgers for boat and renders unified cards', async () => {
    vi.mocked(api.bets).mockResolvedValue([normal])
    vi.mocked(api.experimentalBets).mockResolvedValue([experiment])
    vi.mocked(api.historicalBets).mockResolvedValue([])
    vi.mocked(api.overview).mockReturnValue(new Promise(() => {}))
    render(<MemoryRouter><SportPage sport="boat" /></MemoryRouter>)
    expect(await screen.findByText('仮想・自動')).toBeTruthy()
    expect(api.experimentalBets).toHaveBeenCalledTimes(1)
    expect(api.historicalBets).toHaveBeenCalledTimes(1)
    expect(api.bets).toHaveBeenCalledWith('real', 'boat', false)
    expect(screen.getAllByText('仮想購入履歴')).toHaveLength(1)
  })
})
