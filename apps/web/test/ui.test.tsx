import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { EdgeBadge, OriginBadge, ProbBar } from '../src/components/ui'
import { pct, signedPct, signedYen, freshness } from '../src/lib/format'

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
