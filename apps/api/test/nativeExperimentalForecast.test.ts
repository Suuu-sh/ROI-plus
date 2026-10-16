import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_FEATURE_COLUMNS,
  EXPERIMENTAL_NATIVE_MODEL_SCHEMA,
  buildNativeExperimentalFeatures,
  predictNativeExactTrifecta,
  validateNativeExperimentalModel,
} from '../src/services/nativeExperimentalForecast.js';

const fixture = JSON.parse(readFileSync(
  new URL('../../../ml/tests/fixtures/experimental_worker_equivalence.synthetic.json', import.meta.url), 'utf8',
)) as {
  columns: string[];
  features: Array<Array<number | null>>;
  numbers: number[];
  temperature: number;
  members: Array<{ medians: number[]; means: number[]; scales: number[]; coefficients: number[] }>;
  meanProbabilities: Record<string, number>;
  populationStdProbabilities: Record<string, number>;
};
const actualModelFixture = JSON.parse(readFileSync(
  new URL('../../../ml/tests/fixtures/experimental_worker_equivalence.actual-model.synthetic.json', import.meta.url), 'utf8',
)) as typeof fixture & { modelId: string; artifactSha256: string };
const actualBundle = JSON.parse(readFileSync(
  new URL('../src/models/experimental-worker-model.json', import.meta.url), 'utf8',
)) as unknown;

const modelId = 'synthetic-model';
const artifactSha256 = 'a'.repeat(64);
function model() {
  return validateNativeExperimentalModel({
    schema: EXPERIMENTAL_NATIVE_MODEL_SCHEMA,
    modelId,
    artifactSha256,
    temperature: fixture.temperature,
    columns: fixture.columns,
    members: fixture.members,
  }, modelId, artifactSha256);
}

