/** Strict parser for a single, completed BOAT RACE official result page. */
export type BoatraceResultExpected = {
  url: string;
  raceDate: string;
  venueCode: string;
  raceNo: number;
  entries: Array<{ number: number; racerId: string }>;
};

export type BoatraceResults = {
  results: Array<{ number: number; finishOrder: number }>;
  terminalEntries: Array<{ number: number; finishCode: string }>;
  refundTablePresent: boolean;
  refundNumbers: number[];
  nonRefundableNumbers: number[];
  payouts: Array<{ betType: 'win' | 'trifecta'; selection: string; payout: number }>;
};
export type BoatraceRefundOutcome = {
  refundNumbers: number[];
  payouts: Array<{ betType: 'win' | 'trifecta'; selection: string; payout: number }>;
};

const OFFICIAL_HOST = 'www.boatrace.jp';
const RESULT_PATH = '/owpc/pc/race/raceresult';

export function parseBoatraceResults(html: string, expected: BoatraceResultExpected): BoatraceResults {
  if (typeof html !== 'string' || html.length === 0) fail();
  validateExpected(expected);
  const expectedDate = expected.raceDate.replaceAll('-', '');
  const requested = officialResultIdentity(expected.url);
  if (!sameIdentity(requested, expectedDate, expected.venueCode, expected.raceNo)) fail();
  // Exclude table headers: the official result template always has a static
  // "返還" heading, including normal races. Only body evidence is meaningful.
  const nonHeaderText = html.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi, '');
  if (/中止|不成立/.test(text(nonHeaderText))) fail();
  const refundTables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match => match[0])
    .filter(table => /<th\b[^>]*>\s*返還\s*<\/th>/i.test(table));
  if (refundTables.length !== 1) fail();
  const refundNumbers: number[] = [];
  const refundBodies = [...refundTables[0].matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)];
  if (!refundBodies.length) fail();
  for (const body of refundBodies) for (const cell of body[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    const values = [...cell[1].matchAll(/<span\b[^>]*\bnumberSet1_number\b[^>]*>([\s\S]*?)<\/span>/gi)];
    if (text(cell[1].replace(/<span\b[^>]*\bnumberSet1_number\b[^>]*>[\s\S]*?<\/span>/gi, ''))) fail();
    for (const value of values) { const number = digit(text(value[1])); if (!number) fail(); refundNumbers.push(number); }
  }
  if (new Set(refundNumbers).size !== refundNumbers.length) fail();

  // Require three independent indicators that the response is the selected
  // result page: venue image, active date, and selected race in its schedule.
  const venueImage = html.match(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*\/text_place2_(\d{2})\.png(?:\?[^"']*)?["'][^>]*>/i);
  if (!venueImage || venueImage[1] !== expected.venueCode) fail();
  const activeDate = html.match(/<li\b[^>]*\bclass\s*=\s*["'][^"']*\bis-active2\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/i)?.[1];
  const dateLabel = activeDate ? text(activeDate).match(/(\d{1,2})月(\d{1,2})日/) : null;
  if (!dateLabel || Number(dateLabel[1]) !== Number(expectedDate.slice(4, 6)) || Number(dateLabel[2]) !== Number(expectedDate.slice(6, 8))) fail();
  const schedule = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi)?.find(table => /<th\b[^>]*>\s*レース\s*<\/th>/i.test(table));
  if (!schedule) fail();
  const selected = [...schedule.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)].filter(match => {
    if (/\bis-thColor[23]\b/i.test(match[1])) return false;
    const href = match[2].match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    return !!href && isOfficialResultLink(href);
  });
  if (selected.length !== 1) fail();
  const selectedHref = selected[0][2].match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!selectedHref || !identityFromLink(selectedHref, true, expectedDate, expected.venueCode, expected.raceNo)) fail();

  // The active result tab and a matching selected-race link in the page tabs
  // prevent a generic race page with a matching navigation menu being used.
  const resultTab = html.match(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\btab3\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (!resultTab || !/<li\b[^>]*\bclass\s*=\s*["'][^"']*\bis-active\b[^"']*["'][^>]*>\s*<span[^>]*>\s*<span>\s*結果\s*<\/span>/i.test(resultTab)) fail();

  const finishTable = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m => m[0]).find(table => {
    const head = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? '';
    const labels = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => text(m[1]));
    return labels.includes('着') && labels.includes('枠') && labels.includes('ボートレーサー');
  });
  if (!finishTable) fail();
  // Individual non-finisher markers are validated row-by-row below. Race-wide
  // cancellation remains outside this contract; refunds require table evidence.
  if (/中止|不成立|返還/.test(text(finishTable))) fail();
  const finishRows: Array<{ number: number; finishOrder: number | null; finishCode: string | null; racerId: string }> = [];
  for (const body of finishTable.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)) {
    const rows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
      if (cells.length !== 4) fail();
      const rankText = text(cells[0][2]);
      const rank = digit(rankText);
      const finishCode = rank ? null : terminalFinishCode(rankText);
      const number = digit(text(cells[1][2]));
      const racerCells = [...cells[2][2].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)];
      const racerSpan = racerCells.find(cell => /\bis-fs12\b/.test(cell[1]));
      const racerId = racerSpan ? text(racerSpan[2]) : '';
      if ((!rank && !finishCode) || !number || !/^\d{4,5}$/.test(racerId)) fail();
      finishRows.push({ number, finishOrder: rank, finishCode, racerId });
    }
  }
  const numericRows = finishRows.filter((row): row is typeof row & { finishOrder: number } => row.finishOrder !== null);
  const terminalRows = finishRows.filter((row): row is typeof row & { finishCode: string } => row.finishCode !== null);
  if (finishRows.length !== 6 || new Set(finishRows.map(row => row.number)).size !== 6
      || terminalRows.length > 5 || numericRows.length !== 6 - terminalRows.length
      || !numericRows.every(row => row.finishOrder === 1 + numericRows.filter(other => other.finishOrder < row.finishOrder).length)) fail();
  if (refundNumbers.some(number => !terminalRows.some(row => row.number === number))
    || terminalRows.some(row => ['Ｆ', 'Ｌ', '欠場'].includes(row.finishCode) !== refundNumbers.includes(row.number))) fail();
  const expectedByNumber = new Map(expected.entries.map(entry => [entry.number, entry]));
  if (finishRows.some(row => {
    const entry = expectedByNumber.get(row.number);
    return !entry || row.racerId !== entry.racerId;
  })) fail();

  const payouts = parsePayouts(html);
  const wins = numericRows.filter(row => row.finishOrder === 1).map(row => String(row.number));
  const winPayouts = payouts.filter(payout => payout.betType === 'win');
  if (winPayouts.length !== wins.length || wins.some(selection => !winPayouts.some(p => p.selection === selection))) fail();
  // A dead heat preserves competition ranks; enumerate only the legal top-three
  // orders, never manufacture an ordering between tied boats.
  const legalTrifectas: string[] = [];
  for (const a of numericRows) for (const b of numericRows) for (const c of numericRows) {
    if (new Set([a.number,b.number,c.number]).size !== 3) continue;
    const selected = [a,b,c];
    if (selected.some((row,i) => selected.slice(0,i).some(prior => prior.finishOrder > row.finishOrder))) continue;
    if (numericRows.some(row => !selected.includes(row) && row.finishOrder < c.finishOrder)) continue;
    legalTrifectas.push(selected.map(row=>row.number).join('-'));
  }
  const trifectas = payouts.filter(payout=>payout.betType === 'trifecta');
  if (trifectas.some(p=>!legalTrifectas.includes(p.selection))
    || (trifectas.length && (trifectas.length !== legalTrifectas.length || legalTrifectas.some(selection=>!trifectas.some(p=>p.selection===selection))))) fail();
  const nonRefundableNumbers = terminalRows.filter(row=>!refundNumbers.includes(row.number)).map(row=>row.number);
  return { results: numericRows.map(({ number, finishOrder }) => ({ number, finishOrder })),
    terminalEntries: terminalRows.map(({number,finishCode})=>({number,finishCode})),
    refundTablePresent: true, refundNumbers: refundNumbers.sort((a,b)=>a-b), nonRefundableNumbers, payouts };

}

