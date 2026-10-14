#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export const CAPTURE_MS = 120_000;
const MAX_EVENTS = 200;
const MAX_BUFFER = 2 * 1024 * 1024;
const TRUSTED_CUTOFF_SOURCE = 'boatrace-racelist-cutoff-v1';
const allowedEvents = new Set(['paper-decision-timing','experimental-paper-decision','historical-trifecta-virtual-experiment','boat-ten-minute-results','paper-t60-target']);
const reasonAllowlist = new Set([
  'official_entries_incomplete','experimental_forecast_missing_or_invalid','forecast_predates_model',
  'official_archive_missing_or_stale','official_archive_invalid','official_archive_identity_or_odds_invalid',
  'purchase_odds_fetch_failed_or_window_elapsed','no_conservative_positive_edge','ten-minute-pass-failed',
  'official-result-unavailable','t60-window-expired','target-discovery-failed','decision-stage-failed',
]);
const stackFunctionAllowlist = new Set(['scheduled','autoBetWithReport','experimentalPaperDecision','historicalTrifectaExperimentDecision','collectResults','cron','settleOpen','fetchPurchaseOdds']);

export function safeErrorClass(value) {
  const s = String(value ?? '');
  if (/no such table/i.test(s)) return 'd1_no_such_table';
  if (/no such column/i.test(s)) return 'd1_no_such_column';
  if (/constraint failed|check constraint/i.test(s)) return 'd1_constraint_failure';
  if (/too many sql variables/i.test(s)) return 'd1_too_many_variables';
  if (/database is locked|database is busy/i.test(s)) return 'd1_busy';
  if (/cannot read properties of (undefined|null)/i.test(s)) return 'js_missing_property_receiver';
  if (/is not a function/i.test(s)) return 'js_not_callable';
  if (/invalid url/i.test(s)) return 'js_invalid_url';
  return 'unclassified';
}

function safeTimestamp(value) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n)) return null;
  const ms = n > 0 && n < 10_000_000_000 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function safeEvent(value, timestamp, output) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return; } }
  if (!value || typeof value !== 'object' || !allowedEvents.has(value.event) || output.length >= MAX_EVENTS) return;
  const out = { event: value.event, timestamp };
  if (['success','partial','failed','skipped','ready','none','expired'].includes(value.status)) out.status = value.status;
  if (['current','upcoming-t60'].includes(value.pass)) out.pass = value.pass;
  if (['TypeError','RangeError','SyntaxError','D1Error','Error'].includes(value.errorClass)) out.errorClass = value.errorClass;
  if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 600_000) out.elapsedMs = value.elapsedMs;
  if (Number.isFinite(value.startDeltaMs) && Math.abs(value.startDeltaMs) <= 600_000) out.startDeltaMs = value.startDeltaMs;
  for (const key of ['evaluated','placedRaces','placedBets','targets','verified','records','attempted','settled']) {
    if (Number.isFinite(value[key])) out[key] = value[key];
  }
  if (typeof value.reason === 'string') out.reason = reasonAllowlist.has(value.reason) ? value.reason : 'other';
  if (value.abstainedByReason && typeof value.abstainedByReason === 'object') {
    out.abstainedByReason = Object.fromEntries(Object.entries(value.abstainedByReason)
      .filter(([key, count]) => reasonAllowlist.has(key) && Number.isFinite(count)));
  }
  if (value.timingDroppedByReason && typeof value.timingDroppedByReason === 'object') {
    const timingReasons = new Set(['commit_window_elapsed','pre_batch_window_elapsed','purchase_evidence_stale_before_commit']);
    out.timingDroppedByReason = Object.fromEntries(Object.entries(value.timingDroppedByReason)
      .filter(([key,count]) => timingReasons.has(key) && Number.isFinite(count) && count >= 0 && count <= 100_000));
  }
  output.push(out);
}

