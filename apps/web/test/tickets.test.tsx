import { describe, expect, it } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { BetSheet } from '../src/components/BetSheet'
import { BetsTable } from '../src/components/BetsTable'
import { api } from '../src/lib/api'
import type { Bet, RaceDetail, TicketCandidate } from '@edgelab/shared/src/types'
import { vi } from 'vitest'

const ticket = { betType: 'trifecta', selection: '1-3-2', probability: .1, probStd: .01, odds: 15, oddsCapturedAt: '2026-10-10T10:05:00+09:00', expectedRoi: .5, conservativeRoi: .35, edge: 'POSITIVE_EDGE', buyEligible: true } as TicketCandidate
const race = { id: 'boat-test', venueName: 'テスト', raceNo: 1 } as RaceDetail

describe('ticket virtual purchase', () => {
  it('records the ordered selection and exact ticket type, never win', async () => {
    const place = vi.spyOn(api, 'placeBet').mockResolvedValue({} as Bet)
    const ui = render(<BetSheet race={race} ticket={ticket} onClose={() => {}} onPlaced={() => {}} />)
    expect(ui.container.textContent).toContain('仮想購入・3連単')
    expect(ui.container.textContent).toContain('1-3-2')
    expect(ui.container.textContent).toContain('10:05 取得')
    fireEvent.click(ui.getByText('仮想購入する'))
    await waitFor(() => expect(place).toHaveBeenCalledWith({ raceId: 'boat-test', betType: 'trifecta', selection: '1-3-2', stake: 100 }))
    ui.unmount(); place.mockRestore()
  })
  it('does not permit an ineligible ticket and labels recorded ticket history accurately', () => {
    const ui = render(<BetSheet race={race} ticket={{ ...ticket, buyEligible: false }} onClose={() => {}} onPlaced={() => {}} />)
    expect((ui.getByText('仮想購入する') as HTMLButtonElement).disabled).toBe(true)
    ui.unmount()
    const history = render(<BetsTable bets={[{ id: 'x', raceId: 'test', sport: 'boat', betType: 'trifecta', selection: '1-3-2', stake: 100, mode: 'manual', status: 'open', dataOrigin: 'real', edgeLabel: 'POSITIVE_EDGE', oddsAtBet: 15, oddsCapturedAt: '2026-10-10T10:05:00+09:00', placedAt: '2026-10-10T10:00:00Z' } as Bet]} />)
    expect(history.container.textContent).toContain('3連単 1-3-2')
    expect(history.container.textContent).toContain('取得オッズ / 払戻換算')
    expect(history.container.textContent).toContain('取得 10/10 10:05')
  })
})
