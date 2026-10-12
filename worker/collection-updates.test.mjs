import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { collectionRevision, createCollectionUpdates, COLLECTION_UPDATE_QUEUE_BYTES } from './collection-updates.js';

const CLOCK = Date.parse('2026-10-11T12:00:00.000Z');
const input = (offset = 0, digest = 'a') => ({ at: new Date(CLOCK + offset).toISOString(), digest: digest.repeat(64), recordCount: 350 });
const flush = async () => { for (let step = 0; step < 24; step++) await Promise.resolve(); };
function scheduler() {
  let clock = CLOCK, serial = 0;
  const tasks = new Map();
  return { tasks, now: () => clock,
    schedule(callback, delay) { const id = ++serial; tasks.set(id, { callback, at: clock + delay }); return id; },
    unschedule(id) { tasks.delete(id); },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        clock = next[1].at; tasks.delete(next[0]); next[1].callback(); await flush();
      }
      clock = until; await flush();
    },
  };
}
async function database(t, { pluginsMigrated = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const filename of ['0000_glossy_overlord.sql', '0001_collection_revision.sql', ...(pluginsMigrated ? ['0007_source_plugins.sql', '0008_plugin_heads.sql'] : [])]) sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const counters = { reads: 0, writes: 0, primary: 0, queries: [] };
  const binding = { sqlite, counters,
    withSession(value) { assert.equal(value, 'first-primary'); counters.primary++; return this; },
    prepare(sql) { return { bind(...values) {
      return {
        async first() { counters.reads++; if (binding.failReads) throw new Error('private database failure details'); return sqlite.prepare(sql).get(...values) || null; },
        async all() { counters.reads++; counters.queries.push(sql); if (binding.failReads) throw new Error('private database failure details'); return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { counters.writes++; return sqlite.prepare(sql).run(...values); },
      };
    } }; },
  };
  return binding;
}
function retainedPlugin(db, { pluginId = 'ecb-press-v1', scopeId = 'ecb-institutional-press-en-v1', fence = 1, marker = 'a', facts = 'a', offset = 0 } = {}) {
  const recordedAt = new Date(CLOCK + offset).toISOString(), receiptId = `receipt:${marker.repeat(64)}`;
  db.sqlite.prepare(`INSERT INTO earth_plugin_captures (receipt_id,plugin_id,scope_id,fence,captured_at,recorded_at,facts_digest,raw_sha256,artifact_sha256,
    raw_bytes,facts_bytes,artifact_bytes,source_updated_at,source_version,item_count) VALUES (?,?,?,?,?,?,?,?,?,1,1,1,NULL,NULL,1)`)
    .run(receiptId, pluginId, scopeId, fence, recordedAt, recordedAt, facts.repeat(64), 'd'.repeat(64), 'e'.repeat(64));
  db.sqlite.prepare(`INSERT INTO earth_plugin_state (plugin_id,scope_id,next_check_at,status,failure_count,fence,current_receipt,facts_digest)
    VALUES (?,?,'2026-10-11T12:00:00.000Z','ready',0,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET
    current_receipt=excluded.current_receipt,facts_digest=excluded.facts_digest,fence=excluded.fence`).run(pluginId, scopeId, fence, receiptId, facts.repeat(64));
  return { schemaVersion: 1, pluginId, scopeId, receiptId, fence, factsDigest: facts.repeat(64), recordedAt };
}
function connect(channel, env, { headers = {}, path = '/api/updates', method = 'GET' } = {}) {
  const abort = new AbortController();
  const response = channel.handleUpdates(new Request(`https://owned.example${path}`, { method, headers, signal: abort.signal }), env);
  return { abort, response, reader: response?.body?.getReader() };
}
async function nextEvent(reader, name = 'collection') {
  let timeout;
  const operation = (async () => {
    for (let chunk = 0; chunk < 12; chunk++) {
      const part = await reader.read(); assert.equal(part.done, false);
      const value = new TextDecoder().decode(part.value);
      if (value.includes(`event: ${name}\n`)) return { frame: value, value: JSON.parse(/^data: (.+)$/m.exec(value)[1]) };
    }
    throw new Error('Expected bounded update event');
  })();
  try { return await Promise.race([operation, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Stream test deadline')), 1000); })]); }
  finally { clearTimeout(timeout); }
}

test('generated migrations and actual SQLite enforce a monotonic, bounded, public revision', async (t) => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates(clock), env = { EARTH_DB: db };
  const first = await channel.publishCollectionRevision(env, { ...input(), secret: 'not-public', records: ['not-public'] });
  assert.equal(first.stored, true); assert.equal(first.superseded, false);
  assert.equal((await channel.publishCollectionRevision(env, input(-1000, 'b'))).revision, first.revision);
  assert.equal((await channel.publishCollectionRevision(env, input(-1000, 'b'))).superseded, true);
  assert.equal((await channel.publishCollectionRevision(env, input())).revision, first.revision);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM earth_collection_revision').get().count, 1);
  await assert.rejects(channel.publishCollectionRevision(env, input(300001)), TypeError);
  for (const value of [{ ...input(), recordCount: 501 }, { ...input(), digest: 'bad' }, { ...input(), at: '2026-10-11' }]) assert.throws(() => collectionRevision(value), TypeError);
  assert.deepEqual(await channel.publishCollectionRevision({}, input()), { configured: false, stored: false });
  assert.equal(clock.tasks.size, 0);
  const client = connect(channel, env); const event = await nextEvent(client.reader);
  assert.deepEqual(Object.keys(event.value), ['schemaVersion', 'revision', 'collectedAt', 'inputDigest', 'recordCount']);
  assert.equal(event.frame.includes('not-public'), false); assert.match(event.frame, new RegExp(`^id: ${first.revision}`, 'm'));
  client.abort.abort(); await flush(); assert.equal(channel.status(env).clients, 0); assert.equal(clock.tasks.size, 0);
});

test('many clients share one D1 read slot and keepalive without upstream requests; cancellation hands over the watcher', async (t) => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates({ ...clock, keepaliveMs: 2000 }), env = { EARTH_DB: db };
  await channel.publishCollectionRevision(env, input()); db.counters.reads = 0;
  const clients = Array.from({ length: 8 }, () => connect(channel, env)); await flush();
  for (const client of clients) assert.equal((await nextEvent(client.reader)).value.recordCount, 350);
  assert.equal(db.counters.reads, 1);
  await clock.advance(2000); assert.equal(db.counters.reads, 3);
  const keepalive = new TextDecoder().decode((await clients[0].reader.read()).value); assert.equal(keepalive, ': keepalive\n\n');
  clients[0].abort.abort(); await flush();
  await channel.publishCollectionRevision(env, input(2000, 'b'));
  await clock.advance(1000);
  for (const client of clients.slice(1)) assert.equal((await nextEvent(client.reader)).value.inputDigest, 'b'.repeat(64));
  for (const client of clients.slice(1)) await client.reader.cancel(); await flush();
  const reads = db.counters.reads; await clock.advance(10000);
  assert.equal(db.counters.reads, reads); assert.equal(channel.status(env).clients, 0); assert.equal(clock.tasks.size, 0);
});

test('independent isolate factories observe durable latest data and reconnect always replays current revision', async (t) => {
  const db = await database(t), clock = scheduler(), writer = createCollectionUpdates(clock), reader = createCollectionUpdates(clock), env = { EARTH_DB: db };
  const initial = await writer.publishCollectionRevision(env, input());
  const client = connect(reader, env, { headers: { 'last-event-id': initial.revision } }); await flush();
  assert.equal((await nextEvent(client.reader)).value.revision, initial.revision);
  const later = await writer.publishCollectionRevision(env, input(1000, 'c')); await clock.advance(1000);
  assert.equal((await nextEvent(client.reader)).value.revision, later.revision);
  assert.ok(db.counters.primary >= 3);
  await client.reader.cancel(); await flush();
  const resumed = connect(createCollectionUpdates(clock), env, { headers: { 'last-event-id': initial.revision } }); await flush();
  assert.equal((await nextEvent(resumed.reader)).value.revision, later.revision);
  resumed.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});

test('empty status, stream caps and request rotation recover through a latest-revision reconnect', async (t) => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates({ ...clock, maxClients: 1, streamLifetimeMs: 2000 }), env = { EARTH_DB: db };
  assert.equal(channel.handleUpdates(new Request('https://owned.example/other'), env), null);
  assert.equal(connect(channel, env, { method: 'POST' }).response.status, 405);
  assert.equal(connect(channel, {}).response.status, 503);
  const client = connect(channel, env); await flush();
  assert.deepEqual((await nextEvent(client.reader, 'ready')).value, { schemaVersion: 1, available: false });
  assert.equal(connect(channel, env).response.status, 429);
  await clock.advance(2000); assert.equal((await client.reader.read()).done, true);
  assert.equal(channel.status(env).clients, 0); assert.equal(clock.tasks.size, 0);
  await channel.publishCollectionRevision(env, input(2000));
  const resumed = connect(channel, env); await flush(); assert.equal((await nextEvent(resumed.reader)).value.collectedAt, input(2000).at);
  channel.closeUpdates(env); await clock.advance(1000);
  assert.equal((await resumed.reader.read()).done, true); assert.equal(clock.tasks.size, 0);
});

test('slow consumers have bounded queued bytes and free their connection slot', async (t) => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates(clock), env = { EARTH_DB: db };
  await channel.publishCollectionRevision(env, input());
  const client = connect(channel, env); await flush();
  for (let index = 1; index < 15 && channel.status(env).clients; index++) {
    await clock.advance(1000); await channel.publishCollectionRevision(env, input(index * 1000, (index % 15).toString(16)));
  }
  await clock.advance(1000);
  assert.equal(channel.status(env).clients, 0);
  let total = 0;
  for (;;) { const part = await client.reader.read(); if (part.done) break; total += part.value.byteLength; }
  assert.ok(total <= COLLECTION_UPDATE_QUEUE_BYTES); assert.equal(COLLECTION_UPDATE_QUEUE_BYTES,4096); assert.equal(clock.tasks.size, 0);
});

