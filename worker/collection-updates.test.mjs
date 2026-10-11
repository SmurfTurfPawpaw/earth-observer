import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { collectionRevision, createCollectionUpdates } from './collection-updates.js';

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
async function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const filename of ['0000_glossy_overlord.sql', '0001_collection_revision.sql']) sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const counters = { reads: 0, writes: 0, primary: 0 };
  const binding = { sqlite, counters,
    withSession(value) { assert.equal(value, 'first-primary'); counters.primary++; return this; },
    prepare(sql) { return { bind(...values) {
      return {
        async first() { counters.reads++; if (binding.failReads) throw new Error('private database failure details'); return sqlite.prepare(sql).get(...values) || null; },
        async run() { counters.writes++; return sqlite.prepare(sql).run(...values); },
      };
    } }; },
  };
  return binding;
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
  assert.ok(total <= 2048); assert.equal(clock.tasks.size, 0);
});

test('a timed-out D1 read remains coalesced and its late completion cannot mutate a closed watcher', async () => {
  const clock = scheduler(); let resolveRead, reads = 0;
  const db = { prepare() { return { bind() { return { first() { reads++; return new Promise((resolve) => { resolveRead = resolve; }); } }; } }; } };
  const env = { EARTH_DB: db }, channel = createCollectionUpdates({ ...clock, readTimeoutMs: 1000 });
  const a = connect(channel, env), b = connect(channel, env); await flush();
  await clock.advance(4000); assert.equal(reads, 1); assert.equal(channel.status(env).reading, true);
  a.abort.abort(); b.abort.abort(); await flush(); assert.equal(clock.tasks.size, 0);
  const value = collectionRevision(input());
  resolveRead({ collected_at: value.collectedAt, input_digest: value.inputDigest, record_count: value.recordCount, revision: value.revision });
  await flush(); assert.deepEqual(channel.status(env), { clients: 0, reading: false, revision: null });
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
