import { LhaReader, Uint8ArrayReader, Uint8ArrayWriter } from '@kirinsaninc/lhats';
import Encoding from 'encoding-japanese';
import { first, type Db, type Statement } from '../repo/db.js';

export const BOATRACE_PROGRAM_SOURCE = 'boatrace-program-files-worker-v1';
export const BOATRACE_PROGRAM_PARSER_VERSION = 'boatrace-bk-ts-v1';
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SCHEDULE_SKEW_MS = 20 * 60 * 1000;
const MIN_REQUEST_GAP_MS = 3_000;
const MAX_STATEMENTS_PER_TICK = 400;
const STATEMENTS_PER_BATCH = 80;
const SHA256 = /^[a-f0-9]{64}$/;

const VENUES: Record<string, string> = {
  '01': '桐生', '02': '戸田', '03': '江戸川', '04': '平和島', '05': '多摩川', '06': '浜名湖',
  '07': '蒲郡', '08': '常滑', '09': '津', '10': '三国', '11': 'びわこ', '12': '住之江',
  '13': '尼崎', '14': '鳴門', '15': '丸亀', '16': '児島', '17': '宮島', '18': '徳山',
  '19': '下関', '20': '若松', '21': '芦屋', '22': '福岡', '23': '唐津', '24': '大村',
};
const PREFECTURES = [
  '北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川',
  '新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫',
  '奈良','和歌山','鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎',
  '熊本','大分','宮崎','鹿児島','沖縄',
];
const PREF_RE = PREFECTURES.sort((a, b) => b.length - a.length).join('|');
const RATE = '(?:\\d{1,2}\\.\\d{2}|[-―]+)';
const ENTRY_RE = new RegExp(`^\\s*([1-6])\\s+(\\d{4})(.+?)(\\d{2})(${PREF_RE})(\\d{2})([A-Z]\\d)\\s+(${RATE})\\s+(${RATE})\\s+(${RATE})\\s+(${RATE})\\s+(\\d{1,2})\\s+(${RATE})\\s*(\\d{1,3})\\s+(${RATE})(?:\\s|$)`);
const RESULT_RE = /^\s*(\d{2}|[A-Z]\d|F|L|K\d?|欠場|欠|失格|転覆|妨害|落水|エンスト|不完走)\s+([1-6])\s+(\d{4})\s+(.+?)\s+(\d{1,3})\s+(\d{1,3})\s+(\d\.\d{2}|K\s*\.|\.)\s+([1-6]|K\s*\.|\.)\s+(?:F)?([+-]?\d\.\d{2}|K\s*\.|\.)/;
const PAYOUT_TYPES: Record<string, string> = { '単勝':'win','複勝':'place','2連複':'quinella','2連単':'exacta','拡連複':'wide','3連複':'trio','3連単':'trifecta' };
const jstDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms));
const jstIso = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const isoNow = (ms: number) => new Date(ms).toISOString();
const hash = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const sum = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(sum)].map(x => x.toString(16).padStart(2, '0')).join('');
};

export type ProgramFileKind = 'B' | 'K';
export type ProgramSyncOutcome = {
  status: 'success' | 'partial' | 'failed' | 'skipped';
  reason: string;
  kind: ProgramFileKind;
  targetDate: string;
  records: number;
  retryable: boolean;
  sourceSha256?: string;
  fetchedAt?: string;
};
export type ProgramSyncOptions = {
  targetDate?: string;
  fetch?: typeof fetch;
  now?: () => number;
  minGapMs?: number;
  /** Test seam; production callers should use the built-in bounded LZH decoder. */
  decodeArchive?: (archive: Uint8Array) => Promise<{text:string;unpackedBytes?:number}>;
};
export type ParsedProgram = {
  races: Record<string, unknown>[];
  entries: Record<string, unknown>[];
  results: Record<string, unknown>[];
  payouts: Record<string, unknown>[];
};
type ProgramCursor = {schema:'boatrace-program-cursor-v1';kind:ProgramFileKind;targetDate:string;sha256:string;url:string;rawKey:string;manifestKey:string;fetchedAt:string;startedAt:string;previousSha?:string;offset:number};
type ProgramManifest = {schema:'boatrace-normalized-program-v1';kind:ProgramFileKind;targetDate:string;url:string;sha256:string;sourceBytes:number;fetchedAt:string;parserVersion:string;data:ParsedProgram};