test('a timed-out D1 read remains coalesced and its late completion cannot mutate a closed watcher', async () => {
  const clock = scheduler(); let resolveRead, reads = 0;
  const db = { prepare() { return { bind() { return { all() { reads++; return new Promise((resolve) => { resolveRead = resolve; }); } }; } }; } };
  const env = { EARTH_DB: db }, channel = createCollectionUpdates({ ...clock, readTimeoutMs: 1000 });
  const a = connect(channel, env), b = connect(channel, env); await flush();
  await clock.advance(4000); assert.equal(reads, 1); assert.equal(channel.status(env).reading, true);
  a.abort.abort(); b.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
  const value = collectionRevision(input());
  resolveRead({ results: [{ id: 1, collected_at: value.collectedAt, input_digest: value.inputDigest, record_count: value.recordCount, revision: value.revision }] });
  await flush(); assert.deepEqual(channel.status(env), { clients: 0, reading: false, revision: null, aircraftRevision: null });
});

test('cached revision stays bounded while status reports database failure and unchanged-data recovery', async (t) => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates(clock), env = { EARTH_DB: db };
  const published = await channel.publishCollectionRevision(env, input());
  const client = connect(channel, env); await flush();
  assert.deepEqual((await nextEvent(client.reader, 'status')).value, { schemaVersion: 1, available: true });
  assert.equal((await nextEvent(client.reader)).value.revision, published.revision);
  db.failReads = true; await clock.advance(1000);
  const failed = await nextEvent(client.reader, 'status');
  assert.deepEqual(failed.value, { schemaVersion: 1, available: false });
  assert.equal(failed.frame.includes('private database failure details'), false);
  assert.equal(channel.status(env).revision, published.revision);
  db.failReads = false; await clock.advance(1000);
  assert.deepEqual((await nextEvent(client.reader, 'status')).value, { schemaVersion: 1, available: true });
  assert.equal(channel.status(env).revision, published.revision);
  client.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});

