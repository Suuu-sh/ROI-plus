import { describe, expect, it } from 'vitest'
import { predictHistoricalTrifecta, historicalTrifectaModelMetadata, HISTORICAL_BASE_COLUMNS } from '../src/services/historicalTrifectaModel.js'

const rows = Array.from({ length: 6 }, (_, index) => {
  const lane = index + 1
  return {
    lane,
    national_win_rate: 3.1 + lane * 0.43,
    local_win_rate: 2.4 + lane * 0.67,
    motor_2rate: 27 + lane * 2.7,
    boat_2rate: 29 + lane * 1.9,
    national_2rate: 31 + lane * 1.1,
    local_2rate: 28 + lane * 0.9,
    age: 25 + lane * 2,
    weight_carried: 48 + lane * 0.5,
    racer_class_code: lane % 4 + 1,
    history_starts: lane * 13,
    history_wins: lane % 3,
    history_win_rate: (lane % 3) / (lane * 13),
  }
})

describe('historical trifecta static model', () => {
  it('reproduces source pickle five-fit mean/std references and 120 normalized exact outcomes', () => {
    const predictions = predictHistoricalTrifecta(rows)
    const bySelection = new Map(predictions.map(p => [p.selection, p]))
    expect(predictions).toHaveLength(120)
    expect(predictions.reduce((sum, p) => sum + p.probability, 0)).toBeCloseTo(1, 12)
    expect(bySelection.get('1-2-3')?.probability).toBeCloseTo(0.011004699959540454, 13)
    expect(bySelection.get('1-2-3')?.probStd).toBeCloseTo(0.00053612099511456, 13)
    expect(bySelection.get('3-1-6')?.probability).toBeCloseTo(0.010747264249667746, 13)
    expect(bySelection.get('6-5-4')?.probability).toBeCloseTo(0.0060063996173255405, 13)
    expect(bySelection.get('6-5-4')?.probStd).toBeCloseTo(0.0003189998450305988, 13)
    expect(predictHistoricalTrifecta(rows.map((row, index) => ({ ...row, exhibition_time: index + 5, weather: index * 100 }))))
      .toEqual(predictions)
  })

  it('publishes immutable provenance and never claims qualification or profitability', () => {
    const metadata = historicalTrifectaModelMetadata()
    expect(metadata.id).toBe('boat-trifecta-historical-base-20261014')
    expect(metadata.immutableVersion).toBe('2026-10-14.1')
    expect(metadata.sourceArtifactSha256).toBe('b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a')
    expect(metadata.featureColumns).toEqual(HISTORICAL_BASE_COLUMNS)
    expect(metadata.runtimeFeatureSchemaVersion).toBe('boat-trifecta-historical-base-v1')
    expect(metadata.trainedAt).toBe('2026-10-13T16:21:26.363521+00:00')
    expect(metadata.exhibitionFeaturesUsed).toBe(false)
    expect(metadata.evaluationQualified).toBe(false)
    expect(metadata.promotionEligible).toBe(false)
    expect(metadata.profitabilityProven).toBe(false)
  })

  it('rejects incomplete and misordered boat inputs', () => {
    expect(() => predictHistoricalTrifecta(rows.slice(0, 5))).toThrow(/six ordered lanes/)
    expect(() => predictHistoricalTrifecta([rows[1], rows[0], ...rows.slice(2)])).toThrow(/six ordered lanes/)
  })
})