/** Parse explicit refunds and official payouts without creating result labels. */
export function parseBoatraceRefundOutcome(html: string, expected: BoatraceResultExpected): BoatraceRefundOutcome {
  if (typeof html !== 'string' || html.length === 0) fail();
  validateExpected(expected);
  const expectedDate=expected.raceDate.replaceAll('-','');
  if(!sameIdentity(officialResultIdentity(expected.url),expectedDate,expected.venueCode,expected.raceNo))fail();
  const nonHeaderText=html.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi,'');
  if(/中止|不成立|同着/.test(text(nonHeaderText)))fail();
  validateSelectedResultTab(html,expectedDate,expected.venueCode,expected.raceNo);
  const tables=[...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match=>match[0]);
  const finishTables=tables.filter(table=>{
    const head=table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1]??'';
    const labels=[...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match=>text(match[1]));
    return labels.includes('着')&&labels.includes('枠')&&labels.includes('ボートレーサー');
  });
  if(finishTables.length>1)fail();
  if (finishTables.length === 1) {
    const parsed = parseBoatraceResults(html, expected);
    if (!parsed.refundNumbers.length) fail();
    return {refundNumbers:parsed.refundNumbers,payouts:parsed.payouts};
  }
  const refundTables=tables.filter(table=>/<th\b[^>]*>\s*返還\s*<\/th>/i.test(table));
  if(refundTables.length!==1)fail();
  const bodies=[...refundTables[0].matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)];
  if(!bodies.length)fail();
  const refundNumbers:number[]=[];
  for(const body of bodies)for(const row of body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match=>text(match[1])).filter(Boolean);
    for(const value of cells){const number=digit(value);if(!number)fail();refundNumbers.push(number);}
  }
  if(!refundNumbers.length||new Set(refundNumbers).size!==refundNumbers.length)fail();
  const payouts=parsePayouts(html);
  const trifecta=payouts.filter(payout=>payout.betType==='trifecta');
  const win=payouts.filter(payout=>payout.betType==='win');
  if(trifecta.length!==1||win.length!==1
    ||trifecta[0].selection.split('-')[0]!==win[0].selection
    ||trifecta[0].selection.split('-').some(value=>refundNumbers.includes(Number(value))))fail();
  return {refundNumbers:refundNumbers.sort((a,b)=>a-b),payouts};
}

