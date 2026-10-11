import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMinuteTimer, signMinuteTrigger, MINUTE_TRIGGER_URL, MINUTE_TRIGGER_CRON, MINUTE_TRIGGER_LIMITS } from './minute-trigger.js';
import { createCollectorTriggerHandler, collectorTriggerMessage, COLLECTOR_TRIGGER_BODY } from '../worker/collector-trigger.js';

const NOW=Date.parse('2026-10-12T01:00:00.000Z'),KEY='minute_test_'.padEnd(64,'k'),TOKEN='server_only_'.padEnd(64,'t'),NONCE='a'.repeat(32);
const settings=()=>({EARTH_MINUTE_TIMER_ENABLED:'1',EARTH_TRIGGER_HMAC_KEY:KEY});
const stored=()=>Response.json({schemaVersion:1,status:'stored',stored:true,sourceCount:4,snapshotCount:4,failureCount:0,recordCount:12,
  worldStored:true,updatesPublished:true,unsafe:KEY,sourceText:'Private untrusted source content'});
const controller=(changes={})=>({cron:MINUTE_TRIGGER_CRON,type:'scheduled',scheduledTime:NOW,...changes});

test('WebCrypto signature interoperates with existing fixed collect-only server capability without the broad secret on the runner',async()=>{
  const headers=await signMinuteTrigger(KEY,{now:NOW,nonce:NONCE});
  assert.equal(headers['x-earth-trigger-signature'],createHmac('sha256',KEY).update(collectorTriggerMessage(String(NOW/1000),NONCE,COLLECTOR_TRIGGER_BODY)).digest('hex'));
  let calls=0;const host={EARTH_TRIGGER_HMAC_KEY:KEY,EARTH_COLLECTOR_TOKEN:TOKEN};
  const handle=createCollectorTriggerHandler({now:()=>NOW,collectionHandler:async(request)=>{
    calls++;assert.equal(request.headers.get('authorization'),`Bearer ${TOKEN}`);assert.equal(await request.text(),COLLECTOR_TRIGGER_BODY);
    return Response.json({stored:true,collectedAt:new Date(NOW).toISOString(),plugins:['usgs','gdacs','eonet','gdelt'],snapshots:[{},{},{},{}],
      failures:[],prepared:{recordCount:12},world:{stored:true},updatesPublished:true});}});
  const env=settings();Object.defineProperty(env,'EARTH_COLLECTOR_TOKEN',{get(){assert.fail('Runner must not read broad secret');}});
  Object.defineProperty(env,'COLLECTOR_STATE',{get(){assert.fail('Runner must not access KV');}});
  const timer=createMinuteTimer({now:()=>NOW,nonce:()=>NONCE,fetchImpl:async(url,options)=>{
    assert.equal(url,MINUTE_TRIGGER_URL);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    assert.equal(options.cache,'no-store');assert.equal(options.body,COLLECTOR_TRIGGER_BODY);assert.equal(new Headers(options.headers).has('authorization'),false);
    const normalized=new URL(url);normalized.pathname=normalized.pathname.slice('/earth'.length);return handle(new Request(normalized,options),host);
  }});
  const result=await timer.run(env);assert.equal(result.ok,true);assert.equal(result.summary.stored,true);assert.equal(result.summary.worldStored,true);assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes(KEY),false);assert.equal(JSON.stringify(result).includes(TOKEN),false);
});

test('misconfigured target/key, paused gate and invalid cron never send a request; HTTP health is read-only and cannot change scope',async()=>{
  let calls=0,noRetry=0;const logs=[];
  const timer=createMinuteTimer({now:()=>NOW,logger:(summary)=>logs.push(summary),fetchImpl:async()=>{calls++;return stored();}});
  assert.equal((await timer.run({})).summary.status,'unconfigured');
  assert.equal((await timer.run({...settings(),EARTH_TRIGGER_HMAC_KEY:'short'})).summary.status,'unconfigured');
  assert.equal((await timer.run({...settings(),EARTH_MINUTE_TIMER_ENABLED:'0'})).summary.status,'paused');
  for(const origin of ['https://attacker.example','http://giovannicallebaut.com','https://giovannicallebaut.com/earth/',
    'https://user@giovannicallebaut.com','https://giovannicallebaut.com.evil.example','https://giovannicallebaut.com/?action=publish'])
    assert.equal((await timer.run({...settings(),EARTH_TARGET_ORIGIN:origin})).summary.status,'invalid_configuration');
  for(const change of [{cron:'*/5 * * * *'},{type:'fetch'},{scheduledTime:NaN},{scheduledTime:1e300}])
    await assert.rejects(timer.scheduled(controller({...change,noRetry(){noRetry++;}}),settings()),/invalid_schedule/);
  assert.equal((await timer.scheduled(controller({noRetry(){noRetry++;}}),{EARTH_MINUTE_TIMER_ENABLED:'0'})).summary.status,'paused');
  assert.equal(calls,0);assert.equal(noRetry,5);assert.equal(logs.length,5);
  for(const path of ['/','/healthz','/status']){const response=timer.fetch(new Request(`https://timer.example${path}`),settings());assert.equal(response.status,200);
    const health=await response.json();assert.equal(health.stateStorage,'none');assert.equal(health.status,'ready');assert.equal('lastSuccessAt'in health,false);}
  assert.equal(timer.fetch(new Request('https://timer.example/status?target=https://bad.example'),settings()).status,400);
  assert.equal(timer.fetch(new Request('https://timer.example/status',{method:'POST'}),settings()).status,405);
  assert.equal(timer.fetch(new Request('https://timer.example/collect'),settings()).status,404);assert.equal(calls,0);
});

