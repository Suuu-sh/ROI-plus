import { all, first, type Db, type Statement } from '../repo/db.js';
import { parseBoatraceResults } from './boatraceResults.js';
import { parseTrifectaOdds, trifectaOddsUrl } from './boatraceTrifectaOdds.js';
import { USER_AGENT } from './boatraceOdds.js';
import { estimateWorkerWriteUnits, reserveWriteBudgets, utcDate } from './writeBudget.js';
import { boatArchiveEvidenceValid } from './boatArchiveEvidence.js';

export const RESULTS_SOURCE = 'boatrace-results-worker-v1';
// Preserve the existing worst-case request envelope (eight target races, with
// one retry each) while allowing successful pages to advance farther. These
// are request-attempt budgets, not product-level race caps.
const HOURLY_MAX_ATTEMPTS = 16;
const MANUAL_MAX_ATTEMPTS = 8;
const TARGET_BATCH_SIZE = 8;
const BODY_LIMIT = 512 * 1024;
const RESULT_FETCH_TIMEOUT_MS = 30_000;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export type ResultsRequestBudget = { used: number; max: number };
type RaceTarget = { id: string; venue_id: string; race_no: number; race_date: string; betting_cutoff_at?: string|null; betting_cutoff_source?: string|null };
export type CollectResultsOptions = {
  // Set only by the authenticated, explicitly confirmed manual route.
  mode?: 'hourly' | 'manual';
  // Per-invocation network attempt limit. Retries use the same budget.
  maxAttempts?: number;
  requestBudget?: ResultsRequestBudget;
  // Explicitly collect labels only for races with validated archived PIT inputs.
  labelOnly?: boolean;
  // Canonical complete R2 archive races selected by the bounded archive cursor.
  // These are lower priority than open bets and share the existing request budget.
  archiveRaceIds?: string[];
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};
const runId = (raceId: string) => `boat-result:${raceId}`;
export const resultUrl = (race: RaceTarget) => `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${race.race_no}&jcd=${race.venue_id}&hd=${race.race_date.replaceAll('-', '')}`;

// A complete numeric/payout record is not enough to stop collection when an
// open ticket selects an official terminal runner: settlement still needs the
// source's explicit no-refund capsize evidence for that runner.
const missingOpenTerminalProofSql = `NOT EXISTS(
  SELECT 1 FROM entries te WHERE te.race_id=r.id AND te.data_origin='real'
    AND json_valid(te.features_json) AND (json_extract(te.features_json,'$.finish_code') IN ('F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走') OR json_extract(te.features_json,'$.finish_code') GLOB 'K[0-9]')
    AND (EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.data_origin='real' AND b.status='open' AND b.bet_type IN ('win','trifecta')
        AND instr('-'||b.selection||'-','-'||CAST(te.number AS TEXT)||'-')>0 AND NOT EXISTS(SELECT 1 FROM data_repair_audit_marks m WHERE m.record_type='bet' AND m.record_id=b.id))
      OR EXISTS(SELECT 1 FROM experimental_paper_bets eb WHERE eb.race_id=r.id AND eb.data_origin='real' AND eb.status='open'
        AND instr('-'||eb.selection||'-','-'||CAST(te.number AS TEXT)||'-')>0 AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=eb.id))
      OR EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets hb WHERE hb.race_id=r.id AND hb.data_origin='real' AND hb.status='open'
        AND instr('-'||hb.selection||'-','-'||CAST(te.number AS TEXT)||'-')>0))
    AND NOT EXISTS(SELECT 1 FROM collection_runs cp WHERE cp.id='boat-result:'||r.id AND cp.source='boatrace-results-worker-v1' AND cp.sport='boat'
      AND cp.status='success' AND cp.target_date=r.race_date AND json_valid(cp.reason)
      AND json_extract(cp.reason,'$.quality')='verified-official-outcome-v2' AND json_extract(cp.reason,'$.raceId')=r.id
      AND json_extract(cp.reason,'$.url')='https://www.boatrace.jp/owpc/pc/race/raceresult?rno='||r.race_no||'&jcd='||r.venue_id||'&hd='||replace(r.race_date,'-','')
      AND julianday(json_extract(cp.reason,'$.fetchedAt'))<=julianday('now')
      AND json_extract(cp.reason,'$.refundTablePresent')=1 AND json_extract(cp.reason,'$.refundPolicy')='official-post-start-capsize-v1'
      AND EXISTS(SELECT 1 FROM json_each(cp.reason,'$.nonRefundableNumbers') nr WHERE CAST(nr.value AS INTEGER)=te.number)
      AND EXISTS(SELECT 1 FROM json_each(cp.reason,'$.terminalEntries') ti WHERE CAST(json_extract(ti.value,'$.number') AS INTEGER)=te.number AND json_extract(ti.value,'$.finishCode')='転覆'))
)`;

