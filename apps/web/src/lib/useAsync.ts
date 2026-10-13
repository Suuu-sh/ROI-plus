import { useCallback, useEffect, useRef, useState } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], freshFn?: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  const runFresh = useCallback(freshFn ?? fn, deps)
  const execute = useCallback((fetcher: () => Promise<T>) => {
    const id = ++seq.current
    setLoading(true)
    fetcher()
      .then((d) => { if (id === seq.current) { setData(d); setError(null) } })
      .catch((e: Error) => { if (id === seq.current) setError(e) })
      .finally(() => { if (id === seq.current) setLoading(false) })
  }, [])
  const reload = useCallback(() => execute(runFresh), [execute, runFresh])
  useEffect(() => { execute(run) }, [execute, run])
  return { data, error, loading, reload }
}
