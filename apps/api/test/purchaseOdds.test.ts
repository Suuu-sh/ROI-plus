import { afterEach, expect, it, vi } from 'vitest';
import { fetchPurchaseOdds, purchaseOddsContext } from '../src/services/purchaseOdds.js';
const at=Date.parse('2026-10-14T10:00:00+09:00');
const race={id:'boat-20261014-01-01',race_date:'2026-10-14',venue_id:'01',race_no:1,betting_cutoff_at:new Date(at+60_000).toISOString()};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('shares one race request and 49-attempt budget, and spaces different simultaneous races',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(at);
 const ctx=purchaseOddsContext(),fetcher=vi.fn(async()=>new Response('',{status:503}));
 ctx.fetch=fetcher;ctx.sleep=vi.fn(async()=>{});
 await Promise.all([fetchPurchaseOdds(race,ctx),fetchPurchaseOdds(race,ctx)]);
 await fetchPurchaseOdds({...race,id:'boat-20261014-01-02',race_no:2},ctx);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(ctx.requestBudget.used).toBe(2);expect(ctx.sleep).toHaveBeenCalledExactlyOnceWith(3000);
 ctx.requestBudget.used=49;
 expect(await fetchPurchaseOdds({...race,id:'third',race_no:3},ctx)).toBeNull();expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not issue a request when spacing consumes the remaining decision window',async()=>{
 let clock=at;vi.spyOn(Date,'now').mockImplementation(()=>clock);
 const ctx=purchaseOddsContext({used:1,max:49});ctx.fetch=vi.fn();ctx.sleep=async()=>{clock=at+11_000;};
 expect(await fetchPurchaseOdds(race,ctx)).toBeNull();expect(ctx.fetch).not.toHaveBeenCalled();expect(ctx.requestBudget.used).toBe(1);
});
it('rejects oversized bodies before parsing and keeps failure cached, without archived fallback',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(at);
 const ctx=purchaseOddsContext();ctx.fetch=vi.fn(async()=>new Response('large',{headers:{'content-length':String(512*1024+1)}}));
 expect(await fetchPurchaseOdds(race,ctx)).toBeNull();expect(await fetchPurchaseOdds(race,ctx)).toBeNull();expect(ctx.fetch).toHaveBeenCalledTimes(1);
});
