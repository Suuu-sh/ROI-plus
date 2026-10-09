import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type OriginFilter = 'all' | 'real' | 'sample'
const KEY = 'edgelab.origin'

const Ctx = createContext<{ origin: OriginFilter; setOrigin: (o: OriginFilter) => void }>({
  origin: 'all', setOrigin: () => {},
})

function initial(): OriginFilter {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'all' || v === 'real' || v === 'sample') return v
  } catch { /* storage unavailable */ }
  return 'all'
}

export function OriginProvider({ children }: { children: ReactNode }) {
  const [origin, setOrigin] = useState<OriginFilter>(initial)
  useEffect(() => { try { localStorage.setItem(KEY, origin) } catch { /* ignore */ } }, [origin])
  return <Ctx.Provider value={{ origin, setOrigin }}>{children}</Ctx.Provider>
}

export const useOrigin = () => useContext(Ctx)
