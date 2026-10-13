export type ExperimentalTicket = {
  selection: string;
  probability: number;
  probStd: number;
  odds: number;
};

export type ExperimentalStake = ExperimentalTicket & {
  conservativeProbability: number;
  expectedRoi: number;
  stake: number;
};

export type ExperimentalSizingResult = {
  stakes: ExperimentalStake[];
  abstentionReason: 'no_conservative_positive_edge' | 'virtual_balance_unavailable' | 'minimum_virtual_stake_not_reached' | null;
};

/**
 * Conservative fractional-Kelly sizing for mutually exclusive trifecta
 * outcomes. Uncertainty is deducted at 1.96 standard deviations; positive
 * conservative edges receive proportional Kelly weights, scaled to 25% of
 * the available virtual balance and clipped to the approved per-race cap.
 */
export function sizeExperimentalPortfolioResult(
  tickets: ExperimentalTicket[],
  availableBalance: number,
  perRaceCap = 1000,
  fraction = 0.25,
): ExperimentalSizingResult {
  const abstain = (abstentionReason: NonNullable<ExperimentalSizingResult['abstentionReason']>): ExperimentalSizingResult => ({ stakes: [], abstentionReason });
  if (!Number.isSafeInteger(availableBalance) || availableBalance < 0
      || !Number.isSafeInteger(perRaceCap) || perRaceCap < 0
      || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return abstain('no_conservative_positive_edge');
  if (!tickets.length || new Set(tickets.map(x => x.selection)).size !== tickets.length) return abstain('no_conservative_positive_edge');
  if (tickets.some(x => !Number.isFinite(x.probability) || x.probability < 0 || x.probability > 1
      || !Number.isFinite(x.probStd) || x.probStd < 0 || !Number.isFinite(x.odds) || x.odds <= 1)) return abstain('no_conservative_positive_edge');

  const scored = tickets.map(ticket => {
    const conservativeProbability = Math.max(0, ticket.probability - 1.96 * ticket.probStd);
    const expectedRoi = conservativeProbability * ticket.odds - 1;
    const kelly = expectedRoi > 0 ? expectedRoi / (ticket.odds - 1) : 0;
    return { ...ticket, conservativeProbability, expectedRoi, kelly };
  });
  const qualified = scored.filter(x => x.kelly > 0);
  const kellyTotal = qualified.reduce((sum, x) => sum + x.kelly, 0);
  if (kellyTotal <= 0) return abstain('no_conservative_positive_edge');
  if (availableBalance <= 0 || perRaceCap <= 0) return abstain('virtual_balance_unavailable');
  const portfolioFraction = Math.min(fraction, fraction * Math.min(1, kellyTotal), 1, perRaceCap / availableBalance);
  const totalUnits = Math.floor(availableBalance * portfolioFraction / 100);
  if (totalUnits <= 0) return abstain('minimum_virtual_stake_not_reached');

  // Allocate whole 100-yen units by largest remainder. This preserves the
  // portfolio budget while preventing any placed ticket from being under 100.
  const shares = qualified.map((x, index) => {
    const exactUnits = totalUnits * x.kelly / kellyTotal;
    const units = Math.floor(exactUnits);
    return { x, index, units, remainder: exactUnits - units };
  });
  let unitsLeft = totalUnits - shares.reduce((sum, share) => sum + share.units, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (unitsLeft <= 0) break;
    share.units++;
    unitsLeft--;
  }
  const stakes = shares.filter(share => share.units > 0).map(({ x, units }) => ({
      selection: x.selection,
      probability: x.probability,
      probStd: x.probStd,
      odds: x.odds,
      conservativeProbability: x.conservativeProbability,
      expectedRoi: x.expectedRoi,
      stake: units * 100,
    }));
  return stakes.length ? { stakes, abstentionReason: null } : abstain('minimum_virtual_stake_not_reached');
}

export function sizeExperimentalPortfolio(
  tickets: ExperimentalTicket[], availableBalance: number, perRaceCap = 1000, fraction = 0.25,
): ExperimentalStake[] {
  return sizeExperimentalPortfolioResult(tickets, availableBalance, perRaceCap, fraction).stakes;
}
