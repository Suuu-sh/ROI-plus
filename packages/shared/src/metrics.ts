/** Binary log loss; probabilities are clipped only to keep log(0) finite. */
export function logLoss(probabilities: readonly number[], outcomes: readonly (0 | 1 | boolean)[]): number {
  assertSameLength(probabilities, outcomes);
  if (probabilities.length === 0) return Number.NaN;
  const epsilon = 1e-15;
  const loss = probabilities.reduce((sum, probability, index) => {
    assertProbability(probability);
    const p = Math.min(1 - epsilon, Math.max(epsilon, probability));
    const outcome = outcomes[index] === true || outcomes[index] === 1 ? 1 : 0;
    return sum - (outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
  }, 0);
  return loss / probabilities.length;
}

/** Mean squared error for binary outcomes (Brier score). */
export function brierScore(probabilities: readonly number[], outcomes: readonly (0 | 1 | boolean)[]): number {
  assertSameLength(probabilities, outcomes);
  if (probabilities.length === 0) return Number.NaN;
  return probabilities.reduce((sum, probability, index) => {
    assertProbability(probability);
    const outcome = outcomes[index] === true || outcomes[index] === 1 ? 1 : 0;
    return sum + (probability - outcome) ** 2;
  }, 0) / probabilities.length;
}

/** Expected calibration error using equal-width probability bins. */
export function expectedCalibrationError(
  probabilities: readonly number[],
  outcomes: readonly (0 | 1 | boolean)[],
  binCount = 10,
): number {
  assertSameLength(probabilities, outcomes);
  if (!Number.isInteger(binCount) || binCount < 1) throw new RangeError('binCount must be a positive integer');
  if (probabilities.length === 0) return Number.NaN;
  const counts = Array.from({ length: binCount }, () => 0);
  const probabilitySums = Array.from({ length: binCount }, () => 0);
  const outcomeSums = Array.from({ length: binCount }, () => 0);
  probabilities.forEach((probability, index) => {
    assertProbability(probability);
    const bin = Math.min(binCount - 1, Math.floor(probability * binCount));
    counts[bin] += 1;
    probabilitySums[bin] += probability;
    outcomeSums[bin] += outcomes[index] === true || outcomes[index] === 1 ? 1 : 0;
  });
  return counts.reduce((error, count, bin) => count === 0
    ? error
    : error + (count / probabilities.length) * Math.abs(probabilitySums[bin] / count - outcomeSums[bin] / count), 0);
}

/** Maximum peak-to-trough drawdown for a sequence of bankroll/equity values. */
export function maxDrawdown(values: readonly number[]): { amount: number; pct: number } {
  let peak = 0;
  let amount = 0;
  let pct = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError('Asset values must be finite');
    peak = Math.max(peak, value);
    const current = peak - value;
    amount = Math.max(amount, current);
    if (peak > 0) pct = Math.max(pct, current / peak);
  }
  return { amount, pct };
}

/** Return on investment expressed as total payout divided by total stake. */
export function roi(stake: number, payout: number): number | null {
  if (!Number.isFinite(stake) || !Number.isFinite(payout) || stake < 0 || payout < 0) {
    throw new RangeError('Stake and payout must be finite non-negative numbers');
  }
  return stake === 0 ? null : payout / stake;
}

function assertSameLength(a: readonly unknown[], b: readonly unknown[]): void {
  if (a.length !== b.length) throw new RangeError('probabilities and outcomes must have the same length');
}

function assertProbability(probability: number): void {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError('Probabilities must be finite numbers between 0 and 1');
  }
}
