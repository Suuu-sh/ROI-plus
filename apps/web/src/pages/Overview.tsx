import { Link } from 'react-router-dom'
import type { ModelInfo, Overview, Sport } from '@edgelab/shared/src/types'
import { api } from '../lib/api'
import { useOrigin, type OriginFilter } from '../lib/origin'
import { representativeModel } from '../lib/models'
import { useAsync } from '../lib/useAsync'
import { num, pct, signedPct, signedYen, tone, yen } from '../lib/format'
import { t } from '../i18n'
import { EquityChart } from '../components/EquityChart'
import { BetsTable } from '../components/BetsTable'
import { Empty, ErrorState, Kpi, Loading, Section, SportIcon } from '../components/ui'

export function OverviewPage() {
  const { origin } = useOrigin()
  const all = useAsync(() => Promise.all([
    api.overview(origin), api.overview(origin, 'horse'), api.overview(origin, 'boat'), api.models(), api.bets(origin),
  ]), [origin])

  if (all.error) return <div className="card"><ErrorState error={all.error} onRetry={all.reload} /></div>
  if (!all.data) return <div className="card"><Loading rows={5} /></div>
  const [ov, horse, boat, models, bets] = all.data

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">概要</h1>
        <p className="mt-1 text-sm text-muted">初期仮想資金 {yen(ov.initialBankroll)}・1点 ¥100 からの仮想運用成績</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="総仮想資産" value={yen(ov.bankroll)} sub={signedPct(ov.bankroll / ov.initialBankroll - 1)} />
        <Kpi label="累計損益" value={signedYen(ov.totalProfit)} valueClass={tone(ov.totalProfit)} />
        <Kpi label="回収率" value={pct(ov.roi)} valueClass={ov.roi == null ? '' : ov.roi >= 1 ? 'text-pos' : 'text-neg'} sub="払戻 ÷ 購入額" />
        <Kpi label="仮想購入回数" value={ov.betCount.toLocaleString()} sub={`確定 ${ov.settledCount}`} />
        <Kpi label="的中率" value={pct(ov.hitRate)} />
        <Kpi label="最大ドローダウン" value={yen(ov.maxDrawdown)} sub={pct(ov.maxDrawdownPct)} valueClass={ov.maxDrawdown > 0 ? 'text-neg' : ''} />
      </div>

      <Section title="資産推移" right={<span className="text-xs text-muted">破線＝初期資金</span>}>
        <div className="px-2 pb-3 pt-2">
          {ov.equityCurve.length > 1 ? <EquityChart data={ov.equityCurve} base={ov.initialBankroll} /> : <Empty>確定した仮想購入がまだありません。</Empty>}
        </div>
      </Section>

      <SportComparison horse={horse} boat={boat} models={models} origin={origin} />

      <Section title="最近の仮想購入" right={<Link to="/performance" className="text-xs text-accent hover:underline">成績の詳細 →</Link>}>
        <BetsTable bets={bets} limit={8} />
      </Section>
    </div>
  )
}

function SportComparison({ horse, boat, models, origin }: { horse: Overview; boat: Overview; models: ModelInfo[]; origin: OriginFilter }) {
  const active = (s: Sport) => representativeModel(models, s, origin)
  const rows: { sport: Sport; ov: Overview; model: ModelInfo | null }[] = [
    { sport: 'horse', ov: horse, model: active('horse') },
    { sport: 'boat', ov: boat, model: active('boat') },
  ]
  // ROI が高い方を強調（どちらも確定購入がある場合のみ）
  // 確定購入が各100件以上かつ回収率差が5pt以上のときだけリードを示す（それ未満は誤差の範囲）
  const comparable = horse.roi != null && boat.roi != null && horse.settledCount >= 100 && boat.settledCount >= 100
  const leader = comparable && Math.abs(horse.roi! - boat.roi!) >= 0.05 ? (horse.roi! > boat.roi! ? 'horse' : 'boat') : null
  const verdict = !comparable ? '比較に十分な確定購入がまだありません（各100件以上で判定）'
    : leader ? `${t().sport[leader]}が回収率で ${Math.abs((horse.roi! - boat.roi!) * 100).toFixed(1)}pt リード`
    : '回収率の差は 5pt 未満で、現時点では優劣をつけられません'
  return (
    <Section title="競馬 vs ボートレース" right={<span className="text-right text-xs text-muted">{verdict}</span>}>
      <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
        {rows.map(({ sport, ov, model }) => (
          <div key={sport} className="p-4">
            <div className="flex items-center justify-between">
              <div className={`flex items-center gap-2 font-semibold ${sport === 'horse' ? 'text-horse' : 'text-boat'}`}>
                <SportIcon sport={sport} className="h-5 w-5" />{t().sport[sport]}
              </div>
              {leader === sport && <span className="rounded-full bg-pos/10 px-2 py-0.5 text-[11px] font-semibold text-pos">回収率リード</span>}
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-y-4 text-sm">
              <Stat k="回収率" v={pct(ov.roi)} cls={ov.roi == null ? '' : ov.roi >= 1 ? 'text-pos' : 'text-neg'} />
              <Stat k="損益" v={signedYen(ov.totalProfit)} cls={tone(ov.totalProfit)} />
              <Stat k="購入/的中率" v={`${ov.settledCount} / ${pct(ov.hitRate, 0)}`} />
              <Stat k="Log Loss" v={num(model?.metrics.logLoss, 3)} hint={model?.metrics.baselineLogLoss != null ? `基準 ${num(model.metrics.baselineLogLoss, 3)}` : undefined} />
              <Stat k="Brier" v={num(model?.metrics.brier, 3)} />
              <Stat k="校正誤差 ECE" v={num(model?.metrics.ece, 3)} />
            </dl>
            <div className="mt-4 text-xs text-muted">
              {model ? <>{model.status === 'active' ? '稼働モデル' : t().modelStatus[model.status]} <span className="font-mono text-ink">{model.id}</span>{model.testFrom && <span className="text-faint">（test {model.testFrom}〜{model.testTo}）</span>}</> : <span className="text-warn">学習済みモデルがありません（未学習）</span>}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Stat({ k, v, cls = '', hint }: { k: string; v: string; cls?: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className={`num mt-0.5 font-semibold ${cls}`}>{v}</dd>
      {hint && <dd className="num text-[10px] text-faint">{hint}</dd>}
    </div>
  )
}
