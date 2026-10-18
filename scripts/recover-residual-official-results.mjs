/** Research-only official GET recovery. Never writes D1 or production proofs. */
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const base='data/private_fixtures/residual-20261019',out=join(base,'official-recovery');mkdirSync(out,{recursive:true})
const digest=b=>createHash('sha256').update(b).digest('hex')
const input=JSON.parse(readFileSync(join(base,'test-accepted.json'))),archives=JSON.parse(readFileSync(join(base,'compressed-test-archives.json'))).rows
const dir=mkdtempSync(join(tmpdir(),'roi-recovery-'))
try{
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',dir,'apps/api/src/services/boatraceResults.ts'])
writeFileSync(join(dir,'package.json'),'{"type":"module"}')
const {parseBoatraceResults,parseBoatraceRefundOutcome}=await import(pathToFileURL(join(dir,'boatraceResults.js')))
let last=0
for(const r of input.races.filter(r=>!r.outcome)){
 const id=r.raceId,metaPath=join(out,id+'.json'),htmlPath=join(out,id+'.html')
 if(existsSync(metaPath)){const m=JSON.parse(readFileSync(metaPath));if(m.status==='verified'&&existsSync(htmlPath)&&digest(readFileSync(htmlPath))===m.bodySha256)continue}
 const [,date,venue,num]=/^boat-(\d{8})-(\d{2})-(\d{2})$/.exec(id),url=`https://www.boatrace.jp/owpc/pc/race/raceresult?hd=${date}&jcd=${venue}&rno=${Number(num)}`
 const m={raceId:id,qualityStatus:'research-recovered-official-html-v1',sourceUrl:url,status:'unknown',originalAsOf:input.asOf,productionPersisted:false}
 try{
 let html
 if(existsSync(metaPath)&&existsSync(htmlPath)){
  const previous=JSON.parse(readFileSync(metaPath)),bytes=readFileSync(htmlPath)
  if(digest(bytes)!==previous.bodySha256)throw Error('cached_html_hash_mismatch')
  Object.assign(m,previous);html=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
 }else{
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,3100-(Date.now()-last))));last=Date.now()
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'ROIPlus-Research-Official-Result-Recovery/1.0'}})
  m.httpStatus=response.status;if(!response.ok)throw Error('http_status_'+response.status)
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>512*1024)throw Error('body_too_large')
  html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);m.fetchedAt=new Date().toISOString();m.availableAt=m.fetchedAt;m.bodySha256=digest(bytes);writeFileSync(htmlPath,bytes,{flag:'wx'})
 }
 const a=archives.find(a=>a.raceId===id)?.archive;if(!a)throw Error('trusted_roster_missing')
 const expected={url,raceDate:'2026-10-18',venueCode:venue,raceNo:Number(num),entries:a.raceList.entries.map(e=>({number:e.lane,racerId:e.registrationNumber}))}
 let parsed;try{parsed=parseBoatraceResults(html,expected)}catch{try{const refund=parseBoatraceRefundOutcome(html,expected);m.refundNumbers=refund.refundNumbers;m.refundPayouts=refund.payouts;m.reason='official_refund_outcome_unsupported_in_research'}catch{};throw Error(m.reason??'official_strict_parse_rejected')}
 if(parsed.terminalEntries.some(t=>!parsed.nonRefundableNumbers.includes(t.number)))throw Error('terminal_refund_state_unsupported_in_research')
 const payout=parsed.payouts.find(p=>p.betType==='trifecta');if(!payout)throw Error('trifecta_payout_missing')
 delete m.reason;Object.assign(m,{status:'verified',recoveredAt:new Date().toISOString(),results:parsed.results,terminalEntries:parsed.terminalEntries,nonRefundableNumbers:parsed.nonRefundableNumbers,payouts:parsed.payouts,winnerSelection:payout.selection,payoutPer100:payout.payout,rosterSourceSha256:a.raceList.sha256,parserVersion:'existing-strict-boatraceResults.ts',independentlyParsedOfficialHtml:true})
 }catch(e){m.reason=/^[a-z0-9_]+$/.test(e.message)?e.message:'official_strict_parse_rejected'}
 writeFileSync(metaPath,JSON.stringify(m,null,2)+'\n');console.log(id,m.status,m.reason??'')
}
}finally{rmSync(dir,{recursive:true,force:true})}
