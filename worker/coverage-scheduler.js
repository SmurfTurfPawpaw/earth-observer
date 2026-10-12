import { COVERAGE_POLICY, coverageSector, coverageClock, coverageConfigured, claimCoverageWake, coveragePriorityJobs,
  completeCoverageSector, releaseCoverageWake, expireCoveragePriority, validateCoverageResult, enqueueCoveragePriority } from './coverage-store.js';
export { COVERAGE_POLICY, coverageSector, enqueueCoveragePriority, readCoverageStatus } from './coverage-store.js';

async function boundedProcess(processSector, options, processMs) {
  const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal]);
  const timeout = Object.assign(new Error('processing-timeout'), { code: 'processing-timeout' });
  const timer = setTimeout(() => controller.abort(timeout), processMs); signal.throwIfAborted(); let cancel;
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return processSector({ ...options, signal }); }),
    new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel(); })]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
/** Separate retained-data work. The nominal 30s slot is not a promise that the
 * minute trigger executes twice. Every success is admitted at actual DB time. */
export async function runCoverageWake(env, { now = Date.now, processSector, signal: external, processMs = COVERAGE_POLICY.processMs } = {}) {
  if (!Number.isInteger(processMs) || processMs < 1 || processMs > COVERAGE_POLICY.processMs) throw new TypeError('Invalid sector processing deadline');
  const measuredAt = coverageClock(now), base = { schemaVersion: 1, policyId: COVERAGE_POLICY.id, measuredAt,
    configured: coverageConfigured(env), status: 'unavailable', admitted: false, baseline: [], catchup: [], priority: [] };
  if (external?.aborted) return { ...base, status: 'cancelled' };
  if (!base.configured || typeof processSector !== 'function') return base;
  const startedAt = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Coverage wake deadline', 'TimeoutError')), COVERAGE_POLICY.deadlineMs);
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal; let lease = null;
  try {
    lease = await claimCoverageWake(env, signal);
    if (!lease) return { ...base, status: 'not-due-or-busy' };
    base.admitted = true; base.fence = lease.fence;
    base.catchupSlotsAtAdmission = lease.catchup_slots; base.catchupSlotsRemaining = lease.catchup_slots;
    await expireCoveragePriority(env, lease, signal);
    const baselineIds = [lease.next_sector, lease.next_sector === 120 ? 1 : lease.next_sector + 1];
    let jobs;
    try { jobs = await coveragePriorityJobs(env, baselineIds, signal); }
    catch (error) {
      if (error?.code !== 'invalid-coverage-state') throw error;
      // The priority lane fails closed independently. Its bad retained task
      // cannot consume the two baseline sectors reserved for quiet regions.
      jobs = []; base.priorityErrorCode = 'invalid-priority-state';
    }
    const potentialCatchup = Array.from({ length: Math.min(lease.catchup_slots, COVERAGE_POLICY.catchupPerWake) },
      (_, index) => (lease.next_sector - 1 + COVERAGE_POLICY.baselinePerWake + index) % COVERAGE_POLICY.sectors + 1);
    // A priority target on the advancing cursor is already served as catch-up.
    // An independent priority keeps one optional slot, before any catch-up.
    const selectedJobs = lease.catchup_slots ? jobs.filter(job => !potentialCatchup.includes(job.sector_id)).slice(0, 1) : jobs;
    const catchupIds = potentialCatchup.slice(0, COVERAGE_POLICY.tasksPerWake - COVERAGE_POLICY.baselinePerWake - selectedJobs.length);
    const tasks = [...baselineIds.map(sectorId => ({ sectorId, lane: 'baseline', job: null })),
      ...selectedJobs.map(job => ({ sectorId: job.sector_id, lane: 'priority', job })),
      ...catchupIds.map(sectorId => ({ sectorId, lane: 'catchup', job: jobs.find(job => job.sector_id === sectorId) || null }))];
    for (const task of tasks) {
      signal.throwIfAborted(); let result = null, errorCode = null;
      // Baseline capacity is reserved. Optional priority/catch-up waits for
      // another wake if its processing and atomic storage budget cannot fit.
      if (task.lane !== 'baseline' && Date.now() - startedAt > COVERAGE_POLICY.deadlineMs - processMs - COVERAGE_POLICY.operationMs * 2) break;
      try { const value = await boundedProcess(processSector, { sector: coverageSector(task.sectorId), lane: task.lane, signal }, processMs);
        result = validateCoverageResult(value, coverageClock(now)); }
      catch (error) { if (signal.aborted) throw error;
        errorCode = ['source-not-ready', 'invalid-source-basis', 'invalid-coverage-summary', 'coverage-result-budget', 'processing-timeout'].includes(error?.code) ? error.code : 'processing-failed'; }
      const committed = await completeCoverageSector(env, lease, { ...task, result, errorCode }, signal);
      if (!committed) return { ...base, status: 'superseded' };
      base[task.lane].push({ sectorId: task.sectorId, status: result ? 'processed' : 'unavailable', errorCode });
      if (task.lane === 'catchup') base.catchupSlotsRemaining--;
      if (!result && task.lane !== 'priority') await enqueueCoveragePriority(env,
        { sectorId: task.sectorId, reason: 'retry', priority: 0, expiresAt: new Date(Date.parse(coverageClock(now)) + COVERAGE_POLICY.priorityTtlMs).toISOString() }, { now, signal });
    }
    return { ...base, status: 'processed' };
  } catch { return { ...base, configured: lease ? true : false, status: signal.aborted ? (external?.aborted ? 'cancelled' : 'deadline') : 'unavailable' }; }
  finally { clearTimeout(timer);
    // No work starts after cancellation. Cleanup is bounded independently and
    // cannot release a newer owner's lease. Ignored callback cancellation does
    // not authorize a late result or imply that physical computation stopped.
    if (lease) { try { await releaseCoverageWake(env, lease); } catch { /* Lease expiry supplies bounded recovery. */ } }
  }
}
