import { pluginJson } from '../src/core/plugin-evidence.js';

export const COVERAGE_POLICY = Object.freeze({ id: 'coverage-sectors-v1', columns: 12, bands: 10, sectors: 120, wakeClock: 'utc-calendar-minute',
  nominalSlotMs: 30000, nominalSweepMs: 3600000, wakeDueMs: 60000, baselinePerWake: 2, priorityPerWake: 2,
  priorityTasks: 120, priorityTtlMs: 3600000, retryMs: 300000, attempts: 3, leaseMs: 30000,
  deadlineMs: 20000, processMs: 6000, operationMs: 2000, basisBytes: 1536, summaryBytes: 2048, statusBytes: 262144 });
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const UTF8 = new TextEncoder();
const REASONS = Object.freeze(['urgent', 'followed', 'viewport', 'retry']);
const fail = code => Object.assign(new Error(code), { code });
export const coverageUtc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function coverageSector(id) {
  if (!Number.isInteger(id) || id < 1 || id > COVERAGE_POLICY.sectors) throw new TypeError('Invalid coverage sector');
  const column = (id - 1) % COVERAGE_POLICY.columns, band = Math.floor((id - 1) / COVERAGE_POLICY.columns);
  const latitude = edge => Math.asin(-1 + 2 * edge / COVERAGE_POLICY.bands) * 180 / Math.PI;
  return Object.freeze({ id, column, band, bounds: Object.freeze({ west: -180 + column * 30, east: -150 + column * 30,
    south: latitude(band), north: latitude(band + 1) }) });
}
export function coverageClock(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError('Invalid coverage clock');
  return new Date(value).toISOString();
}
export function coverageConfigured(env) { return Boolean(env?.EARTH_DB?.prepare && env?.EARTH_DB?.batch); }
export async function coverageIO(operation, signal) {
  const timeout = AbortSignal.timeout(COVERAGE_POLICY.operationMs);
  const stopped = signal ? AbortSignal.any([signal, timeout]) : timeout; stopped.throwIfAborted();
  let cancel;
  try { return await Promise.race([Promise.resolve().then(() => { stopped.throwIfAborted(); return operation(); }),
    new Promise((_, reject) => { cancel = () => reject(fail(signal?.aborted ? 'cancelled' : 'storage-timeout'));
      stopped.addEventListener('abort', cancel, { once: true }); if (stopped.aborted) cancel(); })]); }
  finally { stopped.removeEventListener('abort', cancel); }
}
export async function coverageRows(env, sql, values = [], signal) {
  const result = await coverageIO(() => env.EARTH_DB.prepare(sql).bind(...values).all(), signal);
  if (result?.success === false || !Array.isArray(result?.results)) throw fail('storage-unavailable');
  return result.results;
}
async function batch(env, statements, signal) {
  const result = await coverageIO(() => env.EARTH_DB.batch(statements), signal);
  if (!Array.isArray(result) || result.length !== statements.length || result.some(row => row?.success === false)) throw fail('storage-unavailable');
  return result;
}
const sql = (env, text, values = []) => env.EARTH_DB.prepare(text).bind(...values);
const live = `policy_id=? AND fence=? AND lease_token=? AND lease_until>${DB_NOW}`;
const leaseValues = lease => [COVERAGE_POLICY.id, lease.fence, lease.lease_token];
const admitted = 'EXISTS(SELECT 1 FROM earth_coverage_state WHERE policy_id=? AND fence=? AND lease_token=? AND admitted_token=?)';
function state(row) {
  if (!row || row.policy_id !== COVERAGE_POLICY.id || !Number.isSafeInteger(row.fence) || row.fence < 0 ||
      !Number.isInteger(row.next_sector) || row.next_sector < 1 || row.next_sector > 120 || !coverageUtc(row.next_due_at) ||
      !Number.isSafeInteger(row.sweep_count) || row.sweep_count < 0) throw fail('invalid-coverage-state');
  return row;
}
/** Migration-owned tables only. Authenticated wake initializes rows, never DDL. */
export async function claimCoverageWake(env, signal) {
  const found = (await coverageRows(env, 'SELECT * FROM earth_coverage_state WHERE policy_id=?', [COVERAGE_POLICY.id], signal))[0];
  if (!found) await batch(env, [sql(env, `INSERT INTO earth_coverage_state
    (policy_id,next_sector,next_due_at,fence,sweep_count) VALUES (?,1,${DB_NOW},0,0) ON CONFLICT(policy_id) DO NOTHING`, [COVERAGE_POLICY.id]),
    sql(env, `INSERT INTO earth_coverage_cells(sector_id,status,failure_count,last_fence)
      SELECT CAST(value AS INTEGER),'pending',0,0 FROM json_each(?) WHERE true ON CONFLICT(sector_id) DO NOTHING`,
      [JSON.stringify(Array.from({ length: 120 }, (_, index) => index + 1))])], signal);
  else state(found);
  const token = crypto.randomUUID();
  const rows = await coverageRows(env, `UPDATE earth_coverage_state SET fence=fence+1,lease_token=?,
    lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),admitted_token=NULL,last_wake_at=${DB_NOW},
    next_due_at=substr(strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),1,16)||':00.000Z'
    WHERE policy_id=? AND next_due_at<=${DB_NOW} AND (lease_until IS NULL OR lease_until<=${DB_NOW})
    RETURNING *,${DB_NOW} AS db_now`, [token, COVERAGE_POLICY.id], signal);
  return rows[0] ? state(rows[0]) : null;
}
export async function coveragePriorityJobs(env, excluded, signal) {
  const rows = await coverageRows(env, `SELECT *,${DB_NOW} AS db_now FROM earth_coverage_priority WHERE next_attempt_at<=${DB_NOW} AND expires_at>${DB_NOW}
    ORDER BY CASE WHEN enqueued_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') THEN 0 ELSE 1 END,
      priority DESC,enqueued_at,sector_id,task_key LIMIT 121`, [], signal);
  if (rows.length > COVERAGE_POLICY.priorityTasks) throw fail('invalid-coverage-state');
  const selected = [], seen = new Set(excluded);
  for (const row of rows) {
    try { coverageSector(row.sector_id); } catch { throw fail('invalid-coverage-state'); }
    if (!REASONS.includes(row.reason) || row.task_key !== `${row.sector_id}:${row.reason}` ||
        !Number.isInteger(row.priority) || row.priority < 0 || row.priority > 100 ||
        !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts >= COVERAGE_POLICY.attempts ||
        typeof row.generation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.generation) ||
        ![row.enqueued_at, row.expires_at, row.next_attempt_at, row.db_now].every(coverageUtc) ||
        row.enqueued_at > row.db_now || row.next_attempt_at < row.enqueued_at || row.expires_at <= row.enqueued_at ||
        Date.parse(row.expires_at) > Date.parse(row.db_now) + COVERAGE_POLICY.priorityTtlMs) throw fail('invalid-coverage-state');
    if (!seen.has(row.sector_id) && selected.length < COVERAGE_POLICY.priorityPerWake) { selected.push(row); seen.add(row.sector_id); }
  }
  return selected;
}
function boundedJson(value, limit) {
  const result = pluginJson(value); if (UTF8.encode(result).byteLength > limit) throw fail('coverage-result-budget'); return result;
}
const basisKeys = new Set(['sourceId', 'scopeId', 'version', 'receiptId', 'fence', 'capturedAt', 'recordedAt', 'sourceGeneratedAt',
  'collectionBasis', 'selectedCount', 'maximumMagnitude', 'issues', 'completeRetainedCohort', 'coverageMeaning', 'scopeIssues']);
