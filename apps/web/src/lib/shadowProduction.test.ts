import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REAL_RACE_ID,
  fetchHistoricalShadowRace,
  inspectStoredEvidence,
  TRIFECTA_ORDERS,
  type HistoricalShadowSnapshot,
} from './shadowProduction'

const predictionAt = '2026-10-11T02:00:00.000Z'
const oddsAt = '2026-10-11T01:56:00.000Z'
const sourceHash = 'a'.repeat(64)
const artifactHash = 'b'.repeat(64)
const testNow = Date.parse('2026-10-11T02:05:00.000Z')

function makeSnapshot(): HistoricalShadowSnapshot {
  return {
    race: { id: DEFAULT_REAL_RACE_ID, sport: 'boat', venueId: '18', venueName: '徳山', raceDate: '2026-10-11', raceNo: 7,
      postTime: '2026-10-11T02:35:00.000Z', status: 'finished', dataOrigin: 'real', entryCount: 6 },
    predictionBatch: { modelId: 'boat-trifecta-test', modelVersion: 'test-v1', modelStatus: 'candidate', predictedAt: predictionAt,
      rowCount: 120, rows: TRIFECTA_ORDERS.map((selection) => ({ selection, probability: 1 / 120, probStd: 0.001,
        featureSchemaVersion: 'ticket-selection-v1', artifactSha256: artifactHash })) },
    oddsSnapshot: { capturedAt: oddsAt, source: 'boatrace-trifecta-official-v1',
      sourceUrl: 'https://www.boatrace.jp/owpc/pc/race/odds3t?jcd=18&rno=7&hd=20261011',
      sourceSha256: sourceHash, qualityStatus: 'verified-complete-v1', rowCount: 120,
      rows: TRIFECTA_ORDERS.map((selection) => ({ selection, odds: 10 })) },
    pointInTimeAvailability: 'not-recorded',
  }
}

describe('production historical shadow view', () => {
  it('enumerates all 120 distinct trifecta orders', () => {
    expect(TRIFECTA_ORDERS).toHaveLength(120)
    expect(new Set(TRIFECTA_ORDERS).size).toBe(120)
  })

  it('reads the exact production route and rejects malformed or sample responses', async () => {
    const snapshot = makeSnapshot()
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(snapshot), { status: 200 }))
    const result = await fetchHistoricalShadowRace(DEFAULT_REAL_RACE_ID, fetcher as typeof fetch)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/shadow/races/${DEFAULT_REAL_RACE_ID}`)
    expect(result.snapshot.race.id).toBe(DEFAULT_REAL_RACE_ID)
    await expect(fetchHistoricalShadowRace('not-a-race', fetcher as typeof fetch)).rejects.toThrow('Enter one boat race ID')

    const sampleFetcher = vi.fn(async () => new Response(JSON.stringify({ ...snapshot, race: { ...snapshot.race, dataOrigin: 'sample' } }), { status: 200 }))
    await expect(fetchHistoricalShadowRace(DEFAULT_REAL_RACE_ID, sampleFetcher as typeof fetch)).rejects.toThrow('did not match')
  })

  it('keeps a complete 120-way record as abstain when availability provenance and live status are absent', () => {
    const snapshot = makeSnapshot()
    const review = inspectStoredEvidence(snapshot, testNow)
    expect(review.predictionCount).toBe(120)
    expect(review.oddsCount).toBe(120)
    expect(review.matchedCount).toBe(120)
    expect(review.probabilityTotal).toBeCloseTo(1, 12)
    expect(review.reasons).toContain('Point-in-time input availability is not recorded for these stored predictions.')
    expect(review.reasons).toContain('This is a historical race snapshot; it cannot create a live candidate.')
  })

  it('rejects incomplete distributions and odds captured after the prediction cutoff', () => {
    const snapshot = makeSnapshot()
    const incomplete: HistoricalShadowSnapshot = { ...snapshot,
      predictionBatch: { ...snapshot.predictionBatch!, rowCount: 119, rows: snapshot.predictionBatch!.rows.slice(0, 119) } }
    expect(inspectStoredEvidence(incomplete, testNow).reasons)
      .toContain('Stored prediction batch has 119 rows; exactly 120 distinct trifecta orders are required.')

    const postCutoff: HistoricalShadowSnapshot = { ...snapshot,
      oddsSnapshot: { ...snapshot.oddsSnapshot!, capturedAt: '2026-10-11T02:01:00.000Z' } }
    expect(inspectStoredEvidence(postCutoff, testNow).reasons)
      .toContain('Odds snapshot was captured after the stored prediction time.')
  })
})
