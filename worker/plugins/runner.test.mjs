import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { advanceSourcePlugins, startSourcePlugins, PLUGIN_RUNNER_LIMITS } from './runner.js';
import { SOURCE_PLUGINS } from './registry.js';
import { PREPARED_USGS_KEYS } from '../prepared-usgs-store.js';

const CLOCK = Date.parse('2026-10-12T02:00:00.000Z'), now = () => CLOCK;
const UTF8 = new TextEncoder(), gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gas = new Uint8Array(await readFile(new URL('../../server/hosted/fixtures/eurostat-gas-belgium-2024.json', import.meta.url)));
const ec = new Uint8Array(await readFile(new URL('../../server/hosted/fixtures/ec-press-20261012.xml', import.meta.url)));
const ecb = '<rss version="2.0"><channel><title>ECB - European Central Bank</title><link>https://www.ecb.europa.eu/</link><language>en</language>' +
  '<item><title>TEST ONLY institutional statement</title><link>https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr261007~0000000001.en.html</link>' +
  '<guid>https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr261007~0000000001.en.html</guid><pubDate>Wed, 07 Oct 2026 10:00:00 +0200</pubDate></item></channel></rss>';
async function within(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TEST ONLY fixture dispatch deadline')), 2000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, { failure = null, held = false } = {}) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.function('strftime', { varargs: true }, (format, value, modifier) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    assert.ok(modifier === undefined || /^[+-]?\d+ seconds$/.test(modifier));
    return new Date(CLOCK + (modifier ? Number(modifier.split(' ')[0]) * 1000 : 0)).toISOString();
  });
  const directory = new URL('../../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) sqlite.exec(await readFile(new URL(name, directory), 'utf8'));
  const activity = { reads: 0, writes: 0, puts: 0, fetches: [], gets: 0, active: 0, maximumActive: 0, sql:[],objects:[] }, objects = new Map(),versions=new Map(), ready = gate(), finish = gate();
  let sequence = Promise.resolve(),serial=0;
  const db = { withSession(value) { assert.equal(value, 'first-primary'); return this; },
    prepare(sql) { const bind = (...values) => ({ sql, values, async all() {
      assert.ok(values.length <= 100); const statement = sqlite.prepare(sql);
      const read = /^\s*(SELECT|WITH)\b/.test(sql);
      activity.sql.push({sql,values,read});
      if (read || /\bRETURNING\b/i.test(sql)) {
        const results = statement.all(...values), write = !read;
        if (write) activity.writes++; else activity.reads++;
        return { success: true, results, meta: { changes: write ? Number(sqlite.prepare('SELECT changes() AS n').get().n) : 0 } };
      }
      activity.writes++; return { success: true, results: [], meta: { changes: Number(statement.run(...values).changes) } };
    } }); return { ...bind(), bind }; },
    batch(statements) { assert.ok(statements.length <= 32); const operation = sequence.then(async () => {
      sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }); sequence = operation.catch(() => {}); return operation; },
  };
  const env = { EARTH_DB: db, EARTH_USGS_LIVE_DAY_ENABLED:'1', EARTH_STORE: {
    async get(key) { activity.gets++;activity.objects.push({operation:'get',key});const saved = objects.get(key),bytes=saved?new Uint8Array(saved):null;
      return bytes ? { etag:versions.get(key),size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null; },
    async put(key, value, options={}) { activity.puts++;activity.objects.push({operation:'put',key,options});
      const condition=options.onlyIf;
      if (condition?.get?.('if-none-match') === '*' && objects.has(key) || condition?.etagMatches&&condition.etagMatches!==versions.get(key)) return null;
      const bytes = typeof value === 'string' ? UTF8.encode(value) : new Uint8Array(value); objects.set(key, new Uint8Array(bytes));
      const etag=`fixture-${++serial}`;versions.set(key,etag);return { etag }; },
  } };
  const fetchImpl = async (url, options) => {
    const plugin = SOURCE_PLUGINS.find(item => item.sourceUrl === url); assert.ok(plugin, 'runner admits only reviewed fixed source URLs');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); options.signal.throwIfAborted();
    activity.fetches.push(plugin.pluginId); activity.active++; activity.maximumActive = Math.max(activity.maximumActive, activity.active);
    if (activity.fetches.length === PLUGIN_RUNNER_LIMITS.concurrentSources) ready.resolve();
    try {
      if (held) await finish.promise;
      options.signal.throwIfAborted();
      if (plugin.pluginId === failure) return new Response('TEST ONLY provider failure', { status: 503 });
      if(plugin.kind==='observation-feed')return Response.json({type:'FeatureCollection',metadata:{generated:CLOCK,count:1,status:200,url:plugin.sourceUrl},
        features:[{type:'Feature',id:'testrunner',geometry:{type:'Point',coordinates:[4,50,12]},properties:{mag:3,time:CLOCK-1000,updated:CLOCK,type:'earthquake',
          status:'reviewed',url:'https://earthquake.usgs.gov/earthquakes/eventpage/testrunner'}}]});
      return plugin.kind === 'dataset' ? new Response(gas, { headers: { 'content-type': 'application/json' } }) :
        new Response(plugin.pluginId === 'ec-press-v1' ? ec : ecb, { headers: { 'content-type': 'application/rss+xml' } });
    } finally { activity.active--; }
  };
  const quiet = () => { assert.deepEqual(activity.fetches, []); assert.equal(activity.reads, 0); assert.equal(activity.writes, 0); assert.equal(activity.puts, 0); assert.equal(activity.gets, 0); };
  return { env, activity, fetchImpl, quiet, ready, finish, sqlite, objects,versions,options: { now, fetchImpl },
    reset(){activity.fetches.length=0;activity.reads=0;activity.writes=0;activity.puts=0;activity.gets=0;activity.sql.length=0;activity.objects.length=0;},
    count(table) { return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); } };
}

