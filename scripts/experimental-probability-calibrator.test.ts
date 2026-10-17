import { describe,it,expect } from 'vitest'
import { temperatureTransform, fitTemperatureCandidate } from './experimental-probability-calibrator.js'
import type { ReplayInput, Opportunity } from './experimental-opportunity-replay.js'
const hash='a'.repeat(64)
function fixture(): ReplayInput {
 const tickets=[]
 for(let a=1;a<=6;a++)for(let b=1;b<=6;b++)for(let c=1;c<=6;c++)if(a!==b&&b!==c&&a!==c)tickets.push({selection:`${a}-${b}-${c}`,probability:1/120,probStd:0,odds:200})
 const race:Opportunity={originalDecisionOutcome:'abstained',originalDecisionReason:'no_conservative_positive_edge',raceId:'boat-20261014-01-01',modelId:'current',dataOrigin:'real',decisionAt:'2026-10-14T01:59:00Z',cutoffAt:'2026-10-14T02:00:00Z',predictedAt:'2026-10-14T01:58:00Z',trainedAt:'2026-10-13T00:00:00Z',tickets,cutoffProof:{url:'https://www.boatrace.jp/owpc/pc/race/racelist?rno=1&jcd=01&hd=20261014',sha256:hash,raceId:'boat-20261014-01-01',cutoffAt:'2026-10-14T02:00:00Z',identityVerified:true,source:'boatrace-racelist-cutoff-v1',observedAt:'2026-10-14T01:57:00Z'},forecastProof:{artifactSha256:hash,featureSchemaVersion:'ticket-selection-v1',archiveIdentityVerified:true,availableAt:'2026-10-14T01:57:00Z'},purchaseOddsProof:{url:'https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=01&hd=20261014',sha256:hash,requestedAt:'2026-10-14T01:58:55Z',capturedAt:'2026-10-14T01:58:59Z',qualityStatus:'verified-complete-v1',odds:tickets.map(({selection,odds})=>({selection,odds}))}}
 return {schemaVersion:1,asOf:'2026-10-14T12:00:00Z',modelId:'current',artifactSha256:hash,races:[race]}
}

describe('research-only calibration',()=>{
 it('normalizes small probabilities and exact zeros, preserving uncertainty and odds',()=>{
 const tickets=Array.from({length:120},(_,i)=>({probability:i===0?1-1e-12:i===1?1e-12:0,probStd:.3,odds:55}))
 const out=temperatureTransform(tickets,3);expect(out.reduce((s,t)=>s+t.probability,0)).toBeCloseTo(1,14);expect(out[2].probability).toBe(0);expect(out[0].probStd).toBe(.3);expect(out[0].odds).toBe(55);expect(out[1].probability).toBeGreaterThan(tickets[1].probability)
 })
 it('fails closed on malformed distribution and missing evidence',()=>{
 expect(()=>temperatureTransform([{probability:1}],2)).toThrow();expect(()=>temperatureTransform(Array.from({length:120},()=>({probability:1/120})),0)).toThrow()
 expect(()=>fitTemperatureCandidate({schemaVersion:1,asOf:'2026-10-17T00:00:00+09:00',modelId:'x',artifactSha256:'a'.repeat(64),races:[]})).toThrow('No eligible')
 })
})

describe('fit boundaries',()=>{
 function training(){const f=fixture();f.asOf='2026-10-17T12:00:00Z';const r=f.races[0];r.tickets.forEach((t,i)=>t.probability=i===0?.8:.2/119);r.outcome={raceId:r.raceId,qualityStatus:'verified-official-outcome-v2',availableAt:'2026-10-14T03:00:00Z',winnerSelection:'1-2-4',payoutPer100:100,sourceUrl:'https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=01&hd=20261014',bodySha256:hash,verified:true};return f}
 it('depends on training labels, not test outcomes or odds/payout features',()=>{const f=training(),baseline=fitTemperatureCandidate(f);expect(baseline.temperature).toBeGreaterThan(1);const test=structuredClone(f.races[0]);test.raceId='boat-20261016-01-01';test.outcome=null;f.races.push(test);expect(fitTemperatureCandidate(f).temperature).toBe(baseline.temperature);f.races[0].outcome!.payoutPer100=999999;f.races[0].tickets.forEach(t=>t.odds=11);f.races[0].purchaseOddsProof.odds.forEach(t=>t.odds=11);expect(fitTemperatureCandidate(f).temperature).toBe(baseline.temperature);f.races[0].outcome!.winnerSelection='1-2-3';expect(fitTemperatureCandidate(f).temperature).toBe(1)})
 it('rejects missing/late outcome proof, invalid source and duplicate partition IDs',()=>{for(const mutate of [(r:Opportunity)=>r.outcome!.verified='true' as unknown as boolean,(r:Opportunity)=>r.outcome!.availableAt='2026-10-16T00:00:00+09:00',(r:Opportunity)=>r.forecastProof.availableAt='2026-10-18T00:00:00Z',(r:Opportunity)=>r.outcome!.bodySha256='']){const f=training();mutate(f.races[0]);expect(()=>fitTemperatureCandidate(f)).toThrow('No eligible')}const f=training();f.races.push(structuredClone(f.races[0]));expect(()=>fitTemperatureCandidate(f)).toThrow('Duplicate')})
})
