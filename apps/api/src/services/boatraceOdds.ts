const BASE_URL = 'https://www.boatrace.jp/owpc/pc/race/oddstf';
export const USER_AGENT = 'EdgeLab/0.1 (polite official Boatrace odds collector)';

export type WinOdds = {
  final: boolean;
  odds: Array<[number, number | null]>;
};

/** Build the official BOAT RACE trifecta/win-odds page URL. */
export function oddsUrl(raceNo: number, venueCode: string, targetDate: string | Date): string {
  const day = targetDate instanceof Date
    ? `${targetDate.getFullYear()}${String(targetDate.getMonth() + 1).padStart(2, '0')}${String(targetDate.getDate()).padStart(2, '0')}`
    : targetDate.replaceAll('-', '');
  return `${BASE_URL}?rno=${Math.trunc(raceNo)}&jcd=${venueCode.padStart(2, '0')}&hd=${day}`;
}

/** Parse the first six win-odds cells and whether the page marks final odds. */
export function parseWinOdds(html: string): WinOdds {
  const values: string[] = [];
  const cells = /<([a-z][\w:-]*)\b(?=[^>]*\bclass\s*=\s*(?:"[^"]*\boddsPoint\b[^"]*"|'[^']*\boddsPoint\b[^']*'))([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of html.matchAll(cells)) {
    const rawText = (match[3] ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').trim();
    values.push(rawText);
  }

  const odds: WinOdds['odds'] = [];
  for (let n = 1; n <= 6; n++) {
    const raw = values[n - 1] ?? '';
    // 0.0 は欠場・発売なし。1.0 倍以下は期待値計算に使えないので欠損扱い
    const v = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
    odds.push([n, v !== null && v > 1.0 ? v : null]);
  }
  return { final: html.includes('締切時オッズ'), odds };
}

/**
 * 投票が少ない発売初期のオッズは極端にぶれるため、払戻率から見た妥当性を確認する。
 * ボートの単勝は控除率25%なので Σ(1/odds) ≈ 1/0.75 ≈ 1.33。欠場艇を除いた合計が範囲外なら不安定とみなす。
 */
export function isStablePool(odds: WinOdds['odds'], min = 1.2, max = 1.5): boolean {
  const vals = odds.map(([, v]) => v).filter((v): v is number => v !== null)
  if (vals.length < 2) return false
  const overround = vals.reduce((a, v) => a + 1 / v, 0)
  return overround >= min && overround <= max
}
