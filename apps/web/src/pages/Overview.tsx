import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Bet, Overview } from '@edgelab/shared/src/types'
import { api } from '../lib/api'
import { useOrigin } from '../lib/origin'
import { useAsync } from '../lib/useAsync'
import { betTypeLabel } from '../lib/betType'
import { dateTime, pct, signedYen, tone, yen } from '../lib/format'
import { t } from '../i18n'
import { EquityChart } from '../components/EquityChart'
import { ExperimentalPerformance } from '../components/ExperimentalPerformance'
import { mergePurchaseHistory, type HistoryBet } from '../lib/purchaseHistory'
import { useVisibleRefresh } from '../lib/useVisibleRefresh'
import { HistoricalTrifectaExperiment } from '../components/HistoricalTrifectaExperiment'
import { CountUp, Empty, ErrorState, LiveDot, Loading, Section, Segmented, SportIcon } from '../components/ui'

type PurchasedRace = {
  raceId: string
  sport: Bet['sport']
  raceDate?: string
  venueName?: string
  raceNo?: number
  bets: HistoryBet[]
  latestPurchase: string
}

function groupPurchasedRaces(bets: HistoryBet[]): PurchasedRace[] {
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

type RaceFilter = 'all' | 'open' | 'won' | 'lost'
const PAGE_SIZE = 12

function raceState(race: PurchasedRace): Exclude<RaceFilter, 'all'> {
  if (race.bets.some((bet) => bet.status === 'open')) return 'open'
  return race.bets.some((bet) => bet.status === 'won') ? 'won' : 'lost'
}

export function OverviewPage() {
  const { origin } = useOrigin()
  const load = async (fresh = false) => {
    const [performance, historyPerformance, normal, experimental] = await Promise.all([api.overview(origin, undefined, fresh), api.overview(origin, undefined, fresh, 'purchase-history'), api.bets(origin, undefined, fresh), origin === 'sample' ? Promise.resolve([]) : api.experimentalBets()])
    return [performance, historyPerformance, mergePurchaseHistory(normal, experimental)] as const
  }
  const all = useAsync(() => load(), [origin], () => load(true))
  useVisibleRefresh(all.reload)
  const purchasedRaces = useMemo(() => all.data ? groupPurchasedRaces(all.data[2]) : [], [all.data])
  const [filter, setFilter] = useState<RaceFilter>('all')
  const [visible, setVisible] = useState(PAGE_SIZE)

  if (all.error) return <div className="card"><ErrorState error={all.error} onRetry={all.reload} /></div>
  if (!all.data) return <div className="card"><Loading rows={5} /></div>
  const [performance, historyPerformance, bets] = all.data
  const unresolved = historyPerformance.betCount - historyPerformance.settledCount
  const counts = { all: purchasedRaces.length, open: 0, won: 0, lost: 0 }
  for (const race of purchasedRaces) counts[raceState(race)] += 1
  const filtered = filter === 'all' ? purchasedRaces : purchasedRaces.filter((race) => raceState(race) === filter)
  const shown = filtered.slice(0, visible)

  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="kicker">VIRTUAL BOARD</div>
        <h1 className="draw-underline mt-1 inline-block text-2xl font-black tracking-tight">運用ボード</h1>
        <p className="mt-3 text-sm text-muted">仮想購入の実績と、購入記録があるレースだけを表示します。</p>
      </div>
      <button className="btn-ghost mt-4 h-8 text-xs" onClick={all.reload} disabled={all.loading}><RefreshIcon spinning={all.loading} />更新</button>
    </div>

    <SettledTicker bets={bets} />

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-5">
        <Section title="運用成績" right={<span className="text-xs text-muted">資産は通常台帳 · 損益 / 回収率は通常＋実験</span>}>
          <Scoreboard performance={performance} historyPerformance={historyPerformance} unresolved={unresolved} />
          <div className="border-t border-line px-2 pb-3 pt-2">
            {historyPerformance.equityCurve.length > 1 ? <EquityChart data={historyPerformance.equityCurve} base={historyPerformance.equityCurve[0].bankroll} valueLabel="累計損益" baseLabel="損益 0円" /> : <Empty>確定した仮想購入がまだありません。</Empty>}
          </div>
        </Section>

        <Section title="購入したレース" right={<span className="num text-xs text-muted">{purchasedRaces.length}レース · {bets.length}点</span>}>
          {!purchasedRaces.length ? <Empty>この表示条件では仮想購入がありません。未購入レースは表示しません。</Empty> : <>
            <div className="border-b border-line px-4 py-3">
              <Segmented<RaceFilter> size="sm" ariaLabel="購入したレースの絞り込み" value={filter} onChange={(next) => { setFilter(next); setVisible(PAGE_SIZE) }} options={[
                { value: 'all', label: <>すべて <span className="num ml-0.5 text-faint">{counts.all}</span></> },
                { value: 'open', label: <>精算待ち <span className="num ml-0.5 text-faint">{counts.open}</span></> },
                { value: 'won', label: <>的中あり <span className="num ml-0.5 text-faint">{counts.won}</span></> },
                { value: 'lost', label: <>不的中 <span className="num ml-0.5 text-faint">{counts.lost}</span></> },
              ]} />
            </div>
            <div className="race-list">
              {shown.length > 0 && <PurchasedRaceHeader />}
              {!shown.length ? <Empty>この条件に該当するレースはありません。</Empty> : <div key={filter} className="stagger divide-y divide-line">
                {shown.map((race, index) => <PurchasedRaceCard key={race.raceId} race={race} index={index % PAGE_SIZE} />)}
              </div>}
            </div>
            {filtered.length > shown.length && <div className="border-t border-line p-3 text-center">
              <button className="btn-ghost h-9 text-xs" onClick={() => setVisible((n) => n + PAGE_SIZE)}>さらに表示（残り {(filtered.length - shown.length).toLocaleString()}レース）</button>
            </div>}
          </>}
        </Section>
      </div>

      {/* The experimental ledger is separate from normal results, so it sits beside them rather than between them. */}
      <aside aria-label="実験台帳" className="min-w-0 space-y-5">
        <ExperimentalPerformance compact narrow />
        <HistoricalTrifectaExperiment compact />
      </aside>
    </div>
  </div>
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${spinning ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
}

function Scoreboard({ performance, historyPerformance, unresolved }: { performance: Overview; historyPerformance: Overview; unresolved: number }) {
  const roi = historyPerformance.roi
  const meterMax = 2
  const fill = roi == null ? 0 : Math.min(1, Math.max(0, roi / meterMax))
  return <div className="grid gap-px bg-line md:grid-cols-[1.25fr_1fr]">
    <div className="bg-surface p-5">
      <div className="label">通常台帳の仮想資産</div>
      <div className="figure mt-2 text-[44px] sm:text-[56px]"><CountUp value={yen(performance.bankroll)} duration={1200} /></div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="label">累計損益</span>
        <span className={`figure text-2xl ${tone(historyPerformance.totalProfit)}`}><CountUp value={signedYen(historyPerformance.totalProfit)} /></span>
        <span className="num text-xs text-muted">通常＋実験 · 確定 {historyPerformance.settledCount}点</span>
      </div>
    </div>
    <div className="bg-surface p-5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">回収率</span>
        <span className="text-[10px] text-muted">通常＋実験 · 確定払戻 ÷ 購入額</span>
      </div>
      <div className={`figure mt-2 text-[40px] ${roi == null ? '' : roi >= 1 ? 'text-pos' : 'text-neg'}`}><CountUp value={pct(roi)} /></div>
      <div className="relative mt-3 h-3 rounded-[2px] border border-ink/20 bg-raised" role="img" aria-label={roi == null ? '回収率は未確定' : `回収率 ${pct(roi)}、損益分岐 100%`}>
        <div className={`bar-grow h-full ${roi != null && roi >= 1 ? 'bg-pos' : 'bg-neg/80'}`} style={{ width: `${fill * 100}%` }} />
        <div className="absolute -top-1 bottom-[-4px] left-1/2 w-[2px] -translate-x-1/2 bg-ink" />
      </div>
      <div className="num mt-1 flex justify-between text-[10px] text-faint"><span>0%</span><span className="font-bold text-muted">損益分岐 100%</span><span>200%</span></div>
    </div>
    <div className="grid grid-cols-2 gap-px bg-line md:col-span-2 md:grid-cols-4">
      <MiniStat label="購入点数" value={historyPerformance.betCount.toLocaleString()} sub={`確定 ${historyPerformance.settledCount}`} />
      <MiniStat label="的中率" value={pct(historyPerformance.hitRate)} />
      <MiniStat label="累計損益の最大下落" value={yen(historyPerformance.maxDrawdown)} sub="最高益から" />
      <MiniStat label="未確定" value={unresolved.toLocaleString()} sub="損益・回収率の集計対象外" live={unresolved > 0} />
    </div>
  </div>
}

function MiniStat({ label, value, sub, live = false }: { label: string; value: string; sub?: string; live?: boolean }) {
  return <dl className="min-w-0 bg-surface px-5 py-3">
    <dt className="label flex items-center gap-1.5">{live && <LiveDot />}{label}</dt>
    <dd className="figure mt-1.5 text-2xl"><CountUp value={value} /></dd>
    {sub && <dd className="num mt-1 text-[10px] text-muted">{sub}</dd>}
  </dl>
}

/** Scrolling strip of the latest settled purchases, built only from stored settlement records. */
function SettledTicker({ bets }: { bets: Bet[] }) {
  const settled = bets.filter((bet) => bet.status !== 'open' && bet.settledAt)
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? '')).slice(0, 14)
  if (settled.length < 3) return null
  const item = (bet: Bet, copy: boolean) => <li key={`${copy ? 'c' : 'o'}-${bet.id}`} aria-hidden={copy || undefined} className="flex shrink-0 items-center gap-2 border-r border-side-ink/15 px-4 text-xs">
    <SportIcon sport={bet.sport} className={`h-3.5 w-3.5 ${bet.sport === 'boat' ? 'text-boat' : 'text-horse'}`} />
    <span className="font-bold">{bet.venueName ?? bet.raceId}{bet.raceNo != null ? ` ${bet.raceNo}R` : ''}</span>
    <span className="font-mono text-side-ink/70">{betTypeLabel[bet.betType]} {bet.selection}</span>
    <span className={`rounded-[3px] px-1 text-[10px] font-bold ${bet.status === 'won' ? 'bg-mark text-[rgb(26_24_20)]' : 'bg-side-ink/10 text-side-ink/70'}`}>{t().betStatus[bet.status]}</span>
    {bet.profit != null && <span className={`num font-bold ${bet.profit > 0 ? 'text-mark' : 'text-side-ink/60'}`}>{signedYen(bet.profit)}</span>}
  </li>
  return <section aria-label="直近の確定" className="ticker flex items-stretch overflow-hidden rounded-md bg-side text-side-ink">
    <div className="z-[1] flex shrink-0 items-center gap-2 bg-mark px-3 text-[11px] font-black text-[rgb(26_24_20)]"><LiveDot />直近の確定</div>
    <div className="min-w-0 flex-1 overflow-hidden py-2">
      <ul className="ticker-track" style={{ ['--ticker-duration' as string]: `${settled.length * 4}s` }}>
        {settled.map((bet) => item(bet, false))}
        {settled.map((bet) => item(bet, true))}
      </ul>
    </div>
  </section>
}

