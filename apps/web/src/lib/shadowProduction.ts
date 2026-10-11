export const DEFAULT_REAL_RACE_ID = 'boat-20261011-18-07'
export const TRIFECTA_ORDERS = makeTrifectaOrders()
const OFFICIAL_ODDS_SOURCE = 'boatrace-trifecta-official-v1'
const MAX_ODDS_AGE_MS = 10 * 60_000
const SHA256_HEX = /^[a-f0-9]{64}$/

export type StoredPredictionRow = {
  selection: string
  probability: number | null
  probStd: number | null
  featureSchemaVersion: string
  artifactSha256: string
}

export type StoredOddsRow = { selection: string; odds: number | null }

export type HistoricalShadowSnapshot = {
  race: {
    id: string
    sport: string
    venueId: string
    venueName: string
    raceDate: string
    raceNo: number
    postTime: string | null
    status: string
    dataOrigin: string
    entryCount: number
  }
  predictionBatch: null | {
    modelId: string
    modelVersion: string | null
    modelStatus: string | null
    predictedAt: string
    rowCount: number
    rows: StoredPredictionRow[]
  }
  oddsSnapshot: null | {
    capturedAt: string
    source: string | null
    sourceUrl: string | null
    sourceSha256: string | null
    qualityStatus: string | null
    rowCount: number
    rows: StoredOddsRow[]
  }
  pointInTimeAvailability: string
}

export type HistoricalShadowResponse = { snapshot: HistoricalShadowSnapshot; fetchedAt: string }

export type StoredEvidenceReview = {
  predictionCount: number
  oddsCount: number
  probabilityTotal: number
  matchedCount: number
  reasons: string[]
}

function makeTrifectaOrders(): string[] {
  const orders: string[] = []
  for (let first = 1; first <= 6; first += 1) {
    for (let second = 1; second <= 6; second += 1) {
      for (let third = 1; third <= 6; third += 1) {
        if (first !== second && first !== third && second !== third) orders.push(`${first}-${second}-${third}`)
      }
    }
  }
  return orders
}

function isOfficialOddsUrl(value: string | null | undefined, race: HistoricalShadowSnapshot['race']): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'www.boatrace.jp'
      && url.pathname === '/owpc/pc/race/odds3t'
      && url.searchParams.get('jcd') === race.venueId
      && url.searchParams.get('rno') === String(race.raceNo)
      && url.searchParams.get('hd') === race.raceDate.replaceAll('-', '')
  } catch {
    return false
  }
}

