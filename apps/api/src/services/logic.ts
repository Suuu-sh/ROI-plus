import { conservativeRoi, edgeLabel, expectedRoi, type EdgeLabel, type ModelStatus } from '@edgelab/shared';
export function validateStake(stake: unknown, unitStake: number): stake is number {
  return Number.isInteger(stake) && (stake as number) > 0 && Number.isInteger(unitStake) && unitStake > 0 && (stake as number) % unitStake === 0;
}
export function candidate(p: number | null, odds: number | null, std: number | null, modelStatus: ModelStatus | null, maxStd: number) {
  const expected = p === null || odds === null ? null : expectedRoi(p, odds);
  const conservative = p === null || odds === null || std === null ? null : conservativeRoi(p, std, odds);
  const edge: EdgeLabel = edgeLabel(p, odds, modelStatus, std, maxStd);
  return { expectedRoi: expected, conservativeRoi: conservative, edge };
}
export function settleValues(stake: number, payoutPer100: number | null, won: boolean) {
  if (won && payoutPer100 !== null) return { payout: stake / 100 * payoutPer100, profit: stake / 100 * payoutPer100 - stake, finalOdds: payoutPer100 / 100 };
  return { payout: 0, profit: -stake, finalOdds: null };
}
export function betId() { return crypto.randomUUID(); }
