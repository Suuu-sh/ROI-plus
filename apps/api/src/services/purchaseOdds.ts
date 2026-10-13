import { parseTrifectaOdds, trifectaOddsUrl } from './boatraceTrifectaOdds.js';
import { readBoundedBody } from './collectBoatraceCaptureArchives.js';
import { USER_AGENT } from './boatraceOdds.js';

type Race = { id:string; race_date:string; venue_id:string; race_no:number; betting_cutoff_at:string };
export type PurchaseOdds = { url:string; sha256:string; requestedAt:string; capturedAt:string; qualityStatus:string; odds:Array<{selection:string;odds:number}> };
export type PurchaseOddsContext = {
  requestBudget:{used:number;max:number};
  enabled?:boolean;
  cache:Map<string,Promise<PurchaseOdds|null>>;
  fetch?:typeof fetch;
  sleep?:(ms:number)=>Promise<void>;
};
export const purchaseOddsContext = (requestBudget={used:0,max:49}):PurchaseOddsContext => ({requestBudget,cache:new Map()});
const iso = (ms:number)=>new Date(ms).toISOString();
/** One fresh market per race per invocation, shared by both paper portfolios.
 * No saved-market fallback. Requests and their complete bodies must finish
 * inside the existing T-60 +/- 10s window; final markets are never purchase odds.
 */
export function fetchPurchaseOdds(race:Race,ctx:PurchaseOddsContext):Promise<PurchaseOdds|null> {
  const cached=ctx.cache.get(race.id);if(cached)return cached;
  const result=(async()=>{
    const cutoff=Date.parse(race.betting_cutoff_at),target=cutoff-60_000;
    const eligible=()=>Number.isFinite(target)&&Math.abs(Date.now()-target)<=10_000;
    if(ctx.enabled===false||!eligible()||ctx.requestBudget.used>=ctx.requestBudget.max)return null;
    if(ctx.requestBudget.used>0)await (ctx.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(3000);
    if(!eligible())return null;
    const requestedAt=Date.now(),controller=new AbortController();
    // Leave the remaining T-60 window as the request/body timeout. No retry
    // queue may monopolize another simultaneous race's purchase window.
    const timer=setTimeout(()=>controller.abort(),Math.max(1,target+10_000-requestedAt));
    ctx.requestBudget.used++;
    try {
      const url=trifectaOddsUrl(race.race_no,race.venue_id,race.race_date);
      const response=await (ctx.fetch??fetch)(url,{headers:{'User-Agent':USER_AGENT,'Cache-Control':'no-cache'},redirect:'manual',signal:controller.signal});
      if(!response.ok){await response.body?.cancel().catch(()=>undefined);return null;}
      const bytes=await readBoundedBody(response),capturedAt=Date.now();
      if(!eligible()||controller.signal.aborted)return null;
      const parsed=parseTrifectaOdds(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{raceDate:race.race_date,venueCode:race.venue_id,raceNo:race.race_no});
      if(parsed.final||parsed.qualityStatus!=='verified-complete-v1')return null;
      const source=new ArrayBuffer(bytes.byteLength);new Uint8Array(source).set(bytes);
      const digest=await crypto.subtle.digest('SHA-256',source);
      if(!eligible())return null;
      return {url,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),requestedAt:iso(requestedAt),capturedAt:iso(capturedAt),qualityStatus:parsed.qualityStatus,odds:parsed.odds};
    }catch{return null;}finally{clearTimeout(timer);}
  })();
  ctx.cache.set(race.id,result);return result;
}
