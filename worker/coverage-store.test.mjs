import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentFixture, CLOCK } from './document-investigation-fixture.mjs';
import { COVERAGE_POLICY, coverageSector, claimCoverageWake, completeCoverageSector, releaseCoverageWake,
  enqueueCoveragePriority, coveragePriorityJobs, readCoverageStatus, validateCoverageResult } from './coverage-store.js';
import { runCoverageWake } from './coverage-scheduler.js';

const migration = await readFile(new URL('../drizzle/0011_coverage_scheduler.sql', import.meta.url), 'utf8');
async function fixture(t) { const f = await documentFixture(t, { documents: false }); f.sqlite.exec(migration); return f; }
const basis = at => [{ sourceId: 'usgs', scopeId: 'usgs-live-day-m2-5-v1', version: `prepared:${'a'.repeat(64)}`,
  receiptId: `receipt:${'b'.repeat(64)}`, fence: 5, capturedAt: at, recordedAt: at,
  sourceGeneratedAt: at, selectedCount: 0, completeRetainedCohort: true, coverageMeaning: 'Retained rolling-day scope only' }];
const result = at => validateCoverageResult({ available: true, basis: basis(at), summary: { missingSources: ['gdacs'] } }, at);
const priority = (f, sectorId, reason = 'urgent', score = 90) => ({ sectorId, reason, priority: score, expiresAt: new Date(f.now() + 3600000).toISOString() });

test('120 sectors include poles, water and every longitude with equal sine-latitude area', () => {
  const sectors = Array.from({ length: 120 }, (_, i) => coverageSector(i + 1));
  assert.equal(sectors[0].bounds.south, -90); assert.equal(sectors[119].bounds.north, 90);
  assert.equal(sectors[0].bounds.west, -180); assert.equal(sectors[11].bounds.east, 180);
  for (const sector of sectors) assert.ok(Math.abs(Math.sin(sector.bounds.north * Math.PI / 180) - Math.sin(sector.bounds.south * Math.PI / 180) - .2) < 1e-14);
  for (let id = 1; id < 120; ++id) {
    if (id % 12) assert.equal(sectors[id - 1].bounds.east, sectors[id].bounds.west);
    else assert.equal(sectors[id - 1].bounds.north, sectors[id].bounds.south);
  }
  assert.throws(() => coverageSector(0)); assert.throws(() => coverageSector(121));
});

test('public status never initializes tables, dispatches writes or touches objects/providers', async t => {
  const f = await fixture(t); f.reset();
  const empty = await readCoverageStatus(f.env, { now: f.now });
  assert.equal(empty.configured, true); assert.equal(empty.available, false); assert.equal(empty.status, 'not-initialized');
  assert.ok(f.activity.sql.every(row => !row.write && !/CREATE|ALTER|INSERT|UPDATE|DELETE/i.test(row.sql)));
  assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
  const lease = await claimCoverageWake(f.env); await completeCoverageSector(f.env, lease,
    { sectorId: 1, lane: 'baseline', result: result(f.stamp()) }); await releaseCoverageWake(f.env, lease);
  f.reset(); const read = await readCoverageStatus(f.env, { now: f.now });
  assert.equal(read.sectors.length, 120); assert.equal(read.counts.successful, 1); assert.equal(read.sectors[0].processedBasis[0].selectedCount, 0);
  assert.equal(read.sectors[0].lastSuccessfulAt, f.stamp()); assert.equal('summary' in read.sectors[0], false);
  assert.ok(f.activity.sql.every(row => !row.write)); assert.equal(f.activity.objects.length, 0);
  const abort = new AbortController(); abort.abort(); f.reset();
  await assert.rejects(readCoverageStatus(f.env, { signal: abort.signal, now: f.now })); assert.equal(f.activity.sql.length, 0);
  f.sqlite.exec('DROP TABLE earth_coverage_state'); f.reset();
  const absent = await readCoverageStatus(f.env, { now: f.now }); assert.equal(absent.configured, false);
  assert.ok(f.activity.sql.every(row => !row.write));
});

