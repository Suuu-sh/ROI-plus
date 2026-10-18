/** Explicit one-off operator replay. No HTTP endpoint, external fetch or credentials handling.
 * Bundle with esbuild (platform=node, packages=external), then run with --execute
 * only after reviewing dry-run output. The immutable 638-race inventory is required.
 */
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {collectResults} from '../../apps/api/src/services/collectBoatraceResults.js';
const require=createRequire(resolve('package.json'));
const {unstable_readConfig:readConfig,getPlatformProxy}=require('wrangler');
const base=resolve('data/private_fixtures/residual-20261019');
const inventoryPath=join(base,'all-historical-pending-inventory.json');
const inventoryBytes=readFileSync(inventoryPath);
const digest=createHash('sha256').update(inventoryBytes).digest('hex');
if(digest!=='b02be73490197fdaae9df9a919b78de0f828a9cbdfaf66589cbd39a0a805efb0')throw new Error('original fixed inventory digest mismatch');
const ids:string[]=JSON.parse(inventoryBytes.toString()).rows.map((r:{id:string})=>r.id);
if(ids.length!==638||new Set(ids).size!==638||ids.some(id=>!/^boat-202610\d{2}-\d{2}-\d{2}$/.test(id)))throw new Error('fixed inventory rejected');
const cache=new Map<string,{html:string;fetchedAt:string}>();
for(const id of ids){
  const meta=JSON.parse(readFileSync(join(base,'all-historical-official-recovery',`${id}.json`),'utf8'));
  const html=readFileSync(join(base,'all-historical-official-recovery',`${id}.html`),'utf8');
  if(meta.raceId!==id||createHash('sha256').update(html).digest('hex')!==meta.bodySha256||!Number.isFinite(Date.parse(meta.fetchedAt)))throw new Error('cached source rejected');
  cache.set(id,{html,fetchedAt:meta.fetchedAt});
}
console.log(JSON.stringify({mode:process.argv.includes('--execute')?'execute':'dry-run',inventoryDigest:digest,races:ids.length,cached:cache.size,networkFetches:0}));
if(!process.argv.includes('--execute')&&!process.argv.includes('--preflight'))process.exit(0);
if(process.argv.includes('--execute')&&!process.argv.includes(`--inventory-sha256=${digest}`))throw new Error('explicit inventory digest confirmation required');
const config=readConfig({config:'apps/api/wrangler.toml'});
const binding=config.d1_databases.find((d:{binding:string})=>d.binding==='DB');
if(!binding)throw new Error('DB binding missing');
const dir=mkdtempSync(join(tmpdir(),'roi-official-backfill-'));
let proxy:any;
try{
  const configPath=join(dir,'wrangler.json');
  writeFileSync(configPath,JSON.stringify({name:'roi-explicit-official-backfill',compatibility_date:config.compatibility_date,d1_databases:[{binding:'DB',database_name:binding.database_name,database_id:binding.database_id,remote:true}]}));
  proxy=await getPlatformProxy({configPath,envFiles:[],persist:false,remoteBindings:true});
  const db=proxy.env.DB;
  const preflight=await db.prepare(`SELECT r.id,r.race_date,r.venue_id,r.race_no,r.post_time,r.status,
    CASE WHEN EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) THEN 'quarantined'
    WHEN r.data_origin!='real' OR r.sport!='boat' THEN 'not-real-boat'
    WHEN julianday(r.post_time)>julianday('now','-5 minutes') OR r.post_time IS NULL THEN 'not-past'
    WHEN (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real')!=6 THEN 'incomplete-roster'
    WHEN EXISTS(SELECT 1 FROM collection_runs c WHERE c.id='boat-result:'||r.id AND c.status='success' AND json_valid(c.reason) AND json_extract(c.reason,'$.quality')='verified-official-outcome-v2') THEN 'already-canonical'
    ELSE 'eligible-source-validation-required' END eligibility,
    EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives a WHERE a.race_id=r.id AND a.data_origin='real') has_archive
    FROM races r WHERE r.id IN (SELECT value FROM json_each(?)) ORDER BY r.id`).bind(JSON.stringify(ids)).all();
  writeFileSync(join(base,'all-historical-production-backfill-preflight.json'),JSON.stringify({inventoryDigest:digest,asOf:new Date().toISOString(),rows:preflight.results},null,2));
  const counts=preflight.results.reduce((a:any,r:any)=>(a[r.eligibility]=(a[r.eligibility]??0)+1,a),{});
  console.log(JSON.stringify({preflight:counts,found:preflight.results.length}));
  if(!process.argv.includes('--execute')){await proxy.dispose();proxy=null;process.exitCode=0;}
  else {
  const output=join(base,'all-historical-production-backfill-replay.jsonl');
  const idForUrl=(input:string)=>{const u=new URL(input);if(u.origin!=='https://www.boatrace.jp'||u.pathname!=='/owpc/pc/race/raceresult')throw new Error('unexpected cached URL');return `boat-${u.searchParams.get('hd')}-${u.searchParams.get('jcd')}-${String(u.searchParams.get('rno')).padStart(2,'0')}`;};
  let processed=0;
  for(let offset=0;offset<ids.length;offset+=4){
    const selected=ids.slice(offset,offset+4);
    const outcome=await collectResults(db,new Date(),{mode:'manual',labelOnly:true,historicalLabelRaceIds:selected,backfillRunId:digest,maxAttempts:8,
      cachedFetchedAt:url=>cache.get(idForUrl(url))?.fetchedAt,
      fetch:async url=>{const saved=cache.get(idForUrl(url));if(!saved)throw new Error('uncached source');return new Response(saved.html,{headers:{'content-type':'text/html; charset=utf-8'}});},sleep:async()=>{}});
    // Canonical rows only; omit credentials, account metadata and archive bodies.
    const verified=await db.prepare("SELECT id,status,json_extract(reason,'$.quality') quality,json_extract(reason,'$.fetchedAt') fetched_at,json_extract(reason,'$.sha256') sha256 FROM collection_runs WHERE id IN (SELECT 'boat-result:'||value FROM json_each(?))").bind(JSON.stringify(selected)).all();
    const entry={at:new Date().toISOString(),inventoryDigest:digest,selected,outcome,canonical:verified.results};
    writeFileSync(output,JSON.stringify(entry)+'\n',{flag:'a'});
    processed+=selected.length;console.log(JSON.stringify({processed,total:ids.length,...outcome}));
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  }
}finally{await proxy?.dispose();rmSync(dir,{recursive:true,force:true});}
