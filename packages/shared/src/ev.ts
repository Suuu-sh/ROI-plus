import type { EdgeLabel, ModelStatus } from './types';

export const DEFAULT_MAX_PROB_STD = 0.05;

/** Expected return per unit stake, expressed as a fraction (0.05 = +5%). */
export function expectedRoi(p: number | null | undefined, odds: number | null | undefined): number | null {
  if (!isValidProbability(p) || !isValidOdds(odds)) return null;
  return p * odds - 1;
}

export function breakEvenProb(odds: number | null | undefined): number | null {
  if (!isValidOdds(odds)) return null;
  return 1 / odds;
}

export function conservativeRoi(
  p: number | null | undefined,
  std: number | null | undefined,
  odds: number | null | undefined,
): number | null {
  if (!isValidProbability(p) || !isValidStd(std) || !isValidOdds(odds)) return null;
  return (p - std) * odds - 1;
}

/** Normalize non-negative finite weights to a probability distribution. */
export function normalizeProbs(ps: readonly number[]): number[] {
  if (ps.some((p) => !Number.isFinite(p) || p < 0)) {
    throw new RangeError('Probabilities must be finite, non-negative numbers');
  }
  const total = ps.reduce((sum, p) => sum + p, 0);
  if (total === 0) return ps.map(() => 0);
  return ps.map((p) => p / total);
}

/** Apply the specification's data sufficiency and edge thresholds. */
export function edgeLabel(
  p: number | null | undefined,
  odds: number | null | undefined,
  modelStatus: ModelStatus | null | undefined,
  std: number | null | undefined,
  maxProbStd = DEFAULT_MAX_PROB_STD,
): EdgeLabel {
  if (!isValidProbability(p) || !isValidOdds(odds) || !modelStatus || modelStatus === 'untrained') {
    return 'INSUFFICIENT_DATA';
  }
  if (!isValidStd(std) || !Number.isFinite(maxProbStd) || maxProbStd < 0 || std > maxProbStd) {
    return 'INSUFFICIENT_DATA';
  }
  const conservative = conservativeRoi(p, std, odds)!;
  if (conservative >= 0.20) return 'HIGH_EDGE';
  if (conservative >= 0.05) return 'POSITIVE_EDGE';
  if (expectedRoi(p, odds)! >= -0.05) return 'NEUTRAL';
  return 'NEGATIVE_EDGE';
}

function isValidProbability(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidOdds(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function isValidStd(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}
