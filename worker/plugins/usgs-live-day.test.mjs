import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUsgsLiveDay,USGS_LIVE_DAY_PLUGIN } from './usgs-live-day.js';
const NOW=Date.parse('2026-10-12T02:00:00.000Z');
const payload=()=>({type:'FeatureCollection',metadata:{generated:NOW,count:1,status:200,url:USGS_LIVE_DAY_PLUGIN.sourceUrl},
  features:[{type:'Feature',id:'test1',geometry:{type:'Point',coordinates:[4,50,12]},properties:{mag:3,time:NOW-1000,updated:NOW,type:'earthquake',status:'automatic',url:'https://earthquake.usgs.gov/earthquakes/eventpage/test1'}}]});
test('fixed bounded acquisition uses original bytes and conditional Last-Modified with truthful304 clocks',async()=>{
  let sent;const raw=new TextEncoder().encode(JSON.stringify(payload()));
  const first=await collectUsgsLiveDay({now:()=>NOW,fetchImpl:async(url,options)=>{assert.equal(url,USGS_LIVE_DAY_PLUGIN.sourceUrl);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    return new Response(raw,{headers:{'content-type':'application/json','last-modified':new Date(NOW).toUTCString()}});}});
  assert.deepEqual(first.raw.bytes,raw);assert.equal(first.canonicalFacts.records[0].eventType,'earthquake');
  const checked=await collectUsgsLiveDay({now:()=>NOW+60000,previous:{validators:first.validators,factsDigest:first.factsDigest},
    fetchImpl:async(url,options)=>{sent=options.headers;return new Response(null,{status:304});}});
  assert.equal(sent['If-Modified-Since'],new Date(NOW).toUTCString());assert.equal(checked.factsDigest,first.factsDigest);assert.equal(checked.raw,null);
  assert.equal(checked.checkedAt,new Date(NOW+60000).toISOString());assert.equal(checked.sourceUpdatedAt,null);
});
test('over-limit bodies, unsolicited304, old provider generation, wrong media and cancellation cannot admit a feed',async()=>{
  for(const response of [()=>new Response(new Uint8Array(512*1024+1),{headers:{'content-type':'application/json'}}),
    ()=>new Response(null,{status:304}),()=>new Response('{}',{headers:{'content-type':'text/html'}})])
    await assert.rejects(collectUsgsLiveDay({now:()=>NOW,fetchImpl:async()=>response()}));
  await assert.rejects(collectUsgsLiveDay({now:()=>NOW,previous:{sourceUpdatedAt:new Date(NOW+1).toISOString()},
    fetchImpl:async()=>Response.json(payload())}),/predates/);
  const stop=new AbortController();stop.abort();let calls=0;
  await assert.rejects(collectUsgsLiveDay({signal:stop.signal,fetchImpl:async()=>{calls++;return Response.json(payload());}}));assert.equal(calls,0);
});
