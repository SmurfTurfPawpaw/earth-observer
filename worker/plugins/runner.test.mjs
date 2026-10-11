import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { advanceSourcePlugins, startSourcePlugins } from './runner.js';
import { SOURCE_PLUGINS } from './registry.js';

const CLOCK = Date.parse('2026-10-12T02:00:00.000Z'), now = () => CLOCK;
const UTF8 = new TextEncoder(), gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gas = new Uint8Array(await readFile(new URL('../../server/hosted/fixtures/eurostat-gas-belgium-2024.json', import.meta.url)));
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
  const activity = { reads: 0, writes: 0, puts: 0, fetches: [], gets: 0 }, objects = new Map(), ready = gate(), finish = gate();
  let sequence = Promise.resolve();
  const db = { withSession(value) { assert.equal(value, 'first-primary'); return this; },
    prepare(sql) { const bind = (...values) => ({ sql, values, async all() {
      assert.ok(values.length <= 100); const statement = sqlite.prepare(sql);
      const read = /^\s*(SELECT|WITH)\b/.test(sql);
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
  const env = { EARTH_DB: db, EARTH_STORE: {
    async get(key) { activity.gets++; const bytes = objects.get(key); return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null; },
    async put(key, value, options) { activity.puts++; if (options.onlyIf.get('if-none-match') === '*' && objects.has(key)) return null;
      const bytes = typeof value === 'string' ? UTF8.encode(value) : new Uint8Array(value); objects.set(key, bytes); return { etag: '"TEST ONLY"' }; },
  } };
  const fetchImpl = async (url, options) => {
    const plugin = SOURCE_PLUGINS.find(item => item.sourceUrl === url); assert.ok(plugin, 'runner admits only reviewed fixed source URLs');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); options.signal.throwIfAborted();
    activity.fetches.push(plugin.pluginId); if (activity.fetches.length === SOURCE_PLUGINS.length) ready.resolve();
    if (held) await finish.promise;
    options.signal.throwIfAborted();
    if (plugin.pluginId === failure) return new Response('TEST ONLY provider failure', { status: 503 });
    return plugin.kind === 'dataset' ? new Response(gas, { headers: { 'content-type': 'application/json' } }) :
      new Response(ecb, { headers: { 'content-type': 'application/rss+xml' } });
  };
  const quiet = () => { assert.deepEqual(activity.fetches, []); assert.equal(activity.reads, 0); assert.equal(activity.writes, 0); assert.equal(activity.puts, 0); assert.equal(activity.gets, 0); };
  return { env, activity, fetchImpl, quiet, ready, finish, sqlite, options: { now, fetchImpl },
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
    const successful = result.results.find(item => item.pluginId !== failure); assert.equal(successful.status, 'stored'); assert.equal(successful.changed, true);
    assert.equal(f.count('earth_plugin_captures'), 1); assert.equal(f.count('earth_plugin_heads'), 1);
    assert.equal(f.sqlite.prepare('SELECT plugin_id FROM earth_plugin_captures').get().plugin_id, successful.pluginId);
    assert.equal(f.count('earth_investigation_jobs'), 0); assert.equal(f.count('earth_world_captures'), 0);
  }
});

test('coalesced wakes reuse exactly one retained operation; a rejected second registration cannot disturb existing work', async t => {
  const f = await fixture(t, { held: true }); let first, second;
  t.after(() => f.finish.resolve());
  assert.equal(startSourcePlugins(f.env, { waitUntil(value) { first = value; } }, f.options).scheduled, true);
  await within(f.ready.promise);
  assert.deepEqual(startSourcePlugins(f.env, { waitUntil(value) { second = value; } }, f.options), { scheduled: false, status: 'already_running' });
  assert.equal(first, second);
  let rejected;
  try { rejected = startSourcePlugins(f.env, { waitUntil() { throw Error('TEST ONLY coalesced registration rejected'); } }, f.options); }
  finally { f.finish.resolve(); }
  assert.deepEqual(rejected, { scheduled: false, status: 'background_unavailable' });
  const result = await first; assert.ok(result.results.every(item => item.status === 'stored'));
  assert.equal(f.activity.fetches.length, SOURCE_PLUGINS.length); assert.equal(f.count('earth_plugin_captures'), SOURCE_PLUGINS.length);
});

test('not-due source wakes make one bounded state read per source with no provider calls or evidence writes', async t => {
  const f = await fixture(t); const stored = await advanceSourcePlugins(f.env, f.options);
  assert.ok(stored.results.every(item => item.status === 'stored'));
  f.activity.fetches.length = 0; f.activity.reads = 0; f.activity.writes = 0; f.activity.puts = 0; f.activity.gets = 0;
  const checked = await advanceSourcePlugins(f.env, f.options);
  assert.ok(checked.results.every(item => item.status === 'not-due' && !item.acquired));
  assert.equal(f.activity.reads, SOURCE_PLUGINS.length); assert.deepEqual(f.activity.fetches, []);
  assert.equal(f.activity.writes, 0); assert.equal(f.activity.puts, 0); assert.equal(f.activity.gets, 0);
});