test('without a successfully registered waitUntil task the runner starts no source, storage or SQL work', async t => {
  const f = await fixture(t);
  assert.deepEqual(startSourcePlugins(f.env, {}, f.options), { scheduled: false, status: 'background_unavailable' });
  let operation;
  assert.deepEqual(startSourcePlugins(f.env, { waitUntil(value) { operation = value; throw Error('TEST ONLY registration rejected'); } }, f.options),
    { scheduled: false, status: 'background_unavailable' });
  assert.equal(await operation, null); f.quiet();
});

test('pre-cancellation and cancellation inside synchronous registration prevent acquisition and mutations', async t => {
  const f = await fixture(t), stopped = new AbortController(); stopped.abort();
  assert.deepEqual(startSourcePlugins(f.env, { waitUntil() { assert.fail('pre-cancelled work cannot register'); } }, { ...f.options, signal: stopped.signal }),
    { scheduled: false, status: 'cancelled' });
  const caller = new AbortController(); let operation;
  const status = startSourcePlugins(f.env, { waitUntil(value) { operation = value; caller.abort(); } }, { ...f.options, signal: caller.signal });
  assert.equal(status.scheduled, true); const result = await operation;
  assert.equal(result.results.length, SOURCE_PLUGINS.length); assert.ok(result.results.every(item => !item.acquired)); f.quiet();
});

test('registered independent source checks persist the other fixed source when either provider fails', async t => {
  for (const failure of SOURCE_PLUGINS.map(plugin => plugin.pluginId)) {
    const f = await fixture(t, { failure }); let operation;
    const admitted = startSourcePlugins(f.env, { waitUntil(value) { operation = value; } }, f.options);
    assert.equal(admitted.scheduled, true); assert.equal(admitted.pluginCount, SOURCE_PLUGINS.length);
    const result = await operation;
    assert.deepEqual([...f.activity.fetches].sort(), SOURCE_PLUGINS.map(plugin => plugin.pluginId).sort());
    assert.equal(result.results.find(item => item.pluginId === failure).status, 'retry');
    const successful = result.results.filter(item => item.pluginId !== failure);
    assert.ok(successful.every(item => item.status === 'stored' && item.changed));
    assert.equal(f.count('earth_plugin_captures'), successful.length);
    assert.equal(f.count('earth_plugin_heads'), successful.reduce((sum, item) => sum + (item.pluginId === 'ec-press-v1' ? 10 : 1), 0));
    assert.equal(f.count('earth_investigation_jobs'), 0); assert.equal(f.count('earth_world_captures'), 0);
  }
});

test('coalesced wakes reuse exactly one retained operation; a rejected second registration cannot disturb existing work', async t => {
  const f = await fixture(t, { held: true }); let first, second;
  t.after(() => f.finish.resolve());
  assert.equal(startSourcePlugins(f.env, { waitUntil(value) { first = value; } }, f.options).scheduled, true);
  await within(f.ready.promise);
  assert.equal(f.activity.fetches.length, 2); assert.equal(f.activity.maximumActive, 2);
  assert.deepEqual(startSourcePlugins(f.env, { waitUntil(value) { second = value; } }, f.options), { scheduled: false, status: 'already_running' });
  assert.equal(first, second);
  let rejected;
  try { rejected = startSourcePlugins(f.env, { waitUntil() { throw Error('TEST ONLY coalesced registration rejected'); } }, f.options); }
  finally { f.finish.resolve(); }
  assert.deepEqual(rejected, { scheduled: false, status: 'background_unavailable' });
  const result = await first; assert.ok(result.results.every(item => item.status === 'stored'));
  assert.equal(f.activity.fetches.length, SOURCE_PLUGINS.length); assert.equal(f.count('earth_plugin_captures'), SOURCE_PLUGINS.length);
  assert.equal(f.activity.maximumActive, 2); assert.equal(f.activity.active, 0);
});

