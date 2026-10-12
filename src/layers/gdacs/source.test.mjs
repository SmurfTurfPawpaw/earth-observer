import test from 'node:test';
import assert from 'node:assert/strict';
import { createGdacsNoticeSource, GDACS_CACHE_KEY, GDACS_BROWSER_LIMITS } from './source.js';
import { canonicalDiscoveryRecord } from '../../core/discovery-index.js';
import { createWorldSourceItem } from '../../core/world-model.js';
import { worldHash } from '../../core/world-identity.js';
import { GDACS_SOURCE_ITEM_LIMITS } from '../../core/gdacs-source-items.js';

const AT = '2026-10-12T03:30:00.000Z', PUBLISHED = '2026-10-12T03:30:01.000Z', READ = '2026-10-12T03:30:02.000Z', NOW = Date.parse(READ);
async function cohort({ empty = false, corrected = false } = {}) {
  const records = empty ? [] : [canonicalDiscoveryRecord({ id: 'gdacs:FL:1001:1', sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report', category: 'disasters',
    title: corrected ? 'TEST ONLY corrected flood notice' : 'TEST ONLY flood notice', eventType: 'FL', alertLevel: 'Orange', country: 'Belgium',
    url: 'https://www.gdacs.org/report.aspx?eventid=1001&episodeid=1&eventtype=FL', lat: 50, lon: 4,
    observedAt: '2026-10-11T10:00:00.000Z', eventEndAt: '2026-10-13T11:00:00.000Z', updatedAt: '2026-10-12T02:00:00.000Z', retrievedAt: AT })];
  const normalized = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] }, snapshotId = await worldHash({ ...normalized,
    records: records.map(({ retrievedAt: _retrievedAt, ...record }) => record) });
  const receipt = { sourceId: 'gdacs', snapshotId, bodySha256: await worldHash(normalized), capturedAt: AT, publishedAt: PUBLISHED, recordCount: records.length };
  return { schemaVersion: 1, kind: 'source-item-cohort', configured: true, available: true, mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: PUBLISHED }), readAt: READ, cohort: receipt,
    items: await Promise.all(records.map(async record => ({ ...await createWorldSourceItem(record, { snapshotId, capturedAt: AT, recordedAt: PUBLISHED }),
      origin: { snapshotId: 'a'.repeat(64), firstCapturedAt: AT, firstRecordedAt: PUBLISHED, validation: 'retained-revision-index-only', bodyValidated: false } }))),
    counts: { returned: records.length, mapped: records.length, unmapped: 0 },
    coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100, completeRetainedCohort: true, completeProviderArchive: false },
    operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
}
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function device(initial) {
  const writes = []; let reads = 0;
  return { writes, get reads() { return reads; }, get: async key => { assert.equal(key, GDACS_CACHE_KEY); reads++; return structuredClone(initial); },
    put: async (key, value) => { assert.equal(key, GDACS_CACHE_KEY); writes.push(structuredClone(value)); } };
}

test('both application mounts read one fixed stored cohort and retain unknown freshness, dates and source episodes', async () => {
  const value = await cohort();
  for (const baseUrl of ['/', '/earth/']) {
    const calls = [], store = device(), source = createGdacsNoticeSource({ now: () => NOW, baseUrl, store,
      fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); return reply(value); } });
    const result = await source.getSnapshot(); assert.deepEqual(calls, [`${baseUrl}api/world/source-items?source=gdacs`]);
    assert.deepEqual(result.cohort, value.cohort); assert.deepEqual(result.items, value.items); assert.deepEqual(result.operational, { status: 'unknown', checkedAt: null });
    assert.equal(result.items[0].record.eventEndAt, '2026-10-13T11:00:00.000Z'); assert.equal(result.items[0].origin.bodyValidated, false); assert.equal(store.writes.length, 1);
  }
});

test('validated device metadata paints before a delayed read without claiming a source check; bad fresh data preserves it', async () => {
  const value = await cohort(), store = device({ schemaVersion: 1, savedAt: NOW - 60000, snapshot: value }), started = Promise.withResolvers(), network = Promise.withResolvers(), paints = [];
  const source = createGdacsNoticeSource({ now: () => NOW, store, fetchImpl: () => { started.resolve(); return network.promise; } });
  const pending = source.getSnapshot({ onCached: cached => paints.push(cached) }); await started.promise;
  assert.equal(paints.length, 1); assert.equal(paints[0].browserCache, 'STALE'); assert.equal(paints[0].cohort.publishedAt, PUBLISHED);
  assert.equal(paints[0].operational.checkedAt, null);
  const bad = structuredClone(value); bad.operational.checkedAt = READ; network.resolve(reply(bad));
  await assert.rejects(pending, /coverage|freshness/); assert.equal(store.writes.length, 0);
});

