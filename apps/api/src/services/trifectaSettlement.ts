import { all, first, type Db } from '../repo/db.js';
import { RESULTS_SOURCE, resultUrl } from './collectBoatraceResults.js';

// Shared query-side candidate filter prevents a permanently unsupported early
// open ticket from occupying each bounded settlement batch ahead of later
// tickets that have fully classified official evidence.
export const verifiedSelectedTerminalOutcomeSql = `NOT EXISTS(
  SELECT 1 FROM entries e WHERE e.race_id=r.id AND e.data_origin='real'
    AND (CASE WHEN json_valid(e.features_json) THEN json_extract(e.features_json,'$.finish_code') END
      IN ('F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走')
      OR (CASE WHEN json_valid(e.features_json) THEN json_extract(e.features_json,'$.finish_code') END) GLOB 'K[0-9]')
    AND instr('-'||b.selection||'-','-'||CAST(e.number AS TEXT)||'-')>0
    AND NOT (json_extract(e.features_json,'$.finish_code')='転覆' AND EXISTS(
      SELECT 1 FROM collection_runs cr WHERE cr.id='boat-result:'||r.id
        AND cr.source='boatrace-results-worker-v1' AND cr.status='success' AND cr.target_date=r.race_date
        AND json_valid(cr.reason) AND json_extract(cr.reason,'$.quality')='verified-official-outcome-v2'
        AND json_extract(cr.reason,'$.raceId')=r.id
        AND json_extract(cr.reason,'$.url')='https://www.boatrace.jp/owpc/pc/race/raceresult?rno='||r.race_no||'&jcd='||r.venue_id||'&hd='||replace(r.race_date,'-','')
        AND julianday(json_extract(cr.reason,'$.fetchedAt'))<=julianday('now')
        AND json_extract(cr.reason,'$.refundTablePresent')=1
        AND json_extract(cr.reason,'$.refundPolicy')='official-post-start-capsize-v1'
        AND EXISTS(SELECT 1 FROM json_each(cr.reason,'$.nonRefundableNumbers') nr WHERE CAST(nr.value AS INTEGER)=e.number)
        AND EXISTS(SELECT 1 FROM json_each(cr.reason,'$.terminalEntries') te
          WHERE CAST(json_extract(te.value,'$.number') AS INTEGER)=e.number AND json_extract(te.value,'$.finishCode')='転覆')
    ))
)`;

export async function verifiedNoRefundCapsize(db: Db, race: { id:string; race_date:string; venue_id:string; race_no:number }, number: number): Promise<boolean> {
  const record=await first<any>(db,'SELECT target_date,status,reason FROM collection_runs WHERE id=? AND source=? AND sport=\'boat\'',`boat-result:${race.id}`,RESULTS_SOURCE);
  return verifiedNoRefundCapsizeRecord(record,race,number);
}

export function verifiedNoRefundCapsizeRecord(record: any, race: { id:string; race_date:string; venue_id:string; race_no:number }, number: number, nowMs=Date.now()): boolean {
  if(!record||record.status!=='success'||record.target_date!==race.race_date)return false;
  let evidence:any;
  try{evidence=JSON.parse(record.reason||'{}')}catch{return false;}
  const expectedUrl=resultUrl({id:race.id,venue_id:race.venue_id,race_no:race.race_no,race_date:race.race_date});
  const fetchedAtMs=typeof evidence?.fetchedAt==='string'&&/(Z|[+-]\d{2}:\d{2})$/i.test(evidence.fetchedAt)?Date.parse(evidence.fetchedAt):NaN;
  return evidence?.raceId===race.id && evidence?.quality==='verified-official-outcome-v2'
    && evidence?.url===expectedUrl && typeof evidence?.sha256==='string' && /^[a-f0-9]{64}$/.test(evidence.sha256)
    && Number.isFinite(fetchedAtMs) && fetchedAtMs<=nowMs
    && evidence?.refundTablePresent===true && evidence?.refundPolicy==='official-post-start-capsize-v1'
    && Array.isArray(evidence?.nonRefundableNumbers) && evidence.nonRefundableNumbers.includes(number)
    && Array.isArray(evidence?.terminalEntries) && evidence.terminalEntries.some((x:any)=>x?.number===number&&x?.finishCode==='転覆');
}

