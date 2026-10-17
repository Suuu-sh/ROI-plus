import { it, expect } from 'vitest'
import { metrics, backtest, labeled, type FrozenArtifact } from './backtest-market-anchor.js'
import type { Opportunity, ReplayInput } from './experimental-opportunity-replay.js'
it('scores all 120 outcomes against actual winner, not market truth',()=>{
 const r={tickets:Array.from({length:120},(_,i)=>({selection:String(i),probability:1/120,probStd:.01,odds:120})),outcome:{winnerSelection:'0'}} as Opportunity
 expect(metrics([r],1).meanNll).toBeCloseTo(Math.log(120));expect(metrics([r],0).multiclassBrier).toBeCloseTo(119/120);expect(metrics([r],0).reliability[0].count).toBe(120)
})
it('fails source identity and train overlap before policy/scoring',()=>{
 const input={schemaVersion:1,modelId:'source',artifactSha256:'a'.repeat(64),asOf:'2026-10-17T10:00:00Z',races:[{raceId:'boat-20261016-01-01',decisionAt:'2026-10-16T01:00:00Z'}]} as ReplayInput
 const artifact={alpha:0,createdAt:'2026-10-17T10:00:00Z',baseModelId:'source',baseModelArtifactSha256:'a'.repeat(64),trainingLabels:[{raceId:'boat-20261016-01-01'}]} as FrozenArtifact
 expect(()=>backtest(input,artifact)).toThrow('overlap');expect(()=>backtest(input,{...artifact,baseModelId:'other'})).toThrow('binding')
})
it('missing outcomes cannot be scored',()=>{expect(labeled({outcome:null} as Opportunity,'2026-10-17T00:00:00Z')).toBe(false)})
