import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Deterministic synthetic fixture; every persisted row is explicitly sample data.
let state = 0x5eedc0de;
function random() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; }
function normal() { return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random()); }
function dateJst(offset = 0) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - offset));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
const q = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(Number(v.toFixed(8))) : `'${String(v).replaceAll("'", "''")}'`;
const rows = [];
function insert(table, columns, values) {
  const updates = columns.filter(c => !['id','race_id','number','sport','bet_type','selection','captured_at','finish_order','date','key'].includes(c));
  rows.push({table,columns,values,updates});
}
const venues = [
  ['horse','h01','サンプル競馬場A'],['horse','h02','サンプル競馬場B'],
  ['boat','b01','サンプルボート場A'],['boat','b02','サンプルボート場B'],
];
for (const [sport,id,name] of venues) insert('venues',['id','sport','name'],[id,sport,name]);

const metrics = (logLoss, baselineLogLoss, brier, ece, roi, expectedRoi, maxDrawdown, nRaces) => JSON.stringify({logLoss,baselineLogLoss,brier,ece,roi,expectedRoi,maxDrawdown,nRaces});
const dateRange = (fromAgo,toAgo) => [dateJst(fromAgo),dateJst(toAgo)];
const [trainFrom,trainTo]=dateRange(420,120), [validFrom,validTo]=dateRange(119,61), [testFrom,testTo]=dateRange(60,1);
const modelRows = [
  ['horse-active','horse','sample-v1','LightGBM + isotonic calibration','active',2.071,2.214,0.861,0.012,0.91,-0.018,0.21,7200],
  ['horse-candidate','horse','sample-v2','LightGBM + temperature scaling','candidate',2.058,2.214,0.858,0.011,0.97,0.012,0.18,7600],
  ['boat-active','boat','sample-v1','LightGBM + isotonic calibration','active',1.206,1.310,0.586,0.015,0.94,-0.006,0.19,4800],
  ['boat-retired','boat','sample-v0','LightGBM baseline','retired',1.247,1.310,0.598,0.024,0.82,-0.042,0.28,3900],
  ['boat-candidate','boat','sample-v2','LightGBM + temperature scaling','candidate',1.198,1.310,0.583,0.014,0.99,0.018,0.16,5200],
];
for (const [id,sport,version,algorithm,status,ll,base,brier,ece,roi,er,dd,n] of modelRows) {
  insert('models',['id','sport','bet_type','version','algorithm','status','train_from','train_to','valid_from','valid_to','test_from','test_to','n_train','metrics_json','trained_at','notes'],
    [id,sport,'win',version,algorithm,status,trainFrom,trainTo,validFrom,validTo,testFrom,testTo,n,metrics(ll,base,brier,ece,roi,er,dd,Math.round(n*.12)),`${dateJst(1)}T08:00:00+09:00`,`サンプルモデル指標（synthetic sample）`]);
}

