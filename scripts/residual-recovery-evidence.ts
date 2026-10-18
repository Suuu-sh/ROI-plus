/** Offline research evidence adapter; output is ephemeral evaluator input, not a collector proof. */
import {createHash} from 'node:crypto'
import {parseBoatraceResults,type BoatraceResultExpected} from '../apps/api/src/services/boatraceResults.js'
import type {Opportunity} from './experimental-opportunity-replay.js'
export type RecoveryEvidence={raceId:string;qualityStatus:string;sourceUrl:string;status:string;originalAsOf:string;productionPersisted:boolean;fetchedAt:string;availableAt:string;recoveredAt:string;bodySha256:string;winnerSelection:string;payoutPer100:number}
export function recoveredResearchOutcome(r:Opportunity,e:RecoveryEvidence,html:Uint8Array,expected:BoatraceResultExpected,originalAsOf:string,asOf:string){
 const ms=(x:string)=>/(?:Z|[+-]\d\d:\d\d)$/.test(x??'')?Date.parse(x):NaN
 if(e.raceId!==r.raceId||e.status!=='verified'||e.qualityStatus!=='research-recovered-official-html-v1'||e.productionPersisted!==false||e.originalAsOf!==originalAsOf||e.availableAt!==e.fetchedAt||![e.fetchedAt,e.recoveredAt,asOf].every(t=>Number.isFinite(ms(t)))||ms(e.fetchedAt)<=Math.max(ms(r.decisionAt),ms(r.cutoffAt),ms(originalAsOf))||ms(e.recoveredAt)<ms(e.fetchedAt)||ms(e.recoveredAt)>ms(asOf)||expected.url!==e.sourceUrl||createHash('sha256').update(html).digest('hex')!==e.bodySha256)throw Error('Invalid research recovery evidence')
 const match=/^boat-(\d{8})-(\d{2})-(\d{2})$/.exec(r.raceId)
 if(!match||expected.raceDate.replaceAll('-','')!==match[1]||expected.venueCode!==match[2]||expected.raceNo!==Number(match[3]))throw Error('Recovery identity mismatch')
 const parsed=parseBoatraceResults(new TextDecoder('utf-8',{fatal:true}).decode(html),expected)
 const p=parsed.payouts.find(p=>p.betType==='trifecta')
 if(parsed.terminalEntries.some(t=>!parsed.nonRefundableNumbers.includes(t.number))||!p||p.selection!==e.winnerSelection||p.payout!==e.payoutPer100)throw Error('Research outcome mismatch or unsupported terminal result')
 // Shared offline evaluator's canonical outcome type is used only after independent
 // strict HTML validation. No serialized input/proof is labeled persisted verified-v2.
 return {raceId:r.raceId,qualityStatus:'verified-official-outcome-v2',verified:true,availableAt:e.fetchedAt,winnerSelection:p.selection,payoutPer100:p.payout,sourceUrl:e.sourceUrl,bodySha256:e.bodySha256}
}
