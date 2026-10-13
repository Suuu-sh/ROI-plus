import { all, first, type Db } from '../repo/db.js'
import { fetchPurchaseOdds, type PurchaseOddsContext } from './purchaseOdds.js'
import { boatArchiveEvidenceValid } from './boatArchiveEvidence.js'
import { predictHistoricalTrifecta, historicalTrifectaModelMetadata, HISTORICAL_TRIFECTA_EXPERIMENT_KEY, HISTORICAL_TRIFECTA_MODEL_ID } from './historicalTrifectaModel.js'
import { primaryPaperTiming } from './paperTiming.js'
import { sizeExperimentalPortfolioResult } from './experimentalSizing.js'

const CUTOFF_SOURCE = 'boatrace-racelist-cutoff-v1'
const MODEL_TRAINED_AT = Date.parse('2026-10-13T16:21:26.363521Z')
const jst = (ms: number) => new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00')
const officialBFileUrl = (date: string) => `https://www1.mbrace.or.jp/od2/B/${date.slice(0, 7).replace('-', '')}/b${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}.lzh`
const sha256 = async (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
function parseFeatures(raw: unknown): Record<string, any> | null {
  try { const value = JSON.parse(String(raw ?? '{}')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null }
}
function timestampIsActual(raw: unknown, before: number): boolean {
  if (typeof raw !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(raw)) return false
  const time = Date.parse(raw)
  if (!Number.isFinite(time) || time > before) return false
  // Imported B-file rows with the synthesized date-at-midnight timestamp are not arrival-time evidence.
  const d = new Date(time)
  return !(d.getUTCHours() === 15 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0)
}
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const featureRows = (entries: any[]) => entries.map((entry, i) => {
  const f = parseFeatures(entry.features_json) ?? {}
  const cls = ({ A1: 4, A2: 3, B1: 2, B2: 1 } as Record<string, number>)[String(entry.racer_class ?? '').toUpperCase()] ?? null
  return {
    lane: i + 1,
    national_win_rate: n(entry.national_win_rate), local_win_rate: n(entry.local_win_rate),
    motor_2rate: n(entry.motor_2rate), boat_2rate: n(entry.boat_2rate),
    national_2rate: n(f.national_2rate), local_2rate: n(f.local_2rate), age: n(f.age),
    weight_carried: n(entry.weight_carried), racer_class_code: cls,
    history_starts: n(f.history_starts), history_wins: n(f.history_wins), history_win_rate: n(f.history_win_rate),
  }
})

export async function historicalTrifectaExperimentDecision(db: Db, decisionAt = Date.now(), oddsContext?: PurchaseOddsContext) {
  const report = { evaluated: 0, placedRaces: 0, placedBets: 0, abstainedByReason: {} as Record<string, number> }
  if (MODEL_TRAINED_AT >= decisionAt) return report
  const from = jst(decisionAt + 50_000), to = jst(decisionAt + 70_000)
  const races = await all<any>(db, `SELECT * FROM races r WHERE r.sport='boat' AND r.data_origin='real' AND r.status='scheduled'
    AND r.race_date=? AND r.betting_cutoff_source=? AND julianday(r.betting_cutoff_at) BETWEEN julianday(?) AND julianday(?)
    AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions d WHERE d.race_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY r.betting_cutoff_at,r.id LIMIT 30`, new Date(decisionAt + 9 * 60 * 60_000).toISOString().slice(0, 10), CUTOFF_SOURCE, from, to)
  for (const race of races) {
    if (!primaryPaperTiming(race.betting_cutoff_at, decisionAt, race.betting_cutoff_source, race.betting_cutoff_observed_at).eligible) continue
    report.evaluated++
    let reason: string | null = null, archiveRow: any = null, archive: any = null, odds: any = null
    const entries = await all<any>(db, `SELECT * FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number`, race.id)
    if (entries.length !== 6 || entries.some((e, i) => Number(e.number) !== i + 1)) reason = 'official_entries_incomplete'
    const target = Date.parse(race.betting_cutoff_at) - 60_000
    if (!reason && entries.some(e => !timestampIsActual(e.available_at, target))) reason = 'entry_arrival_time_unverified'
    const entryFeatures = entries.map(e => parseFeatures(e.features_json) ?? {})
    const sourceHashes = new Set(entryFeatures.map(f => f.source_sha256))
    if (!reason && (sourceHashes.size !== 1 || !/^[a-f0-9]{64}$/.test(String(entryFeatures[0]?.source_sha256 ?? ''))
      || entryFeatures.some((f, i) => f.source_url !== officialBFileUrl(race.race_date)
        || f.source_available_at !== entries[i].available_at
        || !timestampIsActual(f.source_available_at, target)))) reason = 'entry_source_unverified'
    if (!reason) {
      archiveRow = await first<any>(db, `SELECT id,captured_at,archive_json FROM boatrace_prerace_capture_archives
        WHERE race_id=? AND data_origin='real' AND julianday(captured_at)<=julianday(?)
        ORDER BY julianday(captured_at) DESC LIMIT 1`, race.id, jst(target))
      if (!archiveRow || target - Date.parse(archiveRow.captured_at) < 0 || target - Date.parse(archiveRow.captured_at) > 5 * 60_000) reason = 'official_archive_missing_or_stale'
      else { try { archive = JSON.parse(archiveRow.archive_json) } catch { reason = 'official_archive_invalid' } }
    }
    if (!reason && (!boatArchiveEvidenceValid(archive, race, entries)
      || archive.capturedAt !== archiveRow.captured_at
      || !timestampIsActual(archiveRow.captured_at, target)
      || !timestampIsActual(archive.raceList?.capturedAt, target)
      || !timestampIsActual(archive.beforeinfo?.capturedAt, target)
      || !timestampIsActual(archive.trifectaOdds?.capturedAt, target)
      || archive.trifectaOdds?.capturedAt !== archiveRow.captured_at
      )) reason = 'official_archive_identity_or_freshness_invalid'
    let predictions: ReturnType<typeof predictHistoricalTrifecta> = []
    if (!reason) {
      try { predictions = predictHistoricalTrifecta(featureRows(entries)) } catch { reason = 'historical_model_input_invalid' }
    }
    if (!reason && !oddsContext) reason = 'purchase_odds_context_unavailable'
    if (!reason && oddsContext) {
      odds = await fetchPurchaseOdds(race, oddsContext)
      if (!odds || odds.qualityStatus !== 'verified-complete-v1') reason = 'fresh_purchase_odds_unavailable'
    }
    const oddsBySelection = new Map((odds?.odds ?? []).map((o: any) => [o.selection, Number(o.odds)]))
    const tickets = reason ? [] : predictions.map(p => ({ selection: p.selection, probability: p.probability, probStd: p.probStd, odds: Number(oddsBySelection.get(p.selection)) }))
    const bank = await first<any>(db, `SELECT available_balance FROM historical_trifecta_experiment_bankroll WHERE experiment_key=?`, HISTORICAL_TRIFECTA_EXPERIMENT_KEY)
    const sizing = reason ? { stakes: [], abstentionReason: null } : sizeExperimentalPortfolioResult(tickets, Number(bank?.available_balance ?? 0))
    const totalStake = sizing.stakes.reduce((s, b) => s + b.stake, 0)
    const abstentionReason = reason ?? sizing.abstentionReason ?? 'no_conservative_positive_edge'
    const decisionId = crypto.randomUUID(), committed = new Date().toISOString()
    const snapshot = {
      experimentKey: HISTORICAL_TRIFECTA_EXPERIMENT_KEY,
      model: historicalTrifectaModelMetadata(), captureArchiveId: archiveRow?.id ?? null,
      targetAt: jst(target), decisionAt: committed,
      evidence: archive ? { archiveCapturedAt: archiveRow.captured_at, racelistCapturedAt: archive.raceList.capturedAt,
        racelistSha256: archive.raceList.sha256, sourceEntryAvailableAt: entries.map(e => e.available_at),
        entrySourceSha256: [...sourceHashes][0], entrySourceUrl: officialBFileUrl(race.race_date),
        inputDigest: await sha256(featureRows(entries)), purchaseOddsSha256: odds?.sha256 ?? null } : null,
      predictionCount: predictions.length, predictionDigest: predictions.length ? await sha256(predictions) : null,
      tickets: sizing.stakes,
    }
    if (!db.batch) break
    // Recheck timing and scheduled identity immediately before the atomic ledger write.
    if (!primaryPaperTiming(race.betting_cutoff_at, Date.now(), race.betting_cutoff_source, race.betting_cutoff_observed_at).eligible) continue
    const fresh = await first<any>(db, `SELECT id FROM races WHERE id=? AND status='scheduled' AND data_origin='real' AND betting_cutoff_at=?`, race.id, race.betting_cutoff_at)
    if (!fresh) continue
    const statements = []
    if (totalStake) statements.push(db.prepare(`UPDATE historical_trifecta_experiment_bankroll SET available_balance=available_balance-?,updated_at=?
      WHERE experiment_key=? AND available_balance>=? AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions WHERE race_id=?)
      AND EXISTS(SELECT 1 FROM races WHERE id=? AND status='scheduled' AND betting_cutoff_at=?)`)
      .bind(totalStake, committed, HISTORICAL_TRIFECTA_EXPERIMENT_KEY, totalStake, race.id, race.id, race.betting_cutoff_at))
    statements.push(db.prepare(`INSERT INTO historical_trifecta_experiment_decisions
      (id,experiment_key,race_id,model_id,capture_archive_id,decision_at,outcome,reason,total_stake,snapshot_json)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${totalStake ? 'changes()>0 AND ' : ''}NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions WHERE race_id=?)
        AND EXISTS(SELECT 1 FROM races WHERE id=? AND status='scheduled' AND data_origin='real' AND betting_cutoff_at=?)`)
      .bind(decisionId, HISTORICAL_TRIFECTA_EXPERIMENT_KEY, race.id, HISTORICAL_TRIFECTA_MODEL_ID, archiveRow?.id ?? null,
        committed, totalStake ? 'placed' : 'abstained', totalStake ? null : abstentionReason, totalStake, JSON.stringify(snapshot), race.id, race.id, race.betting_cutoff_at))
    for (const bet of sizing.stakes) statements.push(db.prepare(`INSERT INTO historical_trifecta_experiment_bets
      (id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,status,data_origin)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,'open','real' WHERE EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions WHERE id=?)`)
      .bind(crypto.randomUUID(), decisionId, race.id, HISTORICAL_TRIFECTA_MODEL_ID, bet.selection, bet.stake, bet.probability,
        bet.probStd, bet.odds, bet.expectedRoi, committed, decisionId))
    const result = await db.batch(statements) as any[]
    const decisionIndex = totalStake ? 1 : 0
    if (Number(result?.[decisionIndex]?.meta?.changes ?? 0)) {
      if (totalStake) { report.placedRaces++; report.placedBets += sizing.stakes.length }
      else report.abstainedByReason[abstentionReason] = (report.abstainedByReason[abstentionReason] ?? 0) + 1
    }
  }
  return report
}

export async function settleHistoricalTrifectaExperimentOpen(db: Db) {
  const open = await all<any>(db, `SELECT b.* FROM historical_trifecta_experiment_bets b JOIN races r ON r.id=b.race_id
    WHERE b.status='open' AND r.status='finished' AND r.data_origin='real'
    AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) ORDER BY b.placed_at,b.id LIMIT 4`)
  let count = 0
  for (const bet of open) {
    const results = await all<any>(db, `SELECT number,finish_order FROM results WHERE race_id=? AND data_origin='real' ORDER BY finish_order`, bet.race_id)
    const entries = await all<any>(db, `SELECT number,features_json FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number`, bet.race_id)
    const entryNumbers = entries.map(e => Number(e.number)), resultNumbers = results.map(r => Number(r.number))
    const terminal = entries.some(e => {
      const finish = parseFeatures(e.features_json)?.finish_code
      return typeof finish === 'string' && (['F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走'].includes(finish) || /^K\d$/.test(finish))
    })
    const payouts = await all<any>(db, `SELECT selection,payout FROM payouts WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND payout>0`, bet.race_id)
    if (entryNumbers.length !== 6 || entryNumbers.some((n, i) => n !== i + 1) || terminal || results.length !== 6
      || results.some((r, i) => Number(r.finish_order) !== i + 1)
      || new Set(resultNumbers).size !== 6 || resultNumbers.some(n => !entryNumbers.includes(n))
      || payouts.length !== 1 || payouts[0].selection !== results.slice(0, 3).map(r => String(r.number)).join('-')) continue
    const won = bet.selection === payouts[0].selection
    const payout = won ? Math.floor(Number(bet.stake) * Number(payouts[0].payout) / 100) : 0
    if (!db.batch) break
    const settledAt = new Date().toISOString()
    const changes = await db.batch([
      db.prepare(`UPDATE historical_trifecta_experiment_bets SET status=?,payout=?,profit=?,settled_at=? WHERE id=? AND status='open'`)
        .bind(won ? 'won' : 'lost', payout, payout - Number(bet.stake), settledAt, bet.id),
      db.prepare(`UPDATE historical_trifecta_experiment_bankroll SET available_balance=available_balance+?,updated_at=? WHERE experiment_key=? AND changes()>0`)
        .bind(payout, settledAt, HISTORICAL_TRIFECTA_EXPERIMENT_KEY),
    ]) as any[]
    count += Number(changes?.[0]?.meta?.changes ?? 0)
  }
  return count
}

export async function historicalTrifectaExperimentPerformance(db: Db) {
  const summary = await first<any>(db, `SELECT COUNT(DISTINCT d.race_id) decisions,
    COALESCE(SUM(CASE WHEN d.outcome='placed' THEN 1 ELSE 0 END),0) placed_races,
    COALESCE(SUM(CASE WHEN d.outcome='abstained' THEN 1 ELSE 0 END),0) abstained_races,
    COUNT(b.id) bets,COALESCE(SUM(b.stake),0) total_stake,COALESCE(SUM(b.profit),0) settled_profit,
    COALESCE(SUM(CASE WHEN b.status='open' THEN 1 ELSE 0 END),0) open_bets,
    (SELECT available_balance FROM historical_trifecta_experiment_bankroll WHERE experiment_key=?) available_balance
    FROM historical_trifecta_experiment_decisions d LEFT JOIN historical_trifecta_experiment_bets b ON b.decision_id=d.id`, HISTORICAL_TRIFECTA_EXPERIMENT_KEY)
  const decisions = await all<any>(db, `SELECT d.id,d.race_id,r.race_date,r.venue_id,r.race_no,d.decision_at,d.outcome,d.reason,d.total_stake,d.snapshot_json
    FROM historical_trifecta_experiment_decisions d JOIN races r ON r.id=d.race_id ORDER BY d.decision_at DESC LIMIT 20`)
  return { model: historicalTrifectaModelMetadata(), summary, decisions: decisions.map(d => ({ ...d, snapshot: parseFeatures(d.snapshot_json) })) }
}
export async function historicalTrifectaExperimentBets(db: Db) {
  return all<any>(db, `SELECT b.*,r.race_date,r.venue_id,r.race_no FROM historical_trifecta_experiment_bets b
    JOIN races r ON r.id=b.race_id ORDER BY b.placed_at DESC,b.id LIMIT 100`)
}