function normalize(xs) { const sum=xs.reduce((a,b)=>a+b,0); return xs.map(x=>x/sum); }
function drawFinishOrder(ps) {
  const remaining=ps.map((_,i)=>i), result=[];
  while (remaining.length) {
    let dart=random(), sum=remaining.reduce((s,i)=>s+ps[i],0), picked=remaining[remaining.length-1];
    for (const i of remaining) { dart-=ps[i]/sum; if (dart<=0) { picked=i; break; } }
    result.push(picked); remaining.splice(remaining.indexOf(picked),1);
  }
  return result;
}
const eligible = (p,odds,std) => {
  if (p == null || odds == null || std == null || std > .05) return null;
  const conservative=(p-std)*odds-1;
  return conservative>=.20?'HIGH_EDGE':conservative>=.05?'POSITIVE_EDGE':(p*odds-1)>=-.05?'NEUTRAL':'NEGATIVE_EDGE';
};
let betSeq=0;
function race(sport, venueIndex, dayOffset, raceNo, n, finished) {
  const date=dateJst(dayOffset), venue=venues[venueIndex], code=venue[1].slice(1), id=`sample-${sport}-${date.replaceAll('-','')}-${code}-${String(raceNo).padStart(2,'0')}`;
  const post=`${date}T${String(12+(raceNo%5)).padStart(2,'0')}:${String((raceNo*7)%60).padStart(2,'0')}:00+09:00`;
  const status=finished?'finished':'scheduled', stamp=`${date}T${String(9+(raceNo%2)).padStart(2,'0')}:00:00+09:00`;
  insert('races',['id','sport','venue_id','race_date','race_no','name','distance','surface','track_condition','weather','wind_speed','wave_height','post_time','status','data_origin','updated_at'],[id,sport,venue[1],date,raceNo,`サンプル${sport==='horse'?'競走':'レース'}${String(raceNo).padStart(2,'0')}`,sport==='horse'?1200:null,sport==='horse'?'芝':null,'良','晴',2.4,sport==='boat'?1.2:null,post,status,'sample',stamp]);

  // A latent ability distribution drives the full finish order. Lane one has
  // a realistic advantage in boat races; horse fields have less extreme spread.
  const abilities=Array.from({length:n},(_,i)=>{
    if (sport==='boat') return (i===0?4.2:0.7+random()*0.35) * Math.exp(normal()*0.16);
    return Math.exp(normal()*0.72);
  });
  const pTrue=normalize(abilities), finish=finished?drawFinishOrder(pTrue):[];
  // Market is deliberately noisier than the calibrated model; this creates a
  // small, non-zero set of positive-EV opportunities without choosing winners.
  const market=normalize(pTrue.map(p=>p*Math.exp(normal()*.34)));
  const model=normalize(pTrue.map(p=>p*Math.exp(normal()*.28)));
  const entries=[]; const takeout=sport==='horse'?.8:.75;
  for(let i=0;i<n;i++) {
    const number=i+1, frame=sport==='horse'?Math.ceil(number/2):number;
    const name=sport==='horse'?`サンプル馬${String(number).padStart(2,'0')}`:`サンプル選手${String.fromCharCode(64+number)}`;
    const oddsMissing=random()<.075;
    const odds=oddsMissing?null:Math.max(1,Math.round((takeout/market[i])*10)/10);
    const std=.005+random()*.075;
    const row={number,p:model[i],std,odds,edge:eligible(model[i],odds,std)}; entries.push(row);
    const rate=(x,min,max)=>Number((min+x*(max-min)).toFixed(2));
    insert('entries',['id','race_id','number','frame','name','jockey','trainer','weight_carried','horse_weight','racer_class','national_win_rate','local_win_rate','motor_no','motor_2rate','boat_no','boat_2rate','exhibition_time','start_exhibition','features_json','available_at','data_origin'],
      [`${id}-e${String(number).padStart(2,'0')}`,id,number,frame,name,sport==='horse'?`サンプル騎手${number}`:null,sport==='horse'?'サンプルトレーナー':null,sport==='horse'?rate(random(),52,58):null,sport==='horse'?Math.round(rate(random(),420,540)):null,sport==='boat'?(random()<.2?'A1':'A2'):null,sport==='boat'?(i===0?rate(random(),6.4,9.4):rate(random(),3.0,6.6)):null,sport==='boat'?rate(random(),2.4,8.2):null,sport==='boat'?String(1+Math.floor(random()*50)):null,sport==='boat'?rate(random(),25,55):null,sport==='boat'?String(1+Math.floor(random()*50)):null,sport==='boat'?rate(random(),25,55):null,sport==='boat'?rate(random(),6.6,7.1):null,sport==='boat'?rate(random(),.08,.24):null,'{}',`${date}T08:30:00+09:00`,'sample']);
    insert('predictions',['id','race_id','model_id','number','probability','prob_std','predicted_at','data_origin'],[`${id}-p${number}`,id,`${sport}-active`,number,model[i],std,`${date}T09:00:00+09:00`,'sample']);
    if(odds!==null) insert('odds_snapshots',['id','race_id','bet_type','selection','odds','captured_at','source','data_origin'],[`${id}-o${number}`,id,'win',String(number),odds,`${date}T10:00:00+09:00`,'sample:synthetic-market','sample']);
    if(finished) insert('results',['race_id','finish_order','number','data_origin'],[id,finish.indexOf(i)+1,number,'sample']);
  }
  if(finished) {
    const winner=finish[0], winnerRow=entries[winner];
    if(winnerRow.odds!==null) insert('payouts',['race_id','bet_type','selection','payout','popularity','data_origin'],[id,'win',String(winner+1),Math.max(100,Math.round(winnerRow.odds*10)*10),1,'sample']);
    // Keep the automatic policy conservative: among qualified opportunities,
    // take the one closest to the shared positive-edge threshold.
    const candidates=entries.filter(x=>x.odds!==null&&['HIGH_EDGE','POSITIVE_EDGE'].includes(x.edge)).sort((a,b)=>((a.p-a.std)*a.odds)-((b.p-b.std)*b.odds));
    if(candidates.length && random()<.72) placeBet(id,sport,date,candidates[0],'auto',candidates[0].number===winner+1,winnerRow.odds);
    // Occasional manual virtual wager, not conditioned on the result or the
    // auto-edge filter; this represents discretionary picks in a paper ledger.
    if(random()<.40) {
      const manualChoices=entries.filter(x=>x.odds!==null&&(!candidates.length||x.number!==candidates[0].number));
      if(manualChoices.length) {
        const manual=manualChoices[Math.floor(random()*manualChoices.length)];
        placeBet(id,sport,date,manual,'manual',manual.number===winner+1,winnerRow.odds);
      }
    }
  }
  return {id,date,entries};
}
function placeBet(id,sport,date,entry,mode,isWinner,winnerOdds) {
  const stake=100;
  const payout=isWinner && winnerOdds!==null?Math.max(100,Math.round(winnerOdds*10)*10):0;
  const status=isWinner?'won':'lost';
  insert('bets',['id','race_id','sport','bet_type','selection','stake','mode','predicted_prob','odds_at_bet','expected_roi','edge_label','model_id','placed_at','status','payout','profit','final_odds','settled_at','ev_lost','data_origin'],
    [`sample-bet-${++betSeq}`,id,sport,'win',String(entry.number),stake,mode,entry.p,entry.odds,entry.p*entry.odds-1,entry.edge??'INSUFFICIENT_DATA',`${sport}-active`,`${date}T10:05:00+09:00`,status,payout,payout-stake,isWinner&&payout? payout/100:null,`${date}T16:00:00+09:00`,0,'sample']);
}
// 2 venues x 60 days x 4 races for each sport.
for(let ago=60;ago>=1;ago--) {
  for(let v=0;v<2;v++) for(let r=1;r<=4;r++) race('horse',v,ago,r,12+Math.floor(random()*7),true);
  for(let v=2;v<4;v++) for(let r=1;r<=4;r++) race('boat',v,ago,r,6,true);
}
for(let v=0;v<2;v++) for(let r=1;r<=6;r++) race('horse',v,0,r,12+Math.floor(random()*7),false);
for(let v=2;v<4;v++) for(let r=1;r<=6;r++) race('boat',v,0,r,6,false);

