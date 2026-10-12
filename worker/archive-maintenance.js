import { ARCHIVE_SCOPE, archivePrimary, archiveRows, archiveIO, ensureArchiveSchema, retainWorldArchiveRaw, readWorldArchiveChunk } from './world-archive.js';
import { worldTime, isWorldDigest } from '../src/core/world-model.js';
import { acquireUsgsCatalogInterval, restoreUsgsCatalogCandidate, usgsCatalogRange } from '../server/hosted/usgs-catalog-interval.js';
import { prepareArchiveDayCoverage, archiveDayGenerationGate, archiveDayCompletionStatements, readArchiveDayCoverage, ArchiveDayCoverageConflict } from './archive-day-coverage.js';

export const ARCHIVE_MAINTENANCE_LIMITS = Object.freeze({ dueMs: 600000, lagMs: 300000, overlapMs: 86400000,
  overlapDueMs: 21600000, leaseMs: 60000, deadlineMs: 27000, pending: 32, stateBytes: 8192, retryMs: 21600000 });
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')", encoder = new TextEncoder(), iso = (value) => new Date(value).toISOString();
const owned = `EXISTS(SELECT 1 FROM earth_archive_maintenance s WHERE s.scope_id=? AND s.fence=? AND s.lease_token=? AND s.lease_until>${DB_NOW})`;
const leaseValues = (lease) => [ARCHIVE_SCOPE.id, lease.fence, lease.lease_token];
function abortable(operation, signal) {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
export class ArchiveMaintenanceCoverageConflict extends ArchiveDayCoverageConflict {
  constructor() { super('Archive day coverage changed before atomic admission'); this.name = 'ArchiveMaintenanceCoverageConflict'; this.code = 'coverage-generation-conflict'; }
}
const json = (value) => { const result = JSON.stringify(value); if (encoder.encode(result).length > ARCHIVE_MAINTENANCE_LIMITS.stateBytes) throw new RangeError('Archive maintenance state exceeds its budget'); return result; };
function queueValue(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value) || value.length > ARCHIVE_MAINTENANCE_LIMITS.pending) throw new RangeError('Archive maintenance queue exceeds its budget');
  for (const item of value) {
    if (!item || Object.keys(item).sort().join(',') !== 'from,mode,to' || !['tail', 'overlap'].includes(item.mode)) throw new TypeError('Invalid archive maintenance work');
    usgsCatalogRange({ from: item.from, to: item.to });
  }
  for (const mode of ['tail', 'overlap']) {
    const lane = value.filter((item) => item.mode === mode);
    for (let index = 1; index < lane.length; index++) if (lane[index - 1].to !== lane[index].from) throw new TypeError('Maintenance split queue has a gap');
  }
  json(value); return value;
}
function candidateValue(text) {
  const value = JSON.parse(text);
  if (!value || Object.keys(value).sort().join(',') !== 'overlap,tail') throw new TypeError('Invalid frozen archive lanes');
  for (const item of Object.values(value)) if (item !== null) {
    if (!item || Object.keys(item).sort().join(',') !== 'capturedAt,chunkId,expectedCount,kind,range,rawSha256,schemaVersion,scopeId,snapshotId,sourceBytes' ||
        item.schemaVersion !== 1 || item.scopeId !== ARCHIVE_SCOPE.id || item.kind !== 'interval' ||
        !isWorldDigest(item.chunkId) || !isWorldDigest(item.snapshotId) || !isWorldDigest(item.rawSha256) ||
        !Number.isInteger(item.expectedCount) || item.expectedCount < 0 || item.expectedCount > 500 ||
        !Number.isInteger(item.sourceBytes) || item.sourceBytes < 1 || item.sourceBytes > 1048576 || worldTime(item.capturedAt) !== item.capturedAt)
      throw new TypeError('Invalid frozen archive candidate');
    usgsCatalogRange(item.range);
  }
  json(value); return value;
}
function stateValue(row) {
  if (row?.scope_id !== ARCHIVE_SCOPE.id || worldTime(row.verified_from) !== row.verified_from || worldTime(row.verified_through) !== row.verified_through ||
      row.verified_from > row.verified_through || !Number.isSafeInteger(row.fence) || row.fence < 0) throw new TypeError('Invalid archive frontier');
  const queue = queueValue(row.pending_ranges_json), candidates = candidateValue(row.candidate_json);
  for (const mode of ['tail', 'overlap']) if (candidates[mode]) {
    const head = queue.find((item) => item.mode === mode);
    if (!head || head.from !== candidates[mode].range.from || head.to !== candidates[mode].range.to) throw new TypeError('Frozen candidate lost its exact queue interval');
  }
  if (queue.find((item) => item.mode === 'tail')?.from && queue.find((item) => item.mode === 'tail').from !== row.verified_through)
    throw new TypeError('Pending tail does not start at the verified frontier');
  return { ...row, queue, candidates };
}
async function batch(db, statements) {
  const results = await archiveIO(() => db.batch(statements));
  if (!Array.isArray(results) || results.length !== statements.length || results.some((value) => value?.success === false)) throw new Error('Archive maintenance atomic storage failed');
  return results;
}
export async function ensureArchiveMaintenanceSchema(env) {
  if (!env?.EARTH_DB?.prepare || !env?.EARTH_DB?.batch || !env?.EARTH_STORE?.get || !env?.EARTH_STORE?.put) return false;
  if (!await ensureArchiveSchema(env)) return false;
  try {
    await batch(env.EARTH_DB, [env.EARTH_DB.prepare(`SELECT scope_id,verified_from,verified_through,pending_ranges_json,candidate_json,
      tail_due_at,overlap_due_at,next_due_at,checked_at,last_successful_at,last_mode,status,failure_count,fence,lease_token,lease_until,admitted_chunk_id,admitted_fence
      FROM earth_archive_maintenance LIMIT 0`), env.EARTH_DB.prepare(`SELECT scope_id,day,generation,first_proof_at,complete_known_at,first_proof_json,range_from,range_to
      FROM earth_archive_coverage_days LIMIT 0`)]); return true;
  } catch { return false; }
}
/** Owner/bootstrap only. A MAX(range_to) cannot seed a cursor across hidden gaps.
 * The owner first materializes committed receipts; no provider acquisition here. */
