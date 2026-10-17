/** Research-only mean-distribution calibration; no runtime/registry integration.
 * Predeclared method: grid T=1.00..10.00 (step .01), minimum training multiclass
 * NLL, ties retain smaller T. No odds, returns, test labels or method selection.
 */
import { rejection, type Opportunity, type ReplayInput } from './experimental-opportunity-replay.js'
export const CALIBRATION_PROTOCOL = Object.freeze({method:'saved-mean-power-temperature',minTemperature:1,maxTemperature:10,step:.01,objective:'mean training multiclass negative log likelihood',regularization:0,simulatedFitCutoff:'2026-10-16T00:00:00+09:00',trainDates:['20261014','20261015'],testDates:['20261016','20261017'],qualifiedPipelineFloors:{train:300,validation:100,test:100},researchOnly:true})
export function temperatureTransform<T extends {probability:number}>(tickets:T[], temperature:number):T[] {
  if (!Number.isFinite(temperature) || temperature<1 || temperature>10 || tickets.length!==120 || tickets.some(t=>!Number.isFinite(t.probability)||t.probability<0||t.probability>1) || Math.abs(tickets.reduce((s,t)=>s+t.probability,0)-1)>1e-6) throw new Error('Invalid full normalized 120-ticket distribution or temperature')
  // Exact zeros remain zero. Log-sum-exp prevents underflow of small positive masses.
  const logs=tickets.map(t=>t.probability===0?-Infinity:Math.log(t.probability)/temperature), max=Math.max(...logs)
  const weights=logs.map(x=>Math.exp(x-max)), total=weights.reduce((a,b)=>a+b,0)
  return tickets.map((t,i)=>({...t,probability:weights[i]/total}))
}
const time=(s:string)=>/(?:Z|[+-]\d\d:\d\d)$/.test(s??'')?Date.parse(s):NaN
export function calibrationOutcomeValid(r:Opportunity,asOf:string):boolean {
  const o=r.outcome
  if(!o || o.verified!==true || o.raceId!==r.raceId || o.qualityStatus!=='verified-official-outcome-v2' || !/^[a-f0-9]{64}$/.test(o.bodySha256) || !Number.isSafeInteger(o.payoutPer100)||o.payoutPer100<=0 || !r.tickets.some(t=>t.selection===o.winnerSelection))return false
  try { const u=new URL(o.sourceUrl), id=/^boat-(\d{8})-(\d{2})-(\d{2})$/.exec(r.raceId);if(!id||u.protocol!=='https:'||u.hostname!=='www.boatrace.jp'||u.pathname!=='/owpc/pc/race/raceresult'||u.searchParams.get('hd')!==id[1]||u.searchParams.get('jcd')!==id[2]||Number(u.searchParams.get('rno'))!==Number(id[3]))return false }catch{return false}
  return time(o.availableAt)>time(r.decisionAt)&&time(o.availableAt)>=time(r.cutoffAt)&&time(o.availableAt)<=time(asOf)
}
export function fitTemperatureCandidate(input:ReplayInput) {
  if(input.schemaVersion!==1||!Number.isFinite(time(input.asOf)))throw new Error('Invalid replay envelope')
  const seen=new Set<string>();for(const r of input.races){if(seen.has(r.raceId))throw new Error('Duplicate race ID');seen.add(r.raceId)}
  const cutoff=time(CALIBRATION_PROTOCOL.simulatedFitCutoff),rejected:Record<string,number>={}
  const trainRows=input.races.filter(r=>CALIBRATION_PROTOCOL.trainDates.some(d=>r.raceId.startsWith(`boat-${d}-`))).filter(r=>{
    const reason=rejection(r,input)??(!calibrationOutcomeValid(r,input.asOf)?'missing_or_invalid_official_outcome':!(time(r.outcome!.availableAt)<cutoff)?'outcome_not_available_before_fit_cutoff':null)
    if(reason){rejected[reason]=(rejected[reason]??0)+1;return false}return true
  }).sort((a,b)=>a.raceId.localeCompare(b.raceId))
  if(!trainRows.length)throw new Error('No eligible training races')
  const loss=(temperature:number)=>trainRows.reduce((s,r)=>{const q=temperatureTransform(r.tickets,temperature).find(t=>t.selection===r.outcome!.winnerSelection)!.probability;return s-Math.log(Math.max(q,Number.MIN_VALUE))},0)/trainRows.length
  let temperature=1,trainingNll=loss(1)
  for(let i=101;i<=1000;i++){const t=i/100,nll=loss(t);if(nll<trainingNll){temperature=t;trainingNll=nll}}
  return {temperature,trainingNll,identityTrainingNll:loss(1),trainRows,rejected,protocol:CALIBRATION_PROTOCOL,candidateOnly:true,registered:false,promoted:false,evaluationQualified:false,promotionEligible:false,status:'low_data_research_candidate_not_qualified',uncertainty:'Original probStd retained unchanged as conservative uncertainty proxy; not calibrated uncertainty or covariance.'}
}
