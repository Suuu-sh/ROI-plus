import { all, first, type Db, type Statement } from '../repo/db.js';
import { parseBoatraceResults } from './boatraceResults.js';
import { USER_AGENT } from './boatraceOdds.js';
import { reserveWriteBudgets, utcDate } from './writeBudget.js';

export const RESULTS_SOURCE = 'boatrace-results-worker-v1';
const MAX_TARGETS = 4;
const BODY_LIMIT = 512 * 1024;
const RESULT_FETCH_TIMEOUT_MS = 30_000;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export type ResultsRequestBudget = { used: number; max: number };
type RaceTarget = { id: string; venue_id: string; race_no: number; race_date: string };
export type CollectResultsOptions = {
  // Set only by the authenticated, explicitly confirmed manual route.
  mode?: 'hourly' | 'manual';
  maxRequests?: number;
  requestBudget?: ResultsRequestBudget;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};
const runId = (raceId: string) => `boat-result:${raceId}`;
export const resultUrl = (race: RaceTarget) => `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${race.race_no}&jcd=${race.venue_id}&hd=${race.race_date.replaceAll('-', '')}`;

export async function selectResultsTargets(db: Db, now: Date, maximum = MAX_TARGETS) {
  // Old open purchases may still need settlement; no history-wide collection.
  // Least recently attempted first prevents an unpublished race starving others.
  return all<RaceTarget>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date FROM races r
    LEFT JOIN collection_runs cr ON cr.id='boat-result:'||r.id AND cr.source=?
    WHERE r.sport='boat' AND r.data_origin='real' AND r.status IN ('scheduled','closed','finished')
      AND r.post_time IS NOT NULL AND julianday(r.post_time)<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.sport='boat' AND b.data_origin='real'
        AND b.status='open' AND b.bet_type IN ('win','trifecta')
        AND NOT EXISTS(SELECT 1 FROM data_repair_audit_marks m WHERE m.record_type='bet' AND m.record_id=b.id))
      AND NOT (
        (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real')=6
        AND (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')=6
        AND (SELECT COUNT(DISTINCT x.finish_order) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order BETWEEN 1 AND 6)=6
        AND NOT EXISTS(SELECT 1 FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.race_id=r.id AND e.data_origin='real' AND e.number=x.number))
        AND NOT EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='win' AND NOT EXISTS(SELECT 1 FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1 AND p.selection=CAST(x.number AS TEXT)))
        AND EXISTS(SELECT 1 FROM results x JOIN payouts p ON p.race_id=x.race_id AND p.data_origin=x.data_origin AND p.bet_type='win' AND p.selection=CAST(x.number AS TEXT) AND p.payout>0 WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)
        AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.data_origin='real' AND b.status='open' AND b.bet_type='trifecta'
          AND NOT EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='trifecta' AND p.payout>0
            AND p.selection=(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=2)||'-'||(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=3)))
      )
    ORDER BY julianday(cr.started_at) ASC,julianday(r.post_time) ASC,r.id ASC LIMIT ?`, RESULTS_SOURCE,
    new Date(now.getTime()-5*60_000).toISOString(), Math.min(MAX_TARGETS, Math.max(0, Math.floor(maximum))));
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
  const hour = now.toISOString().slice(0,13), budget = opts.requestBudget ?? {used:0,max:49};
  const manual=opts.mode==='manual';
  const lockKey=manual?'boat_results_manual_until':'boat_results_hour';
  const prior=await first<{value:string}>(db,'SELECT value FROM settings WHERE key=?',lockKey);
  if(manual&&prior){
    const until=Date.parse(prior.value);
    if(!Number.isFinite(until))return {...skipped,reason:'manual lock state unavailable'};
    if(until>now.getTime())return {...skipped,reason:'manual run in progress or throttled'};
  } else if(!manual&&prior&&prior.value>=hour)return skipped;
  const capacity=Math.min(MAX_TARGETS,Math.max(0,Math.floor(opts.maxRequests ?? MAX_TARGETS)),Math.max(0,budget.max-budget.used));
  if (!capacity) return skipped;
  const targets = await selectResultsTargets(db,now,capacity);
  if (!targets.length) return skipped;
  // Reserve worst-case results+payouts+status+control and log amplification BEFORE
  // any fetch or collector lock. Never refund a reservation after a crash/race.
  if (!await reserveWriteBudgets(db,utcDate(now),[
    {units:16+targets.length*55,category:'essential'},
    {units:targets.length*5,category:'collection'},
  ])) return {...skipped,reason:'daily D1 write budget unavailable or exhausted'};
  // The manual lease bypasses only the hourly marker. A 5-minute lease
  // covers the bounded 261s fetch path; after completion retain a 60s throttle.
  const lease=manual?new Date(now.getTime()+5*60_000).toISOString():hour;
  const lock=manual
    ?await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
      WHERE julianday(settings.value)<=julianday(?)`).bind(lockKey,lease,now.toISOString()).run()
    :await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
      WHERE settings.value<excluded.value`).bind(lockKey,lease).run();
  if(!lock.meta?.changes)return {...skipped,reason:manual?'manual run in progress or throttled':'hourly run already claimed'};
  const fetcher=opts.fetch ?? ((input,init)=>fetch(input,init)),sleep=opts.sleep ?? pause;
  let attempted=0,records=0,failed=0,verified=0;
  const fetchFailures:Array<FetchFailure & {count:number}>=[];
  try {
  for (const [index,race] of targets.entries()) {
    if (budget.used>=budget.max) break;
    const url=resultUrl(race),startedAt=new Date(now.getTime()+index).toISOString();
    let sha256:string|null=null,reason='official-result-unavailable';
    let fetchFailure:FetchFailure|undefined;
    try {
      if (!/^boat-\d{8}-\d{2}-\d{2}$/.test(race.id)
          ||race.id!==`boat-${race.race_date.replaceAll('-','')}-${race.venue_id}-${String(race.race_no).padStart(2,'0')}`) throw new Error('persisted race identity mismatch');
      const savedEntries=await all<{number:number;features_json:string|null}>(db,"SELECT number,features_json FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number",race.id);
      reason='saved-registry-incomplete';
      const entries=savedEntries.map(e=>{
        let racerId:string|undefined;
        try { const value=JSON.parse(e.features_json ?? '{}').racer_id; if(typeof value==='string'&&/^\d{4,5}$/.test(value))racerId=value; } catch { /* malformed metadata is rejected below */ }
        if(!racerId)throw new Error('saved complete registry missing');
        return {number:e.number,racerId};
      });
      if(entries.length!==6||entries.some(e=>!e.racerId))throw new Error('saved complete registry missing');
      reason='official-result-unavailable';
      let body:{html:string;sha256:string}|undefined;
      for(let retry=0;retry<2;retry++) {
        if(budget.used>=budget.max)break;
        if(budget.used>0)await sleep(3000);
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
          ||existingPayouts.some(x=>!parsed.payouts.some(y=>y.betType===x.bet_type&&y.selection===x.selection&&y.payout===x.payout))) throw new Error('existing result evidence conflict');
      const guardData=JSON.stringify({race,entries,cutoff:new Date(now.getTime()-5*60_000).toISOString(),results:parsed.results,payouts:parsed.payouts});
      const statements:Statement[]=[];
      statements.push(db.prepare(`INSERT INTO results(race_id,number,finish_order,data_origin)
        SELECT ?,json_extract(value,'$.number'),json_extract(value,'$.finishOrder'),'real' FROM json_each(?) WHERE ${currentSourceGuard}
        ON CONFLICT(race_id,number) DO NOTHING`).bind(race.id,JSON.stringify(parsed.results),guardData));
      statements.push(db.prepare(`INSERT INTO payouts(race_id,bet_type,selection,payout,data_origin)
        SELECT ?,json_extract(value,'$.betType'),json_extract(value,'$.selection'),json_extract(value,'$.payout'),'real' FROM json_each(?) WHERE ${currentSourceGuard}
        ON CONFLICT(race_id,bet_type,selection) DO NOTHING`).bind(race.id,JSON.stringify(parsed.payouts),guardData));
      statements.push(db.prepare(`UPDATE races SET status='finished',updated_at=? WHERE id=? AND ${currentSourceGuard}`).bind(new Date().toISOString(),race.id,guardData));
      const count=parsed.results.length+parsed.payouts.length;
      statements.push(logStatement(db,race,startedAt,'success',count,{raceId:race.id,url,sha256,quality:'verified-normal-v1',fetchedAt:new Date().toISOString()},guardData));
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
  return {status:records?(failed?'partial' as const:'success' as const):'failed' as const,records,verified,targets:targets.length,attempted,failed,fetchFailures};
  } finally {
    if(manual)await db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?')
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
    AND EXISTS(SELECT 1 FROM bets b WHERE b.race_id=current.id AND b.data_origin='real' AND b.status='open' AND b.sport='boat' AND b.bet_type IN ('win','trifecta')
      AND NOT EXISTS(SELECT 1 FROM data_repair_audit_marks m WHERE m.record_type='bet' AND m.record_id=b.id))
    AND (SELECT COUNT(*) FROM entries e WHERE e.race_id=current.id AND e.data_origin='real')=6
    AND (SELECT COUNT(*) FROM entries e JOIN json_each(gate.data,'$.entries') saved
      ON e.number=json_extract(saved.value,'$.number')
      WHERE e.race_id=current.id AND e.data_origin='real' AND CASE WHEN json_valid(e.features_json) THEN
        json_extract(e.features_json,'$.racer_id')=json_extract(saved.value,'$.racerId') ELSE 0 END)=6
    AND NOT EXISTS(SELECT 1 FROM results existing WHERE existing.race_id=current.id AND NOT EXISTS(
      SELECT 1 FROM json_each(gate.data,'$.results') incoming WHERE existing.data_origin='real'
        AND existing.number=json_extract(incoming.value,'$.number') AND existing.finish_order=json_extract(incoming.value,'$.finishOrder')))
    AND NOT EXISTS(SELECT 1 FROM payouts existing WHERE existing.race_id=current.id AND existing.bet_type IN ('win','trifecta') AND NOT EXISTS(
      SELECT 1 FROM json_each(gate.data,'$.payouts') incoming WHERE existing.data_origin='real'
        AND existing.bet_type=json_extract(incoming.value,'$.betType') AND existing.selection=json_extract(incoming.value,'$.selection') AND existing.payout=json_extract(incoming.value,'$.payout'))))`;
