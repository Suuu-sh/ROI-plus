// Local files only. Verify an already-frozen artifact before opening retrospective holdout input.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
const [inputPath,artifactPath,outputPath,expectedHash]=process.argv.slice(2)
if(!inputPath||!artifactPath||!outputPath||!expectedHash)throw new Error('Usage: INPUT ARTIFACT REPORT EXPECTED_ARTIFACT_SHA256')
const digest=b=>createHash('sha256').update(b).digest('hex'),dir=mkdtempSync(join(tmpdir(),'roi-residual-'))
try{
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',dir,'scripts/market-residual-retrospective.ts'],{stdio:'pipe'})
 writeFileSync(join(dir,'package.json'),'{"type":"module"}')
 const api=await import(pathToFileURL(join(dir,'scripts/market-residual-retrospective.js')).href)
 const implementationSha256=digest(readFileSync('scripts/experimental-market-residual.ts'))
 const raw=readFileSync(artifactPath);if(digest(raw)!==expectedHash)throw new Error('Frozen artifact SHA mismatch')
 const artifact=JSON.parse(raw);if(artifact.implementationSha256!==implementationSha256)throw new Error('Frozen implementation mismatch')
 const inputRaw=readFileSync(inputPath),report=api.evaluateResidualRetrospective(JSON.parse(inputRaw),artifact)
 writeFileSync(outputPath,JSON.stringify({...report,artifactSha256:expectedHash,evaluationInputSha256:digest(inputRaw),retrospectiveImplementationSha256:digest(readFileSync('scripts/market-residual-retrospective.ts')),freezeVerifiedBeforeEvaluationInputRead:true},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,metrics:report.metrics}))
}finally{rmSync(dir,{recursive:true,force:true})}
