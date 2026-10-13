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

/**
 * Conservative fractional-Kelly sizing for mutually exclusive trifecta
 * outcomes. Uncertainty is deducted at 1.96 standard deviations; positive
 * conservative edges receive proportional Kelly weights, scaled to 25% of
 * the available virtual balance and clipped to the approved per-race cap.
 */
export function sizeExperimentalPortfolio(
  tickets: ExperimentalTicket[],
  availableBalance: number,
  perRaceCap = 1000,
  fraction = 0.25,
): ExperimentalStake[] {
  if (!Number.isSafeInteger(availableBalance) || availableBalance < 0
      || !Number.isSafeInteger(perRaceCap) || perRaceCap < 0
      || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return [];
  if (!tickets.length || new Set(tickets.map(x => x.selection)).size !== tickets.length) return [];
  if (tickets.some(x => !Number.isFinite(x.probability) || x.probability < 0 || x.probability > 1
      || !Number.isFinite(x.probStd) || x.probStd < 0 || !Number.isFinite(x.odds) || x.odds <= 1)) return [];

  const scored = tickets.map(ticket => {
    const conservativeProbability = Math.max(0, ticket.probability - 1.96 * ticket.probStd);
    const expectedRoi = conservativeProbability * ticket.odds - 1;
    const kelly = expectedRoi > 0 ? expectedRoi / (ticket.odds - 1) : 0;
    return { ...ticket, conservativeProbability, expectedRoi, kelly };
  });
  const qualified = scored.filter(x => x.kelly > 0);
  const kellyTotal = qualified.reduce((sum, x) => sum + x.kelly, 0);
  if (kellyTotal <= 0 || availableBalance <= 0 || perRaceCap <= 0) return [];
  const portfolioFraction = Math.min(fraction, fraction * Math.min(1, kellyTotal), 1, perRaceCap / availableBalance);
  const totalStake = Math.floor(availableBalance * portfolioFraction);
  if (totalStake <= 0) return [];

  let allocated = 0;
  const output: ExperimentalStake[] = [];
  qualified.forEach((x, index) => {
    const stake = index === qualified.length - 1
      ? totalStake - allocated
      : Math.floor(totalStake * x.kelly / kellyTotal);
    allocated += stake;
    if (stake > 0) output.push({
      selection: x.selection,
      probability: x.probability,
      probStd: x.probStd,
      odds: x.odds,
      conservativeProbability: x.conservativeProbability,
      expectedRoi: x.expectedRoi,
      stake,
    });
  });
  return output;
}