/** Read immutable result evidence once per race set, rather than once per ticket. */
export async function loadTrifectaSettlementEvidence(db: Db, races: Array<{id:string; race_date:string; venue_id:string; race_no:number}>) {
  const ids=[...new Set(races.map(r=>r.id))];
  const empty={entries:new Map<string,any[]>(),results:new Map<string,any[]>(),payouts:new Map<string,any[]>(),proofs:new Map<string,any>()};
  if(!ids.length)return empty;
  const encoded=JSON.stringify(ids);
  const [entries,results,payouts,proofs]=await Promise.all([
    all<any>(db,"SELECT race_id,number,features_json FROM entries WHERE data_origin='real' AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,number",encoded),
    all<any>(db,"SELECT race_id,number,finish_order FROM results WHERE data_origin='real' AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,finish_order",encoded),
    all<any>(db,"SELECT race_id,selection,payout FROM payouts WHERE data_origin='real' AND bet_type='trifecta' AND payout>0 AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,selection",encoded),
    all<any>(db,"SELECT id,target_date,status,reason FROM collection_runs WHERE source=? AND sport='boat' AND id IN (SELECT 'boat-result:'||value FROM json_each(?))",RESULTS_SOURCE,encoded),
  ]);
  const byRace=(rows:any[],key='race_id')=>{const map=new Map<string,any[]>();for(const row of rows){const list=map.get(String(row[key]))??[];list.push(row);map.set(String(row[key]),list)}return map};
  return {entries:byRace(entries),results:byRace(results),payouts:byRace(payouts),proofs:new Map(proofs.map((row:any)=>[String(row.id).slice('boat-result:'.length),row]))};
}

/** Determine a trifecta outcome from official partial standings without
 * requiring irrelevant lower places to be published. Every selected runner
 * must have an official numeric finish, and the official payout must identify
 * the exact top-three order. */
export function verifiedTrifectaOutcome(
  selection: string,
  entries: Array<{ number: number; finishCode?: string | null }>,
  results: Array<{ number: number; finishOrder: number }>,
  payouts: Array<{ selection: string; payout: number }>,
  verifiedNoRefundTerminalNumbers: number[] = [],
): { winningSelection: string; won: boolean; payoutPer100: number } | null {
  if (entries.length !== 6 || entries.some((entry, i) => entry.number !== i + 1)) return null;
  if (results.length < 3 || new Set(results.map(row => row.number)).size !== results.length
      || new Set(results.map(row => row.finishOrder)).size !== results.length
      || results.some(row => !Number.isInteger(row.finishOrder) || row.finishOrder < 1 || row.finishOrder > 6 || row.number < 1 || row.number > 6)) return null;
  const ordered = [...results].sort((a, b) => a.finishOrder - b.finishOrder);
  if (ordered.some((row, i) => row.finishOrder !== i + 1)) return null;
  const terminal = new Set(['F', 'L', 'K', '欠場', '欠', '失格', '転覆', '転', '妨害', '落水', 'エンスト', '不完走']);
  const terminalNumbers = new Set<number>();
  for (const entry of entries) {
    const code = entry.finishCode;
    const isTerminal = typeof code === 'string' && (terminal.has(code) || /^K\d$/.test(code));
    const hasResult = results.some(row => row.number === entry.number);
    if (hasResult === isTerminal) return null; // unknown, duplicate terminal/result, or unexplained lane
    if (isTerminal) terminalNumbers.add(entry.number);
  }
  if (results.some(row => !entries.some(entry => entry.number === row.number))) return null;
  if (ordered[0]?.finishOrder !== 1 || ordered[1]?.finishOrder !== 2 || ordered[2]?.finishOrder !== 3) return null;
  const winningSelection = ordered.slice(0, 3).map(row => String(row.number)).join('-');
  if (payouts.length !== 1 || payouts[0].selection !== winningSelection
      || !Number.isFinite(payouts[0].payout) || payouts[0].payout <= 0) return null;
  const selected = selection.split('-').map(Number);
  if (selected.length !== 3 || new Set(selected).size !== 3 || selected.some(number => !Number.isInteger(number) || number < 1 || number > 6)) return null;
  // Terminal selections can only be classified as losses with the official
  // post-start capsize / empty-refund evidence validated by the caller.
  if (selected.some(number => terminalNumbers.has(number) && !verifiedNoRefundTerminalNumbers.includes(number))) return null;
  return { winningSelection, won: selection === winningSelection, payoutPer100: payouts[0].payout };
}