export async function seedArchiveMaintenance(env, { verifiedFrom, verifiedThrough } = {}) {
  if (worldTime(verifiedFrom) !== verifiedFrom || worldTime(verifiedThrough) !== verifiedThrough || verifiedFrom > verifiedThrough) throw new TypeError('Use canonical verified frontier bounds');
  env = archivePrimary(env);
  if (!await ensureArchiveMaintenanceSchema(env)) return { configured: false, seeded: false };
  const coverage = await readArchiveDayCoverage(env, { range: { from: verifiedFrom, to: verifiedThrough } });
  if (coverage.available !== true || coverage.complete !== true) return { configured: true, seeded: false, reason: 'The supplied frontier is not contiguous verified coverage' };
  const result = await batch(env.EARTH_DB, [env.EARTH_DB.prepare(`INSERT INTO earth_archive_maintenance
    (scope_id,verified_from,verified_through,pending_ranges_json,candidate_json,tail_due_at,overlap_due_at,next_due_at,status,failure_count,fence)
    VALUES (?,?,?,'[]','{"tail":null,"overlap":null}',${DB_NOW},strftime('%Y-%m-%dT%H:%M:%fZ','now','+21600 seconds'),${DB_NOW},'ready',0,0)
    ON CONFLICT(scope_id) DO NOTHING`).bind(ARCHIVE_SCOPE.id, verifiedFrom, verifiedThrough)]);
  return { configured: true, seeded: result[0]?.meta?.changes === 1 };
}
export async function claimArchiveMaintenance(env) {
  env = archivePrimary(env); if (!await ensureArchiveMaintenanceSchema(env)) return null;
  const token = crypto.randomUUID();
  const result = await batch(env.EARTH_DB, [env.EARTH_DB.prepare(`UPDATE earth_archive_maintenance SET fence=fence+1,lease_token=?,
    lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),checked_at=${DB_NOW},admitted_chunk_id=NULL,admitted_fence=NULL,
    last_mode=CASE WHEN overlap_due_at<=${DB_NOW} AND (tail_due_at>${DB_NOW} OR COALESCE(last_mode,'tail')='tail') THEN 'overlap' ELSE 'tail' END
    WHERE scope_id=? AND next_due_at<=${DB_NOW} AND (lease_until IS NULL OR lease_until<=${DB_NOW})
    RETURNING *,${DB_NOW} AS db_now,strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 seconds') AS closed_target_at`).bind(token, ARCHIVE_SCOPE.id)]);
  const row = result[0]?.results?.[0]; return row ? stateValue(row) : null;
}
function head(lease) { return lease.queue.find((item) => item.mode === lease.last_mode); }
function freezeMetadata(value) {
  return Object.fromEntries(['schemaVersion', 'scopeId', 'kind', 'range', 'expectedCount', 'capturedAt', 'rawSha256', 'sourceBytes', 'chunkId', 'snapshotId'].map((key) => [key, value[key]]));
}
async function saveOwned(env, lease, queue, candidates) {
  queueValue(json(queue)); candidateValue(json(candidates));
  const result = await batch(env.EARTH_DB, [env.EARTH_DB.prepare(`UPDATE earth_archive_maintenance SET pending_ranges_json=?,candidate_json=?
    WHERE scope_id=? AND ${owned}`).bind(json(queue), json(candidates), ARCHIVE_SCOPE.id, ...leaseValues(lease))]);
  if (result[0]?.meta?.changes !== 1) throw new Error('Archive maintenance ownership expired');
  lease.queue = queue; lease.candidates = candidates; lease.pending_ranges_json = json(queue); lease.candidate_json = json(candidates);
}
async function release(env, lease, { status, failed = false, queue = lease.queue, candidates = lease.candidates } = {}) {
  const failures = failed ? Math.min(100, lease.failure_count + 1) : 0;
  const seconds = failed ? Math.min(21600, 600 * 2 ** Math.min(failures - 1, 6)) : 600;
  const due = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${seconds} seconds')`;
  const tail = lease.last_mode === 'tail' ? due : 'tail_due_at', overlap = lease.last_mode === 'overlap' ? due : 'overlap_due_at';
  const result = await batch(env.EARTH_DB, [env.EARTH_DB.prepare(`UPDATE earth_archive_maintenance SET pending_ranges_json=?,candidate_json=?,
    tail_due_at=${tail},overlap_due_at=${overlap},next_due_at=min(${tail},${overlap}),checked_at=${DB_NOW},status=?,failure_count=?,
    lease_token=NULL,lease_until=NULL,admitted_chunk_id=NULL,admitted_fence=NULL WHERE scope_id=? AND ${owned}`)
    .bind(json(queue), json(candidates), status, failures, ARCHIVE_SCOPE.id, ...leaseValues(lease))]);
  return result[0]?.meta?.changes === 1;
}
function exactReceipt(receipt, candidate) {
  if (receipt?.configured !== true || receipt.available !== true || receipt.stored !== true || receipt.complete !== true || receipt.kind !== 'interval' ||
      receipt.scopeId !== ARCHIVE_SCOPE.id || receipt.chunkId !== candidate.chunkId || receipt.snapshotId !== candidate.snapshotId ||
      receipt.rawSha256 !== candidate.rawSha256 || receipt.expectedCount !== candidate.expectedCount || receipt.recordCount !== candidate.expectedCount ||
      receipt.range?.from !== candidate.range.from || receipt.range?.to !== candidate.range.to || worldTime(receipt.publishedAt) !== receipt.publishedAt ||
      worldTime(receipt.capturedAt) !== receipt.capturedAt || receipt.capturedAt < candidate.range.to ||
      !Number.isSafeInteger(receipt.publicationOrder) || receipt.publicationOrder < 1) throw new Error('Exact archive completion receipt is unavailable');
  return receipt;
}
/** Required publisher seam: first admission -> receipt/coverage/heads -> day
 * statements -> frontier statement in ONE batch. No default unfenced publisher.
 * Same SQL gate supports acknowledging an already committed exact receipt. */
