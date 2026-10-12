import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveMaintenanceFixture } from './archive-maintenance-fixture.mjs';
import { ARCHIVE_SCOPE, retainWorldArchiveRaw, publishWorldArchiveChunk } from './world-archive.js';
import { bootstrapArchiveDays } from './archive-bootstrap.js';
import { readWorldScene, createWorldSceneHandler } from './world-scene.js';
import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { usgsCatalogUrl } from '../server/hosted/usgs-catalog-interval.js';
import { normalizeWorldScene } from '../src/core/world-scene-controller.js';
const DAY=86400000, iso=(value)=>new Date(value).toISOString();
async function retainEmpty(f,range) {
  const body=JSON.stringify({type:'FeatureCollection',metadata:{count:0,status:200,generated:f.now(),url:usgsCatalogUrl('query',range).href},features:[]});
  const raw=await retainWorldArchiveRaw(f.env,{body});
  return publishWorldArchiveChunk(f.env,{schemaVersion:1,scopeId:ARCHIVE_SCOPE.id,kind:'interval',range,capturedAt:f.stamp(),expectedCount:0,records:[],rawSha256:raw.rawSha256},{now:f.now});
}

test('legacy and ready day coverage clip broad original interval proof to the loaded scene/calendar without narrowing advertised origins',async(t)=>{
  const f=await archiveMaintenanceFixture(t,{actualMigration:true});
  const origin={from:'2026-09-15T00:00:00.000Z',to:'2026-10-10T23:59:59.999Z'};
  const receipt=await retainEmpty(f,origin), at='2026-10-09T12:00:00.000Z';
  const calendar={from:'2026-10-01T06:00:00.000Z',to:'2026-10-03T07:00:00.000Z'};
  for(const ready of [false,true]) {
    if(ready)assert.equal((await bootstrapArchiveDays(f.env)).complete,true);
    const scene=await readWorldScene(f.env,{at},{now:f.now});
    const target={from:'2026-10-02T12:00:00.001Z',to:at};
    assert.deepEqual(scene.coverage.availableRange,origin);assert.deepEqual(scene.coverage.requestedRange,target);
    assert.deepEqual(scene.coverage.segments,[target]);assert.deepEqual(scene.coverage.gaps,[]);
    await normalizeWorldScene(scene,{at});
    const meta=await readWorldScene(f.env,{metadata:true,calendarFrom:calendar.from,calendarTo:calendar.to},{now:f.now});
    assert.deepEqual(meta.coverage.availableRange,origin);assert.deepEqual(meta.coverage.requestedRange,calendar);assert.deepEqual(meta.coverage.segments,[calendar]);
    await normalizeWorldScene(meta,{metadata:true});
    const earlier=await readWorldScene(f.env,{metadata:true,calendarFrom:calendar.from,calendarTo:calendar.to,knownAt:iso(Date.parse(receipt.publishedAt)-1)},{now:f.now});
    assert.deepEqual(earlier.coverage.segments,[]);assert.deepEqual(earlier.coverage.gaps,[{...calendar,status:'unavailable-at-cutoff'}]);
    assert.deepEqual(earlier.coverage.availableRange,origin);
  }
});

