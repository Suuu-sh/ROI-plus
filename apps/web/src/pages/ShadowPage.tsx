import { useEffect, useMemo, useRef, useState } from 'react'
import { Section } from '../components/ui'
import { dateTime, odds, pct } from '../lib/format'
import {
  DEFAULT_REAL_RACE_ID,
  fetchHistoricalShadowRace,
  inspectStoredEvidence,
  TRIFECTA_ORDERS,
  type HistoricalShadowResponse,
} from '../lib/shadowProduction'

export function ShadowPage() {
  const [raceId, setRaceId] = useState(DEFAULT_REAL_RACE_ID)
  const [record, setRecord] = useState<HistoricalShadowResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const initialLoad = useRef(false)

  const snapshot = record?.snapshot ?? null
  const review = useMemo(() => record ? inspectStoredEvidence(record.snapshot, Date.parse(record.fetchedAt)) : null, [record])
  const outcomes = useMemo(() => {
    const predictions = new Map((snapshot?.predictionBatch?.rows ?? []).map((row) => [row.selection, row]))
    const oddsRows = new Map((snapshot?.oddsSnapshot?.rows ?? []).map((row) => [row.selection, row]))
    return TRIFECTA_ORDERS.map((selection) => ({
      selection,
      prediction: predictions.get(selection),
      odds: oddsRows.get(selection),
    }))
  }, [snapshot])

  async function loadRace(id: string) {
    const requestedId = id.trim()
    setLoading(true)
    setError('')
    try {
      const result = await fetchHistoricalShadowRace(requestedId)
      setRecord(result)
      setRaceId(requestedId)
    } catch (reason) {
      setRecord(null)
      setError(reason instanceof Error ? reason.message : 'Historical production read failed.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (initialLoad.current) return
    initialLoad.current = true
    void loadRace(DEFAULT_REAL_RACE_ID)
  }, [])

  return <div className="space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2"><h1 className="draw-underline text-2xl font-black tracking-tight">シャドー分析</h1><span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent">READ ONLY</span></div>
        <p className="mt-1 text-sm text-muted">本番 D1 に保存された三連単予測とオッズを、指定した実レース1件だけ表示します。</p>
      </div>
      <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">GET /api/shadow/races/:id</div>
    </header>

    <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-xs leading-relaxed text-warn">
      保存済みの値を表示し、候補選択や本番書き込みは行いません。現在のスキーマには各入力の利用可能時刻が記録されていないため、過去予測を時点整合済みの判断として扱いません。
    </div>

    <Section title="実レースの保存済み証跡を読む" right={snapshot && <span className="rounded border border-line bg-raised px-1.5 py-0.5 text-[10px] font-bold text-muted">HISTORICAL REVIEW</span>}>
      <form className="flex flex-wrap gap-2 p-4" onSubmit={(event) => { event.preventDefault(); void loadRace(raceId) }}>
        <label className="sr-only" htmlFor="shadow-race-id">ボートレースID</label>
        <input id="shadow-race-id" className="input min-w-[260px] flex-1 font-mono text-xs" value={raceId} onChange={(event) => setRaceId(event.target.value)} placeholder="boat-YYYYMMDD-venue-race" />
        <button className="btn-primary h-9" disabled={loading}>{loading ? '読込中…' : '保存済みデータを読む'}</button>
      </form>
      {error && <div role="alert" className="mx-4 mb-4 rounded-lg border border-neg/30 bg-neg/5 p-3 text-sm text-neg">{error}</div>}
      {loading && <div className="px-4 pb-4 text-sm text-muted">1件の実ボートレースと、その最新の予測・オッズスナップショットだけを読み込んでいます。</div>}
      {snapshot && <div className="grid grid-cols-2 gap-3 border-t border-line p-4 sm:grid-cols-4">
        <Metric label="実レース" value={`${snapshot.race.venueName} ${snapshot.race.raceNo}R`} sub={snapshot.race.id} />
        <Metric label="開催日・発走" value={snapshot.race.raceDate} sub={dateTime(snapshot.race.postTime)} />
        <Metric label="状態・出所" value={snapshot.race.status} sub={`${snapshot.race.dataOrigin} · ${snapshot.race.entryCount}艇`} />
        <Metric label="この画面で取得" value={dateTime(record?.fetchedAt ?? null)} sub="観測時刻。過去データの公開時刻ではありません。" />
      </div>}
    </Section>

    {snapshot && review && <>
      <Section title={`${snapshot.race.venueName} ${snapshot.race.raceNo}R · 保存済み三連単データ`} right={<span className="font-mono text-[10px] text-muted">MODEL: {snapshot.predictionBatch?.modelId ?? '未取得'}</span>}>
        <div className="grid grid-cols-2 gap-3 border-b border-line p-4 sm:grid-cols-4">
          <Metric label="予測行" value={`${review.predictionCount} / 120`} sub={`確率合計 ${pct(review.probabilityTotal, 3)}`} />
          <Metric label="オッズ行" value={`${review.oddsCount} / 120`} sub={`一致組番 ${review.matchedCount} / 120`} />
          <Metric label="モデル版・artifact" value={snapshot.predictionBatch?.modelVersion ?? '未取得'} sub={snapshot.predictionBatch?.rows[0]?.artifactSha256 ? snapshot.predictionBatch.rows[0].artifactSha256 : 'artifact hashなし'} mono />
          <Metric label="保存時刻" value={dateTime(snapshot.predictionBatch?.predictedAt ?? null)} sub={`オッズ ${dateTime(snapshot.oddsSnapshot?.capturedAt ?? null)}`} />
        </div>
        <div className="space-y-3 p-4">
          <div role="status" className="rounded-lg border border-warn/40 bg-warn/10 p-3">
            <div className="font-semibold text-warn">ABSTAIN · 保存データの閲覧のみ</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-warn">{review.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>

          <div className="rounded-lg border border-line p-3 text-xs leading-relaxed text-muted">
            <div className="font-semibold text-fg">データ経路と確認範囲</div>
            <p className="mt-1">収集器が保存した <code>ticket_predictions</code> の最新バッチと <code>odds_snapshots</code> の最新スナップショットを、API がレースIDで絞ってそれぞれ最大121行で返します。画面は120組を固定表示し、欠けた値は空欄のままです。</p>
            <p className="mt-1">prediction {snapshot.predictionBatch?.predictedAt ?? 'なし'} · odds {snapshot.oddsSnapshot?.capturedAt ?? 'なし'}</p>
            <p className="mt-1 break-all">odds source: {snapshot.oddsSnapshot?.sourceUrl ?? 'なし'} · SHA256: {snapshot.oddsSnapshot?.sourceSha256 ?? 'なし'} · quality: {snapshot.oddsSnapshot?.qualityStatus ?? 'なし'}</p>
            <p className="mt-1">本番の特徴量利用可能時刻と払戻原票の検証証跡はこのビューにありません。実際の払戻をオッズ倍率から推定せず、精算も実行しません。</p>
          </div>

          <div className="rounded-lg border border-line">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div><div className="text-xs font-semibold">三連単 120通り</div><div className="text-[10px] text-muted">保存された確率・オッズを選択ごとに照合。EV候補は生成しません。</div></div>
              <div className="text-[10px] text-muted">model status: {snapshot.predictionBatch?.modelStatus ?? '未取得'}</div>
            </div>
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="sticky top-0 bg-raised text-left text-[10px] text-muted"><tr><th className="px-3 py-2">順序</th><th className="px-2 py-2 text-right">保存確率</th><th className="px-2 py-2 text-right">保存不確実性</th><th className="px-3 py-2 text-right">保存オッズ</th></tr></thead>
                <tbody className="divide-y divide-line">{outcomes.map(({ selection, prediction, odds: savedOdds }) => <tr key={selection}>
                  <td className="px-3 py-2 font-mono font-medium">3連単 {selection}</td>
                  <td className="num px-2 py-2 text-right">{typeof prediction?.probability === 'number' ? pct(prediction.probability, 3) : '—'}</td>
                  <td className="num px-2 py-2 text-right text-muted">{typeof prediction?.probStd === 'number' ? `±${pct(prediction.probStd, 2)}` : '—'}</td>
                  <td className="num px-3 py-2 text-right">{typeof savedOdds?.odds === 'number' ? odds(savedOdds.odds) : '—'}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>
        </div>
      </Section>

      <Section title="説明アダプター">
        <div className="p-4 text-sm text-muted">LLM説明は無効です。認証や外部推論を使わず、この画面は保存値と検証理由だけを表示します。</div>
      </Section>
    </>}

    <p className="px-1 text-[11px] leading-relaxed text-muted">このページは一度に1件の実レースIDだけを読みます。historical read は購入候補・紙上決定・精算に接続せず、既存の live candidate ゲートも変更しません。</p>
  </div>
}

function Metric({ label, value, sub, mono = false }: { label: string; value: string; sub: string; mono?: boolean }) {
  return <div className="min-w-0 rounded-lg bg-raised/60 p-3"><div className="text-[10px] text-muted">{label}</div><div className={`mt-1 truncate text-sm font-semibold ${mono ? 'font-mono text-[11px]' : ''}`} title={value}>{value}</div><div className="mt-1 truncate text-[10px] text-faint" title={sub}>{sub}</div></div>
}
