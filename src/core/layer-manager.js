import { LAYERS } from './catalog.js';
import { createLayer as defaultFactory, preloadLayer as defaultPreload, layerServiceRequirements } from './layer-factories.js';
import { createCoreServices } from './services.js';
import { validateArea } from './local-area.js';
import { pluginRevision } from './live-updates.js';
import { sceneWorkFor } from './scene-work.js';

export const STORAGE_KEY = 'earth-observer:layers:v1';
export const LAYER_ACTIVATION_LIMITS = Object.freeze({ concurrent: 2 });
export const LAYER_REFRESH_FOLLOWUP_MS = 100;
const FAIR_AFTER_ADMISSIONS = 4;
const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));
const aborted = (error) => error?.name === 'AbortError';
const editionMetrics = value => value && typeof value === 'object' ? Object.freeze(Object.fromEntries(
  ['count', 'preparationMs', 'attachmentMs', 'commitMs', 'observerErrors'].filter(key => Number.isFinite(value[key]) && value[key] >= 0)
    .map(key => [key, Math.min(value[key], Number.MAX_SAFE_INTEGER)]))) : null;
// These adapters select genuine provider frames against the shared scene
// time and hide themselves across coverage gaps. Other layers are live-only
// until a dated source contract exists; current data cannot stand in for it.
const OBSERVED_FRAME_LAYERS = new Set(['weather-radar', 'weather-satellite', 'weather-lightning']);
const USGS_SCOPE = 'usgs-live-day-m2-5-v1';
function reviewedSourceRevision(id, value) {
  if (value === undefined) return undefined;
  const reviewed = pluginRevision(value);
  return id === 'earthquakes' && reviewed?.pluginId === USGS_SCOPE ? reviewed : null;
}