function shortId(value, limit = 160) { return typeof value === 'string' && value.length > 0 && value.length <= limit && /^[A-Za-z0-9:._-]+$/.test(value); }
function enums(value) { return Array.isArray(value) && value.length <= 4 && value.every(entry => shortId(entry, 64)); }
export function validateCoverageResult(value, measuredAt) {
  if (!value || value.available !== true || !Array.isArray(value.basis) || !value.basis.length || value.basis.length > 2) throw fail('source-not-ready');
  const sources = new Set();
  for (const item of value.basis) {
    if (!item || Object.keys(item).some(key => !basisKeys.has(key)) || !shortId(item.sourceId) || !shortId(item.scopeId) || !shortId(item.version) ||
        sources.has(`${item.sourceId}:${item.scopeId}`) || item.completeRetainedCohort !== true ||
        !coverageUtc(item.capturedAt) || !coverageUtc(item.recordedAt) || Date.parse(item.recordedAt) > Date.parse(measuredAt) + 305000 ||
        Date.parse(item.capturedAt) > Date.parse(measuredAt) + 305000 ||
        Date.parse(item.capturedAt) > Date.parse(item.recordedAt) + 305000 ||
        (item.receiptId !== undefined && !shortId(item.receiptId)) ||
        (item.fence !== undefined && (!Number.isSafeInteger(item.fence) || item.fence < 0)) ||
        (item.sourceGeneratedAt !== undefined && item.sourceGeneratedAt !== null && (!coverageUtc(item.sourceGeneratedAt) ||
          Date.parse(item.sourceGeneratedAt) > Date.parse(item.capturedAt) + 305000)) ||
        (item.collectionBasis !== undefined && !shortId(item.collectionBasis)) ||
        (item.selectedCount !== undefined && (!Number.isSafeInteger(item.selectedCount) || item.selectedCount < 0)) ||
        (item.maximumMagnitude !== undefined && item.maximumMagnitude !== null && (!Number.isFinite(item.maximumMagnitude) || item.maximumMagnitude < -10 || item.maximumMagnitude > 15)) ||
        (item.coverageMeaning !== undefined && (typeof item.coverageMeaning !== 'string' || item.coverageMeaning.length > 512)) ||
        (item.issues !== undefined && !enums(item.issues)) || (item.scopeIssues !== undefined && !enums(item.scopeIssues))) throw fail('invalid-source-basis');
    sources.add(`${item.sourceId}:${item.scopeId}`);
  }
  if (!value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary)) throw fail('invalid-coverage-summary');
  return { basisJson: boundedJson(value.basis, COVERAGE_POLICY.basisBytes), summaryJson: boundedJson(value.summary, COVERAGE_POLICY.summaryBytes) };
}
/** The first statement admits the entire atomic batch under a live lease. The
 * token fences later statements even if the lease expires during execution. */
