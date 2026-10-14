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
const allowedEvents = new Set(['paper-decision-timing','experimental-paper-decision','historical-trifecta-virtual-experiment','boat-ten-minute-results']);
const reasonAllowlist = new Set([
  'official_entries_incomplete','experimental_forecast_missing_or_invalid','forecast_predates_model',
  'official_archive_missing_or_stale','official_archive_invalid','official_archive_identity_or_odds_invalid',
  'purchase_odds_fetch_failed_or_window_elapsed','no_conservative_positive_edge','ten-minute-pass-failed',
  'official-result-unavailable',
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
  if (['success','partial','failed','skipped'].includes(value.status)) out.status = value.status;
  for (const key of ['evaluated','placedRaces','placedBets','targets','verified','records','attempted','settled']) {
    if (Number.isFinite(value[key])) out[key] = value[key];
  }
  if (typeof value.reason === 'string') out.reason = reasonAllowlist.has(value.reason) ? value.reason : 'other';
  if (value.abstainedByReason && typeof value.abstainedByReason === 'object') {
    out.abstainedByReason = Object.fromEntries(Object.entries(value.abstainedByReason)
      .filter(([key, count]) => reasonAllowlist.has(key) && Number.isFinite(count)));
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

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.log(JSON.stringify({ status: 'blocked', reason: 'required_credentials_unavailable', durationSeconds: 0 }));
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'roi-paper-tail-'));
  const config = join(dir, 'wrangler.toml');
  await writeFile(config, 'name = "roi-plus-api"\ncompatibility_date = "2026-10-09"\n');
  const cli = join(process.cwd(), '../../node_modules/wrangler/bin/wrangler.js');
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
  console.log(JSON.stringify({ status: captured ? 'captured' : 'tail_unavailable', durationSeconds: elapsed,
    exitCode: Number.isInteger(exitCode) ? exitCode : null, events }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
