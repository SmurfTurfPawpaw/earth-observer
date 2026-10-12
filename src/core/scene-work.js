export const SCENE_WORK_LIMITS = Object.freeze({ taskBudgetMs: 4, progressIntervalMs: 100, maxRecords: 100000 });
const phases = new Set(['queued-update', 'acquiring', 'queued-prepare', 'preparing', 'committing', 'prepared', 'complete', 'cancelled', 'error']);
const stopped = () => new DOMException('Scene work no longer owns this view', 'AbortError');
const number = value => Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const viewerSchedulers = new WeakMap();

/** One cooperative CPU pump. A single step, native commit, or callback cannot be preempted. */
export function createSceneWork({ documentRef = globalThis.document, now = () => performance.now(),
  schedule = callback => setTimeout(callback, 0), cancelSchedule = clearTimeout, onChange = () => {} } = {}) {
  const scopes = new Set(), jobs = [];
  let destroyed = false, task, activePreparationMs = 0, maxTaskMs = 0;
  const clock = () => number(now());
  const notify = (scope, force = false) => {
    const at = clock();
    if (!force && at - scope.notifiedAt < SCENE_WORK_LIMITS.progressIntervalMs) return;
    scope.notifiedAt = at;
    const state = scope.handle.getState();
    try { scope.onChange(state); } catch { /* Observers cannot take ownership of work. */ }
    try { onChange(state); } catch { /* Metrics remain optional. */ }
  };
  const phase = (scope, value) => { if (scope.phase !== value) { scope.phase = value; notify(scope, true); } };
  const valid = scope => {
    if (destroyed || scope.finished || scope.cancelled || scope.signal?.aborted || documentRef?.hidden) return false;
    try { return scope.isCurrent() === true; } catch { return false; }
  };
  function settle(job, error) {
    if (job.done) return;
    job.done = true; job.scope.jobs.delete(job);
    const index = jobs.indexOf(job); if (index !== -1) jobs.splice(index, 1);
    if (error) job.reject(error); else job.resolve(job.values);
    if (!jobs.length && task !== undefined) { cancelSchedule(task); task = undefined; }
  }
  function cancel(scope) {
    if (scope.finished) return;
    scope.cancelled = true;
    phase(scope, 'cancelled');
    for (const job of [...scope.jobs]) settle(job, stopped());
  }
  function arm() {
    if (destroyed || task !== undefined || !jobs.length) return;
    task = schedule(pump);
  }
  function pump() {
    task = undefined;
    if (destroyed) return;
    const began = clock(), slices = new Map();
    // Every item is checked; one shared task budget is not multiplied by layers.
    while (jobs.length && clock() - began < SCENE_WORK_LIMITS.taskBudgetMs) {
      const job = jobs.shift(), scope = job.scope;
      if (job.done) continue;
      if (!valid(scope)) { cancel(scope); continue; }
      if (job.startedAt === null) {
        job.startedAt = clock(); scope.metrics.preparationWaitMs += number(job.startedAt - job.queuedAt);
      }
      phase(scope, 'preparing');
      if (!valid(scope)) { cancel(scope); continue; }
      try {
        const stepAt = clock(); let value;
        try { value = job.step(job.records[job.index], job.index); }
        finally {
          const elapsed = number(clock() - stepAt);
          scope.metrics.activePreparationMs += elapsed; activePreparationMs += elapsed;
          slices.set(scope, (slices.get(scope) || 0) + elapsed);
          if (elapsed > SCENE_WORK_LIMITS.taskBudgetMs) scope.metrics.nonCooperativeItems++;
        }
        if (value && typeof value.then === 'function') {
          void Promise.resolve(value).catch(() => {});
          throw new TypeError('Scene preparation steps must be synchronous');
        }
        if (!valid(scope)) { cancel(scope); continue; }
        job.values.push(value); job.index++; scope.preparedCount = job.index;
        if (job.index === job.records.length) { phase(scope, 'prepared'); settle(job); }
        else { jobs.push(job); notify(scope); }
      } catch (error) { phase(scope, valid(scope) ? 'error' : 'cancelled'); settle(job, error); }
    }
    for (const [scope, elapsed] of slices) scope.metrics.maxPreparationSliceMs = Math.max(scope.metrics.maxPreparationSliceMs, elapsed);
    // Includes synchronous progress observers; excludes their later microtasks,
    // network waits, native GPU uploads, and work not passed to this pump.
    maxTaskMs = Math.max(maxTaskMs, number(clock() - began));
    arm();
  }
  const visibility = () => { if (documentRef?.hidden) for (const scope of scopes) cancel(scope); };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  const api = {
    scope({ key, signal, isCurrent = () => true, onChange: scopedChange = () => {} } = {}) {
      if (destroyed || typeof key !== 'string' || !key.length || key.length > 128 || typeof isCurrent !== 'function') throw stopped();
      const scope = { key, signal, isCurrent, onChange: scopedChange, phase: 'queued-update', preparedCount: 0, preparationTotal: null,
        notifiedAt: -Infinity, jobs: new Set(), finished: false, cancelled: false,
        metrics: { activePreparationMs: 0, maxPreparationSliceMs: 0, preparationWaitMs: 0, commitMs: 0, nonCooperativeItems: 0 } };
      const abort = () => cancel(scope);
      const handle = scope.handle = {
        getState: () => Object.freeze({ workPhase: scope.phase, preparedCount: scope.preparedCount, preparationTotal: scope.preparationTotal,
          workMetrics: Object.freeze(Object.fromEntries(Object.entries(scope.metrics).map(([name, value]) => [name, number(value)]))) }),
        assertCurrent() { if (!valid(scope)) { cancel(scope); throw stopped(); } },
        setPhase(value) { handle.assertCurrent(); if (!phases.has(value)) throw new TypeError('Use a scene work phase'); phase(scope, value); },
        prepare(records, step) {
          handle.assertCurrent();
          if (!Array.isArray(records) || records.length > SCENE_WORK_LIMITS.maxRecords || typeof step !== 'function' || scope.jobs.size)
            throw new TypeError('Use one bounded synchronous preparation per owner');
          scope.preparedCount = 0; scope.preparationTotal = records.length;
          if (!records.length) { phase(scope, 'prepared'); handle.assertCurrent(); return Promise.resolve([]); }
          phase(scope, 'queued-prepare');
          handle.assertCurrent();
          return new Promise((resolve, reject) => {
            const job = { scope, records, step, index: 0, values: [], resolve, reject, done: false, queuedAt: clock(), startedAt: null };
            scope.jobs.add(job); jobs.push(job); arm();
          });
        },
        publish(apply, discard = () => {}) {
          if (typeof apply !== 'function' || typeof discard !== 'function') throw new TypeError('Use synchronous publication callbacks');
          try { handle.assertCurrent(); } catch (error) { discard(); throw error; }
          phase(scope, 'committing'); const began = clock();
          let outcome = 'prepared';
          try {
            try { handle.assertCurrent(); } catch (error) { discard(); throw error; }
            const value = apply();
            if (value && typeof value.then === 'function') {
              void Promise.resolve(value).catch(() => {});
              throw new TypeError('Await source attachment before synchronous scene publication');
            }
            return value;
          } catch (error) { outcome = valid(scope) ? 'error' : 'cancelled'; throw error; }
          finally { scope.metrics.commitMs += number(clock() - began); phase(scope, outcome); }
        },
        finish(outcome = 'complete') {
          if (scope.finished) return;
          if (!['complete', 'cancelled', 'error'].includes(outcome)) throw new TypeError('Use a terminal scene work outcome');
          const admitted = valid(scope);
          for (const job of [...scope.jobs]) settle(job, stopped());
          phase(scope, admitted ? outcome : 'cancelled');
          scope.finished = true; signal?.removeEventListener?.('abort', abort); scopes.delete(scope);
        },
      };
      scopes.add(scope); signal?.addEventListener?.('abort', abort, { once: true });
      if (!valid(scope)) cancel(scope);
      return handle;
    },
    getState: () => Object.freeze({ destroyed, queuedPreparations: jobs.length, activeScopes: scopes.size,
      totalActivePreparationMs: number(activePreparationMs), maxTaskMs: number(maxTaskMs), taskBudgetMs: SCENE_WORK_LIMITS.taskBudgetMs }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (task !== undefined) cancelSchedule(task); task = undefined;
      documentRef?.removeEventListener?.('visibilitychange', visibility);
      for (const scope of [...scopes]) scope.handle.finish('cancelled');
    },
  };
  return api;
}

/** Direct utility consumers and the manager use the same scheduler for a viewer. */
export function sceneWorkFor(viewer, options) {
  if (!viewer || typeof viewer !== 'object') throw new TypeError('Scene work needs one viewer owner');
  if (!viewerSchedulers.has(viewer)) viewerSchedulers.set(viewer, createSceneWork(options));
  return viewerSchedulers.get(viewer);
}
