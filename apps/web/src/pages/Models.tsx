import { useState } from 'react'
import type { ModelInfo, Sport } from '@edgelab/shared/src/types'
import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, num, pct, signedPct } from '../lib/format'
import { t } from '../i18n'
import { Empty, ErrorState, Loading, OriginBadge, Section, SportIcon } from '../components/ui'
import { isSampleModel, promotionAvailability } from '../lib/models'

const statusStyle = {
  active: 'bg-pos/10 text-pos border-pos/40', candidate: 'bg-accent/10 text-accent border-accent/40',
  untrained: 'text-warn border-warn/50 border-dashed', retired: 'text-faint border-line',
} as const

export function ModelsPage() {
  const q = useAsync(() => api.models(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function act(kind: 'promote' | 'rollback', m: ModelInfo) {
    const text = kind === 'promote' ? `${m.id} を稼働モデルに昇格しますか？現在の稼働モデルは退役します。` : `${m.sport === 'horse' ? '競馬' : 'ボート'}の稼働モデルを直前のモデルに戻しますか？`
    if (!window.confirm(text)) return
    setBusy(m.id); setMsg(null)
    try { await (kind === 'promote' ? api.promote(m.id) : api.rollback(m.id)); q.reload() }
    catch (e) { setMsg((e as Error).message) }
    finally { setBusy(null) }
  }

  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><Loading rows={5} /></div>

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">モデル管理</h1>
        <p className="mt-1 text-sm text-muted">モデルは競技ごとに独立。自動昇格は無効で、Log Loss・Brier・校正が改善した候補だけを手動で昇格します。</p>
      </div>
      {msg && <div className="rounded-lg border border-neg/40 bg-neg/10 px-3 py-2 text-sm text-neg">{msg}</div>}
      {(['horse', 'boat'] as Sport[]).map((s) => {
        const ms = q.data!.filter((m) => m.sport === s).sort((a, b) => (b.trainedAt ?? '').localeCompare(a.trainedAt ?? ''))
        const active = ms.find((m) => m.status === 'active')
        return (
          <Section key={s}
            title={<span className={`flex items-center gap-2 ${s === 'horse' ? 'text-horse' : 'text-boat'}`}><SportIcon sport={s} />{t().sport[s]}</span>}
            right={active && ms.some((m) => m.status === 'retired') ? (
              <button className="btn-ghost h-7 text-xs" disabled={busy != null} onClick={() => act('rollback', active)}>ロールバック</button>
            ) : undefined}>
            {ms.length === 0 ? <Empty>モデルがありません（未学習）。ml/ で学習を実行してください。</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[880px] text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                    <th className="px-4 py-2 font-medium">モデル</th><th className="px-2 py-2 font-medium">状態</th>
                    <th className="px-2 py-2 font-medium">学習期間 / テスト期間</th>
                    <th className="px-2 py-2 text-right font-medium" title="レース単位の多クラス Log Loss（勝者の −log p の平均）">Log Loss</th><th className="px-2 py-2 text-right font-medium">Brier</th>
                    <th className="px-2 py-2 text-right font-medium">ECE</th><th className="px-2 py-2 text-right font-medium">回収率</th>
                    <th className="px-2 py-2 text-right font-medium">最大DD</th><th className="px-2 py-2 font-medium">学習日時</th><th className="px-4 py-2" />
                  </tr></thead>
                  <tbody className="divide-y divide-line">
                    {ms.map((m) => {
                      // 同じデータ（サンプル同士・実データ同士）のモデルだけを比較する
                      const sameOrigin = active != null && isSampleModel(active) === isSampleModel(m)
                      const promotion = promotionAvailability(m.metrics)
                      const better = (k: 'logLoss' | 'brier' | 'ece') => active && sameOrigin && m.id !== active.id && m.metrics[k] != null && active.metrics[k] != null
                        ? (m.metrics[k]! < active.metrics[k]! ? 'text-pos' : 'text-neg') : ''
                      return (
                        <tr key={m.id} className={m.status === 'retired' ? 'opacity-60' : ''}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs">{m.id}{isSampleModel(m) && <OriginBadge origin="sample" />}</div>
                            <div className="max-w-[240px] text-[11px] text-muted">{m.algorithm}・{/^\d/.test(m.version) ? `v${m.version}` : m.version}{m.nTrain != null && `・n=${m.nTrain.toLocaleString()}`}</div>
                          </td>
                          <td className="px-2 py-2.5"><span className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${statusStyle[m.status]}`}>{t().modelStatus[m.status]}</span></td>
                          <td className="num whitespace-nowrap px-2 py-2.5 text-xs text-muted">
                            <div>{m.trainFrom ?? '—'} 〜 {m.trainTo ?? '—'}</div>
                            <div className="text-faint">test {m.testFrom ?? '—'} 〜 {m.testTo ?? '—'}</div>
                          </td>
                          <td className={`num px-2 py-2.5 text-right ${better('logLoss')}`}>{num(m.metrics.logLoss, 4)}
                            {m.metrics.baselineLogLoss != null && <div className="text-[10px] text-faint">基準 {num(m.metrics.baselineLogLoss, 4)}</div>}</td>
                          <td className={`num px-2 py-2.5 text-right ${better('brier')}`}>{num(m.metrics.brier, 4)}</td>
                          <td className={`num px-2 py-2.5 text-right ${better('ece')}`}>{num(m.metrics.ece, 4)}</td>
                          <td className="num px-2 py-2.5 text-right">{pct(m.metrics.roi)}
                            {m.metrics.expectedRoi != null && <div className="text-[10px] text-faint">期待 {signedPct(m.metrics.expectedRoi)}</div>}</td>
                          <td className="num px-2 py-2.5 text-right">{pct(m.metrics.maxDrawdown)}</td>
                          <td className="num px-2 py-2.5 text-xs text-muted">{dateTime(m.trainedAt)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {m.status === 'candidate' && (
                              <div className="flex flex-col items-end gap-1">
                                <button className="btn-primary h-7 px-2.5 text-xs" disabled={busy != null || !promotion.enabled}
                                  title={promotion.reason ?? undefined} onClick={() => act('promote', m)}>昇格</button>
                                {!promotion.enabled && <span className="max-w-[220px] text-right text-[10px] text-muted">{promotion.reason}</span>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {ms.some((m) => m.notes) && (
                  <ul className="space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
                    {ms.filter((m) => m.notes).map((m) => <li key={m.id}><span className="font-mono text-ink">{m.id}</span>：{m.notes}</li>)}
                  </ul>
                )}
              </div>
            )}
          </Section>
        )
      })}
    </div>
  )
}
