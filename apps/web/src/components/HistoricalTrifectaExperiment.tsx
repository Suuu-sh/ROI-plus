import { api, type HistoricalTrifectaPerformance } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, yen } from '../lib/format'
import { Empty, ErrorState, Loading, Section } from './ui'
import { useVisibleRefresh } from '../lib/useVisibleRefresh'

export function HistoricalTrifectaExperiment({ compact = false }: { compact?: boolean }) {
  const q = useAsync(() => api.historicalTrifectaPerformance(), [])
  useVisibleRefresh(q.reload)
  if (q.error) return <Section title="過去データ基礎モデル・未検証"><div className="p-4"><ErrorState error={q.error} onRetry={q.reload} /></div></Section>
  if (!q.data) return <Section title="過去データ基礎モデル・未検証"><div className="p-4"><Loading rows={compact ? 2 : 4} /></div></Section>
  if (!isHistoricalTrifectaPerformance(q.data)) return <Section title="過去データ基礎モデル・未検証"><div className="p-4"><ErrorState error={new Error('実験データの形式が不正です。')} onRetry={q.reload} /></div></Section>
  const { model, summary, decisions } = q.data
  return <Section title="過去データ基礎モデル・未検証" right={<span className="text-xs text-muted">専用仮想実験</span>}>
    <div className="space-y-3 p-4">
      <p className="text-xs leading-relaxed text-muted">学習 {model.trainingRaces} / 校正 {model.validationRaces} / 検証 {model.testRaces} レース · 展示なし · 過去PIT/ROI未証明</p>
      <div className={`grid grid-cols-2 gap-3 ${compact ? '' : 'md:grid-cols-4'}`}>
        <Metric label="仮想残高" value={yen(summary.available_balance)} />
        <Metric label="累計購入額" value={yen(summary.total_stake)} />
        <Metric label="判断 / 購入" value={`${summary.decisions ?? 0} / ${summary.bets}`} />
        <Metric label="精算待ち" value={String(summary.open_bets)} />
      </div>
      <dl className="grid gap-x-3 gap-y-1 border-t border-line pt-3 text-[10px] text-muted md:grid-cols-[auto_1fr]">
        <dt>Model ID</dt><dd className="break-all font-mono">{model.id}</dd>
        <dt>Source pickle SHA-256</dt><dd className="break-all font-mono">{model.sourceArtifactSha256}</dd>
        <dt>Immutable version</dt><dd className="font-mono">{model.immutableVersion}</dd>
      </dl>
      {!compact && <div className="border-t border-line pt-3">
        <h3 className="mb-2 text-sm font-medium">専用実験の判断履歴</h3>
        {!decisions.length ? <Empty>このモデルの仮想判断はまだありません。</Empty> : <div className="overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-xs">
            <thead className="text-muted"><tr><th className="py-2 pr-3">レース</th><th className="py-2 pr-3">判断</th><th className="py-2 pr-3">購入額</th><th className="py-2">判断時刻</th></tr></thead>
            <tbody className="divide-y divide-line">{decisions.map(d => <tr key={d.id}>
              <td className="py-2 pr-3">{d.race_date} · {d.venue_id} {d.race_no}R</td>
              <td className="py-2 pr-3">{d.outcome === 'placed' ? '仮想購入' : `見送り${d.reason ? ` · ${d.reason}` : ''}`}</td>
              <td className="num py-2 pr-3">{yen(d.total_stake)}</td>
              <td className="py-2">{dateTime(d.decision_at)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </div>}
    </div>
  </Section>
}

function isHistoricalTrifectaPerformance(value: unknown): value is HistoricalTrifectaPerformance {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<HistoricalTrifectaPerformance>
  const model = data.model
  const summary = data.summary
  const finite = (number: unknown) => typeof number === 'number' && Number.isFinite(number)
  return !!model && model.experimentKey === 'boat-trifecta-historical-base-v1'
    && model.id === 'boat-trifecta-historical-base-20261014'
    && model.sourceArtifactSha256 === 'b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a'
    && typeof model.immutableVersion === 'string'
    && finite(model.trainingRaces) && finite(model.validationRaces) && finite(model.testRaces)
    && !!summary && finite(summary.available_balance) && finite(summary.total_stake)
    && finite(summary.bets) && finite(summary.open_bets)
    && Array.isArray(data.decisions)
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-line bg-surface p-3"><div className="label">{label}</div><div className="figure mt-2 text-xl">{value}</div></div>
}
