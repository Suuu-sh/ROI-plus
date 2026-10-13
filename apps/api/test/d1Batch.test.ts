import { describe, expect, it } from 'vitest';
import { D1_MAX_BOUND_PARAMETERS_PER_STATEMENT, splitRowsForD1 } from '../src/services/d1Batch.js';

describe('splitRowsForD1', () => {
  it('keeps 120 forecast rows within the D1 100-bind statement limit', () => {
    const chunks = splitRowsForD1(Array.from({ length: 120 }, (_, i) => i), 9);
    expect(chunks.map(chunk => chunk.length)).toEqual([11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 10]);
    expect(Math.max(...chunks.map(chunk => chunk.length * 9))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS_PER_STATEMENT);
  });

  it('reserves an extra bind for the guarded paper-bet insert', () => {
    const chunks = splitRowsForD1(Array.from({ length: 120 }, (_, i) => i), 11, 1);
    expect(chunks.map(chunk => chunk.length)).toEqual([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 3]);
    expect(Math.max(...chunks.map(chunk => chunk.length * 11 + 1))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS_PER_STATEMENT);
  });

  it('fails closed when one row cannot fit', () => {
    expect(() => splitRowsForD1([1], 101)).toThrow(/bind limit/);
  });
});
