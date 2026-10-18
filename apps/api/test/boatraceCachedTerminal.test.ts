import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {it,expect} from 'vitest';
import {parseBoatraceResults} from '../src/services/boatraceResults.js';
const dir=resolve(process.cwd(),'data/private_fixtures/residual-20261019/all-historical-official-recovery');
it.skipIf(!existsSync(dir))('reparses all 638 cached official pages with independent production rosters without refetching',()=>{
 let count=0,refunds=0,normal=0;
 const rosters=new Map(JSON.parse(readFileSync(resolve(dir,'../all-historical-recovery-manifest.json'),'utf8')).races.map((race:any)=>[race.raceId,race.entries]));
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.json'))){
  const metadata=JSON.parse(readFileSync(resolve(dir,file),'utf8'));
  if(!['unsupported','verified_refund','verified_normal'].includes(metadata.status))continue;
  const html=readFileSync(resolve(dir,file.replace(/json$/,'html')),'utf8');
  const entries=rosters.get(metadata.raceId) as Array<{number:number;racerId:string}>;
  const [,date,venue,race]=metadata.raceId.split('-');
  const result=parseBoatraceResults(html,{url:metadata.sourceUrl,raceDate:`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`,venueCode:venue,raceNo:Number(race),entries});
  expect(result.results.length+result.terminalEntries.length,metadata.raceId).toBe(6);
  expect(result.refundNumbers.every(n=>!result.nonRefundableNumbers.includes(n))).toBe(true);
  if(metadata.status==='verified_refund')refunds++;else if(metadata.status==='unsupported')count++;else normal++;
 }
 expect({count,refunds,normal}).toEqual({count:32,refunds:12,normal:594});
});
