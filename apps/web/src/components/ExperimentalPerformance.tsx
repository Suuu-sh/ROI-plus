import { api, type ExperimentalPerformance as ExperimentalPerformanceData } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, pct, signedYen, tone, yen } from '../lib/format'
import { CountUp, Empty, ErrorState, Loading, Section } from './ui'
import { useVisibleRefresh } from '../lib/useVisibleRefresh'

const caveat = '小標本の実験です。通常の件数基準を満たさず、天候データが欠ける場合があります。精度・収益性は未検証です。'

function decisionLabel(outcome: 'placed' | 'abstained' | 'void', reason: string | null) {
  if (outcome === 'placed') return '購入'
  if (outcome === 'void') return `無効（返金）${reason ? ` · ${reasonLabel(reason)}` : ''}`
  return `見送り${reason ? ` · ${reasonLabel(reason)}` : ''}`
}

function reasonLabel(reason: string) {
  if (reason === 'invalid_stake_unit') return '購入額が100円単位の条件を満たさないため'
  return reason
}

/** `narrow` lays the summary out for a side column. */
export function ExperimentalPerformance({ compact = false, narrow = false }: { compact?: boolean; narrow?: boolean }) {
  const q = useAsync(() => api.experimentalPerformance(), [])
  useVisibleRefresh(q.reload)
  if (q.error) return <Section title="三連単モデル実験"><div className="p-4"><ErrorState error={q.error} onRetry={q.reload} /></div></Section>
  if (!q.data) return <Section title="三連単モデル実験"><div className="p-4"><Loading rows={compact ? 2 : 4} /></div></Section>
  const data = q.data

  return <Section title="三連単モデル実験" right={<span className="text-xs text-muted">実験専用・未検証</span>}>
    <div className="space-y-3 p-4">
      <p className="text-xs leading-relaxed text-muted">通常の運用成績・資産とは別の仮想台帳です。{caveat}</p>
      {data.comparison && <div className="border-t border-line pt-3">
        <h3 className="mb-1 text-sm font-medium">選択買い目の固定100円比較</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted">既存の実験購入と同じ選択・購入時オッズ・公式精算結果を使った事後比較です。固定方式は選択券ごとに100円を仮想計上し、実験台帳・購入判断・実験用残高には影響しません。投資総額が異なるため同額予算比較ではなく、独立した購入戦略でもありません。全券が確定したレースのみを両方式に同じく含め、保留中 {data.comparison.pendingRaceCount} レースは除外、無効・証跡/賭け額条件外 {data.comparison.excludedRaceCount} レースは比較対象外です。</p>
        <div className={`grid grid-cols-1 gap-3 ${narrow ? '' : 'md:grid-cols-2'}`}>
          <ComparisonMetric label="柔軟額（実験台帳）" data={data.comparison.actual} />
          <ComparisonMetric label="固定100円/選択" data={data.comparison.fixed100} />
        </div>
        <p className="mt-2 text-[10px] text-muted">比較対象 {data.comparison.settledRaceCount} レース · 各方式のROI = 払戻合計 ÷ その方式の購入額。固定払戻は保存済み実験精算額から券ごとの100円払戻を復元しています。</p>
      </div>}
      <div className={`grid grid-cols-2 gap-3 ${narrow ? '' : 'md:grid-cols-4'}`}>
        <Metric label="実験用仮想残高" value={yen(data.bankroll.available)} sub={`初期 ${yen(data.bankroll.initial)}`} />
        <Metric label="実験損益" value={signedYen(data.metrics.profit)} className={tone(data.metrics.profit)} />
        <Metric label="実験回収率" value={pct(data.metrics.roi)} />
        <Metric label="判断 / 購入" value={`${data.decisions.length} / ${data.metrics.bets}`} sub={`購入額 ${yen(data.metrics.stake)}`} />
      </div>
      <p className="text-xs text-muted">1券あたり{yen(data.sizing.minimumTicketStake ?? 100)}以上・{yen(data.sizing.stakeUnit ?? 100)}単位 · 1レース合計の購入額上限 {yen(data.sizing.perRaceCombinedCap)} · 日次固定上限なし · 仮想残高は非負に制限</p>
      {!compact && <>
        <div className="border-t border-line pt-3">
          <h3 className="mb-2 text-sm font-medium">実験判断履歴</h3>
          {!data.decisions.length ? <Empty>実験判断はまだありません。</Empty> : <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="text-muted"><tr><th className="py-2 pr-3">レース</th><th className="py-2 pr-3">判断</th><th className="py-2 pr-3">購入額</th><th className="py-2 pr-3">確率</th><th className="py-2 pr-3">オッズ</th><th className="py-2 pr-3">期待ROI</th><th className="py-2">判断時刻</th></tr></thead>
              <tbody className="divide-y divide-line">{data.decisions.map((decision, i) => <tr key={`${decision.raceId}-${decision.decidedAt}-${i}`}>
                <td className="py-2 pr-3">{decision.raceDate} · {decision.venueName ?? decision.raceId} {decision.raceNo}R</td>
                <td className="py-2 pr-3">{decisionLabel(decision.outcome, decision.reason)}</td>
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

function ComparisonMetric({ label, data }: { label: string; data: NonNullable<ExperimentalPerformanceData['comparison']>['actual'] }) {
  return <div className="rounded-md border border-line bg-surface p-3">
    <div className="label">{label}</div>
    <div className={`figure mt-2 text-2xl ${tone(data.profit)}`}>{signedYen(data.profit)}</div>
    <div className="mt-1.5 text-xs text-muted">購入 {yen(data.stake)} · 払戻 {yen(data.payout)} · ROI {pct(data.roi)} · {data.tickets} 券</div>
  </div>
}

function Metric({ label, value, sub, className = '' }: { label: string; value: string; sub?: string; className?: string }) {
  return <div className="lift rounded-md border border-line bg-surface p-3"><div className="label">{label}</div><div className={`figure mt-2 text-2xl ${className}`}><CountUp value={value} /></div>{sub && <div className="num mt-1.5 text-[10px] text-muted">{sub}</div>}</div>
}
