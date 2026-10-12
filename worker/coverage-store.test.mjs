import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentFixture, CLOCK } from './document-investigation-fixture.mjs';
import { COVERAGE_POLICY, coverageSector, claimCoverageWake, completeCoverageSector, releaseCoverageWake,
  enqueueCoveragePriority, coveragePriorityJobs, readCoverageStatus, validateCoverageResult } from './coverage-store.js';
import { runCoverageWake } from './coverage-scheduler.js';

const migration = await readFile(new URL('../drizzle/0011_coverage_scheduler.sql', import.meta.url), 'utf8');
const catchupMigration = await readFile(new URL('../drizzle/0012_coverage_catchup.sql', import.meta.url), 'utf8');
async function fixture(t) { const f = await documentFixture(t, { documents: false }); f.sqlite.exec(migration); f.sqlite.exec(catchupMigration); return f; }
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

test('ADD COLUMN migration preserves populated0011 cursor, live lease and clocks and enforces integer debt0..120', async t => {
  const f = await documentFixture(t, { documents: false }); f.sqlite.exec(migration);
  f.sqlite.prepare(`INSERT INTO earth_coverage_state(policy_id,next_sector,next_due_at,fence,lease_token,lease_until,
    admitted_token,last_wake_at,last_completed_at,last_error,sweep_count) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    COVERAGE_POLICY.id, 119, f.stamp(), 42, 'retained-live-lease', new Date(f.now() + 30000).toISOString(),
    'retained-admission', new Date(f.now() - 60000).toISOString(), new Date(f.now() - 59000).toISOString(), 'source-not-ready', 8);
  const before = f.sqlite.prepare('SELECT * FROM earth_coverage_state').get(); f.sqlite.exec(catchupMigration);
  assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM earth_coverage_state').get() }, { ...before, catchup_slots: 0 });
  for (const value of [-1, 121, 1.5, 'bad', null]) assert.throws(() => f.sqlite.prepare('UPDATE earth_coverage_state SET catchup_slots=?').run(value));
  f.sqlite.prepare('UPDATE earth_coverage_state SET catchup_slots=120').run();
  const status = await readCoverageStatus(f.env, { now: f.now }); assert.equal(status.status, 'unavailable', 'No sector rows are invented by migration');
  assert.doesNotMatch(catchupMigration, /DROP|CREATE|PRAGMA/i);
  assert.match(f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='earth_coverage_state'").get().sql, /CONSTRAINT `earth_coverage_catchup_bound`/);
});

test('debt is computed from authoritative state inside claim and stale leases cannot repay it', async t => {
  const f = await fixture(t), first = await claimCoverageWake(f.env); await releaseCoverageWake(f.env, first); f.advance(240000);
  let changed = false;
  f.sqlHook(({ phase, sql }) => { if (!changed && phase === 'after' && /^SELECT \* FROM earth_coverage_state/.test(sql)) {
    changed = true; f.sqlite.prepare('UPDATE earth_coverage_state SET next_due_at=?,catchup_slots=1').run(new Date(f.now() - 60000).toISOString());
  } });
  const lease = await claimCoverageWake(f.env); f.sqlHook(null);
  assert.equal(lease.catchup_slots, 3, 'Current DB due + retained debt, not the stale pre-read values');
  await completeCoverageSector(f.env, lease, { sectorId: 1, lane: 'baseline', result: result(f.stamp()) });
  assert.equal(await completeCoverageSector(f.env, lease, { sectorId: 3, lane: 'catchup', result: result(f.stamp()) }), false, 'Cursor gaps cannot repay debt');
  await completeCoverageSector(f.env, lease, { sectorId: 2, lane: 'baseline', result: result(f.stamp()) });
  f.advance(31000);
  assert.equal(await completeCoverageSector(f.env, lease, { sectorId: 3, lane: 'catchup', result: result(f.stamp()) }), false);
  assert.equal(f.sqlite.prepare('SELECT catchup_slots FROM earth_coverage_state').get().catchup_slots, 3);
  assert.equal(f.sqlite.prepare('SELECT last_attempt_at FROM earth_coverage_cells WHERE sector_id=3').get().last_attempt_at, null);
});

async function fullViewportQueue(f) {
  for (let sectorId = 1; sectorId <= 120; sectorId++) {
    f.advance(1);
    assert.equal((await enqueueCoveragePriority(f.env, priority(f, sectorId, 'viewport', 30), { now: f.now })).enqueued, true);
  }
}

test('a full120 viewport queue admits one urgent task by replacing only the youngest lower-priority interest', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const oldest = f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='1:viewport'").get();
  const result = await enqueueCoveragePriority(f.env, priority(f, 1), { now: f.now });
  assert.equal(result.configured, true); assert.equal(result.enqueued, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 120);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='1:viewport'").get(), oldest);
  assert.equal(f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='120:viewport'").get(), undefined);
  assert.equal(f.sqlite.prepare("SELECT priority FROM earth_coverage_priority WHERE task_key='1:urgent'").get().priority, 90);
  const existing = f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='2:viewport'").get();
  f.reset(); const denied = await enqueueCoveragePriority(f.env, { ...priority(f, 2, 'viewport', 30), expiresAt: existing.expires_at }, { now: f.now });
  assert.equal(denied.enqueued, false, 'Unchanged existing interest does not consume another task or evict a neighbor');
  const equalNew = await enqueueCoveragePriority(f.env, priority(f, 120, 'followed', 30), { now: f.now });
  assert.equal(equalNew.configured, true); assert.equal(equalNew.enqueued, false, 'Equal priority cannot force room');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 120);
});

test('existing-key renewal under queue pressure preserves other tasks and original fairness age', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const before = f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all(); f.advance(1000);
  const result = await enqueueCoveragePriority(f.env, priority(f, 50, 'viewport', 90), { now: f.now });
  assert.equal(result.enqueued, true);
  const after = f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all();
  assert.equal(after.length, 120);
  assert.deepEqual(after.filter(row => row.task_key !== '50:viewport'), before.filter(row => row.task_key !== '50:viewport'));
  assert.equal(after.find(row => row.task_key === '50:viewport').enqueued_at, before.find(row => row.task_key === '50:viewport').enqueued_at);
});

test('concurrent higher-priority admissions serialize complete eviction/insertion batches and stay bounded120', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  // D1 serializes transactions. Preserve that real contract while this native
  // single SQLite connection receives two simultaneous JavaScript callers.
  const nativeBatch = f.env.EARTH_DB.batch; let transactions = Promise.resolve();
  f.env.EARTH_DB.batch = statements => {
    const operation = transactions.then(() => nativeBatch(statements)); transactions = operation.catch(() => {}); return operation;
  };
  const results = await Promise.all([enqueueCoveragePriority({ ...f.env }, priority(f, 1), { now: f.now }),
    enqueueCoveragePriority({ ...f.env }, priority(f, 2), { now: f.now })]);
  assert.ok(results.every(value => value.configured && value.enqueued));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 120);
  assert.deepEqual(f.sqlite.prepare("SELECT task_key FROM earth_coverage_priority WHERE reason='urgent' ORDER BY task_key").all().map(row => row.task_key), ['1:urgent', '2:urgent']);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM earth_coverage_priority WHERE task_key IN('119:viewport','120:viewport')").get().n, 0);
});

test('incoming interest expired at authoritative admission cannot evict any still-valid queued task', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const before = f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all();
  const incoming = { ...priority(f, 1), expiresAt: new Date(f.now() + 1000).toISOString() }; let advanced = false;
  f.sqlHook(({ phase, sql }) => { if (!advanced && phase === 'before' && /DELETE FROM earth_coverage_priority WHERE expires_at/.test(sql)) {
    advanced = true; f.advance(1001);
  } });
  const result = await enqueueCoveragePriority(f.env, incoming, { now: f.now }); f.sqlHook(null);
  assert.equal(result.configured, true); assert.equal(result.enqueued, false);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all(), before);
});

test('expiry immediately before insertion never removes a valid victim from a full queue', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const before = f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all();
  const incoming = { ...priority(f, 1), expiresAt: new Date(f.now() + 1000).toISOString() }; let advanced = false;
  f.sqlHook(({ phase, sql }) => { if (!advanced && phase === 'before' && /INSERT INTO earth_coverage_priority/.test(sql)) {
    advanced = true; f.advance(1001);
  } });
  const admitted = await enqueueCoveragePriority(f.env, incoming, { now: f.now }); f.sqlHook(null);
  assert.equal(admitted.configured, true); assert.equal(admitted.enqueued, false);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all(), before);
});

test('expiry after valid insertion retains its exact admission proof and commits a bounded replacement', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const incoming = { ...priority(f, 1), expiresAt: new Date(f.now() + 1000).toISOString() }; let advanced = false, transientCount = null;
  f.sqlHook(({ phase, sql }) => { if (!advanced && phase === 'after' && /INSERT INTO earth_coverage_priority/.test(sql)) {
    advanced = true; transientCount = f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n; f.advance(1001);
  } });
  const admitted = await enqueueCoveragePriority(f.env, incoming, { now: f.now }); f.sqlHook(null);
  assert.equal(transientCount, 121, 'Extra row exists only inside the uncommitted replacement transaction');
  assert.equal(admitted.configured, true); assert.equal(admitted.enqueued, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 120);
  const actual = f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='1:urgent'").get();
  assert.equal(actual.expires_at, incoming.expiresAt); assert.ok(actual.enqueued_at < f.stamp());
  assert.equal(f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='120:viewport'").get(), undefined);
});

test('evicted in-flight generation cannot delete a later replacement with its old task key', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const lease = await claimCoverageWake(f.env);
  const victim = f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='120:viewport'").get();
  assert.equal((await enqueueCoveragePriority(f.env, priority(f, 1), { now: f.now })).enqueued, true);
  assert.equal((await enqueueCoveragePriority(f.env, priority(f, 120, 'viewport', 100), { now: f.now })).enqueued, true);
  const replacement = f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='120:viewport'").get();
  assert.notEqual(replacement.generation, victim.generation);
  assert.equal(await completeCoverageSector(f.env, lease, { sectorId: 120, lane: 'priority', job: victim, result: result(f.stamp()) }), true);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM earth_coverage_priority WHERE task_key='120:viewport'").get(), replacement);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_coverage_priority').get().n, 120);
});

test('an insertion failure rolls back pressure eviction with the original queue intact', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const before = f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all();
  f.sqlHook(({ phase, sql }) => { if (phase === 'before' && /INSERT INTO earth_coverage_priority/.test(sql)) throw Error('TEST ONLY failed insertion'); });
  const result = await enqueueCoveragePriority(f.env, priority(f, 1), { now: f.now }); f.sqlHook(null);
  assert.equal(result.configured, false); assert.equal(result.enqueued, false);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all(), before);
});

test('final eviction failure rolls back the temporary121st admission and keeps the original queue intact', async t => {
  const f = await fixture(t); await fullViewportQueue(f);
  const before = f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all();
  f.sqlHook(({ phase, sql }) => { if (phase === 'before' && /DELETE FROM earth_coverage_priority WHERE task_key=\(/.test(sql)) throw Error('TEST ONLY failed final eviction'); });
  const admitted = await enqueueCoveragePriority(f.env, priority(f, 1), { now: f.now }); f.sqlHook(null);
  assert.equal(admitted.configured, false); assert.equal(admitted.enqueued, false);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM earth_coverage_priority ORDER BY task_key').all(), before);
});
