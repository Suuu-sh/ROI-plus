import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Bet, RankingCandidate, TicketCandidate, EntryView, RaceDetail, RaceSummary, Sport } from '@edgelab/shared/src/types'
import { api } from '../lib/api'
import { useOrigin } from '../lib/origin'
import { useAsync } from '../lib/useAsync'
import { dateTime, freshness, num, odds, pct, signedPct, timeOf, todayJst, tone } from '../lib/format'
import { t } from '../i18n'
import { EdgeBadge, Empty, ErrorState, Loading, OriginBadge, ProbBar, Section, SportIcon } from '../components/ui'
import { BetSheet } from '../components/BetSheet'
import { betTypeLabel } from '../lib/betType'

function shiftDate(d: string, days: number) {
  const x = new Date(`${d}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() + days)
  return x.toISOString().slice(0, 10)
}

export function SportPage({ sport }: { sport: Sport }) {
  const { raceId } = useParams()
  const { origin } = useOrigin()
  const [date, setDate] = useState(todayJst)
  const [researchOpen, setResearchOpen] = useState(Boolean(raceId))
  const bets = useAsync(() => api.bets(origin, sport), [sport, origin])
  useEffect(() => { if (raceId) setResearchOpen(true) }, [raceId])

  const accent = sport === 'horse' ? 'text-horse' : 'text-boat'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={`flex items-center gap-2 text-xl font-semibold tracking-tight ${accent}`}>
            <SportIcon sport={sport} className="h-6 w-6" />{t().sport[sport]}
          </h1>
          <p className="mt-1 text-sm text-muted">{sport === 'horse' ? 'JRA 中央競馬' : '全国24場'}・仮想購入とレース結果の確認</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button className="btn-ghost h-8 w-8 px-0" onClick={() => setDate((d) => shiftDate(d, -1))} aria-label="前日">‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="focus-ring num h-8 rounded-lg border border-line bg-surface px-2 text-sm" />
          <button className="btn-ghost h-8 w-8 px-0" onClick={() => setDate((d) => shiftDate(d, 1))} aria-label="翌日">›</button>
          {date !== todayJst() && <button className="btn-ghost h-8 text-xs" onClick={() => setDate(todayJst())}>今日</button>}
        </div>
      </div>

      <PurchasedRaces bets={bets.data} date={date} loading={bets.loading} error={bets.error} onRetry={bets.reload} />

      <details className="card group" open={researchOpen || undefined} onToggle={(event) => setResearchOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold marker:content-none">レースを調べる <span className="ml-2 text-xs font-normal text-muted">期待値ランキング・出走表</span></summary>
        {researchOpen && <ResearchArea sport={sport} date={date} origin={origin} raceId={raceId} onDate={setDate} onChanged={bets.reload} />}
      </details>
    </div>
  )
}

function ResearchArea({ sport, date, origin, raceId, onDate, onChanged }: { sport: Sport; date: string; origin: ReturnType<typeof useOrigin>['origin']; raceId?: string; onDate: (date: string) => void; onChanged: () => void }) {
  const races = useAsync(() => api.races(sport, date, origin), [sport, date, origin])
  const ranks = useAsync(() => api.rankings(sport, date, origin), [sport, date, origin])
  return <div className="space-y-5 border-t border-line p-4">
    <RankingStrip sport={sport} data={ranks.data} loading={ranks.loading} error={ranks.error} />
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <div className={`min-w-0 ${raceId ? 'hidden lg:block' : ''}`}>
        <Section title="レース一覧" right={<span className="num text-xs text-muted">{races.data?.length ?? 0}R</span>}>
          {races.error ? <ErrorState error={races.error} onRetry={races.reload} /> : !races.data ? <Loading rows={6} /> : races.data.length === 0 ? <Empty>この日のレースはありません。<br /><span className="text-xs">データ未取得の可能性もあります（データ収集画面で確認）。</span></Empty> : <RaceList races={races.data} sport={sport} selected={raceId} />}
        </Section>
      </div>
      <div className={`min-w-0 ${raceId ? '' : 'hidden lg:block'}`}>
        {raceId ? <RacePanel key={raceId} raceId={raceId} sport={sport} onDate={onDate} onChanged={() => { races.reload(); ranks.reload(); onChanged() }} /> : <div className="card"><Empty>レースを選択してください。</Empty></div>}
      </div>
    </div>
  </div>
}

export function filterBetsByDate(bets: Bet[], date: string) { return bets.filter((bet) => bet.raceDate === date) }

function PurchasedRaces({ bets, date, loading, error, onRetry }: { bets: Bet[] | null; date: string; loading: boolean; error: Error | null; onRetry: () => void }) {
  const grouped = new Map<string, Bet[]>()
  for (const bet of filterBetsByDate(bets ?? [], date)) grouped.set(bet.raceId, [...(grouped.get(bet.raceId) ?? []), bet])
  return <Section title="購入したレース" right={<span className="text-xs text-muted">{date}・仮想購入レビュー</span>}>
    {error ? <ErrorState error={error} onRetry={onRetry} /> : loading && !bets ? <Loading rows={2} /> : grouped.size === 0 ? <Empty>この日付の仮想購入はありません。日付を切り替えるか、レースを調べるから購入できます。</Empty> :
      <div className="divide-y divide-line">{[...grouped.values()].map((items) => <PurchasedRace key={items[0].raceId} bets={items} />)}</div>}
  </Section>
}

export function PurchasedRace({ bets }: { bets: Bet[] }) {
  const [reviewEnabled, setReviewEnabled] = useState(false)
  return <article className="p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><SportIcon sport={bets[0].sport} className="h-4 w-4"/><h3 className="font-semibold">{bets[0].venueName ?? bets[0].raceId} {bets[0].raceNo != null ? `${bets[0].raceNo}R` : ''}</h3><OriginBadge origin={bets[0].dataOrigin}/></div>
      <Link className="text-xs text-muted hover:text-ink" to={`/${bets[0].sport}/${bets[0].raceId}`}>出走表を見る →</Link>
    </div>
    <p className="mt-1 text-xs text-muted">{bets[0].raceDate ?? '日付不明'}・このレースの購入 {bets.length}件</p>
    <div className="mt-3 space-y-2">{bets.map((bet) => <PurchaseSnapshot key={bet.id} bet={bet} />)}</div>
    <details className="mt-3 rounded-lg border border-line" onToggle={(event) => { if (event.currentTarget.open) setReviewEnabled(true) }}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted">購入後の結果レビューを開く</summary>
      {reviewEnabled && <RaceOutcome bets={bets} />}
    </details>
  </article>
}

function PurchaseSnapshot({ bet: b }: { bet: Bet }) {
  const label = b.status === 'open' ? '仮想購入・精算待ち' : b.status === 'void' ? '無効' : b.status === 'won' ? '的中（精算記録）' : '不的中（精算記録）'
  return <div className="rounded-lg border border-line bg-raised/30 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-mono text-sm font-semibold">{betTypeLabel[b.betType]} {b.selection}<span className="ml-2 rounded bg-raised px-1.5 py-0.5 font-sans text-[10px] text-muted">仮想・{b.mode === 'auto' ? '自動' : '手動'}</span></div><span className={`text-xs ${b.status === 'won' ? 'text-pos' : b.status === 'lost' ? 'text-neg' : 'text-muted'}`}>{label}</span></div>
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
      <span className="text-muted">購入時確率</span><span className="num">{pct(b.predictedProb)}</span>
      <span className="text-muted">購入時オッズ</span><span className="num">{odds(b.oddsAtBet)}</span>
      <span className="text-muted">購入時期待収益率</span><span className={`num ${tone(b.expectedRoi)}`}>{signedPct(b.expectedRoi)}</span>
      <span className="text-muted">購入額 / 払戻 / 損益</span><span className="num">{b.stake.toLocaleString()}円 / {b.payout == null ? '記録なし' : `${b.payout.toLocaleString()}円`} / {b.profit == null ? '記録なし' : `${b.profit > 0 ? '+' : ''}${b.profit.toLocaleString()}円`}</span>
      <span className="text-muted">購入時候補順位</span><span>{b.candidateRank == null ? '記録なし' : `${b.candidateRank}位 / ${b.candidateCount ?? '—'}件`}</span>
    </div>
  </div>
}

function RaceOutcome({ bets }: { bets: Bet[] }) {
  const race = useAsync(() => api.race(bets[0].raceId), [bets[0].raceId])
  const r = race.data
  const winners = r?.entries.filter((e) => e.finishOrder === 1) ?? []
  if (race.error) return <p className="border-t border-line p-3 text-xs text-warn">結果記録は利用できません。このエラーから勝敗を推定しません。</p>
  if (!r) return <div className="border-t border-line p-3"><Loading rows={1}/></div>
  return <div className="border-t border-line p-3">
    <p className="text-xs text-muted">{r.raceDate}・{t().status[r.status]}　{r.dataOrigin === 'sample' ? 'サンプル結果（実績評価には含めません）' : '保存済みレース記録'}</p>
    <div className="mt-2 space-y-2">{bets.map((b) => {
      const entry = b.betType === 'win' ? r.entries.find((e) => String(e.number) === b.selection) : undefined
      const payout = r.payouts.find((p) => p.betType === b.betType && p.selection === b.selection)
      const topThree = [1, 2, 3].map((place) => r.entries.filter((e) => e.finishOrder === place))
      const finish = topThree.every((place) => place.length === 1)
        && new Set(topThree.map((place) => place[0].number)).size === 3
        ? topThree.map((place) => String(place[0].number)) : null
      const outcome = entry ? `${entry.finishOrder == null ? '選択の着順は未記録' : `選択は${entry.finishOrder}着`}${winners.length ? `。記録上の1着は${winners.map((e) => `${e.number}番`).join('、')}` : '。1着記録なし'}`
        : b.betType === 'trifecta' && finish ? `記録上の上位着順 ${finish.join('-')}。選択 ${b.selection} と照合${finish.join('-') === b.selection ? '一致' : '不一致'}`
          : winners.length ? `記録上の1着は${winners.map((e) => `${e.number}番`).join('、')}。選択の完全な着順記録はありません` : '公式着順記録なし'
      const breakEven = b.oddsAtBet != null && b.oddsAtBet > 0 ? `損益分岐確率は ${(100 / b.oddsAtBet).toFixed(1)}%。` : '購入時オッズがなく損益分岐比較はできません。'
      const modelChance = b.predictedProb == null ? '購入時確率なし。' : `購入時確率${(b.predictedProb * 100).toFixed(1)}%なら、補数は不的中確率${((1 - b.predictedProb) * 100).toFixed(1)}%です。これはモデルの推定であり個別結果の保証ではありません。`
      let explanation: string
      if (b.status === 'void') explanation = `保存状態は無効です。返還や払戻を推測しません${b.payout == null ? '（払戻記録なし）' : `。保存払戻 ${b.payout.toLocaleString()}円`}`
      else if (b.status === 'won') explanation = `保存された精算状態は的中。${outcome}。払戻 ${b.payout == null ? '記録なし' : `${b.payout.toLocaleString()}円`}${payout ? `（公式記録 ${payout.payout.toLocaleString()}円/100円）` : '（公式払戻記録なし）'}。${breakEven}${modelChance}`
      else if (b.status === 'lost') explanation = `保存された精算状態は不的中。${outcome}。${breakEven}${modelChance} 個別の不的中から原因は特定できません。`
      else explanation = `精算状態は未確定。観測記録: ${outcome}。該当払戻記録${payout ? `あり（${payout.payout.toLocaleString()}円/100円）` : 'なし'}。${breakEven}${modelChance}`
      return <p key={b.id} className="rounded bg-raised/30 p-2 text-xs leading-relaxed"><span className="font-medium">{betTypeLabel[b.betType]} {b.selection}:</span> {explanation}</p>
    })}</div>
    <p className="mt-2 text-[11px] leading-relaxed text-muted">購入時記録と結果・払戻の観測事実を照合しています。予測確率は期待値の見積りで、結果の因果説明ではありません。情報がない場合は欠損として扱います。</p>
  </div>
}

function RankingStrip({ sport, data, loading, error }: { sport: Sport; data: RankingCandidate[] | null; loading: boolean; error: Error | null }) {
  const top = (data ?? []).filter((c) => c.edge === 'HIGH_EDGE' || c.edge === 'POSITIVE_EDGE').slice(0, 8)
  return (
    <Section title="期待値ランキング" right={<span className="text-xs text-muted">不確実性を差し引いた購入候補</span>}>
      {error ? <ErrorState error={error} /> : loading && !data ? <Loading rows={1} /> : top.length === 0 ? (
        <Empty>購入候補はありません。期待値がプラスでも不確実性が大きい買い目は除外されます。</Empty>
      ) : (
        <div className="flex gap-3 overflow-x-auto p-4 [scrollbar-width:thin]">
          {top.map((c, i) => (
            <Link key={`${c.raceId}-${'selection' in c ? c.betType + '-' + c.selection : c.number}`} to={`/${sport}/${c.raceId}`}
              className="focus-ring group min-w-[200px] flex-1 rounded-xl border border-line bg-raised/40 p-3 transition-colors hover:border-ink/30">
              <div className="flex items-center justify-between">
                <span className="num text-xs text-faint">#{i + 1}</span>
                <EdgeBadge edge={c.edge} compact />
              </div>
              <div className="mt-2 truncate text-sm font-semibold">{c.venueName} {c.raceNo}R・{'selection' in c ? `${betTypeLabel[c.betType]} ${c.selection}` : `単勝 ${c.number}番`}</div>
              <div className="truncate text-xs text-muted">{'name' in c ? c.name : c.modelId}</div>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <div className={`num text-xl font-semibold ${tone(c.expectedRoi)}`}>{signedPct(c.expectedRoi, 0)}</div>
                  <div className="text-[10px] text-faint">期待収益率</div>
                </div>
                <div className="num text-right text-xs text-muted">
                  <div>{pct(c.probability)} × {odds(c.odds)}</div>
                  <div className="text-faint">{timeOf(c.postTime)} 発走</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Section>
  )
}

function RaceList({ races, sport, selected }: { races: RaceSummary[]; sport: Sport; selected?: string }) {
  const byVenue = new Map<string, RaceSummary[]>()
  for (const r of races) byVenue.set(r.venueName, [...(byVenue.get(r.venueName) ?? []), r])
  return (
    <div className="lg:max-h-[70vh] lg:overflow-y-auto">
      {[...byVenue].map(([venue, rs]) => (
        <div key={venue}>
          <div className="sticky top-0 z-10 flex items-center justify-between bg-surface/95 px-4 py-1.5 text-xs font-semibold text-muted backdrop-blur">
            {venue}{rs[0].dataOrigin === 'sample' && <OriginBadge origin="sample" />}
          </div>
          {rs.map((r) => (
            <Link key={r.id} to={`/${sport}/${r.id}`}
              className={`flex items-center gap-3 border-l-2 px-4 py-2.5 text-sm transition-colors ${
                selected === r.id ? 'border-ink bg-raised' : 'border-transparent hover:bg-raised/50'}`}>
              <span className="num w-8 font-semibold">{r.raceNo}R</span>
              <div className="min-w-0 flex-1">
                <div className="truncate">{r.name ?? `${r.raceNo}レース`}</div>
                <div className="num text-[11px] text-muted">
                  {timeOf(r.postTime)}・{r.entryCount}{sport === 'horse' ? '頭' : '艇'}
                  {r.status !== 'scheduled' && <span className="ml-1.5 text-faint">{t().status[r.status]}</span>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <EdgeBadge edge={r.topEdge} compact />
                <span className={`num text-[11px] ${r.topEdge === 'INSUFFICIENT_DATA' || r.topEdge === 'NEUTRAL' ? 'text-faint' : tone(r.bestExpectedRoi)}`}>{signedPct(r.bestExpectedRoi, 0)}</span>
              </div>
            </Link>
          ))}
        </div>
      ))}
    </div>
  )
}

function RacePanel({ raceId, sport, onChanged, onDate }: { raceId: string; sport: Sport; onChanged: () => void; onDate: (d: string) => void }) {
  const race = useAsync(() => api.race(raceId), [raceId])
  // URL で別日のレースを開いたときは一覧の日付も合わせる
  const raceDate = race.data?.raceDate
  useEffect(() => { if (raceDate) onDate(raceDate) }, [raceDate, onDate])
  const [buying, setBuying] = useState<EntryView | null>(null)
  const [ticketBuying, setTicketBuying] = useState<TicketCandidate | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  if (race.error) return <div className="card"><ErrorState error={race.error} onRetry={race.reload} /></div>
  if (!race.data) return <div className="card"><Loading rows={8} /></div>
  const r = race.data
  const canBuy = r.status === 'scheduled'

  return (
    <div className="space-y-4">
      <Link to={`/${sport}`} className="inline-flex items-center gap-1 text-sm text-muted lg:hidden">‹ レース一覧</Link>
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <OriginBadge origin={r.dataOrigin} />
              <span className="text-xs text-muted">{r.raceDate}・{t().status[r.status]}</span>
            </div>
            <h2 className="mt-1.5 text-lg font-semibold">{r.venueName} {r.raceNo}R <span className="font-normal text-muted">{r.name}</span></h2>
            <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              <span>発走 {timeOf(r.postTime)}</span>
              {r.distance != null && <span>{r.surface ?? ''}{r.distance}m</span>}
              {r.trackCondition && <span>馬場 {r.trackCondition}</span>}
              {r.weather && <span>天候 {r.weather}</span>}
              {r.windSpeed != null && <span>風 {r.windSpeed}m</span>}
              {r.waveHeight != null && <span>波 {r.waveHeight}cm</span>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs">
            <span className="text-muted">モデル</span>
            <span className="font-mono">{r.model ? r.model.id : <span className="text-warn">未学習</span>}</span>
            <span className="text-muted">予測時刻</span><span className="num">{dateTime(r.predictedAt)}</span>
            <span className="text-muted">オッズ鮮度</span>
            <span className={`num ${r.dataFreshnessMinutes == null ? 'text-warn' : r.dataFreshnessMinutes > 60 && r.status === 'scheduled' ? 'text-warn' : ''}`}>{freshness(r.dataFreshnessMinutes)}</span>
          </div>
        </div>
      </div>

      <Section title={sport === 'horse' ? '出走馬・AI予測' : '出走艇・AI予測'} right={<span className="hidden text-xs text-muted sm:inline">縦線＝損益分岐勝率</span>}>
        <EntryTable race={r} sport={sport} canBuy={canBuy} onBuy={setBuying} />
      </Section>

      <Section title="券種別の買い目・期待値" right={<span className="text-xs text-muted">不確実性を差し引いた期待値順</span>}>
        <p className="px-4 pt-3 text-xs text-muted">単勝以外は券種専用モデルと公式オッズが揃った買い目のみ表示します。候補モデルは購入に使用しません。</p>
        {!(r.tickets ?? []).length ? <Empty>組合せ券種の検証済み予測・オッズはまだありません。</Empty> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-sm"><thead><tr className="text-left text-xs text-muted"><th className="p-3">券種・買い目</th><th>的中確率</th><th>取得オッズ</th><th>保守的期待収益率</th><th>鮮度</th><th /></tr></thead><tbody>
            {[...(r.tickets ?? [])].sort((a,b) => b.conservativeRoi-a.conservativeRoi).map(ticket => <tr key={`${ticket.betType}-${ticket.selection}`} className="border-t border-line"><td className="p-3 font-mono">{betTypeLabel[ticket.betType]} {ticket.selection}</td><td>{pct(ticket.probability)}</td><td>{odds(ticket.odds)}</td><td className={tone(ticket.conservativeRoi)}>{signedPct(ticket.conservativeRoi)}</td><td>{freshness(ticket.dataFreshnessMinutes)}</td><td><button className="btn-ghost text-xs" disabled={!canBuy || !ticket.buyEligible} onClick={() => setTicketBuying(ticket)}>仮想購入</button></td></tr>)}
          </tbody></table></div>
        )}
      </Section>

      {ticketBuying && <BetSheet race={r} ticket={ticketBuying} onClose={() => setTicketBuying(null)} onPlaced={() => { setTicketBuying(null); race.reload(); onChanged() }} />}

      {r.payouts.length > 0 && (
        <Section title="払戻金（確定）">
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            {r.payouts.map((p) => (
              <div key={`${p.betType}-${p.selection}`} className="bg-surface px-4 py-2.5">
                <div className="text-[11px] text-muted">{betTypeJa[p.betType] ?? p.betType}</div>
                <div className="num flex justify-between gap-2 whitespace-nowrap text-sm"><span className="font-mono">{p.selection}</span><span>¥{p.payout.toLocaleString()}</span></div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {buying && (
        <BetSheet race={r} entry={buying} onClose={() => setBuying(null)}
          onPlaced={(count) => { setBuying(null); setToast(`${count}件を仮想購入として記録しました`); race.reload(); onChanged(); setTimeout(() => setToast(null), 2500) }} />
      )}
      {toast && <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-sm text-bg shadow-lg lg:bottom-8">{toast}</div>}
    </div>
  )
}

function insufficientReason(e: EntryView) {
  if (e.probability == null) return '予測なし'
  if (e.odds == null) return 'オッズ未取得'
  if (e.probStd != null && e.probStd > 0.05) return '不確実性大'
  return 'モデル未学習'
}

const betTypeJa: Record<string, string> = { win: '単勝', place: '複勝', quinella: '2連複/馬連', exacta: '2連単/馬単', trio: '3連複', trifecta: '3連単', wide: '拡連複/ワイド' }

const boatColors = ['', 'bg-white text-black border border-line', 'bg-black text-white', 'bg-red-600 text-white', 'bg-blue-600 text-white', 'bg-yellow-400 text-black', 'bg-green-600 text-white']

function NumberChip({ sport, n, frame }: { sport: Sport; n: number; frame: number | null }) {
  const cls = sport === 'boat' ? boatColors[n] ?? 'bg-raised' : 'bg-raised text-ink border border-line'
  return (
    <span className={`num inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold ${cls}`} title={frame != null ? `${frame}枠` : undefined}>{n}</span>
  )
}

function EntryTable({ race, sport, canBuy, onBuy }: { race: RaceDetail; sport: Sport; canBuy: boolean; onBuy: (e: EntryView) => void }) {
  const [sortBy, setSortBy] = useState<'number' | 'ev'>('number')
  const rows = [...race.entries].sort((a, b) =>
    sortBy === 'number' ? a.number - b.number : (b.expectedRoi ?? -9) - (a.expectedRoi ?? -9))
  const probSum = race.entries.reduce((s, e) => s + (e.probability ?? 0), 0)

  return (
    <>
      <div className="flex items-center justify-between px-4 pt-3 text-xs">
        <div className="flex gap-1">
          {(['number', 'ev'] as const).map((k) => (
            <button key={k} onClick={() => setSortBy(k)} className={`rounded-md px-2 py-1 ${sortBy === k ? 'bg-raised text-ink' : 'text-muted'}`}>
              {k === 'number' ? (sport === 'horse' ? '馬番順' : '艇番順') : '期待値順'}
            </button>
          ))}
        </div>
        <span className="num text-faint">確率合計 {pct(probSum, 1)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">{sport === 'horse' ? '馬名・騎手' : '選手・級別'}</th>
              <th className="px-2 py-2 font-medium">{sport === 'horse' ? '斤量 / 体重' : '全国勝率 / M2率 / 展示'}</th>
              <th className="px-2 py-2 font-medium">AI勝率</th>
              <th className="px-2 py-2 text-right font-medium">オッズ</th>
              <th className="px-2 py-2 text-right font-medium">分岐</th>
              <th className="px-2 py-2 text-right font-medium">期待収益率</th>
              <th className="px-2 py-2 text-right font-medium">信頼性</th>
              <th className="px-2 py-2 font-medium">判定</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((e) => (
              <tr key={e.number} className={`hover:bg-raised/40 ${e.finishOrder === 1 ? 'bg-pos/5' : ''}`}>
                <td className="px-4 py-2.5"><NumberChip sport={sport} n={e.number} frame={e.frame} /></td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-1.5 whitespace-nowrap font-medium">
                    {e.name}
                    {e.finishOrder != null && <span className={`num rounded px-1 text-[10px] ${e.finishOrder === 1 ? 'bg-pos text-white' : 'bg-raised text-muted'}`}>{e.finishOrder}着</span>}
                  </div>
                  <div className="whitespace-nowrap text-xs text-muted">{sport === 'horse' ? [e.jockey, e.trainer].filter(Boolean).join('・') || '—' : e.racerClass ?? '—'}</div>
                </td>
                <td className="num px-2 py-2.5 text-xs text-muted">
                  {sport === 'horse'
                    ? <>{num(e.weightCarried, 1)}kg / {e.horseWeight ?? '—'}kg</>
                    : <>{num(e.nationalWinRate)} / {num(e.motor2Rate, 1)}% / {num(e.exhibitionTime)}</>}
                </td>
                <td className="px-2 py-2.5"><ProbBar p={e.probability} breakEven={e.breakEvenProb} /></td>
                <td className="num px-2 py-2.5 text-right font-medium">
                  <div>{odds(e.odds)}</div>
                  {e.oddsCapturedAt && <div className="mt-0.5 text-[10px] font-normal text-faint">{freshness(Math.max(0, (Date.now() - Date.parse(e.oddsCapturedAt)) / 60000))}</div>}
                </td>
                <td className="num px-2 py-2.5 text-right text-muted">{pct(e.breakEvenProb)}</td>
                <td className={`num px-2 py-2.5 text-right font-semibold ${tone(e.expectedRoi)}`}>{signedPct(e.expectedRoi)}</td>
                <td className="num px-2 py-2.5 text-right text-xs text-muted" title="予測確率の標準偏差（小さいほど安定）">
                  {e.probStd == null ? '—' : `±${(e.probStd * 100).toFixed(1)}pt`}
                </td>
                <td className="px-2 py-2.5">
                  <EdgeBadge edge={e.edge} compact />
                  {e.edge === 'INSUFFICIENT_DATA' && <div className="mt-0.5 whitespace-nowrap text-[10px] text-faint">{insufficientReason(e)}</div>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button className="btn-ghost h-7 px-2.5 text-xs" disabled={!canBuy || e.odds == null} onClick={() => onBuy(e)}
                    title={!canBuy ? '発走前のレースのみ購入できます' : e.odds == null ? 'オッズ欠損' : undefined}>
                    購入
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
