import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentFixture } from './document-investigation-fixture.mjs';
import { runCoverageWake, enqueueCoveragePriority, readCoverageStatus } from './coverage-scheduler.js';
import { createStoredSectorProcessor } from './coverage-runtime.js';

const migration = await readFile(new URL('../drizzle/0011_coverage_scheduler.sql', import.meta.url), 'utf8');
const catchupMigration = await readFile(new URL('../drizzle/0012_coverage_catchup.sql', import.meta.url), 'utf8');
async function fixture(t) { const f = await documentFixture(t, { documents: false }); f.sqlite.exec(migration); f.sqlite.exec(catchupMigration); return f; }
const successful = (f, sector) => ({ available: true, basis: [{ sourceId: 'usgs', scopeId: 'usgs-live-day-m2-5-v1',
  version: `prepared:${'a'.repeat(64)}`, capturedAt: f.stamp(), recordedAt: f.stamp(), selectedCount: sector.id % 3,
  completeRetainedCohort: true, coverageMeaning: 'TEST ONLY retained source subset' }], summary: { missingSources: ['gdacs'] } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('restarted minute wakes process all120 sectors in60 admissions, never more than2 baseline', async t => {
  const f = await fixture(t), visited = [];
  for (let minute = 0; minute < 60; ++minute) {
    if (minute) f.advance(60000);
    const read = await runCoverageWake({ ...f.env }, { now: f.now, processSector: ({ sector }) => { visited.push(sector.id); return successful(f, sector); } });
    assert.equal(read.status, 'processed'); assert.equal(read.baseline.length, 2); assert.equal(read.priority.length, 0);
    if (!minute) { const skip = await runCoverageWake(f.env, { now: f.now, processSector: () => assert.fail('same-minute wake admitted') });
      assert.equal(skip.admitted, false); }
  }
  assert.deepEqual(visited, Array.from({ length: 120 }, (_, i) => i + 1));
  const status = await readCoverageStatus(f.env, { now: f.now }); assert.equal(status.cursor.nextSectorId, 1); assert.equal(status.cursor.completedSweeps, 1);
  assert.equal(status.counts.successful, 120); assert.equal(status.sectors[0].lastSuccessfulAt, new Date(f.now() - 59 * 60000).toISOString());
  assert.ok(f.activity.sql.every(row => !/^\s*(CREATE|ALTER)/i.test(row.sql))); assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
});

test('UTC minute buckets tolerate timer jitter while duplicate and fresh-isolate wakes in the same bucket cannot advance', async t => {
  const f = await fixture(t); f.advance(500); const calls = [];
  const processSector = ({ sector }) => { calls.push(sector.id); return successful(f, sector); };
  const first = await runCoverageWake(f.env, { now: f.now, processSector }); assert.equal(first.admitted, true);
  assert.equal(f.sqlite.prepare('SELECT next_due_at FROM earth_coverage_state').get().next_due_at,
    new Date(f.now() + 59500).toISOString());
  f.advance(59900); const jittered = await runCoverageWake({ ...f.env }, { now: f.now, processSector });
  assert.equal(jittered.admitted, true); assert.deepEqual(calls, [1, 2, 3, 4]);
  f.advance(100); const duplicate = await runCoverageWake({ ...f.env }, { now: f.now, processSector });
  assert.equal(duplicate.admitted, false); assert.deepEqual(calls, [1, 2, 3, 4]);
  // A completed late-minute wake and an early next-minute wake are distinct
  // calendar admissions; this is not a provider-acquisition rate limiter.
  f.advance(58400); assert.equal((await runCoverageWake(f.env, { now: f.now, processSector })).admitted, false);
  f.advance(61000); const lateMinute = await runCoverageWake(f.env, { now: f.now, processSector }); assert.equal(lateMinute.admitted, true);
  f.advance(2000); const nextMinute = await runCoverageWake({ ...f.env }, { now: f.now, processSector }); assert.equal(nextMinute.admitted, true);
  assert.deepEqual(calls.slice(-4), [5, 6, 7, 8]);
});

test('lease contention and expired ignored callbacks cannot overwrite a newer successful owner', async t => {
  const f = await fixture(t); await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.advance(60000); const started = deferred(), late = deferred();
  const older = runCoverageWake(f.env, { now: f.now, processSector: async ({ sector }) => { started.resolve(); await late.promise; return successful(f, sector); } });
  await started.promise;
  const busy = await runCoverageWake({ ...f.env }, { now: f.now, processSector: () => assert.fail('concurrent lease admitted') }); assert.equal(busy.admitted, false);
  f.advance(60000); const newer = await runCoverageWake({ ...f.env }, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  assert.equal(newer.admitted, true); assert.deepEqual(newer.baseline.map(row => row.sectorId), [3, 4]);
  const stamp = f.stamp(), fence = newer.fence; late.resolve(); assert.equal((await older).status, 'superseded');
  const rows = f.sqlite.prepare('SELECT last_success_at,last_fence FROM earth_coverage_cells WHERE sector_id IN(3,4)').all();
  assert.ok(rows.every(row => row.last_success_at === stamp && row.last_fence === fence));
});

test('baseline failure retains its last complete data and cannot starve quiet sectors or the bounded priority lane', async t => {
  const f = await fixture(t);
  await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  const first = f.sqlite.prepare('SELECT * FROM earth_coverage_cells WHERE sector_id=1').get();
  f.sqlite.prepare('UPDATE earth_coverage_state SET next_sector=1').run(); f.advance(60000);
  for (const sectorId of [8, 9, 10]) await enqueueCoveragePriority(f.env,
    { sectorId, reason: 'urgent', priority: 90, expiresAt: new Date(f.now() + 3600000).toISOString() }, { now: f.now });
  const attempted = [];
  const failure = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector, lane }) => { attempted.push([sector.id, lane]);
    return sector.id === 1 ? { available: false } : successful(f, sector); } });
  assert.deepEqual(attempted, [[1, 'baseline'], [2, 'baseline'], [8, 'priority'], [9, 'priority']]);
  assert.equal(failure.baseline[0].status, 'unavailable');
  const retained = f.sqlite.prepare('SELECT * FROM earth_coverage_cells WHERE sector_id=1').get();
  assert.equal(retained.status, 'error'); assert.equal(retained.last_success_at, first.last_success_at); assert.equal(retained.source_basis_json, first.source_basis_json);
  assert.equal(f.sqlite.prepare('SELECT next_sector FROM earth_coverage_state').get().next_sector, 3);
  f.advance(60000); const next = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  assert.deepEqual(next.baseline.map(row => row.sectorId), [3, 4]); assert.deepEqual(next.priority.map(row => row.sectorId), [10]);
});

