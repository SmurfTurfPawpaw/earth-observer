import { ARCHIVE_SCOPE, archivePrimary, archiveRows, archiveIO, ensureArchiveSchema } from './world-archive.js';
import { ensureArchiveDaySchema, prepareArchiveDayCoverage, archiveDayGenerationGate, archiveDayCompletionStatements,
  archiveDayReadiness, readArchiveDayCoverage, ArchiveDayCoverageConflict } from './archive-day-coverage.js';
import { seedArchiveMaintenance } from './archive-maintenance.js';

export const ARCHIVE_BOOTSTRAP_LIMITS = Object.freeze({ receipts: 16, deadlineMs: 24000, leaseSeconds: 60 });
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
async function batch(db, statements) {
  const result = await archiveIO(() => db.batch(statements));
  if (!Array.isArray(result) || result.length !== statements.length || result.some((row) => row?.success === false)) throw new Error('Archive bootstrap storage did not complete');
  return result;
}
const currentOrder = async (db) => (await archiveRows(db, 'SELECT COALESCE(MAX(id),0) AS n FROM earth_archive_chunks WHERE scope_id=?', [ARCHIVE_SCOPE.id]))[0].n;
async function seedReadyFrontier(env) {
  let coverage = await readArchiveDayCoverage(env);
  if (!coverage.available && coverage.availableRange && ['coverage-day-budget', 'coverage-byte-budget'].includes(coverage.errorCode)) {
    // The whole-history calendar budget must not prevent a proved recent tail.
    // Read a bounded latest two-day union; retain every older receipt unchanged.
    const to = coverage.availableRange.to, from = new Date(Math.max(Date.parse(coverage.availableRange.from), Date.parse(to) - 2 * 86400000)).toISOString();
    coverage = await readArchiveDayCoverage(env, { range: { from, to } });
  }
  if (!coverage.available || !coverage.segments?.length) return { seeded: false, reason: 'No bounded proved coverage frontier is available' };
  // A disconnected old import must not manufacture a continuous global range.
  const segment = coverage.segments.at(-1), latest = { from: segment.from < coverage.requestedRange.from ? coverage.requestedRange.from : segment.from,
    to: segment.to > coverage.requestedRange.to ? coverage.requestedRange.to : segment.to };
  const seed = await seedArchiveMaintenance(env, { verifiedFrom: latest.from, verifiedThrough: latest.to });
  const state = (await archiveRows(env.EARTH_DB, 'SELECT verified_from,verified_through FROM earth_archive_maintenance WHERE scope_id=?', [ARCHIVE_SCOPE.id]))[0];
  return { ...seed, ready: !!state, range: state ? { from: state.verified_from, to: state.verified_through } : latest };
}
/** The existing signed archive owner transport is the only mounted caller.
 * Process a bounded receipt prefix, never fetch providers or backdate receipt clocks. */
