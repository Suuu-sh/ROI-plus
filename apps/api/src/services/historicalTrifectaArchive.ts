import { all, first, run, type Db } from '../repo/db.js'

export const HISTORICAL_ARCHIVE_PREFIX = 'historical-trifecta/v1/real/'
export const HISTORICAL_ARCHIVE_SCHEMA = 'roi-plus-trifecta-observation-v1'
export const HISTORICAL_ARCHIVE_SOURCE = 'historical-trifecta-r2-archive-v1'
const SHA256 = /^[a-f0-9]{64}$/

export type HistoricalObservation = {
  schema: typeof HISTORICAL_ARCHIVE_SCHEMA
  dataOrigin: 'real'
  race: { id: string; raceDate: string; venueId: string; raceNo: number }
  model: Record<string, unknown>
  timing: { phase: 't60'; cutoffAt: string; cutoffSource: string; cutoffObservedAt: string; targetAt: string; predictedAt: string | null; observedAt: string }
  archiveEvidence: { status: 'verified' | 'unavailable'; reason: string | null; id: string | null; capturedAt: string | null; raceListSha256: string | null }
  input: { status: 'complete' | 'unavailable'; missingReason: string | null; rows: Array<Record<string, unknown>> }
  predictions: { status: 'complete' | 'unavailable'; missingReason: string | null; rows: Array<{ selection: string; probability: number; probStd: number }> }
  odds: { status: 'complete' | 'missing'; missingReason: string | null; sourceUrl: string | null; requestedAt: string | null; capturedAt: string | null; sha256: string | null; qualityStatus: string | null; rows: Array<{ selection: string; odds: number }> }
  virtualDecision: { decisionId: string | null; outcome: string | null; totalStake: number | null }
}

export function historicalArchiveKey(raceDate: string, venueId: string, raceNo: number, modelId: string) {
  return `${HISTORICAL_ARCHIVE_PREFIX}${raceDate}/${venueId}/${raceNo}/${modelId}/t-60.json.gz`
}

function historicalAttemptKey(observation: HistoricalObservation) {
  const at = observation.timing.observedAt.replace(/[^0-9]/g, '').slice(0, 17) || 'unknown-time'
  return `${HISTORICAL_ARCHIVE_PREFIX}${observation.race.raceDate}/${observation.race.venueId}/${observation.race.raceNo}/${observation.model.id}/t-60-attempts/${at}.json.gz`
}

export function parseHistoricalArchiveKey(key: string) {
  const match = /^historical-trifecta\/v1\/real\/(\d{4}-\d{2}-\d{2})\/(\d{2})\/(\d{1,2})\/([a-z0-9-]{1,80})\/(t-60\.json\.gz|t-60-attempts\/[0-9]{14,17}\.json\.gz)$/.exec(key)
  if (!match || !Number.isInteger(Number(match[3])) || Number(match[3]) < 1 || Number(match[3]) > 12) return null
  return { raceDate: match[1], venueId: match[2], raceNo: Number(match[3]), modelId: match[4], completeKey: match[5] === 't-60.json.gz' }
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const input = new Blob([JSON.stringify(value)]).stream()
  const compressed = input.pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(compressed).arrayBuffer())
}

export async function persistHistoricalObservations(bucket: R2Bucket, db: Db, observations: HistoricalObservation[]) {
  const report = { attempted: observations.length, stored: 0, alreadyPresent: 0, failed: 0 }
  for (const observation of observations) {
    const complete = observation.archiveEvidence.status === 'verified' && observation.input.status === 'complete'
      && observation.predictions.status === 'complete' && observation.odds.status === 'complete'
    const key = complete
      ? historicalArchiveKey(observation.race.raceDate, observation.race.venueId, observation.race.raceNo, String(observation.model.id))
      : historicalAttemptKey(observation)
    const body = await gzipJson(observation)
    let stored = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await bucket.put(key, body, {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip', cacheControl: 'private, no-store' },
          customMetadata: {
            schema: HISTORICAL_ARCHIVE_SCHEMA,
            raceId: observation.race.id,
            raceDate: observation.race.raceDate,
            venueId: observation.race.venueId,
            raceNo: String(observation.race.raceNo),
            modelId: String(observation.model.id),
            sourceArtifactSha256: String(observation.model.sourceArtifactSha256),
            status: complete ? 'complete' : 'incomplete',
            predictedAt: observation.timing.predictedAt ?? '',
          },
        })
        if (result) { report.stored++; stored = true }
        else report.alreadyPresent++
        stored = true
        break
      } catch {
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
    if (!stored) {
      report.failed++
      const now = new Date().toISOString()
      try {
        await run(db, `INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error,reason)
          VALUES(?,?, 'boat', ?, ?, ?, 'failed', 0, 'r2_write_failed', ?)
          ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status='failed',records=0,error='r2_write_failed',reason=excluded.reason`,
          `historical-trifecta-r2:${observation.race.id}`, HISTORICAL_ARCHIVE_SOURCE, observation.race.raceDate,
          observation.timing.observedAt, now, JSON.stringify({ raceId: observation.race.id, status: 'archive_write_failed' }))
      } catch { /* Coverage remains absent/unknown if the failure marker cannot be committed. */ }
    }
  }
  return report
}

