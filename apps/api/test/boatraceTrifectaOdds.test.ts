import { describe, expect, it } from 'vitest';
import { parseTrifectaOdds, trifectaOddsUrl } from '../src/services/boatraceTrifectaOdds.js';

const identity = { raceDate: '2026-10-04', venueCode: '09', raceNo: 3 };

function page(final = true) {
  const firsts = [1, 2, 3, 4, 5, 6];
  const head = `<thead><tr>${firsts.map(n => `<th>${n}</th>`).join('')}</tr></thead>`;
  // Twenty rows are expected (5 second-place choices x 4 third-place choices).
  const bodyRows: string[] = [];
  for (let group = 0; group < 5; group++) {
    for (let row = 0; row < 4; row++) {
      const cells = firsts.map(columnFirst => {
          const seconds = [1, 2, 3, 4, 5, 6].filter(n => n !== columnFirst);
          const columnSecond = seconds[group];
          const thirds = [1, 2, 3, 4, 5, 6].filter(n => n !== columnFirst && n !== columnSecond);
          const runner3 = thirds[row];
          return `${row === 0 ? `<td rowspan="4">${columnSecond}</td>` : ''}<td>${runner3}</td><td class="oddsPoint">${10 + group + 1 + row + columnFirst / 10}</td>`;
        }).join('');
        bodyRows.push(`<tr>${cells}</tr>`);
    }
  }
  return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=3&amp;jcd=09&amp;hd=20261004">出走表</a><a href="/owpc/pc/race/raceresult?rno=3&amp;jcd=09&amp;hd=20261004">結果</a></div><p class="tab4_time">${final ? '締切時オッズ' : 'オッズ更新時間 13:00'}</p><span>3連単オッズ</span><table>${head}<tbody>${bodyRows.join('')}</tbody></table>`;
}

describe('Official trifecta odds parser', () => {
  it('builds the official odds3t URL and parses all 120 ordered tickets', () => {
    expect(trifectaOddsUrl(3, '09', identity.raceDate)).toBe('https://www.boatrace.jp/owpc/pc/race/odds3t?rno=3&jcd=09&hd=20261004');
    const result = parseTrifectaOdds(page(), identity);
    expect(result).toMatchObject({ final: true, qualityStatus: 'verified-final-complete-v1', ...identity });
    expect(result.odds).toHaveLength(120);
    expect(result.odds).toContainEqual({ selection: '1-2-3', odds: 11.1 });
    expect(new Set(result.odds.map(x => x.selection)).size).toBe(120);
  });

  it('marks complete non-final odds separately from final odds', () => {
    expect(parseTrifectaOdds(page(false), identity).qualityStatus).toBe('verified-complete-v1');
  });

  it('fails closed on identity mismatch, missing timing marker, and incomplete markets', () => {
    expect(() => parseTrifectaOdds(page(), { ...identity, raceNo: 4 })).toThrow(/identity mismatch/);
    expect(() => parseTrifectaOdds(page().replace('締切時オッズ', 'not a marker'), identity)).toThrow(/timing marker/);
    expect(() => parseTrifectaOdds(page().replace('<td class="oddsPoint">', '<td class="oddsPoint">0.0'), identity)).toThrow(/malformed trifecta row|non-numeric|incomplete/);
  });
});
