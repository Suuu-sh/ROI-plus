import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ExperimentalPerformance } from '../src/components/ExperimentalPerformance'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const payload = {
  experimentKey: 'boat-trifecta-small-sample-v1' as const,
  state: 'ready' as const,
  model: { id: 'candidate-1', status: 'candidate' as const, artifactSha256: 'abc', schemaVersion: 'boat-prerace-v2-no-weather-experimental-v1', trainedAt: '2026-10-13T00:00:00Z' },
  bankroll: { initial: 100000 as const, available: 99800 },
  metrics: { races: 1, bets: 2, stake: 200, payout: 0, profit: -200, roi: 0 },
  decisions: [{ raceId: 'boat-1', raceDate: '2026-10-13', raceNo: 1, venueName: 'テスト場', outcome: 'placed' as const, reason: null, stake: 200, modelId: 'candidate-1', decidedAt: '2026-10-13T01:00:00Z', probability: 0.2, odds: 10, uncertainty: 0.1, expectedRoi: 1 }],
  sizing: { method: 'fractional-kelly-portfolio' as const, perRaceCombinedCap: 1000 as const, dailyCap: null, balanceGuard: 'nonnegative-virtual-balance' as const },
}

describe('experimental performance separation', () => {
  it('labels the experiment and its virtual balance separately from normal performance', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ExperimentalPerformance />)
    expect(await screen.findByText('実験判断履歴')).toBeTruthy()
    expect(screen.getByText(/通常の運用成績・資産とは別の仮想台帳/)).toBeTruthy()
    expect(screen.getByText('1レース合計の購入額上限 ¥1,000 · 日次固定上限なし · 仮想残高は非負に制限')).toBeTruthy()
    expect(screen.getByText(/実験専用・未検証/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/performance/experimental', expect.any(Object))
  })
})
