import { readWorldEvents } from './world-model.js';
import { enqueueInvestigation, runInvestigationJob } from './investigation-jobs.js';
import { isWorldDigest, worldTime } from '../src/core/world-model.js';

export const INVESTIGATION_PIPELINE_LIMITS = Object.freeze({ events: 100, enqueue: 3,
  ageMs: 86_400_000, deadlineMs: 20_000 });
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,64}$/, pending = new WeakMap();
export const INVESTIGATION_ADMISSION_POLICY = Object.freeze({ id: 'usgs-detail-top3-v1', source: 'usgs' });
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const primary = env => env.EARTH_DB?.withSession?.('first-primary') || env.EARTH_DB;
const ADMISSION_SELECT = `SELECT s.source_id,s.snapshot_id,s.captured_at,s.recorded_at,
  c.recorded_at AS receipt_at,a.candidate_count,a.admitted_at,a.basis_recorded_at
  FROM earth_world_sources s LEFT JOIN earth_world_captures c
    ON c.source_id=s.source_id AND c.captured_at=s.captured_at AND c.snapshot_id=s.snapshot_id
  LEFT JOIN earth_investigation_admissions a ON a.source_id=s.source_id AND a.captured_at=s.captured_at
    AND a.snapshot_id=s.snapshot_id AND a.policy_id=? WHERE s.source_id='usgs'`;
async function admissionIO(task, signal) {
  signal?.throwIfAborted(); let timer;
  try {
    const value = await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Investigation admission unavailable')), 2500);
    })]); signal?.throwIfAborted(); return value;
  } finally { clearTimeout(timer); }
}
function admissionRow(row) {
  if (!row) return { available: true, complete: true, capture: null };
  if (row.source_id !== 'usgs' || !isWorldDigest(row.snapshot_id) ||
      worldTime(row.captured_at) !== row.captured_at || worldTime(row.recorded_at) !== row.recorded_at || row.receipt_at !== row.recorded_at)
    throw Error('Invalid investigation admission basis');
  const retained = row.admitted_at != null;
  if (retained && (worldTime(row.admitted_at) !== row.admitted_at || worldTime(row.basis_recorded_at) !== row.basis_recorded_at ||
      !Number.isInteger(row.candidate_count) || row.candidate_count < 0 || row.candidate_count > INVESTIGATION_PIPELINE_LIMITS.enqueue))
    throw Error('Invalid investigation admission receipt');
  const complete = retained && row.basis_recorded_at === row.recorded_at;
  return { available: true, complete, capture: { sourceId: row.source_id, snapshotId: row.snapshot_id,
    capturedAt: row.captured_at, recordedAt: row.recorded_at } };
}
async function readAdmission(env, signal) {
  const db = primary(env);
  if (!db?.prepare || !db?.batch) return { available: false, complete: false };
  const value = await admissionIO(() => db.prepare(ADMISSION_SELECT).bind(INVESTIGATION_ADMISSION_POLICY.id).all(), signal);
  if (value?.success === false || !Array.isArray(value?.results) || value.results.length > 1) throw Error('Invalid admission response');
  return admissionRow(value.results[0]);
}
async function markAdmission(env, capture, count, signal) {
  const db = primary(env);
  // The mark and its readback use the current exact source publication inside one transaction.
  const value = await admissionIO(() => db.batch([
    db.prepare(`INSERT INTO earth_investigation_admissions
      (source_id,captured_at,snapshot_id,policy_id,basis_recorded_at,candidate_count,admitted_at)
      SELECT source_id,captured_at,snapshot_id,?,recorded_at,?,${DB_NOW} FROM earth_world_sources
      WHERE source_id='usgs' AND captured_at=? AND snapshot_id=? AND recorded_at=?
      ON CONFLICT(source_id,captured_at,snapshot_id,policy_id) DO UPDATE SET
        basis_recorded_at=excluded.basis_recorded_at,candidate_count=excluded.candidate_count,admitted_at=excluded.admitted_at
      WHERE earth_investigation_admissions.basis_recorded_at <> excluded.basis_recorded_at`)
      .bind(INVESTIGATION_ADMISSION_POLICY.id, count, capture.capturedAt, capture.snapshotId, capture.recordedAt),
    db.prepare(ADMISSION_SELECT).bind(INVESTIGATION_ADMISSION_POLICY.id),
  ]), signal);
  if (!Array.isArray(value) || value.length !== 2 || value.some(result => result?.success === false) ||
      !Array.isArray(value[1]?.results) || value[1].results.length > 1) throw Error('Invalid admission transaction');
  const saved = admissionRow(value[1].results[0]);
  return Boolean(saved.complete && saved.capture?.capturedAt === capture.capturedAt &&
    saved.capture.snapshotId === capture.snapshotId && saved.capture.recordedAt === capture.recordedAt);
}
function identity(input) {
  if (!input || Array.isArray(input) || !Object.keys(input).every(key => ['workerId', 'enqueueCandidates'].includes(key)) ||
      !WORKER_ID.test(input.workerId || '') || input.enqueueCandidates !== undefined && typeof input.enqueueCandidates !== 'boolean')
    throw new TypeError('Use the server-owned investigation worker identity');
}
const summary = (status, fields = {}) => ({ schemaVersion: 1, status, candidateCount: 0,
  enqueueCount: 0, jobStarted: false, jobAccepted: false, jobId: null, jobState: null, ...fields });
