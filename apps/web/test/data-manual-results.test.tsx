import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DataPage } from '../src/pages/Data'
import { api } from '../src/lib/api'

const collectionStatus = {
  sources: [], errors: [], qualityExclusions: [], tableCounts: {},
  d1WriteBudget: { date: '2026-10-11', limit: 20_000, essentialLimit: 16_000, optionalLimit: 4_000, oddsLimit: 4_000, reserved: 0, essentialReserved: 0, optionalReserved: 0, oddsReserved: 0, remaining: 20_000, essentialRemaining: 16_000, optionalRemaining: 4_000, state: 'known' as const },
  freeTier: { d1RowsApprox: 0, d1RowsNote: 'test' },
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function renderDataPage() {
  const read = vi.spyOn(api, 'collection').mockResolvedValue(collectionStatus)
  render(<DataPage />)
  return read
}

describe('manual purchased boat results', () => {
  it('waits for collection before settling and disables the action while pending', async () => {
    const read = renderDataPage()
    let finishCollection!: (response: Response) => void
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('collect-boat-results')) return new Promise<Response>((resolve) => { finishCollection = resolve })
      return Promise.resolve(jsonResponse({ settled: 2 }))
    })
    vi.stubGlobal('fetch', fetcher)
    const button = await screen.findByRole('button', { name: '購入済みの結果を今すぐ取得' }) as HTMLButtonElement
    fireEvent.click(button)

    await waitFor(() => expect(button.textContent).toBe('結果を取得中…'))
    expect(button.disabled).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/admin/collect-boat-results')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ confirmed: true }) })

    finishCollection(jsonResponse({ status: 'success', targets: 4, verified: 3, records: 18, attempted: 4 }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(fetcher.mock.calls[1][0]).toBe('/api/admin/settle')
    expect(await screen.findByText(/結果取得完了（3 \/ 4 レース確認）。2 件を精算しました。/)).toBeTruthy()
    expect(button.disabled).toBe(false)
  })

  it('reports partial collection truthfully and does not leak raw response errors', async () => {
    renderDataPage()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'partial', targets: 4, verified: 1, records: 6, attempted: 4 }))
      .mockResolvedValueOnce(jsonResponse({ settled: 1 }))
    vi.stubGlobal('fetch', fetcher)
    fireEvent.click(await screen.findByRole('button', { name: '購入済みの結果を今すぐ取得' }))
    expect(await screen.findByText(/一部のみ取得（1 \/ 4 レース確認）。保存済み結果も含めて精算を実行しました。1 件を精算しました。/)).toBeTruthy()
  })

  it('does not settle or display raw server errors when collection fails', async () => {
    renderDataPage()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'secret internal failure' }, 500)))
    fireEvent.click(await screen.findByRole('button', { name: '購入済みの結果を今すぐ取得' }))
    expect(await screen.findByText(/結果取得の完了を確認できませんでした。/)).toBeTruthy()
    expect(screen.queryByText('secret internal failure')).toBeNull()
  })

  it('does not claim settlement completed when the settle response fails', async () => {
    renderDataPage()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'partial', targets: 4, verified: 1, records: 6, attempted: 4 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'secret settle failure' }, 500))
    vi.stubGlobal('fetch', fetcher)
    fireEvent.click(await screen.findByRole('button', { name: '購入済みの結果を今すぐ取得' }))
    expect(await screen.findByText(/一部のみ取得（1 \/ 4 レース確認）。保存済み結果も含めて精算を試みました。精算要求を送信しました。精算結果は未確認です。 精算結果を確認できませんでした。/)).toBeTruthy()
    expect(screen.queryByText('secret settle failure')).toBeNull()
  })
})
