import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleDemand, pruneDemand, MAX_DEMAND_BODY_BYTES, MAX_DEMAND_DAY_BYTES } from './demand.js';

// Entirely synthetic in-memory storage. No real HTTP requests or R2 writes.
const ORIGIN = 'https://giovannicallebaut.com', NOW = Date.parse('2026-10-11T12:00:00Z');
const PREFIX = 'discovery/demand/days/';
const DAY_KEY = `${PREFIX}2026-10-11.json`;
const PAYLOAD = { subjectId: 'gkg:WB_698_TRADE', country: 'BE', consent: true };
class Bucket {
  items = new Map(); sequence = 0; writes = []; reads = []; deletes = []; lists = 0; failPut = false;
  async get(key) {
    this.reads.push(key); const previous = this.items.get(key); if (!previous) return null;
    const { text, etag } = previous;
    return { etag, size: new TextEncoder().encode(text).byteLength, async text() { return text; } };
  }
  async put(key, text, options = {}) {
    this.writes.push({ key, text, options }); if (this.failPut) return null;
    const previous = this.items.get(key), condition = options.onlyIf;
    if (condition?.get?.('if-none-match') === '*' && previous || condition?.etagMatches && previous?.etag !== condition.etagMatches) return null;
    const etag = String(++this.sequence); this.items.set(key, { text, etag }); return { key, etag };
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { this.deletes.push(key); this.items.delete(key); } }
  async list({ prefix, limit }) { this.lists++; const keys = [...this.items.keys()].filter((key) => key.startsWith(prefix)).sort(); return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit }; }
}
const environment = () => ({ EARTH_STORE: new Bucket() });
const request = (value = PAYLOAD, { origin = ORIGIN, headers = {}, body, method = 'POST', path = '/api/discovery/demand' } = {}) => new Request(`${origin}${path}`, { method,
  headers: { origin, 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: body === undefined ? JSON.stringify(value) : body } : {}) });
const get = (path = '/api/discovery/demand/summary', headers = {}) => request(null, { method: 'GET', path, headers });
const handle = (req, env) => handleDemand(req, env, { now: () => NOW });
async function seed(bucket, day, counts) { await bucket.put(`${PREFIX}${day}.json`, JSON.stringify({ version: 1, day, counts })); }

