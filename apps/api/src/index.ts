import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { all, first, run, type Db, type Statement } from './repo/db.js';
import { candidate, betId, settleValues, validateStake } from './services/logic.js';
import { collectOdds } from './services/collectBoatraceOdds.js';
import type { Sport, DataOrigin } from '@edgelab/shared';

interface Env { DB: Db; INGEST_TOKEN?: string; ENABLE_AUTO_BET?: string; ENABLE_BOATRACE_ODDS_SCRAPE?: string; PROXY_TOKEN?: string; }
type Ctx = { Bindings: Env };
const app = new Hono<Ctx>().basePath('/api');
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }));
// 本番では閲覧系 API を、Cloudflare Access で保護された画面 Worker（Service Binding）経由に限定する。
// PROXY_TOKEN 未設定（ローカル開発・テスト）では制限しない。ingest は従来どおり INGEST_TOKEN で認証。
app.use('*', async (c, next) => {
  const proxy = c.env.PROXY_TOKEN;
  const path = new URL(c.req.url).pathname;
  if (!proxy || path === '/api/health' || path.startsWith('/api/ingest/') || path === '/api/admin/settle') return next();
  if (c.req.header('X-ROI-Proxy') !== proxy) return c.json({ error: 'forbidden' }, 403);
  return next();
});
// Persist timestamps with a consistent JST offset; selection queries use
// julianday() so comparisons remain correct when imported ISO offsets differ.
const now = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const ODDS_MAX_AGE_MS = 10 * 60 * 1000;
const oddsFreshAfter = () => new Date(Date.now() - ODDS_MAX_AGE_MS + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const validSport = (v: string | null): v is Sport => v === 'horse' || v === 'boat';
const originFilter = (v: string | null | undefined) => v === 'sample' || v === 'real' ? v : null;
const jsonError = (c: any, message: string, status = 400) => c.json({ error: message }, status);
async function setting(db: Db, key: string, fallback: string): Promise<string> {
  return (await first<{value:string}>(db, 'SELECT value FROM settings WHERE key=?', key))?.value ?? fallback;
}
const availableBankrollSql = `(COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key='initial_bankroll'), 100000)
  + COALESCE((SELECT SUM(CASE WHEN status IN ('won','lost') THEN profit ELSE 0 END) FROM bets), 0)
  - COALESCE((SELECT SUM(CASE WHEN status='open' THEN stake ELSE 0 END) FROM bets), 0))`;
function auth(c: any) { const token = c.env.INGEST_TOKEN; return !!token && c.req.header('Authorization') === `Bearer ${token}`; }
function parseList(body: unknown): Record<string, unknown>[] | null {
  const rows = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as any).items) ? (body as any).items : null;
  return rows && rows.every((x: unknown) => x && typeof x === 'object' && !Array.isArray(x)) ? rows as Record<string, unknown>[] : null;
}
const ingestTables: Record<string,{table:string; required:string[]; conflict:string}> = {
  venues:{table:'venues',required:['id','sport','name'],conflict:'id'},
  races:{table:'races',required:['id','sport','venue_id','race_date','race_no','status','data_origin'],conflict:'id'},
  entries:{table:'entries',required:['id','race_id','number','name','available_at','data_origin'],conflict:'race_id,number'},
  odds:{table:'odds_snapshots',required:['id','race_id','bet_type','selection','captured_at','data_origin'],conflict:'race_id,bet_type,selection,captured_at'},
  results:{table:'results',required:['race_id','finish_order','number','data_origin'],conflict:'race_id,number'},
  payouts:{table:'payouts',required:['race_id','bet_type','selection','payout','data_origin'],conflict:'race_id,bet_type,selection'},
  predictions:{table:'predictions',required:['id','race_id','model_id','number','probability','predicted_at','data_origin'],conflict:'race_id,model_id,number,predicted_at'},
  models:{table:'models',required:['id','sport','bet_type','version','algorithm','status'],conflict:'id'},
  'collection-runs':{table:'collection_runs',required:['id','source','sport','target_date','started_at','status'],conflict:'id'},
};
const allowedColumns: Record<string,string[]> = {
  venues:'id sport name'.split(' '),
  races:'id sport venue_id race_date race_no name distance surface track_condition weather wind_speed wave_height post_time status data_origin updated_at'.split(' '),
  entries:'id race_id number frame name jockey trainer weight_carried horse_weight racer_class national_win_rate local_win_rate motor_no motor_2rate boat_no boat_2rate exhibition_time start_exhibition features_json available_at data_origin'.split(' '),
  odds_snapshots:'id race_id bet_type selection odds captured_at source data_origin'.split(' '),
  results:'race_id finish_order number data_origin'.split(' '),
  payouts:'race_id bet_type selection payout popularity data_origin'.split(' '),
  predictions:'id race_id model_id number probability prob_std predicted_at data_origin'.split(' '),
  models:'id sport bet_type version algorithm status train_from train_to valid_from valid_to test_from test_to n_train metrics_json trained_at notes'.split(' '),
  collection_runs:'id source sport target_date started_at finished_at status records error reason'.split(' '),
};
const updateColumns: Record<string,string[]> = {
  venues:['sport','name'],
  races:'sport venue_id race_date race_no name distance surface track_condition weather wind_speed wave_height post_time status data_origin updated_at'.split(' '),
  entries:'id frame name jockey trainer weight_carried horse_weight racer_class national_win_rate local_win_rate motor_no motor_2rate boat_no boat_2rate exhibition_time start_exhibition features_json available_at data_origin'.split(' '),
  odds_snapshots:'id odds source data_origin'.split(' '), results:['finish_order','data_origin'], predictions:'id probability prob_std data_origin'.split(' '),
  payouts:'payout popularity data_origin'.split(' '),
  models:'sport bet_type version algorithm status train_from train_to valid_from valid_to test_from test_to n_train metrics_json trained_at notes'.split(' '),
  collection_runs:'source sport target_date started_at finished_at status records error reason'.split(' '),
};
async function ingest(c: any, name: string) {
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const config = ingestTables[name], rows = parseList(await c.req.json().catch(()=>null));
  if (!config || !rows || rows.some(r => config.required.some(k => r[k] === undefined))) return jsonError(c, 'invalid payload');
  const table = config.table, allowed = allowedColumns[table], updates = updateColumns[table];
  const db: Db = c.env.DB, statements: Statement[] = [];
  for (const row of rows) {
    if (table === 'races' && row.updated_at === undefined) row.updated_at = now();
    if (table === 'models' && (row.status === 'active' || row.status === 'retired')) {
      const existing = await first<any>(c.env.DB, 'SELECT status FROM models WHERE id=?', row.id);
      if (!existing || existing.status !== row.status) return jsonError(c, 'ingest cannot change model lifecycle status');
    }
    if (table === 'models' && !['candidate','untrained','active','retired'].includes(String(row.status))) return jsonError(c, 'invalid model status');
    const cols = Object.keys(row).filter(k => allowed.includes(k));
    if (config.required.some(k => !cols.includes(k))) return jsonError(c, 'missing required fields');
    const updateSet = updates.filter(k=>cols.includes(k)).map(k=>`${k}=excluded.${k}`);
    if (table === 'races' && cols.includes('status')) updateSet[updateSet.indexOf('status=excluded.status')] = "status=CASE WHEN races.status IN ('finished','cancelled') THEN races.status ELSE excluded.status END";
    const protectLifecycle = table === 'models' ? " WHERE models.status NOT IN ('active','retired')" : '';
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON CONFLICT(${config.conflict}) DO UPDATE SET ${updateSet.join(',') || `${config.conflict.split(',')[0]}=excluded.${config.conflict.split(',')[0]}`}${protectLifecycle}`;
    statements.push(db.prepare(sql).bind(...cols.map(k=>row[k])));
  }
  // 結果・払戻の入ったレースを確定にする（D1 の書き込み行数を抑えるためレース単位で1回、未確定のものだけ）
  if (name === 'payouts' || name === 'results') {
    for (const id of new Set(rows.map(r => String(r.race_id)))) statements.push(db.prepare("UPDATE races SET status='finished' WHERE id=? AND status<>'finished'").bind(id));
  }
  // D1 batch は1トランザクションで実行される（行ごとの往復を避ける）
  if (db.batch) await db.batch(statements); else for (const s of statements) await s.run();
  return c.json({ upserted: rows.length });
}
async function settleOpen(db: Db) {
  const bets = await all<any>(db, `SELECT b.*, r.status AS race_status FROM bets b JOIN races r ON r.id=b.race_id WHERE b.status='open' AND r.status IN ('finished','cancelled')`);
  let settled = 0;
  for (const b of bets) {
    if (b.race_status === 'cancelled') { await run(db, `UPDATE bets SET status='void',payout=0,profit=0,settled_at=? WHERE id=?`, now(), b.id); settled++; continue; }
    const pay = await first<any>(db, 'SELECT payout FROM payouts WHERE race_id=? AND bet_type=? AND selection=?', b.race_id, b.bet_type, b.selection);
    const values = settleValues(b.stake, pay?.payout ?? null, !!pay);
    await run(db, `UPDATE bets SET status=?,payout=?,profit=?,final_odds=?,settled_at=? WHERE id=?`, pay ? 'won' : 'lost', values.payout, values.profit, values.finalOdds, now(), b.id);
    if (b.expected_roi > 0 && values.finalOdds !== null && b.predicted_prob * values.finalOdds - 1 <= 0) await run(db, `UPDATE bets SET ev_lost=1 WHERE id=?`, b.id);
    settled++;
  }
  return settled;
}
async function autoBet(db: Db, enabled: boolean) {
  if (!enabled) return 0;
  const cfg = Number(await setting(db, 'unit_stake', '100')), minRoi = Number(await setting(db, 'min_expected_roi', '0.05')), maxStd = Number(await setting(db, 'max_prob_std', '0.05'));
  const candidates = await all<any>(db, `SELECT r.id race_id,r.sport,r.data_origin,e.number, p.probability,p.prob_std,p.model_id,m.status model_status,
    (SELECT o.odds FROM odds_snapshots o WHERE o.race_id=r.id AND o.data_origin=r.data_origin AND o.bet_type='win' AND o.selection=CAST(e.number AS TEXT) AND julianday(o.captured_at)<=julianday(?) AND julianday(o.captured_at)>=julianday(?) AND julianday(o.captured_at)<=julianday(r.post_time) ORDER BY julianday(o.captured_at) DESC LIMIT 1) odds
    FROM races r JOIN entries e ON e.race_id=r.id JOIN predictions p ON p.race_id=r.id AND p.number=e.number
    JOIN models m ON m.id=p.model_id AND m.status='active' AND m.sport=r.sport
    WHERE r.status='scheduled' AND e.data_origin=r.data_origin AND p.data_origin=r.data_origin AND p.predicted_at=(SELECT p2.predicted_at FROM predictions p2 WHERE p2.race_id=r.id AND p2.model_id=m.id AND p2.number=e.number AND p2.data_origin=r.data_origin ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)
    AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?)
    AND julianday(p.predicted_at)<=julianday(?) AND julianday(p.predicted_at)<=julianday(r.post_time)
    AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto')`, now(), oddsFreshAfter(), now(), now());
  let n=0;
  for (const x of candidates) {
    const result = candidate(x.probability,x.odds,x.prob_std,x.model_status,maxStd);
    if (!x.odds || !result.expectedRoi || result.expectedRoi < minRoi || !['HIGH_EDGE','POSITIVE_EDGE'].includes(result.edge)) continue;
    const id=betId();
    const inserted=await run(db, `INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin)
      SELECT ?,?,?, 'win', ?,?,'auto',?,?,?,?,?,?,'open',?
      WHERE ${availableBankrollSql} >= ?
      ON CONFLICT(race_id) WHERE mode='auto' DO NOTHING`, id,x.race_id,x.sport,String(x.number),cfg,x.probability,x.odds,result.expectedRoi,result.edge,x.model_id,now(),x.data_origin,cfg);
    if (inserted.meta?.changes) n++;
  }
  return n;
}
async function cron(db: Db, autoEnabled: boolean, oddsEnabled = false) {
  if (oddsEnabled) await collectOdds(db, new Date());
  const settled=await settleOpen(db), bought=await autoBet(db,autoEnabled);
  const cutoff=new Date(Date.now()-30*86400000).toISOString();
  await run(db, `DELETE FROM odds_snapshots WHERE captured_at<? AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.race_id=odds_snapshots.race_id AND b.selection=odds_snapshots.selection AND b.odds_at_bet=odds_snapshots.odds AND b.placed_at>=odds_snapshots.captured_at)`, cutoff).catch(()=>{});
  return {settled,bought};
}
app.get('/health', c=>c.json({ok:true,service:'edgelab-api'}));
app.get('/races', async c=>{
  const db=c.env.DB, sport=c.req.query('sport'), date=c.req.query('date'), origin=originFilter(c.req.query('origin'));
  if (sport && !validSport(sport)) return jsonError(c,'invalid sport');
  if (!date) return jsonError(c,'date is required');
  const rows=await all<any>(db,`SELECT r.*,v.name venue_name,(SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id) entry_count FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.race_date=? AND (? IS NULL OR r.sport=?) AND (? IS NULL OR r.data_origin=?) ORDER BY r.sport,v.name,r.race_no`,date,sport||null,sport||null,origin,origin);
  const out=[];
  const maxStd=Number(await setting(db,'max_prob_std','0.05'));
  for(const r of rows){
    const candidates=await all<any>(db,`SELECT p.probability,p.prob_std,o.odds,m.status FROM predictions p JOIN races r ON r.id=p.race_id JOIN models m ON m.id=p.model_id AND m.status='active' JOIN entries e ON e.race_id=p.race_id AND e.number=p.number JOIN odds_snapshots o ON o.race_id=p.race_id AND o.data_origin=r.data_origin AND o.selection=CAST(e.number AS TEXT) AND o.bet_type='win' AND o.captured_at=(SELECT o2.captured_at FROM odds_snapshots o2 WHERE o2.race_id=p.race_id AND o2.data_origin=r.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(r.post_time) ORDER BY julianday(o2.captured_at) DESC LIMIT 1) WHERE p.race_id=? AND r.status='scheduled' AND e.data_origin=r.data_origin AND p.data_origin=r.data_origin AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) AND julianday(p.predicted_at)<=julianday(r.post_time) AND julianday(p.predicted_at)<=julianday(?)`,now(),oddsFreshAfter(),r.id,now(),now());
    const choices=candidates.map(b=>candidate(b.probability,b.odds,b.prob_std,b.status,maxStd)).sort((a,b)=>(b.expectedRoi??-Infinity)-(a.expectedRoi??-Infinity));
    const best=choices[0]; out.push({id:r.id,sport:r.sport,venueId:r.venue_id,venueName:r.venue_name,raceDate:r.race_date,raceNo:r.race_no,name:r.name,distance:r.distance,surface:r.surface,trackCondition:r.track_condition,weather:r.weather,postTime:r.post_time,status:r.status,dataOrigin:r.data_origin,entryCount:r.entry_count,topEdge:best?.edge??'INSUFFICIENT_DATA',bestExpectedRoi:best?.expectedRoi??null});
  }
  return c.json(out);
});
app.get('/races/:id', async c=>{
 const db=c.env.DB,r=await first<any>(db,'SELECT r.*,v.name venue_name FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.id=?',c.req.param('id')); if(!r)return jsonError(c,'not found',404);
 const maxStd=Number(await setting(db,'max_prob_std','0.05'));
 const entries=await all<any>(db,`SELECT e.*,o.odds,o.captured_at,p.probability,p.prob_std,p.predicted_at,m.id model_id,m.status model_status,res.finish_order FROM entries e JOIN races r ON r.id=e.race_id
 LEFT JOIN odds_snapshots o ON o.id=(SELECT o2.id FROM odds_snapshots o2 WHERE o2.race_id=e.race_id AND o2.data_origin=r.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(r.post_time) AND r.status='scheduled' AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) ORDER BY julianday(o2.captured_at) DESC LIMIT 1)
 LEFT JOIN predictions p ON p.id=(SELECT p2.id FROM predictions p2 JOIN models pm ON pm.id=p2.model_id AND pm.status='active' WHERE p2.race_id=e.race_id AND p2.number=e.number AND p2.data_origin=r.data_origin AND julianday(p2.predicted_at)<=julianday(?) AND julianday(p2.predicted_at)<=julianday(r.post_time) AND r.status='scheduled' AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)
 LEFT JOIN models m ON m.id=p.model_id LEFT JOIN results res ON res.race_id=e.race_id AND res.number=e.number AND res.data_origin=r.data_origin WHERE e.race_id=? AND e.data_origin=r.data_origin ORDER BY e.number`,now(),oddsFreshAfter(),now(),now(),now(),r.id);
 const model=entries.find(x=>x.model_id)?.model_id; const modelRow=model?await first<any>(db,'SELECT * FROM models WHERE id=?',model):null;
 const payouts=(await all<any>(db,`SELECT bet_type,selection,payout,popularity FROM payouts WHERE race_id=? ORDER BY CASE bet_type WHEN 'win' THEN 1 WHEN 'place' THEN 2 WHEN 'exacta' THEN 3 WHEN 'quinella' THEN 4 WHEN 'wide' THEN 5 WHEN 'trifecta' THEN 6 WHEN 'trio' THEN 7 ELSE 8 END,selection`,r.id)).map(p=>({betType:p.bet_type,selection:p.selection,payout:p.payout,popularity:p.popularity}));
 const entryViews=entries.map(x=>{const a=candidate(x.probability,x.odds,x.prob_std,x.model_status,maxStd);return {number:x.number,frame:x.frame,name:x.name,jockey:x.jockey,trainer:x.trainer,weightCarried:x.weight_carried,horseWeight:x.horse_weight,racerClass:x.racer_class,nationalWinRate:x.national_win_rate,localWinRate:x.local_win_rate,motorNo:x.motor_no,motor2Rate:x.motor_2rate,boatNo:x.boat_no,boat2Rate:x.boat_2rate,exhibitionTime:x.exhibition_time,startExhibition:x.start_exhibition,odds:x.odds,oddsCapturedAt:x.captured_at,probability:x.probability,probStd:x.prob_std,breakEvenProb:x.odds?1/x.odds:null,expectedRoi:a.expectedRoi,conservativeRoi:a.conservativeRoi,edge:a.edge,finishOrder:x.finish_order??null}});
 const best=entryViews.filter(x=>x.expectedRoi!==null).sort((a,b)=>(b.expectedRoi??-Infinity)-(a.expectedRoi??-Infinity))[0];
 return c.json({id:r.id,sport:r.sport,venueId:r.venue_id,venueName:r.venue_name,raceDate:r.race_date,raceNo:r.race_no,name:r.name,distance:r.distance,surface:r.surface,trackCondition:r.track_condition,weather:r.weather,windSpeed:r.wind_speed,waveHeight:r.wave_height,postTime:r.post_time,status:r.status,dataOrigin:r.data_origin,entryCount:entries.length,topEdge:best?.edge??'INSUFFICIENT_DATA',bestExpectedRoi:best?.expectedRoi??null,model:modelRow?mapModel(modelRow):null,predictedAt:entries.find(x=>x.predicted_at)?.predicted_at??null,dataFreshnessMinutes:entries.find(x=>x.captured_at)?Math.max(0,(Date.now()-Date.parse(entries.find(x=>x.captured_at).captured_at))/60000):null,entries:entryViews,payouts});
});
function mapModel(m:any){return {id:m.id,sport:m.sport,betType:m.bet_type,version:m.version,algorithm:m.algorithm,status:m.status,trainFrom:m.train_from,trainTo:m.train_to,validFrom:m.valid_from,validTo:m.valid_to,testFrom:m.test_from,testTo:m.test_to,nTrain:m.n_train,metrics:JSON.parse(m.metrics_json||'{}'),trainedAt:m.trained_at,notes:m.notes};}
app.get('/rankings',async c=>{
 const db=c.env.DB,sport=c.req.query('sport'),date=c.req.query('date'),origin=originFilter(c.req.query('origin')); if(sport&&!validSport(sport))return jsonError(c,'invalid sport'); if(!date)return jsonError(c,'date is required');
 const rows=await all<any>(db,`SELECT r.id race_id,r.sport,r.data_origin,r.race_no,r.post_time,v.name venue_name,e.number,e.name,p.probability,p.prob_std,p.model_id,m.status model_status,o.odds,o.captured_at,p.predicted_at FROM races r JOIN venues v ON v.id=r.venue_id JOIN entries e ON e.race_id=r.id AND e.data_origin=r.data_origin JOIN predictions p ON p.id=(SELECT p2.id FROM predictions p2 JOIN models pm ON pm.id=p2.model_id AND pm.status='active' WHERE p2.race_id=r.id AND p2.number=e.number AND p2.data_origin=r.data_origin AND julianday(p2.predicted_at)<=julianday(?) AND julianday(p2.predicted_at)<=julianday(r.post_time) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1) JOIN models m ON m.id=p.model_id AND m.status='active' JOIN odds_snapshots o ON o.race_id=r.id AND o.data_origin=r.data_origin AND o.bet_type='win' AND o.selection=CAST(e.number AS TEXT) AND o.captured_at=(SELECT o2.captured_at FROM odds_snapshots o2 WHERE o2.race_id=r.id AND o2.data_origin=r.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(r.post_time) ORDER BY julianday(o2.captured_at) DESC LIMIT 1) WHERE julianday(p.predicted_at)<=julianday(?) AND r.race_date=? AND r.status='scheduled' AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) AND (? IS NULL OR r.sport=?) AND (? IS NULL OR r.data_origin=?)`,now(),now(),oddsFreshAfter(),now(),date,now(),sport||null,sport||null,origin,origin);
 const maxStd=Number(await setting(db,'max_prob_std','0.05')); return c.json(rows.map(x=>({...candidate(x.probability,x.odds,x.prob_std,x.model_status,maxStd),raceId:x.race_id,sport:x.sport,venueName:x.venue_name,raceNo:x.race_no,postTime:x.post_time,number:x.number,name:x.name,probability:x.probability,probStd:x.prob_std,odds:x.odds,breakEvenProb:1/x.odds,modelId:x.model_id,dataFreshnessMinutes:Math.max(0,(Date.now()-Date.parse(x.captured_at))/60000),dataOrigin:x.data_origin})).sort((a,b)=>(b.expectedRoi??-Infinity)-(a.expectedRoi??-Infinity)));
});
app.post('/bets',async c=>{
 const db=c.env.DB, body=await c.req.json().catch(()=>null) as any; if(!body||typeof body.raceId!=='string'||body.betType!=='win'||typeof body.selection!=='string')return jsonError(c,'invalid request');
 const race=await first<any>(db,'SELECT * FROM races WHERE id=?',body.raceId); if(!race)return jsonError(c,'race not found',404); if(race.status!=='scheduled')return jsonError(c,'race is not scheduled');
 const unit=Number(await setting(db,'unit_stake','100')); if(!validateStake(body.stake,unit))return jsonError(c,'stake must be a positive multiple of unit_stake');
 const entry=await first<any>(db,'SELECT * FROM entries WHERE race_id=? AND data_origin=? AND CAST(number AS TEXT)=?',body.raceId,race.data_origin,body.selection); if(!entry)return jsonError(c,'selection not found');
 if(!race.post_time||!Number.isFinite(Date.parse(race.post_time))||Date.parse(race.post_time)<=Date.now())return jsonError(c,'race has started or start time is unavailable');
 const timestamp=now();
 const pred=await first<any>(db,`SELECT p.*,m.status model_status FROM predictions p JOIN models m ON m.id=p.model_id AND m.status='active' WHERE p.race_id=? AND p.data_origin=? AND p.number=? AND julianday(p.predicted_at)<=julianday(?) AND julianday(p.predicted_at)<=julianday(?) ORDER BY julianday(p.predicted_at) DESC LIMIT 1`,body.raceId,race.data_origin,entry.number,timestamp,race.post_time);
 if(!pred)return jsonError(c,'active model prediction is unavailable');
 const odd=await first<any>(db,`SELECT * FROM odds_snapshots WHERE race_id=? AND data_origin=? AND bet_type='win' AND selection=? AND julianday(captured_at)<=julianday(?) AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1`,body.raceId,race.data_origin,body.selection,timestamp,oddsFreshAfter(),race.post_time);
 if(odd?.odds===null||odd?.odds===undefined)return jsonError(c,'odds are unavailable');
 const maxStd=Number(await setting(db,'max_prob_std','0.05')), x=candidate(pred?.probability??null,odd?.odds??null,pred?.prob_std??null,pred?.model_status??null,maxStd);
 const bet={id:betId(),race_id:race.id,sport:race.sport,bet_type:'win',selection:body.selection,stake:body.stake,mode:'manual',predicted_prob:pred?.probability??null,odds_at_bet:odd?.odds??null,expected_roi:x.expectedRoi,edge_label:x.edge,model_id:pred?.model_id??null,placed_at:now(),status:'open',data_origin:race.data_origin};
 const inserted=await run(db,`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
   WHERE ${availableBankrollSql} >= ?`,...Object.values(bet),body.stake);
 if(!inserted.meta?.changes)return jsonError(c,'insufficient bankroll');
 return c.json(mapBet(bet),201);
});
function mapBet(b:any){return {id:b.id,raceId:b.race_id,sport:b.sport,betType:b.bet_type,selection:b.selection,stake:b.stake,mode:b.mode,predictedProb:b.predicted_prob,oddsAtBet:b.odds_at_bet,expectedRoi:b.expected_roi,edgeLabel:b.edge_label,modelId:b.model_id,placedAt:b.placed_at,status:b.status,payout:b.payout??null,profit:b.profit??null,finalOdds:b.final_odds??null,settledAt:b.settled_at??null,dataOrigin:b.data_origin};}
app.get('/bets',async c=>{const sport=c.req.query('sport'),status=c.req.query('status'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');const rows=await all<any>(c.env.DB,`SELECT b.*,v.name venue_name,r.race_no FROM bets b JOIN races r ON r.id=b.race_id JOIN venues v ON v.id=r.venue_id WHERE (? IS NULL OR b.sport=?) AND (? IS NULL OR b.status=?) AND (? IS NULL OR b.data_origin=?) ORDER BY b.placed_at DESC`,sport||null,sport||null,status||null,status||null,origin,origin);return c.json(rows.map(b=>({...mapBet(b),venueName:b.venue_name,raceNo:b.race_no})));});
app.get('/performance/overview',async c=>{const sport=c.req.query('sport'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');const db=c.env.DB, initial=Number(await setting(db,'initial_bankroll','100000')), bets=await all<any>(db,`SELECT * FROM bets WHERE (? IS NULL OR sport=?) AND (? IS NULL OR data_origin=?) ORDER BY placed_at,id`,sport||null,sport||null,origin,origin);let bankroll=initial;const equity=[{at:bets[0]?.placed_at??now(),bankroll}];let settled=0,hits=0,stake=0,payout=0;for(const b of bets){if(b.status==='won'||b.status==='lost'||b.status==='void'){bankroll+=b.profit??0;settled++;stake+=b.stake;payout+=b.payout??0;if(b.status==='won')hits++;equity.push({at:b.settled_at??b.placed_at,bankroll});}}let peak=initial,dd=0,ddPct=0;for(const e of equity){peak=Math.max(peak,e.bankroll);dd=Math.max(dd,peak-e.bankroll);if(peak>0)ddPct=Math.max(ddPct,(peak-e.bankroll)/peak);}return c.json({initialBankroll:initial,bankroll,totalProfit:bankroll-initial,roi:stake?payout/stake:null,betCount:bets.length,settledCount:settled,hitRate:settled?hits/settled:null,maxDrawdown:dd,maxDrawdownPct:ddPct,equityCurve:equity});});
app.get('/performance/breakdown',async c=>{const db=c.env.DB,origin=originFilter(c.req.query('origin'));
 const O='(? IS NULL OR data_origin=?)';
 const bySport=await all<any>(db,`SELECT sport,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,SUM(COALESCE(profit,0)) profit,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi,CASE WHEN SUM(CASE WHEN status IN ('won','lost') THEN 1 ELSE 0 END)>0 THEN 1.0*SUM(CASE WHEN status='won' THEN 1 ELSE 0 END)/SUM(CASE WHEN status IN ('won','lost') THEN 1 ELSE 0 END) END hitRate FROM bets WHERE ${O} GROUP BY sport`,origin,origin);
 const byMonth=await all<any>(db,`SELECT substr(placed_at,1,7) month,sport,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,SUM(COALESCE(profit,0)) profit FROM bets WHERE ${O} GROUP BY month,sport ORDER BY month`,origin,origin);
 const byEdge=await all<any>(db,`SELECT CASE
   WHEN expected_roi IS NULL THEN '不明'
   WHEN expected_roi >= 0.20 THEN '20%以上'
   WHEN expected_roi >= 0.05 THEN '5〜20%'
   WHEN expected_roi >= 0 THEN '0〜5%'
   ELSE '< 0%'
  END bucket,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi
  FROM bets WHERE ${O} GROUP BY bucket ORDER BY CASE bucket WHEN '20%以上' THEN 1 WHEN '5〜20%' THEN 2 WHEN '0〜5%' THEN 3 WHEN '< 0%' THEN 4 ELSE 5 END`,origin,origin);
 const byModel=await all<any>(db,`SELECT COALESCE(model_id,'unknown') modelId,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi FROM bets WHERE ${O} GROUP BY model_id`,origin,origin);
 const calibration=await all<any>(db,`SELECT r.sport,CAST(p.probability*10 AS INT) bin,AVG(p.probability) predicted,AVG(CASE WHEN res.finish_order=1 THEN 1.0 ELSE 0.0 END) actual,COUNT(*) count FROM predictions p JOIN races r ON r.id=p.race_id AND p.data_origin=r.data_origin JOIN results res ON res.race_id=p.race_id AND res.number=p.number AND res.data_origin=r.data_origin WHERE r.status='finished' AND r.post_time IS NOT NULL AND julianday(p.predicted_at)<=julianday(r.post_time) AND (? IS NULL OR r.data_origin=?) AND p.predicted_at=(SELECT p2.predicted_at FROM predictions p2 WHERE p2.race_id=p.race_id AND p2.model_id=p.model_id AND p2.number=p.number AND p2.data_origin=r.data_origin AND julianday(p2.predicted_at)<=julianday(r.post_time) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1) GROUP BY r.sport,bin ORDER BY r.sport,bin`,origin,origin);
 const oddsDrift=await first<any>(db,`SELECT COUNT(*) bets,AVG(odds_at_bet) avgOddsAtBet,AVG(final_odds) avgFinalOdds,COALESCE(SUM(ev_lost),0) evLostCount FROM bets WHERE status IN ('won','lost') AND ${O}`,origin,origin);
 return c.json({bySport,byMonth,byEdge,byModel,calibration,oddsDrift});
});
app.get('/models',async c=>{const rows=await all<any>(c.env.DB,'SELECT * FROM models ORDER BY sport,status,id');return c.json(rows.map(mapModel));});
app.post('/models/:id/promote',async c=>{const db=c.env.DB,id=c.req.param('id'),m=await first<any>(db,'SELECT * FROM models WHERE id=?',id);if(!m)return jsonError(c,'model not found',404);if(m.status==='untrained')return jsonError(c,'untrained model cannot be promoted');let metrics:Record<string,unknown>;try{metrics=JSON.parse(m.metrics_json||'{}');}catch{return jsonError(c,'model metrics are invalid');}if(metrics.promotionEligible===false)return jsonError(c,typeof metrics.promotionReason==='string'?metrics.promotionReason:'candidate failed same-holdout promotion criteria');await run(db,"UPDATE models SET status='retired' WHERE sport=? AND status='active' AND id<>?",m.sport,id);await run(db,"UPDATE models SET status='active' WHERE id=?",id);return c.json(mapModel({...m,status:'active'}));});
app.post('/models/:id/rollback',async c=>{const db=c.env.DB,id=c.req.param('id'),m=await first<any>(db,'SELECT * FROM models WHERE id=?',id);if(!m)return jsonError(c,'model not found',404);if(m.status!=='active')return jsonError(c,'model is not active');const old=await first<any>(db,"SELECT * FROM models WHERE sport=? AND status='retired' ORDER BY rowid DESC LIMIT 1",m.sport);if(!old)return jsonError(c,'no retired model to rollback');await run(db,"UPDATE models SET status='retired' WHERE id=?",id);await run(db,"UPDATE models SET status='active' WHERE id=?",old.id);return c.json(mapModel({...old,status:'active'}));});
app.get('/collection/status',async c=>{const db=c.env.DB,runs=await all<any>(db,'SELECT * FROM collection_runs ORDER BY started_at DESC'), tables=['venues','races','entries','odds_snapshots','results','payouts','models','predictions','bets','collection_runs','daily_summaries','settings'], tableCounts:Record<string,number>={};for(const t of tables)tableCounts[t]=(await first<any>(db,`SELECT COUNT(*) n FROM ${t}`))?.n??0;
 const sources=await all<any>(db,`SELECT source,sport,COUNT(*) runs,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes,SUM(COALESCE(records,0)) records,MAX(started_at) lastRunAt,MAX(CASE WHEN status='success' THEN started_at END) lastSuccessAt,(SELECT cr.status FROM collection_runs cr WHERE cr.source=collection_runs.source AND cr.sport=collection_runs.sport ORDER BY cr.started_at DESC LIMIT 1) latestStatus FROM collection_runs GROUP BY source,sport`);
 return c.json({sources:sources.map(s=>({source:s.source,sport:s.sport,enabled:s.latestStatus==='skipped'||s.source==='jra' ? false : true,lastRunAt:s.lastRunAt,lastSuccessAt:s.lastSuccessAt,successRate:s.runs?s.successes/s.runs:null,runs:s.runs,records:s.records,freshnessMinutes:s.lastRunAt?Math.max(0,(Date.now()-Date.parse(s.lastRunAt))/60000):null,note:s.source==='jra'?'規約上自動取得不可':null})),errors:runs.filter(r=>r.status==='failed'||r.status==='partial').slice(0,50).map(r=>({at:r.started_at,source:r.source,error:r.error??r.reason??r.status})),tableCounts,freeTier:{d1RowsApprox:Object.values(tableCounts).reduce((a,b)=>a+b,0),d1RowLimitNote:'D1 無料枠: 保存容量 5GB、日次読取 500万行、日次書込 10万行。件数はテーブル行数の合計で概算。'}});
});
for(const route of Object.keys(ingestTables)) app.post(`/ingest/${route}` as any,c=>ingest(c,route));
app.get('/ingest/models',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const models=await all<any>(c.env.DB,'SELECT id,sport,bet_type,version,algorithm,status,train_from,train_to,valid_from,valid_to,test_from,test_to,n_train,metrics_json,trained_at,notes FROM models ORDER BY sport,status,id');
 return c.json({models});
});
app.post('/admin/settle',async c=>{if(!auth(c))return jsonError(c,'unauthorized',401);return c.json({settled:await settleOpen(c.env.DB)});});
export default { fetch: app.fetch, scheduled: async (_event: unknown, env: Env) => { await cron(env.DB, env.ENABLE_AUTO_BET==='true' || (await setting(env.DB,'auto_bet_enabled','false'))==='true', env.ENABLE_BOATRACE_ODDS_SCRAPE==='true'); } };
export { app, cron, settleOpen, autoBet };
