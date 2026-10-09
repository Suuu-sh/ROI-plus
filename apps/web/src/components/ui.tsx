import type { ReactNode } from 'react'
import type { DataOrigin, EdgeLabel, Sport } from '@edgelab/shared/src/types'
import { t } from '../i18n'

const edgeStyle: Record<EdgeLabel, string> = {
  HIGH_EDGE: 'bg-pos text-white dark:text-bg border-pos',
  POSITIVE_EDGE: 'bg-pos/10 text-pos border-pos/40',
  NEUTRAL: 'bg-raised text-muted border-line',
  NEGATIVE_EDGE: 'bg-neg/10 text-neg border-neg/30',
  INSUFFICIENT_DATA: 'bg-transparent text-warn border-warn/50 border-dashed',
}

export function EdgeBadge({ edge, compact }: { edge: EdgeLabel; compact?: boolean }) {
  const label = t().edge[edge]
  return (
    <span
      title={t().edgeHint[edge]}
      className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${edgeStyle[edge]}`}
    >
      {compact ? label.replace(' DATA', '').replace(' EDGE', '') : label}
    </span>
  )
}

export function OriginBadge({ origin }: { origin: DataOrigin }) {
  return origin === 'sample' ? (
    <span className="inline-flex items-center rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold text-warn">SAMPLE</span>
  ) : (
    <span className="inline-flex items-center rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">REAL</span>
  )
}

export function SportDot({ sport }: { sport: Sport }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${sport === 'horse' ? 'bg-horse' : 'bg-boat'}`} />
}

export function SportIcon({ sport, className = 'h-4 w-4' }: { sport: Sport; className?: string }) {
  return sport === 'horse' ? (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 20c0-4 2-6 4-7l-2-4 3 1 2-4 2 3c3 1 5 4 5 7l-2 1-2-2-2 1v4" /><path d="M9 20v-3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 15h15l3-4H8L6 7H4l1 8z" /><path d="M2 19c2 1.3 4 1.3 6 0s4-1.3 6 0 4 1.3 6 0" />
    </svg>
  )
}

export function Kpi({ label, value, sub, valueClass = '' }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className={`num mt-1.5 text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</div>
      {sub != null && <div className="num mt-1 text-xs text-muted">{sub}</div>}
    </div>
  )
}

export function Section({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </header>
      <div>{children}</div>
    </section>
  )
}

export function ProbBar({ p, breakEven }: { p: number | null; breakEven: number | null }) {
  if (p == null) return <span className="text-faint">—</span>
  const w = Math.min(100, p * 100)
  const be = breakEven == null ? null : Math.min(100, breakEven * 100)
  const above = breakEven != null && p > breakEven
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-raised sm:w-20">
        <div className={`h-full rounded-full ${above ? 'bg-pos' : 'bg-faint'}`} style={{ width: `${w}%` }} />
        {be != null && <div className="absolute top-[-2px] h-[10px] w-[2px] bg-ink/70" style={{ left: `calc(${be}% - 1px)` }} title="損益分岐勝率" />}
      </div>
      <span className="num text-sm">{(p * 100).toFixed(1)}%</span>
    </div>
  )
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-md bg-raised" style={{ opacity: 1 - i * 0.2 }} />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-sm">
      <div className="text-neg">読み込みに失敗しました：{error.message}</div>
      <div className="text-xs text-muted">API（npm run dev で :8787 に起動）が動いているか確認してください。</div>
      {onRetry && <button className="btn-ghost h-8" onClick={onRetry}>再試行</button>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-raised p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`focus-ring rounded-md font-medium transition-colors ${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm'} ${
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
