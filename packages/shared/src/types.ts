export type Sport = 'horse' | 'boat';
export type DataOrigin = 'sample' | 'real';
export type BetType = 'win' | 'place' | 'quinella' | 'exacta' | 'wide' | 'trio' | 'trifecta';
export type EdgeLabel = 'HIGH_EDGE' | 'POSITIVE_EDGE' | 'NEUTRAL' | 'NEGATIVE_EDGE' | 'INSUFFICIENT_DATA';
export type RaceStatus = 'scheduled' | 'closed' | 'finished' | 'cancelled';
export type ModelStatus = 'untrained' | 'candidate' | 'active' | 'retired';
export type BetStatus = 'open' | 'won' | 'lost' | 'void';

export interface RaceSummary {
  id: string; sport: Sport; venueId: string; venueName: string; raceDate: string; raceNo: number;
  name: string | null; distance: number | null; surface: string | null; trackCondition: string | null;
  weather: string | null; postTime: string | null; status: RaceStatus; dataOrigin: DataOrigin;
  entryCount: number; topEdge: EdgeLabel; bestExpectedRoi: number | null;
}

export interface EntryView {
  number: number; frame: number | null; name: string;
  jockey: string | null; trainer: string | null; weightCarried: number | null; horseWeight: number | null;
  racerClass: string | null; nationalWinRate: number | null; localWinRate: number | null;
  motorNo: string | null; motor2Rate: number | null; boatNo: string | null; boat2Rate: number | null;
  exhibitionTime: number | null; startExhibition: number | null;
  odds: number | null; oddsCapturedAt: string | null;
  probability: number | null; probStd: number | null;
  breakEvenProb: number | null; expectedRoi: number | null; conservativeRoi: number | null;
  edge: EdgeLabel; finishOrder: number | null;
}

export interface RaceDetail extends RaceSummary {
  windSpeed: number | null; waveHeight: number | null;
  model: ModelInfo | null; predictedAt: string | null; dataFreshnessMinutes: number | null;
  entries: EntryView[];
  payouts: { betType: BetType; selection: string; payout: number; popularity: number | null }[];
}

export interface EdgeCandidate {
  raceId: string; sport: Sport; venueName: string; raceNo: number; postTime: string | null;
  number: number; name: string; probability: number; probStd: number | null; odds: number;
  breakEvenProb: number; expectedRoi: number; conservativeRoi: number; edge: EdgeLabel;
  modelId: string; dataFreshnessMinutes: number | null; dataOrigin: DataOrigin;
}

export interface Bet {
  id: string; raceId: string; sport: Sport; betType: BetType; selection: string; stake: number;
  mode: 'manual' | 'auto'; predictedProb: number | null; oddsAtBet: number | null; expectedRoi: number | null;
  edgeLabel: EdgeLabel; modelId: string | null; placedAt: string; status: BetStatus;
  payout: number | null; profit: number | null; finalOdds: number | null; settledAt: string | null;
  dataOrigin: DataOrigin; venueName?: string; raceNo?: number;
}

export interface Overview {
  initialBankroll: number; bankroll: number; totalProfit: number; roi: number | null; // 回収率 = payout/stake
  betCount: number; settledCount: number; hitRate: number | null; maxDrawdown: number; maxDrawdownPct: number;
  equityCurve: { at: string; bankroll: number }[];
}

export interface Breakdown {
  bySport: { sport: Sport; bets: number; stake: number; payout: number; profit: number; roi: number | null; hitRate: number | null }[];
  byMonth: { month: string; sport: Sport; stake: number; payout: number; profit: number }[];
  byEdge: { bucket: string; bets: number; stake: number; payout: number; roi: number | null }[];
  byModel: { modelId: string; bets: number; stake: number; payout: number; roi: number | null }[];
  calibration: { sport: Sport; bin: number; predicted: number; actual: number; count: number }[];
  oddsDrift: { bets: number; avgOddsAtBet: number | null; avgFinalOdds: number | null; evLostCount: number };
}

export interface ModelMetrics {
  logLoss?: number; brier?: number; ece?: number; roi?: number; expectedRoi?: number; maxDrawdown?: number;
  nRaces?: number; baselineLogLoss?: number;
}
export interface ModelInfo {
  id: string; sport: Sport; betType: BetType; version: string; algorithm: string; status: ModelStatus;
  trainFrom: string | null; trainTo: string | null; validFrom: string | null; validTo: string | null;
  testFrom: string | null; testTo: string | null; nTrain: number | null; metrics: ModelMetrics; trainedAt: string | null; notes: string | null;
}

export interface CollectionSource {
  source: string; sport: Sport; enabled: boolean; lastRunAt: string | null; lastSuccessAt: string | null;
  successRate: number | null; runs: number; records: number; freshnessMinutes: number | null; note: string | null;
}
export interface CollectionStatus {
  sources: CollectionSource[];
  errors: { at: string; source: string; error: string }[];
  tableCounts: Record<string, number>;
  freeTier: { d1RowsApprox: number; d1RowLimitNote: string };
}
