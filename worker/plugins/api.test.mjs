import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginApiHandler } from './api.js';
import { createEarthRuntime } from '../index.js';
import { pluginBytesDigest, pluginJson } from '../../src/core/plugin-evidence.js';

const CLOCK = Date.parse('2026-10-12T02:00:00.000Z'), now = () => CLOCK;
const stamp = offset => new Date(CLOCK + offset).toISOString();
const paths = ['/api/dossiers/belgium-natural-gas-origins', '/api/publications'];
const request = (path, method = 'GET') => new Request(`https://test.invalid${path}`, { method });

function activityGuard(t) {
  const activity = { fetches: 0, writes: 0, tasks: 0, puts: 0, reads: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { activity.fetches++; throw Error('TEST ONLY public reads cannot acquire'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { EARTH_DB: {
    withSession(value) { assert.equal(value, 'first-primary'); return this; },
    prepare(sql) { assert.match(sql.trim(), /^(SELECT|WITH)\b/); return { bind(...values) { return {
      async all() { activity.reads.push({ sql, values }); throw Error('TEST ONLY unavailable migration'); },
    }; } }; },
    async batch() { activity.writes++; throw Error('TEST ONLY public mutation forbidden'); },
  }, EARTH_STORE: {
    async get() { throw Error('TEST ONLY unexpected object read'); },
    async put() { activity.puts++; throw Error('TEST ONLY public mutation forbidden'); },
  } };
  const quiet = () => { assert.equal(activity.fetches, 0); assert.equal(activity.writes, 0); assert.equal(activity.puts, 0); assert.equal(activity.tasks, 0); };
  return { activity, env, quiet, ctx: { waitUntil() { activity.tasks++; throw Error('TEST ONLY public background work forbidden'); } } };
}

test('foreign routes are not consumed; admitted endpoints reject every non-GET method without storage or provider work', async t => {
  const f = activityGuard(t), handle = createPluginApiHandler({ now });
  assert.equal(await handle(request('/api/publications-extra'), f.env), null);
  for (const path of paths) for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await handle(request(path, method), f.env);
    assert.equal(response.status, 405, `${method} ${path}`); assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(f.activity.reads.length, 0); f.quiet();
});

test('malformed, duplicate and foreign query fields are rejected before database access', async t => {
  const f = activityGuard(t), handle = createPluginApiHandler({ now });
  const invalid = [
    ...['plugin=ecb-press-v1', 'limit=1', 'at=2026-10-12T02%3A00%3A00.000Z', 'knownAt=x&knownAt=x', 'url=https%3A%2F%2Fevil.invalid'].map(query => `${paths[0]}?${query}`),
    ...['plugin=', 'plugin=eurostat-gas-origins-v1', 'plugin=ecb-press-v1&plugin=ecb-press-v1',
      'limit=20&limit=20', 'limit=', 'limit=0', 'limit=01', 'limit=41', 'limit=100', 'limit=1.0', 'limit=-1',
      'limit=20&sourceUrl=x', 'knownAt=x&knownAt=x', 'at=x&at=x', '__proto__=x'].map(query => `${paths[1]}?${query}`),
    `${paths[1]}?knownAt=${'x'.repeat(513)}`,
  ];
  for (const path of invalid) assert.equal((await handle(request(path), f.env)).status, 400, path);
  assert.equal(f.activity.reads.length, 0); f.quiet();
});

test('knowledge and publication cutoffs require exact valid UTC milliseconds and reject distant future dates', async t => {
  const f = activityGuard(t), handle = createPluginApiHandler({ now });
  const badDates = ['', '2026-10-12', '2026-10-12T02:00:00Z', '2026-10-12T02:00:00.000+00:00',
    '2026-02-30T00:00:00.000Z', '2026-10-12T24:00:00.000Z', stamp(300001), 'not-a-date'];
  for (const value of badDates) for (const [path, field] of [[paths[0], 'knownAt'], [paths[1], 'knownAt'], [paths[1], 'at']])
    assert.equal((await handle(request(`${path}?${field}=${encodeURIComponent(value)}`), f.env)).status, 400, `${field}=${value}`);
  assert.equal(f.activity.reads.length, 0); f.quiet();
});

test('unconfigured and missing-migration public GETs explain unavailable evidence without acquisition or background work', async t => {
  const f = activityGuard(t), handle = createPluginApiHandler({ now });
  for (const env of [{}, f.env]) for (const path of [paths[0], `${paths[1]}?limit=1`, `${paths[1]}?limit=40&knownAt=${encodeURIComponent(stamp(-1))}&at=${encodeURIComponent(stamp(-1000))}`]) {
    const response = await handle(request(path), env), body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.available, false); assert.equal(body.configured, false);
    assert.equal(body.receipt, null); assert.equal(body.artifact, null); assert.equal(body.schemaVersion, 1);
    if (path.startsWith(paths[1])) assert.deepEqual(body.items, []);
  }
  f.quiet();
});

test('Commission is an explicit stored-only publication scope with the same mounted method and cutoff limits', async t => {
  const f = activityGuard(t), handle = createPluginApiHandler({ now });
  const path = '/api/publications?plugin=ec-press-v1&limit=20';
  const response = await handle(request(path), f.env), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.available, false); assert.equal(body.plugin.id, 'ec-press-v1');
  assert.equal(body.plugin.scopeId, 'ec-presscorner-en-metadata-v1'); assert.equal(body.plugin.kind, 'publication-feed');
  assert.deepEqual(body.items, []); assert.equal(body.receipt, null);
  assert.equal((await handle(request(path, 'POST'), f.env)).status, 405);
  assert.equal((await handle(request(`${path}&sourceUrl=https://evil.example`), f.env)).status, 400);
  assert.equal((await handle(request(`${path}&knownAt=2026-10-10T00:00:00Z`), f.env)).status, 400);
  f.quiet();
});

test('the mounted /earth plugin endpoints preserve stored-only and method admission instead of falling through to provider services', async t => {
  const f = activityGuard(t), runtime = createEarthRuntime({ now, cache: null,
    fetchImpl: async () => { f.activity.fetches++; throw Error('TEST ONLY provider fallback forbidden'); } });
  t.after(() => runtime.close());
  for (const path of paths) {
    const response = await runtime.fetch(request(`/earth${path}`), f.env, f.ctx);
    assert.equal(response.status, 200); assert.equal((await response.json()).available, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await runtime.fetch(request(`/earth${path}`, 'POST'), f.env, f.ctx)).status, 405);
    assert.equal((await runtime.fetch(request(`/earth${path}?unreviewed=x`), f.env, f.ctx)).status, 400);
  }
  f.quiet();
});

