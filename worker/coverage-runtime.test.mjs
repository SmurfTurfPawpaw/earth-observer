import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoredSectorProcessor, startCoverageWake, createCoverageStatusHandler } from './coverage-runtime.js';
import { coverageSector } from './coverage-scheduler.js';

const NOW = Date.parse('2026-10-12T11:30:00.000Z'), utc = offset => new Date(NOW + offset).toISOString();
const usgs = (records = []) => ({ available: true, stale: false,
  source: { scopeId: 'usgs-live-day-m2-5-v1', receiptId: `receipt:${'a'.repeat(64)}`, fence: 1,
    capturedAt: utc(-300000), recordedAt: utc(-290000), sourceGeneratedAt: utc(-310000) },
  prepared: { version: `prepared:${'b'.repeat(64)}`, source: { receiptId: `receipt:${'a'.repeat(64)}` }, content: { features: records.map(record => ({ record })) } } });
const gdacs = (records = []) => ({ available: true, coverage: { completeRetainedCohort: true }, version: 'c'.repeat(64),
  cohort: { capturedAt: utc(-600000), publishedAt: utc(-590000), snapshotId: 'd'.repeat(64) }, items: records.map(record => ({ record })) });

test('two retained source cohorts are read once per wake and all 120 sectors conserve mapped membership without inventing source clocks', async () => {
  let quakeReads = 0, noticeReads = 0;
  const quakes = [{ lon: 180, lat: 90 }, { lon: -180, lat: -90 }, { lon: 4.3, lat: 50.8 }];
  const notices = [{ lon: 0, lat: 0 }, { lon: -180, lat: 0 }, { lon: null, lat: null }];
  const processor = createStoredSectorProcessor({}, { now: () => NOW,
    readUsgs: async () => { quakeReads++; return usgs(quakes); }, readGdacs: async () => { noticeReads++; return gdacs(notices); } });
  let q = 0, n = 0;
  for (let id = 1; id <= 120; id++) {
    const value = await processor.processSector({ sector: coverageSector(id) });
    assert.equal(value.available, true); assert.equal(value.basis.length, 2);
    assert.equal(value.basis[0].capturedAt, utc(-300000)); assert.equal(value.basis[1].capturedAt, utc(-600000));
    assert.equal(value.basis[0].completeRetainedCohort, true); assert.match(value.summary.meaning, /not new source/);
    q += value.basis[0].selectedCount; n += value.basis[1].selectedCount;
  }
  assert.equal(q, 3); assert.equal(n, 2); assert.equal(quakeReads, 1); assert.equal(noticeReads, 1);
});

test('partial source readiness is explicit; no complete retained basis leaves successful processing unavailable', async () => {
  const partial = createStoredSectorProcessor({}, { now: () => NOW, readUsgs: async () => usgs(), readGdacs: async () => { throw Error('pending'); } });
  const value = await partial.processSector({ sector: coverageSector(1) });
  assert.equal(value.available, true); assert.equal(value.basis.length, 1); assert.deepEqual(value.summary.missingSources, ['gdacs']);
  const none = createStoredSectorProcessor({}, { readUsgs: async () => ({ available: false }), readGdacs: async () => ({ available: false }) });
  assert.equal((await none.processSector({ sector: coverageSector(1) })).available, false);
});

test('one stored reader ignoring cancellation cannot hold the wake or hide a ready independent source', async () => {
  const processor = createStoredSectorProcessor({}, { now: () => NOW, sourceReadMs: 10,
    readUsgs: async () => usgs(), readGdacs: async () => new Promise(() => {}) });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const value = await processor.processSector({ sector: coverageSector(1) });
    assert.equal(value.available, true); assert.equal(value.basis.length, 1);
    assert.deepEqual(value.summary.missingSources, ['gdacs']);
    assert.deepEqual(await processor.urgentSectors(), []);
  } finally { clearTimeout(keepAlive); }
});