export async function listHistoricalArchiveObjects(bucket: R2Bucket, date: string, cursor: string | undefined, limit: number) {
  const listed = await bucket.list({ prefix: `${HISTORICAL_ARCHIVE_PREFIX}${date}/`, cursor, limit: Math.min(1000, limit) })
  const objects = listed.objects.filter(object => parseHistoricalArchiveKey(object.key)?.raceDate === date)
  return { objects, truncated: listed.truncated, cursor: 'cursor' in listed ? listed.cursor : undefined }
}

export async function historicalArchiveCoverage(db: Db, bucket: R2Bucket, date: string) {
  const races = await all<any>(db, `SELECT r.id,r.race_date,r.venue_id,r.race_no,r.betting_cutoff_at,r.betting_cutoff_source
    FROM races r WHERE r.sport='boat' AND r.data_origin='real' AND r.race_date=?
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY r.betting_cutoff_at,r.venue_id,r.race_no LIMIT 400`, date)
  const prefix = `${HISTORICAL_ARCHIVE_PREFIX}${date}/`
  const listed = await bucket.list({ prefix, limit: 1000 })
  const byKey = new Map(listed.objects.map(object => [object.key, object]))
  const failed = await all<any>(db, `SELECT id,reason,started_at,finished_at FROM collection_runs
    WHERE source=? AND sport='boat' AND target_date=? AND status='failed' ORDER BY started_at DESC LIMIT 400`, HISTORICAL_ARCHIVE_SOURCE, date)
  const failureByRace = new Map<string, any>()
  for (const row of failed) {
    try { const parsed = JSON.parse(row.reason); if (typeof parsed.raceId === 'string' && !failureByRace.has(parsed.raceId)) failureByRace.set(parsed.raceId, row) } catch { /* Ignore malformed marker. */ }
  }
  const entries = races.map(race => {
    const key = historicalArchiveKey(race.race_date, race.venue_id, Number(race.race_no), 'boat-trifecta-historical-base-20261014')
    const object = byKey.get(key), partial = listed.objects.some(candidate => {
      const parsed = parseHistoricalArchiveKey(candidate.key)
      return !!parsed && parsed.raceDate === race.race_date && parsed.venueId === race.venue_id && parsed.raceNo === Number(race.race_no)
        && parsed.modelId === 'boat-trifecta-historical-base-20261014' && !parsed.completeKey
    }), failure = failureByRace.get(race.id)
    const cutoffTrusted = race.betting_cutoff_source === 'boatrace-racelist-cutoff-v1' && Number.isFinite(Date.parse(race.betting_cutoff_at))
    const status = object?.customMetadata?.status === 'complete' ? 'complete' : partial || object ? 'incomplete' : failure ? 'failed' : 'missing'
    return { raceId: race.id, raceDate: race.race_date, venueId: race.venue_id, raceNo: Number(race.race_no), cutoffAt: race.betting_cutoff_at,
      archiveKey: object?.customMetadata?.status === 'complete' ? object.key : null, status, etag: object?.etag ?? null, uploadedAt: object?.uploaded.toISOString() ?? null,
      cutoffTrusted, failureReason: !cutoffTrusted ? 'cutoff_unverified' : failure ? 'archive_write_failed' : partial || object ? 'complete_snapshot_unavailable' : 'archive_not_found' }
  })
  return { schema: 'roi-plus-trifecta-archive-coverage-v1', date, expected: races.length,
    complete: entries.filter(item => item.status === 'complete').length,
    incomplete: entries.filter(item => item.status === 'incomplete').length,
    missing: entries.filter(item => item.status === 'missing').length,
    failed: entries.filter(item => item.status === 'failed').length,
    truncated: listed.truncated, entries }
}

