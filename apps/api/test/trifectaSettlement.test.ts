import { describe, expect, it } from 'vitest';
import { officialTerminalEntries, verifiedTrifectaOutcome } from '../src/services/trifectaSettlement.js';

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

describe('official competition-rank ties',()=>{
  const tiedEntries=Array.from({length:6},(_,i)=>({number:i+1,finishCode:null}));
  const ranks=[1,2,2,4,5,6].map((finishOrder,i)=>({number:i+1,finishOrder}));
  const pays=[{selection:'1-2-3',payout:800},{selection:'1-3-2',payout:1200}];
  it('pays either official winning order at its own amount',()=>{
    expect(verifiedTrifectaOutcome('1-3-2',tiedEntries,ranks,pays)).toEqual({winningSelection:'1-3-2',won:true,payoutPer100:1200});
    expect(verifiedTrifectaOutcome('1-4-2',tiedEntries,ranks,pays)?.won).toBe(false);
  });
  it('keeps incomplete payouts and dense/invalid tied ranks open',()=>{
    expect(verifiedTrifectaOutcome('1-3-2',tiedEntries,ranks,pays.slice(0,1))).toBeNull();
    expect(verifiedTrifectaOutcome('1-3-2',tiedEntries,ranks.map(r=>r.number===4?{...r,finishOrder:3}:r),pays)).toBeNull();
  });
  it('requires every legal order when a tie crosses third place',()=>{
    const third=[1,2,3,3,5,6].map((finishOrder,i)=>({number:i+1,finishOrder}));
    const thirdPays=[{selection:'1-2-3',payout:900},{selection:'1-2-4',payout:1400}];
    expect(verifiedTrifectaOutcome('1-2-4',tiedEntries,third,thirdPays)?.payoutPer100).toBe(1400);
    expect(verifiedTrifectaOutcome('1-2-4',tiedEntries,third,thirdPays.slice(0,1))).toBeNull();
  });
});

it('uses only source-bound official terminal policy to classify preserved PIT rows',()=>{
  const race={id:'boat-race',race_date:'2026-10-15',venue_id:'01',race_no:1};
  const proof={quality:'verified-official-outcome-v2',raceId:race.id,url:'https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=01&hd=20261015',sha256:'a'.repeat(64),fetchedAt:new Date().toISOString(),refundTablePresent:true,refundPolicy:'official-classified-terminal-v1',nonRefundableNumbers:[5],refundNumbers:[],terminalEntries:[{number:5,finishCode:'落水'}]};
  const record={status:'success',target_date:race.race_date,reason:JSON.stringify(proof)};
  expect(officialTerminalEntries(record,race,[{number:5,finishCode:null}])).toEqual([{number:5,finishCode:'落水'}]);
  record.reason=JSON.stringify({...proof,refundNumbers:[5]});
  expect(officialTerminalEntries(record,race,[{number:5,finishCode:null}])).toEqual([{number:5,finishCode:null}]);
});