function candidates(events, nowMs) {
  return events.filter(event => event?.source?.id === 'usgs' &&
    Number.isFinite(Date.parse(event.eventTime?.at)) && Date.parse(event.eventTime.at) <= nowMs &&
    Date.parse(event.eventTime.at) >= nowMs - INVESTIGATION_PIPELINE_LIMITS.ageMs)
    .sort((a, b) => {
      const magnitudeA = Number.isFinite(a.reportedFacts?.magnitude) ? a.reportedFacts.magnitude : 0;
      const magnitudeB = Number.isFinite(b.reportedFacts?.magnitude) ? b.reportedFacts.magnitude : 0;
      return Number(magnitudeB >= 6) - Number(magnitudeA >= 6) ||
        (magnitudeA >= 6 && magnitudeB >= 6 ? magnitudeB - magnitudeA : 0) ||
        Date.parse(b.eventTime.at) - Date.parse(a.eventTime.at) || a.id.localeCompare(b.id);
    }).slice(0, INVESTIGATION_PIPELINE_LIMITS.enqueue);
}

/** A compact wake repairs candidate admission lost to a crash before progressing due work.
 * Warm admission is one indexed D1 read; no world body or unchanged job upsert.
 */
async function ensureAdmission(env, { now, signal }) {
  const admission = await readAdmission(env, signal);
  if (!admission.available) return { available: false, candidateCount: 0, enqueueCount: 0, admissionCompleted: false };
  if (admission.complete) return { available: true, candidateCount: 0, enqueueCount: 0, admissionCompleted: true, admissionRepaired: false };
  const current = await readWorldEvents(env, { limit: INVESTIGATION_PIPELINE_LIMITS.events }, { now });
  signal?.throwIfAborted();
  if (!current.available || current.coverage?.capturedAt !== admission.capture.capturedAt ||
      current.coverage?.publishedAt !== admission.capture.recordedAt || current.publicationRevision?.snapshotId !== admission.capture.snapshotId)
    return { available: false, candidateCount: 0, enqueueCount: 0, admissionCompleted: false };
  const selected = candidates(current.events || [], now()); let enqueueCount = 0;
  for (const event of selected) {
    signal?.throwIfAborted(); const magnitude = event.reportedFacts?.magnitude;
    const queued = await enqueueInvestigation(env, { eventId: event.id, inputRevision: event.evidence.revision,
      priority: Number.isFinite(magnitude) && magnitude >= 6 ? Math.min(10, Math.ceil(magnitude)) : 0 }, { now, signal });
    if (!queued.configured) return { available: false, candidateCount: selected.length, enqueueCount, admissionCompleted: false };
    if (queued.enqueued) enqueueCount++;
  }
  signal?.throwIfAborted();
  const complete = await markAdmission(env, admission.capture, selected.length, signal);
  return { available: complete, candidateCount: selected.length, enqueueCount,
    admissionCompleted: complete, admissionRepaired: complete };
}

