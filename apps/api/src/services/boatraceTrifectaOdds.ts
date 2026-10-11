/** Strict parser for the official BOAT RACE trifecta-odds page.
 *
 * This intentionally accepts only a complete, numeric 6-boat market. Pages
 * with scratches, omitted cells, non-numeric placeholders, or changed markup
 * fail closed until their semantics are explicitly supported and tested.
 */
export type TrifectaOddsIdentity = { raceDate: string; venueCode: string; raceNo: number };
export type TrifectaOdds = {
  final: boolean;
  qualityStatus: 'verified-complete-v1' | 'verified-final-complete-v1';
  raceDate: string;
  venueCode: string;
  raceNo: number;
  odds: Array<{ selection: string; odds: number }>;
};
export type TrifectaOfficialResult = {
  selection: string;
  payoutPer100: number;
  finishOrder: number[];
};

const BASE_URL = 'https://www.boatrace.jp/owpc/pc/race/odds3t';
const IDENTITY_PAGE_TYPES = ['racelist', 'raceresult', 'beforeinfo', 'pcexpect', 'myexpect'];

export function trifectaOddsUrl(raceNo: number, venueCode: string, raceDate: string): string {
  validateIdentity({ raceNo, venueCode, raceDate });
  return `${BASE_URL}?rno=${raceNo}&jcd=${venueCode}&hd=${raceDate.replaceAll('-', '')}`;
}

