import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DataPage } from '../src/pages/Data'
import { api } from '../src/lib/api'

describe('data collection status', () => {
  it('shows quality reasons separately from failures, including counts', async () => {
    const mock=vi.spyOn(api,'collection').mockResolvedValue({sources:[],errors:[{at:'2026-10-11T00:00:00Z',source:'test',error:'HTTP 503'}],qualityExclusions:[{at:'2026-10-11T00:00:00Z',source:'test',count:1,reason:'overround out of range'}],tableCounts:{},d1WriteBudget:{date:'2026-10-11',limit:20_000,essentialLimit:16_000,optionalLimit:4_000,oddsLimit:4_000,reserved:0,essentialReserved:0,optionalReserved:0,oddsReserved:0,remaining:20_000,essentialRemaining:16_000,optionalRemaining:4_000,state:'known'},freeTier:{d1RowsApprox:0,d1RowsNote:'test'}})
    const ui=render(<DataPage />)
    await waitFor(()=>expect(ui.container.textContent).toContain('品質チェックによる除外（直近1時間）'))
    expect(ui.getByText('overround out of range').className).toContain('text-warn')
    expect(ui.getByText('HTTP 503').className).toContain('text-neg')
    expect(ui.container.textContent).toContain('1 レース試行。通信失敗ではありません。')
    ui.unmount();mock.mockRestore()
  })

  it('explains disabled app reservations without presenting null remaining values as zero', async () => {
    const mock = vi.spyOn(api, 'collection').mockResolvedValue({
      sources: [], errors: [], qualityExclusions: [], tableCounts: {},
      d1WriteBudget: {
        enabled: false, state: 'disabled', date: '2026-10-13', limit: 0,
        essentialLimit: 0, optionalLimit: 0, oddsLimit: 0, reserved: null,
        essentialReserved: null, optionalReserved: null, oddsReserved: null,
        collectionReserved: null, collectionRemaining: null, remaining: null,
        essentialRemaining: null, optionalRemaining: null,
      },
      freeTier: { d1RowsApprox: 0, d1RowsNote: 'test' },
    })
    const ui = render(<DataPage />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'D1 日次書込予約（Worker 内推定）' })).toBeTruthy())
    const section = screen.getByRole('heading', { name: 'D1 日次書込予約（Worker 内推定）' }).closest('section')!
    await waitFor(() => expect(section.textContent).toContain('アプリ内の日次書込予算制限は無効です。'))
    expect(section.textContent).toContain('Cloudflare D1 自体の利用上限・実使用量は別管理')
    expect(section.textContent).not.toContain('unit')
    expect(section.textContent).not.toContain('残り')
    expect(section.textContent).not.toContain('不明')
    ui.unmount(); mock.mockRestore()
  })
})
