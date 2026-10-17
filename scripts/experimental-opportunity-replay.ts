/** Offline only. No network, registry, DB or live policy writes.
 * Trust boundary: a read-only evidence exporter must validate persisted raw archive
 * identity, roster, source arrival, cutoff and result bodies before emitting proof
 * attestations. A host name or `verified: true` alone is not evidence. This module
 * checks source bindings/hashes/times but cannot re-hash bodies absent from input;
 * SHA fields are provenance, not signatures. Missing proofs fail closed.
 */
import { sizeExperimentalPortfolioResult, type ExperimentalTicket } from '../apps/api/src/services/experimentalSizing.js'

import { primaryPaperTiming } from '../apps/api/src/services/paperTiming.js'

export interface Opportunity {
  raceId: string; originalDecisionOutcome?: 'placed' | 'abstained'; originalDecisionReason?: string | null; decisionAt: string; cutoffAt: string; predictedAt: string; trainedAt: string; modelId: string
  dataOrigin: 'real'; tickets: ExperimentalTicket[]
  cutoffProof: { source: string; observedAt: string; url: string; sha256: string; raceId: string; cutoffAt: string; identityVerified: boolean }
  forecastProof: { artifactSha256: string; featureSchemaVersion: string; archiveIdentityVerified: boolean; availableAt: string }
  purchaseOddsProof: { url: string; sha256: string; requestedAt: string; capturedAt: string; qualityStatus: string; odds: {selection: string; odds: number}[] }
  outcome?: { raceId: string; qualityStatus: string; availableAt: string; winnerSelection: string; payoutPer100: number; sourceUrl: string; bodySha256: string; verified: boolean } | null
}
export interface ReplayInput { schemaVersion: 1; asOf: string; modelId: string; artifactSha256: string; races: Opportunity[] }
const ms = (v: string) => /(?:Z|[+-]\d\d:\d\d)$/.test(v ?? '') ? Date.parse(v) : NaN
const month = (v: number) => new Date(v + 9 * 3600_000).toISOString().slice(0, 7)
const sha = (v: string) => /^[a-f0-9]{64}$/.test(v ?? '')
const official = (v: string) => { try { const u = new URL(v); return u.protocol === 'https:' && u.hostname === 'www.boatrace.jp' } catch { return false } }
const raceUrl = (url: string, raceId: string, path: string) => { try { const id=/^boat-(\d{8})-(\d{2})-(\d{2})$/.exec(raceId),u=new URL(url); return !!id && official(url) && u.pathname===path && u.searchParams.get('hd')===id[1] && u.searchParams.get('jcd')===id[2] && Number(u.searchParams.get('rno'))===Number(id[3]) } catch { return false } }
const selections = new Set(Array.from({length: 6}, (_, a) => Array.from({length: 6}, (_, b) => Array.from({length: 6}, (_, c) => a !== b && a !== c && b !== c ? `${a+1}-${b+1}-${c+1}` : '')).flat()).flat().filter(Boolean))
export function rejection(r: Opportunity, input: ReplayInput): string | null {
  if (/^boat-20261013-/.test(r.raceId)) return 'user_declared_test_purchase_date'
  const d = ms(r.decisionAt), target = ms(r.cutoffAt) - 60_000, p = ms(r.predictedAt), trained = ms(r.trainedAt)
  if (r.dataOrigin !== 'real' || r.modelId !== input.modelId || !sha(input.artifactSha256)) return 'wrong_model_or_origin'
  if (![d,target,p,trained].every(Number.isFinite) || d > ms(input.asOf) || Math.abs(d-target)>10_000 || p > target || target-p>300_000 || trained>=p) return 'invalid_forecast_or_decision_time'
  if (!primaryPaperTiming(r.cutoffAt,d,r.cutoffProof?.source,r.cutoffProof?.observedAt).eligible || !(ms(r.cutoffProof?.observedAt)<=d)) return 'missing_cutoff_proof'
  const c=r.cutoffProof
  if(c.raceId!==r.raceId || c.cutoffAt!==r.cutoffAt || c.identityVerified!==true || !sha(c.sha256) || !raceUrl(c.url,r.raceId,'/owpc/pc/race/racelist')) return 'missing_cutoff_identity_proof'
  const f=r.forecastProof
  if (!f || f.artifactSha256!==input.artifactSha256 || f.featureSchemaVersion!=='ticket-selection-v1' || f.archiveIdentityVerified!==true || !(ms(f.availableAt)<=p)) return 'missing_forecast_source_proof'
  const o=r.purchaseOddsProof
  const identity = /^boat-(\d{8})-(\d{2})-(\d{2})$/.exec(r.raceId)
  let marketIdentity=false
  try { const u=new URL(o?.url); marketIdentity=!!identity && u.pathname==='/owpc/pc/race/odds3t' && u.searchParams.get('hd')===identity[1] && u.searchParams.get('jcd')===identity[2] && Number(u.searchParams.get('rno'))===Number(identity[3]) } catch {}
  if (!marketIdentity || !o || !official(o.url) || !sha(o.sha256) || o.qualityStatus!=='verified-complete-v1' || !(ms(o.requestedAt)<=ms(o.capturedAt) && ms(o.capturedAt)<=d) || Math.abs(ms(o.requestedAt)-target)>10_000 || Math.abs(ms(o.capturedAt)-target)>10_000) return 'missing_same_window_purchase_market'
  if (!Array.isArray(r.tickets) || r.tickets.length!==120 || new Set(r.tickets.map(t=>t.selection)).size!==120 || r.tickets.some(t=>!selections.has(t.selection) || !Number.isFinite(t.probability) || t.probability<0 || t.probability>1 || !Number.isFinite(t.probStd) || t.probStd<0 || !Number.isFinite(t.odds) || t.odds<=1) || Math.abs(r.tickets.reduce((s,t)=>s+t.probability,0)-1)>1e-6) return 'invalid_full_forecast'
  if (!Array.isArray(o.odds) || o.odds.length!==120 || new Set(o.odds.map(t=>t.selection)).size!==120 || r.tickets.some(t=>o.odds.find(x=>x.selection===t.selection)?.odds!==t.odds)) return 'incomplete_or_mismatched_market'
  return null
}
export interface ReplayOptions {
  forecastTransform?: (tickets: ExperimentalTicket[]) => ExperimentalTicket[]
  counterfactualMetadata?: Record<string, unknown>
  currentPolicyOnly?: boolean
}
export function replayOpportunities(input: ReplayInput, options: ReplayOptions = {}) {
  if (input.schemaVersion!==1 || !Number.isFinite(ms(input.asOf))) throw new Error('Invalid replay envelope')
  const duplicates=new Set<string>(), seen=new Set<string>()
  for(const r of input.races) { if(seen.has(r.raceId))duplicates.add(r.raceId); seen.add(r.raceId) }
  const accepted: Opportunity[]=[]; const rejected: Record<string,number>={}
  for (const r of input.races) { const reason=duplicates.has(r.raceId)?'duplicate_race':rejection(r,input); if(reason)rejected[reason]=(rejected[reason]??0)+1; else {
      if (!options.forecastTransform) accepted.push(r)
      else {
        const tickets=options.forecastTransform(structuredClone(r.tickets))
        if (!Array.isArray(tickets) || tickets.length!==120 || new Set(tickets.map(t=>t.selection)).size!==120 || tickets.some(t=>!selections.has(t.selection) || !Number.isFinite(t.probability) || t.probability<0 || t.probability>1 || r.tickets.find(x=>x.selection===t.selection)?.probStd!==t.probStd || r.tickets.find(x=>x.selection===t.selection)?.odds!==t.odds) || Math.abs(tickets.reduce((n,t)=>n+t.probability,0)-1)>1e-6) throw new Error('Invalid counterfactual forecast transform')
        accepted.push({...r,tickets})
      }
    } }
  accepted.sort((a,b)=>ms(a.decisionAt)-ms(b.decisionAt)||a.raceId.localeCompare(b.raceId))
  const policies=[{minProbability:0,maxOdds:Infinity}, ...[.05,.1,.2].flatMap(minProbability=>[20,50].map(maxOdds=>({minProbability,maxOdds})))];
  const candidates=(options.currentPolicyOnly?policies.slice(0,1):policies).map(policy=>{
    let spent=0; const exposures: {at:number;closed:number;stake:number}[]=[]; const events: {at:number;profit:number}[]=[]
    const months: Record<string,{grossStake:number;carriedMonthStartExposure:number;realizedProfit:number;unresolvedStake:number;races:number}>={}
    let unresolvedRefundRaces=0; const decisions=[]; const newlyPlacedFromOriginalAbstained: string[]=[]
    for(const r of accepted) {
      const at=ms(r.decisionAt), key=month(at), start=Date.parse(`${key}-01T00:00:00+09:00`)
      const m=months[key]??=( {grossStake:0,carriedMonthStartExposure:exposures.filter(e=>e.at<start && e.closed>=start).reduce((s,e)=>s+e.stake,0),realizedProfit:0,unresolvedStake:0,races:0} )
      // No recycling at all: this is a restrictive risk overlay, not a live bankroll reconstruction.
      const remaining=Math.max(0,10000-m.grossStake-m.carriedMonthStartExposure)
      const eligible=r.tickets.filter(t=>t.probability>=policy.minProbability && t.odds<=policy.maxOdds)
      const result=sizeExperimentalPortfolioResult(eligible,100000-spent,Math.min(1000,remaining))
      const stake=result.stakes.reduce((s,t)=>s+t.stake,0)
      decisions.push({raceId:r.raceId,stakes:result.stakes,abstentionReason:result.abstentionReason})
      if(!stake)continue
      if(r.originalDecisionOutcome==='abstained')newlyPlacedFromOriginalAbstained.push(r.raceId)
      spent+=stake; m.grossStake+=stake; m.races++
      const o=r.outcome
      const valid=o?.verified===true && o.raceId===r.raceId && o.qualityStatus==='verified-official-outcome-v2' && raceUrl(o.sourceUrl,r.raceId,'/owpc/pc/race/raceresult') && sha(o.bodySha256) && selections.has(o.winnerSelection) && Number.isSafeInteger(o.payoutPer100) && o.payoutPer100>0 && ms(o.availableAt)>at && ms(o.availableAt)>=ms(r.cutoffAt) && ms(o.availableAt)<=ms(input.asOf)
      if(o && o.qualityStatus==='verified-official-refund-outcome-v1')unresolvedRefundRaces++
      exposures.push({at,closed:valid?ms(o!.availableAt):Infinity,stake})
      if(valid) { const payout=result.stakes.reduce((s,t)=>s+(t.selection===o!.winnerSelection?t.stake/100*o!.payoutPer100:0),0); const profit=payout-stake; m.realizedProfit+=profit; events.push({at:ms(o!.availableAt),profit}) } else m.unresolvedStake+=stake
    }
    const settlementMonths: Record<string,number>={}; let net=0,peak=0,maxLoss=0,maxDrawdown=0
    // Aggregate simultaneous settlements before drawdown: no arbitrary within-instant ordering.
    const grouped=new Map<number,number>(); for(const e of events)grouped.set(e.at,(grouped.get(e.at)??0)+e.profit)
    for(const [at,profit] of [...grouped].sort((a,b)=>a[0]-b[0])) { net+=profit; peak=Math.max(peak,net); maxLoss=Math.max(maxLoss,-net); maxDrawdown=Math.max(maxDrawdown,peak-net); settlementMonths[month(at)]=(settlementMonths[month(at)]??0)+profit }
    const settlementMonthRisk:Record<string,{maxRealizedNetLoss:number;maxSettlementDrawdown:number}>={}
    for(const key of Object.keys(settlementMonths)) { let n=0,p=0,l=0,dd=0; for(const [at,profit] of [...grouped].sort((a,b)=>a[0]-b[0])) { if(month(at)!==key)continue; n+=profit;p=Math.max(p,n);l=Math.max(l,-n);dd=Math.max(dd,p-n) } settlementMonthRisk[key]={maxRealizedNetLoss:l,maxSettlementDrawdown:dd} }
    const unresolved=Object.values(months).reduce((s,m)=>s+m.unresolvedStake,0)
    return {minRawProbability:policy.minProbability,maxOdds:Number.isFinite(policy.maxOdds)?policy.maxOdds:null,months,settlementMonths,settlementMonthRisk,placedRaces:decisions.filter(d=>d.stakes.length>0).length,abstainedRaces:decisions.filter(d=>d.stakes.length===0).length,newlyPlacedFromOriginalAbstained:{count:newlyPlacedFromOriginalAbstained.length,raceIds:newlyPlacedFromOriginalAbstained},realizedProfit:net,maxRealizedNetLoss:maxLoss,maxSettlementDrawdown:maxDrawdown,unresolvedStake:unresolved,unresolvedRefundRaces,worstCaseProfit:net-unresolved,decisions}
  })
  return {...(options.forecastTransform?{counterfactual:{...options.counterfactualMetadata,originalSourceModelId:input.modelId,originalSourceArtifactSha256:input.artifactSha256,sourceProofsUnmodified:true,probStdStatus:'original_unchanged_risk_proxy_not_recalibrated'}}:{}),status:'insufficient_full_month_coverage',candidateOnly:true,registered:false,promoted:false,promotionEligible:false,winner:null,probabilityStatus:'RAW_UNCALIBRATED',fullyObservedMonths:0,monthlyPositiveProfitFrequency:null,sourceOpportunities:input.races.length,acceptedOpportunities:accepted.length,acceptedByOriginalOutcome:{placed:accepted.filter(r=>r.originalDecisionOutcome==='placed').length,abstained:accepted.filter(r=>r.originalDecisionOutcome==='abstained').length,unknown:accepted.filter(r=>!r.originalDecisionOutcome).length},rejected,policy:'Exact current Kelly selector; offline restrictive no-recycle gross JPY10000/month including month-start open exposure, JPY100000 initial non-recycling capital. Partial coverage only; no full-month proof accepted.',candidates}
}