test('clock rollback and long offline intervals cap debt and never fabricate missed completions or run catchup loops', async t => {
  const f = await fixture(t); await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.advance(-60000); const skipped = await runCoverageWake(f.env, { now: f.now, processSector: () => assert.fail('rollback processing') }); assert.equal(skipped.admitted, false);
  f.advance(86460000); let calls = 0;
  const result = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => { calls++; return successful(f, sector); } });
  assert.equal(calls, 4); assert.deepEqual(result.baseline.map(row => row.sectorId), [3, 4]);
  assert.deepEqual(result.catchup.map(row => row.sectorId), [5, 6]);
  assert.equal(result.catchupSlotsAtAdmission, 120); assert.equal(result.catchupSlotsRemaining, 118);
  const status = await readCoverageStatus(f.env, { now: f.now }); assert.equal(status.counts.successful, 6);
  assert.equal(status.catchup.pendingSlots, 118); assert.equal(status.catchup.maximumTasksPerWake, 4);
  assert.equal(status.cursor.nextWakeDueAt, new Date(f.now() + 60000).toISOString()); assert.equal(status.sectors[2].lastSuccessfulAt, f.stamp());
  assert.ok(status.sectors.slice(2, 6).every(row => row.lastSuccessfulAt === f.stamp()));
  assert.ok(status.sectors.slice(6).every(row => row.lastAttemptAt === null));
});

test('abort during ignored callback admits no partial result and pre-aborted wake has no SQL or source work', async t => {
  const f = await fixture(t), controller = new AbortController(), entered = deferred(), late = deferred();
  const pending = runCoverageWake(f.env, { now: f.now, signal: controller.signal,
    processSector: async ({ sector }) => { entered.resolve(); await late.promise; return successful(f, sector); } });
  await entered.promise; controller.abort(); const result = await pending; assert.equal(result.status, 'cancelled');
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_cells WHERE last_success_at IS NOT NULL').get().n; assert.equal(before, 0);
  late.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_cells WHERE last_success_at IS NOT NULL').get().n, 0);
  f.reset(); const stop = await runCoverageWake(f.env, { now: f.now, signal: controller.signal, processSector: () => assert.fail('aborted source work') });
  assert.equal(stop.status, 'cancelled'); assert.equal(f.activity.sql.length, 0);
});

