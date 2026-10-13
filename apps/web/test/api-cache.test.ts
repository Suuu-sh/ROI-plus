import { afterEach, expect, it, vi } from 'vitest'
import { api, markReadCacheFresh } from '../src/lib/api'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function mockFetch() {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it('bypasses bets and overview cache briefly after a successful purchase mutation', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const fetcher = mockFetch()
  await api.placeBet({ raceId: 'cache-test', betType: 'win', selection: '1', stake: 100, requestId: 'cache-test' })
  await api.bets('real', 'boat')
  await api.overview('real', 'boat')
  expect(fetcher.mock.calls.slice(1).map(([, init]) => init?.headers)).toEqual([
    { 'X-ROI-Cache-Bypass': '1', 'content-type': 'application/json' },
    { 'X-ROI-Cache-Bypass': '1', 'content-type': 'application/json' },
  ])
  vi.advanceTimersByTime(10_001)
  await api.bets('real', 'boat')
  expect(fetcher.mock.calls.at(-1)?.[1]?.headers).toEqual({ 'content-type': 'application/json' })
})

it('bypasses purchase and overview reads after a confirmed settlement marker', async () => {
  vi.useFakeTimers()
  const fetcher = mockFetch()
  // DataPage calls this only after the authenticated settlement response is valid.
  markReadCacheFresh()
  await api.bets('real', 'boat')
  await api.overview('real', 'boat')
  expect(fetcher.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)['X-ROI-Cache-Bypass'] === '1')).toBe(true)
})
