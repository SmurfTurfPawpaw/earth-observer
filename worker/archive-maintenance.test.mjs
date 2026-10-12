import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_SCOPE } from './world-archive.js';
import { usgsCatalogUrl } from '../server/hosted/usgs-catalog-interval.js';
import { prepareArchiveDayCoverage, archiveDayCompletionStatements, readArchiveDayCoverage } from './archive-day-coverage.js';
import { seedArchiveMaintenance, claimArchiveMaintenance, runArchiveMaintenance, ArchiveMaintenanceCoverageConflict } from './archive-maintenance.js';
import { archiveMaintenanceFixture } from './archive-maintenance-fixture.mjs';

const SCOPE = ARCHIVE_SCOPE.id, initialFrom = '2026-10-10T00:00:00.000Z', initialTo = '2026-10-11T00:00:00.000Z', digest = (value) => value.toString(16).padStart(64, '0');
async function initial(f, { gap = false } = {}) {
  const receipt = { scopeId: SCOPE, kind: 'interval', chunkId: digest(1), range: { from: initialFrom, to: gap ? '2026-10-10T23:59:59.998Z' : initialTo },
    expectedCount: 0, recordCount: 0, publishedAt: f.stamp() };
  f.sqlite.prepare(`INSERT INTO earth_archive_chunks(scope_id,chunk_id,snapshot_id,raw_sha256,captured_at,published_at,kind,record_count,policy_json)
    VALUES(?,?,?,?,?,?,'interval',0,'{}')`).run(SCOPE, receipt.chunkId, digest(2), digest(3), f.stamp(), f.stamp());
  f.sqlite.prepare('INSERT INTO earth_archive_coverage VALUES (?,?,?,?,0)').run(SCOPE, receipt.chunkId, receipt.range.from, receipt.range.to);
  const updates = await prepareArchiveDayCoverage(f.env, receipt);
  await f.env.EARTH_DB.batch(archiveDayCompletionStatements(f.env.EARTH_DB, updates, { chunkId: receipt.chunkId, admittedSql: '1' }));
  return seedArchiveMaintenance(f.env, { verifiedFrom: initialFrom, verifiedThrough: initialTo });
}
function provider({ dense = false, gap = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (value, options) => {
    const url = new URL(value); calls.push(url); assert.equal(url.origin, 'https://earthquake.usgs.gov'); assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/count')) return new Response(dense ? '251' : '0', { headers: { 'content-type': 'text/plain' } });
    const range = { from: url.searchParams.get('starttime'), to: url.searchParams.get('endtime') };
    return new Response(gap ? '' : ` ${JSON.stringify({ type: 'FeatureCollection', metadata: { count: 0, status: 200, url: usgsCatalogUrl('query', range).href }, features: [] })}\n`,
      { headers: { 'content-type': 'application/json' } });
  } };
}
/** Representative publisher seam: actual D1 SQL atomically admits, creates an
 * empty catalog receipt/coverage, projects its day proofs, and completes cursor.
 * The existing production publisher is deliberately not changed by this package. */
