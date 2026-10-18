// Local files only. Build freezes before any prospective outcome input is opened.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
const [mode,inputPath,artifactPath,outputPath,expectedHash]=process.argv.slice(2)
if(!['freeze','evaluate'].includes(mode)||!inputPath||!artifactPath||mode==='evaluate'&&(!outputPath||!expectedHash))throw new Error('Usage: freeze INPUT ARTIFACT | evaluate INPUT ARTIFACT REPORT EXPECTED_ARTIFACT_SHA256')
const digest=b=>createHash('sha256').update(b).digest('hex'),dir=mkdtempSync(join(tmpdir(),'roi-residual-'))
try{
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',dir,'scripts/experimental-market-residual.ts'],{stdio:'pipe'})
 writeFileSync(join(dir,'package.json'),'{"type":"module"}')
 const api=await import(pathToFileURL(join(dir,'scripts/experimental-market-residual.js')).href)
 const implementationSha256=digest(readFileSync('scripts/experimental-market-residual.ts'))
 if(mode==='freeze'){
 const raw=readFileSync(inputPath),input=JSON.parse(raw)
 if(!(Date.parse(input.asOf)<=Date.now()))throw new Error('Training asOf is in the future')
 const fit=api.fitResidual(input)
 const artifact={schemaVersion:1,candidateId:'decision-market-residual-research',...fit,createdAt:new Date().toISOString(),implementationSha256,inputDatasetSha256:digest(raw),baseModelId:input.modelId,baseModelArtifactSha256:input.artifactSha256}
 const output=JSON.stringify(artifact,null,2)+'\n';writeFileSync(artifactPath,output,{flag:'wx'});console.log(JSON.stringify({artifactSha256:digest(output),createdAt:artifact.createdAt,trainingRaceCount:fit.trainingRaceCount,trainingNll:fit.trainingNll,weights:fit.weights}))
 }else{
 const raw=readFileSync(artifactPath);if(digest(raw)!==expectedHash)throw new Error('Frozen artifact SHA mismatch')
 const artifact=JSON.parse(raw);if(artifact.implementationSha256!==implementationSha256)throw new Error('Frozen implementation mismatch')
 const inputRaw=readFileSync(inputPath),report=api.evaluateResidual(JSON.parse(inputRaw),artifact)
 writeFileSync(outputPath,JSON.stringify({...report,artifactSha256:expectedHash,evaluationInputSha256:digest(inputRaw)},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,metrics:report.metrics}))
 }
}finally{rmSync(dir,{recursive:true,force:true})}
