import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, pct, signedYen, yen } from '../lib/format'
import { Empty, ErrorState, Loading, Section } from './ui'

const statusLabel = { open: '精算待ち', won: '的中', lost: '不的中', void: '無効（返金）' } as const

/** Ticket-level records from the isolated experimental ledger; never included in normal bets or metrics. */
export function ExperimentalBetsHistory({ compact = false }: { compact?: boolean }) {
  const q = useAsync(() => api.experimentalBets(), [])
  if (q.error) return <Section title="実験購入履歴（別台帳）"><div className="p-4"><ErrorState error={q.error} onRetry={q.reload} /></div></Section>
  if (!q.data) return <Section title="実験購入履歴（別台帳）"><div className="p-4"><Loading rows={compact ? 1 : 3} /></div></Section>
  const bets = q.data

  return <Section title="実験購入履歴（別台帳）" right={<span className="text-xs text-muted">実験・通常成績に含まず</span>}>
    <div className="p-4">
      <p className="mb-3 text-xs text-muted">実験専用の仮想購入です。通常の購入履歴・残高・成績とは別に表示しています。確定オッズは的中券の公式払戻から換算し、不的中券は未取得です。</p>
      {!bets.length ? <Empty>実験購入はまだありません。</Empty> : <div className="space-y-2">
        {bets.map((bet) => <article key={bet.id} className="rounded-lg border border-line bg-raised/30 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <Link to={`/boat/${encodeURIComponent(bet.raceId)}`} className="font-medium hover:text-accent">
                {bet.raceDate} · {bet.venueName ?? bet.raceId} {bet.raceNo}R
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="rounded bg-surface px-1.5 py-0.5">実験</span>
                <span>三連単 {bet.selection}</span>
                <span>{dateTime(bet.placedAt)}</span>
              </div>
            </div>
            <span className={`text-xs ${bet.status === 'won' ? 'text-pos' : bet.status === 'lost' ? 'text-neg' : 'text-muted'}`}>{statusLabel[bet.status]}</span>
          </div>
          {bet.status === 'void' && <p className="mt-2 text-xs text-muted">返金済み{bet.repairReason ? ` · ${repairReasonLabel(bet.repairReason)}` : ''}</p>}
          <p className="mt-2 text-xs text-muted">公式結果 {bet.officialSelection ? `三連単 ${bet.officialSelection}` : '未取得'}</p>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-5">
            <Metric label={bet.status === 'void' ? '無効化した旧記録額' : '購入額'} value={yen(bet.stake)} />
            <Metric label="購入時オッズ" value={bet.oddsAtBet == null ? '—' : bet.oddsAtBet.toFixed(2)} />
            <Metric label="確定オッズ（払戻換算）" value={bet.status === 'void' ? '対象外（無効）' : bet.finalOdds == null ? bet.status === 'open' ? '精算待ち' : '未取得' : bet.finalOdds.toFixed(2)} />
            <Metric label="確率 / 期待ROI" value={`${pct(bet.predictedProb)} / ${pct(bet.expectedRoi)}`} />
            <Metric label="払戻 / 損益" value={`${bet.payout == null ? '—' : yen(bet.payout)} / ${bet.profit == null ? '—' : signedYen(bet.profit)}`} />
          </div>
          {!compact && <div className="mt-2 text-[10px] text-faint">{bet.modelId} · {bet.experimentKey} · 実データ</div>}
        </article>)}
      </div>}
    </div>
  </Section>
}

function repairReasonLabel(reason: string) {
  if (reason === 'invalid_stake_unit') return '購入額が100円単位の条件を満たさないため'
  return '旧記録の購入条件を満たさないため'
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[10px] text-muted">{label}</div><div className="num mt-0.5 font-medium">{value}</div></div>
}