export async function completeCoverageSector(env, lease, { sectorId, lane, job = null, result = null, errorCode = null }, signal) {
  coverageSector(sectorId); const token = crypto.randomUUID(), accepted = [...leaseValues(lease), token];
  const isBaseline = lane === 'baseline', next = sectorId === 120 ? 1 : sectorId + 1;
  const statements = [sql(env, `UPDATE earth_coverage_state SET admitted_token=?,last_completed_at=${DB_NOW},last_error=?,
    next_sector=CASE WHEN ?=1 THEN ? ELSE next_sector END,sweep_count=sweep_count+CASE WHEN ?=1 AND ?=120 THEN 1 ELSE 0 END
    WHERE ${live} RETURNING fence`, [token, errorCode, isBaseline ? 1 : 0, next, isBaseline ? 1 : 0, sectorId, ...leaseValues(lease)]),
    sql(env, `UPDATE earth_coverage_cells SET last_attempt_at=${DB_NOW},last_fence=?,status=?,
      failure_count=CASE WHEN ?=1 THEN 0 ELSE failure_count+1 END,
      last_success_at=CASE WHEN ?=1 THEN ${DB_NOW} ELSE last_success_at END,
      source_basis_json=CASE WHEN ?=1 THEN ? ELSE source_basis_json END,
      summary_json=CASE WHEN ?=1 THEN ? ELSE summary_json END WHERE sector_id=? AND ${admitted}`,
      [lease.fence, result ? 'ready' : 'error', result ? 1 : 0, result ? 1 : 0, result ? 1 : 0, result?.basisJson ?? null,
        result ? 1 : 0, result?.summaryJson ?? null, sectorId, ...accepted])];
  if (job) statements.push(result || job.attempts + 1 >= COVERAGE_POLICY.attempts ?
    sql(env, `DELETE FROM earth_coverage_priority WHERE task_key=? AND generation=? AND ${admitted}`, [job.task_key, job.generation, ...accepted]) :
    sql(env, `UPDATE earth_coverage_priority SET attempts=attempts+1,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
      WHERE task_key=? AND generation=? AND ${admitted}`, [job.task_key, job.generation, ...accepted]));
  const response = await batch(env, statements, signal); return response[0]?.results?.length === 1;
}
export async function releaseCoverageWake(env, lease, signal) {
  await coverageRows(env, `UPDATE earth_coverage_state SET lease_token=NULL,lease_until=NULL,admitted_token=NULL
    WHERE policy_id=? AND fence=? AND lease_token=?`, leaseValues(lease), signal);
}
export async function expireCoveragePriority(env, lease, signal) {
  await coverageRows(env, `DELETE FROM earth_coverage_priority WHERE expires_at<=${DB_NOW} AND
    EXISTS(SELECT 1 FROM earth_coverage_state WHERE ${live})`, leaseValues(lease), signal);
}
/** Internal authenticated callers only. This function never acquires sources. */
export async function enqueueCoveragePriority(env, job, { now = Date.now, signal } = {}) {
  const measuredAt = coverageClock(now); signal?.throwIfAborted(); coverageSector(job?.sectorId);
  if (!REASONS.includes(job.reason) || !Number.isInteger(job.priority) || job.priority < 0 || job.priority > 100 ||
      !coverageUtc(job.expiresAt) || Date.parse(job.expiresAt) <= Date.parse(measuredAt) ||
      Date.parse(job.expiresAt) > Date.parse(measuredAt) + COVERAGE_POLICY.priorityTtlMs) throw new TypeError('Invalid bounded priority request');
  if (!coverageConfigured(env)) return { configured: false, enqueued: false, status: 'unavailable' };
  const taskKey = `${job.sectorId}:${job.reason}`, generation = crypto.randomUUID();
  try {
    const results = await batch(env, [sql(env, `DELETE FROM earth_coverage_priority WHERE expires_at<=${DB_NOW}`),
      sql(env, `INSERT INTO earth_coverage_priority(task_key,sector_id,reason,priority,enqueued_at,expires_at,next_attempt_at,attempts,generation)
        SELECT ?,?,?,?,${DB_NOW},?,CASE WHEN ?='retry' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') ELSE ${DB_NOW} END,0,? WHERE ?>${DB_NOW}
        AND ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') AND (EXISTS(SELECT 1 FROM earth_coverage_priority WHERE task_key=?)
        OR (SELECT COUNT(*) FROM (SELECT task_key FROM earth_coverage_priority LIMIT 120))<120)
        ON CONFLICT(task_key) DO UPDATE SET priority=MAX(earth_coverage_priority.priority,excluded.priority),
          expires_at=MAX(earth_coverage_priority.expires_at,excluded.expires_at),next_attempt_at=excluded.next_attempt_at,attempts=0,generation=excluded.generation
        WHERE excluded.expires_at>earth_coverage_priority.expires_at OR excluded.priority>earth_coverage_priority.priority
        RETURNING task_key,generation`, [taskKey, job.sectorId, job.reason, job.priority, job.expiresAt, job.reason, generation, job.expiresAt, job.expiresAt, taskKey])], signal);
    return { schemaVersion: 1, configured: true, enqueued: results[1]?.results?.length === 1,
      status: results[1]?.results?.length ? 'enqueued' : 'unchanged-or-capped', taskKey };
  } catch { return { schemaVersion: 1, configured: false, enqueued: false, status: signal?.aborted ? 'cancelled' : 'unavailable' }; }
}
export async function readCoverageStatus(env, { now = Date.now, signal } = {}) {
  const measuredAt = coverageClock(now); signal?.throwIfAborted();
  const base = { schemaVersion: 1, policyId: COVERAGE_POLICY.id, measuredAt, configured: false, available: false,
    nominalSlotMs: COVERAGE_POLICY.nominalSlotMs, nominalSweepMs: COVERAGE_POLICY.nominalSweepMs, sectors: [],
    meaning: 'Retained-source sector processing, not acquisition or complete world coverage. Actual completion dates are independent of nominal cadence.' };
  if (!coverageConfigured(env)) return base;
  try {
    const row = (await coverageRows(env, 'SELECT * FROM earth_coverage_state WHERE policy_id=?', [COVERAGE_POLICY.id], signal))[0];
    const cells = await coverageRows(env, 'SELECT * FROM earth_coverage_cells ORDER BY sector_id LIMIT 121', [], signal);
    const tasks = await coverageRows(env, `SELECT task_key,expires_at,next_attempt_at FROM earth_coverage_priority ORDER BY task_key LIMIT 121`, [], signal);
    if (cells.length > 120 || tasks.length > 120) throw fail('invalid-coverage-state');
    if (!row) return { ...base, configured: true, status: 'not-initialized' }; state(row);
    if (cells.length !== 120) throw fail('invalid-coverage-state');
    const sectors = cells.map(cell => {
      coverageSector(cell.sector_id);
      if (!['pending', 'ready', 'error'].includes(cell.status) || !Number.isSafeInteger(cell.failure_count) || cell.failure_count < 0 ||
          !Number.isSafeInteger(cell.last_fence) || cell.last_fence < 0 ||
          [cell.last_attempt_at, cell.last_success_at].some(date => date !== null && !coverageUtc(date))) throw fail('invalid-coverage-state');
      let basis = [];
      if (cell.source_basis_json !== null) { const parsed = JSON.parse(cell.source_basis_json);
        basis = JSON.parse(validateCoverageResult({ available: true, basis: parsed, summary: {} }, measuredAt).basisJson); }
      if (Boolean(cell.last_success_at) !== Boolean(basis.length)) throw fail('invalid-coverage-state');
      return { sectorId: cell.sector_id, status: cell.status, lastAttemptAt: cell.last_attempt_at, lastSuccessfulAt: cell.last_success_at,
        failureCount: cell.failure_count, processedBasis: basis };
    });
    const result = { ...base, configured: true, available: true, status: 'ready', sectors,
      cursor: { nextSectorId: row.next_sector, completedSweeps: row.sweep_count, nextWakeDueAt: row.next_due_at },
      wake: { lastAdmittedAt: row.last_wake_at, lastCompletedAt: row.last_completed_at, lastError: row.last_error,
        busy: Boolean(row.lease_token && row.lease_until > measuredAt), leaseUntil: row.lease_until },
      priority: { queued: tasks.filter(task => task.expires_at > measuredAt).length, expired: tasks.filter(task => task.expires_at <= measuredAt).length },
      counts: { successful: sectors.filter(cell => cell.lastSuccessfulAt !== null).length, pending: sectors.filter(cell => cell.status === 'pending').length,
        failed: sectors.filter(cell => cell.status === 'error').length } };
    boundedJson(result, COVERAGE_POLICY.statusBytes); return result;
  } catch { return { ...base, status: signal?.aborted ? 'cancelled' : 'unavailable' }; }
}
