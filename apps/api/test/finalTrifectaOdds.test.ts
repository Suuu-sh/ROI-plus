import {expect,it} from 'vitest';
import {finalTrifectaOdds} from '../src/services/finalTrifectaOdds.js';
const race={id:'boat-20261011-09-01',race_date:'2026-10-11',venue_id:'09',race_no:1};
function proof(){
 const odds=[];for(let a=1;a<=6;a++)for(let b=1;b<=6;b++)for(let c=1;c<=6;c++)if(new Set([a,b,c]).size===3)odds.push({selection:`${a}-${b}-${c}`,odds:20});
 return {raceId:race.id,fetchedAt:'2026-10-11T05:00:01Z',quality:'verified-official-outcome-v2',payouts:[{betType:'trifecta',selection:'1-2-3',payout:2000}],finalMarket:{quality:'verified-result-final-market-v1',url:'https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=09&hd=20261011',sha256:'a'.repeat(64),fetchedAt:'2026-10-11T05:00:00Z',odds}};
}
it('returns winning and losing selected odds only from complete verified result-time market',()=>{
 expect(finalTrifectaOdds(JSON.stringify(proof()),race,'1-2-3','1-2-3')).toBe(20);
 expect(finalTrifectaOdds(JSON.stringify(proof()),race,'6-5-4','1-2-3')).toBe(20);
});
it('fails closed on missing, non-final, wrong race/source/time, partial market and inconsistent payout',()=>{
 expect(finalTrifectaOdds(null,race,'6-5-4','1-2-3')).toBeNull();
 for(const mutate of [(p:any)=>p.finalMarket.quality='verified-complete-v1',(p:any)=>p.finalMarket.url+='wrong',(p:any)=>p.finalMarket.fetchedAt='invalid',(p:any)=>p.finalMarket.sha256='bad',(p:any)=>p.finalMarket.odds.pop(),(p:any)=>p.payouts[0].payout=2100]){
  const p=proof();mutate(p);expect(finalTrifectaOdds(JSON.stringify(p),race,'6-5-4','1-2-3')).toBeNull();
 }
 expect(finalTrifectaOdds(JSON.stringify(proof()),race,'6-5-4','1-3-2')).toBeNull();
});
