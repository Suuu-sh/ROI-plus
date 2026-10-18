/** Local files only. Freeze verification precedes opening test outcomes. */
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url'
import {evaluateRecoveredCandidate} from './evaluate-recovered-candidate.mjs'
import {verifyRecoveredBindings} from './recovered-candidate-evaluation-guards.mjs'
const base='data/private_fixtures/residual-20261019/',sha=x=>createHash('sha256').update(x).digest('hex'),read=p=>readFileSync(p),artifactPath=base+'recovered-market-interactions-artifact.json',frozenHash='999ef9d5ecabe531dbd889150f020f70036b30c4a48745e65b8ae7b1111924f5',raw=read(artifactPath)
if(sha(raw)!==frozenHash)throw Error('Frozen artifact mismatch')
const artifact=JSON.parse(raw);if(sha(read('scripts/recovered-market-model.ts'))!==artifact.implementationSha256)throw Error('Scorer implementation mismatch')
const oldPath='docs/reports/market-residual-artifact-2026-10-19.json',oldRaw=read(oldPath),old=JSON.parse(oldRaw)
if(sha(oldRaw)!=='0a875cbfb51030ccf6fb2010f13cd3b7b58602b9170b1c84e1338c8d2370c0b5'||sha(read('scripts/experimental-market-residual.ts'))!==old.implementationSha256)throw Error('Old frozen artifact mismatch')
// Test outcomes are first opened only after both freezes verified above.
const testPath=base+'candidate-recovered-test.json',testRaw=read(testPath),input=JSON.parse(testRaw),audit=JSON.parse(read(base+'candidate-dataset-audit.json'))
input.asOf=audit.acceptedAt
const trainRaw=read(base+'candidate-recovered-train-accepted.json');if(sha(trainRaw)!==artifact.inputDatasetSha256)throw Error('Training binding mismatch')
const sourceCompatibility=verifyRecoveredBindings({artifact,oldArtifact:old,train:JSON.parse(trainRaw),test:input,protocol:JSON.parse(read('scripts/recovered-market-model-protocol.json')),protocolSha256:sha(read('scripts/recovered-market-model-protocol.json')),trainerSha256:sha(read('scripts/train-recovered-market-model.py'))})
const dir=mkdtempSync(join(tmpdir(),'roi-recovered-eval-'))
try{
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--types','node','--outDir',dir,'scripts/recovered-market-model.ts','scripts/experimental-market-residual.ts','scripts/experimental-probability-calibrator.ts'])
 writeFileSync(join(dir,'package.json'),'{"type":"module"}')
 const load=p=>import(pathToFileURL(join(dir,p)))
 const {recoveredMarketTransform}=await load('scripts/recovered-market-model.js'),{residualTransform}=await load('scripts/experimental-market-residual.js'),{replayOpportunities,rejection}=await load('scripts/experimental-opportunity-replay.js'),{calibrationOutcomeValid}=await load('scripts/experimental-probability-calibrator.js')
 const transforms={current:t=>t,oldResidual:t=>residualTransform(t,old.weights),market:t=>residualTransform(t,Array(19).fill(0)),candidate:t=>recoveredMarketTransform(t,artifact.weights)}
 const report=evaluateRecoveredCandidate({input,transforms,replayOpportunities,rejection,calibrationOutcomeValid,trainingRaceIds:artifact.trainingRaceIds})
 const nonOutcome=x=>sha(JSON.stringify(x.races.map(({outcome,...r})=>r)))
 report.provenance={evaluatedAt:new Date().toISOString(),originalDataAsOf:audit.acceptedAt,asOfMeaning:'Recovered-label data snapshot, not the time this evaluation ran',sourceCompatibility,actualFrozenAt:artifact.createdAt,candidateArtifactSha256:frozenHash,oldArtifactSha256:sha(oldRaw),implementationSha256:artifact.implementationSha256,testInputSha256:sha(testRaw),nonOutcomeInputSha256:nonOutcome(input),trainInputSha256:sha(trainRaw),datasetAuditSha256:sha(read(base+'candidate-dataset-audit.json')),asOf:input.asOf,originalAsOf:JSON.parse(testRaw).asOf,trainingRaceCount:artifact.trainingRaceCount,trainingRaceIds:artifact.trainingRaceIds,trainMaxRaceDate:artifact.trainingRaceIds.map(id=>id.split('-')[1]).sort().at(-1),testRaceIds:input.races.map(r=>r.raceId),trainTestOverlap:0,features:'127 ticket-derived lane, ordered-pair, incumbent/market ratio and market-marginal interactions; decision-time odds only; no outcomes/exhibition data passed to scorer',decisionSourceProofsUnchanged:true,originalInputUnchanged:sha(read(testPath))===sha(testRaw),artifactUnchanged:sha(read(artifactPath))===frozenHash,productionWrites:false,modelRegistryWrites:false}
 report.selection={...artifact.selection,selectedPolicyArm:artifact.selectedPolicyArm,learnedResearchCandidateL2:artifact.selectedL2,validationScores:artifact.validationScores,noTestWinnerSelection:true,explanation:'Train-only inner validation selected exact zero-residual market. Nonzero candidate retained as research proposal; test results do not change selection.'}
 const path='docs/reports/recovered-market-interactions-comparison-2026-10-19.json';writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({path,metrics:report.metrics,comparisons:report.comparisons,arms:Object.fromEntries(Object.entries(report.arms).map(([n,a])=>[n,{placedRaces:a.placedRaces,realizedProfit:a.realizedProfit,unresolvedStake:a.unresolvedStake,worstCaseProfit:a.worstCaseProfit,months:a.months,maxRealizedNetLoss:a.maxRealizedNetLoss,maxSettlementDrawdown:a.maxSettlementDrawdown}]))},null,2))
}finally{rmSync(dir,{recursive:true,force:true})}