function validateSelectedResultTab(html:string,expectedDate:string,venueCode:string,raceNo:number):void {
  const venueImage=html.match(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*\/text_place2_(\d{2})\.png(?:\?[^"']*)?["'][^>]*>/i);
  if(!venueImage||venueImage[1]!==venueCode)fail();
  const activeDate=html.match(/<li\b[^>]*\bclass\s*=\s*["'][^"']*\bis-active2\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/i)?.[1];
  const dateLabel=activeDate?text(activeDate).match(/(\d{1,2})月(\d{1,2})日/):null;
  if(!dateLabel||Number(dateLabel[1])!==Number(expectedDate.slice(4,6))||Number(dateLabel[2])!==Number(expectedDate.slice(6,8)))fail();
  const schedule=html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi)?.find(table=>/<th\b[^>]*>\s*レース\s*<\/th>/i.test(table));
  if(!schedule)fail();
  const selected=[...schedule.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)].filter(match=>{
    if(/\bis-thColor[23]\b/i.test(match[1]))return false;
    const href=match[2].match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    return !!href&&isOfficialResultLink(href);
  });
  if(selected.length!==1)fail();
  const href=selected[0][2].match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if(!href||!identityFromLink(href,true,expectedDate,venueCode,raceNo))fail();
  const tab=html.match(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\btab3\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if(!tab||!/<li\b[^>]*\bclass\s*=\s*["'][^"']*\bis-active\b[^"']*["'][^>]*>\s*<span[^>]*>\s*<span>\s*結果\s*<\/span>/i.test(tab))fail();
}

// Official result pages use short markers in the finish column. Keep the
// mapping explicit; these are terminal entrants, not inferred rank positions.
function terminalFinishCode(value: string): string | null {
  const codes: Record<string,string> = { '転':'転覆', '沈':'沈没', '落':'落水', 'エ':'エンスト', '不':'不完走', '妨':'妨害失格', '失':'失格', '欠':'欠場', 'F':'Ｆ', 'Ｆ':'Ｆ', 'L':'Ｌ', 'Ｌ':'Ｌ' };
  return codes[value] ?? null;
}

function parsePayouts(html: string): BoatraceResults['payouts'] {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m => m[0]);
  const matches = tables.filter(table => /<th\b[^>]*>\s*勝式\s*<\/th>/i.test(table));
  if (matches.length !== 1) fail();
  const payouts: BoatraceResults['payouts'] = [];
  for (const body of matches[0].matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)) {
    const rows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
      [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1]));
    if (!rows.length || !rows[0].length) fail();
    // Official markup groups a market and its rowspan continuation rows in one
    // tbody. Strictly inspect target markets while ignoring other bet types.
    const betTypeText = text(rows[0][0]);
    if (betTypeText !== '単勝' && betTypeText !== '3連単') continue;
    if (rows[0].length !== 4) fail();
    for (const [index, row] of rows.entries()) {
    const cells = index === 0 ? row : ['', ...row];
    if (index > 0 && (row.length !== 3)) fail();
    if (index > 0 && row.every(cell => text(cell) === '')) continue;
    const selection = [...cells[1].matchAll(/<span\b[^>]*\bclass\s*=\s*["'][^"']*\bnumberSet1_number\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
      .map(m => digit(text(m[1])));
    const rawPayout = cells[2].match(/<span\b[^>]*\bis-payout1\b[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const amount = rawPayout ? text(rawPayout).replace(/^(?:¥|&yen;|￥)\s*/i, '').replaceAll(',', '') : '';
    const expectedParts = betTypeText === '単勝' ? 1 : 3;
    if (selection.length !== expectedParts || selection.some(n => !n)
        || new Set(selection).size !== selection.length || !/^\d+$/.test(amount)) fail();
    const payout = Number(amount);
    if (!Number.isSafeInteger(payout) || payout <= 0) fail();
    payouts.push({ betType: betTypeText === '単勝' ? 'win' : 'trifecta', selection: selection.join('-'), payout });
    }
  }
  if (!payouts.some(p => p.betType === 'win') || new Set(payouts.map(p=>p.betType+':'+p.selection)).size !== payouts.length) fail();
  return payouts;
}

function validateExpected(expected: BoatraceResultExpected): void {
  if (!expected || !/^\d{4}-\d{2}-\d{2}$/.test(expected.raceDate) || !/^\d{2}$/.test(expected.venueCode)
      || !Number.isInteger(expected.raceNo) || expected.raceNo < 1 || expected.raceNo > 12
      || !Array.isArray(expected.entries) || expected.entries.length !== 6) fail();
  if (new Set(expected.entries.map(entry => entry.number)).size !== 6
      || ![1, 2, 3, 4, 5, 6].every(number => expected.entries.some(entry => entry.number === number))
      || expected.entries.some(entry => !/^\d{4,5}$/.test(entry.racerId))) fail();
}

function officialResultIdentity(raw: string): { date: string; venue: string; race: number } {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== OFFICIAL_HOST || url.pathname !== RESULT_PATH
        || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => !['hd', 'jcd', 'rno'].includes(key))) fail();
    const values = ['hd', 'jcd', 'rno'].map(key => url.searchParams.getAll(key));
    if (values.some(all => all.length !== 1)) fail();
    const [date, venue, race] = values.map(all => all[0]);
    if (!/^\d{8}$/.test(date) || !/^\d{2}$/.test(venue) || !/^\d{1,2}$/.test(race)) fail();
    return { date, venue, race: Number(race) };
  } catch { fail(); }
}

function identityFromLink(href: string, requireResult: boolean, date: string, venue: string, race: number): boolean {
  try {
    const url = new URL(decodeEntities(href), `https://${OFFICIAL_HOST}`);
    if (url.hostname !== OFFICIAL_HOST || url.pathname !== RESULT_PATH || (requireResult && url.protocol !== 'https:')) return false;
    const hd = url.searchParams.getAll('hd'), jcd = url.searchParams.getAll('jcd'), rno = url.searchParams.getAll('rno');
    return hd.length === 1 && jcd.length === 1 && rno.length === 1 && hd[0] === date && jcd[0] === venue && rno[0] === String(race);
  } catch { return false; }
}

function isOfficialResultLink(href: string): boolean {
  try {
    const url = new URL(decodeEntities(href), `https://${OFFICIAL_HOST}`);
    return url.protocol === 'https:' && url.hostname === OFFICIAL_HOST && url.pathname === RESULT_PATH;
  } catch { return false; }
}

function sameIdentity(identity: { date: string; venue: string; race: number }, date: string, venue: string, race: number): boolean {
  return identity.date === date && identity.venue === venue && identity.race === race;
}

function text(value: string): string { return decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }
function digit(value: string): number | null {
  const normalized = value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).trim();
  return /^[1-6]$/.test(normalized) ? Number(normalized) : null;
}
function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&yen;/gi, '¥').replace(/&#(\d+);/g, (_all, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_all, n: string) => String.fromCodePoint(parseInt(n, 16)));
}
function fail(): never { throw new Error('official result page rejected'); }
