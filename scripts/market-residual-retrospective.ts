/** Separate retrospective research evaluator. Never prospective or promotion evidence. */
import {RESIDUAL_PROTOCOL,residualTransform,type ResidualArtifact} from './experimental-market-residual.js'
import {rejection,replayOpportunities,type ReplayInput} from './experimental-opportunity-replay.js'
import {calibrationOutcomeValid} from './experimental-probability-calibrator.js'
export function evaluateResidualRetrospective(input:ReplayInput,artifact:ResidualArtifact){
 if(input.schemaVersion!==1||!Number.isFinite(Date.parse(input.asOf)))throw new Error('Invalid envelope')
 if(!Number.isFinite(Date.parse(artifact.createdAt))||Date.parse(artifact.createdAt)>Date.parse(input.asOf)||JSON.stringify(artifact.protocol)!==JSON.stringify(RESIDUAL_PROTOCOL)||artifact.baseModelId!==input.modelId||artifact.baseModelArtifactSha256!==input.artifactSha256)throw new Error('Artifact protocol/source mismatch')
 if(!input.races.length)throw new Error('No retrospective evaluation input')
 if(input.races.some(r=>!/^boat-20261018-\d{2}-\d{2}$/.test(r.raceId)||artifact.trainingRaceIds.includes(r.raceId)||artifact.excludedInspectedRaceIds.includes(r.raceId)))throw new Error('Holdout date or inspected/training overlap')
 const seen=new Set<string>();for(const r of input.races){if(seen.has(r.raceId)||rejection(r,input))throw new Error('Invalid retrospective evidence');seen.add(r.raceId)}
 const labeled=input.races.filter(r=>calibrationOutcomeValid(r,input.asOf))
 const transforms={current:(t:typeof input.races[number]['tickets'])=>t,residual:(t:typeof input.races[number]['tickets'])=>residualTransform(t,artifact.weights),market:(t:typeof input.races[number]['tickets'])=>residualTransform(t,Array(19).fill(0))}
 const metrics=Object.fromEntries(Object.entries(transforms).map(([name,transform])=>[name,{races:labeled.length,meanNll:labeled.length?labeled.reduce((s,r)=>s-Math.log(Math.max(Number.MIN_VALUE,transform(r.tickets).find(t=>t.selection===r.outcome!.winnerSelection)!.probability)),0)/labeled.length:null,multiclassBrier:labeled.length?labeled.reduce((s,r)=>s+transform(r.tickets).reduce((n,t)=>n+(t.probability-Number(t.selection===r.outcome!.winnerSelection))**2,0),0)/labeled.length:null}]))
 // Invalid/unknown labels remain unresolved exposure, never synthetic losses or wins.
 const safeInput={...input,races:input.races.map(r=>({...r,outcome:calibrationOutcomeValid(r,input.asOf)?r.outcome:null}))}
 const arms=Object.fromEntries(Object.entries(transforms).map(([name,forecastTransform])=>[name,replayOpportunities(safeInput,{forecastTransform}).candidates.find(c=>c.minRawProbability===.1&&c.maxOdds===50)!]))
 return {status:'retrospective_previously_unviewed_holdout_not_prospective_not_promotion_proof',actualFrozenAt:artifact.createdAt,asOf:input.asOf,sourceModelId:input.modelId,sourceModelArtifactSha256:input.artifactSha256,trainingRaceIds:artifact.trainingRaceIds,excludedInspectedRaceIds:artifact.excludedInspectedRaceIds,evaluationRaceIds:[...seen].sort(),evaluationRaceCount:seen.size,labeledRaceCount:labeled.length,unknownLabels:seen.size-labeled.length,decisionsBeforeFreeze:input.races.filter(r=>Date.parse(r.decisionAt)<=Date.parse(artifact.createdAt)).length,metrics,arms,policy:RESIDUAL_PROTOCOL.policy,fullyObservedMonths:0,monthlyPositiveProfitFrequency:null,registered:false,promoted:false,promotionEligible:false,noTuning:true,uncertainty:RESIDUAL_PROTOCOL.uncertainty}
}