export async function prepareArchiveMaintenanceCommit(env, { lease, candidate, receipt = null } = {}) {
  if (lease?.scope_id !== ARCHIVE_SCOPE.id || !['tail', 'overlap'].includes(lease.last_mode)) throw new TypeError('Require a claimed archive lane');
  const frozen = lease.candidates[lease.last_mode];
  if (!frozen || json(frozen) !== json(freezeMetadata(candidate))) throw new Error('Completion candidate differs from the frozen owned candidate');
  if (receipt) exactReceipt(receipt, candidate);
  const dayUpdates = await prepareArchiveDayCoverage(env, { scopeId: ARCHIVE_SCOPE.id, kind: 'interval', chunkId: candidate.chunkId,
    range: candidate.range, expectedCount: candidate.expectedCount, recordCount: candidate.expectedCount, publishedAt: receipt?.publishedAt ?? null });
  const dayGate = archiveDayGenerationGate(dayUpdates), db = env.EARTH_DB;
  const admissionStatement = db.prepare(`UPDATE earth_archive_maintenance SET admitted_chunk_id=?,admitted_fence=fence
    WHERE scope_id=? AND pending_ranges_json=? AND candidate_json=? AND ${owned} AND ${dayGate.sql}`)
    .bind(candidate.chunkId, ARCHIVE_SCOPE.id, lease.pending_ranges_json, lease.candidate_json, ...leaseValues(lease), ...dayGate.values);
  const admittedSql = `EXISTS(SELECT 1 FROM earth_archive_maintenance s WHERE s.scope_id=? AND s.fence=? AND s.lease_token=? AND s.admitted_fence=? AND s.admitted_chunk_id=?)`;
  const admittedValues = [...leaseValues(lease), lease.fence, candidate.chunkId];
  const dayStatements = archiveDayCompletionStatements(db, dayUpdates, { chunkId: candidate.chunkId, admittedSql, admittedValues });
  const work = head(lease), queue = [...lease.queue], index = queue.indexOf(work);
  if (index < 0 || work.from !== candidate.range.from || work.to !== candidate.range.to || lease.last_mode === 'tail' && work.from !== lease.verified_through)
    throw new Error('Completion cannot skip a pending frontier interval');
  queue.splice(index, 1); const candidates = { ...lease.candidates, [lease.last_mode]: null };
  const nextTail = lease.last_mode === 'tail' ? "strftime('%Y-%m-%dT%H:%M:%fZ','now','+600 seconds')" : 'tail_due_at';
  const nextOverlap = lease.last_mode === 'overlap' ? `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${queue.some((item) => item.mode === 'overlap') ? 600 : 21600} seconds')` : 'overlap_due_at';
  const receiptSql = `EXISTS(SELECT 1 FROM earth_archive_chunks c JOIN earth_archive_coverage v ON v.scope_id=c.scope_id AND v.chunk_id=c.chunk_id
    WHERE c.scope_id=? AND c.chunk_id=? AND c.snapshot_id=? AND c.raw_sha256=? AND c.kind='interval' AND c.record_count=?
      AND v.expected_count=? AND v.range_from=? AND v.range_to=?)`;
  const receiptValues = [ARCHIVE_SCOPE.id, candidate.chunkId, candidate.snapshotId, candidate.rawSha256, candidate.expectedCount, candidate.expectedCount, work.from, work.to];
  const completionStatement = db.prepare(`UPDATE earth_archive_maintenance SET verified_through=?,pending_ranges_json=?,candidate_json=?,
    tail_due_at=${nextTail},overlap_due_at=${nextOverlap},next_due_at=min(${nextTail},${nextOverlap}),last_successful_at=${DB_NOW},checked_at=${DB_NOW},
    status='ready',failure_count=0,lease_token=NULL,lease_until=NULL,admitted_chunk_id=NULL,admitted_fence=NULL
    WHERE scope_id=? AND ${admittedSql} AND ${receiptSql}`)
    .bind(lease.last_mode === 'tail' ? work.to : lease.verified_through, json(queue), json(candidates), ARCHIVE_SCOPE.id, ...admittedValues, ...receiptValues);
  return { admissionStatement, admittedSql, admittedValues, dayStatements, completionStatement, dayUpdates,
    ownedSql: owned, ownedValues: leaseValues(lease),
    scopeId: ARCHIVE_SCOPE.id, chunkId: candidate.chunkId, fence: lease.fence };
}
export async function acknowledgeArchiveMaintenanceReceipt(env, { lease, candidate, receipt } = {}) {
  const plan = await prepareArchiveMaintenanceCommit(env, { lease, candidate, receipt });
  const results = await batch(env.EARTH_DB, [plan.admissionStatement, ...plan.dayStatements, plan.completionStatement]);
  return results.at(-1)?.meta?.changes === 1;
}
async function restore(env, metadata, now, signal) {
  signal.throwIfAborted(); const raw = await archiveIO(() => env.EARTH_STORE.get(`archive/raw/usgs/${metadata.rawSha256}.json`));
  if (!raw || Number.isFinite(raw.size) && raw.size !== metadata.sourceBytes) throw new Error('Frozen source body is missing or changed');
  const body = await archiveIO(() => raw.text()); signal.throwIfAborted();
  return restoreUsgsCatalogCandidate({ body, metadata, now });
}
/** Authenticated collector integration only. Not imported by a visitor handler.
 * publishPrepared must apply the supplied atomic plan to the existing publisher;
 * until that seam exists this runner refuses to acquire anything. */
