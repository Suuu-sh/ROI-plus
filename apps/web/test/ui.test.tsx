import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { EdgeBadge, OriginBadge, ProbBar } from '../src/components/ui'
import { pct, signedPct, signedYen, freshness } from '../src/lib/format'
import { ProfitabilityNotice } from '../src/pages/Performance'
import { promotionAvailability } from '../src/lib/models'

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