test('source rules admit bounded investigation priorities, never inferred global impact or renewed event timestamps', async () => {
  const processor = createStoredSectorProcessor({}, { now: () => NOW,
    readUsgs: async () => usgs([{ lon: 4, lat: 51, eventType: 'earthquake', mag: 6.1, updatedAt: NOW - 10000 },
      { lon: 80, lat: 20, eventType: 'earthquake', mag: 7.1, updatedAt: NOW - 3600001 },
      { lon: 0, lat: 10, eventType: 'explosion', mag: 7, updatedAt: NOW - 10000 }]),
    readGdacs: async () => gdacs([{ lon: -80, lat: 40, alertLevel: 'Red', updatedAt: utc(-20000) },
      { lon: 100, lat: 0, alertLevel: 'Red', updatedAt: utc(1000) }]),
  });
  const jobs = await processor.urgentSectors(); assert.equal(jobs.length, 2);
  assert.ok(jobs.every(job => job.reason === 'urgent' && Object.keys(job).length === 4));
  assert.ok(jobs.every(job => Date.parse(job.expiresAt) <= NOW + 3600000));
  assert.ok(!JSON.stringify(jobs).includes('impact'));
});

test('background registration is required and durable not-due admission performs no source or priority work', async () => {
  let calls = 0, queued = [], sourceReads = 0, enqueues = 0;
  const env = { EARTH_DB: { prepare() {}, batch() {} }, EARTH_STORE: { get() {} } };
  const options = { now: () => NOW, processorFactory() { return { processSector() { sourceReads++; }, urgentSectors() { sourceReads++; return []; } }; },
    run: async () => { calls++; return { configured: true, status: 'not-due' }; }, enqueue: async () => { enqueues++; } };
  assert.equal(startCoverageWake(env, {}, options).scheduled, false); assert.equal(calls, 0);
  assert.equal(startCoverageWake(env, { waitUntil(p) { queued.push(p); } }, options).scheduled, true);
  await Promise.all(queued); assert.equal(calls, 1); assert.equal(sourceReads, 0); assert.equal(enqueues, 0);
  assert.equal(startCoverageWake(env, { waitUntil() { throw Error('not registered'); } }, options).scheduled, false);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('a timed-out admitted wake skips urgent work and releases isolate admission for the next independent wake', async () => {
  let queued = [], reads = 0, runs = 0;
  const env = { EARTH_DB: { prepare() {}, batch() {} }, EARTH_STORE: { get() {} } };
  const options = { processorFactory() { return { processSector() {}, urgentSectors() { reads++; return new Promise(() => {}); } }; },
    run: async () => { runs++; return { configured: true, admitted: true, status: 'deadline' }; } };
  const ctx = { waitUntil(p) { queued.push(p); } };
  assert.equal(startCoverageWake(env, ctx, options).scheduled, true); await Promise.all(queued);
  assert.equal(reads, 0); queued = [];
  assert.equal(startCoverageWake(env, ctx, options).scheduled, true); await Promise.all(queued);
  assert.equal(runs, 2); assert.equal(reads, 0);
});

test('coverage status owns its route, rejects writes/query injection before reads and bounds public output', async () => {
  let reads = 0; const handler = createCoverageStatusHandler({ read: async () => { reads++; return { configured: true, available: true, sectors: [] }; } });
  const request = (path = '', method = 'GET') => new Request(`https://owned.example/api/coverage/status${path}`, { method });
  assert.equal((await handler(request('', 'POST'), {})).status, 405);
  assert.equal((await handler(request('?sector=1'), {})).status, 400); assert.equal(reads, 0);
  assert.equal((await handler(request(), {})).status, 200); assert.equal(reads, 1);
  assert.equal(await handler(new Request('https://owned.example/api/other'), {}), null);
  const oversized = createCoverageStatusHandler({ read: async () => ({ configured: true, text: 'x'.repeat(300000) }) });
  assert.equal((await oversized(request(), {})).status, 503);
});
