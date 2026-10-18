/** Fail-closed provenance checks; pure and independently testable. */
export function verifyRecoveredBindings({artifact,oldArtifact,train,test,protocol,protocolSha256,trainerSha256}) {
 for(const input of [train,test])for(const candidate of [artifact,oldArtifact])if(candidate.baseModelId!==input.modelId||candidate.baseModelArtifactSha256!==input.artifactSha256)throw Error('Source model binding mismatch')
 if(protocolSha256!==artifact.protocolSha256||trainerSha256!==artifact.trainerSha256||JSON.stringify(protocol)!==JSON.stringify(artifact.protocol))throw Error('Frozen protocol/trainer mismatch')
 return {candidateSourceMatchesTrainAndTest:true,oldSourceMatchesTrainAndTest:true,protocolFileSha256Verified:true,protocolContentVerified:true,trainerSha256Verified:true}
}
