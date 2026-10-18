import {describe,it,expect} from 'vitest'
import {recoveredResearchOutcome} from './residual-recovery-evidence.js'
describe('offline recovery provenance gates',()=>{
 it('rejects missing or falsely persisted provenance before parsing',()=>{
  const r:any={raceId:'boat-20261018-01-01',decisionAt:'2026-10-18T01:00:00Z',cutoffAt:'2026-10-18T01:01:00Z'}
  expect(()=>recoveredResearchOutcome(r,{productionPersisted:true} as any,new Uint8Array(),{} as any,'2026-10-19T00:00:00Z','2026-10-19T01:00:00Z')).toThrow('Invalid research recovery evidence')
 })
 it('rejects corrupt HTML hash and retroactive result availability',()=>{
  const r:any={raceId:'boat-20261018-01-01',decisionAt:'2026-10-18T01:00:00Z',cutoffAt:'2026-10-18T01:01:00Z'}
  const e:any={raceId:r.raceId,status:'verified',qualityStatus:'research-recovered-official-html-v1',productionPersisted:false,originalAsOf:'2026-10-19T00:00:00Z',fetchedAt:'2026-10-18T02:00:00Z',availableAt:'2026-10-18T02:00:00Z',recoveredAt:'2026-10-19T00:30:00Z'}
  expect(()=>recoveredResearchOutcome(r,e,new Uint8Array(),{} as any,e.originalAsOf,'2026-10-19T01:00:00Z')).toThrow()
  e.fetchedAt=e.availableAt='2026-10-19T00:15:00Z';e.sourceUrl='url';e.bodySha256='a'.repeat(64)
  expect(()=>recoveredResearchOutcome(r,e,new Uint8Array(),{url:'url'} as any,e.originalAsOf,'2026-10-19T01:00:00Z')).toThrow()
 })
})

import {createHash} from 'node:crypto'
import {boatraceResultPage} from '../apps/api/test/fixtures/boatraceResultPage.js'
it('accepts actual supported capsize top3 without synthesizing ranks; rejects refund',()=>{
 const identity={raceDate:'2026-10-18',venueCode:'01',raceNo:1},url='https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=01&hd=20261018'
 const expected={...identity,url,entries:Array.from({length:6},(_,i)=>({number:i+1,racerId:String(4001+i)}))}
 const r:any={raceId:'boat-20261018-01-01',decisionAt:'2026-10-18T01:00:00Z',cutoffAt:'2026-10-18T01:01:00Z'}
 const html=boatraceResultPage({...identity,finishOrder:[1,2,5,3,4,'転']})
 const bytes=Buffer.from(html),e:any={raceId:r.raceId,status:'verified',qualityStatus:'research-recovered-official-html-v1',productionPersisted:false,originalAsOf:'2026-10-19T00:00:00Z',fetchedAt:'2026-10-19T00:10:00Z',availableAt:'2026-10-19T00:10:00Z',recoveredAt:'2026-10-19T00:11:00Z',bodySha256:createHash('sha256').update(bytes).digest('hex'),sourceUrl:url,winnerSelection:'1-2-5',payoutPer100:3770}
 expect(recoveredResearchOutcome(r,e,bytes,expected,e.originalAsOf,'2026-10-19T01:00:00Z').winnerSelection).toBe('1-2-5')
 const refund=Buffer.from(html.replace('転','Ｆ'));e.bodySha256=createHash('sha256').update(refund).digest('hex')
 expect(()=>recoveredResearchOutcome(r,e,refund,expected,e.originalAsOf,'2026-10-19T01:00:00Z')).toThrow()
})