/** Decode an official LZH member using only Worker-compatible Uint8Array APIs. */
export async function decodeBoatraceLzh(archive: Uint8Array): Promise<{ text: string; unpackedBytes: number }> {
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) throw new Error('archive-size-invalid');
  const reader = new LhaReader(new Uint8ArrayReader(archive));
  try {
    const members = (await reader.getEntries()).filter(entry => !entry.directory);
    if (!members.length) throw new Error('archive-member-missing');
    const member = members.find(entry => /\.(?:txt|dat)$/i.test(entry.filename)) ?? members[0];
    if (!Number.isSafeInteger(member.uncompressedSize) || member.uncompressedSize < 1 || member.uncompressedSize > MAX_TEXT_BYTES) {
      throw new Error('archive-output-size-invalid');
    }
    const writer = new Uint8ArrayWriter();
    await member.getData(writer);
    const bytes = await writer.getData();
    if (!bytes.length || bytes.length > MAX_TEXT_BYTES || bytes.length !== member.uncompressedSize) throw new Error('archive-output-size-invalid');
    // Match the existing Python decoder: strict Shift_JIS first, whole-buffer
    // CP932 fallback only when the byte stream is not strict Shift_JIS.
    const strictShiftJis=isStrictShiftJis(bytes);
    if(!strictShiftJis&&!isValidCp932(bytes))throw new Error('archive-encoding-invalid');
    // encoding-japanese's SJIS decoder is the CP932 superset; the byte
    // validator above selects whether Python's strict-SJIS remap is applicable.
    const decoded = Encoding.convert([...bytes], { to: 'UNICODE', from: 'SJIS', type: 'string' });
    const mapped = strictShiftJis?decoded.replaceAll('\uFF0D','\u2212').replaceAll('\uFF5E','\u301C'):decoded;
    const text = mapped.normalize('NFKC').replaceAll('\0', '');
    if (!text.trim()) throw new Error('archive-text-empty');
    return { text, unpackedBytes: bytes.length };
  } finally { await reader.close(); }
}

