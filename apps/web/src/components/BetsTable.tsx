import type { Bet } from '@edgelab/shared/src/types'
import { t } from '../i18n'
import { betTypeLabel } from '../lib/betType'
import { dateTime, odds, pct, signedPct, signedYen, tone, yen } from '../lib/format'
import { EdgeBadge, Empty, OriginBadge, SportDot } from './ui'

const statusStyle = { open: 'text-muted', won: 'text-pos', lost: 'text-faint', void: 'text-warn' } as const

export function BetsTable({ bets, limit }: { bets: Bet[]; limit?: number }) {
  const rows = limit ? bets.slice(0, limit) : bets
  if (!rows.length) return <Empty>仮想購入はまだありません。レース画面から購入できます。</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
            <th className="px-4 py-2 font-medium">購入</th>
            <th className="px-2 py-2 font-medium">レース</th>
            <th className="px-2 py-2 font-medium">買い目</th>
            <th className="px-2 py-2 text-right font-medium">予測</th>
            <th className="px-2 py-2 text-right font-medium">取得オッズ / 払戻換算</th>
            <th className="px-2 py-2 text-right font-medium">期待収益率</th>
            <th className="px-2 py-2 font-medium">判定</th>
            <th className="px-2 py-2 text-right font-medium">金額</th>
            <th className="px-4 py-2 text-right font-medium">損益</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((b) => {
            const drift = b.oddsAtBet != null && b.finalOdds != null ? b.finalOdds - b.oddsAtBet : null
            return (
              <tr key={b.id} className="hover:bg-raised/50">
                <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">
                  {dateTime(b.placedAt)}
                  <span className="ml-1.5 rounded bg-raised px-1 text-[10px]">{b.mode === 'auto' ? 'AUTO' : '手動'}</span>
                </td>
                <td className="whitespace-nowrap px-2 py-2.5">
                  <div className="flex items-center gap-1.5"><SportDot sport={b.sport} />{b.venueName ?? b.raceId}{b.raceNo != null && <span className="text-muted">{b.raceNo}R</span>}</div>
                </td>
                <td className="px-2 py-2.5"><span className="whitespace-nowrap font-mono text-xs">{betTypeLabel[b.betType]} {b.selection}</span></td>
                <td className="num px-2 py-2.5 text-right">{pct(b.predictedProb)}</td>
                <td className="num whitespace-nowrap px-2 py-2.5 text-right">
                  <div>
                    {odds(b.oddsAtBet)}<span className="text-faint"> / </span>
                    <span className={drift == null ? 'text-faint' : drift < 0 ? 'text-neg' : 'text-ink'}>{odds(b.finalOdds)}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-faint">{b.oddsCapturedAt ? `取得 ${dateTime(b.oddsCapturedAt)}` : '取得時刻不明'}</div>
                </td>
                <td className={`num px-2 py-2.5 text-right ${tone(b.expectedRoi)}`}>{signedPct(b.expectedRoi)}</td>
                <td className="px-2 py-2.5"><div className="flex gap-1"><EdgeBadge edge={b.edgeLabel} compact />{b.dataOrigin === 'sample' && <OriginBadge origin="sample" />}</div></td>
                <td className="num px-2 py-2.5 text-right">{yen(b.stake)}</td>
                <td className="num whitespace-nowrap px-4 py-2.5 text-right">
                  <span className={`mr-2 text-xs ${statusStyle[b.status]}`}>{t().betStatus[b.status]}</span>
                  <span className={tone(b.profit)}>{b.profit == null ? '—' : signedYen(b.profit)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
