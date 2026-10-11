import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Bet, RaceDetail } from '@edgelab/shared/src/types'
import { api } from '../src/lib/api'
import { filterBetsByDate, PurchasedRace } from '../src/pages/SportPage'

vi.mock('../src/lib/api', () => ({ api: { race: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const bet: Bet = {
  id: 'b1', raceId: 'sample-race', sport: 'boat', betType: 'win', selection: '2', stake: 100,
  mode: 'manual', predictedProb: 0.4, oddsAtBet: 3.2, expectedRoi: 0.28, edgeLabel: 'POSITIVE_EDGE',
  modelId: 'model', placedAt: '2026-10-10T00:00:00Z', status: 'open', payout: null, profit: null,
  finalOdds: null, settledAt: null, dataOrigin: 'sample', groupId: null, candidateRank: 1,
  candidateCount: 3, oddsCapturedAt: null, predictedAtAtBet: null, venueName: 'テスト場', raceNo: 1, raceDate: '2026-10-10',
}
const race = (entries: RaceDetail['entries'], dataOrigin: 'sample' | 'real' = 'sample'): RaceDetail => ({
  id: bet.raceId, sport: 'boat', venueId: 'v', venueName: 'テスト場', raceDate: '2026-10-10', raceNo: 1,
  name: null, distance: null, surface: null, trackCondition: null, weather: null, windSpeed: null, waveHeight: null,
  postTime: null, status: 'finished', dataOrigin, entryCount: entries.length, topEdge: 'INSUFFICIENT_DATA',
  bestExpectedRoi: null, model: null, predictedAt: null, dataFreshnessMinutes: null, entries, tickets: [], payouts: [],
})
const openReview = () => fireEvent.click(screen.getByText('購入後の結果レビューを開く'))

describe('purchased race review', () => {
  it('keeps purchase snapshot visible and fetches outcome only when review is opened', async () => {
    vi.mocked(api.race).mockResolvedValue(race([{ number: 2, finishOrder: 1 } as RaceDetail['entries'][number]]))
    render(<MemoryRouter><PurchasedRace bets={[bet]} /></MemoryRouter>)
    expect(screen.getByText('40.0%')).toBeTruthy()
    expect(screen.getByText('3.2')).toBeTruthy()
    expect(api.race).not.toHaveBeenCalled()
    openReview()
    expect(await screen.findByText(/損益分岐確率は 31.3%/)).toBeTruthy()
    expect(screen.getByText(/補数は不的中確率60.0%/)).toBeTruthy()
    expect(screen.getByText(/サンプル結果（実績評価には含めません）/)).toBeTruthy()
  })

  it('describes a settled win using result and payout evidence', async () => {
    vi.mocked(api.race).mockResolvedValue({ ...race([{ number: 2, finishOrder: 1 } as RaceDetail['entries'][number]], 'real'), payouts: [{ betType: 'win', selection: '2', payout: 320, popularity: null }] })
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, status: 'won', payout: 320, profit: 220, dataOrigin: 'real' }]} /></MemoryRouter>)
    openReview()
    expect(await screen.findByText(/保存された精算状態は的中/)).toBeTruthy()
    expect(screen.getByText(/公式記録 320円\/100円/)).toBeTruthy()
  })

  it('describes a loss from observed finish without claiming a cause', async () => {
    vi.mocked(api.race).mockResolvedValue(race([{ number: 2, finishOrder: 2 } as RaceDetail['entries'][number], { number: 1, finishOrder: 1 } as RaceDetail['entries'][number]], 'real'))
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, status: 'lost', dataOrigin: 'real' }]} /></MemoryRouter>)
    openReview()
    expect(await screen.findByText(/保存された精算状態は不的中/)).toBeTruthy()
    expect(screen.getByText(/選択は2着。記録上の1着は1番/)).toBeTruthy()
    expect(screen.getByText(/個別の不的中から原因は特定できません/)).toBeTruthy()
  })

  it('keeps open status distinct from race observation and makes missing data clear', async () => {
    vi.mocked(api.race).mockResolvedValue(race([], 'real'))
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, dataOrigin: 'real' }]} /></MemoryRouter>)
    expect(screen.getByText('仮想購入・精算待ち')).toBeTruthy()
    openReview()
    expect(await screen.findByText(/精算状態は未確定。観測記録: 公式着順記録なし/)).toBeTruthy()
  })

  it('does not infer a void refund', () => {
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, status: 'void' }]} /></MemoryRouter>)
    expect(screen.getByText('無効')).toBeTruthy()
    expect(screen.queryByText(/返還/)).toBeNull()
  })

  it('does not treat incomplete or duplicate trifecta places as a definitive order', async () => {
    vi.mocked(api.race).mockResolvedValue(race([
      { number: 1, finishOrder: 1 } as RaceDetail['entries'][number],
      { number: 2, finishOrder: 2 } as RaceDetail['entries'][number],
      { number: 3, finishOrder: 2 } as RaceDetail['entries'][number],
    ], 'real'))
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, betType: 'trifecta', selection: '1-2-3', dataOrigin: 'real', status: 'lost' }]} /></MemoryRouter>)
    openReview()
    expect(await screen.findByText(/選択の完全な着順記録はありません/)).toBeTruthy()
    expect(screen.queryByText(/上位着順 1-2-3/)).toBeNull()
  })

  it('reuses a loaded review when closed and reopened', async () => {
    vi.mocked(api.race).mockResolvedValue(race([{ number: 2, finishOrder: 1 } as RaceDetail['entries'][number]]))
    render(<MemoryRouter><PurchasedRace bets={[bet]} /></MemoryRouter>)
    openReview()
    await screen.findByText(/サンプル結果（実績評価には含めません）/)
    fireEvent.click(screen.getByText('購入後の結果レビューを開く'))
    fireEvent.click(screen.getByText('購入後の結果レビューを開く'))
    expect(api.race).toHaveBeenCalledTimes(1)
  })

  it('filters purchase records by race date', () => {
    const other = { ...bet, id: 'b2', raceDate: '2026-10-09' }
    expect(filterBetsByDate([bet, other], '2026-10-10').map((b) => b.id)).toEqual(['b1'])
  })

  it('preserves snapshot if lazy review request fails', async () => {
    vi.mocked(api.race).mockRejectedValue(new Error('unavailable'))
    render(<MemoryRouter><PurchasedRace bets={[bet]} /></MemoryRouter>)
    openReview()
    expect(await screen.findByText(/結果記録は利用できません/)).toBeTruthy()
    expect(screen.getByText('40.0%')).toBeTruthy()
  })
})
