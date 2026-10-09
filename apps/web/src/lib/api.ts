import type {
  Bet, Breakdown, CollectionStatus, EdgeCandidate, ModelInfo, Overview, RaceDetail, RaceSummary, Sport,
} from '@edgelab/shared/src/types'
import type { OriginFilter } from './origin'

// 本番では VITE_API_BASE に Worker の URL を指定する（ローカルは Vite のプロキシ）
const API_BASE: string = import.meta.env.VITE_API_BASE ?? ''

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText)
  return body as T
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  races: (sport: Sport, date: string, origin: OriginFilter) =>
    req<RaceSummary[]>(`/races${qs({ sport, date, origin })}`),
  race: (id: string) => req<RaceDetail>(`/races/${encodeURIComponent(id)}`),
  rankings: (sport: Sport, date: string, origin: OriginFilter) =>
    req<EdgeCandidate[]>(`/rankings${qs({ sport, date, origin })}`),
  placeBet: (b: { raceId: string; betType: 'win'; selection: string; stake: number }) =>
    req<Bet>('/bets', { method: 'POST', body: JSON.stringify(b) }),
  bets: (origin: OriginFilter, sport?: Sport) => req<Bet[]>(`/bets${qs({ sport, origin })}`),
  overview: (origin: OriginFilter, sport?: Sport) => req<Overview>(`/performance/overview${qs({ sport, origin })}`),
  breakdown: (origin: OriginFilter) => req<Breakdown>(`/performance/breakdown${qs({ origin })}`),
  models: () => req<ModelInfo[]>('/models'),
  promote: (id: string) => req<ModelInfo>(`/models/${encodeURIComponent(id)}/promote`, { method: 'POST' }),
  rollback: (id: string) => req<ModelInfo>(`/models/${encodeURIComponent(id)}/rollback`, { method: 'POST' }),
  collection: () => req<CollectionStatus>('/collection/status'),
}
