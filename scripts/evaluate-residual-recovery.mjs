/** Local-only frozen replay with independently reparsed fresh official HTML labels. */
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const base='data/private_fixtures/residual-20261019',out=join(base,'official-recovery'),artifactPath='docs/reports/market-residual-artifact-2026-10-19.json',expectedHash='0a875cbfb51030ccf6fb2010f13cd3b7b58602b9170b1c84e1338c8d2370c0b5'
const digest=b=>createHash('sha256').update(b).digest('hex'),raw=readFileSync(artifactPath)
if(digest(raw)!==expectedHash)throw Error('Frozen artifact changed')
const artifact=JSON.parse(raw),inputRaw=readFileSync(join(base,'test-accepted.json')),original=JSON.parse(inputRaw),input=structuredClone(original),asOf=new Date().toISOString();input.asOf=asOf
if(artifact.implementationSha256!==digest(readFileSync('scripts/experimental-market-residual.ts')))throw Error('Frozen implementation changed')
const archives=JSON.parse(readFileSync(join(base,'compressed-test-archives.json'))).rows,dir=mkdtempSync(join(tmpdir(),'roi-recovery-eval-'))
try{
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--types','node','--outDir',dir,'scripts/residual-recovery-evidence.ts','scripts/market-residual-retrospective.ts'])
writeFileSync(join(dir,'package.json'),'{"type":"module"}')
const {recoveredResearchOutcome}=await import(pathToFileURL(join(dir,'scripts/residual-recovery-evidence.js'))),{evaluateResidualRetrospective}=await import(pathToFileURL(join(dir,'scripts/market-residual-retrospective.js')))
const evidence=[],failures=[]
for(const r of input.races.filter(r=>!r.outcome)){
 const e=JSON.parse(readFileSync(join(out,r.raceId+'.json')))
 if(e.status!=='verified'){failures.push(e);continue}
 const a=archives.find(a=>a.raceId===r.raceId).archive
 r.outcome=recoveredResearchOutcome(r,e,readFileSync(join(out,r.raceId+'.html')),{url:e.sourceUrl,raceDate:a.race.date,venueCode:a.race.venueCode,raceNo:a.race.raceNo,entries:a.raceList.entries.map(x=>({number:x.lane,racerId:x.registrationNumber}))},original.asOf,asOf)
 evidence.push(e)
}
const withoutOutcomes=x=>JSON.stringify(x.races.map(({outcome,...r})=>r)),before=digest(withoutOutcomes(original)),after=digest(withoutOutcomes(input))
if(before!==after)throw Error('Prediction/odds/input mutation')
const report={...evaluateResidualRetrospective(input,artifact),recovery:{schema:'research-recovered-official-html-v1',originalAsOf:original.asOf,recoveryAsOf:asOf,originalInputSha256:digest(inputRaw),originalVerifiedLabels:original.races.filter(r=>r.outcome).length,recoveredVerifiedLabels:evidence.length,remainingUnknowns:failures.length,failures,evidence,productionPersisted:false,canonicalProofCreated:false,internalAdapter:'Independently strict-validated official HTML mapped only in memory to shared offline evaluator outcome contract; not persisted verified-official-outcome-v2',artifactSha256:expectedHash,artifactUnchanged:digest(readFileSync(artifactPath))===expectedHash,originalInputUnchanged:digest(readFileSync(join(base,'test-accepted.json')))===digest(inputRaw),nonOutcomeInputSha256Before:before,nonOutcomeInputSha256After:after,predictionsOddsAndDecisionsUnchanged:before===after,availability:'fresh actual fetch completion, never inferred race completion',officialParserSha256:digest(readFileSync('apps/api/src/services/boatraceResults.ts')),recoveryAdapterSha256:digest(readFileSync('scripts/residual-recovery-evidence.ts')),fitPerformed:false,productionWrites:false}}
const originalExport=new Map(readFileSync(join(base,'compressed-test-outcomes.jsonl'),'utf8').trim().split('\n').map(line=>{const o=JSON.parse(line);return[o.race_id,o]})),counts={},differences=[]
const norm=rows=>JSON.stringify(rows.map(x=>[x.number,x.finishOrder]).sort((a,b)=>a[0]-b[0]))
for(const e of evidence){const o=originalExport.get(e.raceId),numericResultsMatch=norm(e.results)===norm(o.db_results_json),trifectaPayoutMatch=o.db_payouts_json.some(x=>x.selection===e.winnerSelection&&x.payout===e.payoutPer100);for(const key of [numericResultsMatch?'numericResultsMatch':'numericResultsDiffer',trifectaPayoutMatch?'trifectaPayoutMatch':'trifectaPayoutDifferOrMissing'])counts[key]=(counts[key]??0)+1;if(!numericResultsMatch||!trifectaPayoutMatch)differences.push({raceId:e.raceId,numericResultsMatch,trifectaPayoutMatch,originalDbResults:o.db_results_json,freshResults:e.results,originalDbPayouts:o.db_payouts_json,freshPayout:{selection:e.winnerSelection,payout:e.payoutPer100}})}
report.recovery.freshVersusOriginalExport={counts,differences,scope:'94 recovered races only; original saved D1 export, no current D1 query; terminal codes are fresh evidence, never inferred from original absent ranks'}
report.recovery.selectedPreviouslyUnknownByArm=Object.fromEntries(Object.entries(report.arms).map(([name,arm])=>[name,arm.decisions.filter(d=>d.stakes.length>0&&evidence.some(e=>e.raceId===d.raceId)).map(d=>({raceId:d.raceId,...d}))]))
writeFileSync('docs/reports/market-residual-recovered-comparison-2026-10-19.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({labeled:report.labeledRaceCount,unknown:report.unknownLabels,recovery:report.recovery.recoveredVerifiedLabels,metrics:report.metrics,arms:Object.fromEntries(Object.entries(report.arms).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).filter(([x])=>x!=='decisions'))]))},null,2))
}finally{rmSync(dir,{recursive:true,force:true})}