/** Authenticated factual/compact collector wakes advance retained work.
 * No visitor or external heartbeat trigger is provided; no live pointer is changed.
 */
export async function advanceInvestigationPipeline(env, input, { now = Date.now, fetchImpl = fetch, signal } = {}) {
  identity(input); signal?.throwIfAborted();
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, INVESTIGATION_PIPELINE_LIMITS.deadlineMs);
  let candidateCount = 0, enqueueCount = 0;
  try {
    controller.signal.throwIfAborted();
    const admission = await ensureAdmission(env, { now, signal: controller.signal });
    candidateCount = admission.candidateCount; enqueueCount = admission.enqueueCount;
    if (!admission.available) return summary('unavailable', { candidateCount, enqueueCount, admissionCompleted: false });
    // Existing due work may continue even when this particular sweep found no new recent input.
    controller.signal.throwIfAborted();
    const result = await runInvestigationJob(env, { workerId: input.workerId }, { now, fetchImpl, signal: controller.signal });
    return summary(result.configured ? 'advanced' : 'unavailable', { candidateCount, enqueueCount,
      mode: input.enqueueCandidates === false ? 'due-only' : 'new-input',
      admissionCompleted: admission.admissionCompleted, admissionRepaired: admission.admissionRepaired,
      jobStarted: result.started === true, jobAccepted: result.accepted === true,
      jobId: result.job?.jobId || result.jobId || null, jobState: result.job?.state || null,
      ...(result.uncertain === true ? { uncertain: true, readStatusBeforeRetry: true } : {}) });
  } catch {
    return summary(controller.signal.aborted ? 'cancelled' : 'failed', { candidateCount, enqueueCount });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

/** Admission is isolate-local; durable job claims/fences remain the cross-isolate authority.
 * No detached execution if the host cannot retain a background task.
 */
export function startInvestigationPipeline(env, ctx, input, options = {}) {
  identity(input);
  if (options.signal?.aborted) return { scheduled: false, status: 'cancelled' };
  if (typeof ctx?.waitUntil !== 'function') return { scheduled: false, status: 'background_unavailable' };
  const owner = env.EARTH_STORE || env;
  const existing = pending.get(owner);
  if (existing) {
    ctx.waitUntil(existing.operation);
    if (input.enqueueCandidates !== false) existing.needsAdmission = true;
    return { scheduled: false, status: 'already_running' };
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  // Defer execution until after registration succeeds; waitUntil failure cannot start a claim.
  let registered = false; const state = { operation: null, needsAdmission: false };
  const operation = Promise.resolve().then(async () => {
    if (!registered) return summary('cancelled');
    const result = await advanceInvestigationPipeline(env, input, { ...options, signal: controller.signal });
    if (state.needsAdmission && !controller.signal.aborted) {
      // One bounded metadata-only follow-up; the durable receipt repairs any later lost wake.
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const admitted = await ensureAdmission(env, { now: options.now || Date.now, signal: controller.signal });
        return { ...result, coalescedAdmission: admitted.admissionCompleted === true };
      } catch {
        // Admission repair cannot erase an already-completed detail outcome.
        return { ...result, coalescedAdmission: false, admissionRetryPending: true };
      } finally { clearTimeout(timer); }
    }
    return result;
  })
    .catch(() => summary(controller.signal.aborted ? 'cancelled' : 'failed')).finally(() => {
      options.signal?.removeEventListener('abort', cancel);
      if (pending.get(owner) === state) pending.delete(owner);
    });
  state.operation = operation; pending.set(owner, state);
  try { ctx.waitUntil(operation); registered = true; return { scheduled: true, status: 'scheduled' }; }
  catch { controller.abort(); pending.delete(owner); return { scheduled: false, status: 'background_unavailable' }; }
}
