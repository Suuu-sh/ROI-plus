import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EntryView, RaceDetail } from '@edgelab/shared/src/types'
import { BetSheet } from '../src/components/BetSheet'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', () => ({
  api: {
    overview: vi.fn(), bets: vi.fn(), placeBetBatch: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const entry = (number: number): EntryView => ({
  number, frame: null, name: `選手${number}`, jockey: null, trainer: null, weightCarried: null, horseWeight: null,
  racerClass: null, nationalWinRate: null, localWinRate: null, motorNo: null, motor2Rate: null, boatNo: null,
  boat2Rate: null, exhibitionTime: null, startExhibition: null, odds: 2, oddsCapturedAt: null,
  probability: 0.5, probStd: 0.01, breakEvenProb: 0.5, expectedRoi: 0, conservativeRoi: -0.02,
  edge: 'NEUTRAL', finishOrder: null,
})

const race = {
  id: 'boat-20261010-01-01', sport: 'boat', venueId: '01', venueName: 'テスト場', raceDate: '2026-10-10', raceNo: 1,
  name: null, distance: null, surface: null, trackCondition: null, weather: null, windSpeed: null, waveHeight: null,
  postTime: null, status: 'scheduled', dataOrigin: 'real', entryCount: 2, topEdge: 'NEUTRAL', bestExpectedRoi: 0,
  model: null, predictedAt: null, dataFreshnessMinutes: 1, entries: [entry(1), entry(2)], payouts: [],
} as RaceDetail

describe('BetSheet', () => {
  it('submits multiple selections with independent positive integer yen stakes', async () => {
    vi.mocked(api.overview).mockResolvedValue({ initialBankroll: 1000 } as never)
    vi.mocked(api.bets).mockResolvedValue([])
    vi.mocked(api.placeBetBatch).mockResolvedValue({ groupId: 'group', bets: [{}, {}] } as never)
    const onPlaced = vi.fn()
    render(<BetSheet race={race} entry={race.entries[0]} onClose={() => {}} onPlaced={onPlaced} />)

    await screen.findByText('¥1,000')
    const second = screen.getByRole('checkbox', { name: '2番を選択' })
    fireEvent.click(second)
    fireEvent.change(screen.getByRole('spinbutton', { name: '1番の金額' }), { target: { value: '125' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '2番の金額' }), { target: { value: '51' } })
    fireEvent.click(screen.getByRole('button', { name: '2件を仮想購入' }))

    await waitFor(() => expect(api.placeBetBatch).toHaveBeenCalledWith(expect.objectContaining({
      raceId: race.id,
      selections: [{ selection: '1', stake: 125 }, { selection: '2', stake: 51 }],
    })))
    expect(api.overview).toHaveBeenCalledWith('all')
    expect(api.bets).toHaveBeenCalledWith('all')
    expect(onPlaced).toHaveBeenCalledWith(2)
  })

  it('blocks the full batch when total stakes exceed available virtual funds', async () => {
    vi.mocked(api.overview).mockResolvedValue({ initialBankroll: 100 } as never)
    vi.mocked(api.bets).mockResolvedValue([])
    render(<BetSheet race={race} entry={race.entries[0]} onClose={() => {}} onPlaced={() => {}} />)

    await screen.findByText('¥100')
    fireEvent.change(screen.getByRole('spinbutton', { name: '1番の金額' }), { target: { value: '101' } })
    expect(screen.getByRole('button', { name: '1件を仮想購入' }).hasAttribute('disabled')).toBe(true)
  })
})
