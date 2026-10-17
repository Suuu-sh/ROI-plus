/** Read-only persisted archive validation. No invented source attestations. */
import { boatArchiveEvidenceValid } from '../apps/api/src/services/boatArchiveEvidence.js'
export interface ArchiveRow { raceId:string; archive:any; race:any; entries:any[]; decisionAt:string; predictedAt:string; capturedAt:string }
const time=(s:string)=>/(?:Z|[+-]\d\d:\d\d)$/.test(s??'')?Date.parse(s):NaN
export function validateReplayArchives(input:{rows:ArchiveRow[]}) {
 return {rows:input.rows.map(row=>{
  const a=row.archive, d=time(row.decisionAt), p=time(row.predictedAt), captured=time(row.capturedAt)
  let identity=false
  try { identity=row.raceId===row.race?.id && boatArchiveEvidenceValid(a,row.race,row.entries) } catch {}
  const sourceTimes=[time(a?.raceList?.capturedAt),time(a?.beforeinfo?.capturedAt),time(a?.trifectaOdds?.capturedAt)]
  const timing=sourceTimes.every(t=>Number.isFinite(t)&&t<=d) && Number.isFinite(captured) && captured<=d && d-captured<=300000 && a?.trifectaOdds?.capturedAt===row.capturedAt
  const valid=identity&&timing
  const featureAvailableAt=sourceTimes.every(Number.isFinite)?Math.max(...sourceTimes):NaN
  return {raceId:row.raceId,archiveIdentityVerified:identity,decisionArchiveValid:valid,
   forecastArchiveAvailableBeforePrediction:valid&&Number.isFinite(p)&&featureAvailableAt<=p,
   availableAt:Number.isFinite(featureAvailableAt)?new Date(featureAvailableAt).toISOString():null,
   cutoffProof:valid?{source:'boatrace-racelist-cutoff-v1',observedAt:a.raceList.capturedAt,url:a.raceList.url,sha256:a.raceList.sha256,raceId:row.raceId,cutoffAt:a.raceList.cutoffAt,identityVerified:true}:null,
   sourceHashes:valid?{racelist:a.raceList.sha256,beforeinfo:a.beforeinfo.sha256,odds:a.trifectaOdds.sha256}:null,
   reason:!identity?'runtime_archive_identity_rejected':!timing?'archive_time_rejected':null}
 })}
}
