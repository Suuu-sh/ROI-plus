import { useState } from 'react'
import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, freshness, pct } from '../lib/format'
import { Empty, ErrorState, Kpi, Loading, Section, SportDot } from '../components/ui'

const API_BASE: string = import.meta.env.VITE_API_BASE ?? ''

export function DataPage() {
  const q = useAsync(() => api.collection(), [])
  const [manualResults, setManualResults] = useState<ManualResultsState>({ phase: 'idle' })
  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><Loading rows={5} /></div>
  const d = q.data
  const exclusions = d.qualityExclusions ?? []
  const total = Object.values(d.tableCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">データ収集</h1>
          <p className="mt-1 text-sm text-muted">利用規約で許可された無料ソースのみ。取得できない値は欠損として扱い、補完しません。</p>
        </div>
        <button className="btn-ghost h-8 text-xs" onClick={q.reload}>更新</button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="データソース" value={d.sources.length} sub={`有効 ${d.sources.filter((s) => s.enabled).length}`} />
        <Kpi label="総レコード数" value={total.toLocaleString()} sub="D1 全テーブル" />
        <Kpi label="通信・解析等のエラー（直近）" value={d.errors.length} valueClass={d.errors.length ? 'text-neg' : ''} />
        <Kpi label="保存中の行数（概算）" value={`${d.freeTier.d1RowsApprox.toLocaleString()} 行`} sub="Cloudflare quota 使用量ではありません" />
      </div>

      <Section title="D1 日次書込予約（Worker 内推定）">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <BudgetKpi label="保護枠の残り" used={d.d1WriteBudget.essentialReserved} remaining={d.d1WriteBudget.essentialRemaining} limit={d.d1WriteBudget.essentialLimit} />
          <BudgetKpi label="任意処理枠の残り" used={d.d1WriteBudget.optionalReserved} remaining={d.d1WriteBudget.optionalRemaining} limit={d.d1WriteBudget.optionalLimit} />
        </div>
        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-faint">
          {d.d1WriteBudget.date} UTC の予約推定値です。Cloudflare アカウント全体の実使用量・quota 残量ではありません。
          {d.d1WriteBudget.state === 'missing' || d.d1WriteBudget.state === 'invalid' ? ' 予約状態を確認できないため、残量は不明です。' : ''}
        </p>
      </Section>

      <Section title="取得状況">
        {d.sources.length === 0 ? <Empty>収集履歴がありません。</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-medium">ソース</th><th className="px-2 py-2 font-medium">状態</th>
                <th className="px-2 py-2 font-medium">最終保存記録</th><th className="px-2 py-2 text-right font-medium">記録成功率</th>
                <th className="px-2 py-2 text-right font-medium">件数</th><th className="px-4 py-2 font-medium">鮮度</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {d.sources.map((s) => (
                  <tr key={s.source}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 font-medium"><SportDot sport={s.sport} /><span className="font-mono text-xs">{s.source}</span></div>
                      {s.note && <div className="mt-0.5 text-xs text-muted">{s.note}</div>}
                    </td>
                    <td className="px-2 py-2.5">
                      {s.enabled ? <span className="text-xs text-pos">● 有効</span> : <span className="text-xs text-faint">○ 無効</span>}
                    </td>
                    <td className="num px-2 py-2.5 text-xs">
                      <div>{dateTime(s.lastRunAt)}</div>
                      <div className="text-faint">成功記録 {dateTime(s.lastSuccessAt)}</div>
                    </td>
                    <td className={`num px-2 py-2.5 text-right ${s.enabled && s.successRate != null && s.successRate < 0.9 ? 'text-warn' : ''}`}>{s.enabled ? pct(s.successRate, 0) : <span className="text-faint">—</span>}<div className="text-[10px] text-faint">{s.runs} 記録 · 品質除外（保存記録全体）{s.qualityExclusions ?? 0} レース試行</div></td>
                    <td className="num px-2 py-2.5 text-right">{s.records.toLocaleString()}</td>
                    <td className={`num px-4 py-2.5 text-xs ${s.enabled && (s.freshnessMinutes == null || s.freshnessMinutes > 60 * 48) ? 'text-warn' : ''}`}>{s.enabled ? freshness(s.freshnessMinutes) : <span className="text-faint">取得停止中</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-faint">表示時刻・記録成功率は保存された収集記録に基づきます。毎分の起動や未保存の試行をすべて表すものではありません。</p>
      </Section>

      <Section title="購入済みボートの結果取得">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted">実データの購入済みボートのみ・最大4レース。結果取得後に精算します。</p>
          <button
            className="btn-primary text-sm"
            disabled={manualResults.phase === 'collecting' || manualResults.phase === 'settling'}
            onClick={() => void collectAndSettleResults(setManualResults)}
          >
            {manualResults.phase === 'collecting' ? '結果を取得中…' : manualResults.phase === 'settling' ? '精算中…' : '購入済みの結果を今すぐ取得'}
          </button>
          {manualResults.phase === 'failed' && <p role="status" className="text-sm text-neg">{manualResults.message}</p>}
          {manualResults.phase === 'complete' && <p role="status" className={`text-sm ${manualResults.collection.status === 'success' ? 'text-pos' : 'text-warn'}`}>{manualResults.message}</p>}
        </div>
      </Section>

      <Section title="品質チェックによる除外（直近1時間）">
        <p className="px-4 py-2 text-xs text-muted">{exclusions.reduce((n, row) => n + row.count, 0)} レース試行。通信失敗ではありません。基準外のオッズは保存せず、判定・購入に使いません。成功率から品質のみの除外試行を除きます。1時間より古い品質のみの収集ログは定期的に削除します。</p>
        {exclusions.length === 0 ? <Empty>品質除外はありません。</Empty> : <ul className="divide-y divide-line">{exclusions.map((row, i) => (
          <li key={i} className="px-4 py-2.5 text-sm">
            <div className="flex justify-between text-xs text-muted"><span className="font-mono">{row.source} · {row.count} レース試行</span><span className="num">{dateTime(row.at)}</span></div>
            <div className="mt-0.5 break-words text-warn">{row.reason}</div>
          </li>
        ))}</ul>}
      </Section>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Section title="通信・解析等のエラー履歴">
          {d.errors.length === 0 ? <Empty>エラーはありません。</Empty> : (
            <ul className="divide-y divide-line">
              {d.errors.map((e, i) => (
                <li key={i} className="px-4 py-2.5 text-sm">
                  <div className="flex justify-between text-xs text-muted"><span className="font-mono">{e.source}</span><span className="num">{dateTime(e.at)}</span></div>
                  <div className="mt-0.5 break-words text-neg">{e.error}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="テーブル件数">
          <ul className="divide-y divide-line text-sm">
            {Object.entries(d.tableCounts).map(([k, v]) => (
              <li key={k} className="flex justify-between px-4 py-2"><span className="font-mono text-xs text-muted">{k}</span><span className="num">{v.toLocaleString()}</span></li>
            ))}
          </ul>
          <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-faint">{d.freeTier.d1RowsNote}</p>
        </Section>
      </div>
    </div>
  )
}

type CollectionStatus = 'success' | 'partial' | 'failed' | 'skipped'
type CollectionResult = { status: CollectionStatus; targets: number; verified: number; records: number; attempted: number }
type ManualResultsState =
  | { phase: 'idle' | 'collecting' | 'settling' }
  | { phase: 'failed'; message: string }
  | { phase: 'complete'; collection: CollectionResult; settled: number; message: string }

async function collectAndSettleResults(setState: (state: ManualResultsState) => void) {
  setState({ phase: 'collecting' })
  let collection: CollectionResult
  try {
    const payload: unknown = await manualPost('/api/admin/collect-boat-results')
    if (!isCollectionResult(payload)) {
      setState({ phase: 'failed', message: '結果取得の応答を確認できませんでした。精算は実行していません。' })
      return
    }
    collection = payload
  } catch (error) {
    setState({ phase: 'failed', message: error instanceof SessionExpiredError ? 'ログイン状態を確認してください。結果取得・精算は実行していません。' : '結果取得の完了を確認できませんでした。通信状態を確認してください。精算は実行していません。' })
    return
  }

  setState({ phase: 'settling' })
  try {
    const payload: unknown = await manualPost('/api/admin/settle')
    if (!isSettledResult(payload)) {
      setState({ phase: 'failed', message: collectionSummary(collection, null) + ' 精算結果を確認できませんでした。' })
      return
    }
    setState({ phase: 'complete', collection, settled: payload.settled, message: collectionSummary(collection, payload.settled) })
  } catch (error) {
    setState({ phase: 'failed', message: collectionSummary(collection, null) + (error instanceof SessionExpiredError ? ' ログイン状態を確認してください。' : ' 精算結果を確認できませんでした。') })
  }
}

class SessionExpiredError extends Error {}

async function manualPost(path: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  })
  if (response.redirected || response.type === 'opaqueredirect' || !(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new SessionExpiredError('SESSION_EXPIRED')
  }
  if (!response.ok) throw new Error('REQUEST_FAILED')
  return response.json().catch(() => { throw new Error('INVALID_JSON') })
}

function isCollectionResult(value: unknown): value is CollectionResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return ['success', 'partial', 'failed', 'skipped'].includes(String(result.status)) &&
    ['targets', 'verified', 'records', 'attempted'].every((key) => typeof result[key] === 'number' && Number.isFinite(result[key]))
}

function isSettledResult(value: unknown): value is { settled: number } {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).settled === 'number' && Number.isFinite((value as Record<string, unknown>).settled)
}

function collectionSummary(collection: CollectionResult, settled: number | null) {
  const verified = `${collection.verified.toLocaleString()} / ${collection.targets.toLocaleString()} レース確認`
  const settlement = settled == null ? '精算要求を送信しました。精算結果は未確認です。' : `${settled.toLocaleString()} 件を精算しました。`
  if (collection.status === 'success') return `結果取得完了（${verified}）。${settlement}`
  const label = collection.status === 'partial' ? '一部のみ取得' : collection.status === 'skipped' ? '結果取得は対象なし／スキップ' : '結果取得に失敗'
  return `${label}（${verified}）。${settled == null ? '保存済み結果も含めて精算を試みました。' : '保存済み結果も含めて精算を実行しました。'}${settlement}`
}

function BudgetKpi({ label, used, remaining, limit }: { label: string; used: number | null; remaining: number | null; limit: number }) {
  const value = remaining == null ? '不明' : `${remaining.toLocaleString()} unit`
  const detail = used == null ? `予約上限 ${limit.toLocaleString()} unit` : `予約 ${used.toLocaleString()} / ${limit.toLocaleString()} unit`
  return <div className="rounded-lg border border-line bg-surface px-4 py-3">
    <div className="text-xs text-muted">{label}</div>
    <div className="num mt-1 text-lg font-semibold">{value}</div>
    <div className="mt-0.5 text-[11px] text-faint">{detail}</div>
  </div>
}
