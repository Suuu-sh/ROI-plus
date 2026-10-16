/** Native Worker inference for the SHA-bound experimental logistic ensemble. */

export const EXPERIMENTAL_NATIVE_MODEL_SCHEMA = 'experimental-trifecta-worker-model-v1';
export const EXPERIMENTAL_FEATURE_SCHEMA = 'boat-prerace-v2-no-weather-experimental-v1';
export const EXPERIMENTAL_FEATURE_COLUMNS = [
  'lane', 'national_win_rate', 'local_win_rate', 'motor_2rate', 'boat_2rate',
  'national_2rate', 'local_2rate', 'age', 'weight_carried', 'racer_class_code',
  'racer_history_starts', 'racer_history_wins', 'racer_history_win_rate',
  'exhibition_time', 'tilt', 'observed_weight', 'start_exhibition',
  'start_exhibition_course', 'start_exhibition_false_start',
] as const;

export interface NativeExperimentalMember {
  medians: number[];
  means: number[];
  scales: number[];
  coefficients: number[];
}

export interface NativeExperimentalModel {
  schema: typeof EXPERIMENTAL_NATIVE_MODEL_SCHEMA;
  modelId: string;
  artifactSha256: string;
  temperature: number;
  columns: string[];
  members: NativeExperimentalMember[];
}

export interface NativeTicketProbability {
  selection: string;
  probability: number;
  probStd: number | null;
}

export interface NativeRaceFeatureInput {
  race: Record<string, unknown>;
  entries: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  /** Complete six-entry/six-result real races, matching Python completed_racer_history(). */
  historyRaces: Array<{
    race: Record<string, unknown>;
    entries: Array<Record<string, unknown>>;
    results: Array<Record<string, unknown>>;
  }>;
  /** SHA-bound/locally validated history totals through one date, exported from Python history. */
  historySnapshot?: {
    schema: 'native-racer-history-v1';
    asOf: string;
    throughRaceDate: string;
    totals: Record<string, { starts: number; wins: number }>;
  };
  predictedAt: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const RACER_ID = /^\d{4,5}$/;
const WIND_DEGREES: Record<string, number> = {
  '北': 0, '北東': 45, '東': 90, '南東': 135, '南': 180, '南西': 225, '西': 270, '北西': 315,
};
const CLASS_CODES: Record<string, number> = { A1: 4, A2: 3, B1: 2, B2: 1 };

export function validateNativeExperimentalModel(
  candidate: unknown, expectedModelId: string, expectedArtifactSha256: string,
): NativeExperimentalModel {
  if (!candidate || typeof candidate !== 'object') throw new Error('invalid-model');
  const model = candidate as Partial<NativeExperimentalModel>;
  if (model.schema !== EXPERIMENTAL_NATIVE_MODEL_SCHEMA || model.modelId !== expectedModelId
      || model.artifactSha256 !== expectedArtifactSha256 || !SHA256.test(expectedArtifactSha256)
      || !Number.isFinite(model.temperature) || !Array.isArray(model.columns)
      || model.columns.length !== EXPERIMENTAL_FEATURE_COLUMNS.length
      || model.columns.some((column, index) => column !== EXPERIMENTAL_FEATURE_COLUMNS[index])
      || !Array.isArray(model.members) || model.members.length < 1 || model.members.length > 5) {
    throw new Error('invalid-model');
  }
  for (const member of model.members) {
    if (!member || !Array.isArray(member.medians) || !Array.isArray(member.means)
        || !Array.isArray(member.scales) || !Array.isArray(member.coefficients)
        || [member.medians, member.means, member.scales, member.coefficients]
          .some(values => values.length !== EXPERIMENTAL_FEATURE_COLUMNS.length)
        || [...member.medians, ...member.means, ...member.scales, ...member.coefficients]
          .some(value => !Number.isFinite(value)) || member.scales.some(scale => scale <= 0)) {
      throw new Error('invalid-model');
    }
  }
  return model as NativeExperimentalModel;
}

function logSumExp(scores: number[], indices: number[]): number {
  let peak = -Infinity;
  for (const index of indices) if (scores[index] > peak) peak = scores[index];
  let total = 0;
  for (const index of indices) total += Math.exp(scores[index] - peak);
  return peak + Math.log(total);
}

function memberDistribution(member: NativeExperimentalMember, model: NativeExperimentalModel,
                            features: Array<Record<string, unknown>>): Map<string, number> {
  const temperature = Math.max(0.05, model.temperature);
  const scores = features.map(row => {
    let score = 0;
    for (let column = 0; column < EXPERIMENTAL_FEATURE_COLUMNS.length; column++) {
      const value = row[EXPERIMENTAL_FEATURE_COLUMNS[column]];
      const numeric = value !== null && value !== undefined && value !== '' ? Number(value) : NaN;
      const filled = Number.isFinite(numeric) ? numeric : member.medians[column];
      score += ((filled - member.means[column]) / member.scales[column]) * member.coefficients[column];
    }
    return score / temperature;
  });
  const all = [0, 1, 2, 3, 4, 5];
  const result = new Map<string, number>();
  let totalProbability = 0;
  for (const a of all) for (const b of all) {
    if (b === a) continue;
    for (const c of all) {
      if (c === a || c === b) continue;
      const remainingAfterFirst = all.filter(index => index !== a);
      const remainingAfterSecond = remainingAfterFirst.filter(index => index !== b);
      const logProbability = scores[a] - logSumExp(scores, all)
        + scores[b] - logSumExp(scores, remainingAfterFirst)
        + scores[c] - logSumExp(scores, remainingAfterSecond);
      const probability = Math.exp(logProbability);
      const selection = `${Number(features[a].lane)}-${Number(features[b].lane)}-${Number(features[c].lane)}`;
      result.set(selection, probability);
      totalProbability += probability;
    }
  }
  if (!Number.isFinite(totalProbability) || totalProbability <= 0) throw new Error('invalid-prediction');
  for (const [selection, probability] of result) result.set(selection, probability / totalProbability);
  return result;
}

/** Matches Python _scores + ordered_triple_probabilities + ensemble_ordered_triples. */
export function predictNativeExactTrifecta(
  model: NativeExperimentalModel, features: Array<Record<string, unknown>>,
): NativeTicketProbability[] {
  if (features.length !== 6 || features.some(row => !row || !Number.isInteger(Number(row.lane))
      || Number(row.lane) < 1 || Number(row.lane) > 6)
      || [...features].map(row => Number(row.lane)).sort((a, b) => a - b).join(',') !== '1,2,3,4,5,6') {
    throw new Error('invalid-feature-group');
  }
  const members = model.members.map(member => memberDistribution(member, model, features));
  const selections = [...members[0].keys()].sort();
  return selections.map(selection => {
    const values = members.map(member => member.get(selection)!);
    const probability = values.reduce((sum, value) => sum + value, 0) / values.length;
    const probStd = values.length >= 5
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - probability) ** 2, 0) / values.length)
      : null;
    return { selection, probability, probStd };
  });
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const millis = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value ? value : null;
}