test('bounded success summaries discard secrets/source text and fail responses never retry within an invocation',async()=>{
  let calls=0,noRetry=0;const logs=[];
  const timer=createMinuteTimer({now:()=>NOW,nonce:()=>NONCE,logger:(summary)=>logs.push(summary),fetchImpl:async()=>{calls++;return stored();}});
  assert.equal((await timer.scheduled(controller({noRetry(){noRetry++;}}),settings())).ok,true);
  assert.equal(calls,1);assert.equal(noRetry,1);assert.equal(logs[0].recordCount,12);assert.equal(JSON.stringify(logs).includes(KEY),false);
  assert.equal(JSON.stringify(logs).includes('Private untrusted source content'),false);
  const failed=createMinuteTimer({now:()=>NOW,logger:(summary)=>logs.push(summary),fetchImpl:async()=>{calls++;
    return Response.json({status:'failed',stored:false,recordCount:100000,secret:KEY},{status:503});}});
  await assert.rejects(failed.scheduled(controller({noRetry(){noRetry++;}}),settings()),/Earth minute timer: failed/);
  assert.equal(calls,2);assert.equal(logs.at(-1).recordCount,null);
  const busy=createMinuteTimer({logger:()=>{},fetchImpl:async()=>Response.json({status:'busy',stored:false},{status:429})});
  assert.equal((await busy.scheduled(controller(),settings())).summary.status,'busy');
});

test('oversized declared/streamed JSON, invalid UTF8, mismatched targets and misleading successful payloads are bounded failures',async()=>{
  let cancellations=0;
  const responses=[()=>new Response('x'.repeat(MINUTE_TRIGGER_LIMITS.responseBytes+1),{headers:{'content-type':'application/json'}}),
    ()=>new Response('x',{headers:{'content-type':'application/json','content-length':String(MINUTE_TRIGGER_LIMITS.responseBytes+1)}}),
    ()=>new Response('<html>PRIVATE</html>',{headers:{'content-type':'text/html'}}),
    ()=>Response.json({status:'stored',stored:false}),()=>Response.json({status:'stored',stored:true},{status:503}),
    ()=>Response.json({status:'failed',stored:true},{status:503}),()=>Response.json({status:'unknown',stored:true}),()=>Response.json([]),
    ()=>new Response(new Uint8Array([0xff,0xfe]),{headers:{'content-type':'application/json'}}),
    ()=>{const response=stored();Object.defineProperty(response,'redirected',{value:true});return response;},
    ()=>{const response=stored();Object.defineProperty(response,'url',{value:'https://bad.example/'});return response;},
    ()=>new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array(MINUTE_TRIGGER_LIMITS.responseBytes+1));},cancel(){cancellations++;}}),
      {headers:{'content-type':'application/json'}}),
  ];
  for(const makeResponse of responses){let calls=0;const timer=createMinuteTimer({now:()=>NOW,fetchImpl:async()=>{calls++;return makeResponse();}});
    const result=await timer.run(settings());assert.equal(result.ok,false);assert.equal(result.summary.status,'request_failed');
    assert.equal(result.summary.stored,null);assert.equal(result.summary.readStatusBeforeRetry,true);assert.equal(calls,1);
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false);}
  assert.equal(cancellations,1);
});

test('deadline and cancellation finish even when fetch or response streams ignore cancellation, preserving unknown commit outcome',async()=>{
  let calls=0;const timer=createMinuteTimer({now:()=>NOW,timeoutMs:10,fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  const timed=await timer.run(settings());assert.equal(timed.summary.status,'uncertain');assert.equal(timed.summary.stored,null);assert.equal(calls,1);
  const stopped=new AbortController();stopped.abort();assert.equal((await timer.run(settings(),{signal:stopped.signal})).summary.status,'cancelled');assert.equal(calls,1);
  const running=new AbortController(),operation=timer.run(settings(),{signal:running.signal});setTimeout(()=>running.abort(),1);
  const cancelled=await operation;assert.equal(cancelled.summary.status,'cancelled');assert.equal(cancelled.summary.stored,null);assert.equal(calls,2);
  let bodyCancelled=false;const streamed=createMinuteTimer({now:()=>NOW,timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({
    pull(){return new Promise(()=>{});},cancel(){bodyCancelled=true;}}),{headers:{'content-type':'application/json'}})});
  assert.equal((await streamed.run(settings())).summary.status,'uncertain');assert.equal(bodyCancelled,true);
});

test('default deployment is a minute-only scoped Worker with no storage/broad credential; cron deletion is explicit',async()=>{
  const text=await readFile(new URL('./wrangler.example.jsonc',import.meta.url),'utf8'),config=JSON.parse(text);
  assert.equal(config.main,'minute-trigger.js');assert.deepEqual(config.triggers.crons,[MINUTE_TRIGGER_CRON]);assert.equal(config.workers_dev,false);
  assert.deepEqual(config.secrets.required,['EARTH_TRIGGER_HMAC_KEY']);assert.equal(config.vars.EARTH_MINUTE_TIMER_ENABLED,'1');
  assert.equal('kv_namespaces'in config,false);assert.equal('d1_databases'in config,false);assert.equal('r2_buckets'in config,false);
  assert.equal(JSON.stringify(config).includes('EARTH_COLLECTOR_TOKEN'),false);
  const disabled={...config,triggers:{crons:[]},vars:{...config.vars,EARTH_MINUTE_TIMER_ENABLED:'0'}};
  assert.deepEqual(disabled.triggers.crons,[]);assert.equal((await createMinuteTimer({fetchImpl(){assert.fail('Paused cron request');}}).run(disabled.vars)).summary.status,'paused');
});
