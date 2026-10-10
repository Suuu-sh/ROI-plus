import { useEffect, useMemo, useState } from 'react'
import type { EntryView, RaceDetail } from '@edgelab/shared/src/types'
import { api, ApiError } from '../lib/api'
import { odds, pct, signedPct, tone, yen } from '../lib/format'
import { EdgeBadge } from './ui'

const MAX_SELECTIONS = 6
const MAX_STAKE = 2_147_483_647

export function BetSheet({ race, entry, onClose, onPlaced }: {
  race: RaceDetail; entry: EntryView; onClose: () => void; onPlaced: (count: number) => void
}) {
  const [selected, setSelected] = useState<number[]>([entry.number])
  const [stakes, setStakes] = useState<Record<number, string>>({ [entry.number]: '100' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [bankroll, setBankroll] = useState<number | null>(null)
  const [fundsLoading, setFundsLoading] = useState(true)
  const [requestId, setRequestId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setFundsLoading(true)
    // The backend bankroll guard is global across sample and real-origin virtual bets.
    Promise.all([api.overview('all'), api.bets('all')])
      .then(([overview, bets]) => {
        const settledProfit = bets.reduce((sum, bet) => sum + (bet.status === 'won' || bet.status === 'lost' || bet.status === 'void' ? bet.profit ?? 0 : 0), 0)
        const openStake = bets.reduce((sum, bet) => sum + (bet.status === 'open' ? bet.stake : 0), 0)
        if (alive) setBankroll(overview.initialBankroll + settledProfit - openStake)
      })
      .catch((e) => { if (alive) setErr(e instanceof ApiError ? e.message : '仮想資金を取得できませんでした') })
      .finally(() => { if (alive) setFundsLoading(false) })
    return () => { alive = false }
  }, [race.dataOrigin])

  const picked = useMemo(() => race.entries.filter((e) => selected.includes(e.number)), [race.entries, selected])
  const parsedStakes = picked.map((e) => Number(stakes[e.number] ?? ''))
  const validStakes = parsedStakes.every((amount) => Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_STAKE)
  const totalStake = validStakes ? parsedStakes.reduce((sum, amount) => sum + amount, 0) : 0
  const fundsOk = bankroll != null && totalStake <= bankroll
  const canSubmit = !busy && !fundsLoading && bankroll != null && picked.length > 0 && picked.length <= MAX_SELECTIONS && validStakes && fundsOk

  function editSelection(number: number, checked: boolean) {
    if (busy) return
    setErr(null); setRequestId(null)
    setSelected((current) => checked
      ? current.length < MAX_SELECTIONS ? [...current, number] : current
      : current.filter((n) => n !== number))
    if (checked) setStakes((current) => ({ ...current, [number]: current[number] ?? '100' }))
  }

  async function submit() {
    if (!canSubmit) return
    setBusy(true); setErr(null)
    const id = requestId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    setRequestId(id)
    try {
      const result = await api.placeBetBatch({
        raceId: race.id, betType: 'win', requestId: id,
        selections: picked.map((e) => ({ selection: String(e.number), stake: Number(stakes[e.number]) })),
      })
      onPlaced(result.bets.length)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '仮想購入に失敗しました')
    } finally { setBusy(false) }
  }

  function close() { if (!busy) onClose() }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={(event) => { if (event.target === event.currentTarget) close() }}>
      <div role="dialog" aria-modal="true" aria-label="仮想購入の組み立て" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-line bg-surface p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="label">仮想購入・単勝</div>
            <div className="mt-1 text-lg font-semibold">{race.venueName} {race.raceNo}R</div>
            <p className="mt-1 text-xs text-muted">候補を最大{MAX_SELECTIONS}件選び、各金額を円単位で指定します。候補順位は購入時点のサーバー判定で記録します。</p>
          </div>
          <button className="btn-ghost h-8 px-3 text-sm" onClick={close} disabled={busy}>閉じる</button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[540px] text-sm">
            <thead><tr className="bg-raised text-left text-[11px] text-muted"><th className="px-3 py-2">選択</th><th className="px-2 py-2">候補</th><th className="px-2 py-2 text-right">AI勝率</th><th className="px-2 py-2 text-right">オッズ</th><th className="px-2 py-2 text-right">期待収益率</th><th className="px-3 py-2 text-right">金額（円）</th></tr></thead>
            <tbody className="divide-y divide-line">
              {race.entries.slice().sort((a, b) => a.number - b.number).map((e) => {
                const checked = selected.includes(e.number)
                return <tr key={e.number} className={checked ? 'bg-raised/50' : ''}>
                  <td className="px-3 py-2"><input aria-label={`${e.number}番を選択`} type="checkbox" checked={checked} disabled={busy || (!checked && selected.length >= MAX_SELECTIONS) || e.odds == null} onChange={(event) => editSelection(e.number, event.target.checked)} /></td>
                  <td className="px-2 py-2"><div className="font-medium">{e.number}番 {e.name}</div><div className="mt-0.5"><EdgeBadge edge={e.edge} compact /></div></td>
                  <td className="num px-2 py-2 text-right">{pct(e.probability)}</td>
                  <td className="num px-2 py-2 text-right">{odds(e.odds)}</td>
                  <td className={`num px-2 py-2 text-right ${tone(e.expectedRoi)}`}>{signedPct(e.expectedRoi)}</td>
                  <td className="px-3 py-2 text-right"><input aria-label={`${e.number}番の金額`} type="number" inputMode="numeric" min="1" max={MAX_STAKE} step="1" value={stakes[e.number] ?? '100'} disabled={!checked || busy} onChange={(event) => { setErr(null); setRequestId(null); setStakes((current) => ({ ...current, [e.number]: event.target.value })) }} className="focus-ring num w-28 rounded-md border border-line bg-bg px-2 py-1.5 text-right disabled:opacity-40" /></td>
                </tr>
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-raised p-3 text-sm sm:grid-cols-4">
          <div><div className="text-[11px] text-muted">選択件数</div><div className="num font-semibold">{picked.length} / {MAX_SELECTIONS}</div></div>
          <div><div className="text-[11px] text-muted">購入合計</div><div className="num font-semibold">{yen(totalStake)}</div></div>
          <div><div className="text-[11px] text-muted">利用可能な仮想資金（共通）</div><div className="num font-semibold">{fundsLoading ? '確認中…' : bankroll == null ? '—' : yen(bankroll)}</div></div>
          <div><div className="text-[11px] text-muted">購入後の仮想資金</div><div className={`num font-semibold ${fundsOk ? '' : 'text-neg'}`}>{bankroll == null || !validStakes ? '—' : yen(bankroll - totalStake)}</div></div>
        </div>
        {!fundsLoading && bankroll == null && <p className="mt-2 text-xs text-warn">仮想資金を確認できないため購入を止めています。</p>}
        {picked.length > 0 && !validStakes && <p className="mt-2 text-xs text-neg">各金額は1円以上の整数で入力してください。</p>}
        {validStakes && bankroll != null && !fundsOk && <p className="mt-2 text-xs text-neg">合計が利用可能な仮想資金を超えています。</p>}
        {picked.some((e) => e.edge === 'INSUFFICIENT_DATA' || e.edge === 'NEGATIVE_EDGE') && <p className="mt-2 text-xs text-warn">購入候補外の買い目も検証目的で記録できます。候補順位・比較対象にならない場合があります。</p>}
        {err && <p className="mt-2 text-sm text-neg">{err}</p>}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button className="btn-ghost" onClick={close} disabled={busy}>キャンセル</button>
          <button className="btn-primary" onClick={submit} disabled={!canSubmit}>{busy ? '記録中…' : `${picked.length}件を仮想購入`}</button>
        </div>
        <p className="mt-3 text-center text-[11px] text-faint">仮想購入のみです。払戻は公式の100円あたり払戻を賭け額に比例換算し、1円未満を切り捨てます。候補順位はサーバーが購入時点の有効候補から記録します。この画面から自動購入設定は変更しません。</p>
      </div>
    </div>
  )
}
