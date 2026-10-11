import { readPageIdentity, type TrifectaOddsIdentity } from './boatraceTrifectaOdds.js';
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

/** Read only the explicitly labelled win market, using its own boat numbers. */
export function parseWinOdds(html: string, expected?: TrifectaOddsIdentity): WinOdds {
  if (expected) {
    const identity = readPageIdentity(html);
    if (identity.raceDate !== expected.raceDate.replaceAll('-', '') || identity.venueCode !== expected.venueCode || identity.raceNo !== expected.raceNo) throw new Error('official win odds page identity mismatch');
  }
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m => m[0]);
  const markets = tables.filter(table => /<th\b[^>]*>\s*単勝オッズ\s*<\/th>/i.test(table));
  if (markets.length !== 1) throw new Error('official win odds table missing or ambiguous');
  const table = markets[0];
  const before = html.slice(0, html.indexOf(table));
  const timingAt = Math.max(before.lastIndexOf('締切時オッズ'), before.lastIndexOf('オッズ更新時間'));
  if (timingAt < 0) throw new Error('official win odds timing marker missing');
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]).filter(row => /<td\b/i.test(row));
  const byBoat = new Map<number, number | null>();
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length !== 3 || !/\boddsPoint\b/.test(cells[2][1])) throw new Error('malformed official win odds row');
    const number = text(cells[0][2]);
    if (!/^[1-6]$/.test(number) || byBoat.has(Number(number))) throw new Error('invalid or duplicate win boat number');
    const raw = text(cells[2][2]);
    // 1.0 is a valid displayed quote, not missing data. 0.0 is unavailable;
    // the page alone does not prove whether this means no votes or a scratch.
    if (!/^\d+\.\d$/.test(raw)) throw new Error('non-numeric official win odds');
    const value = Number(raw);
    if (!Number.isFinite(value) || (value !== 0 && value < 1)) throw new Error('invalid official win odds value');
    byBoat.set(Number(number), value === 0 ? null : value);
  }
  if (byBoat.size !== 6) throw new Error('incomplete official win odds coverage');
  return { final: before.slice(timingAt).startsWith('締切時オッズ'), odds: [...byBoat].sort((a, b) => a[0] - b[0]) };
}
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').trim();
}

/**
 * 投票が少ない発売初期のオッズは極端にぶれるため、払戻率から見た妥当性を確認する。
 * ボートの単勝は控除率25%なので Σ(1/odds) ≈ 1/0.75 ≈ 1.33。取得不能値を除いた合計が範囲外なら不安定とみなす。
 */
export function isStablePool(odds: WinOdds['odds'], min = 1.2, max = 1.5): boolean {
  const vals = odds.map(([, v]) => v).filter((v): v is number => v !== null && Number.isFinite(v) && v >= 1)
  if (vals.length < 2) return false
  const overround = vals.reduce((a, v) => a + 1 / v, 0)
  return overround >= min && overround <= max
}
