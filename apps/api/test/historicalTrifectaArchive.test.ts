import { describe, expect, it } from 'vitest'
import { app } from '../src/index.js'
import { historicalArchiveKey, listHistoricalArchiveObjects, parseHistoricalArchiveKey, persistHistoricalObservations,
  matchesVerifiedResultPairs, type HistoricalObservation } from '../src/services/historicalTrifectaArchive.js'
import type { Db } from '../src/repo/db.js'

function fakeBucket(keys: string[]) {
  const objects=keys.sort().map((key,index)=>({key,version:'v1',size:100,etag:`e${index}`,httpEtag:`"e${index}"`,uploaded:new Date('2026-10-15T00:00:00Z'),
    customMetadata:{schema:'roi-plus-trifecta-observation-v1',raceId:`boat-20261015-${String(index+1).padStart(2,'0')}-01`,status:'complete',sourceArtifactSha256:'b'.repeat(64),predictedAt:'2026-10-15T03:00:00.000Z'}}))
  const writes=new Map<string,{bytes:Uint8Array;metadata:any}>()
  const bucket={
    objects,writes,
    async list({prefix='',cursor,limit=1000}:{prefix?:string;cursor?:string;limit?:number}){
      const rows=objects.filter(object=>object.key.startsWith(prefix)),offset=Number(cursor??0),page=rows.slice(offset,offset+limit)
      const truncated=offset+limit<rows.length
      return {objects:page,delimitedPrefixes:[],truncated,...(truncated?{cursor:String(offset+limit)}:{})}
    },
    async put(key:string,value:Uint8Array|string,_options:any){
      if(writes.has(key))return null
      writes.set(key,{bytes:typeof value==='string'?new TextEncoder().encode(value):value,metadata:_options.customMetadata})
      return {key,etag:'new'}
    },
    async head(key:string){return objects.find(object=>object.key===key)??null},
  }
  return bucket
}

const completeObservation=(overrides:Partial<HistoricalObservation>={}):HistoricalObservation=>({
  schema:'roi-plus-trifecta-observation-v1',dataOrigin:'real',race:{id:'boat-20261015-01-01',raceDate:'2026-10-15',venueId:'01',raceNo:1},
  model:{id:'boat-trifecta-historical-base-20261014',immutableVersion:'2026-10-14.1',sourceArtifactSha256:'b'.repeat(64),trainedAt:'2026-10-14T00:00:00Z'},
  timing:{phase:'t60',cutoffAt:'2026-10-15T03:01:00Z',cutoffSource:'boatrace-racelist-cutoff-v1',cutoffObservedAt:'2026-10-15T02:50:00Z',targetAt:'2026-10-15T03:00:00Z',predictedAt:'2026-10-15T03:00:00Z',observedAt:'2026-10-15T03:00:01Z'},
  archiveEvidence:{status:'verified',reason:null,id:'archive-row',capturedAt:'2026-10-15T03:00:00Z',raceListSha256:'c'.repeat(64)},
  input:{status:'complete',missingReason:null,rows:Array.from({length:6},(_,index)=>({lane:index+1,availableAt:'2026-10-15T02:59:00Z',source:{kind:'official-daily-B-file',url:'https://www1.mbrace.or.jp/od2/B/202610/b261015.lzh',sha256:'d'.repeat(64),availableAt:'2026-10-15T02:59:00Z'},features:{lane:index+1}}))},
  predictions:{status:'complete',missingReason:null,rows:Array.from({length:120},(_,index)=>({selection:String(index),probability:1/120,probStd:0}))},
  odds:{status:'complete',missingReason:null,sourceUrl:'https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=01&hd=20261015',requestedAt:'2026-10-15T03:00:00Z',capturedAt:'2026-10-15T03:00:01Z',sha256:'e'.repeat(64),qualityStatus:'verified-complete-v1',rows:Array.from({length:120},(_,index)=>({selection:String(index),odds:20}))},
  virtualDecision:{decisionId:null,outcome:'abstained',totalStake:0},...overrides,
})

describe('private historical trifecta R2 archive',()=>{
  it('keeps complete and partial snapshots in separate immutable keys',async()=>{
    const bucket=fakeBucket([]),db={} as Db
    const partial=completeObservation({odds:{status:'missing',missingReason:'fresh_official_market_not_observed',sourceUrl:null,requestedAt:null,capturedAt:null,sha256:null,qualityStatus:null,rows:[]}})
    const report=await persistHistoricalObservations(bucket as unknown as R2Bucket,db,[completeObservation(),partial])
    expect(report).toMatchObject({attempted:2,stored:2,failed:0})
    const keys=[...bucket.writes.keys()]
    expect(keys).toContain(historicalArchiveKey('2026-10-15','01',1,'boat-trifecta-historical-base-20261014'))
    expect(keys.some(key=>key.includes('/t-60-attempts/'))).toBe(true)
    expect([...bucket.writes.values()].map(value=>value.metadata.status).sort()).toEqual(['complete','incomplete'])
  })

  it('paginates R2 archives without skipping the object after a full page',async()=>{
    const keys=Array.from({length:26},(_,index)=>historicalArchiveKey('2026-10-15',String(index+1).padStart(2,'0'),1,'boat-trifecta-historical-base-20261014'))
    const bucket=fakeBucket(keys) as unknown as R2Bucket
    const env={DB:{} as Db,INGEST_TOKEN:'test-token',TRIFECTA_ARCHIVE:bucket}
    expect((await app.request('/api/ingest/historical-trifecta-archives?date=2026-10-15&limit=25',{},env)).status).toBe(401)
    const auth={headers:{Authorization:'Bearer test-token'}}
    const first=await app.request('/api/ingest/historical-trifecta-archives?date=2026-10-15&limit=25',auth,env)
    const firstBody=await first.json() as any
    expect(firstBody.archives).toHaveLength(25)
    expect(firstBody.nextCursor).toBeTruthy()
    const next=await app.request(`/api/ingest/historical-trifecta-archives?date=2026-10-15&limit=25&cursor=${firstBody.nextCursor}`,auth,env)
    const nextBody=await next.json() as any
    expect(nextBody.archives).toHaveLength(1)
    expect(new Set([...firstBody.archives,...nextBody.archives].map((row:any)=>row.key)).size).toBe(26)
  })

  it('rejects keys outside the exact archive prefix and model version',()=>{
    expect(parseHistoricalArchiveKey(historicalArchiveKey('2026-10-15','01',1,'boat-trifecta-historical-base-20261014'))?.completeKey).toBe(true)
    expect(parseHistoricalArchiveKey('historical-trifecta/v1/sample/2026-10-15/01/1/model/t-60.json.gz')).toBeNull()
    expect(parseHistoricalArchiveKey('historical-trifecta/v1/real/2026-10-15/01/13/model/t-60.json.gz')).toBeNull()
  })

  it('requires the proof to match all six saved number/rank pairs exactly',()=>{
    const saved=Array.from({length:6},(_,index)=>({number:index+1,finish_order:6-index}))
    const proof=saved.map(row=>({number:row.number,finishOrder:row.finish_order}))
    expect(matchesVerifiedResultPairs(proof,saved)).toBe(true)
    expect(matchesVerifiedResultPairs([...proof.slice(0,5),proof[0]],saved)).toBe(false)
    expect(matchesVerifiedResultPairs(proof.map((row,index)=>index===0?{...row,finishOrder:0}:row),saved)).toBe(false)
  })
})