export async function runArchiveMaintenance(env, { fetchImpl = fetch, now = Date.now, publishPrepared, deadlineMs = ARCHIVE_MAINTENANCE_LIMITS.deadlineMs } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > ARCHIVE_MAINTENANCE_LIMITS.deadlineMs) throw new TypeError('Use a bounded archive maintenance deadline');
  if (typeof publishPrepared !== 'function') return { configured: false, status: 'integration-required', acquired: false };
  env = archivePrimary(env); let lease, acquired = false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Archive maintenance deadline exceeded')), deadlineMs);
  try {
    lease = await claimArchiveMaintenance(env);
    if (!lease) {
      const configured = await ensureArchiveMaintenanceSchema(env);
      const state = configured ? (await archiveRows(env.EARTH_DB, `SELECT lease_until,next_due_at,${DB_NOW} AS db_now FROM earth_archive_maintenance WHERE scope_id=?`, [ARCHIVE_SCOPE.id]))[0] : null;
      return { configured, status: !configured ? 'unavailable' : !state ? 'unseeded' : state.lease_until && state.lease_until > state.db_now ? 'busy' : 'not-due', acquired: false };
    }
    let work = head(lease);
    if (!work) {
      const from = lease.last_mode === 'tail' ? lease.verified_through : iso(Math.max(Date.parse(lease.verified_from),
        Math.min(Date.parse(lease.verified_through), Date.parse(lease.closed_target_at)) - ARCHIVE_MAINTENANCE_LIMITS.overlapMs));
      const to = lease.last_mode === 'tail' ? iso(Math.min(Date.parse(lease.closed_target_at), Date.parse(from) + 86400000)) :
        iso(Math.min(Date.parse(lease.verified_through), Date.parse(lease.closed_target_at)));
      if (from >= to) { await release(env, lease, { status: 'idle' }); return { configured: true, status: 'idle', acquired: false }; }
      work = { mode: lease.last_mode, from, to }; await saveOwned(env, lease, [...lease.queue, work], lease.candidates);
    }
    let metadata = lease.candidates[lease.last_mode], value;
    if (metadata) {
      const receipt = await readWorldArchiveChunk(env, { chunkId: metadata.chunkId });
      if (receipt.stored === true) {
        exactReceipt(receipt, metadata);
        const completed = await acknowledgeArchiveMaintenanceReceipt(env, { lease, candidate: metadata, receipt });
        return { configured: true, status: completed ? 'stored' : 'uncertain', acquired: false, resumed: true, mode: lease.last_mode, chunkId: metadata.chunkId };
      }
      if (receipt.available !== true || receipt.stored !== false) throw new Error('Primary receipt state is uncertain');
      value = await restore(env, metadata, now, controller.signal);
    } else {
      value = await acquireUsgsCatalogInterval({ range: { from: work.from, to: work.to }, fetchImpl, signal: controller.signal, now }); acquired = value.status === 'acquired';
      if (value.status === 'split-required') {
        const queue = [...lease.queue], index = queue.indexOf(work);
        queue.splice(index, 1, ...value.parts.map((part) => ({ mode: lease.last_mode, ...part }))); queueValue(json(queue));
        await release(env, lease, { status: 'split', queue });
        return { configured: true, status: 'split', acquired: false, mode: lease.last_mode, sourceRequests: value.requests };
      }
      if (value.status !== 'acquired') throw new Error(value.reason || 'Catalog interval did not complete');
      controller.signal.throwIfAborted();
      const retained = await retainWorldArchiveRaw(env, { body: value.body });
      if (retained.stored !== true || retained.rawSha256 !== value.rawSha256 || retained.bytes !== value.sourceBytes) throw new Error('Original source body did not retain exactly');
      metadata = freezeMetadata(value); await saveOwned(env, lease, lease.queue, { ...lease.candidates, [lease.last_mode]: metadata });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = await prepareArchiveMaintenanceCommit(env, { lease, candidate: value }); controller.signal.throwIfAborted();
      try { await abortable(Promise.resolve().then(() => publishPrepared({ env, acquired: value, lease, plan, signal: controller.signal })), controller.signal); break; }
      catch (error) {
        if (!(error instanceof ArchiveDayCoverageConflict) || attempt || controller.signal.aborted) throw error;
        const active = (await archiveRows(env.EARTH_DB, `SELECT ${owned} AS active`, leaseValues(lease)))[0];
        if (!active?.active) throw error;
        // Exactly one generation re-read; no count/query retry and no catch-all retry.
      }
    }
    const receipt = exactReceipt(await readWorldArchiveChunk(env, { chunkId: metadata.chunkId }), metadata);
    const state = (await archiveRows(env.EARTH_DB, 'SELECT * FROM earth_archive_maintenance WHERE scope_id=?', [ARCHIVE_SCOPE.id]))[0];
    if (state?.fence !== lease.fence || state.lease_token !== null || candidateValue(state.candidate_json)[lease.last_mode] !== null ||
        lease.last_mode === 'tail' && state.verified_through !== work.to) throw new Error('Publication did not atomically complete its owned frontier');
    return { configured: true, status: 'stored', acquired, mode: lease.last_mode, chunkId: receipt.chunkId, sourceRequests: value.requests || 0 };
  } catch {
    if (lease) { try { await release(env, lease, { status: 'retry', failed: true }); } catch {} }
    return { configured: !!lease, status: lease?.candidates?.[lease.last_mode] ? 'uncertain' : 'retry', acquired,
      readReceiptBeforeRetry: !!lease?.candidates?.[lease.last_mode] };
  } finally { clearTimeout(timer); }
}