test('fragmented calendar byte overflow makes one latest-day stored read and returns its actual smaller window, including knowledge cutoffs',async(t)=>{
  const f=await archiveMaintenanceFixture(t,{actualMigration:true}), origin={from:'2026-10-01T00:00:00.000Z',to:'2026-10-08T23:59:59.999Z'};
  const receipt=await retainEmpty(f,origin);await bootstrapArchiveDays(f.env);
  // Synthetic fragmented first-proof index fixture; no source acquisition.
  const base=Date.parse(origin.from);
  for(let day=0;day<8;day++) {
    const start=base+day*DAY, pieces=Array.from({length:300},(_,index)=>({from:iso(start+index*2),to:iso(start+index*2),knownAt:receipt.publishedAt,chunkId:receipt.chunkId}));
    if(day===7)pieces.push({from:origin.to,to:origin.to,knownAt:receipt.publishedAt,chunkId:receipt.chunkId});
    f.sqlite.prepare('UPDATE earth_archive_coverage_days SET complete_known_at=NULL,first_proof_json=?,range_from=?,range_to=? WHERE day=?')
      .run(JSON.stringify(pieces),pieces[0].from,pieces.at(-1).to,iso(start).slice(0,10));
  }
  for(const knownAt of [undefined,receipt.publishedAt]) {
    f.activity.length=0;
    const result=await readWorldScene(f.env,{metadata:true,...(knownAt?{knownAt}:{})},{now:f.now});
    assert.equal(result.available,true);assert.equal(result.coverage.calendarFallback,'coverage-byte-budget');
    assert.deepEqual(result.coverage.availableRange,origin);
    assert.deepEqual(result.coverage.requestedRange,{from:'2026-10-08T00:00:00.000Z',to:origin.to});
    assert.deepEqual(result.coverage.initialRequestedRange,origin);assert.equal(result.complete,false);
    assert.equal(f.activity.filter(item=>/SELECT day,generation,first_proof_at/.test(item.sql)).length,2,'Only the original bounded calendar and one smaller fallback are attempted');
    assert.equal(f.activity.filter(item=>/SELECT d.day,d.first_proof_json/.test(item.sql)).length,1,'The overflowing read never loads its large proof arrays');
  }
});


test('an empty ready archive retains explicit null coverage metadata without failing the client protocol',async(t)=>{
  const f=await archiveMaintenanceFixture(t,{actualMigration:true});assert.equal((await bootstrapArchiveDays(f.env)).complete,true);
  const result=await readWorldScene(f.env,{metadata:true},{now:f.now});
  const normalized=await normalizeWorldScene(result,{metadata:true});
  assert.equal(normalized.available,true);assert.equal(normalized.coverage.availableRange,null);
  assert.equal(normalized.coverage.requestedRange,null);assert.deepEqual(normalized.coverage.segments,[]);assert.equal(normalized.complete,false);
});

const SCENE_AT='2025-06-01T12:00:00.000Z';
async function sceneRecords(f,count=300) {
  const at=Date.parse(SCENE_AT),range={from:iso(at-7*DAY),to:iso(at+7*DAY)};
  const features=Array.from({length:count},(_,index)=>({type:'Feature',id:`paged${index}`,properties:{type:'earthquake',
    time:at-DAY+index*1000,updated:at+1000,mag:5.2,status:'reviewed',title:`TEST ONLY earthquake \u00e9 \u{1F30D} ${index}`,
    url:`https://earthquake.usgs.gov/earthquakes/eventpage/paged${index}`},geometry:{type:'Point',coordinates:[4,50,12]}}));
  const raw=await retainWorldArchiveRaw(f.env,{body:JSON.stringify({type:'FeatureCollection',metadata:{count:features.length,status:200,
    generated:f.now(),url:usgsCatalogUrl('query',range).href},features})});
  const records=features.flatMap(feature=>normalizeUsgs({features:[feature]},f.stamp())).map(canonicalDiscoveryRecord);
  const published=await publishWorldArchiveChunk(f.env,{schemaVersion:1,scopeId:ARCHIVE_SCOPE.id,kind:'interval',range,
    capturedAt:f.stamp(),expectedCount:records.length,records,rawSha256:raw.rawSha256},{now:f.now});
  assert.equal(published.complete,true);return records;
}
const decodeCursor=token=>JSON.parse(atob(token.replace(/-/g,'+').replace(/_/g,'/')));

