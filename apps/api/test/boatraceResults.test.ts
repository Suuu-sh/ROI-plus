import { describe, expect, it } from 'vitest';
import { parseBoatraceResults, type BoatraceResultExpected } from '../src/services/boatraceResults.js';
import { boatraceResultPage } from './fixtures/boatraceResultPage.js';

const identity = { raceDate: '2026-10-11', venueCode: '18', raceNo: 7 };
const expected: BoatraceResultExpected = {
  ...identity,
  url: 'https://www.boatrace.jp/owpc/pc/race/raceresult?rno=7&jcd=18&hd=20261011',
  entries: Array.from({ length: 6 }, (_, index) => ({ number: index + 1, racerId: String(4001 + index) })),
};

describe('official BOAT RACE result parser', () => {
  it('parses a complete six-boat result and exact winning payouts', () => {
    expect(parseBoatraceResults(boatraceResultPage(identity), expected)).toEqual({
      results: [1, 2, 5, 3, 4, 6].map((number, index) => ({ number, finishOrder: index + 1 })),
      terminalEntries: [],
      refundTablePresent: true,
      nonRefundableNumbers: [],
      payouts: [
        { betType: 'trifecta', selection: '1-2-5', payout: 3770 },
        { betType: 'win', selection: '1', payout: 430 },
      ],
    });
  });

  it('requires the official URL and matching selected page identity', () => {
    const html = boatraceResultPage(identity);
    for (const url of [
      expected.url.replace('www.boatrace.jp', 'evil.example'),
      expected.url.replace('/raceresult?', '/racelist?'),
      expected.url.replace('rno=7', 'rno=8'),
      expected.url.replace('hd=20261011', 'hd=20261010'),
    ]) expect(() => parseBoatraceResults(html, { ...expected, url })).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('18.png', '19.png'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('10月11日', '10月10日'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('rno=7&amp;jcd=18&amp;hd=20261011">7R', 'rno=6&amp;jcd=18&amp;hd=20261011">7R'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace(' class="is-thColor2"><a href="/owpc/pc/race/raceresult?rno=8', '><a href="/owpc/pc/race/raceresult?rno=8'), expected)).toThrow('official result page rejected');
  });

  it('accepts the normal empty refund table even though its heading says 返還', () => {
    expect(parseBoatraceResults(boatraceResultPage(identity), expected).payouts).toHaveLength(2);
  });

  it('rejects refund boat numbers even when the refund table has no status text', () => {
    const html = boatraceResultPage(identity).replace(
      '<div class="numberSet1_row"></div>',
      '<div class="numberSet1_row"><span class="numberSet1_number">1</span></div>',
    );
    expect(() => parseBoatraceResults(html, expected)).toThrow('official result page rejected');
  });

  it('requires six unique normal ranks, entries, and registration IDs', () => {
    const html = boatraceResultPage(identity);
    expect(() => parseBoatraceResults(html.replace('<td class="is-fs14">６</td>', '<td class="is-fs14">５</td>'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('>4005</span>', '>9999</span>'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('<td class="is-fs14">６</td>', '<td class="is-fs14">失格</td>'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(boatraceResultPage({ ...identity, finishOrder: [1, 1, 5, 3, 4, 6] }), expected)).toThrow('official result page rejected');
  });

  it('requires a positive matching win payout and only accepts a matching trifecta payout', () => {
    const html = boatraceResultPage(identity);
    expect(() => parseBoatraceResults(html.replace('&yen;430', '&nbsp;'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('>1</span></div></td><td><span class="is-payout1">&yen;430', '>2</span></div></td><td><span class="is-payout1">&yen;430'), expected)).toThrow('official result page rejected');
    expect(() => parseBoatraceResults(html.replace('>5</span></div></td><td><span class="is-payout1">&yen;3,770', '>4</span></div></td><td><span class="is-payout1">&yen;3,770'), expected)).toThrow('official result page rejected');
  });

  it('rejects a populated row-spanning continuation under a target payout market', () => {
    const html = boatraceResultPage(identity).replace(
      '<tr><td>&nbsp;</td><td><span class="is-payout1">&nbsp;</span></td><td>&nbsp;</td></tr>',
      '<tr><td>2</td><td><span class="is-payout1">&nbsp;</span></td><td>&nbsp;</td></tr>',
    );
    expect(() => parseBoatraceResults(html, expected)).toThrow('official result page rejected');
  });
});