export async function selectResultsTargets(db: Db, now: Date, maximum = TARGET_BATCH_SIZE, labelOnly = false, archiveRaceIds: string[] = []) {
  // Old open purchases may still need settlement; no history-wide collection.
  // Least recently attempted first prevents an unpublished race starving others.
  const jstDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const archiveIds=archiveRaceIds.filter(id=>/^boat-\d{8}-\d{2}-\d{2}$/.test(id)).slice(0,80)
  const archiveIdSql=archiveIds.length?`r.id IN (${archiveIds.map(()=>'?').join(',')})`:'0'
  return all<RaceTarget>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date,r.betting_cutoff_at,r.betting_cutoff_source FROM races r
    LEFT JOIN collection_runs cr ON cr.id='boat-result:'||r.id AND cr.source=?
    WHERE r.sport='boat' AND r.data_origin='real' AND r.status IN ('scheduled','closed','finished')
      AND r.post_time IS NOT NULL AND julianday(r.post_time)<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND ((?=0 AND (EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.sport='boat' AND b.data_origin='real'
        AND b.status='open' AND b.bet_type IN ('win','trifecta')
        AND NOT EXISTS(SELECT 1 FROM data_repair_audit_marks m WHERE m.record_type='bet' AND m.record_id=b.id))
        OR EXISTS(SELECT 1 FROM experimental_paper_bets eb
          JOIN experimental_paper_decisions ed ON ed.id=eb.decision_id AND ed.experiment_key='boat-trifecta-small-sample-v1'
          WHERE eb.race_id=r.id AND eb.data_origin='real')
        OR EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets hb
          JOIN historical_trifecta_experiment_decisions hd ON hd.id=hb.decision_id AND hd.experiment_key='boat-trifecta-historical-base-v1'
          WHERE hb.race_id=r.id AND hb.data_origin='real' AND hb.status='open')))
        OR (?=1 AND r.race_date=? AND r.betting_cutoff_source='boatrace-racelist-cutoff-v1'
          AND julianday(r.betting_cutoff_at)<=julianday(?,'-5 minutes')
          AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.data_origin='real' AND b.status='open')
          AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets hb WHERE hb.race_id=r.id AND hb.data_origin='real' AND hb.status='open')
          AND EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives ar WHERE ar.race_id=r.id AND ar.data_origin='real'
            AND julianday(ar.captured_at)<=julianday(r.betting_cutoff_at,'-60 seconds')
            AND json_valid(ar.archive_json) AND json_extract(ar.archive_json,'$.schema')='boat-prerace-capture-v1')
          AND NOT EXISTS(SELECT 1 FROM collection_runs proof WHERE proof.id='boat-result:'||r.id AND proof.source=?
            AND proof.status='success' AND json_valid(proof.reason) AND json_extract(proof.reason,'$.quality')='verified-official-outcome-v2'
            AND json_type(proof.reason,'$.results')='array' AND json_type(proof.reason,'$.payouts')='array'))
        OR (${archiveIdSql} AND r.betting_cutoff_source='boatrace-racelist-cutoff-v1'
          AND julianday(r.betting_cutoff_at)<=julianday(?)
          AND NOT EXISTS(SELECT 1 FROM collection_runs proof WHERE proof.id='boat-result:'||r.id AND proof.source=?
            AND proof.status='success' AND json_valid(proof.reason) AND json_extract(proof.reason,'$.quality')='verified-official-outcome-v2')))
      AND (?=1 OR ${archiveIdSql} OR (EXISTS(SELECT 1 FROM experimental_paper_bets eb WHERE eb.race_id=r.id AND eb.data_origin='real')
        AND NOT COALESCE((cr.status='success' AND json_valid(cr.reason) AND json_extract(cr.reason,'$.finalMarket.quality')='verified-result-final-market-v1'),0)) OR NOT (
        (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real')=6
        AND (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')+
          (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real' AND json_valid(e.features_json) AND (json_extract(e.features_json,'$.finish_code') IN ('F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走') OR json_extract(e.features_json,'$.finish_code') GLOB 'K[0-9]'))=6
        AND (SELECT COUNT(DISTINCT x.finish_order) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order BETWEEN 1 AND 6)=
          (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')
        AND NOT EXISTS(SELECT 1 FROM entries e JOIN results x ON x.race_id=e.race_id AND x.number=e.number AND x.data_origin=e.data_origin WHERE e.race_id=r.id AND e.data_origin='real' AND json_valid(e.features_json) AND (json_extract(e.features_json,'$.finish_code') IN ('F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走') OR json_extract(e.features_json,'$.finish_code') GLOB 'K[0-9]'))
        AND NOT EXISTS(SELECT 1 FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.race_id=r.id AND e.data_origin='real' AND e.number=x.number))
        AND NOT EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='win' AND NOT EXISTS(SELECT 1 FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1 AND p.selection=CAST(x.number AS TEXT)))
        AND EXISTS(SELECT 1 FROM results x JOIN payouts p ON p.race_id=x.race_id AND p.data_origin=x.data_origin AND p.bet_type='win' AND p.selection=CAST(x.number AS TEXT) AND p.payout>0 WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)
        AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.data_origin='real' AND b.status='open' AND b.bet_type='trifecta'
          AND NOT EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='trifecta' AND p.payout>0
            AND p.selection=(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=2)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=3)))
        AND NOT EXISTS(SELECT 1 FROM experimental_paper_bets eb WHERE eb.race_id=r.id AND eb.data_origin='real' AND eb.status='open'
          AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=eb.id)
          AND NOT EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='trifecta' AND p.payout>0
            AND p.selection=(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=2)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=3)))
        AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets hb WHERE hb.race_id=r.id AND hb.data_origin='real' AND hb.status='open'
          AND NOT EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='trifecta' AND p.payout>0
            AND p.selection=(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=2)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=3)))
        AND ${missingOpenTerminalProofSql}
      ))
    ORDER BY CASE WHEN EXISTS(SELECT 1 FROM bets ob WHERE ob.race_id=r.id AND ob.sport='boat' AND ob.data_origin='real' AND ob.status='open'
        AND NOT EXISTS(SELECT 1 FROM data_repair_audit_marks m WHERE m.record_type='bet' AND m.record_id=ob.id))
        OR EXISTS(SELECT 1 FROM experimental_paper_bets eb WHERE eb.race_id=r.id AND eb.data_origin='real' AND eb.status='open')
        OR EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets hb WHERE hb.race_id=r.id AND hb.data_origin='real' AND hb.status='open') THEN 0 ELSE 1 END,
      julianday(cr.started_at) ASC,julianday(r.post_time) ASC,r.id ASC LIMIT ?`, RESULTS_SOURCE,
    new Date(now.getTime()-5*60_000).toISOString(),Number(labelOnly),Number(labelOnly),jstDate,
    new Date(now.getTime()).toISOString(),RESULTS_SOURCE,...archiveIds,new Date(now.getTime()-5*60_000).toISOString(),RESULTS_SOURCE,
    Number(labelOnly),...archiveIds,Math.max(0, Math.floor(maximum)));
}

type FetchFailureCode = 'http-status' | 'http-redirect-rejected' | 'body-missing' | 'body-too-large' | 'body-read-failed' | 'utf8-rejected' | 'hash-failed' | 'fetch-timeout' | 'fetch-rejected';
type FetchFailure = { code:FetchFailureCode; httpStatus?:number };
class ResultFetchFailure extends Error {
  constructor(readonly diagnostic:FetchFailure) { super(diagnostic.code); }
}
const failure = (code:FetchFailureCode,httpStatus?:number) => new ResultFetchFailure({code,...(httpStatus===undefined?{}:{httpStatus})});
function safeFetchFailure(error:unknown):FetchFailure {
  if(error instanceof ResultFetchFailure)return error.diagnostic;
  const name=error && typeof error==='object' && 'name' in error?error.name:undefined;
  return {code:name==='TimeoutError'||name==='AbortError'?'fetch-timeout':'fetch-rejected'};
}
async function readBody(response: Response): Promise<{ html: string; sha256: string }> {
  // workerd supports manual/follow only, not redirect:error. Manual makes
  // HTTP redirects visible and rejects them without another network request.
  let earlyFailure:ResultFetchFailure|undefined;
  if(response.status>=300&&response.status<400)earlyFailure=failure('http-redirect-rejected',response.status);
  else if(!response.ok)earlyFailure=failure('http-status',response.status);
  else if(!response.body)earlyFailure=failure('body-missing',response.status);
  else if(Number(response.headers.get('content-length'))>BODY_LIMIT)earlyFailure=failure('body-too-large',response.status);
  if(earlyFailure){
    // Release upstream connections even when status/size rejects the body
    // before a reader is acquired. Preserve the safe original failure class.
    await response.body?.cancel().catch(()=>undefined);
    throw earlyFailure;
  }
  const chunks:Uint8Array[]=[];
  let size=0;
  try {
    const reader=response.body!.getReader();
    try {
      while(true) {
        const part=await reader.read();
        if(part.done)break;
        size+=part.value.length;
        if(size>BODY_LIMIT)throw failure('body-too-large',response.status);
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(()=>undefined); }
  } catch(error) {
    if(error instanceof ResultFetchFailure)throw error;
    throw failure('body-read-failed',response.status);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let html:string;
  try {html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw failure('utf8-rejected',response.status);}
  let hash:ArrayBuffer;
  try {hash=await crypto.subtle.digest('SHA-256',bytes);} catch {throw failure('hash-failed',response.status);}
  return {html,sha256:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')};
}

export async function collectResults(db: Db, now: Date, opts: CollectResultsOptions = {}) {
  const skipped = { status:'skipped' as const, records:0, verified:0, targets:0, attempted:0 };
  if (!db.batch) return {...skipped,reason:'atomic D1 batch required'};
  const minute = Math.floor(now.getUTCMinutes() / 10) * 10;
  const window = `${now.toISOString().slice(0,13)}:${String(minute).padStart(2,'0')}`;
  const budget = opts.requestBudget ?? {used:0,max:49};
  const manual=opts.mode==='manual';
  const lockKey=manual?'boat_results_manual_until':'boat_results_ten_minute';
  const prior=await first<{value:string}>(db,'SELECT value FROM settings WHERE key=?',lockKey);
  if(manual&&prior){
    const until=Date.parse(prior.value);
    if(!Number.isFinite(until))return {...skipped,reason:'manual lock state unavailable'};
    if(until>now.getTime())return {...skipped,reason:'manual run in progress or throttled'};
  } else if(!manual&&prior&&prior.value>=window)return skipped;
  const attemptStart=budget.used;
  const attemptLimit=Math.min(manual?MANUAL_MAX_ATTEMPTS:HOURLY_MAX_ATTEMPTS,
    Math.max(0,Math.floor(opts.maxAttempts ?? Number.MAX_SAFE_INTEGER)),
    Math.max(0,budget.max-budget.used));
  if (!attemptLimit) return skipped;
  const labelOnly=opts.labelOnly===true;
  const archiveRaceIds=(opts.archiveRaceIds??[]).filter(id=>/^boat-\d{8}-\d{2}-\d{2}$/.test(id)).slice(0,80)
  const targets = await selectResultsTargets(db,now,labelOnly?Math.min(4,attemptLimit):attemptLimit,labelOnly,archiveRaceIds);
  if (!targets.length) return skipped;
  const lease=manual?new Date(now.getTime()+5*60_000).toISOString():window;
  const fetcher=opts.fetch ?? ((input,init)=>fetch(input,init)),sleep=opts.sleep ?? pause;
  let attempted=0,records=0,failed=0,verified=0,processedTargets=0,batches=0,lockClaimed=false;
  const fetchFailures:Array<FetchFailure & {count:number}>=[];
  const hasAttemptCapacity=()=>budget.used-attemptStart<attemptLimit&&budget.used<budget.max;
  const reserveBatch=async (count:number)=>reserveWriteBudgets(db,utcDate(now),[
    // The lock is one real settings-row mutation; result rows are reserved
    // only after the official page has passed validation below.
    ...(!lockClaimed ? [{units:estimateWorkerWriteUnits(manual?2:1),category:'essential' as const}] : []),
    {units:count*5,category:'collection'},
  ]);
  const claimLock=async ()=>{
    const lock=manual
      ?await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
        WHERE julianday(settings.value)<=julianday(?)`).bind(lockKey,lease,now.toISOString()).run()
      :await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
        WHERE settings.value<excluded.value`).bind(lockKey,lease).run();
    return Boolean(lock.meta?.changes);
  };
  try {
  for (let offset=0;offset<targets.length&&hasAttemptCapacity();) {
    // Keep each reservation and processing batch bounded for D1. A failed
    // reservation is retried at smaller sizes so remaining daily headroom can
    // still make progress. Unprocessed targets stay queued for the next run.
    const remainingAttempts=attemptLimit-(budget.used-attemptStart);
    let batchSize=Math.min(TARGET_BATCH_SIZE,Math.ceil(remainingAttempts/2),targets.length-offset);
    let reserved=false;
    while(batchSize>0){
      if(await reserveBatch(batchSize)){reserved=true;break;}
      batchSize=Math.floor(batchSize/2);
    }
    if(!reserved) return {...skipped,...(processedTargets?{status:'partial' as const,records,verified,targets:processedTargets,attempted,failed,fetchFailures}:{}),reason:'daily D1 write budget unavailable or exhausted'};
    batches++;
    if(!lockClaimed){
      if(!await claimLock())return {...skipped,reason:manual?'manual run in progress or throttled':'hourly run already claimed'};
      lockClaimed=true;
    }
    for (let index=0;index<batchSize&&hasAttemptCapacity();index++) {
    const race=targets[offset+index];
    processedTargets++;
    const url=resultUrl(race),startedAt=new Date(now.getTime()+processedTargets).toISOString();
    let sha256:string|null=null,reason='official-result-unavailable';
    let fetchFailure:FetchFailure|undefined;
    try {
      if (!/^boat-\d{8}-\d{2}-\d{2}$/.test(race.id)
          ||race.id!==`boat-${race.race_date.replaceAll('-','')}-${race.venue_id}-${String(race.race_no).padStart(2,'0')}`) throw new Error('persisted race identity mismatch');
      const savedEntries=await all<{number:number;features_json:string|null}>(db,"SELECT number,features_json FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number",race.id);
      reason='saved-registry-incomplete';
      const entries=savedEntries.map(e=>{
        let racerId:string|undefined;
        let finishCode:string|null=null;
        try { const value=JSON.parse(e.features_json ?? '{}'); if(typeof value.racer_id==='string'&&/^\d{4,5}$/.test(value.racer_id))racerId=value.racer_id; if(typeof value.finish_code==='string')finishCode=value.finish_code; } catch { /* malformed metadata is rejected below */ }
        if(!racerId)throw new Error('saved complete registry missing');
        return {number:e.number,racerId,finishCode};
      });
      if(entries.length!==6||entries.some(e=>!e.racerId))throw new Error('saved complete registry missing');
      let labelArchiveId:string|null=null;
      if(labelOnly){
        reason='archived-prerace-evidence-unavailable';
        const archiveRow=await first<{id:string;captured_at:string;archive_json:string}>(db,"SELECT id,captured_at,archive_json FROM boatrace_prerace_capture_archives WHERE race_id=? AND data_origin='real' AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1",race.id,new Date(Date.parse(race.betting_cutoff_at??'')-60_000).toISOString());
        if(!race.betting_cutoff_at||race.betting_cutoff_source!=='boatrace-racelist-cutoff-v1'||!archiveRow)throw new Error('archive evidence missing');
        let archive:any;try{archive=JSON.parse(archiveRow.archive_json)}catch{throw new Error('archive evidence invalid');}
        if(archive.capturedAt!==archiveRow.captured_at||!boatArchiveEvidenceValid(archive,race,savedEntries))throw new Error('archive evidence rejected');
        labelArchiveId=archiveRow.id;
      }
      reason='official-result-unavailable';
      let body:{html:string;sha256:string}|undefined;
      for(let retry=0;retry<2;retry++) {
        if(!hasAttemptCapacity())break;
        if(budget.used>0)await sleep(3000);
        if(!hasAttemptCapacity())break;
        budget.used++;attempted++;
        try {
          const response=await fetcher(url,{headers:{'User-Agent':USER_AGENT,'Accept':'text/html'},redirect:'manual',signal:AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS)});
          body=await readBody(response);break;
        } catch(error) {
          fetchFailure=safeFetchFailure(error);
          const prior=fetchFailures.find(x=>x.code===fetchFailure!.code&&x.httpStatus===fetchFailure!.httpStatus);
          if(prior)prior.count++;else fetchFailures.push({...fetchFailure,count:1});
          // One bounded fetch/read retry; parser failures are not retried.
        }
      }
      if(!body){reason=fetchFailure?.code ?? 'official-result-unavailable';throw new Error('official result unavailable');}
      sha256=body.sha256;
      reason='official-page-identity-or-outcome-rejected';
      const parsed=parseBoatraceResults(body.html,{url,raceDate:race.race_date,venueCode:race.venue_id,raceNo:race.race_no,entries});
      const [existingResults,existingPayouts]=await Promise.all([
        all<{number:number;finish_order:number}>(db,"SELECT number,finish_order FROM results WHERE race_id=? AND data_origin='real'",race.id),
        all<{bet_type:string;selection:string;payout:number}>(db,"SELECT bet_type,selection,payout FROM payouts WHERE race_id=? AND data_origin='real' AND bet_type IN ('win','trifecta')",race.id),
      ]);
      reason='stored-evidence-conflict';
      // Don't silently repair/correct prior trusted evidence or settled tickets.
      if(existingResults.some(x=>!parsed.results.some(y=>y.number===x.number&&y.finishOrder===x.finish_order))
          ||existingPayouts.some(x=>!parsed.payouts.some(y=>y.betType===x.bet_type&&y.selection===x.selection&&y.payout===x.payout))
          ||parsed.terminalEntries.some(x=>{const old=entries.find(e=>e.number===x.number)?.finishCode;return old!==null&&old!==x.finishCode&&!(old==='転'&&x.finishCode==='転覆');})
          ||parsed.results.some(x=>!!entries.find(e=>e.number===x.number)?.finishCode)) throw new Error('existing result evidence conflict');
      // Reserve for the verified result, payout, race status and run-log rows
      // only once source and stored evidence are both accepted.
      if (!await reserveWriteBudgets(db,utcDate(now),[
        {units:estimateWorkerWriteUnits(parsed.results.length+parsed.payouts.length+parsed.terminalEntries.length+2),category:'essential'},
      ])) { reason='daily-write-budget-exhausted'; throw new Error('daily write budget exhausted'); }
      // Optional post-result market: same fetch budget/spacing, never blocks settlement.
      let finalMarket:Record<string,unknown>|undefined;
      const needsMarket=!labelOnly && await first(db,`SELECT 1 FROM bets WHERE race_id=? AND data_origin='real' AND bet_type='trifecta'
        UNION ALL SELECT 1 FROM experimental_paper_bets WHERE race_id=? AND data_origin='real' LIMIT 1`,race.id,race.id);
      if(needsMarket&&hasAttemptCapacity()) {
        const oddsUrl=trifectaOddsUrl(race.race_no,race.venue_id,race.race_date);
        for(let retry=0;retry<2&&hasAttemptCapacity();retry++) {
          if(budget.used>0)await sleep(3000);
          budget.used++;attempted++;
          let oddsBody:{html:string;sha256:string};
          try { oddsBody=await readBody(await fetcher(oddsUrl,{headers:{'User-Agent':USER_AGENT,'Accept':'text/html'},redirect:'manual',signal:AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS)})); }
          catch { continue; }
          try {
            const market=parseTrifectaOdds(oddsBody.html,{raceDate:race.race_date,venueCode:race.venue_id,raceNo:race.race_no});
            const winner=parsed.payouts.find(p=>p.betType==='trifecta');
            if(market.final&&winner&&market.odds.find(o=>o.selection===winner.selection)?.odds===winner.payout/100) {
              finalMarket={quality:'verified-result-final-market-v1',url:oddsUrl,sha256:oddsBody.sha256,fetchedAt:new Date().toISOString(),odds:market.odds};
            }
          } catch { /* identity, timing, coverage or payout mismatch stays missing */ }
          break;
        }
      }
      const guardData=JSON.stringify({race,entries,cutoff:new Date(now.getTime()-5*60_000).toISOString(),results:parsed.results,payouts:parsed.payouts,labelOnly,labelArchiveId});
      const guardedEntries=labelOnly?entries:entries.map(e=>({...e,finishCode:parsed.terminalEntries.find(x=>x.number===e.number)?.finishCode??e.finishCode}));
      const guardAfterTerminal=JSON.stringify({race,entries:guardedEntries,cutoff:new Date(now.getTime()-5*60_000).toISOString(),results:parsed.results,payouts:parsed.payouts,labelOnly,labelArchiveId});
      const statements:Statement[]=[];
      statements.push(db.prepare(`INSERT INTO results(race_id,number,finish_order,data_origin)
        SELECT ?,json_extract(value,'$.number'),json_extract(value,'$.finishOrder'),'real' FROM json_each(?) WHERE ${currentSourceGuard}
        ON CONFLICT(race_id,number) DO NOTHING`).bind(race.id,JSON.stringify(parsed.results),guardData));
      statements.push(db.prepare(`INSERT INTO payouts(race_id,bet_type,selection,payout,data_origin)
        SELECT ?,json_extract(value,'$.betType'),json_extract(value,'$.selection'),json_extract(value,'$.payout'),'real' FROM json_each(?) WHERE ${currentSourceGuard}
        ON CONFLICT(race_id,bet_type,selection) DO NOTHING`).bind(race.id,JSON.stringify(parsed.payouts),guardData));
      if(!labelOnly&&parsed.terminalEntries.length) statements.push(db.prepare(`UPDATE entries SET features_json=json_set(CASE WHEN json_valid(features_json) THEN features_json ELSE '{}' END,'$.finish_code',
        (SELECT json_extract(terminal.value,'$.finishCode') FROM json_each(?) terminal WHERE json_extract(terminal.value,'$.number')=entries.number))
        WHERE race_id=? AND data_origin='real' AND number IN (SELECT json_extract(value,'$.number') FROM json_each(?)) AND ${currentSourceGuard}`)
        .bind(JSON.stringify(parsed.terminalEntries),race.id,JSON.stringify(parsed.terminalEntries),guardData));
      statements.push(db.prepare(`UPDATE races SET status='finished',updated_at=? WHERE id=? AND ${currentSourceGuard}`).bind(new Date().toISOString(),race.id,guardAfterTerminal));
      const count=parsed.results.length+parsed.payouts.length+parsed.terminalEntries.length;
      statements.push(logStatement(db,race,startedAt,'success',count,{raceId:race.id,url,sha256,quality:'verified-official-outcome-v2',fetchedAt:new Date().toISOString(),results:parsed.results,payouts:parsed.payouts,...(finalMarket?{finalMarket}:{}),refundTablePresent:parsed.refundTablePresent,nonRefundableNumbers:parsed.nonRefundableNumbers,...(parsed.nonRefundableNumbers.length?{refundPolicy:'official-post-start-capsize-v1',terminalEntries:parsed.terminalEntries}:{})},guardAfterTerminal));
      reason='source-state-changed';
      const writes=await db.batch(statements);
      const logged=writes.at(-1) as {meta?:{changes?:number}}|undefined;
      if(!logged?.meta?.changes)throw new Error('source state changed');
      records+=count;verified++;
    } catch {
      failed++;
      // Safe static reason only: never log response body, runtime secrets, or
      // arbitrary upstream errors. Latest evidence only, one row per race.
      await db.batch([logStatement(db,race,startedAt,'failed',0,{raceId:race.id,url,sha256,quality:'unavailable-or-unsupported',fetchedAt:new Date().toISOString(),reason,...(fetchFailure?{fetchFailure}:{})})]);
    }
    }
    offset+=batchSize;
  }
  return {status:records?(failed?'partial' as const:'success' as const):'failed' as const,records,verified,targets:processedTargets,attempted,failed,fetchFailures,batches};
  } finally {
    if(manual&&lockClaimed)await db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?')
      .bind(new Date(Date.now()+60_000).toISOString(),lockKey,lease).run().catch(()=>undefined);
  }
}
function logStatement(db:Db,race:RaceTarget,startedAt:string,status:string,records:number,evidence:Record<string,unknown>,guardData?:string) {
  return db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error,reason)
    SELECT ?,?,'boat',?,?,?,?,?,NULL,? WHERE ${guardData?currentSourceGuard:'1'} ON CONFLICT(id) DO UPDATE SET
    started_at=excluded.started_at,finished_at=excluded.finished_at,status=excluded.status,records=excluded.records,error=NULL,reason=excluded.reason`)
    .bind(runId(race.id),RESULTS_SOURCE,race.race_date,startedAt,new Date().toISOString(),status,records,JSON.stringify(evidence),...(guardData?[guardData]:[]));
}

