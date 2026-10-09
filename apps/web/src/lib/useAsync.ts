import { useCallback, useEffect, useRef, useState } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  const reload = useCallback(() => {
    const id = ++seq.current
    setLoading(true)
    run()
      .then((d) => { if (id === seq.current) { setData(d); setError(null) } })
      .catch((e: Error) => { if (id === seq.current) setError(e) })
      .finally(() => { if (id === seq.current) setLoading(false) })
  }, [run])
  useEffect(reload, [reload])
  return { data, error, loading, reload }
}
