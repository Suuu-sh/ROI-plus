import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
export function jstRaceDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid status date.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const result = `${values.year}-${values.month}-${values.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('Could not determine JST race date.');
  return result;
}
export function targetRaceDates(now = new Date()) {
  const today = jstRaceDate(now);
  const [year, month, day] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1, -9));
  return { today, tomorrow: jstRaceDate(tomorrow) };
}
// Retained for consumers of the previous module API; target is computed in JST.
export const TARGET_DATE = targetRaceDates().tomorrow;
export const SETTING_KEYS = Object.freeze(['auto_bet_enabled','auto_bet_paused','min_expected_roi','max_prob_std','unit_stake','auto_bet_max_picks','auto_bet_race_budget','auto_bet_start_date','auto_promote_enabled']);
export const SETTINGS_QUERY = `SELECT key,value FROM settings WHERE key IN (${SETTING_KEYS.map(k=>`'${k}'`).join(',')}) ORDER BY key LIMIT 9;`;
export function parseQuery(stdout, maxRows=100) {
  let data; try { data=JSON.parse(stdout); } catch { throw new Error('D1 returned an invalid query response.'); }
  if (!Array.isArray(data)||data.length!==1||data[0]?.success!==true||!Array.isArray(data[0].results)||data[0].results.length>maxRows) throw new Error('D1 query did not return the expected bounded result.');
  return data[0].results;
}
function query(sql) {
  const r=spawnSync(process.execPath,[wrangler,'d1','execute','roi-plus','--remote','--json','--command',sql],{cwd:path.join(root,'apps/api'),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  if(r.error||r.status!==0) throw new Error('Read-only production D1 query failed.');
  return parseQuery(r.stdout);
}
function onlySettings(rows) { const out={}; for(const row of rows){if(!row||!SETTING_KEYS.includes(row.key)||typeof row.value!=='string')throw new Error('D1 returned a non-allowlisted setting.');out[row.key]=row.value;} return out; }
function int(v){const n=Number(v);return Number.isSafeInteger(n)&&n>=0?n:0;}
export function safeBet(row) {
 const id=typeof row.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)?row.id:null;
 const raceId=typeof row.race_id==='string'&&/^boat-\d{8}-\d{2}-\d{2}$/.test(row.race_id)?row.race_id:null;
 const raceDate=typeof row.race_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.race_date)?row.race_date:null;
 const selection=typeof row.selection==='string'&&(/^[1-6]$/.test(row.selection)||/^([1-6])-([1-6])-([1-6])$/.test(row.selection)&&new Set(row.selection.split('-')).size===3)?row.selection:null;
 return {id,raceId,raceDate,selection,status:row.status==='open'?'open':null};
}
async function main(){
 const mode='status';
 const {today,tomorrow:targetDate}=targetRaceDates();
 for(const name of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'])if(!process.env[name])throw new Error(`Required credential is unavailable: ${name}.`);
 let settings=onlySettings(query(SETTINGS_QUERY));
 const models=query("SELECT id,sport,bet_type,status,algorithm,metrics_json FROM models WHERE sport='boat' AND bet_type='trifecta' AND status IN ('candidate','active') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,id LIMIT 12;");
 const artifacts=query("SELECT tp.model_id,COUNT(DISTINCT tp.artifact_sha256) AS artifact_count,MIN(tp.artifact_sha256) AS artifact_sha256,MIN(tp.feature_schema_version) AS feature_schema_version,COUNT(*) AS prediction_rows FROM ticket_predictions tp JOIN models m ON m.id=tp.model_id WHERE m.sport='boat' AND m.bet_type='trifecta' AND m.status IN ('candidate','active') AND tp.data_origin='real' GROUP BY tp.model_id LIMIT 12;");
 const captureStats=query("SELECT COUNT(*) AS archive_rows,COUNT(DISTINCT race_id) AS archive_races,COUNT(DISTINCT race_date) AS archive_dates FROM boatrace_prerace_capture_archives WHERE data_origin='real' LIMIT 1;")[0]??{};
 const observationStats=query("SELECT COUNT(*) AS observation_rows,COUNT(DISTINCT race_id) AS observation_races,COUNT(DISTINCT date(fetched_at)) AS observation_dates FROM boatrace_prerace_observations WHERE data_origin='real' LIMIT 1;")[0]??{};
 const todayStats=query(`SELECT COUNT(*) AS race_count,SUM(CASE WHEN entry_count=6 THEN 1 ELSE 0 END) AS six_entry_races,SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled_races,SUM(CASE WHEN status='scheduled' AND entry_count=6 THEN 1 ELSE 0 END) AS scheduled_six_entry_races FROM (SELECT r.id,r.status,COUNT(e.number) AS entry_count FROM races r LEFT JOIN entries e ON e.race_id=r.id AND e.data_origin='real' WHERE r.data_origin='real' AND r.sport='boat' AND r.race_date='${today}' GROUP BY r.id,r.status) LIMIT 1;`)[0]??{};
 const todayArchives=query(`SELECT COUNT(*) AS archive_rows,COUNT(DISTINCT race_id) AS archive_races FROM boatrace_prerace_capture_archives WHERE data_origin='real' AND race_date='${today}' LIMIT 1;`)[0]??{};
 const archiveDates=query("SELECT race_date,COUNT(*) AS archive_rows,COUNT(DISTINCT race_id) AS archive_races FROM boatrace_prerace_capture_archives WHERE data_origin='real' GROUP BY race_date ORDER BY race_date DESC LIMIT 32;");
 const openBets=query("SELECT b.id,b.race_id,r.race_date,b.selection,b.status FROM bets b JOIN races r ON r.id=b.race_id WHERE b.sport='boat' AND b.data_origin='real' AND b.status='open' AND r.data_origin='real' ORDER BY r.race_date,r.post_time,b.id LIMIT 50;");
 const tomorrow=query(`SELECT r.sport,p.model_id,COUNT(DISTINCT r.id) AS race_count,COUNT(DISTINCT p.id) AS prediction_rows,COUNT(DISTINCT o.race_id) AS odds_races FROM races r LEFT JOIN predictions p ON p.race_id=r.id AND p.data_origin='real' LEFT JOIN odds_snapshots o ON o.race_id=r.id AND o.data_origin='real' AND o.bet_type='win' WHERE r.data_origin='real' AND r.race_date='${targetDate}' AND r.status='scheduled' GROUP BY r.sport,p.model_id LIMIT 30;`);
 const ticketTomorrow=query(`SELECT r.sport,tp.bet_type,tp.model_id,COUNT(DISTINCT r.id) AS race_count,COUNT(DISTINCT tp.id) AS prediction_rows FROM races r LEFT JOIN ticket_predictions tp ON tp.race_id=r.id AND tp.data_origin='real' WHERE r.data_origin='real' AND r.race_date='${targetDate}' AND r.status='scheduled' GROUP BY r.sport,tp.bet_type,tp.model_id LIMIT 40;`);
 const cfg=await readFile(path.join(root,'apps/api/wrangler.toml'),'utf8');
 const flags={}; for(const k of ['ENABLE_AUTO_BET','ENABLE_BOATRACE_ODDS_SCRAPE','ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE','ENABLE_BOATRACE_RESULTS_SCRAPE']){const m=cfg.match(new RegExp('^'+k+'\\s*=\\s*"(true|false)"\\s*$', 'm'));flags[k]=m?.[1]??'unset';}
 let budget=null; try { const res=await fetch('https://roi-plus-api.suuu-sh.workers.dev/api/health',{signal:AbortSignal.timeout(12000)});if(res.ok){const j=await res.json();const b=j?.d1WriteBudget;if(b&&typeof b==='object'){budget={};for(const k of ['date','limit','essentialLimit','optionalLimit','oddsLimit','reserved','essentialReserved','optionalReserved','oddsReserved','remaining','essentialRemaining','optionalRemaining','state','allowance'])if(['string','number','boolean'].includes(typeof b[k])||(k==='allowance'&&b[k]&&typeof b[k]==='object'))budget[k]=b[k];}} }catch{}
 const safe={mode,today,targetDate,settings,trifectaModels:models.map(m=>{let meta={};try{meta=JSON.parse(m.metrics_json??'{}')}catch{};const metrics=meta.metrics&&typeof meta.metrics==='object'?meta.metrics:{};const allow=['exactOrderLogLoss','nTrainRaces','nValidRaces','nTestRaces','nTestDates','topTicketEce','completeCombinationCoverage','boatFeatureSchemaVersion','ticketModelSchemaVersion','ticketPredictionSemantics','ticketBetType','dataOrigin'];const sanitized=Object.fromEntries(allow.filter(k=>['string','number','boolean'].includes(typeof meta[k])||['string','number','boolean'].includes(typeof metrics[k])).map(k=>[k,meta[k]??metrics[k]]));const v=meta.ticketValidation&&typeof meta.ticketValidation==='object'?meta.ticketValidation:{};const validation=Object.fromEntries(['status','policyVersion','betType','validatedAt','dataOrigin','completeCombinationCoverage','probabilitiesNormalized','outOfSampleValidated','pointInTimeSafe','reportSha256','independentReviewId'].filter(k=>['string','boolean'].includes(typeof v[k])).map(k=>[k,v[k]]));const artifact=artifacts.find(a=>a.model_id===m.id);return{id:/^[a-z0-9][a-z0-9._-]{0,79}$/.test(m.id)?m.id:null,status:m.status,algorithm:typeof m.algorithm==='string'?m.algorithm.slice(0,120):null,metadata:sanitized,validation,artifactSha256:artifact&&int(artifact.artifact_count)===1&&/^[a-f0-9]{64}$/.test(artifact.artifact_sha256??'')?artifact.artifact_sha256:null,realPredictionRows:int(artifact?.prediction_rows),predictionFeatureSchema:artifact?.feature_schema_version??null};}),captureEvidence:{archiveRows:int(captureStats.archive_rows),archiveRaces:int(captureStats.archive_races),archiveDates:int(captureStats.archive_dates),observationRows:int(observationStats.observation_rows),observationRaces:int(observationStats.observation_races),observationDates:int(observationStats.observation_dates)},todayCounts:{realBoatRaces:int(todayStats.race_count),sixEntryRaces:int(todayStats.six_entry_races),scheduledRealBoatRaces:int(todayStats.scheduled_races),scheduledSixEntryRaces:int(todayStats.scheduled_six_entry_races),immutableArchiveRows:int(todayArchives.archive_rows),immutableArchiveRaces:int(todayArchives.archive_races)},archiveDateCounts:archiveDates.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.race_date??'')).map(r=>({raceDate:r.race_date,rows:int(r.archive_rows),races:int(r.archive_races)})),openRealBoatBets:openBets.map(safeBet),tomorrow:tomorrow.map(r=>({sport:r.sport,betType:'win',modelId:/^[a-z0-9][a-z0-9._-]{0,79}$/.test(r.model_id??'')?r.model_id:null,races:int(r.race_count),predictionRows:int(r.prediction_rows),racesWithWinOdds:int(r.odds_races)})),ticketPredictions:ticketTomorrow.map(r=>({sport:r.sport,betType:r.bet_type==='trifecta'?'trifecta':null,modelId:/^[a-z0-9][a-z0-9._-]{0,79}$/.test(r.model_id??'')?r.model_id:null,races:int(r.race_count),rows:int(r.prediction_rows)})),workerFlags:flags,writeBudget:budget};
 const output=JSON.stringify(safe,null,2);console.log(output);if(process.env.GITHUB_STEP_SUMMARY)await (await import('node:fs/promises')).appendFile(process.env.GITHUB_STEP_SUMMARY,`## Paper operation ${mode}\n\n\`\`\`json\n${output}\n\`\`\`\n`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(`Paper operator failed closed: ${e.message}`);process.exitCode=1;});
