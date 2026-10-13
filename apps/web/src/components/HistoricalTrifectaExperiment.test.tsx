import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { historicalTrifectaPerformance } = vi.hoisted(() => ({ historicalTrifectaPerformance: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { historicalTrifectaPerformance } }))
import { HistoricalTrifectaExperiment } from './HistoricalTrifectaExperiment'

describe('HistoricalTrifectaExperiment', () => {
  it('keeps the unverified history model distinct and displays immutable provenance', async () => {
    historicalTrifectaPerformance.mockResolvedValue({
      model: {
        id: 'boat-trifecta-historical-base-20261014', immutableVersion: '2026-10-14.1',
        sourceArtifactSha256: 'b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a',
        trainingRaces: 10508, validationRaces: 2213, testRaces: 2070,
      },
      summary: { decisions: 2, bets: 1, total_stake: 100, open_bets: 1, available_balance: 99900 },
      decisions: [],
    })
    render(<HistoricalTrifectaExperiment />)
    expect(await screen.findByText('過去データ基礎モデル・未検証')).toBeTruthy()
    expect(screen.getByText(/学習 10508 \/ 校正 2213 \/ 検証 2070/)).toBeTruthy()
    expect(screen.getByText(/展示なし · 過去PIT\/ROI未証明/)).toBeTruthy()
    expect(screen.getByText('boat-trifecta-historical-base-20261014')).toBeTruthy()
    expect(screen.getByText('2026-10-14.1')).toBeTruthy()
    expect(screen.getByText('b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a')).toBeTruthy()
  })
})