export function parseTrifectaOdds(html: string, expected: TrifectaOddsIdentity): TrifectaOdds {
  validateIdentity(expected);
  if (!html || typeof html !== 'string') throw new Error('empty official odds page');
  const identity = readPageIdentity(html);
  if (identity.raceDate !== expected.raceDate.replaceAll('-', '')
      || identity.venueCode !== expected.venueCode
      || identity.raceNo !== expected.raceNo) {
    throw new Error('official odds page identity mismatch');
  }

  const titleAt = html.indexOf('3連単オッズ');
  if (titleAt < 0) throw new Error('official trifecta odds table missing');
  const beforeTable = html.slice(0, titleAt);
  const lastTimeMarker = Math.max(beforeTable.lastIndexOf('締切時オッズ'), beforeTable.lastIndexOf('オッズ更新時間'));
  if (lastTimeMarker < 0) throw new Error('official odds timing marker missing');
  const final = beforeTable.slice(lastTimeMarker).startsWith('締切時オッズ');

  const tableOpen = html.indexOf('<table', titleAt);
  const tableClose = tableOpen < 0 ? -1 : html.indexOf('</table>', tableOpen);
  if (tableOpen < 0 || tableClose < 0) throw new Error('official trifecta odds table malformed');
  const table = html.slice(tableOpen, tableClose + '</table>'.length);
  const head = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
  const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!head || !body) throw new Error('official trifecta odds table sections missing');
  const firsts = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(match => textContent(match[1]))
    .filter(value => /^[1-6]$/.test(value))
    .map(Number);
  if (firsts.length !== 6 || new Set(firsts).size !== 6) throw new Error('invalid first-place header');

  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  if (rows.length !== 20) throw new Error('incomplete trifecta rows');
  const odds = new Map<string, number>();
  let secondByFirst: number[] | null = null;
  rows.forEach((row, rowIndex) => {
    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map(match => ({
      attrs: match[1], text: textContent(match[2]),
    }));
    const groupStart = rowIndex % 4 === 0;
    const expectedCells = groupStart ? 18 : 12;
    if (cells.length !== expectedCells) throw new Error('malformed trifecta row');
    if (groupStart) secondByFirst = [];
    if (!secondByFirst) throw new Error('missing second-place row state');

    firsts.forEach((first, column) => {
      let second: number, third: number, oddsText: string;
      if (groupStart) {
        const offset = column * 3;
        const secondCell = cells[offset];
        if (!/\browspan\s*=\s*["']?4["']?/i.test(secondCell.attrs)) throw new Error('invalid second-place span');
        second = readRunner(secondCell.text);
        third = readRunner(cells[offset + 1].text);
        oddsText = cells[offset + 2].text;
        secondByFirst![column] = second;
      } else {
        const offset = column * 2;
        second = secondByFirst![column];
        third = readRunner(cells[offset].text);
        oddsText = cells[offset + 1].text;
      }
      if (first === second || first === third || second === third) throw new Error('duplicate runner in trifecta selection');
      const value = parseOdds(oddsText);
      const selection = `${first}-${second}-${third}`;
      if (odds.has(selection)) throw new Error('duplicate trifecta selection');
      odds.set(selection, value);
    });
  });

  if (odds.size !== 120) throw new Error('incomplete trifecta odds coverage');
  // Ensure each of the five second-place groups appears once and each has its
  // four legal third-place combinations in every first-place column.
  for (const first of firsts) {
    const selections = [...odds.keys()].filter(key => Number(key.split('-')[0]) === first);
    if (selections.length !== 20) throw new Error('incomplete first-place odds coverage');
  }
  return {
    final,
    qualityStatus: final ? 'verified-final-complete-v1' : 'verified-complete-v1',
    raceDate: expected.raceDate,
    venueCode: expected.venueCode,
    raceNo: expected.raceNo,
    odds: [...odds].map(([selection, value]) => ({ selection, odds: value })),
  };
}

/** Parse the ordered top-three result and winning trifecta payout from the
 * official race-result page. Used for an offline consistency audit, not for
 * pre-race prediction or odds acquisition. */
export function parseOfficialTrifectaResult(html: string, expected: TrifectaOddsIdentity): TrifectaOfficialResult {
  validateIdentity(expected);
  const identity = readPageIdentity(html);
  if (identity.raceDate !== expected.raceDate.replaceAll('-', '')
      || identity.venueCode !== expected.venueCode || identity.raceNo !== expected.raceNo) {
    throw new Error('official result page identity mismatch');
  }

  const resultHeaderAt = html.indexOf('<th>着</th>');
  const resultTable = enclosingTable(html, resultHeaderAt);
  if (!resultTable) throw new Error('official finish-order table missing');
  const finishOrder: number[] = [];
  for (const row of resultTable.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => textContent(m[1]));
    if (cells.length < 2) continue;
    const rank = parseJapaneseDigit(cells[0]);
    const runner = parseJapaneseDigit(cells[1]);
    if (rank !== null && runner !== null) finishOrder[rank - 1] = runner;
  }
  if (finishOrder.length < 3 || finishOrder.slice(0, 3).some(n => !Number.isInteger(n))
      || new Set(finishOrder.slice(0, 3)).size !== 3) throw new Error('invalid official finish order');

  const payoutHeaderAt = html.indexOf('<th>勝式</th>');
  const payoutTable = enclosingTable(html, payoutHeaderAt);
  if (!payoutTable) throw new Error('official payout table missing');
  const trifecta = payoutTable.match(/<tbody\b[^>]*>([\s\S]*?<td\b[^>]*>\s*3連単\s*<\/td>[\s\S]*?)<\/tbody>/i)?.[1];
  if (!trifecta) throw new Error('official trifecta payout missing');
  const winningNumbers = [...trifecta.matchAll(/<span\b[^>]*class\s*=\s*["'][^"']*\bnumberSet1_number\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map(match => parseJapaneseDigit(textContent(match[1])))
    .filter((n): n is number => n !== null);
  const payoutMatch = trifecta.match(/(?:&yen;|&#165;|¥)\s*([\d,]+)/i);
  if (winningNumbers.length !== 3 || !payoutMatch) throw new Error('malformed official trifecta payout');
  const selection = winningNumbers.join('-');
  if (selection !== finishOrder.slice(0, 3).join('-')) throw new Error('official trifecta payout does not match finish order');
  const payoutPer100 = Number(payoutMatch[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(payoutPer100) || payoutPer100 <= 0) throw new Error('invalid official trifecta payout amount');
  return { selection, payoutPer100, finishOrder };
}

export function readPageIdentity(html: string): { raceDate: string; venueCode: string; raceNo: number } {
  // The selected-race tab links are the page's own identity evidence. Requiring
  // every relevant tab link to agree prevents a generic/error page or a page
  // for another race from being accepted based on the caller's requested URL.
  const tab = html.match(/<div\b[^>]*class\s*=\s*["'][^"']*\btab3\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (!tab) throw new Error('official race identity tabs missing');
  const identities: Array<{ raceDate: string; venueCode: string; raceNo: number }> = [];
  const links = [...tab.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => decodeEntities(m[1]));
  for (const href of links) {
    const match = href.match(new RegExp(`/(${IDENTITY_PAGE_TYPES.join('|')})\\?([^#]*)`, 'i'));
    if (!match) continue;
    const params = new URLSearchParams(match[2]);
    const raceDate = params.get('hd') ?? '';
    const venueCode = params.get('jcd') ?? '';
    const raceNo = Number(params.get('rno'));
    if (!/^\d{8}$/.test(raceDate) || !/^\d{2}$/.test(venueCode) || !Number.isInteger(raceNo)) {
      throw new Error('malformed official race identity');
    }
    identities.push({ raceDate, venueCode, raceNo });
  }
  if (identities.length < 2) throw new Error('insufficient official race identity evidence');
  const first = identities[0];
  if (identities.some(item => item.raceDate !== first.raceDate || item.venueCode !== first.venueCode || item.raceNo !== first.raceNo)) {
    throw new Error('conflicting official race identity evidence');
  }
  return first;
}

function textContent(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&#(\d+);/g, (_all, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_all, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function readRunner(value: string): number {
  if (!/^[1-6]$/.test(value)) throw new Error('invalid runner placeholder');
  return Number(value);
}

function parseOdds(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('non-numeric or unavailable trifecta odds');
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds <= 0) throw new Error('invalid trifecta odds value');
  return odds;
}

function enclosingTable(html: string, innerOffset: number): string | null {
  if (innerOffset < 0) return null;
  const start = html.lastIndexOf('<table', innerOffset);
  const end = html.indexOf('</table>', innerOffset);
  return start < 0 || end < 0 ? null : html.slice(start, end + '</table>'.length);
}

function parseJapaneseDigit(value: string): number | null {
  const normalized = value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).trim();
  return /^[1-6]$/.test(normalized) ? Number(normalized) : null;
}

function validateIdentity(identity: TrifectaOddsIdentity): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(identity.raceDate)
      || !/^\d{2}$/.test(identity.venueCode)
      || !Number.isInteger(identity.raceNo) || identity.raceNo < 1 || identity.raceNo > 12) {
    throw new Error('invalid race identity');
  }
}
