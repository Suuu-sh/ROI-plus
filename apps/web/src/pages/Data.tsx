import { api } from '../lib/api'
import { useAsync } from '../lib/useAsync'
import { dateTime, freshness, pct } from '../lib/format'
import { Empty, ErrorState, Kpi, Loading, Section, SportDot } from '../components/ui'

export function DataPage() {
  const q = useAsync(() => api.collection(), [])
  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><Loading rows={5} /></div>
  const d = q.data
  const exclusions = d.qualityExclusions ?? []
  const total = Object.values(d.tableCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">データ収集</h1>
          <p className="mt-1 text-sm text-muted">利用規約で許可された無料ソースのみ。取得できない値は欠損として扱い、補完しません。</p>
        </div>
        <button className="btn-ghost h-8 text-xs" onClick={q.reload}>更新</button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="データソース" value={d.sources.length} sub={`有効 ${d.sources.filter((s) => s.enabled).length}`} />
        <Kpi label="総レコード数" value={total.toLocaleString()} sub="D1 全テーブル" />
        <Kpi label="通信・解析等のエラー（直近）" value={d.errors.length} valueClass={d.errors.length ? 'text-neg' : ''} />
        <Kpi label="D1 使用量（概算）" value={`${d.freeTier.d1RowsApprox.toLocaleString()} 行`} sub="無料枠内" />
      </div>

      <Section title="取得状況">
        {d.sources.length === 0 ? <Empty>収集履歴がありません。</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-medium">ソース</th><th className="px-2 py-2 font-medium">状態</th>
                <th className="px-2 py-2 font-medium">最終取得</th><th className="px-2 py-2 text-right font-medium">成功率</th>
                <th className="px-2 py-2 text-right font-medium">件数</th><th className="px-4 py-2 font-medium">鮮度</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {d.sources.map((s) => (
                  <tr key={s.source}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 font-medium"><SportDot sport={s.sport} /><span className="font-mono text-xs">{s.source}</span></div>
                      {s.note && <div className="mt-0.5 text-xs text-muted">{s.note}</div>}
                    </td>
                    <td className="px-2 py-2.5">
                      {s.enabled ? <span className="text-xs text-pos">● 有効</span> : <span className="text-xs text-faint">○ 無効</span>}
                    </td>
                    <td className="num px-2 py-2.5 text-xs">
                      <div>{dateTime(s.lastRunAt)}</div>
                      <div className="text-faint">成功 {dateTime(s.lastSuccessAt)}</div>
                    </td>
                    <td className={`num px-2 py-2.5 text-right ${s.enabled && s.successRate != null && s.successRate < 0.9 ? 'text-warn' : ''}`}>{s.enabled ? pct(s.successRate, 0) : <span className="text-faint">—</span>}<div className="text-[10px] text-faint">{s.runs} 回 · 品質除外 {s.qualityExclusions ?? 0} レース試行</div></td>
                    <td className="num px-2 py-2.5 text-right">{s.records.toLocaleString()}</td>
                    <td className={`num px-4 py-2.5 text-xs ${s.enabled && (s.freshnessMinutes == null || s.freshnessMinutes > 60 * 48) ? 'text-warn' : ''}`}>{s.enabled ? freshness(s.freshnessMinutes) : <span className="text-faint">取得停止中</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="品質チェックによる除外（直近）">
        <p className="px-4 py-2 text-xs text-muted">{exclusions.reduce((n, row) => n + row.count, 0)} レース試行。通信失敗ではありません。基準外のオッズは保存せず、判定・購入に使いません。成功率から品質のみの除外試行を除きます。</p>
        {exclusions.length === 0 ? <Empty>品質除外はありません。</Empty> : <ul className="divide-y divide-line">{exclusions.map((row, i) => (
          <li key={i} className="px-4 py-2.5 text-sm">
            <div className="flex justify-between text-xs text-muted"><span className="font-mono">{row.source} · {row.count} レース試行</span><span className="num">{dateTime(row.at)}</span></div>
            <div className="mt-0.5 break-words text-warn">{row.reason}</div>
          </li>
        ))}</ul>}
      </Section>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Section title="通信・解析等のエラー履歴">
          {d.errors.length === 0 ? <Empty>エラーはありません。</Empty> : (
            <ul className="divide-y divide-line">
              {d.errors.map((e, i) => (
                <li key={i} className="px-4 py-2.5 text-sm">
                  <div className="flex justify-between text-xs text-muted"><span className="font-mono">{e.source}</span><span className="num">{dateTime(e.at)}</span></div>
                  <div className="mt-0.5 break-words text-neg">{e.error}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="テーブル件数">
          <ul className="divide-y divide-line text-sm">
            {Object.entries(d.tableCounts).map(([k, v]) => (
              <li key={k} className="flex justify-between px-4 py-2"><span className="font-mono text-xs text-muted">{k}</span><span className="num">{v.toLocaleString()}</span></li>
            ))}
          </ul>
          <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-faint">{d.freeTier.d1RowLimitNote}</p>
        </Section>
      </div>
    </div>
  )
}