function addException(exception, timestamp, output) {
  if (output.length >= MAX_EVENTS) return;
  const rawName = exception?.name;
  const exceptionType = ['TypeError','RangeError','SyntaxError','D1Error','Error'].includes(rawName) ? rawName : 'Other';
  const stack = typeof exception?.stack === 'string' ? exception.stack : '';
  const callsite = [...stack.matchAll(/(?:at\s+)?([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]).find(n => stackFunctionAllowlist.has(n));
  output.push({ event: 'invocation_exception', timestamp, exceptionType,
    errorClass: safeErrorClass(exception?.message), ...(callsite ? { callsite } : {}) });
}

export function parseTailRecords(chunks) {
  const output = [];
  let buffer = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const accept = raw => {
    let item;
    try { item = JSON.parse(raw); } catch { return; }
    if (!item || typeof item !== 'object') return;
    const timestamp = safeTimestamp(item.eventTimestamp ?? item.timestamp);
    const cron = item.event?.cron;
    if (typeof cron === 'string' && output.length < MAX_EVENTS) {
      output.push({ event: 'scheduled_invocation', timestamp, cron: cron === '* * * * *' ? cron : 'other',
        outcome: ['ok','exception','cpuExceeded','memoryExceeded'].includes(item.outcome) ? item.outcome : 'other' });
    }
    for (const log of Array.isArray(item.logs) ? item.logs : []) {
      const parts = Array.isArray(log.message) ? log.message : [log.message];
      const message = parts.filter(x => typeof x === 'string').join(' ');
      const before = output.length;
      safeEvent(message, timestamp, output);
      if (output.length > before) continue;
      if (log.level === 'error') {
        const errorClass = safeErrorClass(message);
        if (errorClass !== 'unclassified' && output.length < MAX_EVENTS) output.push({ event: 'worker_error', timestamp, errorClass });
      }
    }
    for (const ex of Array.isArray(item.exceptions) ? item.exceptions : []) addException(ex, timestamp, output);
    // Also support the older singular shape, without ever forwarding raw error text.
    if (item.exception && typeof item.exception === 'object') addException(item.exception, timestamp, output);
  };
  for (const chunk of chunks) {
    for (const ch of String(chunk)) {
      if (buffer.length >= MAX_BUFFER) { buffer = ''; depth = 0; quoted = false; escaped = false; continue; }
      if (depth === 0) { if (ch !== '{') continue; buffer = '{'; depth = 1; continue; }
      buffer += ch;
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { accept(buffer); buffer = ''; }
      }
    }
  }
  return output;
}

const contextSql = `WITH active_model AS (
  SELECT id, artifact_sha256, manifest_json FROM experimental_models
  WHERE status IN ('candidate','experimental') ORDER BY registered_at DESC,id DESC LIMIT 1
), latest_prediction AS (
  SELECT p.race_id, MAX(p.predicted_at) predicted_at
  FROM experimental_ticket_predictions p JOIN active_model m ON m.id=p.model_id
  JOIN races rr ON rr.id=p.race_id
  WHERE p.data_origin='real' AND p.feature_schema_version='ticket-selection-v1'
    AND p.artifact_sha256=m.artifact_sha256
    AND julianday(p.predicted_at)<=julianday(rr.betting_cutoff_at,'-60 seconds')
    AND julianday(p.predicted_at)>=julianday(rr.betting_cutoff_at,'-360 seconds')
  GROUP BY p.race_id
)
SELECT v.name venue,r.race_no raceNo,r.race_date raceDate,r.status,
  r.betting_cutoff_at cutoffAt,r.betting_cutoff_source cutoffSource,r.betting_cutoff_observed_at cutoffObservedAt,
  datetime(r.betting_cutoff_at,'-60 seconds') t60TargetAt,
  ROUND((julianday(r.betting_cutoff_at)-julianday('now'))*86400) secondsToCutoff,
  ROUND((julianday(r.betting_cutoff_at)-julianday('now'))*86400-60) secondsToT60Target,
  (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real') entryCount,
  (SELECT COUNT(*) FROM experimental_ticket_predictions p JOIN active_model m ON m.id=p.model_id
    JOIN latest_prediction lp ON lp.race_id=p.race_id AND lp.predicted_at=p.predicted_at
    WHERE p.race_id=r.id AND p.data_origin='real' AND p.feature_schema_version='ticket-selection-v1'
      AND p.artifact_sha256=m.artifact_sha256) predictionCount,
  (SELECT lp.predicted_at FROM latest_prediction lp WHERE lp.race_id=r.id) predictedAt,
  EXISTS(SELECT 1 FROM experimental_paper_decisions d WHERE d.experiment_key='boat-trifecta-small-sample-v1' AND d.race_id=r.id) hasExperimentalDecision,
  EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=r.id AND d.phase='primary_t60') hasNormalDecision,
  EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto') hasNormalBet,
  EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions d WHERE d.race_id=r.id) hasHistoricalDecision,
  EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) quarantined,
  EXISTS(SELECT 1 FROM experimental_models m WHERE m.status IN ('candidate','experimental')
    AND json_valid(m.manifest_json) AND json_extract(m.manifest_json,'$.trainingMode')='experimental'
    AND json_extract(m.manifest_json,'$.experimentalOnly')=1
    AND json_extract(m.manifest_json,'$.ticketArtifactSha256')=m.artifact_sha256
    AND json_extract(m.manifest_json,'$.boatFeatureSchemaVersion')='boat-prerace-v2-no-weather-experimental-v1'
    AND m.id=(SELECT id FROM active_model)) modelReadyGate,
  (julianday(r.betting_cutoff_at)-julianday('now')>70.0/86400
    AND julianday(r.betting_cutoff_at)-julianday('now')<=120.0/86400
    AND (EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)=0)
    AND ((NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto')
          AND NOT EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=r.id AND d.phase='primary_t60'))
      OR NOT EXISTS(SELECT 1 FROM experimental_paper_decisions d WHERE d.experiment_key='boat-trifecta-small-sample-v1' AND d.race_id=r.id)
      OR NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions d WHERE d.race_id=r.id))
    AND julianday(r.betting_cutoff_observed_at)<=julianday(r.betting_cutoff_at,'-55 seconds')
    AND julianday(r.betting_cutoff_observed_at)>=julianday(r.betting_cutoff_at,'-660 seconds')) productionT60Target
FROM races r JOIN venues v ON v.id=r.venue_id
WHERE r.sport='boat' AND r.data_origin='real' AND r.status='scheduled'
  AND r.race_date=strftime('%Y-%m-%d','now','+9 hours')
  AND r.betting_cutoff_source='${TRUSTED_CUTOFF_SOURCE}'
  AND julianday(r.betting_cutoff_at)>=julianday('now','-15 minutes')
  AND julianday(r.betting_cutoff_at)<=julianday('now','+15 minutes')
ORDER BY productionT60Target DESC,julianday(r.betting_cutoff_at),r.race_no LIMIT 30`;

export function safeDbRows(text) {
  let root;
  try { root = JSON.parse(text); } catch { return null; }
  const rows = [];
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.results) && value.results.every(x => x && typeof x === 'object' && ('raceNo' in x || 'modelReadyGate' in x))) {
      rows.push(...value.results);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  if (!rows.length) return null;
  return rows.slice(0,30).map(row => {
    const venue = typeof row.venue === 'string' && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9ー・]+$/u.test(row.venue) ? row.venue : undefined;
    const iso = value => {
      if (value == null) return null;
      const text = String(value);
      const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(text) ? `${text.replace(' ','T')}Z` : text;
      const date = Date.parse(normalized);
      return Number.isFinite(date) ? new Date(date).toISOString() : null;
    };
    const num = value => Number.isFinite(Number(value)) ? Number(value) : null;
    const bool = value => value === true || value === 1 || value === '1';
    return {
      ...(venue ? { venue } : {}), raceNo: Number.isInteger(Number(row.raceNo)) ? Number(row.raceNo) : null,
      raceDate: /^\d{4}-\d\d-\d\d$/.test(row.raceDate ?? '') ? row.raceDate : null,
      status: row.status === 'scheduled' ? row.status : 'other', cutoffAt: iso(row.cutoffAt),
      cutoffSource: row.cutoffSource === TRUSTED_CUTOFF_SOURCE ? TRUSTED_CUTOFF_SOURCE : 'other',
      cutoffObservedAt: iso(row.cutoffObservedAt), t60TargetAt: iso(row.t60TargetAt),
      secondsToCutoff: num(row.secondsToCutoff), secondsToT60Target: num(row.secondsToT60Target),
      entryCount: num(row.entryCount), predictionCount: num(row.predictionCount), predictedAt: iso(row.predictedAt),
      hasExperimentalDecision: bool(row.hasExperimentalDecision), hasNormalDecision: bool(row.hasNormalDecision),
      hasNormalBet: bool(row.hasNormalBet), hasHistoricalDecision: bool(row.hasHistoricalDecision),
      quarantined: bool(row.quarantined), modelReadyGate: bool(row.modelReadyGate), productionT60Target: bool(row.productionT60Target),
    };
  });
}

