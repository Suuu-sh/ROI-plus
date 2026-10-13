import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ExperimentalPerformance as ExperimentalPerformanceData } from '../lib/api'

const { experimentalPerformance } = vi.hoisted(() => ({ experimentalPerformance: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { experimentalPerformance } }))

import { ExperimentalPerformance } from './ExperimentalPerformance'

describe('ExperimentalPerformance', () => {
  it('renders refunded decisions with a localized reason instead of a skip label', async () => {
    const data: ExperimentalPerformanceData = {
      experimentKey: 'boat-trifecta-small-sample-v1', state: 'ready', model: null,
      bankroll: { initial: 100000, available: 100000 },
      metrics: { races: 1, bets: 0, stake: 0, payout: 0, profit: 0, roi: null },
      comparison: { actual: { tickets: 2, stake: 300, payout: 500, profit: 200, roi: 500 / 300 }, fixed100: { tickets: 2, stake: 200, payout: 400, profit: 200, roi: 2 }, settledRaceCount: 1, pendingRaceCount: 1, excludedRaceCount: 0 },
      sizing: { method: 'fractional-kelly-portfolio', perRaceCombinedCap: 1000, dailyCap: null, balanceGuard: 'nonnegative-virtual-balance' },
      decisions: [{
        raceId: 'boat-20261013-04-12', raceDate: '2026-10-13', raceNo: 12, venueName: '平和島',
        outcome: 'void', reason: 'invalid_stake_unit', stake: 0, modelId: 'experimental-model',
        decidedAt: '2026-10-13T04:00:00.000Z', probability: null, odds: null, uncertainty: null, expectedRoi: null,
      }],
    }
    experimentalPerformance.mockResolvedValue(data)

    render(<ExperimentalPerformance />)

    expect(await screen.findByText(/無効（返金） · 購入額が100円単位の条件を満たさないため/)).toBeTruthy()
    expect(screen.queryByText(/見送り.*invalid_stake_unit/)).toBeNull()
    expect(screen.getByText('固定100円/選択')).toBeTruthy()
    expect(screen.getByText(/投資総額が異なるため同額予算比較ではなく/)).toBeTruthy()
    expect(screen.getByText(/保留中 1 レース/)).toBeTruthy()
  })
})