// Re-check mutable authority INSIDE every statement of the atomic batch. A
// concurrent K sync, quarantine, registry edit or settlement cannot turn a
// stale external response into trusted new result evidence.
const currentSourceGuard = `EXISTS(SELECT 1 FROM races current JOIN (SELECT ? data) gate
  ON current.id=json_extract(gate.data,'$.race.id')
  WHERE current.sport='boat' AND current.data_origin='real' AND current.status IN ('scheduled','closed','finished')
    AND current.post_time IS NOT NULL AND julianday(current.post_time)<=julianday(json_extract(gate.data,'$.cutoff'))
    AND current.race_date=json_extract(gate.data,'$.race.race_date')
    AND current.venue_id=json_extract(gate.data,'$.race.venue_id') AND current.race_no=json_extract(gate.data,'$.race.race_no')
    AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=current.id)
    AND (EXISTS(SELECT 1 FROM bets b WHERE b.race_id=current.id AND b.data_origin='real' AND b.status='open' AND b.sport='boat' AND b.bet_type IN ('win','trifecta')
      AND NOT EXISTS(SELECT 1 FROM data_repair_audit_marks m WHERE m.record_type='bet' AND m.record_id=b.id))
      OR EXISTS(SELECT 1 FROM experimental_paper_bets eb
        JOIN experimental_paper_decisions ed ON ed.id=eb.decision_id AND ed.experiment_key='boat-trifecta-small-sample-v1'
        WHERE eb.race_id=current.id AND eb.data_origin='real')
      OR EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets hb
        JOIN historical_trifecta_experiment_decisions hd ON hd.id=hb.decision_id AND hd.experiment_key='boat-trifecta-historical-base-v1'
        WHERE hb.race_id=current.id AND hb.data_origin='real' AND hb.status='open')
      OR (json_extract(gate.data,'$.labelOnly')=1 AND json_extract(gate.data,'$.labelArchiveId') IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=current.id AND b.data_origin='real' AND b.status='open')
        AND current.betting_cutoff_source='boatrace-racelist-cutoff-v1'
        AND EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives ar WHERE ar.id=json_extract(gate.data,'$.labelArchiveId')
          AND ar.race_id=current.id AND ar.data_origin='real' AND json_valid(ar.archive_json)
          AND julianday(ar.captured_at)<=julianday(current.betting_cutoff_at,'-60 seconds')
          AND json_extract(ar.archive_json,'$.schema')='boat-prerace-capture-v1')
        AND NOT EXISTS(SELECT 1 FROM collection_runs proof WHERE proof.id='boat-result:'||current.id AND proof.source='boatrace-results-worker-v1'
          AND proof.status='success' AND json_valid(proof.reason) AND json_extract(proof.reason,'$.quality')='verified-official-outcome-v2'
          AND json_type(proof.reason,'$.results')='array' AND json_type(proof.reason,'$.payouts')='array')))
    AND (SELECT COUNT(*) FROM entries e WHERE e.race_id=current.id AND e.data_origin='real')=6
    AND (SELECT COUNT(*) FROM entries e JOIN json_each(gate.data,'$.entries') saved
      ON e.number=json_extract(saved.value,'$.number')
      WHERE e.race_id=current.id AND e.data_origin='real' AND CASE WHEN json_valid(e.features_json) THEN
        json_extract(e.features_json,'$.racer_id')=json_extract(saved.value,'$.racerId') ELSE 0 END)=6
    AND NOT EXISTS(SELECT 1 FROM entries e JOIN json_each(gate.data,'$.entries') saved
      ON e.number=json_extract(saved.value,'$.number') WHERE e.race_id=current.id AND e.data_origin='real'
      AND (CASE WHEN json_valid(e.features_json) THEN json_extract(e.features_json,'$.finish_code') END) IS NOT json_extract(saved.value,'$.finishCode'))
    AND NOT EXISTS(SELECT 1 FROM results existing WHERE existing.race_id=current.id AND NOT EXISTS(
      SELECT 1 FROM json_each(gate.data,'$.results') incoming WHERE existing.data_origin='real'
        AND existing.number=json_extract(incoming.value,'$.number') AND existing.finish_order=json_extract(incoming.value,'$.finishOrder')))
    AND NOT EXISTS(SELECT 1 FROM payouts existing WHERE existing.race_id=current.id AND existing.bet_type IN ('win','trifecta') AND NOT EXISTS(
      SELECT 1 FROM json_each(gate.data,'$.payouts') incoming WHERE existing.data_origin='real'
        AND existing.bet_type=json_extract(incoming.value,'$.betType') AND existing.selection=json_extract(incoming.value,'$.selection') AND existing.payout=json_extract(incoming.value,'$.payout'))))`;
