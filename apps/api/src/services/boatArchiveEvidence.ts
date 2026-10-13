import { isCompleteTicketDistribution } from '@edgelab/shared';
import { beforeinfoUrl } from './boatraceBeforeinfo.js';
import { raceListUrl } from './boatraceRaceList.js';

const SHA256 = /^[a-f0-9]{64}$/;
const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);

/** Exact, source-bound T-60 archive check shared by the decision and label paths. */
export function boatArchiveEvidenceValid(archive: any, race: any, entries: any[]): boolean {
  if (!archive || archive.schema !== 'boat-prerace-capture-v1' || archive.race?.id !== race.id
      || archive.race?.date !== race.race_date || archive.race?.venueCode !== race.venue_id
      || Number(archive.race?.raceNo) !== Number(race.race_no)
      || !Array.isArray(archive.race?.lanes) || archive.race.lanes.length !== 6
      || archive.race.lanes.some((x: any, i: number) => Number(x) !== i + 1)
      || archive.raceList?.cutoffAt !== race.betting_cutoff_at
      || archive.raceList?.url !== raceListUrl(Number(race.race_no), String(race.venue_id), String(race.race_date))
      || !Array.isArray(archive.raceList?.entries) || archive.raceList.entries.length !== 6
      || archive.beforeinfo?.url !== beforeinfoUrl(Number(race.race_no), String(race.venue_id), String(race.race_date))
      || !Array.isArray(archive.beforeinfo?.exhibitions) || archive.beforeinfo.exhibitions.length !== 6
      || !Array.isArray(archive.trifectaOdds?.odds) || archive.trifectaOdds.qualityStatus !== 'verified-complete-v1'
      || archive.trifectaOdds.final !== false || archive.trifectaOdds.odds.length !== 120
      || !isSha256(archive.beforeinfo?.sha256) || !isSha256(archive.raceList?.sha256)
      || !isSha256(archive.trifectaOdds?.sha256) || !officialTrifectaUrl(archive.trifectaOdds?.url, race)) return false;
  const savedRacers = new Map<number, string>();
  for (const row of entries) {
    let racerId = '';
    try { const feature = JSON.parse(row.features_json ?? '{}'); if (typeof feature.racer_id === 'string') racerId = feature.racer_id; }
    catch { return false; }
    if (!Number.isInteger(Number(row.number)) || !/^\d{4,5}$/.test(racerId)) return false;
    savedRacers.set(Number(row.number), racerId);
  }
  if (savedRacers.size !== 6) return false;
  const officialRacers = new Map<number, string>();
  for (const row of archive.raceList.entries) {
    if (!Number.isInteger(Number(row.lane)) || typeof row.registrationNumber !== 'string') return false;
    officialRacers.set(Number(row.lane), row.registrationNumber);
  }
  if (officialRacers.size !== 6 || [1, 2, 3, 4, 5, 6].some(n => savedRacers.get(n) !== officialRacers.get(n))) return false;
  const exhibitions = new Map<number, any>();
  for (const row of archive.beforeinfo.exhibitions) {
    if (!Number.isInteger(Number(row.lane)) || !Number.isFinite(row.exhibitionTime) || row.exhibitionTime <= 0) return false;
    exhibitions.set(Number(row.lane), row);
  }
  if (exhibitions.size !== 6 || [1, 2, 3, 4, 5, 6].some(n => !exhibitions.has(n))) return false;
  const odds = archive.trifectaOdds.odds;
  return odds.every((x: any) => x && typeof x.selection === 'string' && Number.isFinite(x.odds) && x.odds > 1)
    && isCompleteTicketDistribution('trifecta', [1, 2, 3, 4, 5, 6], odds.map((x: any) => x.selection), odds.map(() => 1 / odds.length));
}

function officialTrifectaUrl(sourceUrl: unknown, race: any): boolean {
  if (typeof sourceUrl !== 'string') return false;
  try {
    const url = new URL(sourceUrl);
    return url.protocol === 'https:' && url.hostname === 'www.boatrace.jp' && url.pathname === '/owpc/pc/race/odds3t'
      && url.searchParams.get('jcd') === String(race.venue_id)
      && url.searchParams.get('rno') === String(race.race_no)
      && url.searchParams.get('hd') === String(race.race_date).replaceAll('-', '');
  } catch { return false; }
}