test('collection invalidation is idempotent, aborts pending cache/read work and suppresses older cache on its replacement', async () => {
  const value = await cohort(), newer = await cohort({ corrected: true }), cache = Promise.withResolvers(); let paints = 0, fetches = 0, writes = 0;
  const source = createGdacsNoticeSource({ now: () => NOW, store: { get: () => cache.promise, put: () => { writes++; } }, fetchImpl: async () => { fetches++; return reply(newer); } });
  const pending = source.getSnapshot({ onCached: () => { paints++; } }); source.invalidate(); source.invalidate();
  await assert.rejects(pending, { name: 'AbortError' }); cache.resolve({ schemaVersion: 1, savedAt: NOW, snapshot: value }); await Promise.resolve();
  assert.equal(paints, 0); assert.equal(fetches, 0); assert.equal(writes, 0);
  const result = await source.getSnapshot({ onCached: () => { paints++; } }); assert.equal(result.version, newer.version); assert.equal(paints, 0); assert.equal(fetches, 1);
  const begun = Promise.withResolvers(), network = Promise.withResolvers(); let mode = 'initial';
  const second = createGdacsNoticeSource({ now: () => NOW, store: device(), fetchImpl: () => {
    if (mode === 'blocked') { begun.resolve(); return network.promise; } return reply(newer);
  } });
  await second.getSnapshot(); mode = 'blocked'; const oldRead = second.getSnapshot(); await begun.promise; second.invalidate();
  await assert.rejects(oldRead, { name: 'AbortError' }); network.resolve(reply(value)); mode = 'initial';
  assert.equal((await second.getSnapshot()).version, newer.version);
});

test('malformed receipts, corrected uncited facts, foreign links, partial coverage and bounded response failures never trigger providers or overwrite cache', async () => {
  const value = await cohort();
  for (const change of [v => { v.items[0].record.title = 'Uncited correction'; }, v => { v.items[0].record.url = 'https://foreign.example/report'; },
    v => { v.cohort.bodySha256 = 'b'.repeat(64); }, v => { v.coverage.completeProviderArchive = true; }, v => { v.history.replay = true; }]) {
    const bad = structuredClone(value); change(bad); const calls = [], store = device();
    const source = createGdacsNoticeSource({ now: () => NOW, store, fetchImpl: async url => { calls.push(url); return reply(bad); } });
    await assert.rejects(source.getSnapshot()); assert.deepEqual(calls, ['/api/world/source-items?source=gdacs']); assert.equal(store.writes.length, 0);
  }
  for (const response of [new Response('{}', { status: 503 }), new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(GDACS_SOURCE_ITEM_LIMITS.bytes + 1), { headers: { 'content-type': 'application/json' } })]) {
    const store = device(); await assert.rejects(createGdacsNoticeSource({ now: () => NOW, store, fetchImpl: async () => response }).getSnapshot()); assert.equal(store.writes.length, 0);
  }
});

test('expired/future cache and unavailable persistence do not block stored data; empty complete metadata is valid', async () => {
  const value = await cohort({ empty: true });
  for (const savedAt of [NOW + 1, NOW - GDACS_BROWSER_LIMITS.cacheAgeMs - 1]) {
    let paints = 0; const source = createGdacsNoticeSource({ now: () => NOW, store: device({ schemaVersion: 1, savedAt, snapshot: value }), fetchImpl: async () => reply(value) });
    const result = await source.getSnapshot({ onCached: () => { paints++; } }); assert.equal(paints, 0); assert.deepEqual(result.items, []);
  }
  const source = createGdacsNoticeSource({ now: () => NOW, store: { get: () => new Promise(() => {}), put() { throw new Error('TEST ONLY restricted device'); } }, fetchImpl: async () => reply(value) });
  assert.deepEqual((await source.getSnapshot({ onCached() {} })).counts, { returned: 0, mapped: 0, unmapped: 0 });
});

test('caller cancellation and deadline prevent late body/cache completion or durable writes', async () => {
  const value = await cohort(), controller = new AbortController(), store = device(), transport = Promise.withResolvers(), begun = Promise.withResolvers();
  const source = createGdacsNoticeSource({ now: () => NOW, store, fetchImpl: () => { begun.resolve(); return transport.promise; } });
  const pending = source.getSnapshot({ signal: controller.signal }); await begun.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  transport.resolve(reply(value)); await Promise.resolve(); assert.equal(store.writes.length, 0);
  const stalled = createGdacsNoticeSource({ now: () => NOW, store: device(), deadlineMs: 25, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(stalled.getSnapshot(), { name: 'TimeoutError' });
});
