import { readWorldEvents } from './world-model.js';
import { enqueueInvestigation, runInvestigationJob } from './investigation-jobs.js';

export const INVESTIGATION_PIPELINE_LIMITS = Object.freeze({ events: 100, enqueue: 3,
  ageMs: 86_400_000, deadlineMs: 20_000 });
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,64}$/, pending = new WeakMap();
function identity(input) {
  if (!input || Array.isArray(input) || Object.keys(input).join(',') !== 'workerId' || !WORKER_ID.test(input.workerId || ''))
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

/** Called only after the authenticated collector has completed factual publication.
 * Uses current retained input; no browser/heartbeat path is provided and no live pointer is changed.
 */
export async function advanceInvestigationPipeline(env, input, { now = Date.now, fetchImpl = fetch, signal } = {}) {
  identity(input); signal?.throwIfAborted();
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, INVESTIGATION_PIPELINE_LIMITS.deadlineMs);
  let candidateCount = 0, enqueueCount = 0;
  try {
    controller.signal.throwIfAborted();
    const current = await readWorldEvents(env, { limit: INVESTIGATION_PIPELINE_LIMITS.events }, { now });
    controller.signal.throwIfAborted();
    if (!current.available) return summary('unavailable');
    const selected = candidates(current.events || [], now()); candidateCount = selected.length;
    for (const event of selected) {
      controller.signal.throwIfAborted();
      const magnitude = event.reportedFacts?.magnitude;
      const queued = await enqueueInvestigation(env, { eventId: event.id, inputRevision: event.evidence.revision,
        priority: Number.isFinite(magnitude) && magnitude >= 6 ? Math.min(10, Math.ceil(magnitude)) : 0 }, { now });
      if (!queued.configured) return summary('unavailable', { candidateCount, enqueueCount });
      if (queued.enqueued) enqueueCount++;
      controller.signal.throwIfAborted();
    }
    // Existing due work may continue even when this particular sweep found no new recent input.
    controller.signal.throwIfAborted();
    const result = await runInvestigationJob(env, { workerId: input.workerId }, { now, fetchImpl, signal: controller.signal });
    return summary(result.configured ? 'advanced' : 'unavailable', { candidateCount, enqueueCount,
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
  if (existing) { ctx.waitUntil(existing); return { scheduled: false, status: 'already_running' }; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  // Defer execution until after registration succeeds; waitUntil failure cannot start a claim.
  let registered = false;
  const operation = Promise.resolve().then(() => registered
    ? advanceInvestigationPipeline(env, input, { ...options, signal: controller.signal }) : summary('cancelled'))
    .catch(() => summary(controller.signal.aborted ? 'cancelled' : 'failed')).finally(() => {
      options.signal?.removeEventListener('abort', cancel);
      if (pending.get(owner) === operation) pending.delete(owner);
    });
  pending.set(owner, operation);
  try { ctx.waitUntil(operation); registered = true; return { scheduled: true, status: 'scheduled' }; }
  catch { controller.abort(); pending.delete(owner); return { scheduled: false, status: 'background_unavailable' }; }
}
