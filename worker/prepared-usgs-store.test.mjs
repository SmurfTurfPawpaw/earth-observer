import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFixture,CLOCK } from './document-investigation-fixture.mjs';
import { runSourcePlugin,readPluginObservations } from './plugins/store.js';
import { USGS_LIVE_DAY_PLUGIN,collectUsgsLiveDay,usgsLiveDayItems } from './plugins/usgs-live-day.js';
import { readPreparedUsgsScene,ensurePreparedUsgsScene,PREPARED_USGS_KEYS,PREPARED_USGS_STORE_LIMITS } from './prepared-usgs-store.js';
import { validatePreparedUsgsScene,selectPreparedUsgsCells,diffPreparedUsgsViews } from './prepared-usgs-scene.js';
import { pluginJson } from '../src/core/plugin-evidence.js';

const UTF8=new TextEncoder(),descriptor={...USGS_LIVE_DAY_PLUGIN,collect:collectUsgsLiveDay,items:usgsLiveDayItems};
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function source(magnitude=3,generated=CLOCK){return JSON.stringify({type:'FeatureCollection',metadata:{generated,count:1,status:200,url:descriptor.sourceUrl},
  features:[{type:'Feature',id:'testprepared',geometry:{type:'Point',coordinates:[4,50,12]},properties:{mag:magnitude,time:CLOCK-1000,
    updated:CLOCK,type:'quarry blast',status:'reviewed',url:'https://earthquake.usgs.gov/earthquakes/eventpage/testprepared'}}]});}
async function fixture(t){
  const f=await documentFixture(t,{documents:false});let serial=0,hook=null;
  const versions=new Map();
  f.env.EARTH_STORE={
    async get(key){f.activity.objects.push({operation:'get',key});await hook?.({operation:'get',key});const value=f.objects.get(key);
      return value?{etag:versions.get(key),size:value.byteLength,arrayBuffer:async()=>new Uint8Array(value).buffer}:null;},
    async put(key,body,options={}){f.activity.objects.push({operation:'put',key,options});await hook?.({operation:'put',key,body,options});
      if(options.onlyIf?.get?.('if-none-match')==='*'&&f.objects.has(key)||options.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==versions.get(key))return null;
      const bytes=typeof body==='string'?UTF8.encode(body):new Uint8Array(body);f.objects.set(key,new Uint8Array(bytes));const etag=`fixture-${++serial}`;
      versions.set(key,etag);return {etag};},
  };
  return {...f,versions,hook:next=>{hook=next;},
    acquire:async(magnitude=3,{notModified=false,env=f.env}={})=>runSourcePlugin(env,descriptor,{now:f.now,fetchImpl:async()=>{
      f.activity.providers.push(descriptor.sourceUrl);return notModified?new Response(null,{status:304,headers:{etag:'"prepared-test"'}}):
        new Response(source(magnitude,f.now()),{headers:{'content-type':'application/json',etag:'"prepared-test"'}});}}),
    reset:()=>{f.reset();},
  };
}

test('actual publication prepares once; unchanged checks move only operational dates and missing slots repair without another capture',async t=>{
  const f=await fixture(t),first=await f.acquire();assert.equal(first.status,'stored');assert.equal(first.preparation.status,'prepared');
  const retained=await readPreparedUsgsScene(f.env,{now:f.now});assert.equal(retained.available,true);
  assert.equal(retained.prepared.source.receiptId,first.receiptId);assert.equal(retained.prepared.content.features[0].record.eventType,'quarry blast');
  const original=retained.source;f.advance(60001);f.reset();const checked=await f.acquire(3,{notModified:true});
  assert.equal(checked.status,'checked');assert.equal(checked.preparation.status,'ready');
  const latest=await readPreparedUsgsScene(f.env,{now:f.now});assert.deepEqual(latest.source,original);
  assert.notEqual(latest.check.checkedAt,retained.check.checkedAt);assert.equal(latest.stale,false);
  assert.equal(f.activity.objects.filter(x=>x.operation==='put').length,0);
  f.objects.delete(PREPARED_USGS_KEYS.current);f.versions.delete(PREPARED_USGS_KEYS.current);f.advance(60001);
  const repaired=await f.acquire(3,{notModified:true});assert.equal(repaired.status,'checked');assert.equal(repaired.preparation.status,'prepared');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM earth_plugin_captures').get().n,1);
  assert.equal(f.objects.has(PREPARED_USGS_KEYS.current),true);
});

