import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { worldRevision } from '../src/core/world-model.js';
import { appendHistorySnapshot } from './history.js';
import { projectWorldCollection } from './world-model.js';
import { ARCHIVE_SCOPE, ARCHIVE_LIMITS, retainWorldArchiveRaw, publishWorldArchiveChunk, readWorldArchiveChunk, createWorldArchiveCandidate } from './world-archive.js';
import { readWorldScene, createWorldSceneHandler } from './world-scene.js';

const CLOCK=Date.parse('2026-10-12T02:00:00.000Z'),AT='2025-06-01T12:00:00.000Z',DAY=86400000,WEEK=7*DAY;
const stamp=(offset=0)=>new Date(CLOCK+offset).toISOString(),hist=(offset=0)=>new Date(Date.parse(AT)+offset).toISOString();
const feature=(id='test001',changes={})=>({type:'Feature',id,properties:{type:'earthquake',time:Date.parse(AT)-3600000,
  updated:Date.parse(AT)+3600000,mag:5.2,status:'reviewed',title:`TEST ONLY earthquake ${id}`,
  url:`https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,ids:`,${id},TEST_ALIAS,`,...changes},
  geometry:{type:'Point',coordinates:[changes.lon??4,changes.lat??50,12.3]}});
function bucket() {
  const records=new Map();let serial=0;
  return {records,puts:0,gets:0,async get(key) {
    this.gets++;const value=records.get(key);return value?{etag:value.etag,size:new TextEncoder().encode(value.body).byteLength,
      text:async()=>value.body,json:async()=>JSON.parse(value.body)}:null;
  },async put(key,body,options={}) {
    this.puts++;const old=records.get(key);
    if(options.onlyIf?.get?.('if-none-match')==='*'&&old)return null;
    const value={body:String(body),etag:String(++serial)};records.set(key,value);return value;
  }};
}
async function fixture(t,migrated=true) {
  let clock=CLOCK,dbClock;const now=()=>clock,sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.function('strftime',{varargs:true},(format,value,modifier)=>{
    assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(value,'now');
    assert.ok(modifier===undefined||modifier==='+305 seconds');
    return new Date((dbClock??clock)+(modifier?305000:0)).toISOString();
  });
  for(const filename of ['0000_glossy_overlord.sql','0001_collection_revision.sql','0002_aircraft_observations.sql','0003_world_evidence.sql',
    ...(migrated?['0004_world_archive_investigations.sql']:[])])sqlite.exec(await readFile(new URL(`../drizzle/${filename}`,import.meta.url),'utf8'));
  const counters={statements:0,batches:0,maxJsonBytes:0,maxBindings:0,plans:[]};
  const db={sqlite,counters,beforeBatch:null,withSession(mode){assert.equal(mode,'first-primary');return this;},prepare(sql){
    const bind=(...values)=>{
      assert.ok(values.length<=100);counters.maxBindings=Math.max(counters.maxBindings,values.length);
      for(const value of values)if(typeof value==='string'&&value.startsWith('[')){
        const bytes=new TextEncoder().encode(value).byteLength;counters.maxJsonBytes=Math.max(counters.maxJsonBytes,bytes);
        assert.ok(bytes<=ARCHIVE_LIMITS.sqlBytes);
      }
      return {sql,values,async all(){counters.statements++;counters.plans.push(...sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values));
        return {success:true,results:sqlite.prepare(sql).all(...values)};},async first(){counters.statements++;return sqlite.prepare(sql).get(...values)||null;},async run(){counters.statements++;
        const result=sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};}};
    };return {...bind(),bind};
  },async batch(statements){counters.batches++;assert.ok(statements.length<=25);await db.beforeBatch?.(statements);sqlite.exec('BEGIN');
    try{const values=[];for(const statement of statements)values.push(/^\s*(SELECT|WITH)/.test(statement.sql)?await statement.all():await statement.run());
      sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={EARTH_DB:db,EARTH_STORE:bucket()};
  return {env,now,sqlite,counters,setClock(offset){clock=CLOCK+offset;},setDbClock(offset){dbClock=CLOCK+offset;},
    count(table){return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;},
    async input(features=[feature()],{offset=0,kind='interval',range={from:hist(-WEEK),to:AT}}={}){
      const capturedAt=stamp(offset),query=new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
      for(const [key,value]of Object.entries({format:'geojson',eventtype:'earthquake',minmagnitude:'4.5',orderby:'time-asc',limit:'501',
        starttime:range.from,endtime:range.to}))query.searchParams.set(key,value);
      const raw={type:'FeatureCollection',metadata:{count:features.length,generated:CLOCK+offset,url:query.href,status:200},features};
      const retained=await retainWorldArchiveRaw(env,{body:JSON.stringify(raw)});
      return {schemaVersion:1,scopeId:ARCHIVE_SCOPE.id,capturedAt,kind,range,expectedCount:features.length,rawSha256:retained.rawSha256,
        records:features.flatMap((f)=>normalizeUsgs({features:[f]},capturedAt)).map(canonicalDiscoveryRecord)};
    },async publish(features,options){const input=await this.input(features,options);return {input,result:await publishWorldArchiveChunk(env,input,{now})};},
    async scene(query={}){return readWorldScene(env,{at:AT,...query},{now});}};
}

test('one complete historical interval retains attributable evidence and never advances live source or packet pointers',async(t)=>{
  const f=await fixture(t),{input,result}=await f.publish();assert.equal(result.stored,true);assert.equal(result.complete,true);
  for(const table of ['earth_observations','earth_world_sources','earth_world_captures','earth_world_observations','earth_collection_revision'])assert.equal(f.count(table),0,table);
  assert.equal([...f.env.EARTH_STORE.records.keys()].some((key)=>/prepared|manifest|catalog/.test(key)),false);
  const scene=await f.scene();assert.equal(scene.events.length,1);assert.equal(scene.events[0].eventTime.at,hist(-3600000));
  assert.equal(scene.events[0].sourceTimes.updatedAt,hist(3600000));assert.equal(scene.events[0].knowledge.firstRecordedAt,stamp());
  assert.equal(scene.events[0].archive.publishedAt,stamp());assert.equal(scene.coverage.complete,true);
  assert.equal(scene.coverage.availableRange.from,hist(-WEEK));assert.equal(scene.counts.eligible,1);
  const detail=await f.scene({id:scene.events[0].id});assert.equal(detail.event.id,scene.events[0].id);
  const raw=JSON.parse(f.env.EARTH_STORE.records.get(`archive/raw/usgs/${input.rawSha256}.json`).body);
  assert.equal(raw.features[0].geometry.coordinates[2],12.3);assert.match(raw.features[0].properties.ids,/TEST_ALIAS/);
  const receipt=await readWorldArchiveChunk(f.env,{chunkId:result.chunkId});assert.equal(receipt.range.from,hist(-WEEK));assert.equal(receipt.stored,true);
});

test('archive imported today reconstructs earlier origin dates but cannot backdate hosted knowledge',async(t)=>{
  const f=await fixture(t);await f.publish();
  const earlier=await f.scene({knownMode:'scene'});assert.equal(earlier.events.length,0);assert.equal(earlier.coverage.status,'unavailable-at-cutoff');
  assert.equal(earlier.coverage.availableRange.from,hist(-WEEK));assert.equal(earlier.coverage.complete,false);
  const fixed=await f.scene({knownAt:stamp()});assert.equal(fixed.events.length,1);assert.equal(fixed.mode,'as-known');
  const metadata=await readWorldScene(f.env,{metadata:true},{now:f.now});assert.equal(metadata.at,null);assert.equal(metadata.coverage.availableRange.to,AT);
  const oldMeta=await readWorldScene(f.env,{metadata:true,knownAt:hist()},{now:f.now});
  assert.deepEqual(oldMeta.coverage.availableRange,metadata.coverage.availableRange);assert.equal(oldMeta.coverage.status,'unavailable-at-cutoff');
});

test('retry preserves receipt publication and reused immutable revision dates, including prior live retention',async(t)=>{
  const f=await fixture(t),input=await f.input();
  const live=await appendHistorySnapshot(f.env,{source:'usgs',at:stamp(),records:input.records},{now:f.now});
  await projectWorldCollection(f.env,{packet:{schemaVersion:1,collectedAt:stamp(),payload:{indexRecords:input.records}},snapshots:[live]},{now:f.now});
  const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM earth_world_sources').all());
  f.setClock(1000);const first=await publishWorldArchiveChunk(f.env,input,{now:f.now});f.setClock(61000);
  const second=await publishWorldArchiveChunk(f.env,input,{now:f.now});assert.equal(second.reused,true);assert.equal(second.publishedAt,first.publishedAt);
  assert.equal(f.count('earth_world_revisions'),1);assert.equal(f.count('earth_archive_chunks'),1);
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM earth_world_sources').all()),before);
  const event=(await f.scene()).events[0];assert.equal(event.knowledge.firstRecordedAt,stamp());assert.equal(event.archive.publishedAt,stamp(1000));
  assert.equal((await f.scene({id:event.id})).event.id,event.id);
  const laterInput={...input,capturedAt:stamp(61000),records:input.records.map((record)=>({...record,retrievedAt:stamp(61000)}))};
  assert.equal((await createWorldArchiveCandidate(input,{now:f.now})).chunkId,(await createWorldArchiveCandidate(laterInput,{now:f.now})).chunkId);
  assert.equal((await publishWorldArchiveChunk(f.env,laterInput,{now:f.now})).publishedAt,first.publishedAt);
});

test('provider updated time selects revisions before origin, geometry and magnitude filters; obsolete imports never regress heads',async(t)=>{
  const f=await fixture(t);await f.publish();const first=(await f.scene()).events[0];f.setClock(1000);
  await f.publish([feature(undefined,{time:Date.parse(hist(-9*DAY)),updated:Date.parse(hist(2*3600000)),lat:60,lon:30})],{offset:1000,kind:'correction'});
  assert.equal((await f.scene()).events.length,0);assert.equal((await f.scene({knownAt:stamp()})).events[0].id,first.id);
  assert.equal((await f.scene({knownAt:stamp(1000)})).events.length,0);
  assert.equal((await f.scene({at:hist(-8*DAY),bbox:'0,40,10,55'})).events.length,0);
  assert.equal((await f.scene({at:hist(-8*DAY),bbox:'20,55,40,70'})).events[0].id,first.id);
  f.setClock(2000);await f.publish([feature()],{offset:2000});assert.equal((await f.scene()).events.length,0);
  f.setClock(3000);await f.publish([feature(undefined,{updated:Date.parse(hist(3*3600000)),mag:4.1})],{offset:3000,kind:'correction'});
  assert.equal((await f.scene()).events.length,0);assert.equal((await f.scene({knownAt:stamp()})).events.length,1);
  assert.equal(f.count('earth_archive_coverage'),2,'correction chunks do not assert interval coverage');
});

test('equal-date differing facts remain cited conflicts and preserve the first committed selection even at equal SQL clocks',async(t)=>{
  const f=await fixture(t);await f.publish();await f.publish([feature(undefined,{mag:5.7})],{kind:'correction'});
  const scene=await f.scene();assert.equal(scene.events[0].reportedFacts.magnitude,5.2);assert.equal(scene.events[0].archive.conflictCount,1);
  assert.equal((await f.scene({knownAt:stamp()})).events[0].reportedFacts.magnitude,5.2);
  const detail=await f.scene({id:scene.events[0].id});assert.equal(detail.event.archive.conflicts.length,1);
  assert.notEqual(detail.event.archive.conflicts[0].revision,scene.events[0].evidence.revision);assert.equal(detail.event.archive.conflictsOmitted,0);
  assert.equal(f.count('earth_world_revisions'),2);assert.equal(f.count('earth_archive_chunks'),2);
});

test('failed bounded item writes remain invisible; retry preserves first retained facts but publication uses its later SQL clock',async(t)=>{
  const f=await fixture(t),features=Array.from({length:500},(_,n)=>feature(`rich${n}`,{time:Date.parse(AT)-n*1000,title:`TEST ONLY ${n} ${'x'.repeat(220)}`}));
  const input=await f.input(features);let groups=0;f.env.EARTH_DB.beforeBatch=async(statements)=>{
    if(statements.some((statement)=>/INSERT INTO earth_archive_membership/.test(statement.sql))&&++groups===2)throw new Error('TEST ONLY injected storage failure');
  };
  await assert.rejects(publishWorldArchiveChunk(f.env,input,{now:f.now}),/injected/);
  assert.ok(f.count('earth_world_revisions')>0);assert.equal(f.count('earth_archive_chunks'),0);assert.equal(f.count('earth_archive_heads'),0);
  assert.equal((await f.scene()).events.length,0);assert.equal((await f.scene()).coverage.status,'not-imported');
  f.env.EARTH_DB.beforeBatch=null;f.setClock(60000);const result=await publishWorldArchiveChunk(f.env,input,{now:f.now});assert.equal(result.stored,true);
  const scene=await f.scene();assert.equal(scene.counts.eligible,500);assert.equal(scene.events.length,100);assert.equal(scene.coverage.complete,true);
  assert.ok(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_world_revisions WHERE first_recorded_at=?').get(stamp()).n>0);
  const early=f.sqlite.prepare('SELECT event_id FROM earth_world_revisions WHERE first_recorded_at=? LIMIT 1').get(stamp());
  assert.equal((await f.scene({id:early.event_id})).event.knowledge.firstRecordedAt,stamp());
  assert.equal(scene.events.every((event)=>event.archive.publishedAt===stamp(60000)),true);
  assert.equal((await f.scene({knownAt:stamp()})).events.length,0);
});

test('maximum rich 500-record publication uses bounded JSON1 work and scene reads use origin/item indexes',async(t)=>{
  const f=await fixture(t),features=Array.from({length:500},(_,n)=>feature(`maximum${n}`,{time:Date.parse(AT)-n*1000,
    title:`TEST ONLY ${n} ${'x'.repeat(220)}`,lat:((n%170)-85),lon:((n%350)-175)}));
  const before=f.counters.statements,{input,result}=await f.publish(features);const writes=f.counters.statements-before;
  assert.equal(result.recordCount,500);assert.ok(writes<=30,`500 records need ${writes} statements`);assert.ok(f.counters.maxJsonBytes<=ARCHIVE_LIMITS.sqlBytes);
  const body=JSON.parse(f.env.EARTH_STORE.records.get(`history/snapshots/usgs/${result.snapshotId}.json`).body);
  assert.equal(body.records.length,500);assert.equal(body.records.filter((record)=>Number.isFinite(record.lat)&&Number.isFinite(record.lon)).length,500);
  assert.equal(body.coordinates.length,0,'record geometry is complete; redundant live coordinate-array protocol is not expanded');
  const beforeRead=f.counters.statements,scene=await f.scene();assert.ok(f.counters.statements-beforeRead<=6);
  assert.equal(scene.counts.eligible,500);assert.equal(scene.counts.omitted,400);assert.ok(scene.cursor);
  assert.ok(f.counters.plans.some((plan)=>/earth_archive_heads_scope_event/.test(plan.detail)&&/SEARCH/.test(plan.detail)));
  await f.scene({knownAt:stamp()});assert.ok(f.counters.plans.some((plan)=>/earth_archive_membership_scope_event/.test(plan.detail)&&/SEARCH/.test(plan.detail)));
  assert.ok(f.counters.plans.some((plan)=>/earth_archive_membership_scope_item_update/.test(plan.detail)));
  assert.equal(input.records.length,500);
  t.diagnostic(`500 rich records: ${writes} D1 statements, maximum SQL JSON ${f.counters.maxJsonBytes} bytes; scene read ${f.counters.statements-beforeRead} statements including both lenses.`);
});

test('keyset pages are exact and cursor reuse is rejected after changing time, lens, scope or archive version',async(t)=>{
  const f=await fixture(t);await f.publish(Array.from({length:5},(_,n)=>feature(`page${n}`,{time:Date.parse(AT)-n*1000})));
  const first=await f.scene({limit:2}),second=await f.scene({limit:2,cursor:first.cursor}),third=await f.scene({limit:2,cursor:second.cursor});
  assert.equal(new Set([...first.events,...second.events,...third.events].map((event)=>event.id)).size,5);assert.equal(third.cursor,null);
  assert.equal(first.counts.eligible,5);await assert.rejects(f.scene({at:hist(1000),cursor:first.cursor}),TypeError);
  await assert.rejects(f.scene({knownAt:stamp(),cursor:first.cursor}),TypeError);
  f.setClock(1000);await f.publish([feature('extra')],{offset:1000});await assert.rejects(f.scene({cursor:first.cursor}),TypeError);
});

test('verified scene interval is half-open across entry and exact seven-day expiry; advancing knowledge also stops at publication',async(t)=>{
  const f=await fixture(t);await f.publish([feature('old',{time:Date.parse(hist(-WEEK+1000))}),feature('next',{time:Date.parse(hist(2000))})],
    {range:{from:hist(-WEEK),to:hist(3000)}});
  const scene=await f.scene();assert.equal(scene.events.length,1);assert.equal(scene.validTo,hist(1000));assert.equal(scene.nextSceneChangeAt,hist(1000));
  assert.equal((await f.scene({at:hist(999)})).events.length,1);assert.equal((await f.scene({at:hist(1000)})).events.length,0);
  assert.equal((await f.scene({at:hist(2000)})).events.length,1);
  f.setClock(60000);await f.publish([feature('later',{time:CLOCK-1000,updated:CLOCK-1000})],{offset:60000,range:{from:stamp(-WEEK),to:stamp()}});
  const atPublication=await f.scene({at:stamp(),knownMode:'scene'});assert.equal(atPublication.validTo,stamp(60000));
  const fixed=await f.scene({at:stamp(),knownAt:stamp()});assert.ok(fixed.validTo>stamp(60000));
});

test('coverage keeps real gaps and complete empty intervals; absence never deletes existing scoped heads',async(t)=>{
  const f=await fixture(t);await f.publish([],{range:{from:hist(-WEEK),to:hist(-DAY)}});
  const partial=await f.scene();assert.equal(partial.events.length,0);assert.equal(partial.coverage.complete,false);assert.equal(partial.coverage.gaps.length,1);
  assert.equal(partial.coverage.gaps[0].from,hist(-DAY+1));
  f.setClock(1000);await f.publish([],{offset:1000,range:{from:hist(-DAY),to:AT}});assert.equal((await f.scene()).coverage.complete,true);
  f.setClock(2000);await f.publish([feature()],{offset:2000});f.setClock(3000);await f.publish([],{offset:3000});assert.equal((await f.scene()).events.length,1);
});

test('publication SQL clock rejects a future capture even if importer clock admitted it',async(t)=>{
  const f=await fixture(t);f.setClock(600000);f.setDbClock(0);const input=await f.input(undefined,{offset:600000});
  await assert.rejects(publishWorldArchiveChunk(f.env,input,{now:f.now}),/complete receipt/);
  assert.equal(f.count('earth_archive_chunks'),0);assert.equal(f.count('earth_archive_heads'),0);assert.equal(f.count('earth_archive_coverage'),0);
});

test('public scene handler validates bounded queries and verifies original detail evidence without any provider requests',async(t)=>{
  const f=await fixture(t),{input}=await f.publish(),handle=createWorldSceneHandler({env:f.env,now:f.now});
  const base=`https://owned.example/api/world/scene?at=${AT}`;
  for(const extra of ['&scope=arbitrary','&knownMode=fixed','&window=year','&limit=101','&at=2025-06-01T12:00:00Z','&bbox=0,90,4,-90','&url=https://bad.example'])
    assert.equal((await handle(new Request(base+extra))).status,400,extra);
  assert.equal((await handle(new Request(base,{method:'POST'}))).status,405);assert.equal(await handle(new Request('https://owned.example/elsewhere')),null);
  const valid=await handle(new Request(base));assert.equal(valid.status,200);const event=(await valid.json()).events[0];
  const key=`archive/raw/usgs/${input.rawSha256}.json`,saved=f.env.EARTH_STORE.records.get(key);saved.body=saved.body.replace('5.2','5.9');
  const detail=await handle(new Request(`https://owned.example/api/world/scene/events/${event.id}?at=${AT}`));assert.equal(detail.status,503);
});

test('missing migration is unavailable rather than stored success; mismatched evidence/counts never publish coverage',async(t)=>{
  const noMigration=await fixture(t,false),input=await noMigration.input();
  assert.equal((await publishWorldArchiveChunk(noMigration.env,input,{now:noMigration.now})).configured,false);
  assert.equal((await createWorldSceneHandler({env:noMigration.env,now:noMigration.now})(new Request(`https://owned.example/api/world/scene?at=${AT}`))).status,503);
  const f=await fixture(t),good=await f.input();
  await assert.rejects(publishWorldArchiveChunk(f.env,{...good,expectedCount:2},{now:f.now}),TypeError);
  await assert.rejects(publishWorldArchiveChunk(f.env,{...good,records:good.records.map((record)=>({...record,magnitude:5.9}))},{now:f.now}),/disagree/);
  assert.equal(f.count('earth_archive_chunks'),0);assert.equal(f.count('earth_archive_coverage'),0);
});

test('catalog GeoJSON without summary-feed metadata.count retains exact bytes and requires independent complete interval count',async(t)=>{
  const f=await fixture(t),input=await f.input();
  const old=f.env.EARTH_STORE.records.get(`archive/raw/usgs/${input.rawSha256}.json`),raw=JSON.parse(old.body);delete raw.metadata.count;
  raw.metadata.limit=501;raw.metadata.offset=1;
  const original=JSON.stringify(raw,null,2),retained=await retainWorldArchiveRaw(f.env,{body:original});
  const good={...input,rawSha256:retained.rawSha256};
  assert.equal((await publishWorldArchiveChunk(f.env,good,{now:f.now})).complete,true);
  assert.equal(f.env.EARTH_STORE.records.get(`archive/raw/usgs/${retained.rawSha256}.json`).body,original);
  for(const changed of ['offset=2','minlatitude=49','minmagnitude=5']){
    const invalid=structuredClone(raw),url=new URL(invalid.metadata.url),[key,value]=changed.split('=');url.searchParams.set(key,value);invalid.metadata.url=url.href;
    const rejected=await retainWorldArchiveRaw(f.env,{body:JSON.stringify(invalid)});
    await assert.rejects(publishWorldArchiveChunk(f.env,{...good,rawSha256:rejected.rawSha256},{now:f.now}),TypeError);
  }
});

test('undated provider revisions do not override dated evidence; dateline bounds are evaluated on selected geometry',async(t)=>{
  const f=await fixture(t);await f.publish([feature('date',{updated:null,lon:179}),feature('other',{lon:-179})]);
  assert.equal((await f.scene({bbox:'170,40,-170,60'})).events.length,2);
  assert.equal((await f.scene({bbox:'-170,40,170,60'})).events.length,0);
  f.setClock(1000);await f.publish([feature('date',{updated:Date.parse(hist(3600000)),lon:2})],{offset:1000,kind:'correction'});
  f.setClock(2000);await f.publish([feature('date',{updated:null,lon:178,mag:5.8})],{offset:2000,kind:'correction'});
  const scene=await f.scene({bbox:'170,40,-170,60'});assert.equal(scene.events.length,1);assert.equal(scene.events[0].evidence.sourceRecordId,'usgs:other');
  assert.equal((await f.scene({knownAt:stamp(),bbox:'170,40,-170,60'})).events.length,2);
});

test('archive receipt, coverage and head promotion are atomic, and late older publication cannot replace a concurrent newer provider revision',async(t)=>{
  const f=await fixture(t),old=await f.input(),newer=await f.input([feature(undefined,{updated:Date.parse(hist(7200000)),mag:5.8})],{offset:1000,kind:'correction'});
  f.setClock(1000);let promoted=false;
  f.env.EARTH_DB.beforeBatch=async(statements)=>{
    if(!promoted&&statements.some((statement)=>/INSERT INTO earth_archive_chunks/.test(statement.sql))){
      promoted=true;f.env.EARTH_DB.beforeBatch=null;await publishWorldArchiveChunk(f.env,newer,{now:f.now});
    }
  };
  await publishWorldArchiveChunk(f.env,old,{now:f.now});const scene=await f.scene();
  assert.equal(scene.events[0].reportedFacts.magnitude,5.8);assert.equal(f.count('earth_archive_chunks'),2);
  const failed=await f.input([feature('failed')],{offset:2000});f.setClock(2000);
  f.env.EARTH_DB.beforeBatch=async(statements)=>{if(statements.some((statement)=>/INSERT INTO earth_archive_chunks/.test(statement.sql)))throw new Error('TEST ONLY receipt failure');};
  await assert.rejects(publishWorldArchiveChunk(f.env,failed,{now:f.now}),/receipt failure/);
  assert.equal(f.count('earth_archive_chunks'),2);assert.equal((await f.scene()).events.length,1);
});

test('historical knowledge coverage distinguishes never imported gaps from intervals imported after that cutoff',async(t)=>{
  const f=await fixture(t);await f.publish([],{range:{from:hist(-WEEK),to:hist(-3*DAY)}});
  f.setClock(1000);await f.publish([],{offset:1000,range:{from:hist(-2*DAY),to:AT}});
  const scene=await f.scene({knownAt:stamp()});assert.equal(scene.coverage.status,'partial');
  assert.equal(scene.coverage.gaps.length,2);assert.equal(scene.coverage.gaps[0].status,'not-imported');
  assert.equal(scene.coverage.gaps[1].status,'unavailable-at-cutoff');assert.equal(scene.coverage.gaps[1].from,hist(-2*DAY));
  assert.equal((await f.scene({at:hist(2*DAY),knownAt:hist()})).coverage.gaps.at(-1).status,'not-imported');
});

test('buffered reconstruction supplies minimal points for every instant in a seven-day span, including entry/expiry seams',async(t)=>{
  const f=await fixture(t);await f.publish([
    feature('excluded',{time:Date.parse(hist(-WEEK))}),feature('expires',{time:Date.parse(hist(-WEEK+1000))}),
    feature('current',{time:Date.parse(AT)}),feature('later',{time:Date.parse(hist(DAY))}),
    feature('seam',{time:Date.parse(hist(WEEK))}),feature('outside',{time:Date.parse(hist(WEEK+1))}),
  ],{range:{from:hist(-WEEK),to:hist(WEEK+DAY)}});
  const buffered=await f.scene({points:true,span:'7d'});assert.equal(buffered.events.length,0);assert.equal(buffered.points.length,4);
  assert.equal(buffered.bufferFrom,AT);assert.equal(buffered.bufferTo,hist(WEEK));assert.equal(buffered.validTo,hist(WEEK));
  assert.equal(buffered.coverage.requestedRange.from,hist(-WEEK+1));assert.equal(buffered.coverage.requestedRange.to,hist(WEEK));
  assert.equal(buffered.counts.eligible,4);assert.equal(buffered.complete,true);
  assert.equal(buffered.points.every((point)=>point.sourceRecordId&&point.itemId&&point.revision&&point.snapshotId&&!point.knowledge&&!point.sourceTimes),true);
  for(const offset of [0,999,1000,DAY-1,DAY,3*DAY,WEEK-1]){
    const local=buffered.points.filter((point)=>Date.parse(point.originAt)>Date.parse(AT)+offset-WEEK&&Date.parse(point.originAt)<=Date.parse(AT)+offset).map((p)=>p.id).sort();
    const instant=(await f.scene({at:hist(offset)})).events.map((event)=>event.id).sort();assert.deepEqual(local,instant,`local UTC+${offset}`);
  }
  const next=await f.scene({at:hist(WEEK),points:true,span:'7d'});assert.equal(next.points.some((point)=>point.sourceRecordId==='usgs:seam'),true);
});

test('buffer pages are bounded and version-scoped, honor corrected heads/bounds, and cannot expose a Known then lens',async(t)=>{
  const f=await fixture(t);await f.publish(Array.from({length:205},(_,n)=>feature(`buffer${n}`,{time:Date.parse(hist(n*1000))})),
    {range:{from:hist(-WEEK),to:hist(WEEK)}});
  const first=await f.scene({points:true,span:'7d'});assert.equal(first.points.length,100);assert.equal(first.counts.eligible,205);
  assert.equal(first.complete,false);assert.equal(first.truncated,true);assert.ok(first.cursor);
  const second=await f.scene({points:true,span:'7d',cursor:first.cursor}),third=await f.scene({points:true,span:'7d',cursor:second.cursor});
  assert.equal(new Set([...first.points,...second.points,...third.points].map((p)=>p.id)).size,205);assert.equal(third.cursor,null);
  await assert.rejects(f.scene({points:true,span:'7d',knownAt:stamp()}),TypeError);
  await assert.rejects(f.scene({points:true,span:'7d',knownMode:'scene'}),TypeError);
  await assert.rejects(f.scene({points:true,span:'7d',at:stamp(1)}),TypeError);
  await assert.rejects(f.scene({cursor:first.cursor}),TypeError);
  f.setClock(1000);await f.publish([feature('buffer0',{updated:Date.parse(hist(WEEK+DAY)),time:Date.parse(hist(-9*DAY)),lon:30})],{offset:1000,kind:'correction'});
  const corrected=await f.scene({points:true,span:'7d'});assert.equal(corrected.points.some((p)=>p.sourceRecordId==='usgs:buffer0'),false);
  await assert.rejects(f.scene({points:true,span:'7d',cursor:first.cursor}),TypeError);
});

test('buffers clamp to actual retained coverage and current wall time; detail rejects a superseded selected point revision',async(t)=>{
  const f=await fixture(t);await f.publish([feature()],{range:{from:hist(-WEEK),to:hist(DAY)}});
  const buffered=await f.scene({points:true,span:'7d'});assert.equal(buffered.bufferTo,hist(DAY));assert.equal(buffered.validTo,hist(DAY));
  const point=buffered.points[0],handle=createWorldSceneHandler({env:f.env,now:f.now});
  const exact=`https://owned.example/api/world/scene/events/${point.id}?at=${AT}&revision=${point.revision}`;
  assert.equal((await handle(new Request(exact))).status,200);
  f.setClock(1000);await f.publish([feature(undefined,{mag:5.8,updated:Date.parse(hist(7200000))})],{offset:1000,kind:'correction'});
  assert.equal((await handle(new Request(exact))).status,409);
  const atEnd=await f.scene({at:hist(DAY),points:true,span:'7d'});assert.equal(atEnd.bufferTo,null);assert.equal(atEnd.validFrom,null);
  await assert.rejects(f.publish([],{offset:1000,range:{from:stamp(),to:stamp(2000)}}),/Future intervals/);
});

test('concurrent equivalent retries project the first retained canonical retrieval clock even when a later attempt wins D1 publication',async(t)=>{
  const f=await fixture(t),first=await f.input(),later={...first,capturedAt:stamp(1000),records:first.records.map((record)=>({...record,retrievedAt:stamp(1000)}))};
  f.setClock(1000);let raced=false;
  f.env.EARTH_DB.beforeBatch=async(statements)=>{
    if(!raced&&statements.some((statement)=>/INSERT INTO earth_world_revisions/.test(statement.sql))){
      raced=true;f.env.EARTH_DB.beforeBatch=null;await publishWorldArchiveChunk(f.env,later,{now:f.now});
    }
  };
  const retained=await publishWorldArchiveChunk(f.env,first,{now:f.now});assert.equal(retained.stored,true);assert.equal(f.count('earth_archive_chunks'),1);
  const event=(await f.scene()).events[0];assert.equal(event.sourceTimes.retrievedAt,stamp());assert.equal(event.archive.capturedAt,stamp(1000));
  assert.equal((await f.scene({id:event.id})).event.id,event.id);
});
