import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, pct, signedYen, tone, yen } from '../lib/format'
import { Empty, ErrorState, Loading, Section } from './ui'

const caveat = '小標本の実験です。通常の件数基準を満たさず、天候データが欠ける場合があります。精度・収益性は未検証です。'

export function ExperimentalPerformance({ compact = false }: { compact?: boolean }) {
  const q = useAsync(() => api.experimentalPerformance(), [])
  if (q.error) return <Section title="三連単モデル実験"><div className="p-4"><ErrorState error={q.error} onRetry={q.reload} /></div></Section>
  if (!q.data) return <Section title="三連単モデル実験"><div className="p-4"><Loading rows={compact ? 2 : 4} /></div></Section>
  const data = q.data

  return <Section title="三連単モデル実験" right={<span className="text-xs text-muted">実験専用・未検証</span>}>
    <div className="space-y-3 p-4">
      <p className="text-xs leading-relaxed text-muted">通常の運用成績・資産とは別の仮想台帳です。{caveat}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="実験用仮想残高" value={yen(data.bankroll.available)} sub={`初期 ${yen(data.bankroll.initial)}`} />
        <Metric label="実験損益" value={signedYen(data.metrics.profit)} className={tone(data.metrics.profit)} />
        <Metric label="実験回収率" value={pct(data.metrics.roi)} />
        <Metric label="判断 / 購入" value={`${data.decisions.length} / ${data.metrics.bets}`} sub={`購入額 ${yen(data.metrics.stake)}`} />
      </div>
      <p className="text-xs text-muted">1レース合計の購入額上限 {yen(data.sizing.perRaceCombinedCap)} · 日次固定上限なし · 仮想残高は非負に制限</p>
      {!compact && <>
        <div className="border-t border-line pt-3">
          <h3 className="mb-2 text-sm font-medium">実験判断履歴</h3>
          {!data.decisions.length ? <Empty>実験判断はまだありません。</Empty> : <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="text-muted"><tr><th className="py-2 pr-3">レース</th><th className="py-2 pr-3">判断</th><th className="py-2 pr-3">購入額</th><th className="py-2 pr-3">確率</th><th className="py-2 pr-3">オッズ</th><th className="py-2 pr-3">期待ROI</th><th className="py-2">判断時刻</th></tr></thead>
              <tbody className="divide-y divide-line">{data.decisions.map((decision, i) => <tr key={`${decision.raceId}-${decision.decidedAt}-${i}`}>
                <td className="py-2 pr-3">{decision.raceDate} · {decision.venueName ?? decision.raceId} {decision.raceNo}R</td>
                <td className="py-2 pr-3">{decision.outcome === 'placed' ? '購入' : `見送り${decision.reason ? ` · ${decision.reason}` : ''}`}</td>
                <td className="num py-2 pr-3">{yen(decision.stake)}</td>
                <td className="num py-2 pr-3">{pct(decision.probability)}</td>
                <td className="num py-2 pr-3">{decision.odds == null ? '—' : decision.odds.toFixed(2)}</td>
                <td className="num py-2 pr-3">{pct(decision.expectedRoi)}</td>
                <td className="py-2">{dateTime(decision.decidedAt)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </div>
      </>}
    </div>
  </Section>
}

function Metric({ label, value, sub, className = '' }: { label: string; value: string; sub?: string; className?: string }) {
  return <div className="rounded-lg border border-line bg-raised/30 p-3"><div className="text-[11px] text-muted">{label}</div><div className={`num mt-1 text-lg font-semibold ${className}`}>{value}</div>{sub && <div className="mt-1 text-[10px] text-muted">{sub}</div>}</div>
}