test('current/prior bound preserves exact A/B/A basis and delta; stored reads perform no provider work, writes or reclustering',async t=>{
  const f=await fixture(t);await f.acquire(3);const a=await readPreparedUsgsScene(f.env,{now:f.now});
  f.advance(60001);await f.acquire(4);const b=await readPreparedUsgsScene(f.env,{now:f.now,includePrior:true});
  assert.equal(b.prior.source.receiptId,a.source.receiptId);assert.equal(b.prepared.content.features[0].record.mag,4);
  const selection={level:0,cells:[[4,0]],mode:'features'},before=await selectPreparedUsgsCells(b.prior,selection),after=await selectPreparedUsgsCells(b.prepared,selection);
  const delta=diffPreparedUsgsViews(before,after);assert.equal(delta.upsertFeatures.length,1);assert.equal(delta.upsertFeatures[0].record.mag,4);
  f.advance(60001);await f.acquire(3);const reverted=await readPreparedUsgsScene(f.env,{now:f.now,includePrior:true});
  assert.equal(reverted.prepared.contentDigest,a.prepared.contentDigest);assert.notEqual(reverted.source.receiptId,a.source.receiptId);
  assert.equal(reverted.prior.source.receiptId,b.source.receiptId);
  assert.deepEqual([...f.objects.keys()].filter(key=>key.startsWith('prepared/')).sort(),Object.values(PREPARED_USGS_KEYS).sort());
  const total=Object.values(PREPARED_USGS_KEYS).reduce((n,key)=>n+f.objects.get(key).byteLength,0);assert.ok(total<=PREPARED_USGS_STORE_LIMITS.totalBytes);
  f.reset();const warm=await readPreparedUsgsScene(f.env,{now:f.now});assert.equal(warm.prepared,reverted.prepared);
  assert.equal(f.activity.providers.length,0);assert.equal(f.activity.sql.some(row=>row.write),false);assert.equal(f.activity.objects.length,0);
  const plans=f.activity.sql.map(row=>f.sqlite.prepare('EXPLAIN QUERY PLAN '+row.sql).all(...row.values)).flat();
  assert.equal(plans.some(row=>/SCAN c/.test(row.detail)),false);
});

test('failed preparation is separate from completed source acquisition; reads stay pending without repair or acquisition',async t=>{
  const f=await fixture(t);f.hook(({operation,key})=>{if(operation==='put'&&key.startsWith('prepared/'))throw Error('fixture derivative failure');});
  const captured=await f.acquire();assert.equal(captured.status,'stored');assert.equal(captured.changed,true);assert.equal(captured.preparation.status,'pending');
  assert.equal(captured.preparation.uncertain,true,'failed/ambiguous write cannot claim a prepared commit');
  assert.equal(f.sqlite.prepare('SELECT status FROM earth_plugin_state').get().status,'ready');
  f.reset();const missing=await readPreparedUsgsScene(f.env,{now:f.now});assert.equal(missing.available,false);assert.equal(missing.pending,true);
  assert.equal(missing.source.receiptId,captured.receiptId);assert.equal(f.activity.providers.length,0);
  assert.equal(f.activity.sql.some(row=>row.write),false);assert.equal(f.activity.objects.some(row=>row.operation==='put'),false);
});

test('delayed conditional writer cannot overwrite a newer complete source/derivative; head mismatch is pending',async t=>{
  const f=await fixture(t);await f.acquire(3);f.advance(60001);
  const reached=gate(),release=gate();let block=true;
  f.hook(async({operation,key})=>{if(operation==='put'&&key===PREPARED_USGS_KEYS.current&&block){block=false;reached.resolve();await release.promise;}});
  const delayed=f.acquire(4);await reached.promise;
  const during=await readPreparedUsgsScene(f.env,{now:f.now});assert.equal(during.available,false);assert.equal(during.pending,true);
  assert.equal(during.prepared,null,'an older rendered cohort cannot masquerade as the new completed source head');
  f.advance(60001);
  // Distinct binding identity gives the competing writer its own isolate cache;
  // both still conditionally write the same R2 objects/real D1 capture head.
  const newer=await f.acquire(5,{env:{...f.env,EARTH_STORE:{...f.env.EARTH_STORE}}});assert.equal(newer.status,'stored');assert.equal(newer.preparation.status,'prepared');
  release.resolve();const old=await delayed;assert.equal(old.status,'stored');assert.equal(old.preparation.status,'superseded');
  const delivered=await readPreparedUsgsScene(f.env,{now:f.now,includePrior:true});assert.equal(delivered.source.receiptId,newer.receiptId);
  assert.equal(delivered.prepared.content.features[0].record.mag,5);
  assert.equal(JSON.parse(new TextDecoder().decode(f.objects.get(PREPARED_USGS_KEYS.current))).source.receiptId,newer.receiptId);
});

