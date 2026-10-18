/** Offline follow-up: reparse the same fixed population, changing labels only. */
import {existsSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const base='data/private_fixtures/residual-20261019',cache=join(base,'all-historical-official-recovery')
const artifactPath='docs/reports/market-residual-artifact-2026-10-19.json',artifactHash='0a875cbfb51030ccf6fb2010f13cd3b7b58602b9170b1c84e1338c8d2370c0b5'
const digest=x=>createHash('sha256').update(x).digest('hex'),artifactRaw=readFileSync(artifactPath),artifact=JSON.parse(artifactRaw)
if(digest(artifactRaw)!==artifactHash||digest(readFileSync('scripts/experimental-market-residual.ts'))!==artifact.implementationSha256)throw Error('Frozen artifact/implementation changed')
const inputPath=join(base,'test-accepted.json'),inputRaw=readFileSync(inputPath),original=JSON.parse(inputRaw),input=structuredClone(original),asOf=new Date().toISOString()
input.asOf=asOf
const archives=JSON.parse(readFileSync(join(base,'compressed-test-archives.json'))).rows
const exported=new Map(readFileSync(join(base,'compressed-test-outcomes.jsonl'),'utf8').trim().split('\n').map(line=>{const e=JSON.parse(line);return[e.race_id,e]}))
const dir=mkdtempSync(join(tmpdir(),'roi-complete-labels-'))
try{
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--types','node','--outDir',dir,'apps/api/src/services/boatraceResults.ts','scripts/market-residual-retrospective.ts'])
 writeFileSync(join(dir,'package.json'),'{"type":"module"}')
 const {parseBoatraceResults}=await import(pathToFileURL(join(dir,'apps/api/src/services/boatraceResults.js')))
 const {evaluateResidualRetrospective}=await import(pathToFileURL(join(dir,'scripts/market-residual-retrospective.js')))
 const evidence=[],refunds=[],failures=[],originalVerified=[]
 for(const race of input.races){
  const previousOutcome=race.outcome
  race.outcome=null
  try{
   const cacheDir=[cache,join(base,'official-recovery')].find(dir=>existsSync(join(dir,race.raceId+'.json'))&&existsSync(join(dir,race.raceId+'.html')))
   if(!cacheDir){
    const e=exported.get(race.raceId),norm=rows=>JSON.stringify(rows.map(r=>[r.number,r.finishOrder]).sort((a,b)=>a[0]-b[0]))
    if(!previousOutcome||!e||e.proof_status!=='success'||e.quality!=='verified-official-outcome-v2'||e.proof_race_id!==race.raceId||previousOutcome.sourceUrl!==e.url||previousOutcome.bodySha256!==e.sha256||previousOutcome.availableAt!==e.available_at||norm(e.proof_results_json)!==norm(e.db_results_json)||!e.proof_payouts_json.some(p=>p.selection===previousOutcome.winnerSelection&&p.payout===previousOutcome.payoutPer100)||!e.db_payouts_json.some(p=>p.selection===previousOutcome.winnerSelection&&p.payout===previousOutcome.payoutPer100))throw Error('Original verified export mismatch')
    race.outcome=previousOutcome;originalVerified.push({raceId:race.raceId,sourceUrl:e.url,bodySha256:e.sha256,availableAt:e.available_at,classification:'original_verified_canonical_label_unchanged_no_cached_html'});continue
   }
   const m=JSON.parse(readFileSync(join(cacheDir,race.raceId+'.json'))),html=readFileSync(join(cacheDir,race.raceId+'.html'))
   if(m.raceId!==race.raceId||digest(html)!==m.bodySha256||m.availableAt!==m.fetchedAt||!/(?:Z|[+-]\d\d:\d\d)$/.test(m.fetchedAt)||!Number.isFinite(Date.parse(m.fetchedAt))||Date.parse(m.fetchedAt)>Date.parse(asOf)||Date.parse(m.fetchedAt)<=Math.max(Date.parse(race.decisionAt),Date.parse(race.cutoffAt)))throw Error('Cached identity/hash/availability mismatch')
   const a=archives.find(a=>a.raceId===race.raceId)?.archive
   if(!a||a.race.id!==race.raceId)throw Error('Original archive missing/mismatch')
   const parsed=parseBoatraceResults(new TextDecoder('utf-8',{fatal:true}).decode(html),{url:m.sourceUrl,raceDate:a.race.date,venueCode:a.race.venueCode,raceNo:a.race.raceNo,entries:a.raceList.entries.map(x=>({number:x.lane,racerId:x.registrationNumber}))})
   const item={raceId:race.raceId,sourceUrl:m.sourceUrl,bodySha256:m.bodySha256,availableAt:m.fetchedAt,parsedAt:asOf,previousCacheStatus:m.status,cacheDirectory:cacheDir,results:parsed.results,payouts:parsed.payouts,terminalEntries:parsed.terminalEntries,refundNumbers:parsed.refundNumbers}
   if(parsed.refundNumbers.length){refunds.push({...item,classification:'verified_official_refund_excluded_from_single_winner_metrics'});continue}
   const payouts=parsed.payouts.filter(p=>p.betType==='trifecta')
   if(payouts.length!==1||parsed.terminalEntries.some(t=>!parsed.nonRefundableNumbers.includes(t.number)))throw Error('Single-label evaluator unsupported outcome')
   const p=payouts[0]
   race.outcome={raceId:race.raceId,qualityStatus:'verified-official-outcome-v2',verified:true,availableAt:m.fetchedAt,winnerSelection:p.selection,payoutPer100:p.payout,sourceUrl:m.sourceUrl,bodySha256:m.bodySha256}
   evidence.push(item)
  }catch(error){failures.push({raceId:race.raceId,reason:String(error)})}
 }
 const withoutLabels=x=>JSON.stringify(x.races.map(({outcome,...r})=>r)),before=digest(withoutLabels(original)),after=digest(withoutLabels(input))
 if(before!==after)throw Error('Forecast/odds/decision input changed')
 const evaluated=evaluateResidualRetrospective(input,artifact)
 const refundIds=new Set(refunds.map(r=>r.raceId))
 const selectedRefundExposureByArm=Object.fromEntries(Object.entries(evaluated.arms).map(([name,arm])=>[name,arm.decisions.filter(d=>refundIds.has(d.raceId)&&d.stakes.length)]))
 // The existing evaluator reserves any selected unlabelled race as unresolved risk.
 // Never invent refund win/loss labels or improve P&L by releasing this reserve.
 const report={...evaluated,unknownLabels:failures.length,verifiedRefundExcludedCount:refunds.length,evaluatorUnlabelledCount:evaluated.unknownLabels,labelCoverage:{fixedPopulation:input.races.length,normalVerified:evidence.length+originalVerified.length,strictHtmlReparsed:evidence.length+refunds.length,originalVerifiedUnchanged:originalVerified.length,verifiedRefunds:refunds.length,unknown:failures.length},followup:{schema:'frozen-residual-complete-label-followup-v1',originalAsOf:original.asOf,asOf,artifactSha256:artifactHash,implementationSha256:artifact.implementationSha256,officialParserSha256:digest(readFileSync('apps/api/src/services/boatraceResults.ts')),originalInputSha256:digest(inputRaw),nonOutcomeInputSha256Before:before,nonOutcomeInputSha256After:after,originalInputUnchanged:digest(readFileSync(inputPath))===digest(inputRaw),artifactUnchanged:digest(readFileSync(artifactPath))===artifactHash,fitPerformed:false,tuned:false,productionWrites:false,productionPersisted:false,canonicalProofCreated:false,availability:'actual cached fetch completion; parser acceptance recorded at followup asOf; never backdated',classification:'Refund races remain in the fixed 125-decision population but are excluded from single-winner NLL/Brier. Any selected refund stays unresolved reserved exposure in the unchanged evaluator, never a fabricated loss or win.',selectedRefundExposureByArm,originalVerified,previouslyUnsupportedNowNormal:evidence.filter(e=>e.previousCacheStatus==='unsupported').map(e=>e.raceId),refunds,failures,evidence}}
 const priorPath='docs/reports/market-residual-recovered-comparison-2026-10-19.json',priorRaw=readFileSync(priorPath),prior=JSON.parse(priorRaw)
 const choices=arm=>JSON.stringify(arm.decisions.map(d=>({raceId:d.raceId,stakes:d.stakes})))
 report.followup.previousReportSha256=digest(priorRaw)
 report.followup.decisionsAndStakesUnchangedByArm=Object.fromEntries(Object.keys(report.arms).map(name=>[name,choices(report.arms[name])===choices(prior.arms[name])]))
 if(Object.values(report.followup.decisionsAndStakesUnchangedByArm).some(value=>!value))throw Error('Frozen replay selections/stakes changed')
 const out=process.argv[2]??'docs/reports/market-residual-complete-label-comparison-2026-10-19.json'
 writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({output:out,coverage:report.labelCoverage,previouslyUnsupportedNowNormal:report.followup.previouslyUnsupportedNowNormal,selectedRefundExposureByArm,metrics:report.metrics,arms:Object.fromEntries(Object.entries(report.arms).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).filter(([x])=>x!=='decisions'))]))},null,2))
}finally{rmSync(dir,{recursive:true,force:true})}