test('one stalled sector times out independently, advances baseline and cannot later publish over quiet sectors', async t => {
  const f = await fixture(t), late = deferred(), calls = [];
  const result = await runCoverageWake(f.env, { now: f.now, processMs: 10, processSector: async ({ sector, signal }) => {
    calls.push(sector.id); if (sector.id === 1) { await late.promise; signal.throwIfAborted(); } return successful(f, sector); } });
  assert.deepEqual(calls, [1, 2]); assert.equal(result.status, 'processed');
  assert.equal(result.baseline[0].errorCode, 'processing-timeout'); assert.equal(result.baseline[1].status, 'processed');
  assert.equal(f.sqlite.prepare('SELECT next_sector FROM earth_coverage_state').get().next_sector, 3);
  assert.equal(f.sqlite.prepare('SELECT last_success_at FROM earth_coverage_cells WHERE sector_id=1').get().last_success_at, null);
  assert.equal(f.sqlite.prepare('SELECT last_success_at FROM earth_coverage_cells WHERE sector_id=2').get().last_success_at, f.stamp());
  late.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sqlite.prepare('SELECT last_success_at FROM earth_coverage_cells WHERE sector_id=1').get().last_success_at, null);
});

test('one or several missed early UTC minutes are repaid within four actual tasks per resumed wake', async t => {
  for (const missed of [[5], [5, 6, 7]]) {
    const f = await fixture(t), seen = [], start = f.now(); let admissions = 0;
    for (let minute = 0; minute < 60; minute++) {
      f.setClock(start + minute * 60000); if (missed.includes(minute)) continue;
      const result = await runCoverageWake({ ...f.env }, { now: f.now, processSector: ({ sector }) => {
        seen.push(sector.id); return successful(f, sector); } });
      admissions++; assert.equal(result.baseline.length, 2);
      assert.ok(result.baseline.length + result.catchup.length + result.priority.length <= 4);
      assert.ok(result.catchup.length <= 2);
    }
    assert.equal(admissions, 60 - missed.length);
    assert.deepEqual(seen, Array.from({ length: 120 }, (_, index) => index + 1));
    const status = await readCoverageStatus(f.env, { now: f.now });
    assert.equal(status.cursor.completedSweeps, 1); assert.equal(status.cursor.nextSectorId, 1);
    assert.equal(status.catchup.pendingSlots, 0); assert.equal(status.counts.successful, 120);
    assert.ok(status.sectors.every(row => !missed.some(minute => row.lastAttemptAt === new Date(start + minute * 60000).toISOString())));
    assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
  }
});

test('priority remains ahead of optional catchup and residual debt survives subsequent admitted minutes', async t => {
  const f = await fixture(t), calls = [];
  await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.advance(240000);
  for (const sectorId of [60, 70]) await enqueueCoveragePriority(f.env,
    { sectorId, reason: 'urgent', priority: 90, expiresAt: new Date(f.now() + 3600000).toISOString() }, { now: f.now });
  const result = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector, lane }) => {
    calls.push([sector.id, lane]); return successful(f, sector); } });
  assert.deepEqual(calls, [[3, 'baseline'], [4, 'baseline'], [60, 'priority'], [5, 'catchup']]);
  assert.equal(result.catchupSlotsAtAdmission, 6); assert.equal(result.catchupSlotsRemaining, 5);
  f.advance(60000); const next = await runCoverageWake(f.env, { now: f.now,
    processSector: ({ sector }) => successful(f, sector) });
  assert.deepEqual(next.priority.map(row => row.sectorId), [70]); assert.equal(next.catchupSlotsAtAdmission, 5);
  assert.equal(next.catchupSlotsRemaining, 4); assert.equal(f.sqlite.prepare('SELECT next_sector FROM earth_coverage_state').get().next_sector, 9);
});

test('catchup crossing120 wraps once and a priority on its cursor is processed once under its own generation', async t => {
  const f = await fixture(t); await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.sqlite.prepare('UPDATE earth_coverage_state SET next_sector=119').run(); f.advance(120000);
  await enqueueCoveragePriority(f.env, { sectorId: 1, reason: 'urgent', priority: 90,
    expiresAt: new Date(f.now() + 3600000).toISOString() }, { now: f.now });
  const seen = [], result = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector, lane }) => {
    seen.push([sector.id, lane]); return successful(f, sector); } });
  assert.deepEqual(seen, [[119, 'baseline'], [120, 'baseline'], [1, 'catchup'], [2, 'catchup']]);
  assert.equal(result.priority.length, 0); assert.equal(result.catchupSlotsRemaining, 0);
  const status = await readCoverageStatus(f.env, { now: f.now });
  assert.equal(status.cursor.completedSweeps, 1); assert.equal(status.cursor.nextSectorId, 3); assert.equal(status.priority.queued, 0);
});

