import { trifectaOddsUrl } from './boatraceTrifectaOdds.js';
/** Result-time evidence only; purchase/cutoff snapshots cannot stand in for it. */
export function finalTrifectaOdds(reason:string|null,race:{id:string;race_date:string;venue_id:string;race_no:number},selection:string,officialSelection:string|null):number|null {
  try {
    const proof=JSON.parse(reason??'null'),market=proof?.finalMarket;
    if(proof?.raceId!==race.id||proof.quality!=='verified-official-outcome-v2'||!market
      ||market.quality!=='verified-result-final-market-v1'||market.url!==trifectaOddsUrl(race.race_no,race.venue_id,race.race_date)
      ||!/^[a-f0-9]{64}$/.test(market.sha256)
      ||!Number.isFinite(Date.parse(market.fetchedAt))
      ||!Number.isFinite(Date.parse(proof.fetchedAt))||Date.parse(market.fetchedAt)>Date.parse(proof.fetchedAt)
      ||Date.parse(market.fetchedAt)<Date.parse(race.race_date+'T00:00:00+09:00')||!Array.isArray(market.odds)||market.odds.length!==120)return null;
    const selections=new Set<string>();
    for(const row of market.odds){
      if(!/^[1-6]-[1-6]-[1-6]$/.test(row.selection)||new Set(row.selection.split('-')).size!==3
        ||selections.has(row.selection)||!Number.isFinite(row.odds)||row.odds<=0)return null;
      selections.add(row.selection);
    }
    const payouts=proof.payouts?.filter((p:any)=>p.betType==='trifecta');
    if(payouts?.length!==1||payouts[0].selection!==officialSelection
      ||market.odds.find((o:any)=>o.selection===officialSelection)?.odds!==payouts[0].payout/100)return null;
    return market.odds.find((o:any)=>o.selection===selection)?.odds??null;
  }catch{return null;}
}
