import { readPageIdentity, type TrifectaOddsIdentity } from './boatraceTrifectaOdds.js';

const TIME_SOURCE = '\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b';
const TIME = new RegExp(TIME_SOURCE, 'g');
export const BOATRACE_CUTOFF_REFRESH_MS = 5 * 60_000;
export const BOATRACE_CUTOFF_MAX_AGE_MS = 10 * 60_000;

/** Read only an explicitly labelled BOAT RACE scheduled cutoff from an
 * already-fetched official race page. The page identity is checked before the
 * schedule row is interpreted; an absent or changed page shape fails closed.
 */
export function parseBoatraceCutoff(html: string, expected: TrifectaOddsIdentity): string {
  const identity = readPageIdentity(html);
  if (identity.raceDate !== expected.raceDate.replaceAll('-', '')
      || identity.venueCode !== expected.venueCode || identity.raceNo !== expected.raceNo) {
    throw new Error('official cutoff page identity mismatch');
  }
  if (!Number.isInteger(expected.raceNo) || expected.raceNo < 1 || expected.raceNo > 12) {
    throw new Error('invalid official cutoff race number');
  }

  const candidates: string[] = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = visibleText(match[1]);
    if (!row.includes('締切予定時刻')) continue;
    const times = [...row.matchAll(new RegExp(TIME_SOURCE, 'g'))].map(time => `${time[1].padStart(2, '0')}:${time[2]}`);
    if (times.length === 0) continue;
    if (times.length === 1) candidates.push(times[0]);
    else if (times.length === 12) candidates.push(times[expected.raceNo - 1]);
    else throw new Error('official cutoff schedule row is incomplete or ambiguous');
  }

  if (!candidates.length) {
    // Some official views render the selected race's labelled time outside a
    // table row. Only accept a single time immediately following the label.
    const plain = visibleText(html);
    for (const label of plain.matchAll(/締切予定時刻/g)) {
      const following = plain.slice(label.index! + label[0].length, label.index! + label[0].length + 48);
      const time = following.match(new RegExp(TIME_SOURCE));
      if (time) candidates.push(`${time[1].padStart(2, '0')}:${time[2]}`);
    }
  }

  if (!candidates.length || new Set(candidates).size !== 1) {
    throw new Error('explicit official cutoff label/time missing or ambiguous');
  }
  return candidates[0];
}

function visibleText(value: string): string {
  return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\s\u3000]+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_all, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_all, n: string) => String.fromCodePoint(parseInt(n, 16)));
}