function parseInstant(value: unknown, requireZone = false): number | null {
  if (typeof value !== 'string') return null;
  if (requireZone && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${sortedJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validObservation(row: Record<string, unknown>, race: Record<string, unknown>, predictedAt: number): Record<string, unknown> | null {
  if (row.fixture || row.data_origin !== 'real' || race.data_origin !== 'real'
      || row.race_id !== race.id || row.kind !== 'exhibition' || typeof row.source_sha256 !== 'string'
      || !SHA256.test(row.source_sha256)) return null;
  try {
    const url = new URL(String(row.source_url ?? ''));
    const expectedDate = String(race.race_date ?? '').replaceAll('-', '');
    if (url.protocol !== 'https:' || url.hostname !== 'www.boatrace.jp'
        || url.pathname !== '/owpc/pc/race/beforeinfo'
        || url.searchParams.get('hd') !== expectedDate
        || url.searchParams.get('jcd') !== String(race.venue_id)
        || url.searchParams.get('rno') !== String(race.race_no)) return null;
  } catch { return null; }
  const fetchedAt = parseInstant(row.fetched_at, true);
  const availableAt = parseInstant(row.available_at, true);
  if (fetchedAt === null || fetchedAt !== availableAt || fetchedAt > predictedAt
      || predictedAt - fetchedAt > 30 * 60_000) return null;
  const sourceObservedAt = row.source_observed_at;
  if (sourceObservedAt !== null && sourceObservedAt !== undefined) {
    const sourceTime = parseInstant(sourceObservedAt, true);
    if (sourceTime === null || sourceTime > predictedAt || sourceTime > fetchedAt) return null;
  }
  const values = parseObject(row.values_json);
  const usable = ['exhibition_time', 'tilt', 'weight', 'start_exhibition', 'start_exhibition_course']
    .some(field => finiteNumber(values[field]) !== null) || typeof values.start_exhibition_false_start === 'boolean';
  return usable ? values : null;
}

function validateHistorySnapshot(snapshot: NonNullable<NativeRaceFeatureInput['historySnapshot']>,
                                 predictedAt: number, targetDate: string): Map<string, { starts: number; wins: number }> {
  const asOf = parseInstant(snapshot.asOf, true);
  const throughRaceDate = parseDate(snapshot.throughRaceDate);
  if (snapshot.schema !== 'native-racer-history-v1' || asOf === null || asOf > predictedAt
      || !throughRaceDate || throughRaceDate >= targetDate || !snapshot.totals
      || typeof snapshot.totals !== 'object' || Array.isArray(snapshot.totals)) {
    throw new Error('invalid-history-snapshot');
  }
  const totals = new Map<string, { starts: number; wins: number }>();
  for (const [racerId, value] of Object.entries(snapshot.totals)) {
    if (!RACER_ID.test(racerId) || !value || !Number.isInteger(value.starts) || value.starts < 0
        || !Number.isInteger(value.wins) || value.wins < 0 || value.wins > value.starts) {
      throw new Error('invalid-history-snapshot');
    }
    totals.set(racerId, { starts: value.starts, wins: value.wins });
  }
  return totals;
}

function buildHistory(input: NativeRaceFeatureInput, asOf: number, targetDate: string,
                      afterRaceDate?: string): Array<{
  raceId: string; racerId: string; raceDate: string; finishOrder: number;
}> {
  const history: Array<{ raceId: string; racerId: string; raceDate: string; finishOrder: number }> = [];
  const seenRaceIds = new Set<string>();
  for (const group of input.historyRaces) {
    const race = group.race;
    const raceDate = parseDate(race.race_date);
    const raceId = typeof race.id === 'string' ? race.id : '';
    if (race.sport !== 'boat' || race.data_origin !== 'real' || race.status !== 'finished'
        || !raceId || seenRaceIds.has(raceId) || !raceDate || raceDate >= targetDate
        || (afterRaceDate !== undefined && raceDate <= afterRaceDate)
        || group.entries.length !== 6 || group.results.length !== 6) continue;
    const entries = new Map<string, Record<string, unknown>>();
    const results = new Map<string, Record<string, unknown>>();
    let invalid = false;
    for (const entry of group.entries) {
      const number = String(entry.number);
      const availableAt = parseInstant(entry.available_at);
      if (entry.data_origin !== 'real' || !['1', '2', '3', '4', '5', '6'].includes(number)
          || entries.has(number) || availableAt === null) { invalid = true; break; }
      entries.set(number, entry);
    }
    if (invalid || entries.size !== 6) continue;
    for (const result of group.results) {
      const number = String(result.number);
      const finishOrder = Number(result.finish_order);
      const availableAt = parseInstant(result.available_at);
      if (result.data_origin !== 'real' || !['1', '2', '3', '4', '5', '6'].includes(number)
          || results.has(number) || !Number.isInteger(finishOrder) || finishOrder < 1 || finishOrder > 6
          || availableAt === null) { invalid = true; break; }
      results.set(number, result);
    }
    if (invalid || results.size !== 6
        || [...results.values()].map(row => Number(row.finish_order)).sort((a, b) => a - b).join(',') !== '1,2,3,4,5,6') continue;
    seenRaceIds.add(raceId);
    for (const [number, entry] of entries) {
      const extra = parseObject(entry.features_json);
      const racerId = extra.racer_id;
      if (typeof racerId !== 'string' || !RACER_ID.test(racerId)) continue;
      const entryAvailable = parseInstant(entry.available_at)!;
      const resultAvailable = parseInstant(results.get(number)!.available_at)!;
      if (entryAvailable > asOf || resultAvailable > asOf) continue;
      history.push({ raceId, racerId, raceDate, finishOrder: Number(results.get(number)!.finish_order) });
    }
  }
  return history;
}

/** Build the same 19 weather-free per-entry features as Python's V2 builder. */
export function buildNativeExperimentalFeatures(input: NativeRaceFeatureInput): Array<Record<string, unknown>> {
  const race = input.race;
  const raceDate = parseDate(race.race_date);
  const predictedAt = parseInstant(input.predictedAt, true);
  if (race.data_origin !== 'real' || race.sport !== 'boat' || race.status !== 'scheduled'
      || !raceDate || predictedAt === null || input.entries.length !== 6) throw new Error('invalid-feature-input');
  for (const entry of input.entries) {
    const availableAt = parseInstant(entry.available_at, true);
    if (entry.data_origin !== 'real' || availableAt === null || availableAt > predictedAt) {
      throw new Error('invalid-feature-input');
    }
  }
  const byLane = new Map<number, Record<string, unknown>>();
  for (const entry of input.entries) {
    const lane = Number(entry.number);
    if (!Number.isInteger(lane) || lane < 1 || lane > 6 || byLane.has(lane)) throw new Error('invalid-feature-input');
    byLane.set(lane, entry);
  }
  if (byLane.size !== 6) throw new Error('invalid-feature-input');

  const snapshotTotals = input.historySnapshot
    ? validateHistorySnapshot(input.historySnapshot, predictedAt, raceDate) : new Map<string, { starts: number; wins: number }>();
  const historyThroughDate = input.historySnapshot?.throughRaceDate;
  const history = buildHistory(input, predictedAt, raceDate, historyThroughDate);
  const historyByRacer = new Map<string, typeof history>();
  for (const row of history) {
    const rows = historyByRacer.get(row.racerId) ?? [];
    rows.push(row);
    historyByRacer.set(row.racerId, rows);
  }
  const exhibitions = new Map<number, { fetchedAt: number; digest: string; canonical: string; values: Record<string, unknown> }>();
  for (const observation of input.observations) {
    const values = validObservation(observation, race, predictedAt);
    const lane = Number(observation.entry_number);
    const fetchedAt = parseInstant(observation.fetched_at, true);
    if (!values || !Number.isInteger(lane) || lane < 1 || lane > 6 || fetchedAt === null) continue;
    const candidate = { fetchedAt, digest: String(observation.source_sha256), canonical: sortedJson(values), values };
    const previous = exhibitions.get(lane);
    if (!previous || candidate.fetchedAt > previous.fetchedAt
        || (candidate.fetchedAt === previous.fetchedAt && (candidate.digest > previous.digest
          || (candidate.digest === previous.digest && candidate.canonical > previous.canonical)))) exhibitions.set(lane, candidate);
  }

  const valuesByLane = new Map<number, Record<string, unknown>>();
  const firstNumber = (...candidates: unknown[]) => {
    for (const candidate of candidates) {
      const numeric = finiteNumber(candidate);
      if (numeric !== null) return numeric;
    }
    return null;
  };
  for (let lane = 1; lane <= 6; lane++) {
    const entry = byLane.get(lane)!;
    const extra = parseObject(entry.features_json);
    const racerId = typeof extra.racer_id === 'string' ? extra.racer_id : null;
    const prior = racerId ? (historyByRacer.get(racerId) ?? []).filter(row => row.raceDate < raceDate) : [];
    const snapshot = racerId ? snapshotTotals.get(racerId) : undefined;
    const starts = (snapshot?.starts ?? 0) + prior.length;
    const wins = (snapshot?.wins ?? 0) + prior.filter(row => row.finishOrder === 1).length;
    const exhibition = exhibitions.get(lane)?.values ?? {};
    const className = String(entry.racer_class ?? '').toUpperCase();
    valuesByLane.set(lane, {
      lane,
      national_win_rate: finiteNumber(entry.national_win_rate),
      local_win_rate: finiteNumber(entry.local_win_rate),
      motor_2rate: firstNumber(entry.motor_2rate, entry.motor2_rate),
      boat_2rate: firstNumber(entry.boat_2rate, entry.boat2_rate),
      national_2rate: finiteNumber(extra.national_2rate),
      local_2rate: finiteNumber(extra.local_2rate),
      age: finiteNumber(extra.age),
      weight_carried: finiteNumber(entry.weight_carried),
      racer_class_code: CLASS_CODES[className] ?? null,
      racer_history_starts: starts,
      racer_history_wins: wins,
      racer_history_win_rate: starts ? wins / starts : null,
      exhibition_time: finiteNumber(exhibition.exhibition_time),
      tilt: finiteNumber(exhibition.tilt),
      observed_weight: finiteNumber(exhibition.weight),
      start_exhibition: finiteNumber(exhibition.start_exhibition),
      start_exhibition_course: finiteNumber(exhibition.start_exhibition_course),
      start_exhibition_false_start: typeof exhibition.start_exhibition_false_start === 'boolean'
        ? (exhibition.start_exhibition_false_start ? 1 : 0) : null,
    });
  }
  return Array.from(valuesByLane.values());
}
