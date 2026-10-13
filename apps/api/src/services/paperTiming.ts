import { BOATRACE_CUTOFF_MAX_AGE_MS } from './boatraceCutoff.js'

const TRUSTED_CUTOFF_SOURCE = 'boatrace-racelist-cutoff-v1'
const OFFSET_MS = 60_000
const TOLERANCE_MS = 10_000

export function primaryPaperTiming(cutoffAt: string | null | undefined, decisionAt: number,
  cutoffSource?: string | null, cutoffObservedAt?: string | null) {
  const cutoffMs = cutoffAt ? Date.parse(cutoffAt) : Number.NaN
  const observedMs = cutoffObservedAt ? Date.parse(cutoffObservedAt) : Number.NaN
  if (cutoffSource !== TRUSTED_CUTOFF_SOURCE || !Number.isFinite(cutoffMs) || !Number.isFinite(observedMs)) {
    return { eligible: false, reason: 'missing_or_invalid_cutoff', cutoffMs: null, targetMs: null, secondsBeforeCutoff: null, targetDeltaSeconds: null }
  }
  if (observedMs > decisionAt + 5_000) {
    return { eligible: false, reason: 'future_cutoff_observation', cutoffMs, targetMs: cutoffMs - OFFSET_MS, secondsBeforeCutoff: null, targetDeltaSeconds: null }
  }
  if (decisionAt - observedMs > BOATRACE_CUTOFF_MAX_AGE_MS) {
    return { eligible: false, reason: 'stale_cutoff_evidence', cutoffMs, targetMs: cutoffMs - OFFSET_MS, secondsBeforeCutoff: null, targetDeltaSeconds: null }
  }
  const targetMs = cutoffMs - OFFSET_MS
  const delta = decisionAt - targetMs
  const secondsBeforeCutoff = (cutoffMs - decisionAt) / 1000
  const targetDeltaSeconds = delta / 1000
  if (Math.abs(delta) <= TOLERANCE_MS) return { eligible: true, reason: null, cutoffMs, targetMs, secondsBeforeCutoff, targetDeltaSeconds }
  return { eligible: false, reason: delta > TOLERANCE_MS ? 'missed_timing' : 'not_due', cutoffMs, targetMs, secondsBeforeCutoff, targetDeltaSeconds }
}