export async function bootstrapArchiveDays(env, { limit = ARCHIVE_BOOTSTRAP_LIMITS.receipts } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_BOOTSTRAP_LIMITS.receipts) throw new TypeError('Use a bounded archive bootstrap batch');
  env = archivePrimary(env); const db = env?.EARTH_DB;
  if (!await ensureArchiveSchema(env) || !await ensureArchiveDaySchema(env, { force: true })) return { configured: false, available: false, stored: false, status: 'migration-required' };
  const current = await currentOrder(db), readiness = await archiveDayReadiness(env, current);
  if (readiness.ready) return { configured: true, available: true, stored: true, complete: true, status: 'ready', processed: 0,
    materializedOrder: current, currentOrder: current, frontier: await seedReadyFrontier(env) };
  const token = crypto.randomUUID();
  const claimed = await batch(db, [db.prepare(`INSERT INTO earth_archive_day_state(scope_id,materialized_order,status,fence)
    VALUES(?,0,'pending',0) ON CONFLICT(scope_id) DO NOTHING`).bind(ARCHIVE_SCOPE.id),
  db.prepare(`UPDATE earth_archive_day_state SET fence=fence+1,lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),
    checked_at=${DB_NOW} WHERE scope_id=? AND (lease_until IS NULL OR lease_until<=${DB_NOW}) RETURNING *`).bind(token, ARCHIVE_SCOPE.id)]);
  const lease = claimed[1]?.results?.[0];
  if (!lease) return { configured: true, available: true, stored: false, complete: false, status: 'busy', currentOrder: current };
  const owned = `EXISTS(SELECT 1 FROM earth_archive_day_state s WHERE s.scope_id=? AND s.fence=? AND s.lease_token=? AND s.lease_until>${DB_NOW})`;
  const ownerValues = [ARCHIVE_SCOPE.id, lease.fence, token]; let cursor = lease.materialized_order, processed = 0;
  const started = performance.now();
  try {
    const rows = await archiveRows(db, `SELECT c.*,v.range_from,v.range_to,v.expected_count FROM earth_archive_chunks c
      LEFT JOIN earth_archive_coverage v ON v.scope_id=c.scope_id AND v.chunk_id=c.chunk_id
      WHERE c.scope_id=? AND c.id>? ORDER BY c.id LIMIT ?`, [ARCHIVE_SCOPE.id, cursor, limit]);
    for (const receipt of rows) {
      if (performance.now() - started >= ARCHIVE_BOOTSTRAP_LIMITS.deadlineMs) break;
      let committed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const updates = receipt.kind === 'interval' ? await prepareArchiveDayCoverage(env, { scopeId: ARCHIVE_SCOPE.id, kind: 'interval', chunkId: receipt.chunk_id,
          range: { from: receipt.range_from, to: receipt.range_to }, recordCount: receipt.record_count, expectedCount: receipt.expected_count, publishedAt: receipt.published_at }) : [];
        if (!['interval', 'correction'].includes(receipt.kind)) throw new Error('Unsupported retained archive receipt');
        const gate = archiveDayGenerationGate(updates), admissionToken = crypto.randomUUID();
        const admission = db.prepare(`UPDATE earth_archive_day_state SET admission_token=?,admitted_chunk_id=?
          WHERE scope_id=? AND materialized_order=? AND ${owned} AND ${gate.sql}`)
          .bind(admissionToken, receipt.chunk_id, ARCHIVE_SCOPE.id, cursor, ...ownerValues, ...gate.values);
        const admittedSql = `EXISTS(SELECT 1 FROM earth_archive_day_state s WHERE s.scope_id=? AND s.fence=? AND s.lease_token=? AND s.admission_token=? AND s.admitted_chunk_id=?)`;
        const admittedValues = [...ownerValues, admissionToken, receipt.chunk_id];
        const complete = db.prepare(`UPDATE earth_archive_day_state SET materialized_order=?,checked_at=${DB_NOW},admission_token=NULL,admitted_chunk_id=NULL
          WHERE scope_id=? AND ${admittedSql}`).bind(receipt.id, ARCHIVE_SCOPE.id, ...admittedValues);
        const result = await batch(db, [admission, ...archiveDayCompletionStatements(db, updates, { chunkId: receipt.chunk_id, admittedSql, admittedValues }), complete]);
        if (result.at(-1)?.meta?.changes === 1) { committed = true; cursor = receipt.id; processed++; break; }
        const active = (await archiveRows(db, `SELECT ${owned} AS active`, ownerValues))[0];
        if (!active?.active) throw new Error('Archive bootstrap ownership expired');
        if (attempt) throw new ArchiveDayCoverageConflict();
      }
      if (!committed) break;
    }
    await batch(db, [db.prepare(`UPDATE earth_archive_day_state SET status=CASE WHEN materialized_order=
      (SELECT COALESCE(MAX(id),0) FROM earth_archive_chunks WHERE scope_id=?) THEN 'ready' ELSE 'pending' END,
      checked_at=${DB_NOW},lease_token=NULL,lease_until=NULL WHERE scope_id=? AND ${owned}`).bind(ARCHIVE_SCOPE.id, ARCHIVE_SCOPE.id, ...ownerValues)]);
    const finalOrder = await currentOrder(db), final = await archiveDayReadiness(env, finalOrder);
    return { configured: true, available: true, stored: true, complete: final.ready, status: final.ready ? 'ready' : 'pending',
      processed, materializedOrder: final.materializedOrder, currentOrder: finalOrder, ...(final.ready ? { frontier: await seedReadyFrontier(env) } : {}) };
  } catch (error) {
    try { await batch(db, [db.prepare(`UPDATE earth_archive_day_state SET lease_token=NULL,lease_until=NULL WHERE scope_id=? AND ${owned}`)
      .bind(ARCHIVE_SCOPE.id, ...ownerValues)]); } catch {}
    throw error;
  }
}
