// Offline only. Frozen input and artifact are read; no registry, DB or network access.
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const [inputPath,artifactPath,outputPath]=process.argv.slice(2)
if(!inputPath||!artifactPath||!outputPath)throw new Error('Usage: node scripts/backtest-market-anchor.mjs INPUT ARTIFACT OUTPUT')
const raw=readFileSync(inputPath),artifactRaw=readFileSync(artifactPath),artifact=JSON.parse(artifactRaw),digest=b=>createHash('sha256').update(b).digest('hex')
if(digest(artifactRaw)!=='861364496f7e59aae0dd02951e1ad51262d0b84adf06359d487345b5cd770e2c')throw new Error('Frozen artifact SHA mismatch for this retrospective evaluation run')
if(digest(raw)!==artifact.inputDatasetSha256)throw new Error('Frozen input hash mismatch')
const dir=mkdtempSync(join(tmpdir(),'roi-market-anchor-'))
try{
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',dir,'scripts/backtest-market-anchor.ts'],{stdio:'pipe'})
 writeFileSync(join(dir,'package.json'),'{"type":"module"}')
 const {backtest}=await import(pathToFileURL(join(dir,'scripts/backtest-market-anchor.js')).href)
 const report={...backtest(JSON.parse(raw),artifact),candidateArtifactSha256:digest(artifactRaw),inputDatasetSha256:digest(raw)}
 writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({testAccepted:report.testAccepted,testLabeled:report.testLabeled,baseline:report.probabilityMetrics.current.meanNll,candidate:report.probabilityMetrics.anchor.meanNll}))
}finally{rmSync(dir,{recursive:true,force:true})}
