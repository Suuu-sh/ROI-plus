import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Bet, RaceDetail } from '@edgelab/shared/src/types'
import { api } from '../src/lib/api'
import { filterBetsByDate, PurchasedRace, PurchasedRaces } from '../src/pages/SportPage'

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
  it('shows differing saved purchase and payout-converted final odds side by side without requesting results', () => {
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, status: 'won', oddsAtBet: 3.2, finalOdds: 4.5, payout: 450, profit: 350 }]} /></MemoryRouter>)
    const purchase = screen.getByText('購入時オッズ').parentElement!
    const final = screen.getByText('確定オッズ（払戻換算）').parentElement!
    expect(purchase.parentElement).toBe(final.parentElement)
    expect(within(purchase).getByText('3.2')).toBeTruthy()
    expect(within(final).getByText('4.5')).toBeTruthy()
    expect(screen.getByText('SAMPLE')).toBeTruthy()
    expect(screen.getByRole('link', { name: '出走表を見る →' }).getAttribute('href')).toBe('/boat/sample-race')
    expect(api.race).not.toHaveBeenCalled()
  })

  it.each(['open', 'won', 'lost', 'void'] as const)('does not fabricate final odds for %s records', (status) => {
    render(<MemoryRouter><PurchasedRace bets={[{ ...bet, status, oddsAtBet: null, finalOdds: status === 'void' ? 0 : null, payout: status === 'lost' || status === 'void' ? 0 : null }]} /></MemoryRouter>)
    expect(within(screen.getByText('購入時オッズ').parentElement!).getByText('記録なし')).toBeTruthy()
    const final = within(screen.getByText('確定オッズ（払戻換算）').parentElement!)
    expect(final.getByText(status === 'void' ? '対象外（無効）' : status === 'open' ? '未記録 / 精算待ち' : '記録なし')).toBeTruthy()
    expect(final.queryByText('0.0')).toBeNull()
    expect(api.race).not.toHaveBeenCalled()
  })

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

  it('groups multiple selections into a horizontal rail and opens only the requested review', async () => {
    vi.mocked(api.race).mockResolvedValue(race([]))
    render(<MemoryRouter><PurchasedRaces bets={[bet, { ...bet, id: 'b2', selection: '3' }, { ...bet, id: 'b3', raceId: 'other', venueName: null }]} loading={false} error={null} onRetry={vi.fn()} /></MemoryRouter>)
    const rail = screen.getByRole('region', { name: '購入レースの横スクロール' })
    expect(screen.queryByRole('heading', { name: '購入したレース' })).toBeNull()
    expect(screen.queryByText(/レース・横にスワイプして確認/)).toBeNull()
    expect(screen.queryByText(/確定オッズは保存払戻の換算値/)).toBeNull()
    expect(screen.queryByRole('group', { name: '購入履歴の期間' })).toBeNull()
    expect(screen.queryByRole('button', { name: '前の購入レース' })).toBeNull()
    expect(screen.queryByRole('button', { name: '次の購入レース' })).toBeNull()
    expect(rail.querySelectorAll('article')).toHaveLength(2)
    expect(screen.getByText('2026-10-10・このレースの購入 2件')).toBeTruthy()
    expect(screen.getByText('other 1R')).toBeTruthy()
    const scrollBy = vi.fn()
    Object.defineProperty(rail, 'scrollBy', { value: scrollBy })
    fireEvent.keyDown(rail, { key: 'ArrowRight' })
    expect(scrollBy).toHaveBeenCalledOnce()
    fireEvent.scroll(rail)
    expect(api.race).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByText('購入後の結果レビューを開く')[1])
    await screen.findByText(/サンプル結果（実績評価には含めません）/)
    expect(api.race).toHaveBeenCalledTimes(1)
    expect(api.race).toHaveBeenCalledWith('other')
  })

  it('keeps multi-ticket cards compact with a keyboard-focusable scrollable snapshot area', () => {
    render(<MemoryRouter><PurchasedRace bets={Array.from({ length: 6 }, (_, index) => ({ ...bet, id: `b${index}`, selection: String(index + 1) }))} /></MemoryRouter>)
    const snapshots = screen.getByLabelText('このレースの購入明細')
    expect(snapshots.tabIndex).toBe(0)
    expect(snapshots.className).toContain('max-h-[300px]')
    expect(snapshots.querySelectorAll('dl')).toHaveLength(12)
    expect(screen.getByText('購入明細は上下にスクロールできます')).toBeTruthy()
    expect(api.race).not.toHaveBeenCalled()
  })

  it('preserves date filtering and empty, loading, and error states', () => {
    const props = { bets: [bet], date: '2026-10-09', loading: false, error: null, onRetry: vi.fn() }
    const view = render(<MemoryRouter><PurchasedRaces {...props} /></MemoryRouter>)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByText(/この日付の仮想購入はありません/)).toBeTruthy()
    expect(screen.queryByText(/レースを調べるから購入できます/)).toBeNull()
    view.rerender(<MemoryRouter><PurchasedRaces {...props} bets={null} loading /></MemoryRouter>)
    expect(screen.queryByText(/この日付の仮想購入はありません/)).toBeNull()
    view.rerender(<MemoryRouter><PurchasedRaces {...props} error={new Error('unavailable')} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /再試行/ }))
    expect(props.onRetry).toHaveBeenCalledOnce()
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
