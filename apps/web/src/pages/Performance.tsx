import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import type { Breakdown } from '@edgelab/shared/src/types'
import { api } from '../lib/api'
import { useOrigin, type OriginFilter } from '../lib/origin'
import { useAsync } from '../lib/useAsync'
import { odds, pct, signedYen, tone, yen } from '../lib/format'
import { t } from '../i18n'
import { BetsTable } from '../components/BetsTable'
import { Empty, ErrorState, Loading, Section, SportIcon } from '../components/ui'

const axis = { fontSize: 11, fill: 'rgb(var(--faint))' }
const tip = { contentStyle: { background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 } }

export function PerformancePage() {
  const { origin } = useOrigin()
  const q = useAsync(() => Promise.all([api.breakdown(origin), api.bets(origin)]), [origin])
  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><Loading rows={6} /></div>
  const [bd, bets] = q.data

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">成績</h1>
        <p className="mt-1 text-sm text-muted">回収率だけでなく、予測確率の校正と期待値帯ごとの実績で評価します。</p>
      </div>

      <ProfitabilityNotice
        origin={origin}
        settledBets={bets.filter((bet) => bet.status === 'won' || bet.status === 'lost').length}
      />

      {origin === 'real' && bd.bySport.length === 0 && (
        <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          実データの仮想購入履歴がまだありません。オッズや予測が未取得の場合、期待収益率や購入候補は算出できません。収益性は、確定した実データの履歴とモデル管理の評価を分けて確認してください。
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {(['horse', 'boat'] as const).map((s) => {
          const r = bd.bySport.find((x) => x.sport === s)
          return (
            <div key={s} className="card p-4">
              <div className={`flex items-center gap-2 text-sm font-semibold ${s === 'horse' ? 'text-horse' : 'text-boat'}`}><SportIcon sport={s} />{t().sport[s]}の回収率</div>
              <div className={`num mt-2 text-3xl font-semibold ${r?.roi == null ? '' : r.roi >= 1 ? 'text-pos' : 'text-neg'}`}>{pct(r?.roi)}</div>
              <div className="num mt-1 flex gap-4 text-xs text-muted">
                <span>購入 {r?.bets ?? 0}</span><span>的中率 {pct(r?.hitRate)}</span>
                <span className={tone(r?.profit)}>損益 {signedYen(r?.profit ?? 0)}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title="月別損益">
          <MonthlyChart data={bd.byMonth} />
        </Section>
        <Section title="予測確率の校正" right={<span className="text-xs text-muted">対角線に近いほど良い</span>}>
          <CalibrationChart data={bd.calibration} />
        </Section>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title="期待値帯別の成績">
          <SimpleTable
            head={['期待収益率', '購入', '購入額', '回収率']}
            rows={bd.byEdge.map((r) => [r.bucket, r.bets, yen(r.stake), <RoiCell roi={r.roi} />])}
          />
        </Section>
        <Section title="モデル別の成績">
          <SimpleTable
            head={['モデル', '購入', '購入額', '回収率']}
            rows={bd.byModel.map((r) => [<span className="font-mono text-xs">{r.modelId}</span>, r.bets, yen(r.stake), <RoiCell roi={r.roi} />])}
          />
        </Section>
      </div>

      <Section title="オッズ変動の影響" right={<span className="text-xs text-muted">購入時オッズ vs 確定オッズ（的中時のみ判明）</span>}>
        <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
          <Cell k="対象購入数" v={(bd.oddsDrift.bets ?? 0).toLocaleString()} />
          <Cell k="平均 購入時オッズ" v={odds(bd.oddsDrift.avgOddsAtBet)} />
          <Cell k="平均 確定オッズ" v={odds(bd.oddsDrift.avgFinalOdds)} />
          <Cell k="期待値が消えた購入" v={(bd.oddsDrift.evLostCount ?? 0).toLocaleString()} cls={(bd.oddsDrift.evLostCount ?? 0) > 0 ? 'text-warn' : ''} />
        </div>
      </Section>

      <Section title="仮想購入履歴"><BetsTable bets={bets} /></Section>
    </div>
  )
}

export function ProfitabilityNotice({ origin, settledBets }: { origin: OriginFilter; settledBets: number }) {
  return (
    <aside className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted" aria-label="収益性の評価について">
      <p className="font-medium text-primary">期待収益率はモデル上の推定値であり、真のプラス期待値や利益を証明するものではありません。</p>
      <p className="mt-1">個々の購入の負けだけで予測の誤りとは判断できません。収益性の評価には、事前オッズを使った十分な out-of-sample 予測と、確定した実データの長期成績が必要です。</p>
      {origin === 'sample' ? (
        <p className="mt-1">サンプルデータの成績は、実際の利益を示す証拠にはなりません。</p>
      ) : origin === 'real' && settledBets === 0 ? (
        <p className="mt-1">現在の表示条件では確定した実データ購入がまだなく、回収率で収益性を検証できません。</p>
      ) : origin === 'all' ? (
        <p className="mt-1">サンプルと実データは区別して評価してください。サンプルの成績は実際の利益を示す証拠にはなりません。</p>
      ) : null}
    </aside>
  )
}

function RoiCell({ roi }: { roi: number | null }) {
  return <span className={`num ${roi == null ? 'text-faint' : roi >= 1 ? 'text-pos' : 'text-neg'}`}>{pct(roi)}</span>
}

function Cell({ k, v, cls = '' }: { k: string; v: string; cls?: string }) {
  return <div className="bg-surface px-4 py-3"><div className="text-[11px] text-muted">{k}</div><div className={`num mt-0.5 text-lg font-semibold ${cls}`}>{v}</div></div>
}

function SimpleTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (!rows.length) return <Empty>データがありません。</Empty>
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted">
        {head.map((h, i) => <th key={h} className={`px-4 py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-line">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`num px-4 py-2.5 ${j > 0 ? 'text-right' : ''}`}>{c}</td>)}</tr>)}
      </tbody>
    </table>
  )
}

function MonthlyChart({ data }: { data: Breakdown['byMonth'] }) {
  const months = [...new Set(data.map((d) => d.month))].sort()
  const rows = months.map((m) => ({
    month: m.slice(2).replace('-', '/'),
    horse: data.find((d) => d.month === m && d.sport === 'horse')?.profit ?? 0,
    boat: data.find((d) => d.month === m && d.sport === 'boat')?.profit ?? 0,
  }))
  if (!rows.length) return <Empty>確定した購入がありません。</Empty>
  return (
    <div className="h-[260px] p-2">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" />
          <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
          <ReferenceLine y={0} stroke="rgb(var(--faint))" />
          <Tooltip {...tip} formatter={(v, n) => [signedYen(Number(v)), n === 'horse' ? '競馬' : 'ボート']} cursor={{ fill: 'rgb(var(--raised))' }} />
          <Legend formatter={(v) => (v === 'horse' ? '競馬' : 'ボート')} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="horse" fill="rgb(var(--horse))" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Bar dataKey="boat" fill="rgb(var(--boat))" radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function CalibrationChart({ data }: { data: Breakdown['calibration'] }) {
  if (!data.length) return <Empty>結果が確定した予測がありません。</Empty>
  const pts = (s: 'horse' | 'boat') => data.filter((d) => d.sport === s && d.count > 0).map((d) => ({ x: d.predicted, y: d.actual, n: d.count }))
  const max = Math.min(1, Math.max(0.3, ...data.map((d) => Math.max(d.predicted, d.actual))) + 0.05)
  return (
    <div className="h-[260px] p-2">
      <ResponsiveContainer>
        <ComposedChart margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="rgb(var(--line))" />
          <XAxis type="number" dataKey="x" domain={[0, max]} tick={axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} label={{ value: '予測', position: 'insideBottomRight', offset: -2, fontSize: 11, fill: 'rgb(var(--muted))' }} />
          <YAxis type="number" dataKey="y" domain={[0, max]} tick={axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} width={40} />
          <Tooltip {...tip} formatter={(v, n) => [pct(Number(v)), n === 'x' ? '予測' : n === 'y' ? '実際' : n]} />
          <Line data={[{ x: 0, y: 0 }, { x: max, y: max }]} dataKey="y" stroke="rgb(var(--faint))" strokeDasharray="4 4" dot={false} isAnimationActive={false} legendType="none" />
          <Scatter name="競馬" data={pts('horse')} fill="rgb(var(--horse))" line={{ stroke: 'rgb(var(--horse))', strokeOpacity: 0.5 }} />
          <Scatter name="ボート" data={pts('boat')} fill="rgb(var(--boat))" line={{ stroke: 'rgb(var(--boat))', strokeOpacity: 0.5 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
