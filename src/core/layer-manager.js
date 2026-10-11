import { LAYERS } from './catalog.js';
import { createLayer as defaultFactory, preloadLayer as defaultPreload, layerServiceRequirements } from './layer-factories.js';
import { createCoreServices } from './services.js';
import { validateArea } from './local-area.js';

export const STORAGE_KEY = 'earth-observer:layers:v1';
const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));
const aborted = (error) => error?.name === 'AbortError';
// These adapters select genuine provider frames against the shared scene
// time and hide themselves across coverage gaps. Other layers are live-only
// until a dated source contract exists; current data cannot stand in for it.
const OBSERVED_FRAME_LAYERS = new Set(['weather-radar', 'weather-satellite', 'weather-lightning']);

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
  const entries = new Map(catalog.map((meta) => [meta.id, {
    meta, requested: false, enabled: false, initialized: false,
    status: 'disabled', error: null, module: null, loading: null,
    queue: Promise.resolve(), revision: 0, controller: new AbortController(),
    timer: null, refreshing: false, refreshedAt: null, params: clone(meta.defaults), urls: new Set(), browserCache: null, browserCachedAt: null, revalidated: false, preparedDirty: false,
  }]));
  const listeners = new Set([onStateChange]);
  let servicesPromise, services, destroyed = false, publishQueued = false, timelinePaused = false;
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
      stale: stats.stale === true || ['STALE', 'OFFLINE'].includes(entry.browserCache),
      browserCache: entry.browserCache,
      browserCachedAt: entry.browserCachedAt,
      browserCacheAgeMs: entry.browserCachedAt ? Math.max(0, Date.now() - entry.browserCachedAt) : null,
      mode: stats.mode || null,
      observationDate: stats.observationDate || null,
      coverage: stats.coverage || null,
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
    entry.controller.abort();
    entry.controller = new AbortController();
  }
  function updateActiveServices() {
    services?.setActiveServices?.([...new Set([...entries].flatMap(([id, entry]) => !historySuspends(entry) && entry.requested ? requiredServices(id) : []))]);
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
      return module;
    })().finally(() => { entry.loading = null; });
    return entry.loading;
  }
  async function refresh(id) {
    const entry = requireEntry(id);
    if (historySuspends(entry) || !entry.enabled || !entry.requested || entry.refreshing || documentRef?.hidden || destroyed) return false;
    entry.refreshing = true;
    const owner = entry.controller;
    publish();
    try {
      if (entry.preparedDirty) {
        entry.preparedDirty = false;
        entry.module.invalidatePreparedSnapshot?.();
      }
      const updated = await entry.module.update?.(viewer, { signal: owner.signal });
      if (owner.signal.aborted) return false;
      entry.error = null;
      if (updated !== false) entry.refreshedAt = Date.now();
      return updated !== false;
    } catch (error) {
      if (!aborted(error) && !owner.signal.aborted) entry.error = error.message || 'Source unavailable';
      return false;
    } finally {
      entry.refreshing = false;
      if (!owner.signal.aborted) viewer.scene?.requestRender?.();
      publish();
      if (entry.revalidated && !destroyed && !historySuspends(entry) && entry.requested && !documentRef?.hidden) {
        entry.revalidated = false;
        queueMicrotask(() => { void refresh(id); });
      }
    }
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
    entry.status = 'loading'; entry.error = null; publish();
    try {
      const module = await ensureModule(id);
      if (destroyed || revision !== entry.revision) return false;
      if (!entry.initialized) {
        // Mark before init: a partial initialization must also be cleaned up.
        entry.initialized = true;
        if ((await module.init?.(viewer, { signal: entry.controller.signal })) === false) throw new Error('Layer initialization failed');
      }
      if (destroyed || revision !== entry.revision) return false;
      module.setParams?.(entry.params, { origin: 'user' });
      if ((await module.enable?.(viewer, { signal: entry.controller.signal })) === false) throw new Error('Layer activation failed');
      if (destroyed || revision !== entry.revision) { await module.disable?.(viewer); return false; }
      entry.enabled = true; entry.status = 'ready';
      await refresh(id);
      if (revision !== entry.revision) return false;
      armTimer(id, entry); viewer.scene?.requestRender?.(); publish(); return true;
    } catch (error) {
      stopTimer(entry);
      try { await entry.module?.disable?.(viewer); } catch { /* destroy is the next recovery boundary */ }
      if (revision !== entry.revision || destroyed) return false;
      if (aborted(error) && documentRef?.hidden) {
        entry.enabled = false; entry.status = 'paused'; publish(); return false;
      }
      try { if (entry.initialized) await entry.module?.destroy?.(viewer); } catch { /* retain the original error */ }
      entry.initialized = false; entry.module = null;
      entry.enabled = false; entry.requested = false;
      updateActiveServices();
      entry.status = aborted(error) ? 'disabled' : 'error';
      entry.error = aborted(error) ? null : error.message || 'Layer could not start';
      persist(); publish(); return false;
    }
  }
  function setEnabled(id, enabled) {
    const entry = requireEntry(id);
    if (destroyed) return Promise.resolve(false);
    const next = Boolean(enabled);
    if (entry.requested === next && entry.enabled === next && entry.status !== 'error') return entry.queue.then(() => true);
    entry.requested = next;
    updateActiveServices();
    const revision = ++entry.revision;
    stopTimer(entry); restartRequestLifetime(entry);
    entry.module?.cancelPendingRestore?.({ origin: 'user', reason: 'visibility changed' });
    entry.module?.cancelPendingTrackingRestore?.({ origin: 'user', reason: 'visibility changed' });
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
      const revision = ++entry.revision;
      stopTimer(entry); restartRequestLifetime(entry); entry.revalidated = false;
      // This transition preserves requested intent and never writes preferences.
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
      entry.controller.abort();
      if (!documentRef?.hidden) entry.controller = new AbortController();
      if (!historySuspends(entry) && !documentRef?.hidden && entry.enabled) { armTimer(id, entry); void refresh(id); }
      else if (!historySuspends(entry) && !documentRef?.hidden && entry.requested) void setEnabled(id, true);
    }
    publish();
  }
  documentRef?.addEventListener?.('visibilitychange', visibilityChanged);
  const unsubscribeCache = fetchImpl.subscribe?.((url) => {
    if (destroyed || documentRef?.hidden) return;
    for (const [id, entry] of entries) {
      if (historySuspends(entry) || !entry.requested || !entry.urls.has(url)) continue;
      if (entry.refreshing) entry.revalidated = true;
      else void refresh(id);
    }
  });
  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribeCache?.();
    documentRef?.removeEventListener?.('visibilitychange', visibilityChanged);
    for (const entry of entries.values()) { ++entry.revision; stopTimer(entry); entry.controller.abort(); }
    for (const entry of entries.values()) {
      await Promise.allSettled([entry.queue, entry.loading].filter(Boolean));
      try { await entry.module?.destroy?.(viewer); } catch (error) { console.error(error); }
      entry.module?.setRowControlsListener?.(null);
      entry.module = null;
    }
    await services?.destroy?.(); listeners.clear();
  }

  const manager = {
    viewer, getState, setEnabled, restore, destroy, refresh, preload, setTimelineMode,
    requestRefresh(id) {
      const entry = requireEntry(id);
      if (destroyed) return false;
      // Retain one invalidation through lazy loading, hidden/history pauses and
      // disabled layers. The next permitted update must bypass an older HIT.
      entry.preparedDirty = true;
      if (historySuspends(entry) || documentRef?.hidden || !entry.requested || !entry.enabled) return false;
      if (entry.refreshing) entry.revalidated = true;
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
          if (entry.refreshing) entry.revalidated = true;
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
