import { Fragment, useState } from 'react'
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
const safeBoatRuntime = (m: ModelInfo) => m.sport !== 'boat' ||
  (m.metrics.boatFeatureSchemaVersion === 'boat-base-v1' && /^[a-f0-9]{64}$/.test(m.metrics.boatArtifactSha256 ?? ''))
const showCI = (ci: number[] | null | undefined) => ci?.length === 2 ? `[${num(ci[0], 4)}, ${num(ci[1], 4)}]` : '未取得'

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

  async function approveInitialBaseline(m: ModelInfo) {
    const validation = m.metrics.initialBaselineValidation
    const fingerprint = validation?.fingerprint
    if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) return
    const text = [
      `モデル ${m.id} を「初期の仮想基準」として手動承認しますか？`,
      '',
      'これは新規のボート仮想予測を有効にする運用切替です。正のEV・利益を証明するものではなく、実購入も行いません。',
      'Bデータの available_at は公開時刻ではなくレース日午前0時を仮定し、履歴特徴量は使用・観測していません。',
      '未検証の旧モデルによる新規予測・EV表示は引き続き停止し、既存の未決済ベットは精算のみ継続します。',
      '',
      `検証 fingerprint: ${fingerprint}`,
    ].join('\n')
    if (!window.confirm(text)) return
    setBusy(m.id); setMsg(null)
    try { await api.promoteInitialBaseline(m.id, fingerprint); q.reload() }
    catch (e) { setMsg((e as Error).message) }
    finally { setBusy(null) }
  }

  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><Loading rows={5} /></div>

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">モデル管理</h1>
        <p className="mt-1 text-sm text-muted">モデルは競技ごとに独立し、自動昇格は無効です。通常昇格と、証拠を確認した初期の仮想基準承認は別の手動操作です。初期基準は利益・正のEVの証明ではありません。</p>
      </div>
      {msg && <div className="rounded-lg border border-neg/40 bg-neg/10 px-3 py-2 text-sm text-neg">{msg}</div>}
      {(['horse', 'boat'] as Sport[]).map((s) => {
        const ms = q.data!.filter((m) => m.sport === s).sort((a, b) => (b.trainedAt ?? '').localeCompare(a.trainedAt ?? ''))
        const active = ms.find((m) => m.status === 'active')
        const safeRetired = ms.some((m) => m.status === 'retired' && safeBoatRuntime(m))
        return (
          <Section key={s}
            title={<span className={`flex items-center gap-2 ${s === 'horse' ? 'text-horse' : 'text-boat'}`}><SportIcon sport={s} />{t().sport[s]}</span>}
            right={active && safeRetired ? (
              <button className="btn-ghost h-7 text-xs" disabled={busy != null || !safeBoatRuntime(active)} onClick={() => act('rollback', active)}>ロールバック</button>
            ) : undefined}>
            {s === 'boat' && active && !safeBoatRuntime(active) && <div className="mb-3 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">旧スキーマの稼働モデルです。新規ボート予測・EV表示は安全なモデルが手動承認されるまで停止します。既存の未決済ベットは精算のみ継続します。</div>}
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
                      const runtimeSafe = safeBoatRuntime(m)
                      const regularPromotionEnabled = promotion.enabled && (m.sport !== 'boat' || m.metrics.promotionEligible === true)
                      const regularPromotionReason = !promotion.enabled ? promotion.reason : m.sport === 'boat' && m.metrics.promotionEligible !== true ? 'ボートの通常昇格には同一ホールドアウトの昇格適格性が必要です。初期基準とは別の経路です。' : null
                      const baseline = m.metrics.initialBaselineValidation
                      const baselineFingerprint = baseline?.fingerprint
                      const baselineCanApprove = m.sport === 'boat' && m.status === 'candidate' &&
                        m.metrics.initialBaselineEligible === true && baseline?.initialBaselineEligible === true &&
                        !!baseline.checks && Object.keys(baseline.checks).length > 0 && Object.values(baseline.checks).every((value) => value === true) &&
                        runtimeSafe && !!baselineFingerprint && /^[a-f0-9]{64}$/.test(baselineFingerprint)
                      const better = (k: 'logLoss' | 'brier' | 'ece') => active && sameOrigin && m.id !== active.id && m.metrics[k] != null && active.metrics[k] != null
                        ? (m.metrics[k]! < active.metrics[k]! ? 'text-pos' : 'text-neg') : ''
                      return (
                        <Fragment key={m.id}>
                        <tr key={m.id} className={m.status === 'retired' ? 'opacity-60' : ''}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs">{m.id}{isSampleModel(m) && <OriginBadge origin="sample" />}</div>
                            <div className="max-w-[240px] text-[11px] text-muted">{m.algorithm}・{/^\d/.test(m.version) ? `v${m.version}` : m.version}{m.nTrain != null && `・n=${m.nTrain.toLocaleString()}`}</div>
                          </td>
                          <td className="px-2 py-2.5"><span className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${statusStyle[m.status]}`}>{m.sport === 'boat' && m.status === 'active' && !runtimeSafe ? '稼働中・新規停止' : m.sport === 'boat' && m.status === 'candidate' && m.metrics.promotionEligible === false ? '評価用候補' : t().modelStatus[m.status]}</span></td>
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
                                <button className="btn-primary h-7 px-2.5 text-xs" disabled={busy != null || !regularPromotionEnabled || !runtimeSafe}
                                  title={regularPromotionReason ?? undefined} onClick={() => act('promote', m)}>昇格</button>
                                {!regularPromotionEnabled && <span className="max-w-[220px] text-right text-[10px] text-muted">{regularPromotionReason}</span>}
                                {!runtimeSafe && <span className="max-w-[220px] text-right text-[10px] text-warn">検証済みボートスキーマがありません</span>}
                                {baselineCanApprove && <button className="btn-ghost h-7 border border-warn/50 px-2.5 text-xs text-warn" disabled={busy != null} onClick={() => approveInitialBaseline(m)}>初期仮想基準として承認</button>}
                              </div>
                            )}
                          </td>
                        </tr>
                        {baseline && <tr key={`${m.id}-baseline`}><td colSpan={10} className="px-4 pb-3">
                          <details className="rounded-lg border border-line bg-panel/40 px-3 py-2 text-xs">
                            <summary className="cursor-pointer font-medium text-ink">初期基準の検証証拠{m.metrics.initialBaselineEligible ? '・レビュー条件通過' : '・承認不可'}</summary>
                            <div className="mt-2 space-y-2 text-muted">
                              <p>検証日時 {dateTime(baseline.validatedAt)} ・ fingerprint <span className="break-all font-mono">{baselineFingerprint}</span></p>
                              <p>対象 {baseline.cohort?.raceCount ?? '—'} races / {baseline.cohort?.dayCount ?? '—'} days（{baseline.cohort?.from ?? '—'} 〜 {baseline.cohort?.to ?? '—'}）・artifact {baseline.artifact?.version ?? '—'}</p>
                              <p>時系列分割: train {baseline.temporal?.trainFrom ?? '—'} 〜 {baseline.temporal?.trainTo ?? '—'}（{baseline.temporal?.trainRaceCount ?? '—'} races） → validation {baseline.temporal?.validFrom ?? '—'} 〜 {baseline.temporal?.validTo ?? '—'}（{baseline.temporal?.validRaceCount ?? '—'} races） → holdout {baseline.temporal?.testFrom ?? '—'} 〜 {baseline.temporal?.testTo ?? '—'}（{baseline.temporal?.testRaceCount ?? '—'} races）</p>
                              {(() => { const checks = Object.entries(baseline.checks ?? {}); const passed = checks.filter(([, value]) => value === true).length; const failed = checks.filter(([, value]) => value !== true).map(([name]) => name); return <p>検証ゲート: {checks.length ? `${passed}/${checks.length} pass${failed.length ? `・未通過: ${failed.join(', ')}` : '・全項目通過'}` : '未取得（検証証拠が不完全）'}</p> })()}
                              <p>表の指標は学習時の単一モデル、ここは運用時のアンサンブル検証です。</p>
                              <p>運用時のアンサンブル確率（候補）Log Loss / Brier / ECE: {num(baseline.candidateMetrics?.logLoss, 4)} / {num(baseline.candidateMetrics?.brier, 4)} / {num(baseline.candidateMetrics?.ece, 4)}（n={baseline.candidateMetrics?.nRaces ?? '—'} races）</p>
                              <p>レーン基準 Log Loss / Brier / ECE: {num(baseline.laneBaselineMetrics?.logLoss, 4)} / {num(baseline.laneBaselineMetrics?.brier, 4)} / {num(baseline.laneBaselineMetrics?.ece, 4)}（n={baseline.laneBaselineMetrics?.nRaces ?? '—'} races）</p>
                              <p>レース単位 paired 95% CI: Log Loss {showCI(baseline.pairedComparison?.logLossCI95)} / Brier {showCI(baseline.pairedComparison?.brierCI95)} ・日付クラスタ CI: Log Loss {showCI(baseline.pairedComparison?.dateClusterLogLossCI95)} / Brier {showCI(baseline.pairedComparison?.dateClusterBrierCI95)}</p>
                              <p>source availability: Bの available_at は実測公開時刻でなくレース日午前0時の仮定。履歴特徴量は観測・使用していません。</p>
                              <p>利益 evidence: {baseline.profitability?.status ?? '未取得'}。これは retrospective / virtual-only の評価であり、実際の利益や正のEVの証明ではありません。</p>
                              {m.metrics.initialBaselineEligible !== true && <p className="text-warn">初期基準承認不可: {m.metrics.initialBaselineReason ?? '検証条件を満たしていません。'}</p>}
                              {!!baseline.limitations?.length && <ul className="list-disc pl-5">{baseline.limitations.map((x) => <li key={x}>{x}</li>)}</ul>}
                            </div>
                          </details>
                        </td></tr>}
                        </Fragment>
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
