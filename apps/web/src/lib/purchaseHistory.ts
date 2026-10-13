import type { Bet } from '@edgelab/shared/src/types'
import type { ExperimentalBet } from './api'

/** Display adapter only: the experimental ledger and performance remain separate. */
export type HistoryBet = Bet & { recordKind?: 'experimental_paper'; repairReason?: string | null; officialSelection?: string | null }

export function mergePurchaseHistory(bets: Bet[], experimental: ExperimentalBet[]): HistoryBet[] {
  const adapted: HistoryBet[] = experimental.map((bet) => ({
    ...bet, id: `experimental:${bet.id}`, mode: 'auto', edgeLabel: 'INSUFFICIENT_DATA',
    finalOdds: bet.finalOdds ?? null, venueName: bet.venueName ?? undefined,
    groupId: null, candidateRank: null, candidateCount: null, oddsCapturedAt: null, predictedAtAtBet: null,
  }))
  return [...bets, ...adapted].sort((a, b) => b.placedAt.localeCompare(a.placedAt) || a.id.localeCompare(b.id))
}
