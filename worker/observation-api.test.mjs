import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationApiHandler,USGS_OBSERVATION_PATH } from './observation-api.js';
import { runSourcePlugin } from './plugins/store.js';
import { USGS_LIVE_DAY_PLUGIN,collectUsgsLiveDay,usgsLiveDayItems } from './plugins/usgs-live-day.js';
import { documentFixture } from './document-investigation-fixture.mjs';

test('stored scientific GET is fixed, bounded and historical with no public acquisition or writes',async t=>{
  const f=await documentFixture(t),plugin={...USGS_LIVE_DAY_PLUGIN,collect:collectUsgsLiveDay,items:usgsLiveDayItems};
  const acquired=await runSourcePlugin(f.env,plugin,{now:f.now,fetchImpl:async()=>Response.json({type:'FeatureCollection',metadata:{generated:f.now(),count:1,status:200,url:plugin.sourceUrl},
    features:[{type:'Feature',id:'testapi',geometry:{type:'Point',coordinates:[4,50,12]},properties:{mag:3,time:f.now()-1000,updated:f.now(),type:'quarry blast',status:'reviewed',
      url:'https://earthquake.usgs.gov/earthquakes/eventpage/testapi'}}]})});assert.equal(acquired.status,'stored');
  const handler=createObservationApiHandler({now:f.now}),base='https://test.invalid'+USGS_OBSERVATION_PATH;
  f.reset();const response=await handler(new Request(base),f.env),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.records[0].eventType,'quarry blast');assert.equal(data.scope.minimumMagnitude,2.5);assert.equal(data.coverage.complete,true);
  assert.equal(f.activity.providers.length,0);assert.equal(f.activity.sql.filter(row=>row.write).length,0);assert.equal(f.activity.objects.filter(row=>row.operation==='put').length,0);
  const before=new Date(f.now()-1).toISOString(),past=await handler(new Request(base+'?knownAt='+encodeURIComponent(before)),f.env);
  assert.equal(past.status,200);assert.equal((await past.json()).available,false);
  for(const query of ['?source=https://evil.test','?knownAt=bad','?knownAt='+before+'&knownAt='+before])assert.equal((await handler(new Request(base+query),f.env)).status,400);
  assert.equal((await handler(new Request(base,{method:'POST'}),f.env)).status,405);
  assert.equal((await handler(new Request(base),{})).status,503);assert.equal(await handler(new Request('https://test.invalid/not-source'),f.env),null);
});
test('read cancellation and response budget cannot expose unbounded stored data',async()=>{
  let calls=0;const stop=new AbortController();stop.abort();const url='https://test.invalid'+USGS_OBSERVATION_PATH;
  const handler=createObservationApiHandler({read:async()=>{calls++;return {configured:true,available:true,records:['a'.repeat(160*1024)]};}});
  assert.equal((await handler(new Request(url,{signal:stop.signal}),{})).status,503);assert.equal(calls,0);
  assert.equal((await handler(new Request(url),{})).status,503);
  let signal;const pending=createObservationApiHandler({deadlineMs:10,read:async(env,options)=>{signal=options.signal;return new Promise(()=>{});}});
  assert.equal((await pending(new Request(url),{})).status,503);assert.equal(signal.aborted,true);
});
