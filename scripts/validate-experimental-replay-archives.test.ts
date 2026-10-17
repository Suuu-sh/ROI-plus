import { it, expect } from 'vitest'
import { validateReplayArchives } from './validate-experimental-replay-archives.js'
it('does not attest missing or forged incomplete archives',()=>{
 const row={raceId:'boat-20261017-01-01',archive:{schema:'boat-prerace-capture-v1'},race:{id:'boat-20261017-01-01'},entries:[],decisionAt:'2026-10-17T01:59:00Z',predictedAt:'2026-10-17T01:58:00Z',capturedAt:'2026-10-17T01:57:00Z'}
 const report=validateReplayArchives({rows:[row]}).rows[0]
 expect(report.decisionArchiveValid).toBe(false);expect(report.cutoffProof).toBeNull();expect(report.sourceHashes).toBeNull();expect(report.forecastArchiveAvailableBeforePrediction).toBe(false)
})
