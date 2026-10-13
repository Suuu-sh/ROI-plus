import { describe, expect, it } from 'vitest';
import { sizeExperimentalPortfolio, sizeExperimentalPortfolioResult } from '../src/services/experimentalSizing.js';

describe('sizeExperimentalPortfolio', () => {
  it('uses uncertainty-adjusted edge and stays inside per-race virtual bankroll bounds', () => {
    const sized = sizeExperimentalPortfolio([
      { selection: '1-2-3', probability: 0.2, probStd: 0.01, odds: 8 },
      { selection: '1-2-4', probability: 0.1, probStd: 0.01, odds: 5 },
      { selection: '1-2-5', probability: 0.01, probStd: 0.02, odds: 100 },
    ], 10_000);
    expect(sized.length).toBeGreaterThan(0);
    expect(sized.some(x => x.selection === '1-2-5')).toBe(false);
    expect(sized.reduce((sum, x) => sum + x.stake, 0)).toBeLessThanOrEqual(1_000);
    expect(sized.every(x => x.stake >= 100 && x.stake % 100 === 0 && x.expectedRoi > 0)).toBe(true);
  });

  it('does not stake when edge, balance, or input integrity is insufficient', () => {
    expect(sizeExperimentalPortfolio([{ selection: '1-2-3', probability: 0.1, probStd: 0.02, odds: 5 }], 1_000)).toEqual([]);
    expect(sizeExperimentalPortfolio([{ selection: '1-2-3', probability: 0.9, probStd: 0, odds: 3 }], 0)).toEqual([]);
    expect(sizeExperimentalPortfolio([
      { selection: '1-2-3', probability: 0.9, probStd: 0, odds: 3 },
      { selection: '1-2-3', probability: 0.1, probStd: 0, odds: 20 },
    ], 1_000)).toEqual([]);
  });

  it('never allocates more than available balance even with high edge', () => {
    const sized = sizeExperimentalPortfolio([
      { selection: '1-2-3', probability: 0.9, probStd: 0.01, odds: 3 },
      { selection: '1-2-4', probability: 0.08, probStd: 0.01, odds: 3 },
    ], 200);
    expect(sized.reduce((sum, x) => sum + x.stake, 0)).toBeLessThanOrEqual(200);
    expect(sized.every(x => x.stake >= 100 && x.stake % 100 === 0)).toBe(true);
  });

  it('abstains when the portfolio budget cannot fund a 100-yen ticket', () => {
    const result = sizeExperimentalPortfolioResult([
      { selection: '1-2-3', probability: 0.3, probStd: 0, odds: 5 },
    ], 704);
    // Existing fractional-Kelly sizing would allocate 22 yen here.
    expect(result).toEqual({ stakes: [], abstentionReason: 'minimum_virtual_stake_not_reached' });
  });
});
