import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, fireEvent, screen, waitFor } from '@testing-library/react'
import { BetSheet } from '../src/components/BetSheet'
import { BetsTable } from '../src/components/BetsTable'
import { api } from '../src/lib/api'
import type { Bet, RaceDetail, TicketCandidate } from '@edgelab/shared/src/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

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
    await waitFor(() => expect(place).toHaveBeenCalledWith(expect.objectContaining({
      raceId: 'boat-test', betType: 'trifecta', selection: '1-3-2', stake: 100, requestId: expect.any(String),
    })))
    ui.unmount()
  })
  it('reuses the request ID after a lost response and no-op amount clicks', async () => {
    const committed = new Map<string, Bet>()
    const place = vi.spyOn(api, 'placeBet').mockImplementation(async (request) => {
      const existing = committed.get(request.requestId)
      if (existing) return existing
      committed.set(request.requestId, { id: 'saved-bet' } as Bet)
      throw new Error('server committed; response was lost')
    })
    const onPlaced = vi.fn()
    render(<BetSheet race={race} ticket={ticket} onClose={() => {}} onPlaced={onPlaced} />)

    fireEvent.click(screen.getByRole('button', { name: '仮想購入する' }))
    await screen.findByText('仮想購入に失敗しました')
    const originalRequestId = place.mock.calls[0][0].requestId

    fireEvent.click(screen.getByRole('button', { name: '減らす' }))
    fireEvent.click(screen.getByRole('button', { name: '¥100' }))
    expect(screen.getByText('¥100', { selector: 'span' })).toBeTruthy()
    expect(place).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '仮想購入する' }))
    await waitFor(() => expect(onPlaced).toHaveBeenCalledTimes(1))
    expect(place).toHaveBeenCalledTimes(2)
    expect(place.mock.calls[1][0]).toMatchObject({ requestId: originalRequestId, stake: 100 })
    expect(committed.size).toBe(1)
  })
  it('disables and ignores ticket amount controls while a request is in flight', async () => {
    let resolvePending!: (bet: Bet) => void
    const pending = new Promise<Bet>((resolve) => { resolvePending = resolve })
    const place = vi.spyOn(api, 'placeBet').mockReturnValue(pending)
    const onPlaced = vi.fn()
    render(<BetSheet race={race} ticket={ticket} onClose={() => {}} onPlaced={onPlaced} />)

    fireEvent.click(screen.getByRole('button', { name: '仮想購入する' }))
    await waitFor(() => expect(place).toHaveBeenCalledTimes(1))
    const decrease = screen.getByRole('button', { name: '減らす' }) as HTMLButtonElement
    const increase = screen.getByRole('button', { name: '増やす' }) as HTMLButtonElement
    const preset = screen.getByRole('button', { name: '¥500' }) as HTMLButtonElement
    expect(decrease.disabled).toBe(true)
    expect(increase.disabled).toBe(true)
    expect(preset.disabled).toBe(true)
    fireEvent.click(increase)
    fireEvent.click(preset)
    expect(screen.getByText('¥100', { selector: 'span' })).toBeTruthy()
    expect(place.mock.calls[0][0].stake).toBe(100)

    resolvePending({} as Bet)
    await waitFor(() => expect(onPlaced).toHaveBeenCalledTimes(1))
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
