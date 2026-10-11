import type { BetType, EdgeLabel, ModelStatus } from './types';

export const DEFAULT_MAX_PROB_STD = 0.05;

/** Canonical selection syntax: combinations sorted, permutations left ordered. */
export function canonicalTicketSelection(betType: BetType, selection: string): string | null {
  if (!['win', 'place', 'quinella', 'exacta', 'wide', 'trio', 'trifecta'].includes(betType)) return null;
  const parts = selection.split('-');
  const sizes: Record<BetType, number> = { win: 1, place: 1, quinella: 2, exacta: 2, wide: 2, trio: 3, trifecta: 3 };
  if (parts.length !== sizes[betType] || parts.some(x => !/^[1-9]\d*$/.test(x))) return null;
  const numbers = parts.map(Number);
  if (numbers.some(n => !Number.isSafeInteger(n)) || new Set(numbers).size !== numbers.length) return null;
  if (['quinella', 'wide', 'trio'].includes(betType)) numbers.sort((a,b) => a-b);
  return numbers.join('-');
}

/** Strict ticket probability completeness check; incomplete sets are not EV distributions. */
export function isCompleteTicketDistribution(
  betType: BetType,
  runnerNumbers: readonly number[],
  selections: readonly string[],
  probabilities: readonly number[],
  tolerance = 1e-6,
): boolean {
  const sizes: Partial<Record<BetType, number>> = { win: 1, place: 1, quinella: 2, exacta: 2, wide: 2, trio: 3, trifecta: 3 };
  const size = sizes[betType];
  if (!size || runnerNumbers.length < size || selections.length !== probabilities.length) return false;
  const expected = new Set<string>();
  const visit = (prefix: number[], remaining: number[]) => {
    if (prefix.length === size) {
      const canonical = canonicalTicketSelection(betType, prefix.join('-'));
      if (canonical) expected.add(canonical);
      return;
    }
    for (let i = 0; i < remaining.length; i++) visit([...prefix, remaining[i]], [...remaining.slice(0,i), ...remaining.slice(i+1)]);
  };
  visit([], [...runnerNumbers].sort((a,b) => a-b));
  const actual = new Set<string>();
  for (const selection of selections) {
    const canonical = canonicalTicketSelection(betType, selection);
    if (!canonical || canonical !== selection || actual.has(canonical)) return false;
    actual.add(canonical);
  }
  return actual.size === expected.size && [...expected].every(x => actual.has(x))
    && probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(probabilities.reduce((sum,p) => sum + p, 0) - 1) <= tolerance;
}

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
