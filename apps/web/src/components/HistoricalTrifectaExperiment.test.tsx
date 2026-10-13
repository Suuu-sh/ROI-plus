import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const { historicalTrifectaPerformance } = vi.hoisted(() => ({ historicalTrifectaPerformance: vi.fn() }))
vi.mock('../lib/api', () => ({ api: { historicalTrifectaPerformance } }))
import { HistoricalTrifectaExperiment } from './HistoricalTrifectaExperiment'

const validPerformance = {
  model: {
    experimentKey: 'boat-trifecta-historical-base-v1',
    id: 'boat-trifecta-historical-base-20261014', immutableVersion: '2026-10-14.1',
    sourceArtifactSha256: 'b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a',
    featureSchemaVersion: 'boat-base-v1', featureColumns: [], fitCount: 5,
    trainingRaces: 10508, validationRaces: 2213, testRaces: 2070,
  },
  summary: { decisions: 2, bets: 1, total_stake: 100, settled_profit: 0, open_bets: 1, available_balance: 99900 },
  decisions: [],
}
afterEach(() => cleanup())

describe('HistoricalTrifectaExperiment', () => {
  it('keeps the unverified history model distinct and displays immutable provenance', async () => {
    historicalTrifectaPerformance.mockResolvedValue(validPerformance)
    render(<HistoricalTrifectaExperiment />)
    expect(await screen.findByText('過去データ基礎モデル・未検証')).toBeTruthy()
    expect(screen.getByText(/学習 10508 \/ 校正 2213 \/ 検証 2070/)).toBeTruthy()
    expect(screen.getByText(/展示なし · 過去PIT\/ROI未証明/)).toBeTruthy()
    expect(screen.getByText('boat-trifecta-historical-base-20261014')).toBeTruthy()
    expect(screen.getByText('2026-10-14.1')).toBeTruthy()
    expect(screen.getByText('b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a')).toBeTruthy()
  })

  it('keeps compact overview metrics in two columns so cards retain readable width', async () => {
    historicalTrifectaPerformance.mockResolvedValue(validPerformance)
    render(<HistoricalTrifectaExperiment compact />)
    const [balanceLabel] = await screen.findAllByText('仮想残高')
    const grid = balanceLabel.parentElement?.parentElement
    expect(grid?.className).toContain('grid-cols-2')
    expect(grid?.className).not.toContain('md:grid-cols-4')
  })

  it('fails closed on a successful response with the wrong contract without crashing its parent page', async () => {
    historicalTrifectaPerformance.mockResolvedValue({ model: null, summary: {}, decisions: [] })
    render(<HistoricalTrifectaExperiment />)
    expect(await screen.findByText('読み込みに失敗しました：実験データの形式が不正です。')).toBeTruthy()
  })
})
