import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { ECB_PRESS_PLUGIN, collectEcbPress, ecbPressItems } from './ecb-press.js';
import { EC_PRESS_PLUGIN, collectEcPress, ecPressItems } from './ec-press.js';
import { pluginBytesDigest, pluginFactsDigest } from '../../src/core/plugin-evidence.js';
import { runSourcePlugin, readPluginEnvelope, readPluginPublications, PLUGIN_STORE_LIMITS } from './store.js';
import { normalizePluginDossier } from '../../src/core/plugin-dossier.js';
import { USGS_LIVE_DAY_PLUGIN,collectUsgsLiveDay,usgsLiveDayItems } from './usgs-live-day.js';
import { readPluginObservations } from './store.js';

const CLOCK = Date.parse('2026-10-12T02:00:00.000Z'), stamp = offset => new Date(CLOCK + offset).toISOString();
const STEP = ECB_PRESS_PLUGIN.cadenceMs + 1, UTF8 = new TextEncoder();
const sourceUrl = 'https://www.ecb.europa.eu//press/pr/date/2026/html/ecb.pr261007~0000000001.en.html';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function sourceFeed(label = 'A', absent = false) {
  const item = absent ? '' : `<item><title>TEST ONLY retained publication ${label}</title><link>${sourceUrl}</link><guid>${sourceUrl}</guid><pubDate>Wed, 07 Oct 2026 10:00:00 +0200</pubDate></item>`;
  return UTF8.encode(`\ufeff<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>ECB - European Central Bank</title><link>https://www.ecb.europa.eu/</link><language>en</language><lastBuildDate>Sun, 11 Oct 2026 10:00:00 +0200</lastBuildDate>${item}</channel></rss>`);
}

