import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EdgeBadge, Kpi, Loading, OriginBadge, ProbBar, Section, Segmented } from '../src/components/ui'
import { pct, signedPct, signedYen, freshness } from '../src/lib/format'
import { ProfitabilityNotice } from '../src/pages/Performance'
import { promotionAvailability } from '../src/lib/models'

afterEach(() => cleanup())

describe('format', () => {
  it('formats percentages and signs', () => {
    expect(pct(0.4)).toBe('40.0%')
    expect(signedPct(0.2)).toBe('+20.0%')
    expect(signedPct(-0.05)).toBe('−5.0%')
    expect(pct(null)).toBe('—')
    expect(signedYen(-1200)).toBe('−¥1,200')
    expect(freshness(null)).toBe('不明')
  })
})

describe('badges', () => {
  it('labels edges and origins', () => {
    const { container } = render(<><EdgeBadge edge="INSUFFICIENT_DATA" /><OriginBadge origin="sample" /></>)
    expect(container.textContent).toContain('INSUFFICIENT DATA')
    expect(container.textContent).toContain('SAMPLE')
  })
  it('shows missing probability as dash', () => {
    const { container } = render(<ProbBar p={null} breakEven={0.3} />)
    expect(container.textContent).toBe('—')
  })
})

describe('shared UI primitives', () => {
  it('uses a labeled button group with one tab stop and pressed state', () => {
    const onChange = vi.fn()
    render(<Segmented ariaLabel="期間" value="month" options={[{ value: 'week', label: '週' }, { value: 'month', label: '月' }]} onChange={onChange} />)
    const group = screen.getByRole('group', { name: '期間' })
    const week = within(group).getByRole('button', { name: '週' })
    const month = within(group).getByRole('button', { name: '月' })
    expect(week.getAttribute('aria-pressed')).toBe('false')
    expect(month.getAttribute('aria-pressed')).toBe('true')
    expect(week.getAttribute('tabindex')).toBe('-1')
    expect(month.getAttribute('tabindex')).toBe('0')
    fireEvent.click(week)
    expect(onChange).toHaveBeenCalledWith('week')
  })

  it('uses the first option as the sole tab stop for an unknown value', () => {
    render(<Segmented value={'missing' as 'a'} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('button', { name: 'B' }).getAttribute('tabindex')).toBe('-1')
  })

  it('moves focus and selection with arrows, wraps, and supports Home/End without handling other keys', () => {
    const onChange = vi.fn()
    render(<Segmented value="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }]} onChange={onChange} />)
    const a = screen.getByRole('button', { name: 'A' })
    const b = screen.getByRole('button', { name: 'B' })
    const c = screen.getByRole('button', { name: 'C' })
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(c)
    expect(onChange).toHaveBeenLastCalledWith('c')
    fireEvent.keyDown(c, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(a, { key: 'End' })
    expect(document.activeElement).toBe(c)
    fireEvent.keyDown(c, { key: 'Home' })
    expect(document.activeElement).toBe(a)
    onChange.mockClear()
    fireEvent.keyDown(a, { key: 'Tab' })
    expect(onChange).not.toHaveBeenCalled()
    expect(b.getAttribute('tabindex')).toBe('-1')
  })

  it('scrolls the selected option into view on mount and when the value changes', () => {
    const options = [{ value: 'first', label: 'First' }, { value: 'last', label: 'Last' }]
    const { rerender } = render(<Segmented value="first" options={options} onChange={() => {}} />)
    const group = screen.getByRole('group', { name: '表示切り替え' }) as HTMLDivElement
    Object.defineProperty(group, 'clientWidth', { configurable: true, value: 100 })
    Object.defineProperty(group, 'clientLeft', { configurable: true, value: 1 })
    group.getBoundingClientRect = () => ({ left: 0, right: 102, width: 102, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON: () => ({}) })
    for (const button of group.querySelectorAll('button')) {
      const start = button.textContent === 'Last' ? 81 : 1
      button.getBoundingClientRect = () => {
        const left = start - group.scrollLeft
        return { left, right: left + 40, width: 40, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON: () => ({}) }
      }
    }
    // Exercise the layout effect with measurable geometry when selection changes.
    rerender(<Segmented value="last" options={options} onChange={() => {}} />)
    expect(group.scrollLeft).toBe(20)
    rerender(<Segmented value="first" options={options} onChange={() => {}} />)
    expect(group.scrollLeft).toBe(0)
  })

  it('does not submit a surrounding form when a segment is activated', () => {
    const submit = vi.fn((event: Event) => event.preventDefault())
    const change = vi.fn()
    render(<form onSubmit={submit}><Segmented value="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={change} /></form>)
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(submit).not.toHaveBeenCalled()
    expect(change).toHaveBeenCalledWith('b')
  })

  it('renders KPI label, exact value, and optional subtext with semantic description list markup', () => {
    const { container, rerender } = render(<Kpi label="長いラベル" value="¥123,456,789" sub="補足" valueClass="text-pos" />)
    const list = container.querySelector('dl')
    expect(list).toBeTruthy()
    expect(within(list as HTMLElement).getByText('長いラベル').tagName).toBe('DT')
    expect(within(list as HTMLElement).getByText('¥123,456,789').tagName).toBe('DD')
    expect(within(list as HTMLElement).getByText('補足').tagName).toBe('DD')
    expect(within(list as HTMLElement).getByText('¥123,456,789').className).toContain('text-pos')
    rerender(<Kpi label="件数" value={8} sub={null} />)
    expect(container.textContent).toBe('件数8')
  })

  it('keeps long section header content available', () => {
    render(<Section title="とても長いタイトルが狭い幅でも折り返されるセクション" right={<button>操作</button>}>内容</Section>)
    expect(screen.getByRole('heading', { name: 'とても長いタイトルが狭い幅でも折り返されるセクション' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '操作' })).toBeTruthy()
    expect(screen.getByText('内容')).toBeTruthy()
  })

  it('keeps all loading skeleton rows visible and exposes reduced-motion-safe status', () => {
    const { container } = render(<Loading rows={8} />)
    const status = screen.getByRole('status', { name: '読み込み中' })
    const rows = status.querySelectorAll('[aria-hidden="true"]')
    expect(rows).toHaveLength(8)
    expect((rows[7] as HTMLElement).style.opacity).toBe('0.3')
    expect(rows[7].className).toContain('motion-reduce:animate-none')
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(8)
  })
})

describe('profitability notice', () => {
  it('does not present expected ROI or sample results as proof of profit', () => {
    const sample = render(<ProfitabilityNotice origin="sample" settledBets={12} />)
    expect(sample.container.textContent).toContain('真のプラス期待値や利益を証明するものではありません')
    expect(sample.container.textContent).toContain('個々の購入の負けだけで予測の誤りとは判断できません')
    expect(sample.container.textContent).toContain('サンプルデータの成績は、実際の利益を示す証拠にはなりません')
    sample.unmount()

    const real = render(<ProfitabilityNotice origin="real" settledBets={0} />)
    expect(real.container.textContent).toContain('確定した実データ購入がまだなく')
  })

  it('keeps sample and real evidence distinct when showing all origins', () => {
    const { container } = render(<ProfitabilityNotice origin="all" settledBets={4} />)
    expect(container.textContent).toContain('サンプルと実データは区別して評価してください')
  })
})

describe('model promotion availability', () => {
  it('keeps legacy unflagged candidates promotable and explains explicitly ineligible ones', () => {
    expect(promotionAvailability({})).toEqual({ enabled: true, reason: null })
    expect(promotionAvailability({ promotionEligible: true })).toEqual({ enabled: true, reason: null })
    expect(promotionAvailability({ promotionEligible: false, promotionReason: '比較データが不足しています。' }))
      .toEqual({ enabled: false, reason: '比較データが不足しています。' })
    expect(promotionAvailability({ promotionEligible: false })).toEqual({
      enabled: false,
      reason: 'この候補は昇格条件を満たしていません。',
    })
  })
})
