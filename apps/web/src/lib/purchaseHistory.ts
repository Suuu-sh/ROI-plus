import type { Bet } from '@edgelab/shared/src/types'
import type { ExperimentalBet } from './api'

/** A virtual ticket from any ledger; trifecta tickets from the former experiments count as ordinary purchases. */
export type HistoryBet = Bet & { recordKind?: ExperimentalBet['recordKind']; repairReason?: string | null; officialSelection?: string | null }

export function mergePurchaseHistory(bets: Bet[], ...ledgers: ExperimentalBet[][]): HistoryBet[] {
  const adapted: HistoryBet[] = ledgers.flat().map((bet) => ({
    ...bet, id: `${bet.recordKind}:${bet.id}`, mode: 'auto', edgeLabel: 'INSUFFICIENT_DATA',
    finalOdds: bet.finalOdds ?? null, venueName: bet.venueName ?? undefined,
    groupId: null, candidateRank: null, candidateCount: null, oddsCapturedAt: null, predictedAtAtBet: null,
  }))
  return [...bets, ...adapted].sort((a, b) => b.placedAt.localeCompare(a.placedAt) || a.id.localeCompare(b.id))
}