test('atomic completion survives lease expiry between statements, but an expired owner cannot admit a new completion', async t => {
  const f = await fixture(t), lease = await claimCoverageWake(f.env), stamp = f.stamp();
  let moved = false; f.sqlHook(({ phase, sql }) => { if (phase === 'after' && /SET admitted_token=/.test(sql) && !moved) { moved = true; f.advance(31000); } });
  assert.equal(await completeCoverageSector(f.env, lease, { sectorId: 1, lane: 'baseline', result: result(stamp) }), true);
  f.sqlHook(null); assert.equal(f.sqlite.prepare('SELECT status FROM earth_coverage_cells WHERE sector_id=1').get().status, 'ready');
  assert.equal(f.sqlite.prepare('SELECT next_sector FROM earth_coverage_state').get().next_sector, 2);
  assert.equal(await completeCoverageSector(f.env, lease, { sectorId: 2, lane: 'baseline', result: result(stamp) }), false);
  assert.equal(f.sqlite.prepare('SELECT status FROM earth_coverage_cells WHERE sector_id=2').get().status, 'pending');
});

test('priority dedup preserves age/backoff/token; new generation cannot be deleted by an old completion', async t => {
  const f = await fixture(t), lease = await claimCoverageWake(f.env), job = priority(f, 9);
  assert.equal((await enqueueCoveragePriority(f.env, job, { now: f.now })).enqueued, true);
  const first = (await coveragePriorityJobs(f.env, [], undefined))[0];
  await completeCoverageSector(f.env, lease, { sectorId: 9, lane: 'priority', job: first, errorCode: 'source-not-ready' });
  const after = f.sqlite.prepare('SELECT * FROM earth_coverage_priority').get(); f.advance(1000);
  assert.equal((await enqueueCoveragePriority(f.env, job, { now: f.now })).enqueued, false);
  const unchanged = f.sqlite.prepare('SELECT * FROM earth_coverage_priority').get();
  assert.equal(unchanged.generation, after.generation); assert.equal(unchanged.next_attempt_at, after.next_attempt_at);
  assert.equal(unchanged.enqueued_at, first.enqueued_at); assert.equal(unchanged.attempts, 1);
  const newer = { ...job, priority: 100 }; await enqueueCoveragePriority(f.env, newer, { now: f.now });
  assert.notEqual(f.sqlite.prepare('SELECT generation FROM earth_coverage_priority').get().generation, first.generation);
  await completeCoverageSector(f.env, lease, { sectorId: 9, lane: 'priority', job: first, result: result(f.stamp()) });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 1);
  const retry = await enqueueCoveragePriority(f.env, priority(f, 10, 'retry', 0), { now: f.now }); assert.equal(retry.enqueued, true);
  assert.equal(f.sqlite.prepare("SELECT next_attempt_at FROM earth_coverage_priority WHERE task_key='10:retry'").get().next_attempt_at,
    new Date(f.now() + 300000).toISOString());
});

test('renewed priority expiry preserves original fairness age and remains runnable within the current DB-clock TTL', async t => {
  const f = await fixture(t), original = priority(f, 9);
  await enqueueCoveragePriority(f.env, original, { now: f.now });
  const first = f.sqlite.prepare('SELECT * FROM earth_coverage_priority').get(); f.advance(1800000);
  assert.equal((await enqueueCoveragePriority(f.env, priority(f, 9), { now: f.now })).enqueued, true);
  const renewed = f.sqlite.prepare('SELECT * FROM earth_coverage_priority').get();
  assert.equal(renewed.enqueued_at, first.enqueued_at); assert.notEqual(renewed.generation, first.generation);
  assert.equal(renewed.expires_at, new Date(f.now() + 3600000).toISOString());
  assert.equal(Date.parse(renewed.expires_at) - Date.parse(renewed.enqueued_at), 5400000);
  assert.equal((await coveragePriorityJobs(f.env, []))[0].task_key, '9:urgent');
});

