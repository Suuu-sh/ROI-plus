import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {it,expect} from 'vitest';
import {parseBoatraceResults} from '../src/services/boatraceResults.js';
const base=resolve(process.cwd(),'data/private_fixtures/residual-20261019');
it.skipIf(!existsSync(resolve(base,'all-historical-production-live-audit.json')))('compares all cached outcomes to independently read production evidence',()=>{
 const rows=JSON.parse(readFileSync(resolve(base,'all-historical-production-live-audit.json'),'utf8')).rows;
 const rosters=new Map(JSON.parse(readFileSync(resolve(base,'all-historical-recovery-manifest.json'),'utf8')).races.map((r:any)=>[r.raceId,r.entries]));
 const sorted=(values:any[])=>[...values].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 let terminal=0,refund=0,tie=0,exactMetadata=0;
 for(const row of rows){
  const metadata=JSON.parse(readFileSync(resolve(base,'all-historical-official-recovery',row.id+'.json'),'utf8'));
  const html=readFileSync(resolve(base,'all-historical-official-recovery',row.id+'.html'),'utf8');
  const [,date,venue,race]=row.id.split('-');
  const parsed=parseBoatraceResults(html,{url:metadata.sourceUrl,raceDate:`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`,venueCode:venue,raceNo:Number(race),entries:rosters.get(row.id) as any});
  const proof=JSON.parse(row.reason);
  for(const field of ['results','payouts','terminalEntries','refundNumbers','nonRefundableNumbers'] as const) expect(sorted(proof[field]??[]),`${row.id}:${field}`).toEqual(sorted(parsed[field]));
  expect(sorted(JSON.parse(row.result_rows)),row.id+':D1results').toEqual(sorted(parsed.results));
  expect(sorted(JSON.parse(row.payout_rows)),row.id+':D1payouts').toEqual(sorted(parsed.payouts));
  if(parsed.terminalEntries.length)terminal++;
  if(parsed.refundNumbers.length)refund++;
  if(new Set(parsed.results.map(r=>r.finishOrder)).size<parsed.results.length)tie++;
  if(proof.sha256===metadata.bodySha256&&proof.fetchedAt===metadata.fetchedAt)exactMetadata++;
 }
 expect(rows).toHaveLength(638);
 console.log(JSON.stringify({races:rows.length,terminalRaces:terminal,refundRaces:refund,tiedRankRaces:tie,exactMetadata,changedMetadata:rows.length-exactMetadata}));
});