test('aircraft and intelligence publish independently and reconnect share one durable read slot', async (t) => {
  const db = await database(t), clock = scheduler(), writer = createCollectionUpdates(clock), reader = createCollectionUpdates(clock), env = { EARTH_DB: db };
  const metadata = await writer.publishCollectionRevision(env, input());
  const aircraft = await writer.publishCollectionRevision(env, { ...input(-10000, 'b'), recordCount: 1600 }, 'aircraft');
  assert.equal(aircraft.stored, true);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_collection_revision').get().n, 2);
  await assert.rejects(writer.publishCollectionRevision(env, { ...input(), recordCount: 2001 }, 'aircraft'), TypeError);
  db.counters.reads = 0;
  const client = connect(reader, env); await flush();
  assert.equal((await nextEvent(client.reader)).value.revision, metadata.revision);
  const event = await nextEvent(client.reader, 'aircraft');
  assert.equal(event.value.revision, aircraft.revision); assert.match(event.frame, /^id: aircraft:/m);
  assert.equal(db.counters.reads, 1, 'Both streams use the same D1 query');
  const later = await writer.publishCollectionRevision(env, { ...input(1000, 'c'), recordCount: 1600 }, 'aircraft');
  await clock.advance(1000);
  assert.equal((await nextEvent(client.reader, 'aircraft')).value.revision, later.revision);
  assert.equal(reader.status(env).revision, metadata.revision);
  assert.equal(db.counters.reads, 3, 'One writer verification plus one shared read');
  client.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});

