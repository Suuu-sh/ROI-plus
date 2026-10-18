/** Offline decision-time residual candidate. Never imported by runtime code. */
import { rejection, replayOpportunities, type ReplayInput } from './experimental-opportunity-replay.js'
import { calibrationOutcomeValid } from './experimental-probability-calibrator.js'
import type { ExperimentalTicket } from '../apps/api/src/services/experimentalSizing.js'
export const RESIDUAL_PROTOCOL = Object.freeze({
 method:'softmax(log(normalized inverse decision-time odds) + linear residual)',
 featureSchema:['clipped_log_forecast_market_ratio_div5','first_lane_1..6','second_lane_1..6','third_lane_1..6'],
 featureCount:19, ratioClip:5, l2:0.1, iterations:600, learningRate:0.2,
 trainingDates:['20261014','20261015','20261016','20261017'],
 policy:{minProbability:0.10,maxOdds:50,monthlyGrossStakeCap:10000,perRaceCap:1000,recyclePayouts:false},
 evaluation:'future decisions strictly after actual artifact creation; exclude every inspected input race; no tuning',
 uncertainty:'Original probStd unchanged; UNCALIBRATED conservative risk proxy, not calibrated residual uncertainty',
 researchOnly:true, promotionEligible:false,
})
function design(tickets:ExperimentalTicket[]) {
 if(tickets.length!==120 || new Set(tickets.map(t=>t.selection)).size!==120 || tickets.some(t=>!/^([1-6])-([1-6])-([1-6])$/.test(t.selection)||new Set(t.selection.split('-')).size!==3||!Number.isFinite(t.odds)||t.odds<=1||!Number.isFinite(t.probability)||t.probability<0||t.probability>1)||Math.abs(tickets.reduce((s,t)=>s+t.probability,0)-1)>1e-6)throw new Error('Invalid 120-ticket distribution')
 const total=tickets.reduce((s,t)=>s+1/t.odds,0),market=tickets.map(t=>1/t.odds/total)
 const features=tickets.map((t,i)=>{const x=Array<number>(19).fill(0);x[0]=Math.max(-5,Math.min(5,Math.log(Math.max(t.probability,1e-12)/market[i])))/5;t.selection.split('-').forEach((lane,j)=>x[1+j*6+Number(lane)-1]=1);return x})
 return {market,features}
}
export function residualTransform(tickets:ExperimentalTicket[],weights:number[]) {
 if(weights.length!==19||weights.some(w=>!Number.isFinite(w)))throw new Error('Invalid residual weights')
 const {market,features}=design(tickets),logs=market.map((p,i)=>Math.log(p)+features[i].reduce((s,x,j)=>s+x*weights[j],0)),max=Math.max(...logs),mass=logs.map(l=>Math.exp(l-max)),total=mass.reduce((a,b)=>a+b,0)
 return tickets.map((t,i)=>({...t,probability:mass[i]/total}))
}
export function fitResidual(input:ReplayInput) {
 if(input.schemaVersion!==1||!Number.isFinite(Date.parse(input.asOf)))throw new Error('Invalid envelope')
 const ids=input.races.map(r=>r.raceId);if(new Set(ids).size!==ids.length)throw new Error('Duplicate race ID')
 const rows=input.races.filter(r=>RESIDUAL_PROTOCOL.trainingDates.some(d=>r.raceId.startsWith(`boat-${d}-`))&&!rejection(r,input)&&calibrationOutcomeValid(r,input.asOf)).sort((a,b)=>a.raceId.localeCompare(b.raceId))
 if(!rows.length)throw new Error('No eligible training races')
 const data=rows.map(r=>({...design(r.tickets),winner:r.tickets.findIndex(t=>t.selection===r.outcome!.winnerSelection)})),weights=Array<number>(19).fill(0)
 for(let k=0;k<RESIDUAL_PROTOCOL.iterations;k++){
 const gradient=weights.map(w=>RESIDUAL_PROTOCOL.l2*w)
 for(const d of data){const logits=d.market.map((p,i)=>Math.log(p)+d.features[i].reduce((s,x,j)=>s+x*weights[j],0)),max=Math.max(...logits),mass=logits.map(l=>Math.exp(l-max)),total=mass.reduce((a,b)=>a+b,0);for(let i=0;i<120;i++)for(let j=0;j<19;j++)gradient[j]+=(mass[i]/total-Number(i===d.winner))*d.features[i][j]/data.length}
 for(let j=0;j<19;j++)weights[j]-=RESIDUAL_PROTOCOL.learningRate*gradient[j]
 }
 return {weights,trainingRaceIds:rows.map(r=>r.raceId),excludedInspectedRaceIds:ids.sort(),trainingRaceCount:rows.length,trainingNll:rows.reduce((s,r)=>s-Math.log(residualTransform(r.tickets,weights).find(t=>t.selection===r.outcome!.winnerSelection)!.probability),0)/rows.length,protocol:RESIDUAL_PROTOCOL,registered:false,promoted:false,promotionEligible:false}
}
export interface ResidualArtifact {createdAt:string;baseModelId:string;baseModelArtifactSha256:string;weights:number[];trainingRaceIds:string[];excludedInspectedRaceIds:string[];protocol:typeof RESIDUAL_PROTOCOL}
export function evaluateResidual(input:ReplayInput,artifact:ResidualArtifact){
 const frozen=Date.parse(artifact.createdAt)
 if(!Number.isFinite(frozen)||JSON.stringify(artifact.protocol)!==JSON.stringify(RESIDUAL_PROTOCOL)||artifact.baseModelId!==input.modelId||artifact.baseModelArtifactSha256!==input.artifactSha256)throw new Error('Artifact protocol/source mismatch')
 if(!input.races.length)throw new Error('No unseen evaluation input')
 if(input.races.some(r=>artifact.excludedInspectedRaceIds.includes(r.raceId)||artifact.trainingRaceIds.includes(r.raceId)||!(Date.parse(r.decisionAt)>frozen)))throw new Error('Not prospective unseen input: overlap or decision before freeze')
 const seen=new Set<string>();for(const r of input.races){if(seen.has(r.raceId)||rejection(r,input))throw new Error('Invalid prospective evidence');seen.add(r.raceId)}
 const labeled=input.races.filter(r=>calibrationOutcomeValid(r,input.asOf))
 const metrics=(candidate:boolean)=>({races:labeled.length,meanNll:labeled.length?labeled.reduce((s,r)=>{const ts=candidate?residualTransform(r.tickets,artifact.weights):r.tickets;return s-Math.log(Math.max(Number.MIN_VALUE,ts.find(t=>t.selection===r.outcome!.winnerSelection)!.probability))},0)/labeled.length:null,multiclassBrier:labeled.length?labeled.reduce((s,r)=>(candidate?residualTransform(r.tickets,artifact.weights):r.tickets).reduce((n,t)=>n+(t.probability-Number(t.selection===r.outcome!.winnerSelection))**2,s),0)/labeled.length:null})
 const run=(candidate:boolean)=>replayOpportunities(input,candidate?{forecastTransform:t=>residualTransform(t,artifact.weights)}:{}).candidates.find(c=>c.minRawProbability===.1&&c.maxOdds===50)!
 return {status:labeled.length?'prospective_comparison_not_promotion_proof':'awaiting_verified_labels',actualFrozenAt:artifact.createdAt,metrics:{current:metrics(false),residual:metrics(true)},arms:{current:run(false),residual:run(true)},unknownLabels:input.races.length-labeled.length,fullyObservedMonths:0,monthlyPositiveProfitFrequency:null,promotionEligible:false,uncertainty:RESIDUAL_PROTOCOL.uncertainty}
}
