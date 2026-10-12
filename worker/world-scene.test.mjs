import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveMaintenanceFixture } from './archive-maintenance-fixture.mjs';
import { ARCHIVE_SCOPE, retainWorldArchiveRaw, publishWorldArchiveChunk } from './world-archive.js';
import { bootstrapArchiveDays } from './archive-bootstrap.js';
import { readWorldScene } from './world-scene.js';
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
