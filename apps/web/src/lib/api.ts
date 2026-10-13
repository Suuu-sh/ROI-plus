import type {
  Bet, BetType, Breakdown, CollectionStatus, RankingCandidate, ModelInfo, Overview, RaceDetail, RaceSummary, Sport,
} from '@edgelab/shared/src/types'
import type { OriginFilter } from './origin'

// 本番では VITE_API_BASE に Worker の URL を指定する（ローカルは Vite のプロキシ）
const API_BASE: string = import.meta.env.VITE_API_BASE ?? ''

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const pendingReads = new Map<string, Promise<unknown>>()
const READ_FRESH_WINDOW_MS = 10_000
let readFreshUntil = 0

export function markReadCacheFresh() {
  readFreshUntil = Date.now() + READ_FRESH_WINDOW_MS
}

// Share concurrent reads (including StrictMode effects), never cache settled purchase data.
function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== 'GET') return fetchJson<T>(path, init)
  if (new Headers(init?.headers).get('X-ROI-Cache-Bypass') === '1') return fetchJson<T>(path, init)
  const existing = pendingReads.get(path)
  if (existing) return existing as Promise<T>
  const request = fetchJson<T>(path, init).finally(() => {
    if (pendingReads.get(path) === request) pendingReads.delete(path)
  })
  pendingReads.set(path, request)
  return request
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  // Access のログイン切れでは /api がログイン画面へ転送される（JSON 以外が返る）
  if (res.redirected || res.type === 'opaqueredirect' || !(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new ApiError(401, 'SESSION_EXPIRED')
  }
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
    req<RankingCandidate[]>(`/rankings${qs({ sport, date, origin })}`),
  placeBet: async (b: { raceId: string; betType: BetType; selection: string; stake: number; requestId: string }) => {
    const result = await req<Bet>('/bets', { method: 'POST', body: JSON.stringify(b) })
    markReadCacheFresh()
    return result
  },
  placeBetBatch: async (b: { raceId: string; betType: 'win'; requestId: string; selections: { selection: string; stake: number }[] }) => {
    const result = await req<{ groupId: string; bets: Bet[] }>('/bets', { method: 'POST', body: JSON.stringify(b) })
    markReadCacheFresh()
    return result
  },
  bets: (origin: OriginFilter, sport?: Sport, fresh = false) => req<Bet[]>(`/bets${qs({ sport, origin })}`, fresh || Date.now() < readFreshUntil ? { headers: { 'X-ROI-Cache-Bypass': '1' } } : undefined),
  overview: (origin: OriginFilter, sport?: Sport, fresh = false) => req<Overview>(`/performance/overview${qs({ sport, origin })}`, fresh || Date.now() < readFreshUntil ? { headers: { 'X-ROI-Cache-Bypass': '1' } } : undefined),
  breakdown: (origin: OriginFilter) => req<Breakdown>(`/performance/breakdown${qs({ origin })}`),
  rankComparison: (origin: OriginFilter) => req<RankComparison>(`/performance/rank-comparison${qs({ origin })}`),
  experimentalPerformance: () => req<ExperimentalPerformance>('/performance/experimental'),
  experimentalBets: () => req<ExperimentalBet[]>('/bets/experimental'),
  models: () => req<ModelInfo[]>('/models'),
  promote: (id: string) => req<ModelInfo>(`/models/${encodeURIComponent(id)}/promote`, { method: 'POST' }),
  promoteInitialBaseline: (id: string, validationFingerprint: string) =>
    req<ModelInfo>(`/models/${encodeURIComponent(id)}/promote`, {
      method: 'POST', body: JSON.stringify({ mode: 'initial_baseline', validationFingerprint, confirmed: true }),
    }),
  rollback: (id: string) => req<ModelInfo>(`/models/${encodeURIComponent(id)}/rollback`, { method: 'POST' }),
  collection: () => req<CollectionStatus>('/collection/status'),
}

export interface ExperimentalBet {
  id: string
  recordKind: 'experimental_paper'
  experimentKey: 'boat-trifecta-small-sample-v1'
  decisionId: string
  raceId: string
  sport: 'boat'
  betType: 'trifecta'
  selection: string
  stake: number
  predictedProb: number | null
  probabilityStd: number | null
  oddsAtBet: number | null
  expectedRoi: number | null
  modelId: string
  placedAt: string
  status: 'open' | 'won' | 'lost' | 'void'
  repairReason?: 'invalid_stake_unit' | string | null
  payout: number | null
  profit: number | null
  settledAt: string | null
  dataOrigin: 'real'
  venueName: string | null
  raceNo: number
  raceDate: string
  finalOdds?: number | null
  officialSelection: string | null
}

export interface ExperimentalPerformance {
  experimentKey: 'boat-trifecta-small-sample-v1'
  state: 'unavailable' | 'ready'
  model: { id: string; status: 'candidate' | 'experimental'; artifactSha256: string; schemaVersion: string; trainedAt: string } | null
  bankroll: { initial: 100000; available: number }
  metrics: { races: number; bets: number; stake: number; payout: number; profit: number; roi: number | null }
  comparison?: {
    actual: { tickets: number; stake: number; payout: number; profit: number; roi: number | null }
    fixed100: { tickets: number; stake: number; payout: number; profit: number; roi: number | null }
    settledRaceCount: number; pendingRaceCount: number; excludedRaceCount: number
  }
  decisions: ExperimentalDecision[]
  sizing: { method: 'fractional-kelly-portfolio'; minimumTicketStake?: 100; stakeUnit?: 100; perRaceCombinedCap: 1000; dailyCap: null; balanceGuard: 'nonnegative-virtual-balance' }
}

export interface ExperimentalDecision {
  raceId: string
  raceDate: string
  raceNo: number
  venueName: string | null
  outcome: 'placed' | 'abstained' | 'void'
  reason: string | null
  stake: number
  modelId: string
  decidedAt: string
  probability: number | null
  odds: number | null
  uncertainty: number | null
  expectedRoi: number | null
}

export interface RankComparison {
  comparedGroupCount: number
  comparedRaceCount: number
  excludedPendingGroupCount: number
  excludedMissingRankOneGroupCount: number
  excludedUnknownRankBetCount: number
  totalStake: number
  multiple: { stake: number; payout: number; profit: number; roi: number | null }
  firstOnly: { stake: number; payout: number; profit: number; roi: number | null }
  note: string
}
