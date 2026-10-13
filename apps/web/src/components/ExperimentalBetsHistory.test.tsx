import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ExperimentalBet } from '../lib/api'

const { experimentalBets } = vi.hoisted(() => ({ experimentalBets: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { experimentalBets } }))

import { ExperimentalBetsHistory } from './ExperimentalBetsHistory'

describe('ExperimentalBetsHistory', () => {
  it('shows ticket-level experimental purchase separately for the example race and stake', async () => {
    const bet: ExperimentalBet = {
      id: 'experimental-ticket-1', recordKind: 'experimental_paper', experimentKey: 'boat-trifecta-small-sample-v1', decisionId: 'decision-1',
      raceId: 'boat-20261013-04-12', sport: 'boat', betType: 'trifecta', selection: '1-2-3', stake: 100,
      predictedProb: 0.12, probabilityStd: 0.02, oddsAtBet: 9.5, expectedRoi: 0.14, modelId: 'experimental-model',
      placedAt: '2026-10-13T03:00:00.000Z', status: 'open', payout: null, profit: null, settledAt: null,
      dataOrigin: 'real', venueName: '平和島', raceNo: 12, raceDate: '2026-10-13',
      officialSelection: null,
    }
    experimentalBets.mockResolvedValue([bet])

    render(<MemoryRouter><ExperimentalBetsHistory compact /></MemoryRouter>)

    expect(await screen.findByText(/実験購入履歴（別台帳）/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /boat-20261013-04-12|平和島 12R/ })).toBeTruthy()
    expect(screen.getByText('実験')).toBeTruthy()
    expect(screen.getByText('三連単 1-2-3')).toBeTruthy()
    expect(screen.getByText('¥100')).toBeTruthy()
    expect(screen.getByText('公式結果 未取得')).toBeTruthy()
    expect(screen.getByText(/通常の購入履歴・残高・成績とは別/)).toBeTruthy()
  })

  it('labels repaired legacy stakes as void and refunded', async () => {
    const bet: ExperimentalBet = {
      id: 'experimental-ticket-legacy', recordKind: 'experimental_paper', experimentKey: 'boat-trifecta-small-sample-v1', decisionId: 'decision-legacy',
      raceId: 'boat-20261013-04-12', sport: 'boat', betType: 'trifecta', selection: '1-2-3', stake: 22,
      predictedProb: 0.12, probabilityStd: 0.02, oddsAtBet: 9.5, expectedRoi: 0.14, modelId: 'experimental-model',
      placedAt: '2026-10-13T03:00:00.000Z', status: 'void', repairReason: 'invalid_stake_unit', payout: 22, profit: 0, settledAt: '2026-10-13T04:00:00.000Z',
      dataOrigin: 'real', venueName: '平和島', raceNo: 12, raceDate: '2026-10-13',
      officialSelection: '4-1-3',
    }
    experimentalBets.mockResolvedValue([bet])

    render(<MemoryRouter><ExperimentalBetsHistory compact /></MemoryRouter>)

    expect(await screen.findByText('無効（返金）')).toBeTruthy()
    expect(screen.getByText(/返金済み · 購入額が100円単位の条件を満たさないため/)).toBeTruthy()
    expect(screen.getByText('無効化した旧記録額')).toBeTruthy()
    expect(screen.queryByText('invalid_stake_unit')).toBeNull()
    expect(screen.getByText('¥22')).toBeTruthy()
    expect(screen.getByText('公式結果 三連単 4-1-3')).toBeTruthy()
  })
})
