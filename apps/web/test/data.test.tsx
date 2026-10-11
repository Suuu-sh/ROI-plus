import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { DataPage } from '../src/pages/Data'
import { api } from '../src/lib/api'

describe('data collection status', () => {
  it('shows quality reasons separately from failures, including counts', async () => {
    const mock=vi.spyOn(api,'collection').mockResolvedValue({sources:[],errors:[{at:'2026-10-11T00:00:00Z',source:'test',error:'HTTP 503'}],qualityExclusions:[{at:'2026-10-11T00:00:00Z',source:'test',count:1,reason:'overround out of range'}],tableCounts:{},freeTier:{d1RowsApprox:0,d1RowLimitNote:'test'}})
    const ui=render(<DataPage />)
    await waitFor(()=>expect(ui.container.textContent).toContain('品質チェックによる除外（直近）'))
    expect(ui.getByText('overround out of range').className).toContain('text-warn')
    expect(ui.getByText('HTTP 503').className).toContain('text-neg')
    expect(ui.container.textContent).toContain('1 レース試行。通信失敗ではありません。')
    ui.unmount();mock.mockRestore()
  })
})
