import { describe, expect, it } from 'vitest';
import { parseBoatraceRefundOutcome, parseBoatraceResults, type BoatraceResultExpected } from '../src/services/boatraceResults.js';
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
      refundNumbers: [],
      nonRefundableNumbers: [],
      payouts: [
        { betType: 'trifecta', selection: '1-2-5', payout: 3770 },
        { betType: 'win', selection: '1', payout: 430 },
      ],
    });
  });

  it('requires every top-three tie payout and preserves tied competition ranks', () => {
    const normal = boatraceResultPage(identity);
    const tied = normal.replace('<td class="is-fs14">４</td>', '<td class="is-fs14">３</td>');
    expect(() => parseBoatraceResults(tied, expected)).toThrow();
    const continuation = '<tr><td>&nbsp;</td><td><span class="is-payout1">&nbsp;</span></td><td>&nbsp;</td></tr>';
    const extra = '<tr><td><span class="numberSet1_number">1</span><span class="numberSet1_number">2</span><span class="numberSet1_number">3</span></td><td><span class="is-payout1">&yen;2000</span></td><td>2</td></tr>';
    const complete = tied.replace(continuation, extra);
    expect(parseBoatraceResults(complete, expected).payouts.filter(row=>row.betType==='trifecta').map(row=>row.selection)).toEqual(['1-2-5','1-2-3']);
    expect(() => parseBoatraceResults(complete.replace('&yen;2000','&yen;0'), expected)).toThrow();
    expect(() => parseBoatraceResults(complete.replace('&yen;2000','&yen;-100'), expected)).toThrow();
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

  it('parses an explicitly refunded no-rank page without manufacturing finish labels',()=>{
    const html=boatraceResultPage({ ...identity,finishOrder:[1,3,5,4,6,2] })
      .replace(/<div class="grid"><div class="table1"><table class="is-w495">[\s\S]*?<\/table><\/div><\/div>/,'')
      .replace('&yen;3,770','&yen;590').replace('&yen;430','&yen;120')
      .replace('<tbody><tr><td><div class="numberSet1"><div class="numberSet1_row"></div><div class="numberSet1_row"></div></div></td></tr></tbody>',
        '<tbody><tr><td><div class="numberSet1"><div class="numberSet1_row"><span class="numberSet1_number">2</span></div></div></td></tr></tbody>');
    expect(parseBoatraceRefundOutcome(html,expected)).toEqual({refundNumbers:[2],payouts:[
      {betType:'trifecta',selection:'1-3-5',payout:590},{betType:'win',selection:'1',payout:120},
    ]});
    expect(()=>parseBoatraceRefundOutcome(html.replace('>2</span>','>5</span>'),expected)).toThrow('official result page rejected');
    expect(()=>parseBoatraceRefundOutcome(html.replace('<span class="numberSet1_number">3</span><span class="numberSet1_number">5</span>',
      '<span class="numberSet1_number">2</span><span class="numberSet1_number">5</span>'),expected)).toThrow('official result page rejected');
    expect(()=>parseBoatraceRefundOutcome(html.replace('>1</span></div></td><td><span class="is-payout1">&yen;120',
      '>3</span></div></td><td><span class="is-payout1">&yen;120'),expected)).toThrow('official result page rejected');
    expect(()=>parseBoatraceRefundOutcome(`${html}<div>中止</div>`,expected)).toThrow('official result page rejected');
    expect(()=>parseBoatraceRefundOutcome(html,{...expected,url:expected.url.replace('rno=7','rno=8')})).toThrow('official result page rejected');
  });

  it('accepts a verified refund result with a matching official finish table but creates no rank output',()=>{
    const page=boatraceResultPage({...identity,finishOrder:[1,3,5,4,6,2]})
      .replace(/(<td class="is-fs14">)６(<\/td>\s*<td class="is-fs14 is-fBold is-boatColor2")/,'$1Ｆ$2')
      .replace('&yen;3,770','&yen;590').replace('&yen;430','&yen;120')
      .replace('<tbody><tr><td><div class="numberSet1"><div class="numberSet1_row"></div><div class="numberSet1_row"></div></div></td></tr></tbody>',
        '<tbody><tr><td><div class="numberSet1"><div class="numberSet1_row"><span class="numberSet1_number">2</span></div></div></td></tr></tbody>');
    expect(parseBoatraceRefundOutcome(page,expected)).toMatchObject({refundNumbers:[2],payouts:[
      {betType:'trifecta',selection:'1-3-5',payout:590},{betType:'win',selection:'1',payout:120},
    ]});
    for(const marker of ['L','Ｌ']){
      const lateStartRefund=page.replace('>Ｆ</td>','>'+marker+'</td>');
      expect(parseBoatraceRefundOutcome(lateStartRefund,expected).refundNumbers).toEqual([2]);
    }
    const wrongTop=page.replace(/(<td class="is-fs14">)２(<\/td>\s*<td class="is-fs14 is-fBold is-boatColor3")/,'$1４$2');
    expect(()=>parseBoatraceRefundOutcome(wrongTop,expected)).toThrow('official result page rejected');
    const missingRefundMarker=page.replace(/(<td class="is-fs14">)Ｆ(<\/td>\s*<td class="is-fs14 is-fBold is-boatColor2")/,'$1６$2');
    expect(()=>parseBoatraceRefundOutcome(missingRefundMarker,expected)).toThrow('official result page rejected');
    const unrefundedLateStart=page.replace(/(<td class="is-fs14">)Ｆ(<\/td>\s*<td class="is-fs14 is-fBold is-boatColor2")/,'$1Ｌ$2')
      .replace('<span class="numberSet1_number">2</span></div></div></td></tr></tbody>','<span class="numberSet1_number">3</span></div></div></td></tr></tbody>');
    expect(()=>parseBoatraceRefundOutcome(unrefundedLateStart,expected)).toThrow('official result page rejected');
    expect(()=>parseBoatraceRefundOutcome(page,{...expected,entries:expected.entries.map(entry=>entry.number===2?{...entry,racerId:'9999'}:entry)}))
      .toThrow('official result page rejected');
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
    expect(parseBoatraceResults(html.replace('<td class="is-fs14">６</td>', '<td class="is-fs14">５</td>'), expected).results.map(row=>row.finishOrder)).toEqual([1,2,3,4,5,5]);
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