export function parseBoatraceProgramText(kind: ProgramFileKind, source: string, fallbackDate: string): ParsedProgram {
  const date = dateFromText(source, fallbackDate);
  if (!date) throw new Error('source-date-invalid');
  const parsed: ParsedProgram = { races: [], entries: [], results: [], payouts: [] };
  let venue: string | undefined;
  let race: Record<string, any> | undefined;
  let inRaceDetail = false;
  for (const line of source.split(/\r?\n/)) {
    const code = line.match(kind === 'B' ? /^\s*(\d{2})BBGN\b/ : /^\s*(\d{2})KBGN\b/);
    if (code) venue = code[1];
    const headingVenue = venueFromLine(line);
    if (headingVenue) venue = headingVenue;
    const heading = line.match(/^\s*(\d{1,2})\s*R\b(.*)$/);
    if (heading) {
      if (kind === 'K' && /^\s*\d+(?:-\d+){1,2}\b/.test(heading[2])) continue;
      if (!venue) { race = undefined; inRaceDetail = false; continue; }
      const raceNo = Number(heading[1]), tail = heading[2];
      const dist = tail.match(/H\s*(\d{3,4})\s*m/i);
      const common = {
        id: `boat-${date.replaceAll('-', '')}-${venue}-${String(raceNo).padStart(2, '0')}`,
        sport:'boat', venue_id:venue, race_date:date, race_no:raceNo,
        name:tail.split(/\s+H\s*\d/i)[0].trim() || null, distance:dist ? Number(dist[1]) : null,
        surface:null, track_condition:null, data_origin:'real',
      };
      if (kind === 'B') {
        const deadline = tail.match(/(\d{1,2})\s*:\s*(\d{2})/);
        race = { ...common, weather:null, wind_speed:null, wave_height:null,
          post_time:deadline ? `${date}T${String(Number(deadline[1])).padStart(2, '0')}:${deadline[2]}:00+09:00` : null,
          status:'scheduled' };
      } else {
        const weather = tail.match(/H\s*\d{3,4}\s*m\s*(\S+?)\s+風/);
        const wind = tail.match(/風\s*\S*\s*(\d+)\s*m/);
        const direction = tail.match(/風\s*([^\d\s]+)/);
        const wave = tail.match(/波\s*(\d+)\s*cm/);
        race = { ...common, weather:weather?.[1]?.trim() ?? null, wind_speed:wind ? Number(wind[1]) : null,
          wave_height:wave ? Number(wave[1]) : null, _wind_direction:direction?.[1]?.trim() ?? null, post_time:null, status:'finished' };
      }
      parsed.races.push(race); inRaceDetail = kind === 'K'; continue;
    }
    if (!race) continue;
    if (kind === 'B') {
      const m = line.match(ENTRY_RE); if (!m) continue;
      const [, lane, racerId, rawName, age, prefecture, weight, racerClass, national, national2, local, local2, motorNo, motorRate, boatNo, boatRate] = m;
      const nationalTwo=num(national2), localTwo=num(local2);
      const features=`{\"racer_id\":${JSON.stringify(racerId)},\"age\":${Number(age)},\"branch\":${JSON.stringify(prefecture)},\"national_2rate\":${pythonFloat(nationalTwo)},\"local_2rate\":${pythonFloat(localTwo)}}`;
      parsed.entries.push({ id:`${race.id}-${Number(lane)}`, race_id:race.id, number:Number(lane), frame:Number(lane),
        name:rawName.replace(/\s+/g, '').trim() || racerId, jockey:null, trainer:null, weight_carried:num(weight), horse_weight:null,
        racer_class:racerClass, national_win_rate:num(national), local_win_rate:num(local), motor_no:motorNo,
        motor_2rate:num(motorRate), boat_no:boatNo, boat_2rate:num(boatRate), exhibition_time:null, start_exhibition:null,
        features_json:features,
        available_at:`${date}T00:00:00+09:00`, data_origin:'real' });
      continue;
    }
    if (!inRaceDetail) continue;
    const conditions = line.match(/H\s*(\d{3,4})\s*m\s*(\S+)\s+風\s*(.*?)\s*(\d+)\s*m\s+波\s*(\d+)\s*cm/);
    if (conditions) { race.distance=Number(conditions[1]);race.weather=conditions[2];race._wind_direction=conditions[3].replace(/\s+/g,'')||null;race.wind_speed=Number(conditions[4]);race.wave_height=Number(conditions[5]);continue; }
    const payout = line.match(/^\s*(単勝|複勝|2連複|2連単|拡連複|3連複|3連単)\s+(.+?)\s*$/);
    if (payout) {
      const pairs = /(?<!\d)(\d+(?:-\d+){0,2})\s+(\d+)(?:\s+人気\s+(\d+))?/g;
      for (const row of payout[2].matchAll(pairs)) parsed.payouts.push({ race_id:race.id, bet_type:PAYOUT_TYPES[payout[1]], selection:row[1], payout:Number(row[2]), popularity:row[3] ? Number(row[3]) : null, data_origin:'real' });
      continue;
    }
    const result = line.match(RESULT_RE); if (!result) continue;
    const [, finishText, lane, racerId, rawName, motorNo, boatNo, exhibition, course, start] = result;
    const finish = /^\d+$/.test(finishText) && Number(finishText) > 0 ? Number(finishText) : null;
    const windDirection = race._wind_direction ?? null;
    const resultFeatures=`{\"racer_id\":${JSON.stringify(racerId)},\"finish_code\":${finish === null ? JSON.stringify(finishText) : 'null'},\"wind_direction\":${windDirection === null ? 'null' : JSON.stringify(windDirection)},\"race_start_timing\":${pythonFloat(num(start))},\"entry_course\":${/^[1-6]$/.test(course) ? Number(course) : 'null'}}`;
    parsed.entries.push({ id:`${race.id}-${Number(lane)}`, race_id:race.id, number:Number(lane),
      frame:/^[1-6]$/.test(course) ? Number(course) : null, name:rawName.replace(/\s+/g, '').trim() || racerId,
      jockey:null, trainer:null, weight_carried:null, horse_weight:null, racer_class:null, national_win_rate:null, local_win_rate:null,
      motor_no:motorNo, motor_2rate:null, boat_no:boatNo, boat_2rate:null, exhibition_time:num(exhibition), start_exhibition:null,
      features_json:resultFeatures,
      available_at:`${date}T00:00:00+09:00`, data_origin:'real' });
    if (finish !== null) parsed.results.push({ race_id:race.id, finish_order:finish, number:Number(lane), data_origin:'real' });
  }
  for (const row of parsed.races) delete row._wind_direction;
  return parsed;
}

