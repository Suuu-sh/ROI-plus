import { describe, expect, it } from 'vitest';
import { isStablePool, parseWinOdds } from '../src/services/boatraceOdds.js';

const page = (vals: string[]) => `<p>オッズ更新時間 9:49</p><table><thead><tr><th>艇</th><th>ボートレーサー</th><th>単勝オッズ</th></tr></thead>${vals.map((v,i) => `<tr><td>${i+1}</td><td>Synthetic</td><td class="oddsPoint ">${v}</td></tr>`).join('')}</table>`;

describe('odds stability guards', () => {
  it('treats unavailable 0.0 as missing', () => {
    const p = parseWinOdds(page(['6.6', '2.0', '1.9', '11.6', '11.6', '0.0']));
    expect(p.odds.map(([, v]) => v)).toEqual([6.6, 2.0, 1.9, 11.6, 11.6, null]);
  });
  it('accepts a normal pool and rejects a thin early pool', () => {
    expect(isStablePool(parseWinOdds(page(['1.4', '4.5', '5.0', '8.0', '15.0', '25.0'])).odds)).toBe(true);
    expect(isStablePool(parseWinOdds(page(['16.5', '3.7', '4.1', '5.5', '8.2', '16.5'])).odds)).toBe(false);
  });
});

describe('win market structure', () => {
  it('includes valid 1.0 odds in the pool instead of dropping the favourite', () => {
    const parsed=parseWinOdds(page(['1.0','12.0','12.0','15.0','20.0','20.0']));
    expect(parsed.odds[0]).toEqual([1,1]);
    expect(isStablePool(parsed.odds)).toBe(true);
    expect(isStablePool(parsed.odds.map(([n,value])=>[n,n===1?null:value]))).toBe(false);
  });
  it('ignores place/unrelated cells and maps shuffled rows by boat number', () => {
    const html=page(['2.0','6.1','13.4','3.0','9.9','5.3']);
    const rows=[...html.matchAll(/<tr><td>[\s\S]*?<\/tr>/g)].map(m=>m[0]).reverse().join('');
    expect(parseWinOdds('<td class="oddsPoint">999.9</td>'+html.replace(/<tr><td>[\s\S]*<\/tr>/,rows)+'<table><th>複勝オッズ</th><td class="oddsPoint">1.0-1.5</td></table>').odds).toEqual([[1,2],[2,6.1],[3,13.4],[4,3],[5,9.9],[6,5.3]]);
  });
  it('fails closed on missing tables, duplicate boats and malformed values', () => {
    expect(()=>parseWinOdds('<td class="oddsPoint">2.0</td>')).toThrow(/table/);
    expect(()=>parseWinOdds(page(['2.0','3.0','4.0','5.0','6.0','7.0']).replace('<td>2</td>','<td>1</td>'))).toThrow(/duplicate/);
    expect(()=>parseWinOdds(page(['1.0-1.1','3.0','4.0','5.0','6.0','7.0']))).toThrow(/non-numeric/);
    expect(()=>parseWinOdds(page(['2.0','3.0','4.0','5.0','6.0']))).toThrow(/coverage/);
  });
});
