import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeUsgsLiveDay,validateUsgsLiveDayFacts,usgsLiveDayItems,USGS_LIVE_DAY } from './usgs-live-day.js';
import { pluginFactsDigest } from './plugin-evidence.js';
const NOW=Date.parse('2026-10-12T02:00:00.000Z'),UTF8=new TextEncoder();
const feature=(id,mag=4.6,type='earthquake')=>({type:'Feature',id,geometry:{type:'Point',coordinates:[4,50,12]},
  properties:{mag,time:NOW-60000,updated:NOW-1000,type,status:'reviewed',place:'TEST ONLY place',title:'TEST ONLY source title',url:`https://earthquake.usgs.gov/earthquakes/eventpage/${id}`}});
const body=(features=[feature('test1'),feature('test2',3.1,'quarry blast'),feature('small',1)],generated=NOW)=>({type:'FeatureCollection',
  metadata:{generated,count:features.length,status:200,url:USGS_LIVE_DAY.sourceUrl},features});
const decode=value=>decodeUsgsLiveDay(UTF8.encode(JSON.stringify(value)),{now:()=>NOW});

test('closed scientific cohort retains reported type/status/update and keeps non-earthquake seismic records distinct',async()=>{
  const decoded=decode(body());assert.equal(decoded.sourceFeatureCount,3);assert.equal(decoded.canonicalFacts.records.length,2);
  const blast=decoded.canonicalFacts.records.find(row=>row.usgsId==='test2');assert.equal(blast.eventType,'quarry blast');assert.equal(blast.updatedAt,NOW-1000);
  assert.equal(blast.reviewStatus,'reviewed');assert.equal(blast.time,NOW-60000);assert.equal(decoded.sourceGeneratedAt,new Date(NOW).toISOString());
  const items=await usgsLiveDayItems(decoded.canonicalFacts);assert.equal(items.length,1);assert.equal(items[0].kind,'rolling-observation-feed');assert.equal(items[0].publishedAt,null);
  assert.equal(items[0].sourceRevision,await pluginFactsDigest(decoded.canonicalFacts));
});
test('generation-only and below-threshold changes do not change qualifying facts; original source corrections do',async()=>{
  const a=decode(body()),b=decode(body([feature('test1'),feature('test2',3.1,'quarry blast'),feature('another-small',0)],NOW+1000));
  assert.notEqual(a.sourceGeneratedAt,b.sourceGeneratedAt);assert.equal(await pluginFactsDigest(a.canonicalFacts),await pluginFactsDigest(b.canonicalFacts));
  const changed=body();changed.features[0].properties.status='automatic';assert.notEqual(await pluginFactsDigest(a.canonicalFacts),await pluginFactsDigest(decode(changed).canonicalFacts));
  const missing=body();delete missing.features[0].properties.type;delete missing.features[0].properties.updated;
  const row=decode(missing).canonicalFacts.records.find(row=>row.usgsId==='test1');assert.equal(row.eventType,null);assert.equal(row.updatedAt,null);
});
test('incomplete scope, unstable identity, foreign source, impossible clocks and all caps fail closed without truncation',()=>{
  for(const change of [value=>{value.metadata.count++;},value=>{value.metadata.url='https://evil.test';},value=>{value.features[0].id=null;},
    value=>{value.features[1].id=value.features[0].id;},value=>{value.features[0].properties.url='https://evil.test';},
    value=>{value.features[0].geometry.coordinates=[4,50];},value=>{value.features[0].geometry.type=null;},value=>{delete value.features[0].properties.time;},
    value=>{value.features[0].properties.time=NOW-25*3600000;},value=>{value.features[0].properties.updated=NOW+300001;}]){
    const value=body();change(value);assert.throws(()=>decode(value),TypeError);
  }
  assert.throws(()=>decode(body(Array.from({length:501},(_,id)=>feature(`t${id}`)))),TypeError);
  const future=body([feature('future')],NOW+300000);future.features[0].properties.time=NOW+300000;
  future.features[0].properties.updated=NOW+300000;assert.equal(decode(future).canonicalFacts.records[0].time,NOW+300000);
  for(const key of ['time','updated']) {const value=structuredClone(future);value.features[0].properties[key]++;
    assert.throws(()=>decode(value),TypeError,'source clock tolerance cannot double the receiver clock tolerance');}
  assert.throws(()=>decodeUsgsLiveDay(new Uint8Array(512*1024+1)),TypeError);
  const facts=decode(body()).canonicalFacts;assert.throws(()=>validateUsgsLiveDayFacts({...facts,inferredClaims:[]}),TypeError);
  facts.records[0].arbitrary={claim:'not scientific evidence'};assert.throws(()=>validateUsgsLiveDayFacts(facts),TypeError);
});
