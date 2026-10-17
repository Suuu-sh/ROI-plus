// Offline immutable builder. Does not score or select on holdout outcomes.
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const [inputPath,outputPath]=process.argv.slice(2)
if(!inputPath||!outputPath)throw new Error('Usage: node scripts/build-market-anchor-candidate.mjs INPUT OUTPUT')
const raw=readFileSync(inputPath),input=JSON.parse(raw),digest=b=>createHash('sha256').update(b).digest('hex'),dir=mkdtempSync(join(tmpdir(),'roi-market-anchor-'))
try{
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',dir,'scripts/experimental-market-anchor.ts'],{stdio:'pipe'})
 writeFileSync(join(dir,'package.json'),'{"type":"module"}')
 const {fitMarketAnchorCandidate}=await import(pathToFileURL(join(dir,'scripts/experimental-market-anchor.js')).href)
 const {trainRows,...fit}=fitMarketAnchorCandidate(input)
 const artifact={schemaVersion:1,candidateId:'market-anchor-research-2026-10-17',createdAt:new Date().toISOString(),inputDatasetSha256:digest(raw),baseModelId:input.modelId,baseModelArtifactSha256:input.artifactSha256,...fit,trainingRaceCount:trainRows.length,trainingRaceIds:trainRows.map(r=>r.raceId),trainingLabels:trainRows.map(r=>({raceId:r.raceId,availableAt:r.outcome.availableAt,bodySha256:r.outcome.bodySha256,winnerSelection:r.outcome.winnerSelection})),trainingRaceIdsSha256:digest(JSON.stringify(trainRows.map(r=>r.raceId)))}
 const output=JSON.stringify(artifact,null,2)+'\n';writeFileSync(outputPath,output,{flag:'wx'});console.log(JSON.stringify({artifactSha256:digest(output),alpha:fit.alpha,trainingRaceCount:trainRows.length}))
}finally{rmSync(dir,{recursive:true,force:true})}
