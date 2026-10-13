import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { DataOrigin, EdgeLabel, Sport } from '@edgelab/shared/src/types'
import { t } from '../i18n'

const edgeStyle: Record<EdgeLabel, string> = {
  HIGH_EDGE: 'shine bg-pos text-white dark:text-bg border-pos',
  POSITIVE_EDGE: 'bg-pos/10 text-pos border-pos/50',
  NEUTRAL: 'bg-raised text-muted border-line',
  NEGATIVE_EDGE: 'bg-neg/10 text-neg border-neg/40',
  INSUFFICIENT_DATA: 'bg-transparent text-warn border-warn/60 border-dashed',
}

export function EdgeBadge({ edge, compact }: { edge: EdgeLabel; compact?: boolean }) {
  const label = t().edge[edge]
  return (
    <span
      title={t().edgeHint[edge]}
      className={`num inline-flex items-center whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${edgeStyle[edge]}`}
    >
      {compact ? label.replace(' DATA', '').replace(' EDGE', '') : label}
    </span>
  )
}

export function OriginBadge({ origin }: { origin: DataOrigin }) {
  return origin === 'sample' ? (
    <span className="num inline-flex items-center rounded-[3px] border border-dashed border-warn/70 bg-warn/10 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-warn">SAMPLE</span>
  ) : (
    <span className="num inline-flex items-center rounded-[3px] border border-ink bg-ink px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-bg">REAL</span>
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

function prefersMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && typeof window.requestAnimationFrame === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const numberPattern = /\d[\d,]*(?:\.\d+)?/

/** Rolls the first number inside a formatted string (¥, %, signs kept) up to its value. Static when motion is unavailable. */
export function CountUp({ value, duration = 900 }: { value: string; duration?: number }) {
  const [shown, setShown] = useState(() => (prefersMotion() ? frame(value, 0) : value))
  const from = useRef(0)
  useEffect(() => {
    const match = value.match(numberPattern)
    if (!match || !prefersMotion()) return
    const target = Number(match[0].replace(/,/g, ''))
    const start = from.current
    const began = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - began) / duration)
      const eased = 1 - Math.pow(1 - progress, 4)
      setShown(progress >= 1 ? value : frame(value, start + (target - start) * eased))
      if (progress < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{numberPattern.test(value) && prefersMotion() ? shown : value}</>
}

function frame(value: string, current: number) {
  const match = value.match(numberPattern)
  if (!match) return value
  const raw = match[0]
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
  const text = raw.includes(',')
    ? current.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : current.toFixed(decimals)
  return value.slice(0, match.index) + text + value.slice((match.index ?? 0) + raw.length)
}

export function LiveDot({ label }: { label?: string }) {
  return <span className="live-dot shrink-0" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}

export function Kpi({ label, value, sub, valueClass = '' }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <dl className="card lift min-w-0 p-4">
      <dt className="label min-w-0 break-words">{label}</dt>
      <dd className={`figure mt-2 min-w-0 break-words text-[28px] sm:text-[32px] ${valueClass}`}>{typeof value === 'string' ? <CountUp value={value} /> : value}</dd>
      {sub != null && <dd className="num mt-2.5 min-w-0 break-words border-t border-dashed border-line pt-2 text-xs text-muted">{sub}</dd>}
    </dl>
  )
}

export function Section({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card border-t-[3px] border-t-ink ${className}`}>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="min-w-0 flex-1 break-words text-[15px] font-bold tracking-tight">{title}</h2>
        {right != null && <div className="min-w-0 max-w-full shrink-0 [overflow-wrap:anywhere]">{right}</div>}
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
      <div className="relative h-2 w-16 rounded-[2px] bg-raised sm:w-20">
        <div className={`bar-grow h-full rounded-[2px] ${above ? 'bg-pos' : 'bg-faint'}`} style={{ width: `${w}%` }} />
        {be != null && <div className="anim-fade absolute top-[-3px] h-[14px] w-[2px] bg-ink" style={{ left: `calc(${be}% - 1px)`, animationDelay: '.8s' }} title="損益分岐勝率" />}
      </div>
      <span className="num text-sm">{(p * 100).toFixed(1)}%</span>
    </div>
  )
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="読み込み中">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} aria-hidden="true" className="skeleton-shimmer h-8 animate-pulse rounded-[4px] bg-raised motion-reduce:animate-none" style={{ opacity: Math.max(0.3, 1 - i * 0.2) }} />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="anim-fade flex flex-col items-start gap-2 border-l-4 border-neg/60 p-4 text-sm">
      {error.message === 'SESSION_EXPIRED' ? (
        <>
          <div className="text-warn">ログインの有効期限が切れました。</div>
          <button className="btn-ghost h-8" onClick={() => window.location.reload()}>再読み込みしてログイン</button>
        </>
      ) : (
        <>
          <div className="text-neg">読み込みに失敗しました：{error.message}</div>
          <div className="text-xs text-muted">
            {import.meta.env.DEV ? 'API（npm run dev で :8787 に起動）が動いているか確認してください。' : 'しばらくしてから再試行してください。続く場合はページを再読み込みしてください。'}
          </div>
          {onRetry && <button className="btn-ghost h-8" onClick={onRetry}>再試行</button>}
        </>
      )}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="anim-fade flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted">
    <svg aria-hidden="true" viewBox="0 0 48 32" className="h-8 w-12 text-faint" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="3" y="3" width="42" height="26" rx="2" strokeDasharray="4 3" /><path d="M14 16h20" /></svg>
    <div>{children}</div>
  </div>
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md', ariaLabel = '表示切り替え' }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; ariaLabel?: string
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : options.length > 0 ? 0 : -1

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group || tabStopIndex < 0) return
    const selected = group.querySelectorAll<HTMLButtonElement>('button')[tabStopIndex]
    if (!selected) return

    const keepSelectedVisible = () => {
      const groupRect = group.getBoundingClientRect()
      const selectedRect = selected.getBoundingClientRect()
      const visibleLeft = groupRect.left + group.clientLeft
      const visibleRight = visibleLeft + group.clientWidth
      let adjustment = 0
      if (selectedRect.width >= group.clientWidth) {
        // An option wider than the viewport cannot fit; keep its leading edge visible.
        adjustment = selectedRect.left - visibleLeft
      } else if (selectedRect.left < visibleLeft) {
        adjustment = selectedRect.left - visibleLeft
      } else if (selectedRect.right > visibleRight) {
        adjustment = selectedRect.right - visibleRight
      }
      if (adjustment !== 0) group.scrollLeft += adjustment
    }

    const placeThumb = () => {
      // A sliding thumb marks the selection; without layout (tests, first paint) the button styles itself.
      const next = selected.offsetWidth > 0 ? { left: selected.offsetLeft, width: selected.offsetWidth } : null
      setThumb((current) => current?.left === next?.left && current?.width === next?.width ? current : next)
    }
    keepSelectedVisible()
    placeThumb()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { keepSelectedVisible(); placeThumb() })
    observer.observe(group)
    return () => observer.disconnect()
  }, [tabStopIndex, value, options])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (options.length === 0) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % options.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = options.length - 1
    if (nextIndex == null) return
    event.preventDefault()
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[nextIndex]?.focus()
    onChange(options[nextIndex].value)
  }

  return (
    <div ref={groupRef} className="segmented-control relative inline-flex max-w-full overflow-x-auto rounded-md border border-ink/15 bg-raised p-0.5" role="group" aria-label={ariaLabel}>
      {thumb && <span aria-hidden="true" className="seg-thumb pointer-events-none absolute bottom-0.5 left-0 top-0.5 rounded-[4px] border border-ink bg-surface shadow-[2px_2px_0_rgb(var(--ink))]" style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }} />}
      {options.map((o, index) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          tabIndex={index === tabStopIndex ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          className={`focus-ring relative z-[1] shrink-0 whitespace-nowrap rounded-[4px] font-bold transition-colors duration-300 motion-reduce:transition-none focus-visible:ring-inset ${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm'} ${
            value === o.value ? `border text-ink ${thumb ? 'border-transparent' : 'border-ink bg-surface'}` : 'border border-transparent text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
