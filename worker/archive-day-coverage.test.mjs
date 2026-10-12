import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_SCOPE } from './world-archive.js';
import { projectArchiveCoverageDays, prepareArchiveDayCoverage, archiveDayCompletionStatements, readArchiveDayCoverage, ARCHIVE_DAY_LIMITS } from './archive-day-coverage.js';
import { archiveMaintenanceFixture } from './archive-maintenance-fixture.mjs';

const DAY = 86400000, from = '2026-10-10T00:00:00.000Z', to = '2026-10-10T23:59:59.999Z';
const digest = (n) => n.toString(16).padStart(64, '0');
async function retain(f, range, n, { materialize = true } = {}) {
  const proof = { scopeId: ARCHIVE_SCOPE.id, kind: 'interval', chunkId: digest(n), range, expectedCount: 0, recordCount: 0, publishedAt: f.stamp() };
  f.sqlite.prepare(`INSERT INTO earth_archive_chunks(scope_id,chunk_id,snapshot_id,raw_sha256,captured_at,published_at,kind,record_count,policy_json)
    VALUES(?,?,?,?,?,?, 'interval',0,'{}')`).run(ARCHIVE_SCOPE.id, digest(n), digest(n + 100000), digest(n + 200000), f.stamp(), f.stamp());
  f.sqlite.prepare('INSERT INTO earth_archive_coverage VALUES (?,?,?,?,0)').run(ARCHIVE_SCOPE.id, digest(n), range.from, range.to);
  if (materialize) {
    const updates = await prepareArchiveDayCoverage(f.env, { ...proof, publishedAt: null });
    await f.env.EARTH_DB.batch(archiveDayCompletionStatements(f.env.EARTH_DB, updates, { chunkId: proof.chunkId, admittedSql: '1' }));
  }
  return proof;
}
test('daily completion uses the receipt DB clock, while an earlier cutoff retains only its actually known partial day', async (t) => {
  const f = await archiveMaintenanceFixture(t), middle = '2026-10-10T12:00:00.000Z';
  const first = await retain(f, { from, to: '2026-10-10T11:59:59.999Z' }, 1); f.advance(600000);
  const second = await retain(f, { from: middle, to }, 2);
  const row = f.sqlite.prepare('SELECT * FROM earth_archive_coverage_days').get();
  assert.equal(row.first_proof_at, first.publishedAt); assert.equal(row.complete_known_at, second.publishedAt);
  assert.deepEqual(JSON.parse(row.first_proof_json).map((piece) => piece.knownAt), [first.publishedAt, second.publishedAt]);
  const current = await readArchiveDayCoverage(f.env, { range: { from, to } }); assert.equal(current.complete, true);
  f.activity.length = 0;
  const known = await readArchiveDayCoverage(f.env, { range: { from, to }, knownAt: first.publishedAt });
  assert.deepEqual(known.segments, [{ from, to: '2026-10-10T11:59:59.999Z' }]);
  assert.deepEqual(known.gaps, [{ from: middle, to, status: 'unavailable-at-cutoff' }]); assert.equal(known.complete, false);
  assert.equal((await readArchiveDayCoverage(f.env, { range: { from, to }, knownAt: second.publishedAt })).complete, true);
  f.activity.length = 0; await readArchiveDayCoverage(f.env, { range: { from, to } });
  assert.equal(f.activity.some((item) => /SELECT d.day,d.first_proof_json/.test(item.sql)), false, 'Completed reconstruction days never load first-proof arrays');
});
test('a closed midnight endpoint remains a one-millisecond proof in the next day instead of falsely covering that day', async (t) => {
  const f = await archiveMaintenanceFixture(t), midnight = '2026-10-11T00:00:00.000Z'; await retain(f, { from, to: midnight }, 1);
  const rows = f.sqlite.prepare('SELECT * FROM earth_archive_coverage_days ORDER BY day').all(); assert.equal(rows.length, 2);
  assert.ok(rows[0].complete_known_at); assert.equal(rows[1].complete_known_at, null);
  assert.deepEqual(JSON.parse(rows[1].first_proof_json).map(({ from, to }) => ({ from, to })), [{ from: midnight, to: midnight }]);
  const result = await readArchiveDayCoverage(f.env, { range: { from: midnight, to: '2026-10-11T00:00:00.001Z' } });
  assert.deepEqual(result.gaps, [{ from: '2026-10-11T00:00:00.001Z', to: '2026-10-11T00:00:00.001Z', status: 'not-imported' }]);
});
test('journal traversal order cannot substitute for the earliest original publication knowledge', () => {
  const earlier = { scopeId: ARCHIVE_SCOPE.id, kind: 'interval', chunkId: digest(2), range: { from, to },
    expectedCount: 0, recordCount: 0, publishedAt: '2026-10-12T03:00:00.000Z' };
  const later = { ...earlier, chunkId: digest(1), publishedAt: '2026-10-12T04:00:00.000Z',
    range: { from, to: '2026-10-10T11:59:59.999Z' } };
  const row = (update) => ({ day: update.day, generation: update.generation, first_proof_json: update.firstProofJson });
  const lateFirst = projectArchiveCoverageDays([], later)[0];
  const earlierAfter = projectArchiveCoverageDays([row(lateFirst)], earlier)[0];
  const earlierFirst = projectArchiveCoverageDays([], earlier)[0];
  assert.equal(earlierAfter.firstProofAt, earlier.publishedAt);
  assert.equal(earlierAfter.completeKnownAt, earlier.publishedAt);
  assert.deepEqual(JSON.parse(earlierAfter.firstProofJson), [{ from, to, knownAt: earlier.publishedAt, chunkId: earlier.chunkId }]);
  assert.deepEqual(projectArchiveCoverageDays([row(earlierFirst)], later), [], 'The opposite traversal retains the same earlier full-day proof');
});

