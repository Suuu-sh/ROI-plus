import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildNativeExperimentalFeatures,
  predictNativeExactTrifecta,
  validateNativeExperimentalModel,
  type NativeRaceFeatureInput,
} from '../src/services/nativeExperimentalForecast.js';

const readJson = (url: URL): Record<string, any> => JSON.parse(readFileSync(url, 'utf8')) as Record<string, any>;
const parity = readJson(new URL('../../../ml/tests/fixtures/experimental_worker_equivalence.real.json', import.meta.url));
const modelBundle = readJson(new URL('../src/models/experimental-worker-model.json', import.meta.url));
const historySnapshot = readJson(new URL('../src/models/native-racer-history.json', import.meta.url)) as NonNullable<NativeRaceFeatureInput['historySnapshot']>;

function actualFeatures(): Array<Record<string, unknown>> {
  if (!parity.input) throw new Error('real-parity-input-missing');
  const input = parity.input as NativeRaceFeatureInput;
  return buildNativeExperimentalFeatures({ ...input, historySnapshot });
}

describe('native experimental real-data parity fixture', () => {
  it('rebuilds whitelisted inputs and matches Python features and all 120 outcomes', () => {
    const actual = actualFeatures();
    const columns = parity.columns as string[];
    const expectedFeatures = parity.features as Array<Array<number | null>>;
    expect(actual).toHaveLength(6);
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < columns.length; column++) {
        const value = actual[row][columns[column]];
        const expected = expectedFeatures[row][column];
        if (expected === null) expect(value === null || value === undefined).toBe(true);
        else expect(Number(value)).toBeCloseTo(expected, 10);
      }
    }
    const model = validateNativeExperimentalModel(
      modelBundle, modelBundle.modelId as string, modelBundle.artifactSha256 as string,
    );
    const predictions = predictNativeExactTrifecta(model, actual);
    expect(predictions).toHaveLength(120);
    const means = parity.meanProbabilities as Record<string, number>;
    const deviations = parity.populationStdProbabilities as Record<string, number>;
    let maxAbsoluteDifference = 0;
    for (const prediction of predictions) {
      const difference = Math.abs(prediction.probability - means[prediction.selection]);
      maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
      expect(prediction.probability).toBeCloseTo(means[prediction.selection], 12);
      expect(prediction.probStd).toBeCloseTo(deviations[prediction.selection], 12);
    }
    // Fixed, sanitized evidence only; never print fixture identifiers or feature values.
    console.info(JSON.stringify({ event: 'native_worker_real_parity', predictions: predictions.length,
      maxAbsoluteProbabilityDifference: Number(maxAbsoluteDifference.toExponential(3)) }));
  });

  it('benchmarks 25 local iterations of model validation, snapshot feature building, and inference', () => {
    const input = parity.input as NativeRaceFeatureInput | undefined;
    if (!input) throw new Error('real-parity-input-missing');
    const iterations = 25;
    const wallMs: number[] = [];
    const cpuStart = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
      const started = performance.now();
      const model = validateNativeExperimentalModel(
        modelBundle, modelBundle.modelId as string, modelBundle.artifactSha256 as string,
      );
      const features = buildNativeExperimentalFeatures({ ...input, historySnapshot });
      predictNativeExactTrifecta(model, features);
      wallMs.push(performance.now() - started);
    }
    const cpu = process.cpuUsage(cpuStart);
    const sorted = [...wallMs].sort((a, b) => a - b);
    const summary = {
      event: 'native_worker_node_benchmark',
      iterations,
      medianWallMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
      maxWallMs: Number(sorted.at(-1)!.toFixed(3)),
      meanProcessCpuMs: Number(((cpu.user + cpu.system) / 1000 / iterations).toFixed(3)),
      scope: 'Node local CPU; not Cloudflare Worker CPU measurement or guarantee',
    };
    console.info(JSON.stringify(summary));
    expect(wallMs).toHaveLength(iterations);
  });
});