test('ambiguous conditional result uses readback; corrupt stored indices or excessive bytes fail before delivery',async t=>{
  const f=await fixture(t),original=f.env.EARTH_STORE.put;
  f.env.EARTH_STORE.put=async(...args)=>{const result=await original(...args);return args[0].startsWith('prepared/')?undefined:result;};
  const captured=await f.acquire();assert.equal(captured.status,'stored');assert.equal(captured.preparation.status,'prepared');assert.equal(captured.preparation.uncertain,true);
  const valid=JSON.parse(new TextDecoder().decode(f.objects.get(PREPARED_USGS_KEYS.current)));valid.content.levels[0].cells[0].indices.push(0);
  await assert.rejects(validatePreparedUsgsScene(valid),/integrity/);
  f.advance(60001);assert.equal((await f.acquire(4)).preparation.status,'prepared');
  f.objects.set(PREPARED_USGS_KEYS.prior,UTF8.encode(pluginJson(valid)));f.versions.set(PREPARED_USGS_KEYS.prior,'corrupt-prior');
  const recovered=await readPreparedUsgsScene(f.env,{now:f.now,includePrior:true});
  assert.equal(recovered.available,true);assert.equal(recovered.prepared.content.features[0].record.mag,4);
  assert.equal(recovered.prior,null,'corrupt prior drops the delta base without blocking a complete current snapshot');
  const out=await readPreparedUsgsScene({...f.env,EARTH_STORE:{...f.env.EARTH_STORE,get:async()=>({etag:'corrupt',size:PREPARED_USGS_STORE_LIMITS.objectBytes+1})}},
    {now:f.now});assert.equal(out.available,false);assert.equal(out.errorCode,'prepared_object_limit');
  assert.ok(UTF8.encode(pluginJson(valid)).byteLength<PREPARED_USGS_STORE_LIMITS.objectBytes);
});

test('an owner wake repairs a corrupt prior using its exact ETag before promoting the next complete scene',async t=>{
  const f=await fixture(t);await f.acquire(3);f.advance(60001);const b=await f.acquire(4);
  f.objects.set(PREPARED_USGS_KEYS.prior,UTF8.encode('{bad-json'));f.versions.set(PREPARED_USGS_KEYS.prior,'bad-prior-version');
  f.reset();const before=await readPreparedUsgsScene(f.env,{now:f.now,includePrior:true});
  assert.equal(before.available,true);assert.equal(before.prior,null);assert.equal(f.activity.objects.some(row=>row.operation==='put'),false);
  f.advance(60001);f.reset();const c=await f.acquire(5);assert.equal(c.status,'stored');assert.equal(c.preparation.status,'prepared');
  const priorWrite=f.activity.objects.find(row=>row.operation==='put'&&row.key===PREPARED_USGS_KEYS.prior);
  assert.equal(priorWrite.options.onlyIf.etagMatches,'bad-prior-version');
  const after=await readPreparedUsgsScene(f.env,{now:f.now,includePrior:true});
  assert.equal(after.source.receiptId,c.receiptId);assert.equal(after.prepared.content.features[0].record.mag,5);
  assert.equal(after.prior.source.receiptId,b.receiptId);assert.equal(after.prior.content.features[0].record.mag,4);
  assert.equal([...f.objects.keys()].filter(key=>key.startsWith('prepared/')).length,2);
  assert.ok(Object.values(PREPARED_USGS_KEYS).reduce((n,key)=>n+f.objects.get(key).byteLength,0)<=PREPARED_USGS_STORE_LIMITS.totalBytes);
});