test('canceled catchup retains debt and cannot publish late; unavailable actual work repays opportunity debt truthfully', async t => {
  const f = await fixture(t); await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.advance(120000); const controller = new AbortController(), started = deferred(), late = deferred();
  const pending = runCoverageWake(f.env, { now: f.now, signal: controller.signal, processSector: async ({ sector, lane }) => {
    if (lane === 'catchup') { started.resolve(); await late.promise; } return successful(f, sector); } });
  await started.promise; controller.abort(); assert.equal((await pending).status, 'cancelled');
  assert.equal(f.sqlite.prepare('SELECT catchup_slots FROM earth_coverage_state').get().catchup_slots, 2);
  assert.equal(f.sqlite.prepare('SELECT last_attempt_at FROM earth_coverage_cells WHERE sector_id=5').get().last_attempt_at, null);
  late.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sqlite.prepare('SELECT last_attempt_at FROM earth_coverage_cells WHERE sector_id=5').get().last_attempt_at, null);
  f.advance(60000); const recovered = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector, lane }) =>
    lane === 'catchup' ? { available: false } : successful(f, sector) });
  assert.equal(recovered.catchupSlotsRemaining, 0); assert.ok(recovered.catchup.every(row => row.status === 'unavailable'));
  const status = await readCoverageStatus(f.env, { now: f.now });
  assert.equal(status.counts.failed, 2); assert.equal(status.priority.queued, 2);
  assert.ok(status.sectors.slice(6, 8).every(row => row.lastAttemptAt === f.stamp() && row.lastSuccessfulAt === null));
});

test('four scheduled sector tasks still share just one read of each retained cohort and acquire no providers', async t => {
  const f = await fixture(t); await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.advance(120000); let usgsReads = 0, gdacsReads = 0;
  const receiptId = `receipt:${'a'.repeat(64)}`;
  const processor = createStoredSectorProcessor(f.env, { now: f.now,
    readUsgs: async () => { usgsReads++; return { available: true, stale: false,
      source: { scopeId: 'usgs-live-day-m2-5-v1', receiptId, fence: 1, capturedAt: f.stamp(), recordedAt: f.stamp(), sourceGeneratedAt: f.stamp() },
      prepared: { version: `prepared:${'b'.repeat(64)}`, source: { receiptId }, content: { features: [] } } }; },
    readGdacs: async () => { gdacsReads++; return { available: false }; } });
  const result = await runCoverageWake(f.env, { now: f.now, processSector: processor.processSector });
  assert.equal(result.baseline.length + result.catchup.length, 4); assert.equal(usgsReads, 1); assert.equal(gdacsReads, 1);
  assert.equal(f.activity.providers.length, 0); assert.equal(result.catchupSlotsRemaining, 0);
});

test('exhausted optional wall-time budget leaves priority and catchup pending without recording their attempts', async t => {
  const f = await fixture(t); await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => successful(f, sector) });
  f.advance(120000);
  await enqueueCoveragePriority(f.env, { sectorId: 70, reason: 'urgent', priority: 90,
    expiresAt: new Date(f.now() + 3600000).toISOString() }, { now: f.now });
  const actualNow = Date.now; let wall = 1000000, callbacks = 0; Date.now = () => wall;
  try {
    const result = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector }) => {
      callbacks++; if (callbacks === 2) wall += 11000; return successful(f, sector); } });
    assert.equal(result.baseline.length, 2); assert.equal(callbacks, 2);
    assert.equal(result.priority.length, 0); assert.equal(result.catchup.length, 0); assert.equal(result.catchupSlotsRemaining, 2);
    assert.equal(f.sqlite.prepare('SELECT catchup_slots FROM earth_coverage_state').get().catchup_slots, 2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 1);
    assert.ok(f.sqlite.prepare('SELECT last_attempt_at FROM earth_coverage_cells WHERE sector_id IN(5,70)').all().every(row => row.last_attempt_at === null));
  } finally { Date.now = actualNow; }
});
