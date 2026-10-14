import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { overview } = vi.hoisted(() => ({ overview: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { overview } }))
vi.mock('../components/EquityChart', () => ({ EquityChart: ({ data }: { data: Array<{ bankroll: number }> }) => <div data-testid="profit-chart">{data.map((point) => point.bankroll).join(',')}</div> }))

import { SportPerformance } from './SportPage'

const stats = (profit: number, bets: number, settled: number, curve: number[]) => ({
  initialBankroll: 100000, bankroll: 100000, totalProfit: profit, roi: null, betCount: bets, settledCount: settled,
  hitRate: null, maxDrawdown: 0, maxDrawdownPct: 0, equityCurve: curve.map((bankroll, i) => ({ at: `2026-10-14T0${i}:00:00Z`, bankroll })),
})

describe('SportPerformance', () => {
  beforeEach(() => { overview.mockReset() })

  it('updates cumulative metrics and chart when the parent refreshes after settlement', async () => {
    overview.mockResolvedValueOnce(stats(0, 1, 0, [0]))
      .mockResolvedValueOnce(stats(-100, 1, 1, [0, -100]))
    const { rerender } = render(<SportPerformance origin="real" sport="boat" version={0} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(overview).toHaveBeenCalledTimes(1)
    expect(screen.getByText('累計損益推移')).toBeTruthy()
    expect(screen.queryByTestId('profit-chart')).toBeNull()

    rerender(<SportPerformance origin="real" sport="boat" version={1} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(overview).toHaveBeenCalledTimes(2)
    expect(overview.mock.calls[1]).toEqual(['real', 'boat', true, 'purchase-history'])
    expect(screen.getByTestId('profit-chart').textContent).toBe('0,-100')
  })
})
