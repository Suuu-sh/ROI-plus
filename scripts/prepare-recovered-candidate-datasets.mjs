/** Offline-only labels/features from immutable saved exports and cached official HTML. */
import {readFileSync,writeFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const base='data/private_fixtures/residual-20261019', acceptedAt=new Date().toISOString(), hash=x=>createHash('sha256').update(x).digest('hex'),tmp=mkdtempSync(join(tmpdir(),'roi-candidate-datasets-'))
try{
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--types','node','--outDir',tmp,'apps/api/src/services/boatraceResults.ts'])
writeFileSync(join(tmp,'package.json'),'{"type":"module"}')
const {parseBoatraceResults}=await import(pathToFileURL(join(tmp,'boatraceResults.js')))
const report={acceptedAt,parserSha256:hash(readFileSync('apps/api/src/services/boatraceResults.ts')),classification:'Retrospective fitting after viewed October 18 test. No prospective holdout claim.',splits:{}}
for(const split of ['train','test']){
 const inputPath=join(base,split==='train'?'train-input.json':'test-accepted.json'),raw=readFileSync(inputPath),input=JSON.parse(raw),original=structuredClone(input),archives=new Map(JSON.parse(readFileSync(join(base,`compressed-${split}-archives.json`))).rows.map(x=>[x.raceId,x])),captures=new Map(JSON.parse(readFileSync(join(base,`compressed-${split}-captures.json`))).rows.map(x=>[x.raceId,x])),exports=new Map(readFileSync(join(base,`compressed-${split}-outcomes.jsonl`),'utf8').trim().split('\n').map(x=>{const e=JSON.parse(x);return[e.race_id,e]})),evidence=[],features=[],failures=[]
 for(const r of input.races){
 const old=r.outcome;r.outcome=null
 try{
 const a=archives.get(r.raceId)?.archive,c=captures.get(r.raceId)
 if(!a||a.race.id!==r.raceId)throw Error('Missing original race archive')
 const cache=['all-historical-official-recovery','official-recovery'].map(x=>join(base,x)).find(x=>existsSync(join(x,r.raceId+'.json'))&&existsSync(join(x,r.raceId+'.html')))
 if(cache){
 const m=JSON.parse(readFileSync(join(cache,r.raceId+'.json'))),html=readFileSync(join(cache,r.raceId+'.html'))
 if(m.raceId!==r.raceId||hash(html)!==m.bodySha256||m.availableAt!==m.fetchedAt||!Number.isFinite(Date.parse(m.fetchedAt))||Date.parse(m.fetchedAt)>Date.parse(acceptedAt)||Date.parse(m.fetchedAt)<=Math.max(Date.parse(r.decisionAt),Date.parse(r.cutoffAt)))throw Error('Cache identity/hash/timestamp failed')
 const p=parseBoatraceResults(new TextDecoder('utf-8',{fatal:true}).decode(html),{url:m.sourceUrl,raceDate:a.race.date,venueCode:a.race.venueCode,raceNo:a.race.raceNo,entries:a.raceList.entries.map(e=>({number:e.lane,racerId:e.registrationNumber}))}),wins=p.payouts.filter(x=>x.betType==='trifecta'),classification=p.refundNumbers.length?'refund':wins.length!==1?'multiple_or_missing_trifecta':p.terminalEntries.some(t=>!p.nonRefundableNumbers.includes(t.number))?'unsupported_terminal':'single_winner'
 evidence.push({raceId:r.raceId,classification,sourceUrl:m.sourceUrl,bodySha256:m.bodySha256,availableAt:m.fetchedAt,acceptedAt,refundNumbers:p.refundNumbers,results:p.results,payouts:p.payouts})
 if(classification==='single_winner')r.outcome={raceId:r.raceId,qualityStatus:'verified-official-outcome-v2',verified:true,availableAt:m.fetchedAt,winnerSelection:wins[0].selection,payoutPer100:wins[0].payout,sourceUrl:m.sourceUrl,bodySha256:m.bodySha256}
 }else{
 const e=exports.get(r.raceId),norm=x=>JSON.stringify(x.map(v=>[v.number,v.finishOrder]).sort((a,b)=>a[0]-b[0]))
 if(!old||!e||e.proof_status!=='success'||e.quality!=='verified-official-outcome-v2'||e.proof_race_id!==r.raceId||old.sourceUrl!==e.url||old.bodySha256!==e.sha256||old.availableAt!==e.available_at||norm(e.proof_results_json)!==norm(e.db_results_json)||!e.proof_payouts_json.some(p=>p.selection===old.winnerSelection&&p.payout===old.payoutPer100)||!e.db_payouts_json.some(p=>p.selection===old.winnerSelection&&p.payout===old.payoutPer100))throw Error('Original verified export mismatch')
 r.outcome=old;evidence.push({raceId:r.raceId,classification:'original_verified_single_winner',sourceUrl:e.url,bodySha256:e.sha256,availableAt:e.available_at,acceptedAt})
 }
 if(c?.archiveIdentityVerified&&c.decisionArchiveValid&&c.forecastArchiveAvailableBeforePrediction&&Date.parse(c.availableAt)<=Date.parse(r.predictedAt)&&Date.parse(a.beforeinfo.capturedAt)<=Date.parse(r.predictedAt)&&a.beforeinfo.sha256===c.sourceHashes.beforeinfo&&a.raceList.sha256===c.sourceHashes.racelist){features.push({raceId:r.raceId,availableAt:c.availableAt,predictedAt:r.predictedAt,sourceHashes:c.sourceHashes,exhibitions:a.beforeinfo.exhibitions.map(({lane,exhibitionTime,tilt,weight,startCourse,startTime,falseStart})=>({lane,exhibitionTime,tilt,weight,startCourse,startTime,falseStart}))})}
 }catch(error){failures.push({raceId:r.raceId,reason:String(error)})}
 }
 const strip=x=>hash(JSON.stringify(x.races.map(({outcome,...r})=>r)))
 if(strip(input)!==strip(original)||input.asOf!==original.asOf)throw Error('Original features/asOf modified')
 const out=join(base,`candidate-recovered-${split}.json`),featureOut=join(base,`candidate-prerace-${split}-features.json`),evidenceOut=join(base,`candidate-recovered-${split}-evidence.json`)
 for(const [path,obj] of [[out,input],[featureOut,{schema:1,joinKey:'raceId',allowlist:['exhibitionTime','tilt','weight','startCourse','startTime','falseStart'],excluded:['registrationNumber','weather','weatherObservedAt','results','payouts'],rows:features}],[evidenceOut,{acceptedAt,rows:evidence,failures}]])writeFileSync(path,JSON.stringify(obj,null,2)+'\n',{flag:'wx'})
 if(split==='train'){ const ids=new Set(JSON.parse(readFileSync(join(base,'train-accepted.json'))).races.map(r=>r.raceId)); const accepted={...input,races:input.races.filter(r=>ids.has(r.raceId))}; writeFileSync(join(base,'candidate-recovered-train-accepted.json'),JSON.stringify(accepted,null,2)+'\n',{flag:'wx'}); writeFileSync(join(base,'train-accepted-recovered.json'),JSON.stringify({...accepted,asOf:acceptedAt},null,2)+'\n',{flag:'wx'}); report.acceptedTrain={races:accepted.races.length,labeled:accepted.races.filter(r=>r.outcome).length,gate:'Exact raceId intersection with original train-accepted.json; no re-admission of rejected inputs'} }
 report.splits[split]={inputPath,originalAsOf:original.asOf,inputSha256:hash(raw),nonOutcomeSha256:strip(input),races:input.races.length,labeled:input.races.filter(r=>r.outcome).length,classifications:evidence.reduce((a,e)=>(a[e.classification]=(a[e.classification]??0)+1,a),{}),features:features.length,failures,out,featureOut,evidenceOut}
}
writeFileSync(join(base,'candidate-dataset-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2))
}finally{rmSync(tmp,{recursive:true,force:true})}