test('one shared wake deadline defers a queued source without acquiring or writing its state', async t => {
  const f = await fixture(t, { held: true }); t.after(() => f.finish.resolve());
  const result = await advanceSourcePlugins(f.env, { ...f.options, deadlineMs: 100 });
  assert.equal(f.activity.fetches.length, 2); assert.equal(f.activity.maximumActive, 2);
  const queued = SOURCE_PLUGINS[2];
  assert.equal(result.results[2].pluginId, queued.pluginId); assert.equal(result.results[2].status, 'deferred');
  assert.equal(result.results[2].acquired, false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_plugin_state WHERE plugin_id=?').get(queued.pluginId).n, 0);
  assert.equal(f.count('earth_plugin_captures'), 0);
  f.finish.resolve();
  await assert.rejects(advanceSourcePlugins(f.env, { ...f.options, deadlineMs: 27001 }), TypeError);
});

test('warm not-due source wakes verify reconstructable metadata without provider, membership, factual-body or evidence work', async t => {
  const f = await fixture(t); const stored = await advanceSourcePlugins(f.env, f.options);
  assert.ok(stored.results.every(item => item.status === 'stored'));
  assert.equal(stored.results.find(item=>item.pluginId==='usgs-live-day-m2-5-v1').preparation.status,'prepared');
  f.reset();
  const checked = await advanceSourcePlugins(f.env, f.options);
  assert.ok(checked.results.every(item => item.status === 'not-due' && !item.acquired));
  assert.equal(checked.results.find(item=>item.pluginId==='usgs-live-day-m2-5-v1').preparation.status,'ready');
  assert.equal(f.activity.reads, SOURCE_PLUGINS.length+1); assert.deepEqual(f.activity.fetches, []);
  assert.equal(f.activity.writes, 0); assert.equal(f.activity.puts, 0); assert.equal(f.activity.gets, 1);
  assert.deepEqual(f.activity.objects,[{operation:'get',key:PREPARED_USGS_KEYS.current}]);
  assert.equal(f.activity.sql.filter(item=>item.sql.startsWith('SELECT * FROM earth_plugin_state WHERE plugin_id=?')).length,SOURCE_PLUGINS.length);
  assert.equal(f.activity.sql.filter(item=>item.sql.startsWith('SELECT c.*')).length,1);
  assert.equal(f.activity.sql.some(item=>/earth_plugin_membership|earth_plugin_revisions/.test(item.sql)),false);
});

test('an authorized not-due wake repairs a missing derivative using retained facts, without another immutable source publication',async t=>{
  const f=await fixture(t),stored=await advanceSourcePlugins(f.env,f.options);
  assert.equal(stored.results.find(item=>item.pluginId==='usgs-live-day-m2-5-v1').preparation.status,'prepared');
  const tables=['earth_plugin_captures','earth_plugin_revisions','earth_plugin_membership','earth_plugin_heads'];
  const before=tables.map(table=>f.count(table));
  f.objects.delete(PREPARED_USGS_KEYS.current);f.versions.delete(PREPARED_USGS_KEYS.current);f.reset();
  const repaired=await advanceSourcePlugins(f.env,f.options),source=repaired.results.find(item=>item.pluginId==='usgs-live-day-m2-5-v1');
  assert.ok(repaired.results.every(item=>item.status==='not-due'&&!item.acquired));assert.equal(source.preparation.status,'prepared');
  assert.deepEqual(f.activity.fetches,[]);assert.equal(f.activity.writes,0);assert.deepEqual(tables.map(table=>f.count(table)),before);
  assert.equal(f.activity.reads,SOURCE_PLUGINS.length+7);assert.equal(f.activity.gets,4);assert.equal(f.activity.puts,1);
  const writes=f.activity.objects.filter(item=>item.operation==='put');
  assert.equal(writes[0].key,PREPARED_USGS_KEYS.current);assert.equal(writes[0].options.onlyIf.get('if-none-match'),'*');
  assert.equal(f.activity.objects.some(item=>item.operation==='put'&&item.key.startsWith('plugins/')),false);
  const gets=f.activity.objects.filter(item=>item.operation==='get').map(item=>item.key);
  assert.equal(gets.filter(key=>key.startsWith('plugins/')&&key.includes('/facts/')).length,1);
  assert.equal(gets.filter(key=>key.startsWith('plugins/')&&key.includes('/artifacts/')).length,1);
  assert.equal(f.objects.has(PREPARED_USGS_KEYS.current),true);
});

test('the default-disabled scientific source performs no provider or state work until explicit owner enablement',async t=>{
  const f=await fixture(t);delete f.env.EARTH_USGS_LIVE_DAY_ENABLED;
  const result=await advanceSourcePlugins(f.env,f.options),id='usgs-live-day-m2-5-v1';
  assert.equal(result.results.find(value=>value.pluginId===id).status,'disabled');assert.ok(!f.activity.fetches.includes(id));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_plugin_state WHERE plugin_id=?').get(id).n,0);
  f.env.EARTH_USGS_LIVE_DAY_ENABLED='1';const enabled=await advanceSourcePlugins(f.env,f.options);
  assert.equal(enabled.results.find(value=>value.pluginId===id).status,'stored');assert.equal(f.activity.fetches.at(-1),id);
});
