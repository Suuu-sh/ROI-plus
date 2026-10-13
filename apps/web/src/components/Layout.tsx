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
  { to: '/board', label: '運用ボード', icon: <Icon d="M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z" />, mobile: true },
  { to: '/horse', label: t().nav.horse, icon: <SportIcon sport="horse" className="h-[18px] w-[18px]" />, mobile: true },
  { to: '/boat', label: t().nav.boat, icon: <SportIcon sport="boat" className="h-[18px] w-[18px]" />, mobile: true },
  { to: '/shadow', label: '分析', icon: <Icon d="M4 19V5m0 14h16M8 15l3-4 3 2 5-7" />, mobile: true },
  { to: '/performance', label: t().nav.performance, icon: <Icon d="M3 3v18h18M7 15l4-4 3 3 6-7" />, mobile: true },
  { to: '/models', label: t().nav.models, icon: <Icon d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" />, mobile: false },
  { to: '/data', label: t().nav.data, icon: <Icon d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />, mobile: false },
]

function OriginToggle() {
  const { origin, setOrigin } = useOrigin()
  return (
    <Segmented<OriginFilter>
      size="sm"
      ariaLabel="表示データ"
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
    <div className="caution-tape anim-fade mb-5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink/20 bg-mark/15 py-2.5 pl-5 pr-4 text-xs text-ink">
      <span><b className="mr-1.5 font-bold">SAMPLE</b>{origin === 'sample' ? 'サンプルデータのみを表示中です。' : 'サンプルデータ（SAMPLE）を含めて表示しています。'}成績・予測は動作確認用の架空の値です。</span>
      <button className="font-bold underline decoration-2 underline-offset-4 hover:decoration-mark" onClick={() => setOrigin('real')}>実データのみ表示</button>
    </div>
  )
}

const isActive = (to: string, pathname: string) => pathname === to || pathname.startsWith(`${to}/`)

export function Layout() {
  const { pathname } = useLocation()
  const isBoatRoute = /^\/boat(?:\/|$)/.test(pathname)
  const isShadowRoute = pathname === '/shadow'
  const activeIndex = nav.findIndex((n) => isActive(n.to, pathname))
  // Replay the entrance animation per top-level screen, not when a race inside it changes.
  const screenKey = pathname.split('/')[1] ?? ''
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[236px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col bg-side px-3 py-6 text-side-ink lg:flex">
        <Brand dark />
        <nav className="relative mt-8 flex flex-col gap-0.5">
          <span aria-hidden="true" className="nav-indicator absolute left-0 top-0 h-10 w-full rounded-md bg-side-ink/10"
            style={{ transform: `translateY(${Math.max(0, activeIndex) * 42}px)`, opacity: activeIndex < 0 ? 0 : 1 }}>
            <span className="absolute inset-y-2 left-0 w-1 rounded-r bg-mark" />
          </span>
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/board'}
              className={({ isActive }) =>
                `nav-item focus-ring relative flex h-10 items-center gap-3 rounded-md px-4 text-sm font-bold transition-colors duration-300 ${
                  isActive ? 'text-side-ink' : 'text-side-ink/55 hover:text-side-ink'
                }`
              }
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-side-ink/15 px-2 pt-4 text-[11px] leading-relaxed text-side-ink/50">
          <p>仮想購入のみ。実際の投票機能はありません。</p>
          <p>予測は将来の結果を保証しません。</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className={`${isBoatRoute || isShadowRoute ? 'lg:hidden' : ''} safe-area-header sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-ink/15 bg-bg/85 px-4 py-3 backdrop-blur-md lg:px-8`}>
          <div className="lg:hidden"><Brand /></div>
          {!isBoatRoute && !isShadowRoute && <>
            <div className="hidden text-xs font-bold text-muted lg:block">表示データ</div>
            <OriginToggle />
          </>}
        </header>
        <main className="safe-area-content mx-auto max-w-[1280px] px-4 pb-28 pt-5 lg:px-8 lg:pb-12">
          {!isBoatRoute && !isShadowRoute && <SampleNotice />}
          <ErrorBoundary resetKey={pathname}><div key={screenKey} className="page-enter"><Outlet /></div></ErrorBoundary>
        </main>
      </div>

      <nav className="safe-area-bottom-nav fixed inset-x-0 bottom-0 z-30 grid grid-cols-7 border-t border-ink/15 bg-surface/90 backdrop-blur-md lg:hidden">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/board'}
            className={({ isActive }) =>
              `nav-item relative flex flex-col items-center gap-1 py-2 text-[10px] font-bold transition-colors duration-300 ${isActive ? 'text-ink' : 'text-faint'}`
            }
          >
            {({ isActive }) => <>
              <span aria-hidden="true" className={`absolute inset-x-3 top-0 h-[3px] origin-center rounded-b bg-mark transition-transform duration-500 [transition-timing-function:var(--ease-spring)] ${isActive ? 'scale-x-100' : 'scale-x-0'}`} />
              {n.icon}
              <span className="truncate">{n.to === '/boat' ? 'ボート' : n.label}</span>
            </>}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <div className="group flex items-center gap-2.5 px-1">
      <span className={`figure flex items-baseline text-[26px] ${dark ? 'text-side-ink' : 'text-ink'}`}>
        ROI<span className="ml-0.5 inline-flex h-[22px] w-[22px] items-center justify-center self-center rounded-[3px] bg-mark text-[20px] text-[rgb(26_24_20)] transition-transform duration-500 [transition-timing-function:var(--ease-spring)] group-hover:rotate-90">+</span>
      </span>
      <div className={`hidden border-l pl-2.5 text-[10px] font-bold leading-tight lg:block ${dark ? 'border-side-ink/20 text-side-ink/60' : 'border-line text-muted'}`}>
        {t().tagline.split('・').map((part) => <div key={part}>{part}</div>)}
      </div>
    </div>
  )
}