// Rows switch to table columns from the width of the list itself (see .race-list in index.css),
// because the board's side column makes the viewport width a poor guide.

function PurchasedRaceHeader() {
  return <div aria-hidden="true" className="race-head border-b border-ink/40 bg-raised/40 px-4 py-2 pl-5 text-[10px] font-bold text-muted">
    <span>レース</span><span>買い目</span><span className="text-right">購入額</span><span className="text-right">確定払戻</span><span className="text-right">確定損益</span><span className="text-right">精算状況</span>
  </div>
}

function PurchasedRaceCard({ race, index }: { race: PurchasedRace; index: number }) {
  const resolved = race.bets.filter((bet) => bet.status !== 'open')
  const pendingCount = race.bets.length - resolved.length
  const knownPayouts = resolved.filter((bet) => bet.payout != null)
  const settledPayout = knownPayouts.reduce((sum, bet) => sum + (bet.payout ?? 0), 0)
  const knownProfits = resolved.filter((bet) => bet.profit != null)
  const settledProfit = knownProfits.reduce((sum, bet) => sum + (bet.profit ?? 0), 0)
  const target = `/${race.sport}/${encodeURIComponent(race.raceId)}`
  const state = raceState(race)
  const strip = state === 'open' ? 'bg-mark' : state === 'won' ? 'bg-pos' : 'bg-line'
  const profitKnown = knownProfits.length === resolved.length && resolved.length > 0
  const experimentalCount = race.bets.filter((bet) => bet.recordKind === 'experimental_paper').length
  // One label per race when the whole race is experimental; mixed races mark each experimental ticket.
  const allExperimental = experimentalCount === race.bets.length
  return <article className="race-row group relative p-4 pl-5 transition-colors duration-300 hover:bg-raised/40" style={{ ['--i' as string]: index }}>
    <span aria-hidden="true" className={`absolute inset-y-3 left-0 w-1 rounded-r transition-[top,bottom] duration-300 group-hover:inset-y-0 ${strip}`} />
    <div className="race-main min-w-0">
      <Link to={target} className="flex items-center gap-2 font-bold hover:text-accent">
        <SportIcon sport={race.sport} className={`h-4 w-4 shrink-0 ${race.sport === 'boat' ? 'text-boat' : 'text-horse'}`} />
        <span className="min-w-0 truncate">{race.venueName ?? race.raceId}{race.raceNo != null ? ` ${race.raceNo}R` : ''}</span>
        <span className="shrink-0 text-xs font-normal text-muted transition-transform duration-300 group-hover:translate-x-1 race-wide-hidden">詳細 →</span>
      </Link>
      <div className="num mt-1 text-[11px] text-muted">{race.raceDate ?? '開催日不明'} · 購入 {race.bets.length}点 · {dateTime(race.latestPurchase)} 時点</div>
      {allExperimental && <span className="mt-1.5 inline-block whitespace-nowrap rounded-[3px] border border-dashed border-line px-1.5 py-0.5 text-[10px] font-bold text-muted">実験・通常成績対象外</span>}
    </div>
    <div className="race-tickets flex min-w-0 flex-wrap gap-1.5">
      {race.bets.map((bet) => <div key={bet.id} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[4px] border px-2 py-1 text-xs [&>span]:whitespace-nowrap ${bet.status === 'won' ? 'border-pos/50 bg-pos/10' : 'border-line bg-surface'}`}>
        {bet.recordKind === 'experimental_paper' && !allExperimental && <span className="rounded-[3px] border border-dashed border-line px-1 text-[10px] font-bold text-muted" title="実験・通常成績対象外">実験</span>}
        <span className="font-mono font-bold">{betTypeLabel[bet.betType]} {bet.selection}</span>
        <span className="num text-muted">{yen(bet.stake)}</span>
        <span className={bet.status === 'won' ? 'anim-stamp inline-block font-bold text-pos' : bet.status === 'void' ? 'text-warn' : 'text-muted'}>{t().betStatus[bet.status]}</span>
        {bet.status !== 'open' && bet.payout != null && (bet.payout > 0 || bet.status === 'void') && <span className="num text-muted">払戻 {yen(bet.payout)}</span>}
      </div>)}
    </div>
    <RowValue label="購入額"><span className="num font-bold">{yen(race.bets.reduce((sum, bet) => sum + bet.stake, 0))}</span></RowValue>
    <RowValue label="確定払戻"><span className="num font-bold">{knownPayouts.length === resolved.length && resolved.length ? yen(settledPayout) : knownPayouts.length ? '一部未確認' : '未確定'}</span></RowValue>
    <RowValue label="確定損益"><span className={`num font-bold ${profitKnown ? tone(settledProfit) : 'text-muted'}`}>{profitKnown ? signedYen(settledProfit) : knownProfits.length ? '一部未確認' : '未確定'}</span></RowValue>
    <RowValue label="精算状況"><span className="flex items-center justify-end gap-1.5 font-bold">{pendingCount > 0 && <LiveDot />}{pendingCount ? `未確定 ${pendingCount}点` : '全点確定'}</span></RowValue>
  </article>
}

function RowValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="race-value flex items-baseline justify-between gap-3 text-xs">
    <span className="race-value-label text-[10px] text-muted">{label}</span>
    {children}
  </div>
}
