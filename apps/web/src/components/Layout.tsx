import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import type { ReactNode } from 'react'
import { t } from '../i18n'
import { useOrigin, type OriginFilter } from '../lib/origin'
import { Segmented, SportIcon } from './ui'

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)

const nav: { to: string; label: string; icon: ReactNode; mobile: boolean }[] = [
  { to: '/', label: t().nav.overview, icon: <Icon d="M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z" />, mobile: true },
  { to: '/horse', label: t().nav.horse, icon: <SportIcon sport="horse" className="h-[18px] w-[18px]" />, mobile: true },
  { to: '/boat', label: t().nav.boat, icon: <SportIcon sport="boat" className="h-[18px] w-[18px]" />, mobile: true },
  { to: '/performance', label: t().nav.performance, icon: <Icon d="M3 3v18h18M7 15l4-4 3 3 6-7" />, mobile: true },
  { to: '/models', label: t().nav.models, icon: <Icon d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" />, mobile: false },
  { to: '/data', label: t().nav.data, icon: <Icon d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />, mobile: false },
]

function OriginToggle() {
  const { origin, setOrigin } = useOrigin()
  return (
    <Segmented<OriginFilter>
      size="sm"
      value={origin}
      onChange={setOrigin}
      options={[
        { value: 'all', label: t().origin.all },
        { value: 'real', label: t().origin.real },
        { value: 'sample', label: t().origin.sample },
      ]}
    />
  )
}

function SampleNotice() {
  const { origin, setOrigin } = useOrigin()
  if (origin === 'real') return null
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/40 bg-warn/10 px-4 py-2.5 text-xs text-warn">
      <span>{origin === 'sample' ? 'サンプルデータのみを表示中です。' : 'サンプルデータ（SAMPLE）を含めて表示しています。'}成績・予測は動作確認用の架空の値です。</span>
      <button className="font-semibold underline-offset-2 hover:underline" onClick={() => setOrigin('real')}>実データのみ表示</button>
    </div>
  )
}

export function Layout() {
  const { pathname } = useLocation()
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface px-3 py-5 lg:flex">
        <Brand />
        <nav className="mt-6 flex flex-col gap-0.5">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `focus-ring flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
                }`
              }
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 px-3 text-[11px] leading-relaxed text-faint">
          <p>仮想購入のみ。実際の投票機能はありません。</p>
          <p>予測は将来の結果を保証しません。</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:px-8">
          <div className="lg:hidden"><Brand /></div>
          <div className="hidden text-xs text-muted lg:block">表示データ</div>
          <OriginToggle />
        </header>
        <main className="mx-auto max-w-[1280px] px-4 pb-28 pt-5 lg:px-8 lg:pb-12">
          <SampleNotice />
          <ErrorBoundary resetKey={pathname}><Outlet /></ErrorBoundary>
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 py-2 text-[10px] font-medium ${isActive ? 'text-ink' : 'text-faint'}`
            }
          >
            {n.icon}
            <span className="truncate">{n.to === '/boat' ? 'ボート' : n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <img src="/favicon.svg" alt="" className="h-7 w-7" />
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight">{t().app}</div>
        <div className="hidden text-[11px] text-muted lg:block">{t().tagline}</div>
      </div>
    </div>
  )
}
