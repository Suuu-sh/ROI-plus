import {it,expect} from 'vitest'
import {distributionMetrics,backtest,validOutcome} from './backtest-calibrated-model.js'
import type {Opportunity,ReplayInput} from './experimental-opportunity-replay.js'
it('scores full multiclass distribution per race with fixed bins',()=>{
 const rows=[{tickets:Array.from({length:120},(_,i)=>({selection:String(i),probability:i<2?.5:0})),outcome:{winnerSelection:'0'}}] as unknown as Opportunity[]
 const m=distributionMetrics(rows);expect(m.meanNll).toBeCloseTo(Math.log(2));expect(m.multiclassBrier).toBe(.5);expect(m.reliability[5].count).toBe(2);expect(m.races).toBe(1)
})
it('rejects overlapping training/test IDs before scoring',()=>{
 const input={schemaVersion:1,asOf:'2026-10-17T10:00:00Z',races:[{raceId:'boat-20261016-01-01',decisionAt:'2026-10-16T01:00:00Z'}]} as ReplayInput
 expect(()=>backtest(input,{temperature:2,partitions:{train:[{raceId:'boat-20261016-01-01',outcomeAvailableAt:'2026-10-15T00:00:00Z'}]}})).toThrow('overlap')
})
it('rejects naive and future outcome timestamps consistently',()=>{
 const r={raceId:'boat-20261016-01-01',decisionAt:'2026-10-16T01:00:00Z',cutoffAt:'2026-10-16T01:01:00Z',tickets:[{selection:'1-2-3'}],outcome:{verified:true,raceId:'boat-20261016-01-01',qualityStatus:'verified-official-outcome-v2',bodySha256:'a'.repeat(64),payoutPer100:100,winnerSelection:'1-2-3',sourceUrl:'https://www.boatrace.jp/owpc/pc/race/raceresult?hd=20261016&jcd=01&rno=1',availableAt:'2026-10-16T02:00:00Z'}} as Opportunity
 expect(validOutcome(r,'2026-10-17T00:00:00Z')).toBe(true)
 r.outcome!.availableAt='2026-10-16T02:00:00';expect(validOutcome(r,'2026-10-17T00:00:00Z')).toBe(false)
 r.outcome!.availableAt='2026-10-18T02:00:00Z';expect(validOutcome(r,'2026-10-17T00:00:00Z')).toBe(false)
})