test('priority total is capped at120 and expiry releases capacity without growing state', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 120; ++id) assert.equal((await enqueueCoveragePriority(f.env, priority(f, id), { now: f.now })).enqueued, true);
  assert.equal((await enqueueCoveragePriority(f.env, priority(f, 1, 'viewport', 30), { now: f.now })).enqueued, false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 120);
  f.advance(3600000); assert.equal((await enqueueCoveragePriority(f.env, priority(f, 1, 'viewport', 30), { now: f.now })).enqueued, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 1);
  await assert.rejects(enqueueCoveragePriority(f.env, { ...priority(f, 1), expiresAt: new Date(f.now() + 3600001).toISOString() }, { now: f.now }));
  assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
});

test('a successful zero-report sector still requires a complete cited retained basis and bounded clocks', () => {
  const stamp = new Date(CLOCK).toISOString(); assert.ok(result(stamp));
  assert.throws(() => validateCoverageResult({ available: true, basis: [], summary: {} }, stamp), /source-not-ready/);
  assert.throws(() => validateCoverageResult({ available: true, basis: [{ ...basis(stamp)[0], completeRetainedCohort: false }], summary: {} }, stamp), /invalid-source-basis/);
  assert.throws(() => validateCoverageResult({ available: true, basis: [{ ...basis(stamp)[0], recordedAt: new Date(CLOCK + 305001).toISOString() }], summary: {} }, stamp));
  assert.throws(() => validateCoverageResult({ available: true, basis: basis(stamp), summary: { text: 'x'.repeat(2048) } }, stamp), /coverage-result-budget/);
});

test('corrupt retained priority admission cannot consume baseline capacity or process malformed jobs', async t => {
  const f = await fixture(t), lease = await claimCoverageWake(f.env); await releaseCoverageWake(f.env, lease);
  const corruptions = [{ priority: 101 }, { priority: 1.5 }, { attempts: -1 }, { attempts: 3 }, { attempts: .5 },
    { generation: '' }, { generation: 'not-a-uuid' }, { enqueued_at: '0000' }, { next_attempt_at: '0000' },
    { enqueued_at: () => new Date(f.now() + 1).toISOString() }, { expires_at: () => new Date(f.now() + 3600001).toISOString() }];
  for (const change of corruptions) {
    f.advance(60000); f.sqlite.prepare('DELETE FROM earth_coverage_priority').run();
    f.sqlite.prepare('UPDATE earth_coverage_state SET next_sector=1').run();
    await enqueueCoveragePriority(f.env, priority(f, 9), { now: f.now });
    const [field, rawValue] = Object.entries(change)[0], value = typeof rawValue === 'function' ? rawValue() : rawValue;
    f.sqlite.prepare(`UPDATE earth_coverage_priority SET ${field}=? WHERE sector_id=9`).run(value);
    if (field === 'generation' && value === 'not-a-uuid') for (const sectorId of [7, 8])
      await enqueueCoveragePriority(f.env, priority(f, sectorId, 'urgent', 100), { now: f.now });
    const callbacks = []; const out = await runCoverageWake(f.env, { now: f.now, processSector: ({ sector, lane }) => {
      callbacks.push([sector.id, lane]); return { available: true, basis: basis(f.stamp()), summary: {} }; } });
    assert.equal(out.status, 'processed', field); assert.equal(out.priorityErrorCode, 'invalid-priority-state', field);
    assert.deepEqual(callbacks, [[1, 'baseline'], [2, 'baseline']], field); assert.deepEqual(out.priority, [], field);
    assert.equal(f.sqlite.prepare('SELECT next_sector FROM earth_coverage_state').get().next_sector, 3, field);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_cells WHERE last_success_at IS NOT NULL').get().n, 2, field);
    assert.equal(f.sqlite.prepare('SELECT last_attempt_at FROM earth_coverage_cells WHERE sector_id=9').get().last_attempt_at, null, field);
  }
  assert.equal(f.activity.objects.length, 0); assert.equal(f.activity.providers.length, 0);
});