test('metadata advertises optional compact capacity while default and full-event selections remain100',async(t)=>{
  const f=await archiveMaintenanceFixture(t,{actualMigration:true});await sceneRecords(f);
  const metadata=await readWorldScene(f.env,{metadata:true},{now:f.now});assert.equal(metadata.delivery.pointsPageLimit,250);
  await normalizeWorldScene(metadata,{metadata:true});
  const query={at:SCENE_AT,points:true,span:'7d'};
  const legacy=await readWorldScene(f.env,query,{now:f.now});assert.equal(legacy.points.length,100);
  const first=await readWorldScene(f.env,{...query,limit:250},{now:f.now});assert.equal(first.points.length,250);
  assert.equal(first.counts.eligible,300);assert.equal(first.counts.omitted,50);
  const tail=decodeCursor(first.cursor);assert.equal(tail.itemId,first.points.at(-1).itemId);assert.equal(tail.eventAt,first.points.at(-1).originAt);
  const second=await readWorldScene(f.env,{...query,limit:250,cursor:first.cursor},{now:f.now});assert.equal(second.points.length,50);assert.equal(second.cursor,null);
  assert.equal(new Set([...first.points,...second.points].map(point=>point.id)).size,300);
  const events=await readWorldScene(f.env,{at:SCENE_AT},{now:f.now});assert.equal(events.events.length,100);
  const handle=createWorldSceneHandler({env:f.env,now:f.now}),base=`https://owned.test/api/world/scene?at=${SCENE_AT}`;
  for(const extra of ['&limit=101','&limit=250&knownMode=scene','&limit=251&points=1&span=7d','&points=1&span=7d&pointsByteLimit=1'])
    assert.equal((await handle(new Request(base+extra))).status,400,extra);
  assert.equal((await handle(new Request(base+'&points=1&span=7d&limit=250'))).status,200);
});

test('UTF8 byte-shortened compact pages resume after the last delivered row without missing evidence',async(t)=>{
  const f=await archiveMaintenanceFixture(t,{actualMigration:true});const records=await sceneRecords(f,90);
  const maximum=8000,query={at:SCENE_AT,points:true,span:'7d',limit:250},seen=new Set();let cursor,pages=0;
  const full=await readWorldScene(f.env,query,{now:f.now}),exactBytes=new TextEncoder().encode(JSON.stringify(full)).length;
  const exact=await readWorldScene(f.env,query,{now:f.now,pointsByteLimit:exactBytes});assert.equal(exact.points.length,90);assert.equal(exact.cursor,null);
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).length,exactBytes,'The final cursor-free prefix is admissible even if its predecessor with a cursor was larger');
  const shorter=await readWorldScene(f.env,query,{now:f.now,pointsByteLimit:exactBytes-1});assert.ok(shorter.points.length<90);assert.ok(shorter.cursor);
  do {
    const result=await readWorldScene(f.env,{...query,...(cursor?{cursor}:{})},{now:f.now,pointsByteLimit:maximum});pages++;
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=maximum);
    assert.ok(result.points.length>0&&result.points.length<90);assert.equal(result.counts.eligible,90);assert.equal(result.membershipComplete,true);
    for(const point of result.points){assert.equal(seen.has(point.id),false);seen.add(point.id);}
    cursor=result.cursor;
    if(cursor){const tail=decodeCursor(cursor);assert.equal(tail.itemId,result.points.at(-1).itemId);assert.equal(tail.eventAt,result.points.at(-1).originAt);assert.equal(tail.version,result.version);}
    assert.ok(pages<20,'Bounded continuation must make progress');
  }while(cursor);
  assert.equal(seen.size,records.length);assert.ok(pages>1);
  await assert.rejects(readWorldScene(f.env,query,{now:f.now,pointsByteLimit:1}),/metadata and one record cannot fit/);
  const response=await createWorldSceneHandler({env:f.env,now:f.now,pointsByteLimit:1})(new Request(`https://owned.test/api/world/scene?at=${SCENE_AT}&points=1&span=7d&limit=250`));
  assert.equal(response.status,503);const failure=await response.json();assert.equal(failure.available,false);assert.equal(failure.errorCode,'scene-delivery-byte-budget');
  await assert.rejects(normalizeWorldScene(failure,{at:SCENE_AT,buffered:true}),/delivery budget/);
});