async function queryRemoteD1(cli) {
  if (!/^\s*WITH\b/i.test(contextSql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|VACUUM|PRAGMA)\b/i.test(contextSql)) {
    return { status:'blocked', reason:'read_only_query_guard' };
  }
  const child = spawn(process.execPath, [cli,'d1','execute','roi-plus','--remote','--yes','--json','--config','wrangler.toml','--command',contextSql], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore','pipe','ignore'],
  });
  let output = '';
  let tooLarge = false;
  child.stdout.on('data', chunk => {
    if (output.length + chunk.length <= 1_000_000) output += chunk.toString();
    else tooLarge = true;
  });
  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(null); }, 30_000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
  });
  if (exitCode !== 0 || tooLarge) return { status: 'unavailable', reason: tooLarge ? 'response_limit' : 'read_query_failed' };
  const rows = safeDbRows(output);
  return rows ? { status:'available', rowCount: rows.length, rows } : { status:'unavailable', reason:'unrecognized_read_result' };
}

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.log(JSON.stringify({ status: 'blocked', reason: 'required_credentials_unavailable', durationSeconds: 0 }));
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'roi-paper-tail-'));
  const config = join(dir, 'wrangler.toml');
  await writeFile(config, 'name = "roi-plus-api"\ncompatibility_date = "2026-10-09"\n');
  const cli = join(process.cwd(), '../../node_modules/wrangler/bin/wrangler.js');
  const d1Promise = queryRemoteD1(cli);
  const child = spawn(process.execPath, [cli,'tail','roi-plus-api','--config',config,'--format','json'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore','pipe','ignore'],
  });
  const chunks = [];
  let bufferedChars = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', line => {
    const chunk = `${line}\n`;
    if (bufferedChars + chunk.length <= MAX_BUFFER) { chunks.push(chunk); bufferedChars += chunk.length; }
  });
  const started = Date.now();
  let exitCode = null;
  let spawnFailed = false;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, CAPTURE_MS);
    child.once('close', code => { exitCode = code; clearTimeout(timer); resolve(); });
    child.once('error', () => { spawnFailed = true; clearTimeout(timer); resolve(); });
  });
  rl.close();
  await rm(dir, { recursive: true, force: true });
  const elapsed = Math.round((Date.now() - started) / 1000);
  const captured = elapsed >= 115 && !spawnFailed;
  const events = parseTailRecords(chunks);
  const d1Context = await d1Promise;
  console.log(JSON.stringify({ status: captured ? 'captured' : 'tail_unavailable', durationSeconds: elapsed,
    exitCode: Number.isInteger(exitCode) ? exitCode : null, events, d1Context }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
