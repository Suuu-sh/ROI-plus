import { readPageIdentity, type TrifectaOddsIdentity } from './boatraceTrifectaOdds.js';

export const RACELIST_ARCHIVE_PARSER_VERSION = 'boatrace-racelist-v1';
export type RaceListEntry = { lane: number; registrationNumber: string };

export function raceListUrl(raceNo: number, venueCode: string, raceDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate) || !/^\d{2}$/.test(venueCode)
      || !Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) throw new Error('invalid race identity');
  return `https://www.boatrace.jp/owpc/pc/race/racelist?hd=${raceDate.replaceAll('-', '')}&jcd=${venueCode}&rno=${raceNo}`;
}

/** Parse the selected official racelist's six lane/registration-number pairs. */
export function parseRaceListEntries(html: string, expected: TrifectaOddsIdentity): RaceListEntry[] {
  const identity = readPageIdentity(html);
  if (identity.raceDate !== expected.raceDate.replaceAll('-', '')
      || identity.venueCode !== expected.venueCode || identity.raceNo !== expected.raceNo) {
    throw new Error('racelist page identity mismatch');
  }
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const header = table[1].match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
    const body = table[1].match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
    if (!header || !body) continue;
    const headers = [...header.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => visibleText(match[1]));
    const laneIndex = headers.findIndex(value => value === '枠' || value === '艇');
    const racerIndex = headers.findIndex(value => value.includes('ボートレーサー'));
    if (laneIndex < 0 || racerIndex < 0) continue;
    const entries: RaceListEntry[] = [];
    for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
      if (cells.length <= Math.max(laneIndex, racerIndex)) continue;
      const laneText = visibleText(cells[laneIndex]).replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
      const laneMatch = laneText.match(/(?:^|\D)([1-6])(?:\D|$)/);
      const registrationNumber = [...cells[racerIndex].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)]
        .filter(match => /\bis-fs12\b/.test(match[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] ?? ''))
        .map(match => visibleText(match[2])).find(value => /^\d{4,5}$/.test(value));
      if (!laneMatch || !registrationNumber) continue;
      entries.push({ lane: Number(laneMatch[1]), registrationNumber });
    }
    if (entries.length === 6 && new Set(entries.map(entry => entry.lane)).size === 6
        && new Set(entries.map(entry => entry.registrationNumber)).size === 6
        && [1, 2, 3, 4, 5, 6].every(lane => entries.some(entry => entry.lane === lane))) {
      return entries.sort((left, right) => left.lane - right.lane);
    }
    throw new Error('racelist six-lane registration set incomplete');
  }
  throw new Error('racelist entry table missing');
}

function visibleText(value: string): string {
  return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<br\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\s\u3000]+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_all, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_all, number: string) => String.fromCodePoint(parseInt(number, 16)));
}