test('demand contract is production-only, same-origin, explicit consent and fixed metadata', async () => {
  const env = environment();
  assert.equal(await handle(get('/api/unrelated'), env), null);
  for (const options of [{ origin: 'http://localhost:4174' }, { origin: 'https://preview.giovannicallebaut.com' }, { headers: { origin: 'https://other.example' } }, { headers: { origin: '' } }, { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { 'x-earth-test': '1' } }, { headers: { 'x-earth-test': '' } }]) assert.equal((await handle(request(PAYLOAD, options), env)).status, 403);
  for (const value of [{ ...PAYLOAD, consent: false }, { ...PAYLOAD, consent: 'true' }, { ...PAYLOAD, q: 'private query' }, { ...PAYLOAD, lat: 50.8 }, { ...PAYLOAD, userId: 'identity' }, { ...PAYLOAD, subjectId: 'unreviewed' }, { ...PAYLOAD, country: 'ZZ' }, { ...PAYLOAD, country: 'be' }, { subjectId: 'overview:country', country: '', consent: true }, { subjectId: 'overview:all', country: 'BE', consent: true }, [], null]) assert.equal((await handle(request(value), env)).status, 400);
  assert.equal((await handle(request(PAYLOAD, { path: '/api/discovery/demand?q=raw-text' }), env)).status, 400);
  assert.equal(env.EARTH_STORE.writes.length, 0); assert.equal(env.EARTH_STORE.lists, 0);
  const accepted = await handle(request(PAYLOAD, { headers: { 'oai-authenticated-user-id': 'ignored', 'cf-connecting-ip': '192.0.2.7' } }), env);
  assert.equal(accepted.status, 202); assert.deepEqual(await accepted.json(), { enabled: true, accepted: true, unit: 'Accepted search actions, not unique people' });
  const stored = JSON.parse(env.EARTH_STORE.items.get(DAY_KEY).text);
  assert.deepEqual(stored, { version: 1, day: '2026-10-11', counts: { 'gkg:WB_698_TRADE|BE': 1 } });
  assert.doesNotMatch(JSON.stringify(env.EARTH_STORE.writes), /ignored|192\.0\.2|userId|raw-text|consent/);
  assert.equal(env.EARTH_STORE.writes[0].options.onlyIf.get('if-none-match'), '*');
  assert.equal(env.EARTH_STORE.writes[0].options.customMetadata.expiresAt, '2026-10-18T00:00:00.000Z');
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
});
test('configuration and bounded JSON failure never acknowledge or write', async () => {
  const status = await handle(get('/api/discovery/demand'), {}); assert.equal(status.status, 200); assert.equal((await status.json()).enabled, false);
  assert.equal((await handle(request(), {})).status, 503);
  assert.equal((await handle(get(), {})).status, 503);
  const env = environment();
  assert.equal((await handle(request(null, { body: 'x'.repeat(MAX_DEMAND_BODY_BYTES + 1) }), env)).status, 413);
  assert.equal((await handle(request(null, { body: '{not-json' }), env)).status, 400);
  assert.equal((await handle(request(null, { body: new Uint8Array([0xff]) }), env)).status, 400);
  assert.equal((await handle(request(null, { body: '{}', headers: { 'content-length': '999999' } }), env)).status, 413);
  assert.equal((await handle(request(null, { body: '{}', headers: { 'content-type': 'text/plain' } }), env)).status, 415);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_DEMAND_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  const chunked = new Request(`${ORIGIN}/api/discovery/demand`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal((await handle(chunked, env)).status, 413);
  assert.equal(env.EARTH_STORE.writes.length, 0);
  assert.equal((await handle(request(null, { method: 'DELETE' }), env)).status, 405);
});
test('simultaneous first claims and updates preserve every acknowledged action using bounded CAS retries', async () => {
  const env = environment();
  const first = await Promise.all(Array.from({ length: 3 }, () => handle(request(), env)));
  assert.equal(first.every((response) => response.status === 202), true);
  assert.equal(JSON.parse(env.EARTH_STORE.items.get(DAY_KEY).text).counts['gkg:WB_698_TRADE|BE'], 3);
  const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => handle(request({ ...PAYLOAD, country: index % 2 ? 'US' : 'BE' }), env)));
  assert.equal(concurrent.every((response) => [202, 503].includes(response.status)), true);
  const accepted = concurrent.filter((response) => response.status === 202).length;
  const counts = JSON.parse(env.EARTH_STORE.items.get(DAY_KEY).text).counts;
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 3 + accepted);
  assert.equal(env.EARTH_STORE.writes.every((write) => write.options.onlyIf instanceof Headers || typeof write.options.onlyIf.etagMatches === 'string'), true);
});
test('conditional put failures, missing etags and corrupt/oversized records fail closed', async () => {
  const env = environment(); env.EARTH_STORE.failPut = true;
  const rejected = await handle(request(), env); assert.equal(rejected.status, 503); assert.equal((await rejected.json()).accepted, false);
  assert.equal(env.EARTH_STORE.writes.length, 5); assert.equal(env.EARTH_STORE.items.size, 0);
  for (const text of ['not-json', JSON.stringify({ version: 1, day: '2026-10-11', counts: { 'unknown|BE': 500 } }), JSON.stringify({ version: 1, day: '2026-10-11', counts: { 'gkg:WB_698_TRADE|BE': -1 } }), 'x'.repeat(MAX_DEMAND_DAY_BYTES + 1)]) {
    const corrupt = environment(); corrupt.EARTH_STORE.items.set(DAY_KEY, { text, etag: 'record' });
    assert.equal((await handle(request(), corrupt)).status, 503); assert.equal(corrupt.EARTH_STORE.writes.length, 0);
  }
  const missing = environment(); missing.EARTH_STORE.items.set(DAY_KEY, { text: JSON.stringify({ version: 1, day: '2026-10-11', counts: {} }) });
  assert.equal((await handle(request(), missing)).status, 503); assert.equal(missing.EARTH_STORE.writes.length, 0);
  const capped = environment(); await seed(capped.EARTH_STORE, '2026-10-11', { 'gkg:WB_698_TRADE|BE': 1000000 }); capped.EARTH_STORE.writes.length = 0;
  assert.equal((await handle(request(), capped)).status, 429); assert.equal(capped.EARTH_STORE.writes.length, 0);
  const uncertain = environment(); uncertain.EARTH_STORE.put = async () => undefined;
  const unconfirmed = await handle(request(), uncertain); assert.equal(unconfirmed.status, 503); assert.equal((await unconfirmed.json()).accepted, false);
});
test('public summaries suppress groups below 300 and round down 100-action buckets across seven UTC days', async () => {
  const env = environment();
  await seed(env.EARTH_STORE, '2026-10-11', { 'gkg:WB_698_TRADE|BE': 199, 'gkg:ARMEDCONFLICT|US': 299, 'category:disasters|': 399 });
  await seed(env.EARTH_STORE, '2026-10-05', { 'gkg:WB_698_TRADE|BE': 101 });
  await seed(env.EARTH_STORE, '2026-10-04', { 'gkg:ARMEDCONFLICT|US': 10000 });
  await seed(env.EARTH_STORE, '2026-10-12', { 'gkg:ARMEDCONFLICT|US': 10000 });
  const response = await handle(get(), env), result = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(result.groups.map(({ subjectId, actions }) => [subjectId, actions]), [['category:disasters', 300], ['gkg:WB_698_TRADE', 300]]);
  assert.deepEqual(result.window, { firstDay: '2026-10-05', lastDay: '2026-10-11', days: 7 });
  assert.equal(result.minimumActions, 300); assert.equal(result.bucketSize, 100); assert.match(result.unit, /not unique people/);
  assert.equal(JSON.stringify(result).includes('ARMEDCONFLICT'), false);
  assert.equal(env.EARTH_STORE.items.has(`${PREFIX}2026-10-04.json`), false);
  assert.equal(env.EARTH_STORE.items.has(`${PREFIX}2026-10-12.json`), true);
  assert.equal((await handle(get('/api/discovery/demand/summary', { 'x-earth-test': 'qa' }), env)).status, 403);
});
test('retention pruning is bounded, scoped and exposes incomplete cleanup honestly', async () => {
  const env = environment();
  await env.EARTH_STORE.put('evidence/pending/private.json', 'private');
  for (let index = 0; index < 300; index++) { const day = new Date(NOW - (index + 8) * 86400000).toISOString().slice(0, 10); await seed(env.EARTH_STORE, day, {}); }
  await seed(env.EARTH_STORE, '2026-10-05', { 'overview:country|BE': 1 });
  const first = await pruneDemand(env, { now: () => NOW });
  assert.equal(first.complete, false); assert.equal(first.deleted, 256); assert.equal(env.EARTH_STORE.lists, 4);
  const second = await pruneDemand(env, { now: () => NOW }); assert.equal(second.complete, true); assert.equal(second.deleted, 44);
  assert.equal(env.EARTH_STORE.items.has('evidence/pending/private.json'), true); assert.equal(env.EARTH_STORE.items.has(`${PREFIX}2026-10-05.json`), true);
  assert.equal(env.EARTH_STORE.deletes.every((key) => key.startsWith(PREFIX)), true);
  assert.equal((await pruneDemand({})).enabled, false);
});