function publicationStatements({ env, acquired, plan }) {
  const receipt = env.EARTH_DB.prepare(`INSERT INTO earth_archive_chunks
    (scope_id,chunk_id,snapshot_id,raw_sha256,captured_at,published_at,kind,record_count,policy_json)
    SELECT ?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'interval',?,'{}' WHERE ${plan.admittedSql}
    ON CONFLICT(scope_id,chunk_id) DO NOTHING`).bind(SCOPE, acquired.chunkId, acquired.snapshotId, acquired.rawSha256, acquired.capturedAt,
    acquired.expectedCount, ...plan.admittedValues);
  const coverage = env.EARTH_DB.prepare(`INSERT INTO earth_archive_coverage SELECT ?,?,?,?,? WHERE ${plan.admittedSql}
    AND EXISTS(SELECT 1 FROM earth_archive_chunks WHERE scope_id=? AND chunk_id=?) ON CONFLICT(scope_id,chunk_id) DO NOTHING`)
    .bind(SCOPE, acquired.chunkId, acquired.range.from, acquired.range.to, acquired.expectedCount, ...plan.admittedValues, SCOPE, acquired.chunkId);
  return [plan.admissionStatement, receipt, coverage, ...plan.dayStatements, plan.completionStatement];
}
async function publishPrepared(args) {
  const result = await args.env.EARTH_DB.batch(publicationStatements(args));
  return result.at(-1)?.meta?.changes === 1;
}
test('seeding rejects an unproved frontier gap and simultaneous isolates claim only one DB-clock fence', async (t) => {
  const invalid = await archiveMaintenanceFixture(t); assert.equal((await initial(invalid, { gap: true })).seeded, false); assert.equal(invalid.state(), undefined);
  const f = await archiveMaintenanceFixture(t); assert.equal((await initial(f)).seeded, true);
  const claims = await Promise.all([claimArchiveMaintenance(f.env), claimArchiveMaintenance(f.env)]);
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(claims.find(Boolean).fence, 1);
  assert.equal(claims.find(Boolean).closed_target_at, '2026-10-12T03:55:00.000Z');
  f.advance(61000); const replacement = await claimArchiveMaintenance(f.env); assert.equal(replacement.fence, 2); assert.notEqual(replacement.lease_token, claims.find(Boolean).lease_token);
});
test('one quiet original response advances only one closed piece with DB publication knowledge and leaves Live pointers alone', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const p = provider();
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared });
  assert.equal(result.status, 'stored'); assert.equal(p.calls.length, 2); assert.equal(f.state().verified_through, '2026-10-12T00:00:00.000Z');
  assert.equal(f.state().tail_due_at, '2026-10-12T04:10:00.000Z'); assert.equal(f.state().lease_token, null);
  const receipt = f.sqlite.prepare('SELECT * FROM earth_archive_chunks WHERE chunk_id=?').get(result.chunkId);
  const day = f.sqlite.prepare("SELECT * FROM earth_archive_coverage_days WHERE day='2026-10-11'").get();
  assert.equal(day.complete_known_at, receipt.published_at); assert.equal(JSON.parse(day.first_proof_json).at(-1).knownAt, receipt.published_at);
  assert.equal((await readArchiveDayCoverage(f.env, { range: { from: initialFrom, to: f.state().verified_through } })).complete, true);
  for (const table of ['earth_world_sources', 'earth_world_captures', 'earth_collection_revision', 'earth_observations'])
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  const notDue = await runArchiveMaintenance(f.env, { now: () => f.now() + 100000000, fetchImpl: () => assert.fail('JS clock cannot make DB work due'), publishPrepared });
  assert.equal(notDue.status, 'not-due');
});
test('empty HTTP body and dense splitting preserve the frontier and persistent exact source seams', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const absent = provider({ gap: true });
  const failed = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: absent.fetchImpl, publishPrepared });
  assert.equal(failed.status, 'retry'); assert.equal(f.state().verified_through, initialTo); assert.equal(f.objects.size, 0);
  f.advance(600000); const dense = provider({ dense: true });
  const split = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: dense.fetchImpl, publishPrepared }); assert.equal(split.status, 'split'); assert.equal(dense.calls.length, 1);
  const queue = JSON.parse(f.state().pending_ranges_json); assert.equal(queue.length, 2); assert.equal(queue[0].to, queue[1].from);
  assert.equal(queue[0].from, initialTo); assert.equal(queue[1].to, '2026-10-12T00:00:00.000Z');
  f.advance(600000); const p = provider(); assert.equal((await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared })).status, 'stored');
  assert.equal(f.state().verified_through, queue[0].to); assert.equal(JSON.parse(f.state().pending_ranges_json)[0].from, queue[0].to);
});
test('expiry before first admission prevents publication; retry restores exact original candidate without new provider work', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const p = provider(); let firstCandidate;
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: async (args) => {
    firstCandidate = { body: args.acquired.body, chunkId: args.acquired.chunkId, capturedAt: args.acquired.capturedAt };
    f.advance(61000); await publishPrepared(args);
  } });
  assert.equal(result.status, 'uncertain'); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  assert.equal(f.state().verified_through, initialTo); assert.equal(f.state().lease_token !== null, true);
  const retry = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: () => assert.fail('Frozen candidate retries cannot fetch a newer body'), publishPrepared: async (args) => {
    assert.equal(args.acquired.body, firstCandidate.body); assert.equal(args.acquired.chunkId, firstCandidate.chunkId); assert.equal(args.acquired.capturedAt, firstCandidate.capturedAt);
    return publishPrepared(args);
  } });
  assert.equal(retry.status, 'stored'); assert.equal(retry.acquired, false); assert.equal(retry.chunkId, firstCandidate.chunkId);
});
test('publisher SQL failure rolls back receipt/day/frontier together and a correction due lane is not starved by a frozen tail', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const p = provider();
  const failed = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: async (args) => {
    const broken = { ...args.plan, completionStatement: args.env.EARTH_DB.prepare('INSERT INTO TEST_ONLY_NONEXISTENT_TABLE VALUES (1)') };
    return publishPrepared({ ...args, plan: broken });
  } });
  assert.equal(failed.status, 'uncertain'); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  assert.equal(f.state().verified_through, initialTo); const frozenTail = JSON.parse(f.state().candidate_json).tail;
  f.advance(21600000);
  const overlap = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared });
  assert.equal(overlap.status, 'stored'); assert.equal(overlap.mode, 'overlap'); assert.equal(f.state().verified_through, initialTo);
  assert.deepEqual(JSON.parse(f.state().candidate_json).tail, frozenTail, 'A separately due overlap does not discard the unresolved tail candidate');
  assert.equal(p.calls.at(-1).searchParams.get('endtime'), initialTo); assert.equal(f.state().last_mode, 'overlap');
});
test('staged runner refuses provider work without a fenced integration and generation conflict cannot overwrite another day proof', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f);
  const disabled = await runArchiveMaintenance(f.env, { fetchImpl: () => assert.fail('No publisher integration, no acquisition') });
  assert.equal(disabled.status, 'integration-required'); assert.equal(f.state().fence, 0);
  const p = provider(); const raced = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: async (args) => {
    f.sqlite.prepare("UPDATE earth_archive_coverage_days SET generation=generation+1 WHERE day='2026-10-11'").run();
    await publishPrepared(args);
  } });
  assert.equal(raced.status, 'uncertain'); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  assert.equal(f.state().verified_through, initialTo); assert.equal(f.sqlite.prepare("SELECT generation FROM earth_archive_coverage_days WHERE day='2026-10-11'").get().generation, 2);
});

