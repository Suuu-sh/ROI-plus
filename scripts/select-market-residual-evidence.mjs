// Local-only, fail-closed evidence selection. Never fits or changes a protocol.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {buildSync} from 'esbuild'
const [inputPath,outputPath,auditPath]=process.argv.slice(2)
if(!inputPath||!outputPath||!auditPath)throw Error('Usage: INPUT ACCEPTED_OUTPUT AUDIT_OUTPUT')
const dir=mkdtempSync(join(tmpdir(),'roi-residual-source-'))
try{
 const bundle=join(dir,'source.mjs')
 buildSync({stdin:{contents:"export {rejection} from './scripts/experimental-opportunity-replay.ts';export {calibrationOutcomeValid} from './scripts/experimental-probability-calibrator.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:bundle,logLevel:'silent'})
 const api=await import(pathToFileURL(bundle).href),raw=readFileSync(inputPath),input=JSON.parse(raw)
 if(input.schemaVersion!==1||!Number.isFinite(Date.parse(input.asOf)))throw Error('Invalid envelope')
 const ids=input.races.map(r=>r.raceId);if(new Set(ids).size!==ids.length)throw Error('Duplicate race ID')
 const rejected={},accepted=[]
 for(const race of input.races){const reason=api.rejection(race,input);if(reason)rejected[reason]=(rejected[reason]??0)+1;else accepted.push(race)}
 const acceptedRaw=JSON.stringify({...input,races:accepted},null,2)+'\n'
 const sha=x=>createHash('sha256').update(x).digest('hex')
 const audit={sourceRaces:input.races.length,acceptedSourceRaces:accepted.length,rejectedSourceRaces:input.races.length-accepted.length,rejected,acceptedWithVerifiedLabels:accepted.filter(r=>api.calibrationOutcomeValid(r,input.asOf)).length,acceptedMissingVerifiedLabels:accepted.filter(r=>!api.calibrationOutcomeValid(r,input.asOf)).length,acceptedRaceIds:accepted.map(r=>r.raceId),inputSha256:sha(raw),acceptedInputSha256:sha(acceptedRaw),asOf:input.asOf}
 writeFileSync(outputPath,acceptedRaw,{flag:'wx'});writeFileSync(auditPath,JSON.stringify(audit,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({...audit,acceptedRaceIds:undefined}))
}finally{rmSync(dir,{recursive:true,force:true})}
