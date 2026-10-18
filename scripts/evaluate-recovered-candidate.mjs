/** Offline replay report. Inputs and frozen scorer are supplied by the local runner. */
import {scoreDistributions,pairedBootstrap,reliability} from './recovered-candidate-evaluation-metrics.mjs'
export function evaluateRecoveredCandidate({input,transforms,replayOpportunities,rejection,calibrationOutcomeValid,trainingRaceIds}) {
 const ids=new Set();for(const r of input.races){if(ids.has(r.raceId)||trainingRaceIds.includes(r.raceId)||!/^boat-20261018-/.test(r.raceId)||rejection(r,input))throw Error('Overlap/duplicate/date/source evidence failure');ids.add(r.raceId)}
 const labels=input.races.filter(r=>calibrationOutcomeValid(r,input.asOf));if(input.races.length!==125||labels.length!==123)throw Error('Fixed population changed')
 const arms={},metrics={},rowsByArm={}
 for(const [name,transform] of Object.entries(transforms)){
  // No outcomes cross the scorer boundary. Bind each cloned ticket set by its
  // exact identity+probability+odds+std fingerprint, not by invocation order.
  const byFingerprint=new Map(),fingerprint=ts=>JSON.stringify(ts)
  for(const r of input.races){const key=fingerprint(r.tickets);if(byFingerprint.has(key))throw Error('Ambiguous race fingerprint');byFingerprint.set(key,transform(structuredClone(r.tickets),r.raceId))}
  const transformed=ts=>{const found=byFingerprint.get(fingerprint(ts));if(!found)throw Error('Unknown race ticket identity');return structuredClone(found)}
  rowsByArm[name]=labels.map(r=>({raceId:r.raceId,tickets:transformed(r.tickets),winner:r.tickets.findIndex(t=>t.selection===r.outcome.winnerSelection)}))
  const scored=scoreDistributions(rowsByArm[name].map(r=>({probabilities:r.tickets.map(t=>t.probability),winner:r.winner})));metrics[name]=scored
  const safe={...input,races:input.races.map(r=>({...r,outcome:calibrationOutcomeValid(r,input.asOf)?r.outcome:null}))}
  const replay=replayOpportunities(safe,{forecastTransform:transformed});if(replay.acceptedOpportunities!==125)throw Error('Replay population changed')
  arms[name]=replay.candidates.find(c=>c.minRawProbability===.1&&c.maxOdds===50)
 }
 const comparisons={};for(const name of Object.keys(metrics))if(name!=='candidate')comparisons[`candidate_minus_${name}`]=Object.fromEntries(['nll','brier'].map(key=>[key,pairedBootstrap(metrics.candidate.losses.map(x=>x[key]),metrics[name].losses.map(x=>x[key]))]))
 const calibration=Object.fromEntries(Object.entries(rowsByArm).map(([name,rows])=>{
  const selected=new Set(arms[name].decisions.flatMap(d=>d.stakes.map(t=>`${d.raceId}/${t.selection}`)))
  const observations=(predicate)=>{let count=0,expectedWins=0,wins=0;for(const r of rows)r.tickets.forEach((t,i)=>{if(predicate(t,r)){count++;expectedWins+=t.probability;wins+=Number(i===r.winner)}});return {count,expectedWins,wins,meanProbability:count?expectedWins/count:null,observedWinFrequency:count?wins/count:null}}
  return [name,{all:reliability(rows),lowProbability:observations(t=>t.probability<.01),oddsAtLeast100:observations(t=>t.odds>=100),selected:observations((t,r)=>selected.has(`${r.raceId}/${t.selection}`)),selectedReliability:reliability(rows,(t,r)=>selected.has(`${r.raceId}/${t.selection}`))}]
 }))
 for(const value of Object.values(metrics))delete value.losses
 return {status:'repeated_retrospective_previously_inspected_test_not_unseen_or_prospective',fixedOpportunities:125,labelledNormalRaces:123,refundsExcludedFromSingleWinnerMetrics:2,unknownLabels:0,metrics,comparisons,calibration,arms,fullyObservedMonths:0,monthlyPositiveProfitFrequency:null,limitations:['October 18 only; not a full month','Zero observed initial open carry is an offline assumption, not production exposure proof','Refund selections remain reserved unresolved exposure; no fabricated refund P&L','Original probStd retained unchanged, not recalibrated','Repeated previously inspected holdout, not independent superiority evidence'],registered:false,promoted:false,promotionEligible:false}
}