test('owner-only current integrity repair keeps the same completed receipt and fails closed on I/O or missing ETag',async t=>{
  const f=await fixture(t),a=await f.acquire(3),value=JSON.parse(new TextDecoder().decode(f.objects.get(PREPARED_USGS_KEYS.current)));
  value.content.levels[0].cells[0].maximumMagnitude=9;
  f.objects.set(PREPARED_USGS_KEYS.current,UTF8.encode(pluginJson(value)));f.versions.set(PREPARED_USGS_KEYS.current,'bad-current-version');
  const cold={...f.env,EARTH_STORE:{...f.env.EARTH_STORE}};f.reset();
  assert.equal((await readPreparedUsgsScene(cold,{now:f.now})).available,false);
  assert.equal(f.activity.objects.some(row=>row.operation==='put'),false);
  const repaired=await ensurePreparedUsgsScene(cold,{now:f.now,readObservations:readPluginObservations});assert.equal(repaired.status,'prepared');
  assert.equal(f.activity.objects.find(row=>row.operation==='put'&&row.key===PREPARED_USGS_KEYS.current).options.onlyIf.etagMatches,'bad-current-version');
  const valid=await readPreparedUsgsScene(cold,{now:f.now});assert.equal(valid.available,true);assert.equal(valid.source.receiptId,a.receiptId);
  assert.equal(valid.prepared.content.levels[0].cells[0].maximumMagnitude,3);
  for(const missingVersion of [false,true]){
    let writes=0;const bucket={...f.env.EARTH_STORE,get:async key=>{
      if(key===PREPARED_USGS_KEYS.current){if(!missingVersion)throw TypeError('test real transport failure');
        const object=await f.env.EARTH_STORE.get(key);return {...object,etag:undefined};}return f.env.EARTH_STORE.get(key);},
      put:async()=>{writes++;throw Error('no write should be reached');}};
    const failed=await ensurePreparedUsgsScene({...f.env,EARTH_STORE:bucket},{now:f.now,readObservations:readPluginObservations});
    assert.equal(failed.status,'unavailable');assert.equal(writes,0);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM earth_plugin_captures').get().n,1);
});

test('authoritative final head reads do not reuse a bookmark replica after a newer completed receipt',async t=>{
  const f=await fixture(t),a=await f.acquire(3);f.advance(60001);let advanced=false,newReceipt=null;
  f.hook(({operation,key})=>{if(operation==='put'&&key===PREPARED_USGS_KEYS.current)throw Error('keep old derivative for head guard proof');});
  const db=f.env.EARTH_DB;let replicaResult=null,sessionCalls=0;
  const staleSession={prepare:sql=>({bind:(...values)=>({all:async()=>{
    if(sql.startsWith('SELECT c.*'))return replicaResult??=await db.prepare(sql).bind(...values).all();
    return db.prepare(sql).bind(...values).all();}})})};
  const readEnv={...f.env,EARTH_DB:{...db,withSession(){sessionCalls++;return staleSession;}}};
  f.sqlHook(async({phase,sql})=>{if(!advanced&&phase==='after'&&sql.startsWith('SELECT c.*')){
    advanced=true;newReceipt=(await f.acquire(4)).receiptId;}});
  const result=await readPreparedUsgsScene(readEnv,{now:f.now});
  assert.equal(advanced,true);assert.notEqual(newReceipt,a.receiptId);
  assert.equal(result.available,false);assert.equal(result.pending,true);assert.equal(result.source.receiptId,newReceipt);
  assert.equal(result.prepared,null);assert.equal(sessionCalls,0);
  assert.ok(f.activity.sql.filter(row=>row.sql.startsWith('SELECT c.*')).length>=3,'publication advance is detected by actual later primary statements');
});

test('zero-progress streamed storage is canceled before unbounded chunks or timer-only spinning',async t=>{
  const f=await fixture(t);await f.acquire(3);let pulls=0,canceled=false,writes=0;
  const bucket={...f.env.EARTH_STORE,get:async key=>key===PREPARED_USGS_KEYS.current?{etag:'empty-stream-version',size:16,
    body:new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(0));},cancel(){canceled=true;}})}:f.env.EARTH_STORE.get(key),
    put:async()=>{writes++;throw Error('public delivery must not repair');}};
  const result=await readPreparedUsgsScene({...f.env,EARTH_STORE:bucket},{now:f.now});
  assert.equal(result.available,false);assert.equal(result.errorCode,'prepared_object_limit');assert.equal(canceled,true);
  assert.ok(pulls<=2,'reader rejects the first zero-progress chunk rather than waiting for its deadline');assert.equal(writes,0);
});
