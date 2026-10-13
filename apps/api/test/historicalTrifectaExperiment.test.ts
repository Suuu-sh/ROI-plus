import { afterEach, describe, expect, it, vi } from 'vitest'
import Sqlite from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { D1SqliteAdapter } from './d1-adapter.js'
import { historicalTrifectaExperimentDecision } from '../src/services/historicalTrifectaExperiment.js'
import { purchaseOddsContext } from '../src/services/purchaseOdds.js'
import { beforeinfoUrl } from '../src/services/boatraceBeforeinfo.js'
import { raceListUrl } from '../src/services/boatraceRaceList.js'
import { trifectaOddsUrl } from '../src/services/boatraceTrifectaOdds.js'

const root = resolve(import.meta.dirname, '../../..')
const sha = 'a'.repeat(64)
const jst = (ms: number) => new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00')
const sourceBUrl = 'https://www1.mbrace.or.jp/od2/B/202610/b261015.lzh'
const marketHtml = () => {
  const lanes = [1, 2, 3, 4, 5, 6], rows: string[] = []
  for (let group = 0; group < 5; group++) for (let row = 0; row < 4; row++) rows.push(`<tr>${lanes.map(a => {
    const b = lanes.filter(x => x !== a)[group], c = lanes.filter(x => x !== a && x !== b)[row]
    return `${row === 0 ? `<td rowspan="4">${b}</td>` : ''}<td>${c}</td><td>200</td>`
  }).join('')}</tr>`)
  return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=1&amp;jcd=01&amp;hd=20261015">出走表</a><a href="/owpc/pc/race/raceresult?rno=1&amp;jcd=01&amp;hd=20261015">結果</a></div><p>オッズ更新時間 12:00</p><span>3連単オッズ</span><table><thead><tr>${lanes.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
}

function createFixture(actualArrival: string) {
  const sqlite = new Sqlite(':memory:')
  for (const file of readdirSync(resolve(root, 'db/migrations')).filter(x => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(resolve(root, 'db/migrations', file), 'utf8'))
  }
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('01','boat','test')").run()
  const now = Date.now(), cutoff = now + 60_000, target = cutoff - 60_000, raceId = 'hist-race'
  sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at,betting_cutoff_at,betting_cutoff_source,betting_cutoff_observed_at)
    VALUES(?,?,?,?,1,?,'scheduled','real',?,?,?,?)`).run(raceId, 'boat', '01', '2026-10-15', jst(now + 600_000), jst(now), jst(cutoff), 'boatrace-racelist-cutoff-v1', jst(now - 30_000))
  const entries = Array.from({ length: 6 }, (_, i) => ({
    lane: i + 1, registrationNumber: String(1000 + i), number: i + 1,
    features_json: JSON.stringify({ racer_id: String(1000 + i), national_2rate: 30 + i, local_2rate: 28 + i, age: 25 + i,
      history_starts: 20 + i, history_wins: i, history_win_rate: i / (20 + i), source_available_at: actualArrival,
      source_sha256: sha, source_url: sourceBUrl }),
    available_at: actualArrival,
  }))
  for (const e of entries) sqlite.prepare(`INSERT INTO entries(id,race_id,number,name,weight_carried,racer_class,national_win_rate,local_win_rate,motor_2rate,boat_2rate,features_json,available_at,data_origin)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'real')`).run(`entry-${e.lane}`, raceId, e.lane, `competitor-${e.lane}`, 50 + e.lane / 10, 'A1', 3 + e.lane, 2 + e.lane, 30 + e.lane, 31 + e.lane, e.features_json, e.available_at)
  const cutoffAt = jst(cutoff), archivedAt = jst(target - 5000), sourceAt = jst(target - 10_000)
  const archive = {
    schema: 'boat-prerace-capture-v1', race: { id: raceId, date: '2026-10-15', venueCode: '01', raceNo: 1, lanes: [1, 2, 3, 4, 5, 6] },
    capturedAt: archivedAt, archivedAt,
    raceList: { url: raceListUrl(1, '01', '2026-10-15'), sha256: sha, capturedAt: sourceAt, cutoffAt, entries: entries.map(e => ({ lane: e.lane, registrationNumber: e.registrationNumber })) },
    beforeinfo: { url: beforeinfoUrl(1, '01', '2026-10-15'), sha256: sha, capturedAt: sourceAt,
      exhibitions: entries.map(e => ({ lane: e.lane, exhibitionTime: 6.8 + e.lane / 100 })), weather: { wind: 'weak' } },
    trifectaOdds: { url: trifectaOddsUrl(1, '01', '2026-10-15'), sha256: sha, capturedAt: archivedAt,
      qualityStatus: 'verified-complete-v1', final: false,
      odds: entries.flatMap(a => entries.filter(b => b !== a).flatMap(b => entries.filter(c => c !== a && c !== b).map(c => ({ selection: `${a.lane}-${b.lane}-${c.lane}`, odds: 200 })))) },
  }
  sqlite.prepare(`INSERT INTO boatrace_prerace_capture_archives(id,race_id,race_date,captured_at,archive_json,data_origin) VALUES(?,?,?,?,?,'real')`)
    .run('hist-archive', raceId, '2026-10-15', archivedAt, JSON.stringify(archive))
  return { sqlite, DB: new D1SqliteAdapter(sqlite), raceId, now, target }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('historical BASE dedicated T-60 virtual experiment', () => {
  it('uses fresh official current odds and writes only its isolated virtual ledger', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T03:00:00.000Z'))
    const f = createFixture(jst(Date.now() - 30_000))
    const fetchMock = vi.fn(async () => new Response(marketHtml(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const odds = purchaseOddsContext({ used: 0, max: 4 }); odds.enabled = true; odds.sleep = async () => undefined
    const result = await historicalTrifectaExperimentDecision(f.DB, Date.now(), odds)
    expect(result.evaluated).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM historical_trifecta_experiment_decisions').get()).toEqual({ n: 1 })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM experimental_paper_decisions').get()).toEqual({ n: 0 })
    const decision = f.sqlite.prepare('SELECT outcome,snapshot_json FROM historical_trifecta_experiment_decisions').get() as any
    expect(JSON.parse(decision.snapshot_json).model.sourceArtifactSha256).toBe('b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a')
    expect(JSON.parse(decision.snapshot_json).model.exhibitionFeaturesUsed).toBe(false)
  })

  it('abstains without fetching when only a synthesized JST-midnight arrival timestamp is available', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T03:00:00.000Z'))
    const f = createFixture('2026-10-15T00:00:00+09:00')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const odds = purchaseOddsContext({ used: 0, max: 4 }); odds.enabled = true
    const result = await historicalTrifectaExperimentDecision(f.DB, Date.now(), odds)
    expect(result.abstainedByReason.entry_arrival_time_unverified).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(f.sqlite.prepare('SELECT outcome,reason FROM historical_trifecta_experiment_decisions').get()).toEqual({ outcome: 'abstained', reason: 'entry_arrival_time_unverified' })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM experimental_paper_decisions').get()).toEqual({ n: 0 })
  })
})