/** Own lazy loading, visibility intent, refresh work and persistence. */
export function createLayerManager(viewer, onStateChange = () => {}, options = {}) {
  const catalog = options.catalog || LAYERS;
  const factory = options.createLayer || defaultFactory;
  const preloadCode = options.preloadLayer || (options.createLayer ? async () => {} : defaultPreload);
  const requiredServices = options.layerServiceRequirements || layerServiceRequirements;
  const documentRef = options.document ?? globalThis.document;
  const connection = options.connection ?? globalThis.navigator?.connection;
  let storage = options.storage;
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const schedule = options.setInterval || globalThis.setInterval;
  const unschedule = options.clearInterval || globalThis.clearInterval;
  const scheduleAdmission = options.setTimeout || globalThis.setTimeout;
  const cancelAdmissionTimer = options.clearTimeout || globalThis.clearTimeout;
  const entries = new Map(catalog.map((meta) => [meta.id, {
    meta, requested: false, enabled: false, initialized: false,
    status: 'disabled', error: null, module: null, loading: null,
    queue: Promise.resolve(), revision: 0, controller: new AbortController(), admission: null, activating: false,
    timer: null, refreshing: false, refreshPromise: null, refreshOwner: null, refreshRevision: null, updateStarted: false,
    followupTimer: undefined, revalidationOwner: null, workSequence: 0, workState: null,
    refreshedAt: null, params: clone(meta.defaults), urls: new Set(), browserCache: null, browserCachedAt: null, revalidated: false, preparedDirty: false, preparedRevision: undefined,
  }]));
  const listeners = new Set([onStateChange]);
  let servicesPromise, services, destroyed = false, publishQueued = false, timelinePaused = false;
  let admissionTimer, activeAdmissions = 0;
  let admissionSequence = 0, admittedJobs = 0;
  const sceneWork = options.sceneWork || sceneWorkFor(viewer, { documentRef });
  const admissions = [], catalogOrder = new Map(catalog.map((meta, index) => [meta.id, index]));
  let localArea = validateArea(options.localArea);
  const historySuspends = (entry) => timelinePaused && !OBSERVED_FRAME_LAYERS.has(entry.meta.id);
  const stateEntry = (entry) => {
    let stats = {};
    try { stats = entry.module?.getStats?.() || {}; } catch { /* startup may precede stats */ }
    return {
      enabled: entry.requested, settledEnabled: entry.enabled,
      timelinePaused: historySuspends(entry),
      sceneMode: timelinePaused ? 'history' : 'live',
      status: entry.status === 'ready' && stats.loading ? 'loading' : entry.status,
      queued: entry.status === 'queued',
      activating: entry.activating,
      count: Number.isFinite(stats.count) ? stats.count : 0,
      lastUpdate: stats.lastUpdate ?? null,
      refreshedAt: entry.refreshedAt,
      observedAt: stats.observedAt ?? stats.observedAtMs ?? null,
      sourceAgeMs: stats.sourceAgeMs ?? stats.ageMs ?? null,
      ageMs: stats.ageMs ?? stats.sourceAgeMs ?? null,
      source: stats.source || entry.meta.source || null,
      sourceStatus: stats.status || null,
      degraded: stats.degraded === true,
      error: entry.error || stats.error || stats.lastError || (stats.keyRequired ? 'Provider key required' : null),
      refreshing: entry.refreshing,
      snapshot: stats.snapshot === true,
      stale: stats.stale === true || ['STALE', 'OFFLINE'].includes(stats.browserCache || entry.browserCache),
      browserCache: stats.browserCache || entry.browserCache,
      browserCachedAt: stats.browserCachedAt || entry.browserCachedAt,
      browserCacheAgeMs: (stats.browserCachedAt || entry.browserCachedAt) ? Math.max(0, Date.now() - (stats.browserCachedAt || entry.browserCachedAt)) : null,
      receipt: stats.receipt || null,
      checkedAt: stats.checkedAt || null,
      lastSuccessfulAt: stats.lastSuccessfulAt || null,
      sourceGeneratedAt: stats.sourceGeneratedAt || null,
      retainedSourceGeneratedAt: stats.retainedSourceGeneratedAt || null,
      factualEditionAgeMs: stats.factualEditionAgeMs ?? null,
      retainedSourceGenerationAgeMs: stats.retainedSourceGenerationAgeMs ?? null,
      mode: stats.mode || null,
      observationDate: stats.observationDate || null,
      coverage: stats.coverage || null,
      workPhase: entry.followupTimer !== undefined ? 'queued-update' : entry.workState?.workPhase || (entry.status === 'queued' ? 'queued-update' : null),
      preparedCount: entry.workState?.preparedCount || 0,
      preparationTotal: entry.workState?.preparationTotal ?? null,
      workMetrics: entry.workState?.workMetrics || null,
      editionMetrics: editionMetrics(stats.editionMetrics),
    };
  };
  const getState = () => Object.fromEntries([...entries].map(([id, entry]) => [id, stateEntry(entry)]));
  function publish() {
    if (publishQueued || destroyed) return;
    publishQueued = true;
    queueMicrotask(() => {
      publishQueued = false;
      if (destroyed) return;
      const state = getState();
      for (const callback of listeners) { try { callback(state); } catch (error) { console.error(error); } }
    });
  }
  function persist() {
    if (destroyed) return;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        layers: Object.fromEntries([...entries].map(([id, entry]) => [id, {
          enabled: entry.requested, params: entry.params,
        }])),
      }));
    } catch { /* Restricted storage must not prevent using the globe. */ }
  }
  function requireEntry(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Unknown layer: ${id}`);
    return entry;
  }
  function stopTimer(entry) {
    if (entry.timer !== null) unschedule(entry.timer);
    entry.timer = null;
  }
  function restartRequestLifetime(entry) {
    cancelFollowup(entry); entry.revalidated = false; entry.revalidationOwner = null;
    entry.controller.abort();
    entry.controller = new AbortController();
  }
  function cancelFollowup(entry) {
    if (entry.followupTimer !== undefined) cancelAdmissionTimer(entry.followupTimer);
    entry.followupTimer = undefined;
  }
  const allowed = entry => !destroyed && !historySuspends(entry) && entry.requested && entry.enabled && !documentRef?.hidden;
  function latestRefresh(entry) {
    // A queued same-owner read already absorbs the latest cache/source intent.
    if (entry.refreshing && !entry.updateStarted && entry.refreshOwner === entry.controller && entry.refreshRevision === entry.revision) return;
    entry.revalidated = true; entry.revalidationOwner = { revision: entry.revision, controller: entry.controller };
  }
  function followup(id, entry) {
    if (!entry.revalidated || entry.followupTimer !== undefined || !allowed(entry)) return;
    const owner = entry.revalidationOwner;
    if (!owner || owner.revision !== entry.revision || owner.controller !== entry.controller) { entry.revalidated = false; return; }
    entry.revalidated = false; entry.revalidationOwner = null;
    entry.followupTimer = scheduleAdmission(() => {
      entry.followupTimer = undefined;
      if (allowed(entry) && owner.revision === entry.revision && owner.controller === entry.controller) void refresh(id);
      publish();
    }, LAYER_REFRESH_FOLLOWUP_MS);
    publish();
  }
  function ownedWork(entry, revision, owner) {
    const sequence = ++entry.workSequence; let sourceEdition;
    const scope = sceneWork.scope({ key: `${entry.meta.id}:${sequence}`, signal: owner.signal,
      isCurrent: () => !destroyed && revision === entry.revision && owner === entry.controller && entry.requested &&
        !historySuspends(entry) && !documentRef?.hidden && (!sourceEdition || entry.preparedRevision?.fence === sourceEdition.fence),
      onChange(state) { if (!destroyed && sequence === entry.workSequence && revision === entry.revision) { entry.workState = state; publish(); } },
    });
    entry.workState = scope.getState();
    return { scope, owner, bindSource() { sourceEdition = entry.preparedRevision; } };
  }
  function completedWorkOutcome(entry) {
    let stats = {}; try { stats = entry.module?.getStats?.() || {}; } catch { /* No reported error. */ }
    return entry.error || stats.error || stats.lastError ? 'error' : 'complete';
  }
  function updateActiveServices() {
    services?.setActiveServices?.([...new Set([...entries].flatMap(([id, entry]) => !historySuspends(entry) && entry.requested && (entry.enabled || entry.activating) ? requiredServices(id) : []))]);
  }
  function cancelAdmission(entry) {
    const job = entry.admission;
    if (!job) return;
    entry.admission = null;
    const index = admissions.indexOf(job); if (index !== -1) admissions.splice(index, 1);
    if (!admissions.length && admissionTimer !== undefined) { cancelAdmissionTimer(admissionTimer); admissionTimer = undefined; }
    job.resolve(null);
  }
  const admissionPriority = entry => entry.meta.id === 'earthquakes' ? -2 : entry.meta.id === 'gdacs-notices' ? -1 : catalogOrder.get(entry.meta.id);
  function armAdmissions() {
    if (destroyed || admissionTimer !== undefined || activeAdmissions >= LAYER_ACTIVATION_LIMITS.concurrent || !admissions.length) return;
    // One admission per task gives input/rendering a turn between layer starts.
    admissionTimer = scheduleAdmission(() => {
      admissionTimer = undefined;
      if (destroyed || !admissions.length || activeAdmissions >= LAYER_ACTIVATION_LIMITS.concurrent) return;
      admissions.sort((a, b) => {
        const oldA = admittedJobs - a.queuedAfter >= FAIR_AFTER_ADMISSIONS, oldB = admittedJobs - b.queuedAfter >= FAIR_AFTER_ADMISSIONS;
        return oldA || oldB ? Number(oldB) - Number(oldA) || a.sequence - b.sequence : admissionPriority(a.entry) - admissionPriority(b.entry) || a.sequence - b.sequence;
      });
      const job = admissions.shift(), entry = job.entry;
      entry.admission = null;
      if (job.revision !== entry.revision || job.owner !== entry.controller || !entry.requested || historySuspends(entry) || documentRef?.hidden) job.resolve(null);
      else {
        admittedJobs++;
        activeAdmissions++; let released = false;
        job.resolve(() => { if (released) return; released = true; activeAdmissions--; armAdmissions(); });
      }
      armAdmissions();
    }, 0);
  }
  function admitWork(entry, revision, kind = 'activation') {
    if (destroyed || revision !== entry.revision || !entry.requested || historySuspends(entry) || documentRef?.hidden) return Promise.resolve(null);
    if (kind === 'activation') entry.status = 'queued'; publish();
    return new Promise(resolve => { const job = { entry, revision, owner: entry.controller, resolve,
      sequence: ++admissionSequence, queuedAfter: admittedJobs }; entry.admission = job; admissions.push(job); armAdmissions(); });
  }
  async function prepareServices(id) {
    const names = requiredServices(id);
    if (!names.length) return undefined;
    servicesPromise ||= Promise.resolve((options.createServices || createCoreServices)(viewer, { documentRef, fetchImpl }));
    services = await servicesPromise;
    updateActiveServices();
    return services.ensure ? services.ensure(names) : services;
  }
  async function preload(id) {
    const entry = requireEntry(id);
    if (destroyed || historySuspends(entry) || documentRef?.hidden || connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) return false;
    try { await preloadCode(id); return !destroyed; }
    catch { return false; } // Optional warm-up must not turn a checkbox into an error.
  }
  async function ensureModule(id) {
    const entry = requireEntry(id);
    if (destroyed) throw new DOMException('Application closed', 'AbortError');
    if (entry.module) return entry.module;
    if (!entry.loading) entry.loading = (async () => {
      // Engine code and its small, selective scene services load in parallel.
      const [layerServices] = await Promise.all([prepareServices(id), preloadCode(id)]);
      const sourceFetch = async (url, init = {}) => {
        if (historySuspends(entry) || documentRef?.hidden || !entry.requested) return Promise.reject(new DOMException('Layer is inactive', 'AbortError'));
        const signal = AbortSignal.any([entry.controller.signal, init.signal].filter(Boolean));
        signal.throwIfAborted();
        const absolute = new URL(String(url), globalThis.location?.origin || 'http://localhost').href;
        entry.urls.add(absolute);
        if (entry.urls.size > 30) entry.urls.delete(entry.urls.values().next().value);
        const response = await fetchImpl(url, { ...init, signal });
        signal.throwIfAborted();
        entry.browserCache = response.headers?.get?.('x-browser-cache') || null;
        entry.browserCachedAt = Number(response.headers?.get?.('x-browser-cached-at')) || null;
        return response;
      };
      const module = await factory(id, { services: layerServices, fetchImpl: sourceFetch, getLayer: ensureModule, getLocalArea: () => localArea });
      if (destroyed) { await module.destroy?.(viewer); throw new DOMException('Application closed', 'AbortError'); }
      entry.module = module;
      module.setLocalArea?.(localArea);
      module.attachDataManager?.(manager);
      module.attachShellServices?.({
        imageryHost: () => ({ collection: viewer.imageryLayers, kind: 'globe' }),
        runNavigation: async (work) => work(),
      });
      module.setParams?.(entry.params, { origin: 'user' });
      module.setRowControlsListener?.(publish);
      // Spatial adapters report demand through the same admission/lifetime
      // owner as source revisions, visibility and timeline changes.
      module.setDemandRefreshListener?.(() => manager.requestRefresh(id));
      return module;
    })().finally(() => { entry.loading = null; });
    return entry.loading;
  }
  async function refresh(id, { activationWork } = {}) {
    const entry = requireEntry(id);
    if (!allowed(entry)) return false;
    if (entry.refreshing) { latestRefresh(entry); return false; }
    cancelFollowup(entry);
    entry.refreshing = true;
    const owner = entry.controller, revision = entry.revision, module = entry.module;
    entry.refreshOwner = owner; entry.refreshRevision = revision;
    const work = activationWork || ownedWork(entry, revision, owner);
    publish();
    const operation = (async () => {
      let release, outcome = 'cancelled';
      try {
        // Initial update reuses its activation's physical permit. Recurring
        // reads join the same pool instead of multiplying startup concurrency.
        if (!activationWork) { release = await admitWork(entry, revision, 'refresh'); if (!release) return false; }
        if (!allowed(entry) || owner !== entry.controller || revision !== entry.revision || module !== entry.module) return false;
        work.bindSource(); work.scope.setPhase('acquiring'); entry.updateStarted = true;
        if (entry.preparedDirty) {
          entry.preparedDirty = false;
          module.invalidatePreparedSnapshot?.(entry.preparedRevision);
        }
        const updated = await module.update?.(viewer, { signal: owner.signal, work: work.scope });
        work.scope.assertCurrent();
        entry.error = null;
        if (updated !== false) entry.refreshedAt = Date.now();
        outcome = completedWorkOutcome(entry);
        return updated !== false;
      } catch (error) {
        outcome = aborted(error) || owner.signal.aborted ? 'cancelled' : 'error';
        if (!aborted(error) && !owner.signal.aborted && owner === entry.controller && revision === entry.revision) entry.error = error.message || 'Source unavailable';
        return false;
      } finally {
        entry.refreshing = false; entry.updateStarted = false;
        if (!activationWork) work.scope.finish(outcome);
        release?.();
        if (!owner.signal.aborted) viewer.scene?.requestRender?.();
        publish(); followup(id, entry);
      }
    })();
    entry.refreshPromise = operation;
    try { return await operation; } finally { if (entry.refreshPromise === operation) entry.refreshPromise = null; }
  }
  function armTimer(id, entry) {
    stopTimer(entry);
    if (historySuspends(entry) || documentRef?.hidden || !entry.requested || !entry.enabled || destroyed) return;
    const interval = entry.module?.updateInterval;
    if (Number.isFinite(interval) && interval > 0) entry.timer = schedule(() => { void refresh(id); }, Math.max(1000, interval));
  }
  async function reconcile(id, revision) {
    const entry = requireEntry(id);
    if (destroyed || revision !== entry.revision) return false;
    if (!entry.requested || historySuspends(entry)) {
      entry.status = 'disabling'; publish();
      if (entry.initialized) await entry.module.disable?.(viewer);
      entry.enabled = false; entry.status = entry.requested && historySuspends(entry) ? 'paused' : 'disabled'; entry.error = null;
      viewer.scene?.requestRender?.(); publish(); return true;
    }
    if (documentRef?.hidden) { entry.status = 'paused'; publish(); return false; }
    const work = ownedWork(entry, revision, entry.controller);
    const release = await admitWork(entry, revision);
    if (!release) { work.scope.finish('cancelled'); return false; }
    if (destroyed || revision !== entry.revision || !entry.requested || historySuspends(entry) || documentRef?.hidden) { work.scope.finish('cancelled'); release(); return false; }
    entry.activating = true;
    entry.status = 'loading'; entry.error = null; publish();
    let outcome = 'cancelled';
    try {
      work.scope.setPhase('acquiring');
      updateActiveServices();
      const module = await ensureModule(id);
      if (destroyed || revision !== entry.revision) return false;
      work.scope.assertCurrent();
      if (!entry.initialized) {
        // Mark before init: a partial initialization must also be cleaned up.
        entry.initialized = true;
        if ((await module.init?.(viewer, { signal: work.owner.signal, work: work.scope })) === false) throw new Error('Layer initialization failed');
      }
      if (destroyed || revision !== entry.revision) return false;
      work.scope.assertCurrent();
      module.setParams?.(entry.params, { origin: 'user' });
      if ((await module.enable?.(viewer, { signal: work.owner.signal, work: work.scope })) === false) throw new Error('Layer activation failed');
      if (destroyed || revision !== entry.revision) { await module.disable?.(viewer); return false; }
      entry.enabled = true; entry.status = 'ready';
      if (entry.refreshing) latestRefresh(entry);
      const refreshed = await refresh(id, { activationWork: work });
      if (revision !== entry.revision) return false;
      if (!refreshed) {
        let stats = {}; try { stats = module.getStats?.() || {}; } catch { /* No retained display proof. */ }
        const failure = entry.error || stats.error || stats.lastError;
        if (failure && !(Number(stats.count) > 0 || stats.lastUpdate != null)) throw new Error(String(failure));
      }
      outcome = completedWorkOutcome(entry);
      armTimer(id, entry); viewer.scene?.requestRender?.(); publish(); return true;
    } catch (error) {
      stopTimer(entry);
      outcome = aborted(error) ? 'cancelled' : 'error';
      try { await entry.module?.disable?.(viewer); } catch { /* destroy is the next recovery boundary */ }
      if (revision !== entry.revision || destroyed) return false;
      if (aborted(error) && documentRef?.hidden) {
        entry.enabled = false; entry.status = 'paused'; publish(); return false;
      }
      try { if (entry.initialized) await entry.module?.destroy?.(viewer); } catch { /* retain the original error */ }
      entry.initialized = false; entry.module = null;
      entry.enabled = false;
      updateActiveServices();
      entry.status = aborted(error) ? 'disabled' : 'error';
      entry.error = aborted(error) ? null : error.message || 'Layer could not start';
      persist(); publish(); return false;
    } finally { work.scope.finish(outcome); entry.activating = false; release(); updateActiveServices(); publish(); }
  }
  function setEnabled(id, enabled) {
    const entry = requireEntry(id);
    if (destroyed) return Promise.resolve(false);
    const next = Boolean(enabled);
    if (entry.requested === next && entry.enabled === next && entry.status !== 'error') return entry.queue.then(() => true);
    entry.requested = next;
    cancelAdmission(entry); updateActiveServices();
    const revision = ++entry.revision;
    entry.workState = null;
    stopTimer(entry); restartRequestLifetime(entry);
    entry.module?.cancelPendingRestore?.({ origin: 'user', reason: 'visibility changed' });
    entry.module?.cancelPendingTrackingRestore?.({ origin: 'user', reason: 'visibility changed' });
    entry.status = next ? historySuspends(entry) || documentRef?.hidden ? 'paused' : 'queued' : entry.initialized ? 'disabling' : 'disabled';
    persist(); publish();
    entry.queue = entry.queue.catch(() => {}).then(() => reconcile(id, revision));
    return entry.queue;
  }
  function setTimelineMode(mode) {
    if (!['live', 'history'].includes(mode)) throw new TypeError('Choose live or recorded timeline mode');
    if (destroyed) return Promise.resolve(false);
    const next = mode === 'history';
    if (timelinePaused === next) return Promise.all([...entries.values()].map((entry) => entry.queue));
    timelinePaused = next; updateActiveServices();
    for (const [id, entry] of entries) {
      cancelAdmission(entry);
      const revision = ++entry.revision;
      entry.workState = null;
      stopTimer(entry); restartRequestLifetime(entry); entry.revalidated = false;
      // This transition preserves requested intent and never writes preferences.
      if (entry.requested) entry.status = historySuspends(entry) || documentRef?.hidden ? 'paused' : 'queued';
      entry.queue = entry.queue.catch(() => {}).then(() => reconcile(id, revision));
    }
    publish();
    return Promise.all([...entries.values()].map((entry) => entry.queue));
  }
  function setLayerParams(id, values) {
    const entry = requireEntry(id);
    const safe = { ...values };
    if (id === 'flights' || id === 'military') safe.models3d = false;
    entry.params = { ...entry.params, ...clone(safe) };
    const result = entry.module?.setParams?.(safe, { origin: 'user' });
    // Action parameters (step, focus, play) are transient; persist engine settings.
    if (entry.module?.getParams) entry.params = clone(entry.module.getParams());
    persist(); viewer.scene?.requestRender?.(); publish(); return result !== false;
  }
  async function restore(ids) {
    if (destroyed) return;
    if (ids === undefined) {
      try {
        const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
        if (saved?.version === 1 && saved.layers && typeof saved.layers === 'object') {
          ids = [];
          for (const [id, value] of Object.entries(saved.layers)) {
            if (!entries.has(id)) continue;
            if (value.params && typeof value.params === 'object' && !Array.isArray(value.params)) setLayerParams(id, value.params);
            if (value.enabled === true) ids.push(id);
          }
        }
      } catch { /* Ignore unavailable or malformed local preferences. */ }
    }
    const chosen = new Set(Array.isArray(ids) ? ids : []);
    await Promise.all([...entries].map(([id]) => setEnabled(id, chosen.has(id))));
  }
  function visibilityChanged() {
    updateActiveServices();
    for (const [id, entry] of entries) {
      stopTimer(entry);
      cancelFollowup(entry); entry.revalidated = false; entry.revalidationOwner = null;
      if (documentRef?.hidden) {
        cancelAdmission(entry);
        if (entry.requested && !entry.enabled) entry.status = 'paused';
      }
      entry.controller.abort();
      if (!documentRef?.hidden) entry.controller = new AbortController();
      if (!historySuspends(entry) && !documentRef?.hidden && entry.enabled) {
        armTimer(id, entry);
        if (entry.refreshing) latestRefresh(entry);
        else void refresh(id);
      }
      else if (!historySuspends(entry) && !documentRef?.hidden && entry.requested) void setEnabled(id, true);
    }
    publish();
  }
  documentRef?.addEventListener?.('visibilitychange', visibilityChanged);
  const unsubscribeCache = fetchImpl.subscribe?.((url) => {
    if (destroyed || documentRef?.hidden) return;
    for (const [id, entry] of entries) {
      if (historySuspends(entry) || !entry.requested || !entry.urls.has(url)) continue;
      if (entry.refreshing) latestRefresh(entry);
      else void refresh(id);
    }
  });
  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (admissionTimer !== undefined) cancelAdmissionTimer(admissionTimer); admissionTimer = undefined;
    unsubscribeCache?.();
    documentRef?.removeEventListener?.('visibilitychange', visibilityChanged);
    sceneWork.destroy();
    for (const entry of entries.values()) { ++entry.revision; cancelAdmission(entry); cancelFollowup(entry); stopTimer(entry); entry.controller.abort(); entry.status = 'disabled'; }
    for (const entry of entries.values()) {
      await Promise.allSettled([entry.queue, entry.loading, entry.refreshPromise].filter(Boolean));
      try { await entry.module?.destroy?.(viewer); } catch (error) { console.error(error); }
      entry.module?.setRowControlsListener?.(null);
      entry.module = null;
    }
    await services?.destroy?.(); listeners.clear();
  }

  const manager = {
    viewer, getState, setEnabled, restore, destroy, refresh, preload, setTimelineMode,
    getWorkState: () => Object.freeze({ activeUpdates: activeAdmissions, queuedUpdates: admissions.length,
      limit: LAYER_ACTIVATION_LIMITS.concurrent, preparation: sceneWork.getState() }),
    requestRefresh(id, revision) {
      const entry = requireEntry(id);
      if (destroyed) return false;
      const reviewed = reviewedSourceRevision(id, revision);
      if (reviewed === null || reviewed && entry.preparedRevision && reviewed.fence <= entry.preparedRevision.fence) return false;
      if (reviewed) {
        entry.preparedRevision = reviewed;
        // Fence a running cache/body read immediately, before its follow-up is
        // admitted. The same revision is retained for a lazy or paused engine.
        if (entry.module?.invalidatePreparedSnapshot?.(reviewed) === false) return false;
      }
      // Retain one invalidation through lazy loading, hidden/history pauses and
      // disabled layers. The next permitted update must bypass an older HIT.
      entry.preparedDirty = true;
      if (historySuspends(entry) || documentRef?.hidden || !entry.requested || !entry.enabled) return false;
      if (entry.refreshing) latestRefresh(entry);
      else void refresh(id);
      return true;
    },
    isTimelinePaused: () => timelinePaused,
    getLocalArea: () => localArea ? { ...localArea } : null,
    setLocalArea(value) {
      const next = validateArea(value);
      if (JSON.stringify(next) === JSON.stringify(localArea)) return;
      localArea = next;
      for (const [id, entry] of entries) {
        if (entry.enabled) restartRequestLifetime(entry);
        entry.module?.setLocalArea?.(localArea);
        if (entry.enabled) {
          if (entry.refreshing) latestRefresh(entry);
          else void refresh(id);
        }
      }
      publish();
    },
    getLayer: (id) => requireEntry(id).module,
    isEnabled: (id) => Boolean(entries.get(id)?.enabled),
    isEffectivelyEnabled: (id) => Boolean(entries.get(id)?.requested) && !historySuspends(entries.get(id)),
    getLayerParams: (id) => clone(requireEntry(id).module?.getParams?.() || requireEntry(id).params),
    setLayerParams,
    adoptLayerParams(id, values) {
      const entry = requireEntry(id);
      entry.params = { ...entry.params, ...clone(values) };
      persist(); publish(); return true;
    },
    refreshLayerStats: publish,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    mountControls(id, container) { return mountLayerControls(manager, id, container); },
  };
  publish();
  return manager;
}

/** Small, safe controls surface for engine-owned option chips and source status. */
function mountLayerControls(manager, id, container) {
  let disposed = false, specialDispose, specialLoading = false, lastSignature;
  const render = () => {
    if (disposed) return;
    const module = manager.getLayer(id);
    if (manager.getState()[id]?.timelinePaused && manager.getState()[id]?.enabled) {
      lastSignature = undefined; container.textContent = 'Live layer paused while reviewing recorded metadata.'; return;
    }
    if (!module || !manager.getState()[id]?.enabled) { lastSignature = undefined; container.replaceChildren(); return; }
    if (id === 'recent-imagery') {
      if (!specialLoading) {
        specialLoading = true;
        Promise.all([import('../ui/recentImagery.js'), import('../ui/imageryBoxTool.js')]).then(([{ createRecentImageryPanel }, { initImageryBoxTool }]) => {
          if (disposed) return;
          const tool = initImageryBoxTool({ viewer: manager.viewer,
            onBox: (box) => module.setBox(box),
            onCancel: (_reason, message, box) => { if (message) module.reportBoxRefusal(message, box); },
            onActive: (active) => module.setToolActive(active),
            onEscape: () => module.clearPreview(),
          });
          const panel = createRecentImageryPanel({ container, viewer: manager.viewer, layer: module,
            tool });
          specialDispose = () => { panel?.destroy?.(); tool?.destroy?.(); };
        }).catch((error) => { if (!disposed) container.textContent = error.message; });
      }
      return;
    }
    const controls = module.getRowControls?.() || {};
    const signature = JSON.stringify(controls);
    if (signature === lastSignature) return;
    lastSignature = signature;
    const focusedKey = container.contains(document.activeElement) ? document.activeElement?.dataset?.controlKey : undefined;
    const fragment = document.createDocumentFragment();
    for (const [index, chip] of (controls.chips || []).entries()) {
      const button = document.createElement('button');
      button.dataset.controlKey = `chip:${chip.id || index}`;
      button.type = 'button'; button.className = 'layer-chip'; button.textContent = chip.label;
      button.title = chip.title || ''; button.disabled = Boolean(chip.disabled);
      button.setAttribute('aria-pressed', String(Boolean(chip.active)));
      button.addEventListener('click', () => manager.setLayerParams(id, chip.params || {}));
      fragment.append(button);
    }
    if (controls.info || controls.summary?.detail || controls.summary?.status) {
      const info = document.createElement('p'); info.className = 'layer-readout';
      info.textContent = controls.info || [controls.summary.detail, controls.summary.status].filter(Boolean).join(' · ');
      fragment.append(info);
    }
    if (Array.isArray(controls.items) && controls.items.length) {
      const list = document.createElement('ol'); list.className = 'layer-records';
      for (const [index, item] of controls.items.entries()) {
        const row = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'layer-chip';
        button.dataset.controlKey = `record:${item.id || index}`;
        button.textContent = item.label; button.title = item.detail || '';
        button.addEventListener('click', () => manager.setLayerParams(id, item.params || {}));
        row.append(button);
        if (item.detail) { const detail = document.createElement('span'); detail.textContent = item.detail; row.append(detail); }
        list.append(row);
      }
      fragment.append(list);
    }
    for (const item of controls.legend || []) {
      const swatch = document.createElement('span'); swatch.className = 'layer-legend';
      swatch.textContent = item.label; swatch.title = item.blurb || ''; swatch.style.borderColor = item.color;
      fragment.append(swatch);
    }
    if (['weather-radar', 'weather-satellite', 'weather-lightning'].includes(id)) {
      for (const [label, params] of [['Previous', { step: -1 }], ['Play / pause', { play: true }], ['Next', { step: 1 }], ['Latest', { latest: true }]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'layer-chip'; button.textContent = label;
        button.dataset.controlKey = `timeline:${label}`;
        button.addEventListener('click', () => manager.setLayerParams(id, params)); fragment.append(button);
      }
    }
    container.replaceChildren(fragment);
    if (focusedKey !== undefined) {
      [...container.querySelectorAll('[data-control-key]')].find((button) => button.dataset.controlKey === focusedKey)?.focus({ preventScroll: true });
    }
  };
  const unsubscribe = manager.subscribe(render);
  render();
  return () => { disposed = true; unsubscribe(); specialDispose?.(); container.replaceChildren(); };
}
