import model from '../models/boat-trifecta-historical-base-20261014.json'

export type HistoricalFeatureRow = Record<string, number | null | undefined>
export type HistoricalPrediction = { selection: string; probability: number; probStd: number }

type Fit = { medians: number[]; means: number[]; scales: number[]; coefficients: number[] }
type RuntimeModel = {
  schema: string
  modelId: string
  immutableVersion: string
  sourceArtifactSha256: string
  featureSchemaVersion: string
  runtimeFeatureSchemaVersion: string
  featureColumns: string[]
  temperature: number
  fitCount: number
  trainingRaces: number
  validationRaces: number
  testRaces: number
  trainedAt: string
  fits: Fit[]
}

export const HISTORICAL_TRIFECTA_EXPERIMENT_KEY = 'boat-trifecta-historical-base-v1'
export const HISTORICAL_TRIFECTA_MODEL_ID = 'boat-trifecta-historical-base-20261014'
export const HISTORICAL_TRIFECTA_SOURCE_SHA256 = 'b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a'
export const HISTORICAL_BASE_COLUMNS = ['lane', 'national_win_rate', 'local_win_rate', 'motor_2rate', 'boat_2rate', 'national_2rate', 'local_2rate', 'age', 'weight_carried', 'racer_class_code', 'history_starts', 'history_wins', 'history_win_rate'] as const
const runtimeModel = model as RuntimeModel
const SHA256 = /^[a-f0-9]{64}$/

function validModel(): boolean {
  return runtimeModel.schema === 'roi-historical-trifecta-worker-model-v1'
    && runtimeModel.modelId === HISTORICAL_TRIFECTA_MODEL_ID
    && runtimeModel.immutableVersion === '2026-10-14.1'
    && runtimeModel.sourceArtifactSha256 === HISTORICAL_TRIFECTA_SOURCE_SHA256 && SHA256.test(runtimeModel.sourceArtifactSha256)
    && runtimeModel.featureSchemaVersion === 'boat-base-v1'
    && runtimeModel.runtimeFeatureSchemaVersion === 'boat-trifecta-historical-base-v1'
    && Number.isFinite(Date.parse(runtimeModel.trainedAt))
    && runtimeModel.featureColumns.length === HISTORICAL_BASE_COLUMNS.length
    && runtimeModel.featureColumns.every((column, index) => column === HISTORICAL_BASE_COLUMNS[index])
    && runtimeModel.fitCount === 5 && runtimeModel.fits.length === 5
    && runtimeModel.temperature === 0.85
    && runtimeModel.fits.every(fit => fit.medians.length === 13 && fit.means.length === 13
      && fit.scales.length === 13 && fit.coefficients.length === 13
      && [...fit.medians, ...fit.means, ...fit.scales, ...fit.coefficients].every(Number.isFinite)
      && fit.scales.every(value => value > 0))
}

function logSumExp(values: number[]): number {
  const max = Math.max(...values)
  return max + Math.log(values.reduce((sum, value) => sum + Math.exp(value - max), 0))
}

function memberDistribution(fit: Fit, rows: HistoricalFeatureRow[]): Map<string, number> {
  const scores = rows.map(row => runtimeModel.featureColumns.reduce((sum, name, i) => {
    const raw = row[name]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fit.medians[i]
    return sum + ((value - fit.means[i]) / fit.scales[i]) * fit.coefficients[i]
  }, 0) / Math.max(0.05, runtimeModel.temperature))
  const result = new Map<string, number>()
  const all = [0, 1, 2, 3, 4, 5]
  for (const a of all) for (const b of all) for (const c of all) {
    if (a === b || a === c || b === c) continue
    const afterFirst = all.filter(index => index !== a)
    const afterSecond = afterFirst.filter(index => index !== b)
    const logProbability = scores[a] - logSumExp(scores)
      + scores[b] - logSumExp(afterFirst.map(index => scores[index]))
      + scores[c] - logSumExp(afterSecond.map(index => scores[index]))
    result.set(`${a + 1}-${b + 1}-${c + 1}`, Math.exp(logProbability))
  }
  const total = [...result.values()].reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || total <= 0) throw new Error('historical model produced invalid distribution')
  for (const [selection, value] of result) result.set(selection, value / total)
  return result
}

/** Exact five-fit port of the offline sklearn + Plackett-Luce runtime. */
export function predictHistoricalTrifecta(rows: HistoricalFeatureRow[]): HistoricalPrediction[] {
  if (!validModel()) throw new Error('historical runtime model metadata or weight schema is invalid')
  if (rows.length !== 6 || rows.some((row, i) => row.lane !== i + 1)) {
    throw new Error('historical model requires the six ordered lanes')
  }
  const members = runtimeModel.fits.map(fit => memberDistribution(fit, rows))
  const predictions: HistoricalPrediction[] = []
  for (const [selection, firstFit] of members[0]) {
    const values = members.map(member => member.get(selection)!)
    const probability = values.reduce((sum, value) => sum + value, 0) / values.length
    const probStd = Math.sqrt(values.reduce((sum, value) => sum + (value - probability) ** 2, 0) / values.length)
    if (!Number.isFinite(firstFit) || !Number.isFinite(probability) || !Number.isFinite(probStd)) {
      throw new Error('historical model produced non-finite prediction')
    }
    predictions.push({ selection, probability, probStd })
  }
  predictions.sort((a, b) => a.selection.localeCompare(b.selection))
  const total = predictions.reduce((sum, prediction) => sum + prediction.probability, 0)
  if (predictions.length !== 120 || Math.abs(total - 1) > 1e-10) {
    throw new Error('historical model failed complete 120-ticket normalization')
  }
  return predictions
}

export function historicalTrifectaModelMetadata() {
  return {
    experimentKey: HISTORICAL_TRIFECTA_EXPERIMENT_KEY,
    id: runtimeModel.modelId,
    immutableVersion: runtimeModel.immutableVersion,
    sourceArtifactSha256: runtimeModel.sourceArtifactSha256,
    featureSchemaVersion: runtimeModel.featureSchemaVersion,
    runtimeFeatureSchemaVersion: runtimeModel.runtimeFeatureSchemaVersion,
    featureColumns: runtimeModel.featureColumns,
    fitCount: runtimeModel.fitCount,
    trainingRaces: runtimeModel.trainingRaces,
    validationRaces: runtimeModel.validationRaces,
    testRaces: runtimeModel.testRaces,
    trainedAt: runtimeModel.trainedAt,
    candidateKind: 'historical-base-experimental-only',
    evaluationQualified: false,
    promotionEligible: false,
    pointInTimeEvidenceComplete: false,
    profitabilityProven: false,
    exhibitionFeaturesUsed: false,
    selectionProfile: 'dedicated-virtual-experiment-only',
  } as const
}
