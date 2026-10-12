import { parseBoatraceCutoff } from './boatraceCutoff.js';
import type { TrifectaOddsIdentity } from './boatraceTrifectaOdds.js';
import { readPageIdentity } from './boatraceTrifectaOdds.js';

export const BEFOREINFO_ARCHIVE_PARSER_VERSION = 'boatrace-beforeinfo-v1';

export type BeforeinfoCapture = {
  cutoffAt: string;
  exhibitions: Array<{
    lane: number;
    exhibitionTime: number | null;
    tilt: number | null;
    weight: number | null;
    startCourse: number | null;
    startTime: number | null;
    falseStart: boolean | null;
  }>;
  weather: Record<string, string | number>;
  weatherObservedAt: string | null;
  weatherObservationLabel: string | null;
};

export function beforeinfoUrl(raceNo: number, venueCode: string, raceDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate) || !/^\d{2}$/.test(venueCode)
      || !Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) throw new Error('invalid race identity');
  return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${raceDate.replaceAll('-', '')}&jcd=${venueCode}&rno=${raceNo}`;
}

/** Parse only values present on the identified official beforeinfo page. */
export function parseBeforeinfoCapture(html: string, expected: TrifectaOddsIdentity, capturedAt: string): BeforeinfoCapture {
  const identity = readPageIdentity(html);
  if (identity.raceDate !== expected.raceDate.replaceAll('-', '')
      || identity.venueCode !== expected.venueCode || identity.raceNo !== expected.raceNo) {
    throw new Error('beforeinfo page identity mismatch');
  }
  const time = parseBoatraceCutoff(html, expected);
  const cutoffAt = `${expected.raceDate}T${time}:00+09:00`;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs) || !/(Z|[+-]\d{2}:\d{2})$/i.test(capturedAt)) throw new Error('invalid capture timestamp');

  const exhibitions = new Map<number, { exhibitionTime: number | null; tilt: number | null; weight: number | null; startCourse: number | null; startTime: number | null; falseStart: boolean | null }>();
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => rowCells(match[1]));
    const headerIndex = rows.findIndex(cells => {
      const header = cells.filter(cell => cell.kind === 'th').map(cell => cell.text.replace(/[\s\u3000]/g, '')).join('');
      return (header.includes('枠') || header.includes('艇')) && header.includes('展示') && header.includes('タイム');
    });
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex].filter(cell => cell.kind === 'th').map(cell => cell.text.replace(/[\s\u3000]/g, ''));
    const laneIndex = headers.findIndex(label => label.includes('枠') || label.includes('艇'));
    const exhibitionIndex = headers.findIndex(label => label.includes('展示') && label.includes('タイム'));
    const tiltIndex = headers.findIndex(label => label.includes('チルト'));
    const weightIndex = headers.findIndex(label => label.includes('体重'));
    for (const row of rows.slice(headerIndex + 1)) {
      const values = row.map(cell => cell.text);
      const lane = laneNumber(values[laneIndex] ?? '');
      if (lane === null || lane > 6 || exhibitions.has(lane)) continue;
      const exhibitionTime = numeric(values[exhibitionIndex] ?? '');
      const tilt = tiltIndex < 0 ? null : numeric(values[tiltIndex] ?? '');
      const weight = weightIndex < 0 ? null : numeric(values[weightIndex] ?? '');
      if (exhibitionTime !== null || tilt !== null || weight !== null) {
        exhibitions.set(lane, { exhibitionTime, tilt, weight, startCourse: null, startTime: null, falseStart: null });
      }
    }
    if (exhibitions.size) break;
  }

  let course = 0;
  const seenStartLanes = new Set<number>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const boatSpans = spansWithClass(row[1], 'table1_boatImage1Number');
    const timeSpans = spansWithClass(row[1], 'table1_boatImage1Time');
    if (!boatSpans.length && !timeSpans.length) continue;
    if (boatSpans.length !== 1 || timeSpans.length !== 1) throw new Error('ambiguous start exhibition spans');
    const lane = laneNumber(boatSpans[0]);
    if (lane === null || seenStartLanes.has(lane)) throw new Error('invalid start exhibition lane');
    seenStartLanes.add(lane);
    course++;
    const previous = exhibitions.get(lane) ?? { exhibitionTime: null, tilt: null, weight: null, startCourse: null, startTime: null, falseStart: null };
    const rawTime = timeSpans[0].trim();
    exhibitions.set(lane, { ...previous, startCourse: course, startTime: numeric(rawTime), falseStart: rawTime ? /^F/i.test(rawTime) : null });
  }

  const pageText = visibleText(html);
  const weather: Record<string, string | number> = {};
  const weatherPatterns: Array<[string, RegExp]> = [
    ['windSpeed', /風速\s*[:：]?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*m/],
    ['waveHeight', /波高\s*[:：]?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*cm/],
    ['airTemperature', /気温\s*[:：]?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*℃/],
    ['waterTemperature', /水温\s*[:：]?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*℃/],
  ];
  for (const [key, pattern] of weatherPatterns) {
    const match = pageText.match(pattern);
    if (match) weather[key] = Number(match[1]);
  }
  const condition = pageText.match(/天候\s*[:：]?\s*(晴れ?|曇り?|雨|雪)/);
  if (condition) weather.weather = condition[1];
  const direction = pageText.match(/風向\s*[:：]?\s*(北東|北西|南東|南西|北|東|南|西)/);
  const windClass = [...html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)].flatMap(match => match[1].split(' '))
    .find(name => /^is-wind(?:[1-9]|1[0-2])$/.test(name));
  if (direction) weather.windDirection = direction[1];
  else if (windClass) {
    const hour = Number(windClass.slice('is-wind'.length));
    const directionByHour: Record<number, string> = { 12: '北', 1: '北東', 2: '北東', 3: '東', 4: '南東', 5: '南東', 6: '南', 7: '南西', 8: '南西', 9: '西', 10: '北西', 11: '北西' };
    weather.windDirection = directionByHour[hour];
    weather.windDirectionClass = windClass;
  }
  const exactWeatherTime = pageText.match(/(?:水面)?気象情報\s*(\d{1,2}:\d{2})\s*現在/);
  const label = pageText.match(/(\d{1,2}:\d{2}\s*現在|\d{1,2}R時点)/)?.[1]?.replace(/\s/g, '') ?? null;
  let weatherObservedAt: string | null = null;
  if (exactWeatherTime) {
    const [hour, minute] = exactWeatherTime[1].split(':').map(Number);
    const observation = `${expected.raceDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}+09:00`;
    if (Date.parse(observation) <= capturedMs) weatherObservedAt = observation;
  }

  const rows = [...exhibitions].sort(([left], [right]) => left - right).map(([lane, values]) => ({ lane, ...values }));
  if (!rows.length && !Object.keys(weather).length) throw new Error('beforeinfo page contains no recognized observations');
  return { cutoffAt, exhibitions: rows, weather, weatherObservedAt, weatherObservationLabel: label };
}

function rowCells(row: string): Array<{ kind: string; text: string }> {
  return [...row.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match => ({ kind: match[1].toLowerCase(), text: visibleText(match[2]) }));
}

function spansWithClass(row: string, className: string): string[] {
  return [...row.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)].filter(match => {
    const classes = match[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? [];
    return classes.includes(className);
  }).map(match => visibleText(match[2]));
}

function laneNumber(value: string): number | null {
  const normalized = value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).trim();
  const match = normalized.match(/(?:^|\D)([1-6])(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function numeric(value: string): number | null {
  const match = value.replaceAll(',', '').trim().match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
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
