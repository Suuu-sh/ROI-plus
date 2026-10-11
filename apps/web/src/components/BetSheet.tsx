import { useState } from 'react'
import type { EntryView, RaceDetail, TicketCandidate } from '@edgelab/shared/src/types'
import { api, ApiError } from '../lib/api'
import { dateTime, odds, pct, signedPct, signedYen, tone, yen } from '../lib/format'
import { EdgeBadge } from './ui'
import { betTypeLabel } from '../lib/betType'

const UNIT = 100

export function BetSheet({ race, entry, ticket, onClose, onPlaced }: {
  race: RaceDetail; entry?: EntryView; ticket?: TicketCandidate; onClose: () => void; onPlaced: () => void
}) {
  const [units, setUnits] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const choice = ticket ?? entry
  if (!choice) return null
  const betType = ticket?.betType ?? 'win'
  const selection = ticket?.selection ?? String(entry?.number)
  const title = ticket ? selection : `${entry?.number}番 ${entry?.name}`
  const oddsCapturedAt = ticket?.oddsCapturedAt ?? entry?.oddsCapturedAt ?? null
  const stake = units * UNIT
  const expReturn = choice.probability != null && choice.odds != null ? stake * choice.probability * choice.odds : null
  const risky = choice.edge === 'INSUFFICIENT_DATA' || choice.edge === 'NEGATIVE_EDGE'

  async function submit() {
    setBusy(true); setErr(null)
    try {
      await api.placeBet({ raceId: race.id, betType, selection, stake })
      onPlaced()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '購入に失敗しました')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="仮想購入"
        className="w-full max-w-md rounded-t-2xl border border-line bg-surface p-5 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="label">仮想購入・{betTypeLabel[betType]}</div>
            <div className="mt-1 text-lg font-semibold">{title}</div>
            <div className="text-xs text-muted">{race.venueName} {race.raceNo}R</div>
          </div>
          <EdgeBadge edge={choice.edge} />
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 rounded-xl bg-raised p-3 text-sm">
          <div><dt className="text-[11px] text-muted">AI予測的中確率</dt><dd className="num font-semibold">{pct(choice.probability)}</dd></div>
          <div>
            <dt className="text-[11px] text-muted">取得オッズ</dt>
            <dd className="num font-semibold">{odds(choice.odds)}</dd>
            <dd className="mt-0.5 text-[10px] text-faint">{oddsCapturedAt ? `${dateTime(oddsCapturedAt)} 取得` : '取得時刻不明'}</dd>
          </div>
          <div><dt className="text-[11px] text-muted">期待収益率</dt><dd className={`num font-semibold ${tone(choice.expectedRoi)}`}>{signedPct(choice.expectedRoi)}</dd></div>
        </dl>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-muted">金額</span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost h-9 w-9 px-0" onClick={() => setUnits((u) => Math.max(1, u - 1))} aria-label="減らす">−</button>
            <span className="num w-20 text-center text-lg font-semibold">{yen(stake)}</span>
            <button className="btn-ghost h-9 w-9 px-0" onClick={() => setUnits((u) => Math.min(100, u + 1))} aria-label="増やす">＋</button>
          </div>
        </div>
        <div className="mt-2 flex justify-end gap-1.5">
          {[1, 5, 10].map((n) => (
            <button key={n} onClick={() => setUnits(n)} className={`rounded-md border px-2 py-0.5 text-xs ${units === n ? 'border-ink text-ink' : 'border-line text-muted'}`}>{yen(n * UNIT)}</button>
          ))}
        </div>
        <div className="mt-3 text-right text-xs text-muted">
          期待払戻 <span className="num text-ink">{yen(expReturn)}</span>
          {expReturn != null && <span className={`num ml-1 ${tone(expReturn - stake)}`}>({signedYen(expReturn - stake)})</span>}
        </div>

        {risky && (
          <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            この買い目は購入候補外（{choice.edge === 'INSUFFICIENT_DATA' ? 'データ不足または不確実性が大きい' : '期待値マイナス'}）です。検証目的の手動購入として記録されます。
          </p>
        )}
        {err && <p className="mt-3 text-sm text-neg">{err}</p>}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button className="btn-ghost" onClick={onClose}>キャンセル</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !!ticket && !ticket.buyEligible}>{busy ? '記録中…' : '仮想購入する'}</button>
        </div>
        <p className="mt-3 text-center text-[11px] text-faint">実際のお金は使われません。オッズの取得時刻と購入時刻は異なる場合があります。</p>
      </div>
    </div>
  )
}
