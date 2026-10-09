import { describe, expect, it } from 'vitest';
import { breakEvenProb, conservativeRoi, edgeLabel, expectedRoi, normalizeProbs } from '../src/ev';
import { brierScore, expectedCalibrationError, logLoss, maxDrawdown, roi } from '../src/metrics';

describe('EV helpers', () => {
  it('calculates expected return and break-even probability', () => {
    expect(expectedRoi(0.25, 5)).toBe(0.25);
    expect(expectedRoi(0.4, 3)).toBeCloseTo(0.2);
    expect(breakEvenProb(4)).toBe(0.25);
    expect(conservativeRoi(0.25, 0.05, 5)).toBeCloseTo(0);
  });

  it('normalizes probabilities and handles an all-zero input', () => {
    expect(normalizeProbs([2, 1])).toEqual([2 / 3, 1 / 3]);
    expect(normalizeProbs([0, 0])).toEqual([0, 0]);
    expect(() => normalizeProbs([1, -1])).toThrow(RangeError);
  });

  it('classifies edge using conservative EV and the default uncertainty limit', () => {
    expect(edgeLabel(0.5, 4, 'active', 0.05)).toBe('HIGH_EDGE');
    expect(edgeLabel(0.3, 4, 'candidate', 0.01)).toBe('POSITIVE_EDGE');
    expect(edgeLabel(0.24, 4, 'active', 0)).toBe('NEUTRAL');
    expect(edgeLabel(0.1, 4, 'active', 0)).toBe('NEGATIVE_EDGE');
    expect(edgeLabel(0.8, 4, 'active', 0.051)).toBe('INSUFFICIENT_DATA');
    expect(edgeLabel(0.8, 4, 'untrained', 0)).toBe('INSUFFICIENT_DATA');
    expect(edgeLabel(null, 4, 'active', 0)).toBe('INSUFFICIENT_DATA');
  });
});

describe('model metrics', () => {
  it('computes binary log loss and Brier score', () => {
    expect(logLoss([0.8, 0.2], [1, 0])).toBeCloseTo(-Math.log(0.8));
    expect(brierScore([0.8, 0.2], [1, 0])).toBeCloseTo(0.04);
    expect(logLoss([0, 1], [0, 1])).toBeGreaterThan(0);
  });

  it('computes equal-width expected calibration error', () => {
    expect(expectedCalibrationError([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBeCloseTo(0.15);
    expect(expectedCalibrationError([0.1], [0], 10)).toBeCloseTo(0.1);
  });

  it('computes max drawdown and payout/stake ROI', () => {
    expect(maxDrawdown([100, 120, 90, 110])).toEqual({ amount: 30, pct: 0.25 });
    expect(roi(100, 150)).toBe(1.5);
    expect(roi(0, 0)).toBeNull();
  });
});