async function fixture(t, { migrated = true, descriptor = null, sourceFeedImpl = sourceFeed } = {}) {
  let clock = CLOCK, databaseClock = null, serial = 0, sqlHook = null, objectHook = null, fetchHook = null, responseMode = '200', label = 'A', absent = false;
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.function('strftime', { varargs: true }, (format, value, ...modifiers) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    let time = databaseClock ?? clock;
    for (const modifier of modifiers) {
      const match = /^([+-]?\d+(?:\.\d+)?) (second|minute|hour)s?$/.exec(modifier);
      assert.ok(match, `supported SQLite clock modifier ${modifier}`);
      time += Number(match[1]) * ({ second: 1000, minute: 60000, hour: 3600000 })[match[2]];
    }
    return new Date(time).toISOString();
  });
  if (migrated) {
    const migrationDirectory = new URL('../../drizzle/', import.meta.url);
    for (const name of (await readdir(migrationDirectory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
      sqlite.exec(await readFile(new URL(name, migrationDirectory), 'utf8'));
  }
  const activity = { sql: [], objects: [], provider: [] }, records = new Map();
  const bucket = {
    records,
    async get(key) {
      activity.objects.push({ operation: 'get', key }); await objectHook?.({ operation: 'get', key });
      const saved = records.get(key); if (!saved) return null;
      const bytes = new Uint8Array(saved.bytes);
      return { etag: saved.etag, size: bytes.byteLength, httpMetadata: saved.metadata,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
    },
    async head(key) { activity.objects.push({ operation: 'head', key }); const saved = records.get(key);
      return saved ? { etag: saved.etag, size: saved.bytes.byteLength, httpMetadata: saved.metadata } : null; },
    async put(key, body, options = {}) {
      activity.objects.push({ operation: 'put', key }); await objectHook?.({ operation: 'put', key, body, options });
      const previous = records.get(key), condition = options.onlyIf;
      if ((condition?.get?.('if-none-match') === '*' || condition?.etagDoesNotMatch === '*') && previous ||
          condition?.etagMatches && condition.etagMatches !== previous?.etag) return null;
      const bytes = typeof body === 'string' ? UTF8.encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body);
      const saved = { bytes: new Uint8Array(bytes), etag: `"fixture-${++serial}"`, metadata: options.httpMetadata || {} }; records.set(key, saved);
      return { etag: saved.etag, size: saved.bytes.byteLength };
    },
  };
  const db = {
    withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    prepare(sql) {
      const bind = (...values) => {
        assert.ok(values.length <= 100, 'D1 bounded parameter count');
        const execute = async mode => {
          const write = !/^\s*(?:SELECT|EXPLAIN|PRAGMA)/i.test(sql); activity.sql.push({ sql, values, mode, write });
          await sqlHook?.({ sql, values, mode, write });
          const statement = sqlite.prepare(sql);
          if (mode === 'first') return statement.get(...values) || null;
          const results = mode === 'all' || statement.columns().length ? statement.all(...values) : [];
          const changes = mode === 'run' && !statement.columns().length ? Number(statement.run(...values).changes) :
            write ? Number(sqlite.prepare('SELECT changes() AS n').get().n) : 0;
          return { success: true, results, meta: { changes } };
        };
        return { sql, values, first: () => execute('first'), all: () => execute('all'), run: () => execute('run') };
      };
      return { ...bind(), bind };
    },
    async batch(statements) {
      assert.ok(statements.length <= 32, 'bounded plugin publication transaction'); sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const fetchImpl = async (url, options = {}) => {
    activity.provider.push({ url, headers: options.headers }); assert.equal(url, plugin.sourceUrl);
    const currentLabel = label, currentAbsent = absent; const result = await fetchHook?.({ url, options, label: currentLabel, absent: currentAbsent });
    if (result) return result;
    if (responseMode === '304') return new Response(null, { status: 304, headers: { etag: `"fixture-${currentLabel}"` } });
    return new Response(sourceFeedImpl(currentLabel, currentAbsent), { headers: { 'content-type': plugin.kind==='observation-feed'?'application/json':'application/rss+xml', etag: `"fixture-${currentLabel}"` } });
  };
  const plugin = descriptor ?? { ...ECB_PRESS_PLUGIN, collect: collectEcbPress, items: ecbPressItems }, env = { EARTH_DB: db, EARTH_STORE: bucket };
  return { env, plugin, now: () => clock, sqlite, records, activity, fetchImpl,
    advance(offset = STEP) { clock += offset; }, clock(offset) { clock = CLOCK + offset; }, databaseClock(offset) { databaseClock = CLOCK + offset; },
    source(nextLabel, nextAbsent = false) { label = nextLabel; absent = nextAbsent; responseMode = '200'; }, mode(value) { responseMode = value; },
    sqlHook(value) { sqlHook = value; }, objectHook(value) { objectHook = value; }, fetchHook(value) { fetchHook = value; },
    count(table) { return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); },
    reset() { activity.sql.length = 0; activity.objects.length = 0; activity.provider.length = 0; },
    rows(table) { return sqlite.prepare(`SELECT * FROM ${table}`).all(); },
    receipts() { return sqlite.prepare('SELECT * FROM earth_plugin_captures ORDER BY recorded_at,fence').all(); },
    revisions() { return sqlite.prepare('SELECT * FROM earth_plugin_revisions ORDER BY first_recorded_at,revision').all(); },
  };
}

const run = (f, plugin = f.plugin) => runSourcePlugin(f.env, plugin, { now: f.now, fetchImpl: f.fetchImpl });
const counts = f => ['earth_plugin_captures', 'earth_plugin_revisions', 'earth_plugin_membership', 'earth_plugin_heads'].map(table => [table, f.count(table)]);
const publication = f => readPluginPublications(f.env, f.plugin.pluginId, { now: f.now });

const originalEc = await readFile(new URL('../../server/hosted/fixtures/ec-press-20261012.xml', import.meta.url), 'utf8');
function ecFeed(label, absent) {
  return UTF8.encode(absent ? originalEc.replace(/<item>[\s\S]*?<\/item>/g, '') :
    label === 'B' ? originalEc.replace('POLICY_AREA=GROWTH,JFRC', 'POLICY_AREA=GENINFO') : originalEc);
}
const ecDescriptor = { ...EC_PRESS_PLUGIN, collect: collectEcPress, items: ecPressItems };
const observationDescriptor={...USGS_LIVE_DAY_PLUGIN,collect:collectUsgsLiveDay,items:usgsLiveDayItems};
function observationFeed(label='A',generated=CLOCK) {
  return UTF8.encode(JSON.stringify({type:'FeatureCollection',metadata:{generated,count:1,status:200,url:USGS_LIVE_DAY_PLUGIN.sourceUrl},
    features:[{type:'Feature',id:'teststored',geometry:{type:'Point',coordinates:[4,50,12]},properties:{mag:label==='A'?3:4,
      time:CLOCK-1000,updated:CLOCK,type:'quarry blast',status:'reviewed',url:'https://earthquake.usgs.gov/earthquakes/eventpage/teststored'}}]}));
}

test('scientific feed generated-only checks preserve the original edition while latest checked generation proves freshness and A/B/A remains historical',async t=>{
  let generated=CLOCK;const f=await fixture(t,{descriptor:observationDescriptor,sourceFeedImpl:label=>observationFeed(label,generated)});
  const a=await run(f);assert.equal(a.status,'stored');const original=f.receipts()[0];
  f.advance(180001);generated=CLOCK+180000;f.reset();const same=await run(f);
  assert.equal(same.status,'checked');assert.equal(same.receiptId,a.receiptId);assert.equal(f.count('earth_plugin_captures'),1);
  assert.equal(f.activity.objects.filter(value=>value.operation==='put').length,0,'generated-only source bytes are not falsely published as changed facts');
  const current=await readPluginObservations(f.env,{now:f.now});assert.equal(current.available,true);assert.equal(current.stale,false);
  assert.equal(current.receipt.sourceUpdatedAt,stamp(0));assert.equal(current.receipt.capturedAt,original.captured_at);
  assert.equal(current.check.sourceGeneratedAt,stamp(180000));assert.ok(current.factualEditionAgeMs>=180000);assert.equal(current.sourceGenerationAgeMs,1);
  assert.equal(current.receipt.fence,original.fence);assert.ok(f.rows('earth_plugin_state')[0].fence>current.receipt.fence,'operational checks never change the complete receipt fence');
  f.advance(60001);f.source('B');generated=CLOCK+180000;const b=await run(f);assert.equal(b.status,'stored','same source-generation date can retain different reported facts');
  const rb=f.receipts().at(-1);assert.equal(rb.source_updated_at,stamp(180000));
  const historical=await readPluginObservations(f.env,{knownAt:rb.recorded_at,now:f.now});assert.equal(historical.records[0].mag,4);assert.equal(historical.records[0].eventType,'quarry blast');assert.equal(historical.check,null);
  f.advance(60001);f.source('A');const reverted=await run(f);assert.equal(reverted.status,'stored');assert.equal(f.count('earth_plugin_captures'),3);assert.equal(f.count('earth_plugin_revisions'),2);
  assert.equal((await readPluginObservations(f.env,{now:f.now})).records[0].mag,3);
  assert.equal((await readPluginObservations(f.env,{knownAt:rb.recorded_at,now:f.now})).records[0].mag,4);
  f.advance(60001);f.source('B');generated=CLOCK;assert.equal((await run(f)).status,'retry','generation regression cannot replace retained facts');
  assert.equal(f.count('earth_plugin_captures'),3);assert.equal((await readPluginObservations(f.env,{now:f.now})).records[0].mag,3);
  assert.equal(f.count('earth_world_captures'),0);assert.equal(f.count('earth_observations'),0,'four-source and archive journals remain separate');
});

test('scientific raw/facts readback failure cannot admit a complete receipt and public reads never acquire or mutate',async t=>{
  for(const kind of ['raw','facts']){
    const f=await fixture(t,{descriptor:observationDescriptor,sourceFeedImpl:label=>observationFeed(label)});
    f.objectHook(({operation,key,body})=>{if(operation==='put'&&key.includes(`/${kind}/`))body[10]^=1;});
    const rejected=await run(f);assert.equal(rejected.status,'retry');assert.equal(rejected.errorCode,'evidence_digest_mismatch');
    assert.ok(f.activity.objects.some(value=>value.operation==='put'&&value.key.includes(`/${kind}/`)),'fault injection reached retained object write/readback');
    assert.equal(f.count('earth_plugin_captures'),0);assert.equal(f.count('earth_plugin_heads'),0);
    f.reset();const missing=await readPluginObservations(f.env,{now:f.now});assert.equal(missing.available,false);
    assert.equal(f.activity.provider.length,0);assert.equal(f.activity.sql.filter(value=>value.write).length,0);assert.equal(f.activity.objects.length,0);
  }
  const f=await fixture(t,{descriptor:observationDescriptor,sourceFeedImpl:label=>observationFeed(label)});assert.equal((await run(f)).status,'stored');
  f.reset();const data=await readPluginObservations(f.env,{now:f.now});assert.equal(data.available,true);assert.equal(data.records.length,1);
  assert.equal(f.activity.provider.length,0);assert.equal(f.activity.sql.filter(value=>value.write).length,0);
  const row=f.receipts()[0];assert.equal((await readPluginObservations(f.env,{knownAt:row.recorded_at,now:f.now})).receipt.fence,row.fence);
  const key=`plugins/${f.plugin.pluginId}/facts/${row.facts_digest}`;f.records.get(key).bytes[10]^=1;
  assert.equal((await readPluginObservations(f.env,{now:f.now})).available,false);
  const plans=f.activity.sql.filter(value=>value.sql.startsWith('SELECT * FROM earth_plugin_captures')||value.sql.startsWith('SELECT c.* FROM earth_plugin_state')).flatMap(value=>f.sqlite.prepare('EXPLAIN QUERY PLAN '+value.sql).all(...value.values));
  assert.ok(plans.some(value=>value.detail.includes('earth_plugin_captures_known')));assert.equal(plans.some(value=>/SCAN earth_plugin_captures/.test(value.detail)),false);
  const currentPlan=plans.map(value=>value.detail).join('\n');assert.match(currentPlan,/SEARCH s USING INDEX.*plugin_id/);assert.match(currentPlan,/SEARCH c USING INDEX.*receipt_id/);
  // Corrupt retained metadata is a storage failure, never an invalid visitor query.
  f.sqlite.prepare('UPDATE earth_plugin_revisions SET projection_json=? WHERE plugin_id=?').run('null',f.plugin.pluginId);
  const corrupt=await readPluginObservations(f.env,{now:f.now});assert.equal(corrupt.configured,false);
  assert.equal(corrupt.errorCode,'stored-observation-unavailable');assert.deepEqual(corrupt.records,[]);
});

test('scientific current-head fence distinguishes equal-millisecond A/B/A and does not rewrite generic publication receipts',async t=>{
  const f=await fixture(t,{descriptor:observationDescriptor,sourceFeedImpl:label=>observationFeed(label)});assert.equal((await run(f)).status,'stored');
  const a=(await readPluginObservations(f.env,{now:f.now})).receipt;
  f.databaseClock(0);
  for(const label of ['B','A']) { f.advance(60001);f.source(label);
    f.sqlite.prepare('UPDATE earth_plugin_state SET next_check_at=? WHERE plugin_id=?').run(stamp(0),f.plugin.pluginId);
    assert.equal((await run(f)).status,'stored');}
  const latest=await readPluginObservations(f.env,{now:f.now}),history=await readPluginObservations(f.env,{knownAt:stamp(0),now:f.now});
  assert.equal(latest.records[0].mag,3);assert.equal(latest.receipt.recordedAt,a.recordedAt);assert.equal(history.receipt.id,latest.receipt.id);
  assert.notEqual(latest.receipt.id,a.id);assert.equal(latest.receipt.factsDigest,a.factsDigest);assert.ok(latest.receipt.fence>a.fence);
  assert.equal(f.count('earth_plugin_revisions'),2);assert.equal(f.count('earth_plugin_captures'),3);
  f.sqlite.prepare('UPDATE earth_plugin_state SET current_receipt=?,facts_digest=? WHERE plugin_id=?').run(a.id,a.factsDigest,f.plugin.pluginId);
  assert.equal((await readPluginObservations(f.env,{now:f.now})).receipt.id,a.id,'current delivery follows its exact pointer, not an unrelated retained capture');
  assert.equal((await readPluginObservations(f.env,{knownAt:stamp(0),now:f.now})).receipt.id,latest.receipt.id,'historical cutoffs remain capture-journal selection');
  f.sqlite.prepare('UPDATE earth_plugin_state SET current_receipt=?,facts_digest=? WHERE plugin_id=?').run(latest.receipt.id,latest.receipt.factsDigest,f.plugin.pluginId);
  for(const fence of [0,Number.MAX_SAFE_INTEGER+1]) {f.sqlite.prepare('UPDATE earth_plugin_captures SET fence=? WHERE receipt_id=?').run(fence,latest.receipt.id);
    assert.equal((await readPluginObservations(f.env,{now:f.now})).available,false,'malformed stored receipt fences fail closed');}
  const publication=await fixture(t);assert.equal((await run(publication)).status,'stored');
  assert.equal(Object.hasOwn((await readPluginPublications(publication.env,publication.plugin.pluginId,{now:publication.now})).receipt,'fence'),false);
});

test('an expired scientific writer cannot overwrite a newer completed edition during object readback; stored delivery retries only one edition',async t=>{
  const f=await fixture(t,{descriptor:observationDescriptor,sourceFeedImpl:label=>observationFeed(label)});let replaced=false,newer;
  f.objectHook(async({operation,key})=>{if(!replaced&&operation==='get'&&key.includes('/raw/')){
    replaced=true;f.objectHook(null);f.advance(60001);f.source('B');newer=await run(f);
  }});
  const old=await run(f);assert.equal(old.status,'superseded');assert.equal(newer.status,'stored');assert.equal(f.count('earth_plugin_captures'),1);
  assert.equal((await readPluginObservations(f.env,{now:f.now})).records[0].mag,4);
  f.advance(60001);f.source('A');let intervened=false;
  f.objectHook(async({operation,key})=>{if(!intervened&&operation==='get'&&key.includes('/facts/')){
    intervened=true;f.objectHook(null);assert.equal((await run(f)).status,'stored');
  }});
  const coherent=await readPluginObservations(f.env,{now:f.now});assert.equal(coherent.records[0].mag,3);assert.equal(coherent.receipt.id,f.receipts().at(-1).receipt_id);
});

test('EC current and historical delivery retain reviewed document fields and each item own receipt after feed disappearance', async t => {
  const f = await fixture(t, { descriptor: ecDescriptor, sourceFeedImpl: ecFeed });
  const stored = await run(f); assert.equal(stored.status, 'stored'); const first = f.receipts()[0];
  let read = await publication(f), item = read.items.find(item => item.documentReference === 'statement_26_2127');
  assert.equal(normalizePluginDossier(read, 'commission'), read, 'actual persisted API projection is accepted by the client');
  assert.ok(item); assert.equal(item.documentType, 'statement'); assert.deepEqual(item.categories, ['POLICY_AREA=GROWTH,JFRC']);
  assert.equal(item.evidence.id, first.receipt_id); assert.equal(read.plugin.id, 'ec-press-v1');
  f.advance(); f.source('B'); assert.equal((await run(f)).status, 'stored'); const second = f.receipts()[1];
  read = await publication(f); item = read.items.find(item => item.documentReference === 'statement_26_2127');
  assert.deepEqual(item.categories, ['POLICY_AREA=GENINFO']); assert.equal(item.evidence.id, second.receipt_id);
  const known = await readPluginPublications(f.env, f.plugin.pluginId, { knownAt: first.recorded_at, now: f.now });
  assert.equal(normalizePluginDossier(known, 'commission'), known, 'knowledge-time delivery keeps the same client contract');
  assert.deepEqual(known.items.find(item => item.documentReference === 'statement_26_2127').categories, ['POLICY_AREA=GROWTH,JFRC']);
  f.advance(); f.source('B', true); assert.equal((await run(f)).status, 'stored'); const empty = f.receipts()[2];
  f.reset(); read = await publication(f); item = read.items.find(item => item.documentReference === 'statement_26_2127');
  assert.equal(read.receipt.id, empty.receipt_id); assert.equal(item.evidence.id, second.receipt_id);
  assert.equal(normalizePluginDossier(read, 'commission'), read, 'retained items remain usable after leaving the rolling feed');
  assert.deepEqual(item.categories, ['POLICY_AREA=GENINFO']); assert.equal(read.artifact.items.length, 0); assert.equal(read.items.length, 10);
  assert.equal(f.activity.provider.length, 0); assert.equal(f.activity.sql.some(item => item.write), false);
  assert.equal(f.count('earth_world_captures'), 0); assert.equal(f.count('earth_investigation_jobs'), 0);
});

test('EC persistence rejects forged reference/type/category fields before factual publication', async t => {
  for (const mutate of [item => { item.documentReference = 'statement_26_99999'; }, item => { item.documentType = 'ip'; },
    item => { item.categories = ['POLICY_AREA=GENINFO', 'POLICY_AREA=GENINFO']; }, item => { item.categories = ['GEOMETRY=50,4']; },
    item => { item.categories = Array.from({ length: 9 }, (_, index) => `POLICY_AREA=A${index}`); },
    item => { item.publishedRaw = 'unknown'; }, item => { item.publishedAt = null; }, item => { item.publishedPrecision = 'day'; },
    item => { item.publisherId = 'other'; }]) {
    const f = await fixture(t, { descriptor: ecDescriptor, sourceFeedImpl: ecFeed });
    const bad = { ...ecDescriptor, collect: async input => { const result = await collectEcPress(input); mutate(result.canonicalFacts.items[0]);
      result.factsDigest = await pluginFactsDigest(result.canonicalFacts); return result; } };
    const result = await run(f, bad); assert.equal(result.status, 'retry'); assert.equal(result.errorCode, 'invalid_plugin_evidence');
    assert.equal(f.count('earth_plugin_captures'), 0); assert.equal(f.count('earth_plugin_heads'), 0);
  }
});

test('first complete source publication retains byte authority and not-due wakes make zero provider calls or mutation statements', async t => {
  const f = await fixture(t), stored = await run(f); assert.equal(stored.status, 'stored'); assert.equal(stored.changed, true);
  assert.deepEqual(counts(f), [['earth_plugin_captures', 1], ['earth_plugin_revisions', 1], ['earth_plugin_membership', 1], ['earth_plugin_heads', 1]]);
  const capture = f.receipts()[0], rawKey = `plugins/${f.plugin.pluginId}/raw/${capture.raw_sha256}`;
  assert.deepEqual(f.records.get(rawKey).bytes, sourceFeed()); assert.equal(capture.raw_sha256, await pluginBytesDigest(sourceFeed()));
  assert.equal(capture.recorded_at, stamp(0)); assert.equal(f.revisions()[0].first_recorded_at, stamp(0));
  for (const table of ['earth_observations', 'earth_world_captures', 'earth_world_sources', 'earth_investigation_jobs']) assert.equal(f.count(table), 0);
  assert.equal([...f.records.keys()].some(key => /prepared|collection\/|world\/|investigation/.test(key)), false);
  f.reset(); const unchangedWake = await run(f); assert.equal(unchangedWake.status, 'not-due'); assert.equal(unchangedWake.acquired, false);
  assert.equal(f.activity.provider.length, 0); assert.equal(f.activity.sql.filter(row => row.write).length, 0); assert.equal(f.activity.objects.length, 0);
});

test('validated unchanged data and a real adapter304 update checks/validators only, never receipt/knowledge rows or R2 evidence', async t => {
  const f = await fixture(t); await run(f); const before = counts(f), revision = f.revisions()[0], receipt = f.receipts()[0];
  f.advance(); f.reset(); assert.equal((await run(f)).status, 'checked'); assert.deepEqual(counts(f), before);
  assert.equal(f.activity.objects.filter(row => row.operation === 'put').length, 0); assert.equal(f.revisions()[0].first_recorded_at, revision.first_recorded_at);
  assert.equal(f.receipts()[0].recorded_at, receipt.recorded_at);
  f.advance(); f.mode('304'); f.reset(); const checked = await run(f); assert.equal(checked.status, 'checked'); assert.equal(checked.changed, false);
  assert.deepEqual(counts(f), before); assert.equal(f.activity.objects.filter(row => row.operation === 'put').length, 0);
  assert.equal(f.rows('earth_plugin_state')[0].checked_at, stamp(STEP * 2)); assert.equal(f.rows('earth_plugin_state')[0].current_receipt, receipt.receipt_id);
});

test('A/B/A revisions have three receipts and two immutable revisions; known-then selects exact evolution without backdating knowledge', async t => {
  const f = await fixture(t); await run(f); const a = f.revisions()[0], first = f.receipts()[0];
  f.advance(); f.source('B'); await run(f); const second = f.receipts()[1];
  f.advance(); f.source('A'); await run(f); const third = f.receipts()[2];
  assert.equal(f.count('earth_plugin_captures'), 3); assert.equal(f.count('earth_plugin_revisions'), 2); assert.equal(f.count('earth_plugin_membership'), 3);
  assert.equal(f.revisions().find(row => row.revision === a.revision).first_recorded_at, first.recorded_at);
  const before = await readPluginPublications(f.env, f.plugin.pluginId, { knownAt: stamp(-1), now: f.now }); assert.equal(before.available, false); assert.deepEqual(before.items, []);
  const atA = await readPluginPublications(f.env, f.plugin.pluginId, { knownAt: first.recorded_at, now: f.now }); assert.match(atA.items[0].title, /publication A$/);
  const atB = await readPluginPublications(f.env, f.plugin.pluginId, { knownAt: second.recorded_at, now: f.now }); assert.match(atB.items[0].title, /publication B$/);
  const againA = await readPluginPublications(f.env, f.plugin.pluginId, { knownAt: third.recorded_at, now: f.now }); assert.equal(againA.items[0].revision, a.revision);
  assert.equal(againA.items[0].firstRecordedAt, first.recorded_at); assert.equal(againA.items[0].lastRecordedAt, third.recorded_at);
  assert.equal((await publication(f)).items[0].revision, a.revision);
});

test('rolling-feed absence retains prior publications and public reads cannot collect, enqueue or write', async t => {
  const f = await fixture(t); await run(f); const origin = f.receipts()[0]; f.advance(); f.source('empty', true); assert.equal((await run(f)).status, 'stored');
  assert.equal(f.count('earth_plugin_heads'), 1); assert.equal(f.count('earth_plugin_revisions'), 1);
  f.reset(); const envelope = await readPluginEnvelope(f.env, f.plugin.pluginId, { now: f.now }), originals = await publication(f);
  assert.equal(envelope.available, true); assert.deepEqual(envelope.artifact.items, []); assert.equal(originals.items.length, 1);
  assert.match(originals.items[0].title, /publication A$/); assert.equal(originals.items[0].firstRecordedAt, stamp(0));
  assert.notEqual(originals.receipt.id, origin.receipt_id, 'the outer current feed receipt is the now-empty rolling feed');
  const evidence = originals.items[0].evidence;
  assert.equal(evidence.id, origin.receipt_id); assert.equal(evidence.rawSha256, origin.raw_sha256); assert.equal(evidence.factsDigest, origin.facts_digest);
  assert.equal(evidence.recordedAt, origin.recorded_at); assert.deepEqual(evidence.locator, { kind: 'rss-guid', guid: sourceUrl });
  const originalFacts = JSON.parse(new TextDecoder().decode(f.records.get(`plugins/${f.plugin.pluginId}/facts/${evidence.factsDigest}`).bytes));
  assert.equal(originalFacts.items.find(item => item.itemId === originals.items[0].itemId).sourceRevision, originals.items[0].revision,
    'per-item provenance must resolve this exact immutable item revision, not the empty latest feed');
  assert.equal(f.activity.provider.length, 0); assert.equal(f.activity.sql.filter(row => row.write).length, 0); assert.equal(f.activity.objects.filter(row => row.operation === 'put').length, 0);
  assert.equal(f.count('earth_investigation_jobs'), 0);
});

test('an interleaved publication during envelope read retries one whole edition and returns coherent artifact/items/evidence', async t => {
  const f = await fixture(t); await run(f); const first = f.receipts()[0]; let interleaved = false, newer;
  f.objectHook(async ({ operation, key }) => {
    if (!interleaved && operation === 'get' && key === `plugins/${f.plugin.pluginId}/artifacts/${first.artifact_sha256}`) {
      interleaved = true; f.advance(); f.source('B'); newer = await run(f); assert.equal(newer.status, 'stored');
    }
  });
  const view = await publication(f); assert.equal(interleaved, true); assert.equal(view.available, true);
  assert.equal(view.receipt.id, newer.receiptId); assert.equal(view.version, newer.receiptId);
  assert.match(view.artifact.items[0].title, /publication B$/); assert.match(view.items[0].title, /publication B$/);
  assert.equal(view.items[0].evidence.id, newer.receiptId); assert.equal(view.items[0].evidence.recordedAt, view.receipt.recordedAt);
});

test('two interleaved editions fail closed after one bounded retry instead of mixing publication evidence', async t => {
  const f = await fixture(t); await run(f); let editions = 0;
  f.objectHook(async ({ operation, key }) => {
    if (operation === 'get' && key.includes('/artifacts/') && editions < 2) {
      editions++; f.advance(); f.source(editions === 1 ? 'B' : 'C'); assert.equal((await run(f)).status, 'stored');
    }
  });
  const view = await publication(f); assert.equal(editions, 2); assert.equal(view.available, false); assert.equal(view.errorCode, 'publication-edition-changed');
  assert.equal(view.artifact, null); assert.equal(view.receipt, null); assert.deepEqual(view.items, []);
});

test('expired/superseded source leases cannot publish late facts over a newer completed source receipt', async t => {
  const f = await fixture(t), started = gate(), finish = gate();
  f.fetchHook(async ({ label }) => {
    if (label === 'A') { started.resolve(); await finish.promise; return new Response(sourceFeed('A'), { headers: { 'content-type': 'application/rss+xml', etag: '"late-A"' } }); }
  });
  const oldWriter = run(f); await started.promise;
  f.advance(PLUGIN_STORE_LIMITS.leaseMs + 1); f.source('B'); const newer = await run(f); assert.equal(newer.status, 'stored');
  finish.resolve(); const late = await oldWriter; assert.equal(late.status, 'superseded'); assert.equal(late.changed, false);
  assert.equal(f.count('earth_plugin_captures'), 1); assert.equal(f.count('earth_plugin_revisions'), 1);
  assert.equal(f.rows('earth_plugin_state')[0].current_receipt, newer.receiptId); assert.match((await publication(f)).items[0].title, /publication B$/);
});

test('publication admitted before lease expiry remains complete and has one coherent first-knowledge timestamp inside the atomic batch', async t => {
  const f = await fixture(t); let moved = false;
  f.sqlHook(({ sql }) => { if (!moved && /^\s*INSERT INTO earth_plugin_revisions/.test(sql)) { moved = true; f.databaseClock(PLUGIN_STORE_LIMITS.leaseMs + 1); } });
  const stored = await run(f); assert.equal(stored.status, 'stored'); assert.equal(moved, true); assert.equal(f.count('earth_plugin_captures'), 1);
  assert.equal(f.count('earth_plugin_revisions'), 1); assert.equal(f.count('earth_plugin_membership'), 1); assert.equal(f.count('earth_plugin_heads'), 1);
  const capture = f.receipts()[0], revision = f.revisions()[0], head = f.rows('earth_plugin_heads')[0];
  assert.equal(revision.first_recorded_at, capture.recorded_at, 'first-known time must identify this exact admitted publication transaction');
  assert.equal(head.recorded_at, capture.recorded_at, 'current head cannot imply another publication time');
  const known = await readPluginPublications(f.env, f.plugin.pluginId, { knownAt: capture.recorded_at, now: f.now });
  assert.equal(known.items.length, 1); assert.equal(known.items[0].firstRecordedAt, capture.recorded_at);
});

test('a D1 publication failure rolls back every fact row while immutable objects remain retryable evidence', async t => {
  const f = await fixture(t); let failed = false;
  f.sqlHook(({ sql }) => { if (!failed && /^\s*INSERT INTO earth_plugin_membership/.test(sql)) { failed = true; throw Error('TEST ONLY transactional failure'); } });
  const result = await run(f); assert.equal(result.status, 'retry'); assert.equal(failed, true);
  for (const [, count] of counts(f)) assert.equal(count, 0); assert.equal(f.rows('earth_plugin_state')[0].current_receipt, null);
  assert.equal(f.records.size, 3, 'only three grouped immutable source/facts/artifact objects survive for retry, never per-item objects');
  f.sqlHook(null); f.advance(); const repaired = await run(f); assert.equal(repaired.status, 'stored'); assert.equal(f.records.size, 3);
  assert.equal(f.count('earth_plugin_captures'), 1); assert.equal(f.revisions()[0].first_recorded_at, stamp(STEP));
});

test('tampered raw/facts digests cannot replace last-good source history; corrupted stored artifacts are unavailable without reacquisition', async t => {
  const f = await fixture(t); await run(f); const first = f.receipts()[0];
  for (const tamper of [result => { result.raw.sha256 = 'b'.repeat(64); }, result => { result.canonicalFacts.items[0].title = 'TEST ONLY unauthorized changed projection'; }]) {
    f.advance(); const badPlugin = { ...f.plugin, collect: async input => { const value = await collectEcbPress(input); tamper(value); return value; } };
    const result = await run(f, badPlugin); assert.equal(result.status, 'retry'); assert.equal(result.errorCode, 'evidence_digest_mismatch');
    assert.equal(f.count('earth_plugin_captures'), 1); assert.equal(f.rows('earth_plugin_state')[0].current_receipt, first.receipt_id);
  }
  const artifact = f.records.get(`plugins/${f.plugin.pluginId}/artifacts/${first.artifact_sha256}`); artifact.bytes[0] ^= 1;
  f.reset(); const read = await readPluginEnvelope(f.env, f.plugin.pluginId, { now: f.now }); assert.equal(read.available, false);
  assert.equal(read.artifact, null); assert.equal(f.activity.provider.length, 0); assert.equal(f.activity.objects.filter(row => row.operation === 'put').length, 0);
});

test('missing database migration reports unavailable without a provider request or a fabricated original publication', async t => {
  const f = await fixture(t, { migrated: false }), result = await run(f);
  assert.equal(result.configured, false); assert.equal(result.status, 'unavailable'); assert.equal(f.activity.provider.length, 0);
  const read = await readPluginEnvelope(f.env, f.plugin.pluginId, { now: f.now }); assert.equal(read.available, false); assert.equal(read.artifact, null);
});
