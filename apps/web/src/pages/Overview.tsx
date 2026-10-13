import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { Bet } from '@edgelab/shared/src/types'
import { api } from '../lib/api'
import { useOrigin } from '../lib/origin'
import { useAsync } from '../lib/useAsync'
import { betTypeLabel } from '../lib/betType'
import { dateTime, pct, signedYen, tone, yen } from '../lib/format'
import { t } from '../i18n'
import { EquityChart } from '../components/EquityChart'
import { ExperimentalPerformance } from '../components/ExperimentalPerformance'
import { ExperimentalBetsHistory } from '../components/ExperimentalBetsHistory'
import { Empty, ErrorState, Kpi, Loading, Section, SportIcon } from '../components/ui'

type PurchasedRace = {
  raceId: string
  sport: Bet['sport']
  raceDate?: string
  venueName?: string
  raceNo?: number
  bets: Bet[]
  latestPurchase: string
}

function groupPurchasedRaces(bets: Bet[]): PurchasedRace[] {
  const groups = new Map<string, PurchasedRace>()
  for (const bet of bets) {
    const group = groups.get(bet.raceId) ?? {
      raceId: bet.raceId,
      sport: bet.sport,
      raceDate: bet.raceDate,
      venueName: bet.venueName,
      raceNo: bet.raceNo,
      bets: [],
      latestPurchase: bet.placedAt,
    }
    group.bets.push(bet)
    if (bet.placedAt > group.latestPurchase) group.latestPurchase = bet.placedAt
    groups.set(bet.raceId, group)
  }
  return [...groups.values()].sort((a, b) => b.latestPurchase.localeCompare(a.latestPurchase))
}

export function OverviewPage() {
  const { origin } = useOrigin()
  const all = useAsync(() => Promise.all([api.overview(origin), api.bets(origin)]), [origin], () => Promise.all([api.overview(origin, undefined, true), api.bets(origin, undefined, true)]))
  const purchasedRaces = useMemo(() => all.data ? groupPurchasedRaces(all.data[1]) : [], [all.data])

  if (all.error) return <div className="card"><ErrorState error={all.error} onRetry={all.reload} /></div>
  if (!all.data) return <div className="card"><Loading rows={5} /></div>
  const [performance, bets] = all.data
  const unresolved = bets.filter((bet) => bet.status === 'open').length

  return <div className="space-y-5">
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold tracking-tight">運用ボード</h1><button className="btn-ghost h-8 text-xs" onClick={all.reload} disabled={all.loading}>更新</button></div>
      <p className="mt-1 text-sm text-muted">仮想購入の実績と、購入記録があるレースだけを表示します。</p>
    </div>

    <Section title="運用成績" right={<span className="text-xs text-muted">確定分の払戻と損益 · 初期資金 {yen(performance.initialBankroll)}</span>}>
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="仮想資産" value={yen(performance.bankroll)} />
        <Kpi label="確定損益" value={signedYen(performance.totalProfit)} valueClass={tone(performance.totalProfit)} />
        <Kpi label="回収率" value={pct(performance.roi)} valueClass={performance.roi == null ? '' : performance.roi >= 1 ? 'text-pos' : 'text-neg'} sub="確定払戻 ÷ 確定購入額（返還除外）" />
        <Kpi label="購入点数" value={performance.betCount.toLocaleString()} sub={`確定 ${performance.settledCount}`} />
        <Kpi label="的中率" value={pct(performance.hitRate)} />
        <Kpi label="未確定" value={unresolved.toLocaleString()} sub="損益・回収率の集計対象外" />
      </div>
      <div className="border-t border-line px-2 pb-3 pt-2">
        {performance.equityCurve.length > 1 ? <EquityChart data={performance.equityCurve} base={performance.initialBankroll} /> : <Empty>確定した仮想購入がまだありません。</Empty>}
      </div>
    </Section>

    <ExperimentalPerformance compact />
    {origin !== 'sample' && <ExperimentalBetsHistory compact />}

    <Section title="購入したレース" right={<span className="text-xs text-muted">{purchasedRaces.length}レース · {bets.length}点</span>}>
      {!purchasedRaces.length ? <Empty>この表示条件では仮想購入がありません。未購入レースは表示しません。</Empty> : <div className="divide-y divide-line">
        {purchasedRaces.map((race) => <PurchasedRaceCard key={race.raceId} race={race} />)}
      </div>}
    </Section>
  </div>
}

function PurchasedRaceCard({ race }: { race: PurchasedRace }) {
  const resolved = race.bets.filter((bet) => bet.status !== 'open')
  const pendingCount = race.bets.length - resolved.length
  const knownPayouts = resolved.filter((bet) => bet.payout != null)
  const settledPayout = knownPayouts.reduce((sum, bet) => sum + (bet.payout ?? 0), 0)
  const knownProfits = resolved.filter((bet) => bet.profit != null)
  const settledProfit = knownProfits.reduce((sum, bet) => sum + (bet.profit ?? 0), 0)
  const target = `/${race.sport}/${encodeURIComponent(race.raceId)}`
  return <article className="p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <Link to={target} className="flex items-center gap-2 font-semibold hover:text-accent">
          <SportIcon sport={race.sport} className={`h-4 w-4 ${race.sport === 'boat' ? 'text-boat' : 'text-horse'}`} />
          {race.venueName ?? race.raceId}{race.raceNo != null ? ` ${race.raceNo}R` : ''}
          <span className="text-xs font-normal text-muted">詳細 →</span>
        </Link>
        <div className="mt-1 text-[11px] text-muted">{race.raceDate ?? '開催日不明'} · 購入 {race.bets.length}点 · {dateTime(race.latestPurchase)} 時点</div>
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-right text-xs sm:grid-cols-4">
        <div><div className="text-[10px] text-muted">購入額</div><div className="num font-semibold">{yen(race.bets.reduce((sum, bet) => sum + bet.stake, 0))}</div></div>
        <div><div className="text-[10px] text-muted">確定払戻</div><div className="num font-semibold">{knownPayouts.length === resolved.length && resolved.length ? yen(settledPayout) : knownPayouts.length ? '一部未確認' : '未確定'}</div></div>
        <div><div className="text-[10px] text-muted">確定損益</div><div className={`num font-semibold ${knownProfits.length === resolved.length && resolved.length ? tone(settledProfit) : 'text-muted'}`}>{knownProfits.length === resolved.length && resolved.length ? signedYen(settledProfit) : knownProfits.length ? '一部未確認' : '未確定'}</div></div>
        <div><div className="text-[10px] text-muted">精算状況</div><div className="font-semibold">{pendingCount ? `未確定 ${pendingCount}点` : '全点確定'}</div></div>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      {race.bets.map((bet) => <div key={bet.id} className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-2 text-xs">
        <span className="font-mono font-medium">{betTypeLabel[bet.betType]} {bet.selection}</span>
        <span className="num text-muted">{yen(bet.stake)}</span>
        <span className={bet.status === 'won' ? 'text-pos' : bet.status === 'void' ? 'text-warn' : 'text-muted'}>{t().betStatus[bet.status]}</span>
        {bet.status !== 'open' && bet.payout != null && <span className="num text-muted">払戻 {yen(bet.payout)}</span>}
      </div>)}
    </div>
  </article>
}
