import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {it,expect} from 'vitest';
import {parseBoatraceResults} from '../src/services/boatraceResults.js';
const dir=resolve(process.cwd(),'data/private_fixtures/residual-20261019/all-historical-official-recovery');
it.skipIf(!existsSync(dir))('reparses all 32 cached unsupported official pages plus 12 refunds without refetching',()=>{
 let count=0,refunds=0;
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.json'))){
  const metadata=JSON.parse(readFileSync(resolve(dir,file),'utf8'));
  if(!['unsupported','verified_refund'].includes(metadata.status))continue;
  const html=readFileSync(resolve(dir,file.replace(/json$/,'html')),'utf8');
  const tables=[...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m=>m[0]);
  const table=tables.find(t=>t.includes('ボートレーサー')&&/<th[^>]*>\s*着\s*<\/th>/.test(t))!;
  const entries=[...table.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)].flatMap(body=>[...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]).map(row=>{
   const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
   return {number:Number(cells[1][1].replace(/<[^>]*>/g,'').trim()),racerId:cells[2][1].match(/is-fs12[^>]*>\s*(\d{4,5})/)![1]};
  });
  const [,date,venue,race]=metadata.raceId.split('-');
  const result=parseBoatraceResults(html,{url:metadata.sourceUrl,raceDate:`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`,venueCode:venue,raceNo:Number(race),entries});
  expect(result.results.length+result.terminalEntries.length,metadata.raceId).toBe(6);
  expect(result.refundNumbers.every(n=>!result.nonRefundableNumbers.includes(n))).toBe(true);
  if(metadata.status==='verified_refund')refunds++;else count++;
 }
 expect({count,refunds}).toEqual({count:32,refunds:12});
});
