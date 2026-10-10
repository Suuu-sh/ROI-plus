import { describe, expect, it } from 'vitest';
import { isStablePool, parseWinOdds } from '../src/services/boatraceOdds.js';

const page = (vals: string[]) => vals.map(v => `<td class="oddsPoint ">${v}</td>`).join('');

describe('odds stability guards', () => {
  it('treats 0.0 and <=1.0 odds as missing', () => {
    const p = parseWinOdds(page(['6.6', '2.0', '1.9', '11.6', '11.6', '0.0']));
    expect(p.odds.map(([, v]) => v)).toEqual([6.6, 2.0, 1.9, 11.6, 11.6, null]);
  });
  it('accepts a normal pool and rejects a thin early pool', () => {
    expect(isStablePool(parseWinOdds(page(['1.4', '4.5', '5.0', '8.0', '15.0', '25.0'])).odds)).toBe(true);
    expect(isStablePool(parseWinOdds(page(['16.5', '3.7', '4.1', '5.5', '8.2', '16.5'])).odds)).toBe(false);
  });
});
