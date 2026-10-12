import { all, first, type Db, type Statement } from '../repo/db.js';
import { beforeinfoUrl, parseBeforeinfoCapture, BEFOREINFO_ARCHIVE_PARSER_VERSION } from './boatraceBeforeinfo.js';
import { parseTrifectaOdds, trifectaOddsUrl } from './boatraceTrifectaOdds.js';
import { parseRaceListEntries, raceListUrl, RACELIST_ARCHIVE_PARSER_VERSION } from './boatraceRaceList.js';
import { parseBoatraceCutoff } from './boatraceCutoff.js';
import { USER_AGENT } from './boatraceOdds.js';
import { estimateWorkerWriteUnits, reserveWriteBudget, utcDate } from './writeBudget.js';

const SOURCE = 'boatrace-prerace-archive-worker-v1';
const ARCHIVE_SCHEMA = 'boat-prerace-capture-v1';
const TRIFECTA_PARSER_VERSION = 'boatrace-trifecta-odds-v1';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024;
const MAX_RACES_PER_TICK = 4;
const MAX_CANDIDATES = 180;
const SHA256 = /^[a-f0-9]{64}$/;

export type SharedCaptureRequestBudget = { used: number; max: number };
type RaceCandidate = {
  id: string;
  venue_id: string;
  race_no: number;
  race_date: string;
  post_time: string;
  entry_count: number;
};
type SavedEntry = { number: number; features_json: string | null };
type Failure = { raceId: string; reason: string };
type FetchResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'body'>;
export type CaptureArchiveOptions = {
  requestBudget?: SharedCaptureRequestBudget;
  maxRaces?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<FetchResponse>;
  now?: () => number;
};