test('only a typed day-generation conflict permits one bounded re-read while retaining the original source body', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const p = provider(); let attempts = 0, original;
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: async (args) => {
    attempts++; original ??= args.acquired.body; assert.equal(args.acquired.body, original);
    if (attempts === 1) {
      f.sqlite.prepare("UPDATE earth_archive_coverage_days SET generation=generation+1 WHERE day='2026-10-11'").run();
      await publishPrepared(args); throw new ArchiveMaintenanceCoverageConflict();
    }
    assert.equal(args.plan.dayUpdates.find((row) => row.day === '2026-10-11').expectedGeneration, 2);
    return publishPrepared(args);
  } });
  assert.equal(result.status, 'stored'); assert.equal(attempts, 2); assert.equal(p.calls.length, 2);
  assert.equal(f.state().verified_through, '2026-10-12T00:00:00.000Z');
});

test('first admission remains authoritative through a single atomic transaction even when its lease expires during completion', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const p = provider();
  const result = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: async (args) => {
    const gate = args.plan.admissionStatement;
    args.plan.admissionStatement = { ...gate, async all() { const result = await gate.all(); f.advance(61000); return result; } };
    return publishPrepared(args);
  } });
  assert.equal(result.status, 'stored'); assert.equal(f.state().lease_token, null);
  const receipt = f.sqlite.prepare('SELECT * FROM earth_archive_chunks WHERE chunk_id=?').get(result.chunkId);
  assert.equal(receipt.published_at, '2026-10-12T04:01:01.000Z');
  assert.equal(f.sqlite.prepare("SELECT complete_known_at FROM earth_archive_coverage_days WHERE day='2026-10-11'").get().complete_known_at, receipt.published_at);
});
test('a previously committed exact receipt is resumed under a fresh lease without source acquisition or backdated proof', async (t) => {
  const f = await archiveMaintenanceFixture(t); await initial(f); const p = provider(); let receiptClock;
  const uncertain = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: p.fetchImpl, publishPrepared: async (args) => {
    // Model an independently committed identical owner import discovered after
    // uncertain transport, not the required atomic maintenance publisher seam.
    await args.env.EARTH_DB.batch(publicationStatements(args).slice(0, 3)); receiptClock = f.stamp(); throw new Error('TEST ONLY uncertain receipt transport');
  } });
  assert.equal(uncertain.status, 'uncertain'); assert.equal(f.state().verified_through, initialTo); f.advance(600000);
  const resumed = await runArchiveMaintenance(f.env, { now: f.now, fetchImpl: () => assert.fail('Exact stored receipt resume cannot acquire a newer source body'),
    publishPrepared: () => assert.fail('A verified existing receipt must not be republished') });
  assert.equal(resumed.status, 'stored'); assert.equal(resumed.resumed, true); assert.equal(resumed.acquired, false);
  assert.equal(f.state().verified_through, '2026-10-12T00:00:00.000Z');
  assert.equal(f.sqlite.prepare("SELECT complete_known_at FROM earth_archive_coverage_days WHERE day='2026-10-11'").get().complete_known_at, receiptClock);
});
