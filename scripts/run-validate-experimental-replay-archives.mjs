// Bundle the exact runtime archive validator offline; no dependency downloads.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
const [inputPath,outputPath]=process.argv.slice(2)
if(!inputPath||!outputPath||resolve(inputPath)===resolve(outputPath))throw new Error('Usage: node scripts/run-validate-experimental-replay-archives.mjs INPUT.json OUTPUT.json')
const directory=mkdtempSync(join(tmpdir(),'roi-archive-validation-'))
try {
 const bundle=join(directory,'validator.mjs')
 buildSync({entryPoints:['scripts/validate-experimental-replay-archives.ts'],bundle:true,platform:'node',format:'esm',outfile:bundle,logLevel:'silent'})
 const {validateReplayArchives}=await import(pathToFileURL(bundle).href)
 const report=validateReplayArchives(JSON.parse(readFileSync(inputPath,'utf8')))
 writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
 process.stdout.write(JSON.stringify({rows:report.rows.length,valid:report.rows.filter(r=>r.decisionArchiveValid).length})+'\n')
} finally {rmSync(directory,{recursive:true,force:true})}
