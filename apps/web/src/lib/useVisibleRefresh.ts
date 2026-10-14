import { useEffect } from 'react'

/** Refresh live result views periodically while visible and immediately on return/focus. */
export function useVisibleRefresh(reload: () => void, intervalMs = 30_000) {
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') reload() }
    const timer = window.setInterval(refresh, intervalMs)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [reload, intervalMs])
}