test('retained artifact hash and bounded pagination deliver evidence with separate source and knowledge dates', async t => {
  const f = activityGuard(t), artifact = { schemaVersion: 1, kind: 'publication-feed-overview', items: [] };
  const bytes = new TextEncoder().encode(pluginJson(artifact)), hash = await pluginBytesDigest(bytes);
  const capture = { receipt_id: 'receipt:test-only', captured_at: stamp(-100), recorded_at: stamp(0), fence: 1,
    facts_digest: 'a'.repeat(64), raw_sha256: 'b'.repeat(64), artifact_sha256: hash, artifact_bytes: bytes.byteLength,
    source_updated_at: stamp(-1000), source_version: 'TEST ONLY RSS' };
  const publications = Array.from({ length: 3 }, (_, index) => ({ ...capture, projection_json: pluginJson({ itemId: `TEST ONLY ${index}`,
    sourceRecordId: `TEST ONLY source GUID ${index}`, title: `TEST ONLY original ${index}`, publishedAt: stamp(-10000 - index), publishedPrecision: 'second' }),
    item_id: `TEST ONLY ${index}`, first_recorded_at: stamp(0), recorded_at: stamp(0), published_at: stamp(-10000 - index) }));
  f.env.EARTH_DB.prepare = sql => ({ bind(...values) { return { async all() {
    f.activity.reads.push({ sql, values }); assert.match(sql.trim(), /^(SELECT|WITH)\b/);
    if (sql.includes('SELECT * FROM earth_plugin_state')) return { success: true, results: [] };
    if (sql.includes('SELECT * FROM earth_plugin_captures')) return { success: true, results: sql.includes('recorded_at<=?') && values.at(-1) < capture.recorded_at ? [] : [capture] };
    if (sql.includes('SELECT COUNT(*) AS count')) return { success: true, results: [{ count: publications.length }] };
    if (sql.includes('SELECT receipt_id FROM earth_plugin_captures')) return { success: true, results: [{ receipt_id: capture.receipt_id }] };
    assert.match(sql, /earth_plugin_revisions/); const limit = values.at(-1);
    assert.equal(limit, 3, 'public limit2 requests only3 rows to report more');
    return { success: true, results: publications.slice(0, limit) };
  } }; } });
  f.env.EARTH_STORE.get = async key => {
    assert.equal(key, `plugins/ecb-press-v1/artifacts/${hash}`); return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  };
  const handle = createPluginApiHandler({ now });
  const response = await handle(request(`${paths[1]}?limit=2&knownAt=${encodeURIComponent(stamp(0))}`), f.env), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.available, true); assert.deepEqual(body.counts, { returned: 2, more: true });
  assert.equal(body.receipt.recordedAt, stamp(0)); assert.equal(body.receipt.sourceUpdatedAt, stamp(-1000));
  assert.equal(body.items[0].publishedAt, stamp(-10000)); assert.equal(body.items[0].firstRecordedAt, stamp(0));
  const earlier = await handle(request(`${paths[1]}?knownAt=${encodeURIComponent(stamp(-1))}`), f.env);
  assert.equal((await earlier.json()).available, false); f.quiet();
});
