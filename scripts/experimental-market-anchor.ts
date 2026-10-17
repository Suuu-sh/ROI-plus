/** Offline research-only decision-time counterfactual, NOT calibrated true probability.
 * Fixed for this retrospective replay: fit alpha on October 14–15 only, NLL grid 0..1/.01.
 * Test dates were previously inspected; this is not an untouched prospective holdout.
 * Market available at decisionAt is not claimed available at original predictedAt.
 */
import { rejection, type ReplayInput } from './experimental-opportunity-replay.js'
import { calibrationOutcomeValid } from './experimental-probability-calibrator.js'
export const MARKET_ANCHOR_PROTOCOL=Object.freeze({method:'decision-time-normalized-inverse-odds-convex-mixture',minAlpha:0,maxAlpha:1,step:.01,tieBreak:'lower alpha',objective:'training multiclass NLL',simulatedFitCutoff:'2026-10-16T00:00:00+09:00',trainDates:['20261014','20261015'],testDates:['20261016','20261017'],qualifiedPipelineFloors:{train:300,validation:100,test:100},researchOnly:true})
export function marketAnchorTransform<T extends {probability:number;odds:number}>(tickets:T[],alpha:number):T[]{
 if(!Number.isFinite(alpha)||alpha<0||alpha>1||tickets.length!==120||tickets.some(t=>!Number.isFinite(t.probability)||t.probability<0||t.probability>1||!Number.isFinite(t.odds)||t.odds<=1)||Math.abs(tickets.reduce((s,t)=>s+t.probability,0)-1)>1e-6)throw new Error('Invalid normalized 120-ticket distribution, quote or alpha')
 const weights=tickets.map(t=>1/t.odds),total=weights.reduce((s,w)=>s+w,0)
 return tickets.map((t,i)=>({...t,probability:alpha*t.probability+(1-alpha)*weights[i]/total}))
}
export function fitMarketAnchorCandidate(input:ReplayInput){
 if(input.schemaVersion!==1||!Number.isFinite(Date.parse(input.asOf)))throw new Error('Invalid replay envelope')
 const seen=new Set<string>();for(const r of input.races){if(seen.has(r.raceId))throw new Error('Duplicate race ID');seen.add(r.raceId)}
 const rejected:Record<string,number>={},cutoff=Date.parse(MARKET_ANCHOR_PROTOCOL.simulatedFitCutoff)
 const trainRows=input.races.filter(r=>MARKET_ANCHOR_PROTOCOL.trainDates.some(d=>r.raceId.startsWith(`boat-${d}-`))).filter(r=>{
 const reason=rejection(r,input)??(!calibrationOutcomeValid(r,input.asOf)?'invalid_official_outcome':!(Date.parse(r.outcome!.availableAt)<cutoff)?'label_after_fit_cutoff':null)
 if(reason){rejected[reason]=(rejected[reason]??0)+1;return false}return true
 }).sort((a,b)=>a.raceId.localeCompare(b.raceId))
 if(!trainRows.length)throw new Error('No eligible training races')
 const loss=(alpha:number)=>trainRows.reduce((s,r)=>s-Math.log(Math.max(Number.MIN_VALUE,marketAnchorTransform(r.tickets,alpha).find(t=>t.selection===r.outcome!.winnerSelection)!.probability)),0)/trainRows.length
 let alpha=0,trainingNll=loss(0)
 for(let i=1;i<=100;i++){const nll=loss(i/100);if(nll<trainingNll-1e-12){alpha=i/100;trainingNll=nll}}
 return {alpha,trainingNll,marketOnlyTrainingNll:loss(0),identityTrainingNll:loss(1),trainRows,rejected,protocol:MARKET_ANCHOR_PROTOCOL,candidateOnly:true,registered:false,promoted:false,evaluationQualified:false,promotionEligible:false,status:'low_data_research_candidate_not_qualified',uncertainty:'Original probStd retained unchanged as an UNCALIBRATED risk proxy, not calibrated uncertainty or covariance.',interpretation:'Normalized inverse decision-time odds are a market reference, NOT true or calibrated probability; decision-time counterfactual, not original prediction-time inference.'}
}