test('over 2,048 immutable interval receipts do not widen public coverage work or replace earliest proof knowledge', async (t) => {
  const f = await archiveMaintenanceFixture(t), first = await retain(f, { from, to }, 1);
  f.advance(600000);
  f.sqlite.exec('BEGIN'); for (let n = 2; n <= 2100; n++) {
    f.sqlite.prepare(`INSERT INTO earth_archive_chunks(scope_id,chunk_id,snapshot_id,raw_sha256,captured_at,published_at,kind,record_count,policy_json)
      VALUES(?,?,?,?,?,?,'interval',0,'{}')`).run(ARCHIVE_SCOPE.id, digest(n), digest(n + 100000), digest(n + 200000), f.stamp(), f.stamp());
    f.sqlite.prepare('INSERT INTO earth_archive_coverage VALUES (?,?,?,?,0)').run(ARCHIVE_SCOPE.id, digest(n), from, to);
  } f.sqlite.exec('COMMIT');
  const row = f.sqlite.prepare('SELECT * FROM earth_archive_coverage_days').get();
  assert.deepEqual(projectArchiveCoverageDays([row], { ...first, chunkId: digest(2100), publishedAt: f.stamp() }), []);
  f.activity.length = 0; const result = await readArchiveDayCoverage(f.env);
  assert.equal(result.complete, true); assert.equal(result.dayRows, 1); assert.ok(result.deliveryBytes < 1024);
  assert.equal(f.activity.length, 2); assert.equal(f.activity.some((item) => /earth_archive_chunks|earth_archive_coverage\b/.test(item.sql)), false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 2100);
  assert.equal(row.first_proof_at, first.publishedAt);
});
test('proof array and delivery byte limits fail before any large partial-day arrays are fetched', async (t) => {
  const f = await archiveMaintenanceFixture(t), start = Date.parse(from), knownAt = f.stamp();
  for (let day = 0; day < 8; day++) {
    const base = start + day * DAY, name = new Date(base).toISOString().slice(0, 10), pieces = Array.from({ length: 300 }, (_, index) => ({
      from: new Date(base + index * 2).toISOString(), to: new Date(base + index * 2).toISOString(), knownAt, chunkId: digest(index + 1) }));
    const text = JSON.stringify(pieces); assert.ok(new TextEncoder().encode(text).length <= ARCHIVE_DAY_LIMITS.dayBytes);
    f.sqlite.prepare('INSERT INTO earth_archive_coverage_days VALUES (?,?,1,?,NULL,?,?,?)').run(ARCHIVE_SCOPE.id, name, knownAt, text, pieces[0].from, pieces.at(-1).to);
  }
  const result = await readArchiveDayCoverage(f.env); assert.equal(result.available, false); assert.equal(result.errorCode, 'coverage-byte-budget');
  assert.equal(f.activity.some((item) => /SELECT d.day,d.first_proof_json/.test(item.sql)), false);
  const row = f.sqlite.prepare('SELECT * FROM earth_archive_coverage_days ORDER BY day LIMIT 1').get(), pieces = JSON.parse(row.first_proof_json);
  assert.throws(() => projectArchiveCoverageDays([{ ...row, first_proof_json: JSON.stringify([...pieces, ...pieces]) }], {
    scopeId: ARCHIVE_SCOPE.id, kind: 'interval', chunkId: digest(999), range: { from, to }, expectedCount: 0, recordCount: 0, publishedAt: knownAt }), /budget/);
});
test('calendar reads cap days and source correction receipts cannot manufacture interval coverage', async (t) => {
  const f = await archiveMaintenanceFixture(t), start = Date.parse(from);
  for (let day = 0; day < 737; day++) {
    const beginning = new Date(start + day * DAY).toISOString(), end = new Date(start + (day + 1) * DAY - 1).toISOString(), name = beginning.slice(0, 10);
    const pieces = JSON.stringify([{ from: beginning, to: end, knownAt: f.stamp(), chunkId: digest(day + 1) }]);
    f.sqlite.prepare('INSERT INTO earth_archive_coverage_days VALUES (?,?,1,?,?,?,?,?)').run(ARCHIVE_SCOPE.id, name, f.stamp(), f.stamp(), pieces, beginning, end);
  }
  const result = await readArchiveDayCoverage(f.env); assert.equal(result.available, false); assert.equal(result.errorCode, 'coverage-day-budget');
  assert.throws(() => projectArchiveCoverageDays([], { scopeId: ARCHIVE_SCOPE.id, kind: 'correction', chunkId: digest(1), range: { from, to }, expectedCount: 0, recordCount: 0 }), /interval/);
});