const today=dateJst(0);
for(let ago=0;ago<5;ago++) {
  const target=dateJst(ago), start=`${target}T06:00:00+09:00`, finish=`${target}T06:01:00+09:00`;
  const run=(id,source,sport,status,records,error,reason)=>insert('collection_runs',['id','source','sport','target_date','started_at','finished_at','status','records','error','reason'],[id,`sample:${source}`,sport,target,start,finish,status,records,error,reason]);
  run(`sample-official-${ago}`,'boatrace-official','boat',ago===3?'failed':'success',ago===3?0:48,ago===3?'サンプルの一時的な通信失敗':null,null);
  run(`sample-odds-${ago}`,'boatrace-odds','boat','skipped',0,null,'自動取得の許諾未確認のため既定無効');
  if(ago===0||ago===2||ago===4) run(`sample-jra-${ago}`,'jra','horse','skipped',0,null,'規約上自動取得不可（ユーザー提供CSVのみ）');
}

// Batch a small number of records per INSERT to keep the checked-in SQL compact
// while staying below SQLite's conservative bind-variable limit.
const statements=[];
const groups=new Map();
for (const row of rows) {
  const key=`${row.table}|${row.columns.join('|')}`;
  if(!groups.has(key)) groups.set(key,[]);
  groups.get(key).push(row);
}
for (const batchRows of groups.values()) {
  const first=batchRows[0];
  for(let at=0;at<batchRows.length;at+=20) {
    const batch=batchRows.slice(at,at+20);
    const updates=first.updates.length ? first.updates.map(c=>`${c}=excluded.${c}`).join(',') : `${first.columns[0]}=excluded.${first.columns[0]}`;
    statements.push(`INSERT INTO ${first.table} (${first.columns.join(',')}) VALUES ${batch.map(r=>`(${r.values.map(q).join(',')})`).join(',')} ON CONFLICT DO UPDATE SET ${updates};`);
  }
}
const sql=`-- Generated by node db/seed/generate.mjs. Synthetic fixture; all domain rows are marked sample.\n${statements.join('\n')}\n`;
const out=resolve(dirname(fileURLToPath(import.meta.url)),'sample.sql'); writeFileSync(out,sql);
console.log(`Wrote ${rows.length} deterministic sample statements for JST ${today}: ${out}`);
