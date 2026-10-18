/** Local evidence only. Explicit manifest, sequential bounded official GETs; no D1 writes. */
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const [manifestPath,outputDir]=process.argv.slice(2)
if(!manifestPath||!outputDir)throw Error('Usage: manifest.json output-directory')
const manifest=JSON.parse(readFileSync(manifestPath)),rows=manifest.races
if(!Array.isArray(rows)||!rows.length||new Set(rows.map(r=>r.raceId)).size!==rows.length)throw Error('Invalid manifest')
const hash=b=>createHash('sha256').update(b).digest('hex'),dir=mkdtempSync(join(tmpdir(),'historical-results-'))
mkdirSync(outputDir,{recursive:true})
try{
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',dir,'apps/api/src/services/boatraceResults.ts'])
writeFileSync(join(dir,'package.json'),'{"type":"module"}')
const {parseBoatraceResults,parseBoatraceRefundOutcome}=await import(pathToFileURL(join(dir,'boatraceResults.js')))
const evidence=[];let last=0,newFetches=0,cacheReused=0
for(const r of rows){
 const match=/^boat-(\d{4})(\d{2})(\d{2})-(\d{2})-(\d{2})$/.exec(r.raceId);if(!match)throw Error('Invalid race id')
 const [,y,m,d,venue,num]=match,url=`https://www.boatrace.jp/owpc/pc/race/raceresult?hd=${y}${m}${d}&jcd=${venue}&rno=${Number(num)}`
 const meta={raceId:r.raceId,sourceUrl:url,productionPersisted:false,status:'fetch_failure'},own=join(outputDir,r.raceId),cached=r.cacheBase??own
 try{
 let bytes,previous
 if(existsSync(cached+'.html')&&existsSync(cached+'.json')){previous=JSON.parse(readFileSync(cached+'.json'));bytes=readFileSync(cached+'.html');if(hash(bytes)!==previous.bodySha256||previous.sourceUrl!==url)throw Error('cached_evidence_mismatch');meta.fetchedAt=previous.fetchedAt;cacheReused++}
 else{
  let response
  for(let attempt=0;attempt<2;attempt++){
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,3100-(Date.now()-last))));last=Date.now();newFetches++
   try{response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'ROIPlus-Research-Official-Result-Recovery/1.0'}});if(!response.ok)throw Error('http_status_'+response.status);break}catch(e){if(attempt===1)throw e}
  }
  bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>512*1024)throw Error('body_too_large');meta.fetchedAt=new Date().toISOString()
 }
 Object.assign(meta,{bodySha256:hash(bytes),availableAt:meta.fetchedAt,htmlPath:own+'.html'});if(!existsSync(own+'.html'))writeFileSync(own+'.html',bytes,{flag:'wx'})
 const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes),expected={url,raceDate:`${y}-${m}-${d}`,venueCode:venue,raceNo:Number(num),entries:r.entries}
 meta.status='unsupported';if(!Array.isArray(r.entries)||r.entries.length!==6){meta.reason='trusted_roster_missing'}else{
  try{const p=parseBoatraceResults(html,expected);if(p.terminalEntries.some(t=>!p.nonRefundableNumbers.includes(t.number)))throw Error('terminal_refund_state_unsupported');Object.assign(meta,{status:'verified_normal',results:p.results,payouts:p.payouts,terminalEntries:p.terminalEntries,nonRefundableNumbers:p.nonRefundableNumbers})}
  catch{try{const p=parseBoatraceRefundOutcome(html,expected);Object.assign(meta,{status:'verified_refund',refundNumbers:p.refundNumbers,payouts:p.payouts,excludedFromFrozenComparison:true,reason:'refund_cashflow_requires_separate_contract'})}catch{meta.reason='official_strict_parser_unsupported';meta.excludedFromFrozenComparison=true}}
 }
 meta.recoveredAt=new Date().toISOString()
 }catch(e){meta.reason=/^[a-z0-9_]+$/.test(e.message)?e.message:'official_fetch_or_decode_failed'}
 writeFileSync(own+'.json',JSON.stringify(meta,null,2)+'\n');evidence.push(meta);console.log(r.raceId,meta.status,meta.reason??'')
}
const counts={};for(const e of evidence)counts[e.status]=(counts[e.status]??0)+1
const summary={schema:'historical-official-recovery-v1',asOf:new Date().toISOString(),manifestSha256:hash(readFileSync(manifestPath)),total:rows.length,newFetchAttempts:newFetches,cacheReused,counts,productionWrites:false,evidence}
writeFileSync(join(outputDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({total:summary.total,newFetches,cacheReused,counts}))
}finally{rmSync(dir,{recursive:true,force:true})}
