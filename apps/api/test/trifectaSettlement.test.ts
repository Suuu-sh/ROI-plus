import { describe, expect, it } from 'vitest';
import { verifiedTrifectaOutcome } from '../src/services/trifectaSettlement.js';

const entries = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, finishCode: i === 4 ? '転覆' : null }));
const publishedPartialOrder = [
  { number: 1, finishOrder: 1 }, { number: 2, finishOrder: 2 },
  { number: 3, finishOrder: 3 }, { number: 4, finishOrder: 4 }, { number: 6, finishOrder: 5 },
];
const payouts = [{ selection: '1-2-3', payout: 1700 }];

describe('verified partial trifecta settlement evidence', () => {
  it('settles a fully classified losing ticket when an unrelated runner is officially terminal', () => {
    expect(verifiedTrifectaOutcome('1-3-6', entries, publishedPartialOrder, payouts))
      .toEqual({ winningSelection: '1-2-3', won: false, payoutPer100: 1700 });
  });

  it('keeps a ticket containing a terminal/refundable runner open', () => {
    expect(verifiedTrifectaOutcome('1-3-5', entries, publishedPartialOrder, payouts)).toBeNull();
  });

  it('allows terminal selections only with verified official no-refund capsize evidence', () => {
    const twoCapsizeEntries = entries.map(entry => entry.number >= 5 ? { ...entry, finishCode: '転覆' } : entry);
    const twoCapsizeOrder = publishedPartialOrder.filter(row => row.number <= 4);
    expect(verifiedTrifectaOutcome('1-5-6', twoCapsizeEntries, twoCapsizeOrder, payouts)).toBeNull();
    expect(verifiedTrifectaOutcome('1-5-6', twoCapsizeEntries, twoCapsizeOrder, payouts, [5])).toBeNull();
    expect(verifiedTrifectaOutcome('1-5-6', twoCapsizeEntries, twoCapsizeOrder, payouts, [5, 6]))
      .toEqual({ winningSelection: '1-2-3', won: false, payoutPer100: 1700 });
  });

  it('keeps the ticket open when the top-three official order or selected runner is incomplete', () => {
    expect(verifiedTrifectaOutcome('1-3-6', entries, publishedPartialOrder.slice(1), payouts)).toBeNull();
    expect(verifiedTrifectaOutcome('1-3-5', entries, publishedPartialOrder, payouts)).toBeNull();
  });

  it('rejects mismatched official payout identity and malformed field identity', () => {
    expect(verifiedTrifectaOutcome('1-3-6', entries, publishedPartialOrder, [{ selection: '1-2-4', payout: 1700 }])).toBeNull();
    expect(verifiedTrifectaOutcome('1-3-6', [{ ...entries[0], number: 2 }, ...entries.slice(1)], publishedPartialOrder, payouts)).toBeNull();
    expect(verifiedTrifectaOutcome('1-3-6', [...entries.slice(0, 4), { number: 5, finishCode: null }, entries[5]], publishedPartialOrder, payouts)).toBeNull();
    expect(verifiedTrifectaOutcome('1-3-6', entries, [{ ...publishedPartialOrder[0], finishOrder: 2 }, ...publishedPartialOrder.slice(1)], payouts)).toBeNull();
  });

  it('settles a winning selection only from the exact official winning payout', () => {
    expect(verifiedTrifectaOutcome('1-2-3', entries, publishedPartialOrder, payouts))
      .toEqual({ winningSelection: '1-2-3', won: true, payoutPer100: 1700 });
  });
});