/** One invocation fetches at most one official file and writes at most 400 D1 statements. */
export async function syncBoatraceProgramFile(db: Db, bucket: R2Bucket, scheduledAt: Date, kind: ProgramFileKind,
  options: ProgramSyncOptions = {}): Promise<ProgramSyncOutcome> {
  const now=options.now??Date.now,fetcher=options.fetch??fetch;
  const at=scheduledAt.getTime(),today=jstDate(now()),yesterday=new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  const date=options.targetDate??jstDate(at);
  if(!Number.isFinite(at)||Math.abs(now()-at)>MAX_SCHEDULE_SKEW_MS||!/^\d{4}-\d{2}-\d{2}$/.test(date)||(date!==today&&date!==yesterday)||(kind==='B'&&date!==today))return outcome('skipped','invalid-schedule',kind,date,0,false);
  const startedAt=isoNow(now()),cursorKey=`boatrace-program-sync:${kind}:${date}`;
  const cursorRow=await first<{value:string}>(db,'SELECT value FROM settings WHERE key=?',cursorKey);
  let cursor:ProgramCursor|undefined;
  try{if(cursorRow?.value)cursor=JSON.parse(cursorRow.value) as ProgramCursor;}catch{cursor=undefined;}
  let parsed:ParsedProgram, fetchedAt:string, sha256:string, url:string, rawKey:string, manifestKey:string;
  let previousSha:string|undefined,offset=0,firstStartedAt=startedAt,sourceBytes=0;
  if(cursor&&cursor.schema==='boatrace-program-cursor-v1'&&cursor.kind===kind&&cursor.targetDate===date&&SHA256.test(cursor.sha256)&&Number.isSafeInteger(cursor.offset)&&cursor.offset>=0){
    try{
      const object=await bucket.get(cursor.manifestKey);
      if(!object||object.size>MAX_TEXT_BYTES)throw Error();
      const manifest=JSON.parse(await object.text()) as ProgramManifest;
      if(manifest.schema!=='boatrace-normalized-program-v1'||manifest.kind!==kind||manifest.targetDate!==date||manifest.sha256!==cursor.sha256||manifest.fetchedAt!==cursor.fetchedAt)throw Error();
      parsed=manifest.data;validateParsed(kind,parsed,date);
      fetchedAt=cursor.fetchedAt;sha256=cursor.sha256;url=cursor.url;rawKey=cursor.rawKey;manifestKey=cursor.manifestKey;previousSha=cursor.previousSha;offset=cursor.offset;firstStartedAt=cursor.startedAt;sourceBytes=manifest.sourceBytes;
    }catch{return outcome('failed','database-write-failed',kind,date,0,true);}
  }else{
    const gap=options.minGapMs??MIN_REQUEST_GAP_MS,requestAt=now();
    const reservation=await db.prepare(`INSERT INTO settings(key,value) VALUES('boatrace-program-last-request-at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<=CAST(excluded.value AS INTEGER)-?`).bind(String(requestAt),gap).run();
    if(reservation.meta?.changes!==1)return outcome('skipped','source-rate-limited',kind,date,0,true);
    const day=date.replaceAll('-',''),yyMMdd=day.slice(2);url=`https://www1.mbrace.or.jp/od2/${kind}/${day.slice(0,6)}/${kind.toLowerCase()}${yyMMdd}.lzh`;
    let response:Response;try{response=await fetcher(url,{headers:{'User-Agent':'EdgeLab/0.1 (official Boatrace downloadable data collector)','Accept':'application/octet-stream'},redirect:'error'});}catch{return outcome('failed','source-fetch-failed',kind,date,0,true);}
    fetchedAt=isoNow(now());
    if(response.status===404){await response.body?.cancel().catch(()=>undefined);return{...outcome('skipped','source-not-published',kind,date,0,true),fetchedAt};}
    if(!response.ok){await response.body?.cancel().catch(()=>undefined);return{...outcome('failed',response.status===403?'source-forbidden':response.status>=500?'source-server-error':'source-http-error',kind,date,0,response.status===403||response.status===408||response.status===429||response.status>=500),fetchedAt};}
    const declared=Number(response.headers.get('content-length')??0);if(declared>MAX_ARCHIVE_BYTES){await response.body?.cancel().catch(()=>undefined);return{...outcome('failed','archive-size-invalid',kind,date,0,false),fetchedAt};}
    let archive:Uint8Array;try{archive=await readBoundedBody(response,MAX_ARCHIVE_BYTES);}catch{return{...outcome('failed','archive-size-invalid',kind,date,0,false),fetchedAt};}
    fetchedAt=isoNow(now());sourceBytes=archive.length;if(!sourceBytes)return{...outcome('failed','archive-size-invalid',kind,date,0,false),fetchedAt};
    sha256=await hash(archive);
    try{const decoded=options.decodeArchive?await options.decodeArchive(archive):await decodeBoatraceLzh(archive);parsed=parseBoatraceProgramText(kind,decoded.text,date);validateParsed(kind,parsed,date);}catch{return{...outcome('failed','archive-parse-rejected',kind,date,0,false),sourceSha256:sha256,fetchedAt};}
    rawKey=`boat-program-files/${date}/${kind.toLowerCase()}/${sha256}.lzh`;manifestKey=`boat-program-manifests/${date}/${kind.toLowerCase()}/${sha256}-${BOATRACE_PROGRAM_PARSER_VERSION}.json`;
    try{
      if(!await bucket.head(rawKey))await bucket.put(rawKey,archive,{httpMetadata:{contentType:'application/x-lzh'},customMetadata:{kind,targetDate:date,sha256,fetchedAt,parserVersion:BOATRACE_PROGRAM_PARSER_VERSION}});
      const oldManifest=await bucket.get(manifestKey);
      if(oldManifest){
        if(oldManifest.size>MAX_TEXT_BYTES)throw Error();const stored=JSON.parse(await oldManifest.text()) as ProgramManifest;
        if(stored.schema!=='boatrace-normalized-program-v1'||stored.kind!==kind||stored.targetDate!==date||stored.sha256!==sha256||stored.parserVersion!==BOATRACE_PROGRAM_PARSER_VERSION||!Number.isFinite(Date.parse(stored.fetchedAt))||stored.sourceBytes!==sourceBytes)throw Error();
        fetchedAt=stored.fetchedAt;
      }else{
        const normalized=JSON.stringify({schema:'boatrace-normalized-program-v1',kind,targetDate:date,url,sha256,sourceBytes,fetchedAt,parserVersion:BOATRACE_PROGRAM_PARSER_VERSION,data:manifestData(parsed,kind,date,fetchedAt,sha256)} satisfies ProgramManifest);
        if(normalized.length>MAX_TEXT_BYTES)throw Error();
        await bucket.put(manifestKey,normalized,{httpMetadata:{contentType:'application/json'},customMetadata:{kind,targetDate:date,sha256,fetchedAt,parserVersion:BOATRACE_PROGRAM_PARSER_VERSION}});
      }
    }catch{return{...outcome('failed','source-archive-write-failed',kind,date,0,true),sourceSha256:sha256,fetchedAt};}
    try{
      const prior=await first<{reason:string|null}>(db,`SELECT reason FROM collection_runs WHERE source=? AND sport='boat' AND target_date=? AND status='success' AND json_valid(reason) AND json_extract(reason,'$.kind')=? ORDER BY started_at DESC LIMIT 1`,BOATRACE_PROGRAM_SOURCE,date,kind);
      const priorReason=JSON.parse(prior?.reason??'{}');if(typeof priorReason.sha256==='string'&&SHA256.test(priorReason.sha256))previousSha=priorReason.sha256;
    }catch{return{...outcome('failed','database-write-failed',kind,date,0,true),sourceSha256:sha256,fetchedAt};}
    const initial:ProgramCursor={schema:'boatrace-program-cursor-v1',kind,targetDate:date,sha256,url,rawKey,manifestKey,fetchedAt,startedAt,previousSha,offset:0};
    try{await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(cursorKey,JSON.stringify(initial)).run();}catch{return{...outcome('failed','database-write-failed',kind,date,0,true),sourceSha256:sha256,fetchedAt};}
  }
  try{
    const statements=buildStatements(db,parsed,kind,date,fetchedAt,previousSha,sha256),end=Math.min(offset+MAX_STATEMENTS_PER_TICK,statements.length);
    for(let i=offset;i<end;i+=STATEMENTS_PER_BATCH){const batch=statements.slice(i,Math.min(i+STATEMENTS_PER_BATCH,end));if(db.batch)await db.batch(batch);else for(const statement of batch)await statement.run();}
    if(end<statements.length){const next:ProgramCursor={schema:'boatrace-program-cursor-v1',kind,targetDate:date,sha256,url,rawKey,manifestKey,fetchedAt,startedAt:firstStartedAt,previousSha,offset:end};await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(cursorKey,JSON.stringify(next)).run();return{...outcome('partial','source-sync-in-progress',kind,date,recordCount(parsed),true),sourceSha256:sha256,fetchedAt};}
    const count=recordCount(parsed),reason=JSON.stringify({schema:'boatrace-source-file-v1',kind,targetDate:date,url,sha256,sourceBytes,fetchedAt,parserVersion:BOATRACE_PROGRAM_PARSER_VERSION,r2Key:rawKey,manifestKey}),id=`boat-program-file:${kind}:${date}:${sha256}`;
    await db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error,reason) VALUES(?,?, 'boat', ?, ?, ?, 'success', ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at,finished_at=excluded.finished_at,status='success',records=excluded.records,error=NULL,reason=excluded.reason`).bind(id,BOATRACE_PROGRAM_SOURCE,date,firstStartedAt,isoNow(now()),count,reason).run();
    await db.prepare('DELETE FROM settings WHERE key=?').bind(cursorKey).run();
    return{...outcome('success','source-file-stored',kind,date,count,false),sourceSha256:sha256,fetchedAt};
  }catch{return{...outcome('failed','database-write-failed',kind,date,0,true),sourceSha256:sha256,fetchedAt};}
}

function outcome(status:ProgramSyncOutcome['status'],reason:string,kind:ProgramFileKind,targetDate:string,records:number,retryable:boolean):ProgramSyncOutcome {
  return {status,reason,kind,targetDate,records,retryable};
}
function validateParsed(kind:ProgramFileKind,data:ParsedProgram,date:string) {
  if (!data.races.length || data.races.some(r=>r.race_date!==date||!/^boat-\d{8}-(?:0[1-9]|1\d|2[0-4])-(?:0[1-9]|1[0-2])$/.test(String(r.id))||Number(r.race_no)<1||Number(r.race_no)>12)) throw new Error('race-identity-invalid');
  if (new Set(data.races.map(r=>r.id)).size!==data.races.length) throw new Error('race-identity-invalid');
  if (kind==='B') {
    if (!data.entries.length || data.entries.some(e=>!data.races.some(r=>r.id===e.race_id))) throw new Error('entry-set-invalid');
    for(const race of data.races){const entries=data.entries.filter(e=>e.race_id===race.id);if(entries.length!==6||new Set(entries.map(e=>Number(e.number))).size!==6||entries.some(e=>Number(e.number)<1||Number(e.number)>6))throw new Error('entry-set-invalid');}
  }
  if (kind==='K' && (!data.results.length || data.results.some(r=>!data.races.some(x=>x.id===r.race_id)))) throw new Error('result-set-invalid');
}
function recordCount(data:ParsedProgram){return data.races.length+data.entries.length+data.results.length+data.payouts.length;}
async function readBoundedBody(response:Response,limit:number):Promise<Uint8Array>{
  if(!response.body)throw Error('body-missing');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>limit){void reader.cancel().catch(()=>undefined);throw Error('body-too-large');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}return output;
}
function buildStatements(db:Db,data:ParsedProgram,kind:ProgramFileKind,date:string,fetchedAt:string,previousSha:string|undefined,sha256:string) {
  const statements:Statement[]=[];
  for (const venue of Object.keys(VENUES)) statements.push(db.prepare("INSERT INTO venues(id,sport,name) VALUES(?,'boat',?) ON CONFLICT(id) DO NOTHING").bind(venue,VENUES[venue]));
  for (const race of data.races) {
    statements.push(db.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,name,distance,surface,track_condition,weather,wind_speed,wave_height,post_time,status,data_origin,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(race.id,race.sport,race.venue_id,race.race_date,race.race_no,race.name,race.distance,race.surface,race.track_condition,race.weather,race.wind_speed,race.wave_height,race.post_time,race.status,'real',fetchedAt));
    if (kind==='B' && previousSha!==sha256) statements.push(db.prepare(`UPDATE races SET name=COALESCE(?,name),distance=COALESCE(?,distance),post_time=COALESCE(?,post_time),updated_at=?
      WHERE id=? AND data_origin='real' AND betting_cutoff_at IS NULL AND betting_cutoff_source IS NULL
        AND NOT EXISTS(SELECT 1 FROM predictions p WHERE p.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM ticket_predictions p WHERE p.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM experimental_paper_decisions d WHERE d.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM experimental_paper_bets b WHERE b.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions d WHERE d.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets b WHERE b.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives a WHERE a.race_id=races.id)
        AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=races.id)`)
      .bind(race.name,race.distance,race.post_time,fetchedAt,race.id));
  }
  for (const entry of data.entries) {
    const available=fetchedAt;
    const features=kind==='B'?JSON.stringify({...safeJsonObject(entry.features_json),source_url:sourceUrlFor(kind,date),source_sha256:sha256,source_available_at:fetchedAt}):entry.features_json;
    statements.push(db.prepare(`INSERT INTO entries(id,race_id,number,frame,name,jockey,trainer,weight_carried,horse_weight,racer_class,national_win_rate,local_win_rate,motor_no,motor_2rate,boat_no,boat_2rate,exhibition_time,start_exhibition,features_json,available_at,data_origin)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(race_id,number) DO NOTHING`).bind(entry.id,entry.race_id,entry.number,entry.frame,entry.name,entry.jockey,entry.trainer,entry.weight_carried,entry.horse_weight,entry.racer_class,entry.national_win_rate,entry.local_win_rate,entry.motor_no,entry.motor_2rate,entry.boat_no,entry.boat_2rate,entry.exhibition_time,entry.start_exhibition,features,available,'real'));
    if (kind==='B' && previousSha!==sha256) statements.push(db.prepare(`UPDATE entries SET frame=COALESCE(?,frame),name=COALESCE(?,name),weight_carried=COALESCE(?,weight_carried),racer_class=COALESCE(?,racer_class),
      national_win_rate=COALESCE(?,national_win_rate),local_win_rate=COALESCE(?,local_win_rate),motor_no=COALESCE(?,motor_no),motor_2rate=COALESCE(?,motor_2rate),boat_no=COALESCE(?,boat_no),boat_2rate=COALESCE(?,boat_2rate),
      features_json=CASE WHEN json_valid(features_json) THEN json_patch(features_json,?) ELSE ? END,available_at=?
      WHERE race_id=? AND number=? AND data_origin='real'
        AND NOT EXISTS(SELECT 1 FROM races r WHERE r.id=entries.race_id AND (r.betting_cutoff_at IS NOT NULL OR r.betting_cutoff_source IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM predictions p WHERE p.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM ticket_predictions p WHERE p.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM experimental_paper_bets b WHERE b.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_bets b WHERE b.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM experimental_paper_decisions d WHERE d.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions d WHERE d.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives a WHERE a.race_id=entries.race_id)
        AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=entries.race_id)`)
      .bind(entry.frame,entry.name,entry.weight_carried,entry.racer_class,entry.national_win_rate,entry.local_win_rate,entry.motor_no,entry.motor_2rate,entry.boat_no,entry.boat_2rate,features,features,fetchedAt,entry.race_id,entry.number));
  }
  if (kind==='K') {
    for (const race of data.races) statements.push(db.prepare("UPDATE races SET status='finished',weather=COALESCE(?,weather),wind_speed=COALESCE(?,wind_speed),wave_height=COALESCE(?,wave_height),updated_at=? WHERE id=? AND data_origin='real' AND status IN ('scheduled','closed')").bind(race.weather,race.wind_speed,race.wave_height,fetchedAt,race.id));
    for (const result of data.results) statements.push(db.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'real\') ON CONFLICT(race_id,number) DO NOTHING').bind(result.race_id,result.finish_order,result.number));
    for (const payout of data.payouts) statements.push(db.prepare('INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,?,?,?,?,\'real\') ON CONFLICT(race_id,bet_type,selection) DO NOTHING').bind(payout.race_id,payout.bet_type,payout.selection,payout.payout,payout.popularity));
  }
  return statements;
}
function safeJsonObject(value:unknown):Record<string,unknown>{if(typeof value!=='string')return{};try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}}catch{return{}}}
function sourceUrlFor(kind:ProgramFileKind,date:string){const day=date.replaceAll('-','');return`https://www1.mbrace.or.jp/od2/${kind}/${day.slice(0,6)}/${kind.toLowerCase()}${day.slice(2)}.lzh`;}
function isStrictShiftJis(bytes:Uint8Array):boolean{return isValidShiftJis(bytes,false);}
function isValidCp932(bytes:Uint8Array):boolean{return isValidShiftJis(bytes,true);}
function isValidShiftJis(bytes:Uint8Array,cp932:boolean):boolean{
  for(let i=0;i<bytes.length;i++){
    const b=bytes[i]!;
    if(b<=0x7f||(b>=0xa1&&b<=0xdf)||(cp932&&(b===0x80||b===0xa0||b>=0xfd)))continue;
    if((b>=0x81&&b<=0x9f)||(b>=0xe0&&(cp932?b<=0xfc:b<=0xef))){
      const trail=bytes[++i];if(trail===undefined||trail<0x40||trail===0x7f||trail>0xfc)return false;continue;
    }
    return false;
  }
  return true;
}
function manifestData(data:ParsedProgram,kind:ProgramFileKind,date:string,fetchedAt:string,sha256:string):ParsedProgram{
  if(kind!=='B')return data;const sourceUrl=sourceUrlFor(kind,date);
  return {...data,entries:data.entries.map(entry=>({...entry,available_at:fetchedAt,features_json:JSON.stringify({...safeJsonObject(entry.features_json),source_url:sourceUrl,source_sha256:sha256,source_available_at:fetchedAt})}))};
}
function num(v:string|undefined|null):number|null { if(!v||!v.trim()||/^[-―]+$/.test(v.trim()))return null;const x=Number(v);return Number.isFinite(x)?x:null; }
function pythonFloat(value:number|null):string { return value===null?'null':Number.isInteger(value)?`${value}.0`:String(value); }
function dateFromText(text:string,fallback:string):string|null {
  const m=text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)??text.match(/(20\d{2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if(!m)return /^20\d\d-\d\d-\d\d$/.test(fallback)?fallback:null;
  const value=`${m[1]}-${String(Number(m[2])).padStart(2,'0')}-${String(Number(m[3])).padStart(2,'0')}`;
  const parsed=new Date(`${value}T00:00:00Z`);return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?value:null;
}
function venueFromLine(line:string):string|undefined {
  const compact=line.replace(/\s+/g,''); if(!compact.includes('ボートレース')&&!compact.includes('[成績]'))return;
  return Object.entries(VENUES).sort((a,b)=>b[1].length-a[1].length).find(([,name])=>compact.includes(name))?.[0];
}