describe('native experimental forecast', () => {
  it('matches the synthetic Python ensemble probabilities for all 120 ordered tickets', () => {
    expect(fixture.columns).toEqual([...EXPERIMENTAL_FEATURE_COLUMNS]);
    const rows = fixture.features.map((values, index) => Object.fromEntries(
      fixture.columns.map((column, columnIndex) => [column, values[columnIndex]])
        .concat([['lane', fixture.numbers[index]]]),
    ));
    const actual = predictNativeExactTrifecta(model(), rows);
    expect(actual).toHaveLength(120);
    for (const ticket of actual) {
      expect(ticket.probability).toBeCloseTo(fixture.meanProbabilities[ticket.selection], 12);
      expect(ticket.probStd).toBeCloseTo(fixture.populationStdProbabilities[ticket.selection], 12);
    }
    expect(actual.reduce((sum, ticket) => sum + ticket.probability, 0)).toBeCloseTo(1, 12);
  });

  it('matches the exported artifact on the independent synthetic actual-weight fixture', () => {
    const artifact = validateNativeExperimentalModel(
      actualBundle, actualModelFixture.modelId, actualModelFixture.artifactSha256,
    );
    const rows = actualModelFixture.features.map((values, index) => Object.fromEntries(
      actualModelFixture.columns.map((column, columnIndex) => [column, values[columnIndex]])
        .concat([['lane', actualModelFixture.numbers[index]]]),
    ));
    const actual = predictNativeExactTrifecta(artifact, rows);
    expect(actual).toHaveLength(120);
    for (const ticket of actual) {
      expect(ticket.probability).toBeCloseTo(actualModelFixture.meanProbabilities[ticket.selection], 12);
      expect(ticket.probStd).toBeCloseTo(actualModelFixture.populationStdProbabilities[ticket.selection], 12);
    }
  });

  it('rejects model identity, feature order, and malformed feature groups', () => {
    const candidate = {
      schema: EXPERIMENTAL_NATIVE_MODEL_SCHEMA,
      modelId,
      artifactSha256,
      temperature: fixture.temperature,
      columns: fixture.columns,
      members: fixture.members,
    };
    expect(() => validateNativeExperimentalModel(candidate, 'other-model', artifactSha256)).toThrow('invalid-model');
    expect(() => validateNativeExperimentalModel(candidate, modelId, 'b'.repeat(64))).toThrow('invalid-model');
    expect(() => validateNativeExperimentalModel({ ...candidate, columns: [...fixture.columns].reverse() }, modelId, artifactSha256))
      .toThrow('invalid-model');
    const rows = fixture.features.map((values, index) => Object.fromEntries(
      fixture.columns.map((column, columnIndex) => [column, values[columnIndex]])
        .concat([['lane', fixture.numbers[index]]]),
    ));
    rows[5].lane = 5;
    expect(() => predictNativeExactTrifecta(model(), rows)).toThrow('invalid-feature-group');
  });

  it('builds the weather-free 19-column features from real, pre-cutoff inputs', () => {
    const predictedAt = '2026-10-16T00:00:00Z';
    const race = {
      id: 'synthetic-race', sport: 'boat', data_origin: 'real', status: 'scheduled',
      race_date: '2026-10-16', venue_id: 21, race_no: 3,
      betting_cutoff_at: '2026-10-16T00:00:00Z',
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      number: index + 1, data_origin: 'real', available_at: '2026-10-15T23:00:00Z',
      racer_class: ['A1', 'A2', 'B1', 'B2', 'A1', 'B1'][index],
      national_win_rate: '6.50', local_win_rate: '5.25', motor_2rate: '35.20', boat_2rate: '34.10',
      weight_carried: '52.0', features_json: JSON.stringify({ racer_id: `12${String(index + 1).padStart(3, '0')}`, age: 34, national_2rate: 42.1 }),
    }));
    const features = buildNativeExperimentalFeatures({
      race, entries,
      observations: [{
        data_origin: 'real', race_id: race.id, kind: 'exhibition', entry_number: 1,
        source_sha256: 'c'.repeat(64),
        source_url: 'https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261016&jcd=21&rno=3',
        fetched_at: '2026-10-15T23:55:00Z', available_at: '2026-10-15T23:55:00Z',
        source_observed_at: '2026-10-15T23:54:00Z',
        values_json: JSON.stringify({ exhibition_time: '6.72', tilt: '0', weight: '52.0' }),
      }],
      historyRaces: [], predictedAt,
    });
    expect(features).toHaveLength(6);
    expect(Object.keys(features[0])).toEqual([...EXPERIMENTAL_FEATURE_COLUMNS]);
    expect(features.map(row => row.lane)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(features[0]).toMatchObject({ lane: 1, national_win_rate: 6.5, motor_2rate: 35.2, racer_class_code: 4 });
    expect(features[0]).toMatchObject({ exhibition_time: 6.72, tilt: 0, observed_weight: 52 });
  });

  it('rejects fixtures, incomplete rosters, and invalid prediction timestamps', () => {
    const race = {
      id: 'synthetic-race', sport: 'boat', data_origin: 'real', status: 'scheduled',
      race_date: '2026-10-16', venue_id: 21, race_no: 3,
      betting_cutoff_at: '2026-10-16T00:00:00Z',
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      number: index + 1, data_origin: 'real', available_at: '2026-10-15T23:00:00Z', features_json: '{}',
    }));
    expect(() => buildNativeExperimentalFeatures({
      race, entries: entries.map((entry, index) => index === 0 ? { ...entry, data_origin: 'fixture' } : entry),
      observations: [], historyRaces: [], predictedAt: '2026-10-16T00:00:00Z',
    })).toThrow('invalid-feature-input');
    expect(() => buildNativeExperimentalFeatures({
      race, entries: entries.slice(1), observations: [], historyRaces: [], predictedAt: '2026-10-16T00:00:00Z',
    })).toThrow('invalid-feature-input');
    expect(() => buildNativeExperimentalFeatures({
      race, entries, observations: [], historyRaces: [], predictedAt: '2026-10-16 00:00:00',
    })).toThrow('invalid-feature-input');
  });

  it('merges a validated Python snapshot with only unique complete post-snapshot races', () => {
    const predictedAt = '2026-10-16T00:00:00Z';
    const race = {
      id: 'synthetic-target', sport: 'boat', data_origin: 'real', status: 'scheduled',
      race_date: '2026-10-16', venue_id: 21, race_no: 3,
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      number: index + 1, data_origin: 'real', available_at: '2026-10-15T23:00:00Z',
      features_json: JSON.stringify({ racer_id: index === 0 ? '12345' : `2345${index}` }),
    }));
    const priorRace = {
      race: { id: 'supplemental-1', sport: 'boat', data_origin: 'real', status: 'finished', race_date: '2026-10-15' },
      entries: entries.map(entry => ({ ...entry })),
      results: entries.map((entry, index) => ({
        number: entry.number, data_origin: 'real', available_at: '2026-10-15T23:10:00Z', finish_order: index === 0 ? 1 : index + 1,
      })),
    };
    const alreadyCoveredRace = {
      ...priorRace,
      race: { ...priorRace.race, id: 'already-in-snapshot', race_date: '2026-10-14' },
    };
    const features = buildNativeExperimentalFeatures({
      race, entries, observations: [],
      historySnapshot: {
        schema: 'native-racer-history-v1', asOf: '2026-10-15T22:00:00Z',
        throughRaceDate: '2026-10-14', totals: { '12345': { starts: 2, wins: 1 } },
      },
      // The snapshot covers the earlier date; duplicate incremental race ids count only once.
      historyRaces: [alreadyCoveredRace, priorRace, { ...priorRace, entries: priorRace.entries.slice().reverse() }],
      predictedAt,
    });
    expect(features[0]).toMatchObject({
      racer_history_starts: 3, racer_history_wins: 2, racer_history_win_rate: 2 / 3,
    });
    expect(features[1].racer_history_starts).toBe(1);
  });

  it('fails closed on invalid history snapshot identity, coverage, time, and counts', () => {
    const race = {
      id: 'synthetic-target', sport: 'boat', data_origin: 'real', status: 'scheduled',
      race_date: '2026-10-16', venue_id: 21, race_no: 3,
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      number: index + 1, data_origin: 'real', available_at: '2026-10-15T23:00:00Z', features_json: '{}',
    }));
    const valid = {
      schema: 'native-racer-history-v1' as const, asOf: '2026-10-15T22:00:00Z',
      throughRaceDate: '2026-10-14', totals: { '12345': { starts: 2, wins: 1 } },
    };
    for (const historySnapshot of [
      { ...valid, schema: 'other' as 'native-racer-history-v1' },
      { ...valid, asOf: '2026-10-16T00:00:01Z' },
      { ...valid, asOf: '2026-10-15 22:00:00' },
      { ...valid, throughRaceDate: '2026-10-16' },
      { ...valid, totals: { '12345': { starts: 1, wins: 2 } } },
    ]) {
      expect(() => buildNativeExperimentalFeatures({
        race, entries, observations: [], historyRaces: [], historySnapshot, predictedAt: '2026-10-16T00:00:00Z',
      })).toThrow('invalid-history-snapshot');
    }
  });
});