const jstIso = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const jstDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sha256 = async (bytes: Uint8Array) => {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

/** Data-only archive path: one bounded JSON write per complete capture, with no model or prediction reads. */
export async function collectBoatraceCaptureArchives(db: Db, scheduledAt: Date, opts: CaptureArchiveOptions = {}) {
  const clock = opts.now ?? Date.now;
  const requestBudget = opts.requestBudget ?? { used: 0, max: 49 };
  const startingRequestCount = requestBudget.used;
  const maxRaces = Math.min(MAX_RACES_PER_TICK, Math.max(0, Math.floor(opts.maxRaces ?? MAX_RACES_PER_TICK)));
  const at = scheduledAt.getTime();
  const date = jstDate(at);
  if (!Number.isFinite(at) || maxRaces === 0) return { status: 'skipped' as const, reason: 'invalid_schedule_or_zero_capacity', targets: 0, attempted: 0, records: 0, failures: [] as Failure[], deferred: 0 };

  const after = jstIso(at), before = jstIso(at + 15 * 60_000);
  const candidates = await all<RaceCandidate>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date,r.post_time,
      (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real') entry_count
    FROM races r
    WHERE r.data_origin='real' AND r.sport='boat' AND r.status='scheduled' AND r.race_date=?
      AND r.post_time>=? AND r.post_time<=?
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives a WHERE a.race_id=r.id)
    ORDER BY r.post_time ASC,r.id ASC LIMIT ?`, date, after, before, MAX_CANDIDATES);
  if (!candidates.length) return { status: 'skipped' as const, reason: 'no_due_races', targets: 0, attempted: 0, records: 0, failures: [] as Failure[], deferred: 0 };

  const budget = Math.max(0, Math.floor(requestBudget.max - requestBudget.used));
  const admittedCount = Math.min(maxRaces, candidates.filter(row => row.entry_count === 6).length, Math.floor(budget / 3));
  if (admittedCount === 0) {
    const reason = candidates.every(row => row.entry_count !== 6) ? 'no_six_lane_races' : 'shared_subrequest_budget_exhausted';
    return { status: 'skipped' as const, reason, targets: 0, attempted: 0, records: 0, failures: [] as Failure[], deferred: candidates.length };
  }

  const cursorRow = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key='boatrace_capture_archive_cursor'");
  const cursor = typeof cursorRow?.value === 'string' ? cursorRow.value : '';
  const sortKey = (race: RaceCandidate) => `${race.post_time}|${race.id}`;
  const eligible = candidates.filter(row => row.entry_count === 6);
  const start = cursor ? eligible.findIndex(row => sortKey(row) > cursor) : 0;
  const rotated = start < 0 ? eligible : [...eligible.slice(start), ...eligible.slice(0, start)];
  const targets = rotated.slice(0, admittedCount);
  const deferred = Math.max(0, eligible.length - targets.length);
  const failures: Failure[] = candidates.filter(row => row.entry_count !== 6)
    .slice(0, 50).map(row => ({ raceId: row.id, reason: 'race_not_six_lane' }));

  const raceIds = targets.map(row => row.id);
  const lanes = raceIds.length ? await all<{ race_id: string; number: number }>(db,
    `SELECT race_id,number FROM entries WHERE data_origin='real' AND race_id IN (${raceIds.map(() => '?').join(',')}) ORDER BY race_id,number`, ...raceIds) : [];
  const laneGroups = new Map<string, number[]>();
  for (const row of lanes) laneGroups.set(row.race_id, [...(laneGroups.get(row.race_id) ?? []), Number(row.number)]);
  const validTargets: RaceCandidate[] = [];
  for (const race of targets) {
    const values = laneGroups.get(race.id) ?? [];
    if (values.length !== 6 || [...values].sort((a, b) => a - b).some((number, index) => number !== index + 1)) {
      failures.push({ raceId: race.id, reason: 'entry_lane_set_not_six' });
      continue;
    }
    if (!/^boat-(\d{8})-(\d{2})-(\d{2})$/.test(race.id)
        || race.id !== `boat-${race.race_date.replaceAll('-', '')}-${race.venue_id}-${String(race.race_no).padStart(2, '0')}`) {
      failures.push({ raceId: race.id, reason: 'race_identity_mismatch' });
      continue;
    }
    validTargets.push(race);
  }
  if (!validTargets.length) {
    const lastSelected = targets.at(-1);
    if (lastSelected && await reserveWriteBudget(db, utcDate(scheduledAt), estimateWorkerWriteUnits(1), 'odds')) {
      await db.prepare(`INSERT INTO settings(key,value) VALUES('boatrace_capture_archive_cursor',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(sortKey(lastSelected)).run();
    }
    return { status: 'skipped' as const, reason: 'no_valid_six_lane_races', targets: targets.length, attempted: 0, records: 0, failures, deferred };
  }

  // The archive uses the existing odds sub-cap: reserve control mutations plus
  // one conservative Worker-row estimate per JSON archive before any fetch.
  const reservedUnits = estimateWorkerWriteUnits(5) + validTargets.length * estimateWorkerWriteUnits(1);
  if (!await reserveWriteBudget(db, utcDate(scheduledAt), reservedUnits, 'odds')) {
    return { status: 'skipped' as const, reason: 'd1_write_budget_unavailable_or_exhausted', targets: validTargets.length, attempted: 0, records: 0, failures, deferred };
  }

  const nowIso = jstIso(clock()), staleIso = jstIso(clock() - 5 * 60_000);
  await db.prepare("INSERT INTO settings(key,value) VALUES('boatrace_capture_archive_lock','') ON CONFLICT(key) DO NOTHING").run();
  const lock = await db.prepare("UPDATE settings SET value=? WHERE key='boatrace_capture_archive_lock' AND value<?").bind(nowIso, staleIso).run();
  if (!lock.meta?.changes) return { status: 'skipped' as const, reason: 'collector_lease_held', targets: validTargets.length, attempted: 0, records: 0, failures, deferred };

  const fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? pause;
  let lastAttemptKey = cursor;
  let attempted = 0, records = 0;
  const statements: Statement[] = [];
  try {
    for (const race of validTargets) {
      lastAttemptKey = sortKey(race);
      const identity = { raceDate: race.race_date, venueCode: race.venue_id, raceNo: race.race_no };
      const beforeUrl = beforeinfoUrl(race.race_no, race.venue_id, race.race_date);
      const raceListPageUrl = raceListUrl(race.race_no, race.venue_id, race.race_date);
      const oddsUrl = trifectaOddsUrl(race.race_no, race.venue_id, race.race_date);
      try {
        const savedEntries = await all<SavedEntry>(db,
          'SELECT number,features_json FROM entries WHERE race_id=? AND data_origin=\'real\' ORDER BY number', race.id);
        const savedRacers = new Map<number, string>();
        for (const entry of savedEntries) {
          let racerId = '';
          try { const value = JSON.parse(entry.features_json ?? '{}').racer_id; if (typeof value === 'string') racerId = value; } catch { /* malformed source identity fails closed */ }
          if (/^\d{4,5}$/.test(racerId)) savedRacers.set(entry.number, racerId);
        }
        if (savedRacers.size !== 6) throw new CaptureFailure('saved_registry_incomplete');

        const raceList = await fetchSource(raceListPageUrl, requestBudget, attempted, fetcher, sleep, clock);
        attempted++;
        const raceListEntries = parseRaceListEntries(raceList.text, identity);
        const raceListCutoff = `${race.race_date}T${parseBoatraceCutoff(raceList.text, identity)}:00+09:00`;
        if (raceListEntries.some(entry => savedRacers.get(entry.lane) !== entry.registrationNumber)) {
          throw new CaptureFailure('racelist_registry_mismatch');
        }

        const beforeinfo = await fetchSource(beforeUrl, requestBudget, attempted, fetcher, sleep, clock);
        attempted++;
        const parsedBeforeinfo = parseBeforeinfoCapture(beforeinfo.text, identity, beforeinfo.capturedAt);
        if (raceListCutoff !== parsedBeforeinfo.cutoffAt) throw new CaptureFailure('racelist_cutoff_mismatch');
        const cutoffMs = Date.parse(parsedBeforeinfo.cutoffAt);
        const t60Ms = cutoffMs - 60_000;
        const earliestMs = cutoffMs - 10 * 60_000;
        const sourceTimes = [Date.parse(raceList.capturedAt), Date.parse(beforeinfo.capturedAt)];
        if (!Number.isFinite(cutoffMs)) throw new CaptureFailure('beforeinfo_cutoff_invalid');
        if (sourceTimes.some(value => !Number.isFinite(value) || value < earliestMs)) throw new CaptureFailure(sourceTimes[0] < earliestMs ? 'racelist_arrival_too_early' : 'beforeinfo_arrival_too_early');
        if (sourceTimes.some(value => !Number.isFinite(value) || value > t60Ms)) throw new CaptureFailure('source_arrival_after_t60');
        if (parsedBeforeinfo.exhibitions.length !== 6
            || parsedBeforeinfo.exhibitions.some((entry, index) => entry.lane !== index + 1)
            || !Object.keys(parsedBeforeinfo.weather).length) throw new CaptureFailure('beforeinfo_observations_incomplete');

        const odds = await fetchSource(oddsUrl, requestBudget, attempted, fetcher, sleep, clock);
        attempted++;
        const oddsAt = Date.parse(odds.capturedAt);
        if (!Number.isFinite(oddsAt) || oddsAt < earliestMs || oddsAt > t60Ms) throw new CaptureFailure('odds_outside_t60_window');
        const parsedOdds = parseTrifectaOdds(odds.text, identity);
        if (parsedOdds.final) throw new CaptureFailure('trifecta_market_final');
        if (parsedOdds.odds.length !== 120 || parsedOdds.odds.some(row => !Number.isFinite(row.odds) || row.odds <= 0)) {
          throw new CaptureFailure('trifecta_market_incomplete');
        }
        const capturedAt = odds.capturedAt;
        const archive = {
          schema: ARCHIVE_SCHEMA,
          race: { id: race.id, date: race.race_date, venueCode: race.venue_id, raceNo: race.race_no, lanes: [1, 2, 3, 4, 5, 6] },
          capturedAt,
          archivedAt: jstIso(clock()),
          beforeinfo: {
            url: beforeUrl, sha256: beforeinfo.sha256, capturedAt: beforeinfo.capturedAt,
            parserVersion: BEFOREINFO_ARCHIVE_PARSER_VERSION, ...parsedBeforeinfo,
          },
          raceList: {
            url: raceListPageUrl, sha256: raceList.sha256, capturedAt: raceList.capturedAt,
            parserVersion: RACELIST_ARCHIVE_PARSER_VERSION, cutoffAt: raceListCutoff, entries: raceListEntries,
          },
          trifectaOdds: {
            url: oddsUrl, sha256: odds.sha256, capturedAt: odds.capturedAt,
            parserVersion: TRIFECTA_PARSER_VERSION, qualityStatus: parsedOdds.qualityStatus,
            final: parsedOdds.final, odds: parsedOdds.odds,
          },
        };
        const archiveJson = JSON.stringify(archive);
        if (new TextEncoder().encode(archiveJson).byteLength > MAX_ARCHIVE_BYTES) throw new CaptureFailure('archive_size_limit');
        if (!SHA256.test(raceList.sha256) || !SHA256.test(beforeinfo.sha256) || !SHA256.test(odds.sha256)) throw new CaptureFailure('source_hash_invalid');
        const id = `${race.id}:capture:${String(Math.floor(Date.parse(capturedAt))).padStart(13, '0')}`;
        statements.push(db.prepare(`INSERT INTO boatrace_prerace_capture_archives(id,race_id,race_date,captured_at,archive_json,data_origin)
          VALUES(?,?,?,?,?,'real') ON CONFLICT(race_id,captured_at) DO NOTHING`)
          .bind(id, race.id, race.race_date, capturedAt, archiveJson));
        records++;
      } catch (error) {
        failures.push({ raceId: race.id, reason: error instanceof CaptureFailure ? error.code : classifyFailure(error) });
      }
    }

    let archiveWriteFailed = false;
    try {
      if (statements.length) {
        if (db.batch) await db.batch(statements);
        else for (const statement of statements) await statement.run();
      }
    } catch { archiveWriteFailed = true; }
    if (archiveWriteFailed) {
      failures.push(...validTargets.map(row => ({ raceId: row.id, reason: 'archive_write_failed' })));
      records = 0;
    }
    if (lastAttemptKey) {
      await db.prepare(`INSERT INTO settings(key,value) VALUES('boatrace_capture_archive_cursor',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(lastAttemptKey).run();
    }
    if (failures.length) await persistFailures(db, scheduledAt, failures, records);
    if (archiveWriteFailed) return { status: 'failed' as const, reason: 'archive_write_failed', targets: validTargets.length, attempted: requestBudget.used - startingRequestCount, records, failures, deferred };
    const status = failures.length ? (records ? 'partial' : 'failed') : 'success';
    return { status, targets: validTargets.length, attempted: requestBudget.used - startingRequestCount, records, failures, deferred };
  } finally {
    await db.prepare("UPDATE settings SET value='' WHERE key='boatrace_capture_archive_lock' AND value=?").bind(nowIso).run().catch(() => undefined);
  }
}

class CaptureFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

async function fetchSource(url: string, budget: SharedCaptureRequestBudget, requestsMade: number,
  fetcher: NonNullable<CaptureArchiveOptions['fetch']>, sleep: NonNullable<CaptureArchiveOptions['sleep']>, clock: () => number) {
  if (budget.used >= budget.max) throw new CaptureFailure('shared_subrequest_budget_exhausted');
  if (requestsMade > 0 || budget.used > 0) await sleep(3_000);
  budget.used++;
  let response: FetchResponse;
  try { response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' }); }
  catch { throw new CaptureFailure('source_fetch_failed'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CaptureFailure('source_http_error');
  }
  const bytes = await readBoundedBody(response);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CaptureFailure('source_encoding_invalid'); }
  return { text, sha256: await sha256(bytes), capturedAt: jstIso(clock()) };
}

async function readBoundedBody(response: FetchResponse): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CaptureFailure('source_body_too_large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CaptureFailure('source_body_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CaptureFailure) throw error;
    throw new CaptureFailure('source_read_failed');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('identity')) return 'page_identity_mismatch';
  if (message.includes('cutoff')) return 'beforeinfo_cutoff_unavailable';
  if (message.includes('trifecta') || message.includes('odds')) return 'trifecta_market_incomplete';
  if (message.includes('start exhibition')) return 'beforeinfo_start_data_invalid';
  return 'source_parse_failed';
}

async function persistFailures(db: Db, at: Date, failures: Failure[], records: number) {
  const date = jstDate(at.getTime());
  const id = `${SOURCE}:${date}`;
  const reason = JSON.stringify(failures.slice(0, 50).sort((a, b) => a.raceId.localeCompare(b.raceId)));
  const status = records ? 'partial' : 'failed';
  const error = failures.slice(0, 50).map(item => `${item.raceId}:${item.reason}`).join(',').slice(0, 2_000);
  const previous = await first<{ status: string; reason: string | null; error: string | null }>(db,
    'SELECT status,reason,error FROM collection_runs WHERE id=?', id);
  if (previous?.status === status && previous.reason === reason && previous.error === error) return;
  if (!await reserveWriteBudget(db, utcDate(at), 5, 'collection')) return;
  await db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error,reason)
    VALUES(?,?,'boat',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at,
      finished_at=excluded.finished_at,status=excluded.status,records=excluded.records,error=excluded.error,reason=excluded.reason`)
    .bind(id, SOURCE, date, jstIso(at.getTime()), jstIso(Date.now()), status, records, error, reason).run();
}
