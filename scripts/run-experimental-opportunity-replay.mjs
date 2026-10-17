// Compile only the offline module and its existing pure runtime dependency into an OS temp directory.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) throw new Error('Usage: node scripts/run-experimental-opportunity-replay.mjs INPUT.json OUTPUT.json (different paths)')
const directory=mkdtempSync(join(tmpdir(),'roi-opportunity-replay-'))
try {
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',directory,'scripts/experimental-opportunity-replay.ts'],{stdio:'pipe'})
 writeFileSync(join(directory,'package.json'),'{"type":"module"}')
 const imported=await import(pathToFileURL(join(directory,'scripts/experimental-opportunity-replay.js')).href)
 const report=imported.replayOpportunities(JSON.parse(readFileSync(inputPath,'utf8')))
 writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
 process.stdout.write(JSON.stringify({acceptedOpportunities:report.acceptedOpportunities,sourceOpportunities:report.sourceOpportunities,rejected:report.rejected})+'\n')
} finally { rmSync(directory,{recursive:true,force:true}) }