export async function exportHistoricalArchive(bucket: R2Bucket, key: string) {
  const parsed = parseHistoricalArchiveKey(key)
  if (!parsed || parsed.modelId !== 'boat-trifecta-historical-base-20261014') return null
  const object = await bucket.get(key)
  if (!object || object.size > 512 * 1024) return null
  return { object, parsed }
}

function subtractCalendarMonths(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number)
  const monthStart = new Date(Date.UTC(year, month - 1 - months, 1))
  const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate()
  return `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

/** One bounded R2 page per hourly results pass; the cursor cycles at the end. */
export async function listHistoricalLabelTargetRaceIds(bucket: R2Bucket, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const fromDate = subtractCalendarMonths(today, 3)
  const controlKey = 'historical-trifecta/v1/control/result-label-scan.json'
  let cursor: string | undefined
  try {
    const state = await bucket.get(controlKey)
    if (state && state.size <= 4096) {
      const value = await state.json<any>()
      if (value?.schema === 'roi-plus-trifecta-label-scan-cursor-v1' && typeof value.cursor === 'string' && value.cursor.length <= 2048) cursor = value.cursor || undefined
    }
  } catch { cursor = undefined }
  let page: R2Objects
  try { page = await bucket.list({ prefix: HISTORICAL_ARCHIVE_PREFIX, cursor, limit: 80 }) }
  catch {
    cursor = undefined
    page = await bucket.list({ prefix: HISTORICAL_ARCHIVE_PREFIX, limit: 80 })
  }
  const ids = [...new Set(page.objects.flatMap(object => {
    const identity = parseHistoricalArchiveKey(object.key), raceId = object.customMetadata?.raceId
    if (!identity?.completeKey || identity.modelId !== 'boat-trifecta-historical-base-20261014'
        || object.customMetadata?.status !== 'complete' || identity.raceDate < fromDate || identity.raceDate > today
        || typeof raceId !== 'string' || !/^boat-\d{8}-\d{2}-\d{2}$/.test(raceId)) return []
    return [raceId]
  }))].slice(0, 80)
  try {
    await bucket.put(controlKey, JSON.stringify({ schema: 'roi-plus-trifecta-label-scan-cursor-v1',
      cursor: page.truncated ? page.cursor ?? '' : '', updatedAt: now.toISOString() }), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
    })
  } catch { /* A failed cursor save only delays or repeats bounded labels; the D1 result proof remains idempotent. */ }
  return { raceIds: ids, scanned: page.objects.length, truncated: page.truncated, fromDate, throughDate: today }
}

export function validHistoricalArchiveDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}

export function validHistoricalArchiveDigest(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value) }

export function matchesVerifiedResultPairs(proofResults: unknown, savedResults: unknown) {
  if (!Array.isArray(proofResults) || !Array.isArray(savedResults) || proofResults.length !== 6 || savedResults.length !== 6) return false
  const pair = (row: any, orderKey: 'finishOrder' | 'finish_order') => {
    const number = Number(row?.number), finishOrder = Number(row?.[orderKey])
    return Number.isInteger(number) && number >= 1 && number <= 6 && Number.isInteger(finishOrder) && finishOrder >= 1 && finishOrder <= 6
      ? `${number}:${finishOrder}` : null
  }
  const proofPairs = proofResults.map((row: any) => pair(row, 'finishOrder'))
  const savedPairs = savedResults.map((row: any) => pair(row, 'finish_order'))
  return proofPairs.every((value): value is string => value !== null)
    && savedPairs.every((value): value is string => value !== null)
    && new Set(proofPairs).size === 6 && new Set(savedPairs).size === 6
    && proofPairs.every(value => savedPairs.includes(value))
    && [1, 2, 3, 4, 5, 6].every(value => proofResults.some((row: any) => Number(row.number) === value))
    && [1, 2, 3, 4, 5, 6].every(value => proofResults.some((row: any) => Number(row.finishOrder) === value))
}
