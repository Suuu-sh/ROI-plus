import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {expect,it} from 'vitest';

// Isolated workerd regression: every outbound call is an in-process synthetic
// service. No real source, D1 binding, credentials or project dev/reset command.
it('workerd accepts result manual redirect mode and does not follow a synthetic redirect',async()=>{
  const collector=readFileSync(resolve(import.meta.dirname,'../src/services/collectBoatraceResults.ts'),'utf8');
  const redirect=collector.match(/redirect:'(\w+)'/)?.[1];
  expect(redirect).toBe('manual');
  let calls=0;
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,compatibilityDate:'2026-10-09',
    outboundService:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://invalid.example/never-follow'}});},
    script:`export default {async fetch(){const response=await fetch('https://invalid.example/synthetic',{redirect:${JSON.stringify(redirect)}});return Response.json({status:response.status})}}`,
  }));
  try {
    const response=await mf.dispatchFetch('http://local.test/');
    expect(await response.json()).toEqual({status:302});expect(calls).toBe(1);
  } finally {await mf.dispose();}
});
