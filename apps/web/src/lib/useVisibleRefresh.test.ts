import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVisibleRefresh } from './useVisibleRefresh'

describe('useVisibleRefresh', () => {
  afterEach(() => vi.useRealTimers())

  it('polls only while visible, refreshes on focus/return, and cleans listeners/timer on unmount', () => {
    vi.useFakeTimers()
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const reload = vi.fn()
    const { unmount } = renderHook(() => useVisibleRefresh(reload, 1000))

    act(() => { vi.advanceTimersByTime(1000) })
    expect(reload).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    expect(reload).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(reload).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).toHaveBeenCalledTimes(3)

    unmount()
    window.dispatchEvent(new Event('focus'))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(reload).toHaveBeenCalledTimes(3)
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    // jsdom provides visibilityState; leave its original descriptor in place.
  })
})
