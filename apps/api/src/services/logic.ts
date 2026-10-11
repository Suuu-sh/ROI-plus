import { conservativeRoi, edgeLabel, expectedRoi, type EdgeLabel, type ModelStatus } from '@edgelab/shared';
export function validateStake(stake: unknown, unitStake: number): stake is number {
  return Number.isInteger(stake) && (stake as number) > 0 && Number.isInteger(unitStake) && unitStake > 0 && (stake as number) % unitStake === 0;
}
export function validateYenStake(stake: unknown): stake is number {
  return Number.isSafeInteger(stake) && (stake as number) > 0 && (stake as number) <= 2_147_483_647;
}
export function candidate(p: number | null, odds: number | null, std: number | null, modelStatus: ModelStatus | null, maxStd: number) {
  const expected = p === null || odds === null ? null : expectedRoi(p, odds);
  const conservative = p === null || odds === null || std === null ? null : conservativeRoi(p, std, odds);
  const edge: EdgeLabel = edgeLabel(p, odds, modelStatus, std, maxStd);
  return { expectedRoi: expected, conservativeRoi: conservative, edge };
}
export function settleValues(stake: number, payoutPer100: number | null, won: boolean) {
  // D1 keeps yen-denominated payouts as integers. Fractional-yen virtual returns
  // are rounded down per ticket, consistently for stored and counterfactual bets.
  if (won && payoutPer100 !== null) {
    const payout = payoutYen(stake, payoutPer100);
    return { payout, profit: payout - stake, finalOdds: payoutPer100 / 100 };
  }
  return { payout: 0, profit: -stake, finalOdds: null };
}
export function payoutYen(stake: number, payoutPer100: number): number {
  return Number((BigInt(stake) * BigInt(payoutPer100)) / 100n);
}
export function betId() { return crypto.randomUUID(); }