test('fixed typed receipts join collection delivery in one indexed query shared by all clients without evidence-object reads', async t => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates(clock);
  let objects = 0; const env = { EARTH_DB: db, EARTH_STORE: { get() { objects++; throw Error('Forbidden stream evidence read'); }, put() { objects++; throw Error('Forbidden stream write'); } } };
  await channel.publishCollectionRevision(env, {...input(),recordCount:500});
  await channel.publishCollectionRevision(env, {...input(),recordCount:2000},'aircraft');
  const fence=Number.MAX_SAFE_INTEGER;
  const ecb = retainedPlugin(db,{fence}), gas = retainedPlugin(db, { pluginId: 'eurostat-gas-origins-v1', scopeId: 'belgium-natural-gas-origins', marker: 'b',fence });
  const commission = retainedPlugin(db, { pluginId: 'ec-press-v1', scopeId: 'ec-presscorner-en-metadata-v1', marker: 'f',fence });
  const seismic = retainedPlugin(db, { pluginId: 'usgs-live-day-m2-5-v1', scopeId: 'usgs-live-day-m2-5-v1', marker: 'c',fence });
  db.counters.reads = 0; const writes = db.counters.writes;
  const clients = Array.from({ length: 8 }, () => connect(channel, env)); t.after(() => clients.forEach(client => client.abort.abort())); await flush();
  // Followers can enter their wait while the first shared query is in flight;
  // all observe its retained result by the next one-second presentation tick.
  await clock.advance(1000);
  for (const client of clients) {
    const collection=await nextEvent(client.reader),aircraft=await nextEvent(client.reader,'aircraft');
    const events = [await nextEvent(client.reader, 'plugin'), await nextEvent(client.reader, 'plugin'), await nextEvent(client.reader, 'plugin'), await nextEvent(client.reader, 'plugin')];
    assert.deepEqual(events.map(event => event.value).sort((a, b) => a.pluginId.localeCompare(b.pluginId)), [ecb, gas, commission, seismic].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
    assert.match(events.find(event => event.value.pluginId === 'ec-press-v1').frame, /^id: plugin:ec-press-v1:9007199254740991:receipt:/m);
    assert.deepEqual(Object.keys(events[0].value), ['schemaVersion', 'pluginId', 'scopeId', 'receiptId', 'fence', 'factsDigest', 'recordedAt']);
    const control='retry: 2000\n\nevent: status\ndata: {"schemaVersion":1,"available":true}\n\n';
    const initialBytes=new TextEncoder().encode(control+[collection,aircraft,...events].map(event=>event.frame).join('')).byteLength;
    assert.ok(initialBytes>2048);assert.ok(initialBytes<=COLLECTION_UPDATE_QUEUE_BYTES,'the entire fixed head replay fits before a follower starts reading');
  }
  assert.equal(db.counters.reads, 2, 'one grouped query per elapsed read slot, independent of eight connected clients'); assert.equal(db.counters.writes, writes); assert.equal(objects, 0);
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${db.counters.queries.at(-1)}`).all().map(row => row.detail).join('\n');
  assert.match(plan, /SEARCH s USING INDEX.*plugin_id/); assert.match(plan, /SEARCH c USING INDEX.*receipt_id/);
  assert.doesNotMatch(plan, /SCAN (?:s|c)\b/);
  await clock.advance(1000); assert.equal(db.counters.reads, 3); assert.equal(objects, 0);
  for (const client of clients) client.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});

test('scientific notifications expose only the completed current head, ignore operational fences and preserve equal-time reversions',async t=>{
  const db=await database(t),clock=scheduler(),channel=createCollectionUpdates(clock),env={EARTH_DB:db};
  const source={pluginId:'usgs-live-day-m2-5-v1',scopeId:'usgs-live-day-m2-5-v1'};
  const a=retainedPlugin(db,source),client=connect(channel,env);t.after(()=>client.abort.abort());await flush();
  assert.deepEqual((await nextEvent(client.reader,'plugin')).value,a);
  db.sqlite.prepare('UPDATE earth_plugin_state SET fence=999,checked_at=? WHERE plugin_id=?').run(new Date(CLOCK+1000).toISOString(),source.pluginId);
  await clock.advance(1000);
  const b=retainedPlugin(db,{...source,fence:1000,marker:'b',facts:'b'});await clock.advance(1000);
  assert.deepEqual((await nextEvent(client.reader,'plugin')).value,b,'unchanged operational checks emitted no factual event');
  const again=retainedPlugin(db,{...source,fence:1001,marker:'c',facts:'a'});await clock.advance(1000);
  assert.deepEqual((await nextEvent(client.reader,'plugin')).value,again);assert.equal(again.recordedAt,a.recordedAt);
  assert.equal(again.factsDigest,a.factsDigest);assert.notEqual(again.receiptId,a.receiptId);
  // A retained capture not promoted to current_receipt cannot announce itself.
  const unpromoted=retainedPlugin(db,{...source,fence:1002,marker:'d',facts:'d'});
  db.sqlite.prepare('UPDATE earth_plugin_state SET current_receipt=?,facts_digest=? WHERE plugin_id=?').run(again.receiptId,again.factsDigest,source.pluginId);
  await clock.advance(1000);client.abort.abort();await flush();
  const resumed=connect(createCollectionUpdates(clock),env,{headers:{'last-event-id':`plugin:${source.pluginId}:${a.fence}:${a.receiptId}`}});
  t.after(()=>resumed.abort.abort());await flush();assert.deepEqual((await nextEvent(resumed.reader,'plugin')).value,again);
  assert.notEqual(again.receiptId,unpromoted.receiptId);resumed.abort.abort();await flush();assert.equal(clock.tasks.size,0);
});

test('operational checks are quiet; A/B/A receipt fences remain distinct and reconnect replays the current receipt', async t => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates(clock), env = { EARTH_DB: db };
  const a = retainedPlugin(db), client = connect(channel, env); await flush(); assert.deepEqual((await nextEvent(client.reader, 'plugin')).value, a);
  db.sqlite.prepare("UPDATE earth_plugin_state SET fence=999,checked_at='2026-10-11T12:00:01.000Z' WHERE plugin_id='ecb-press-v1'").run();
  await clock.advance(1000);
  const b = retainedPlugin(db, { fence: 1000, marker: 'b', facts: 'b', offset: 1000 }); await clock.advance(1000);
  assert.deepEqual((await nextEvent(client.reader, 'plugin')).value, b, 'the prior unchanged check emitted no plugin event');
  const returnA = retainedPlugin(db, { fence: 1001, marker: 'c', facts: 'a', offset: 2000 }); await clock.advance(1000);
  assert.deepEqual((await nextEvent(client.reader, 'plugin')).value, returnA); assert.equal(returnA.factsDigest, a.factsDigest);
  client.abort.abort(); await flush(); const resumed = connect(createCollectionUpdates(clock), env, { headers: { 'last-event-id': `plugin:${a.pluginId}:1:${a.receiptId}` } });
  await flush(); assert.deepEqual((await nextEvent(resumed.reader, 'plugin')).value, returnA);
  resumed.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});

test('exact missing plugin tables cost one bounded legacy fallback then recover on the next shared tick after migration', async t => {
  const db = await database(t, { pluginsMigrated: false }), clock = scheduler(), channel = createCollectionUpdates(clock), env = { EARTH_DB: db };
  const original = await channel.publishCollectionRevision(env, input()); db.counters.reads = 0;
  const client = connect(channel, env); await flush(); assert.equal((await nextEvent(client.reader)).value.revision, original.revision);
  assert.equal(db.counters.reads, 2, 'only an exact missing plugin table permits an exceptional second query');
  for (const filename of ['0007_source_plugins.sql', '0008_plugin_heads.sql']) db.sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  const plugin = retainedPlugin(db); await clock.advance(1000); assert.deepEqual((await nextEvent(client.reader, 'plugin')).value, plugin);
  assert.equal(db.counters.reads, 3, 'the same isolate rechecks and returns to the normal one-query path');
  db.failReads = true; await clock.advance(1000); assert.equal((await nextEvent(client.reader, 'status')).value.available, false);
  assert.equal(db.counters.reads, 4, 'unrelated failures never trigger a legacy fallback');
  client.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});

test('foreign or malformed plugin rows cannot poison valid collection delivery and late missing-table errors cannot issue post-deadline fallbacks', async t => {
  const db = await database(t), clock = scheduler(), channel = createCollectionUpdates(clock), env = { EARTH_DB: db };
  await channel.publishCollectionRevision(env, input()); retainedPlugin(db, { scopeId: 'unreviewed-scope' });
  const client = connect(channel, env); await flush(); assert.equal((await nextEvent(client.reader)).value.recordCount, 350);
  client.abort.abort(); await flush();
  let rejectRead, calls = 0;
  const stalled = { prepare() { return { bind() { return { all() { calls++; return new Promise((_, reject) => { rejectRead = reject; }); } }; } }; } };
  const deadlineChannel = createCollectionUpdates({ ...clock, readTimeoutMs: 1000 }), delayed = connect(deadlineChannel, { EARTH_DB: stalled }); await flush();
  await clock.advance(1000); assert.equal((await nextEvent(delayed.reader, 'status')).value.available, false);
  rejectRead(Error('D1_ERROR: no such table: earth_plugin_state: SQLITE_ERROR')); await flush(); assert.equal(calls, 1);
  delayed.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
});