export async function fetchHistoricalShadowRace(raceId: string, fetcher: typeof fetch = fetch): Promise<HistoricalShadowResponse> {
  if (!/^boat-\d{8}-\d{2}-\d{2}$/.test(raceId)) throw new Error('Enter one boat race ID such as boat-20261011-18-07.')
  const response = await fetcher(`/api/shadow/races/${encodeURIComponent(raceId)}`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Production historical API returned HTTP ${response.status}.`)
  const snapshot = await response.json() as HistoricalShadowSnapshot
  if (!snapshot || snapshot.race?.id !== raceId || snapshot.race.sport !== 'boat' || snapshot.race.dataOrigin !== 'real') {
    throw new Error('The API response did not match the requested real boat race.')
  }
  return { snapshot, fetchedAt: new Date().toISOString() }
}

export function inspectStoredEvidence(snapshot: HistoricalShadowSnapshot, now = Date.now()): StoredEvidenceReview {
  const predictionRows = snapshot.predictionBatch?.rows ?? []
  const oddsRows = snapshot.oddsSnapshot?.rows ?? []
  const prediction = snapshot.predictionBatch
  const oddsSnapshot = snapshot.oddsSnapshot
  const predictions = new Map(predictionRows.map((row) => [row.selection, row]))
  const odds = new Map(oddsRows.map((row) => [row.selection, row]))
  const probabilityTotal = predictionRows.reduce((sum, row) =>
    sum + (typeof row.probability === 'number' && Number.isFinite(row.probability) ? row.probability : 0), 0)
  const matchedCount = TRIFECTA_ORDERS.filter((selection) => predictions.has(selection) && odds.has(selection)).length
  const reasons: string[] = []

  if (predictionRows.length !== 120 || predictions.size !== 120 || TRIFECTA_ORDERS.some((selection) => !predictions.has(selection))) {
    reasons.push(`Stored prediction batch has ${predictionRows.length} rows; exactly 120 distinct trifecta orders are required.`)
  }
  if (predictionRows.some((row) => typeof row.probability !== 'number' || !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1)
      || Math.abs(probabilityTotal - 1) > 1e-9) {
    reasons.push('Stored probabilities are missing, invalid, or not normalized.')
  }
  if (predictionRows.some((row) => typeof row.probStd !== 'number' || !Number.isFinite(row.probStd) || row.probStd < 0 || row.probStd > 1)) {
    reasons.push('Stored uncertainty values are missing or invalid.')
  }
  const artifactHashes = new Set(predictionRows.map((row) => row.artifactSha256))
  const featureSchemas = new Set(predictionRows.map((row) => row.featureSchemaVersion))
  if (artifactHashes.size !== 1 || !SHA256_HEX.test(predictionRows[0]?.artifactSha256 ?? '')
      || featureSchemas.size !== 1 || !prediction?.modelId || !prediction.modelVersion) {
    reasons.push('A consistent model identity, artifact hash, and feature schema are missing.')
  }
  if (oddsRows.length !== 120 || odds.size !== 120 || TRIFECTA_ORDERS.some((selection) => !odds.has(selection))) {
    reasons.push(`Stored odds snapshot has ${oddsRows.length} rows; exactly 120 distinct trifecta orders are required.`)
  }
  if (oddsRows.some((row) => typeof row.odds !== 'number' || !Number.isFinite(row.odds) || row.odds <= 0)) {
    reasons.push('Stored odds include missing or invalid values.')
  }

  const predictedAt = prediction?.predictedAt ? Date.parse(prediction.predictedAt) : Number.NaN
  const capturedAt = oddsSnapshot?.capturedAt ? Date.parse(oddsSnapshot.capturedAt) : Number.NaN
  const postTime = snapshot.race.postTime ? Date.parse(snapshot.race.postTime) : Number.NaN
  if (!prediction || !Number.isFinite(predictedAt) || predictedAt > now) reasons.push('A valid non-future prediction timestamp is missing.')
  if (!oddsSnapshot || !Number.isFinite(capturedAt) || capturedAt > now) reasons.push('A valid non-future odds snapshot timestamp is missing.')
  if (Number.isFinite(postTime) && Number.isFinite(predictedAt) && predictedAt >= postTime) reasons.push('Prediction timestamp is not before the race post time.')
  if (Number.isFinite(predictedAt) && Number.isFinite(capturedAt)) {
    if (capturedAt > predictedAt) reasons.push('Odds snapshot was captured after the stored prediction time.')
    else if (predictedAt - capturedAt > MAX_ODDS_AGE_MS) reasons.push('Odds snapshot was stale at the stored prediction time.')
  }
  if (oddsSnapshot?.source !== OFFICIAL_ODDS_SOURCE || oddsSnapshot.qualityStatus !== 'verified-complete-v1'
      || !isOfficialOddsUrl(oddsSnapshot.sourceUrl, snapshot.race)
      || !SHA256_HEX.test(oddsSnapshot.sourceSha256 ?? '')) {
    reasons.push('Official odds source, completeness marker, URL, or source hash is missing.')
  }
  if (snapshot.pointInTimeAvailability !== 'recorded') reasons.push('Point-in-time input availability is not recorded for these stored predictions.')
  if (snapshot.race.status !== 'scheduled' || !Number.isFinite(postTime) || postTime <= now) {
    reasons.push('This is a historical race snapshot; it cannot create a live candidate.')
  }

  return { predictionCount: predictionRows.length, oddsCount: oddsRows.length, probabilityTotal, matchedCount, reasons: [...new Set(reasons)] }
}
