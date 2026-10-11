export { createTimeline } from './world-timeline.js';

const MAX_SNAPSHOTS = 5000, MAX_REPORTS = 1000, MAX_BYTES = 1024 * 1024;
export const HISTORY_REFRESH_MS = 60000;
const HISTORY_CACHE_LIMIT = 3;
const stamp = (value) => {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
const utc = (value) => stamp(value)?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') || 'Time unavailable';
function linkUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null; }
  catch { return null; }
}

/** Durable coverage may exceed the bounded catalog; recent-index coverage may not. */
export function normalizeHistory(value) {
  if (!value || typeof value.configured !== 'boolean' || !Array.isArray(value.snapshots) || value.snapshots.length > MAX_SNAPSHOTS) throw new Error('Recorded coverage is invalid');
  const seen = new Set();
  const snapshots = value.snapshots.flatMap((item) => {
    const at = stamp(item?.at), id = text(item?.id, 160), source = text(item?.source, 80);
    if (!at || !id || !source || !Number.isInteger(item.recordCount) || item.recordCount < 0 || item.recordCount > 10000) return [];
    const key = `${at}|${source}|${id}`;
    if (seen.has(key)) return []; seen.add(key);
    return [{ at, id, source, recordCount: item.recordCount }];
  }).sort((a, b) => a.at.localeCompare(b.at) || a.source.localeCompare(b.source));
  if (value.snapshots.length && !snapshots.length) throw new Error('Recorded coverage has no usable snapshots');
  const reports = Array.isArray(value.reports) ? value.reports.slice(0, MAX_REPORTS).flatMap((item) => {
    const url = linkUrl(item?.url), title = text(item?.title);
    if (!url || !title) return [];
    const point = item.kind !== 'topic-mention' && item.kind !== 'curated-event' &&
      Number.isFinite(item.lat) && Math.abs(item.lat) <= 90 && Number.isFinite(item.lon) && Math.abs(item.lon) <= 180;
    return [{ id: text(item.id), title, url, source: text(item.source || item.sourceId, 80), sourceId: text(item.sourceId, 80), kind: text(item.kind, 40),
      ...(point ? { lat: item.lat, lon: item.lon } : {}),
      ...(Number.isFinite(item.magnitude) ? { magnitude: item.magnitude } : {}),
      observedAt: stamp(item.observedAt), publishedAt: stamp(item.publishedAt), sourceGeometryAt: stamp(item.sourceGeometryAt),
      indexedAt: stamp(item.indexedAt), updatedAt: stamp(item.updatedAt), retrievedAt: stamp(item.retrievedAt),
      closedAt: stamp(item.closedAt) }];
  }) : [];
  const indexMode = ['d1-full-history', 'r2-recent-history'].includes(value.indexMode) ? value.indexMode : null;
  const durableFirst = stamp(value.firstAt), durableLast = stamp(value.lastAt);
  const fullRange = value.configured && indexMode === 'd1-full-history' && snapshots.length &&
    durableFirst && durableLast && durableFirst <= snapshots[0].at && durableLast >= snapshots.at(-1).at;
  const hasNextCapture = indexMode === 'd1-full-history' && Object.hasOwn(value, 'nextCaptureAt');
  const nextCaptureAt = stamp(value.nextCaptureAt);
  if (hasNextCapture && value.nextCaptureAt !== null && !nextCaptureAt) throw new Error('Recorded capture boundary is invalid');
  return { configured: value.configured, at: stamp(value.at), selectedAt: stamp(value.selectedAt), snapshots, reports, indexMode,
    firstAt: fullRange ? durableFirst : snapshots[0]?.at || null, lastAt: fullRange ? durableLast : snapshots.at(-1)?.at || null,
    ...(hasNextCapture ? { nextCaptureAt } : {}) };
}

async function readJson(response, signal) {
  if (!response.ok) throw new Error(`Recorded history HTTP ${response.status}`);
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) throw new Error('Recorded history is too large');
  if (!response.body?.getReader) {
    const value = await response.json(); signal.throwIfAborted();
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES) throw new Error('Recorded history is too large');
    return value;
  }
  const reader = response.body.getReader(), parts = []; let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Recorded history is too large');
      parts.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(joined));
}

/** Own optional archive acquisition. Closing/hidden panels reject late results. */
export function createHistoryController({ fetchImpl = (...args) => fetch(...args), documentRef = globalThis.document,
  windowRef = documentRef?.defaultView || globalThis.window, now = Date.now,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout,
  subscribeUpdates, onChange = () => {}, onTimeChange = () => {} } = {}) {
  let opened = false, destroyed = false, owner = 0, request, pending, manifest = null, selection = null, error = null, loading = false;
  let manifestOwner = 0, manifestRequest, manifestPending, manifestLoading = false, manifestError = null, checkedAt = null, timer;
  let delivery = 'unsupported', revision = null, manifestDirty = true, queuedInvalidation = false;
  const cache = new Map();
  const captureKey = (items) => JSON.stringify([...items].sort((a, b) => a.source.localeCompare(b.source))
    .map(({ source, at, id }) => [source, at, id]));
  const windowAt = (at) => {
    const canonical = stamp(at);
    if (!canonical || !manifest?.firstAt || canonical < manifest.firstAt || canonical > manifest.lastAt) return null;
    // The newest catalog is a contiguous, bounded tail. Before it begins,
    // only an as-of response with a proven next boundary can define a window.
    if (canonical < manifest.snapshots[0].at) {
      for (const [key, entry] of cache) {
        if (entry.complete && canonical >= entry.firstAt && (entry.nextAt ? canonical < entry.nextAt : canonical <= entry.lastAt)) {
          return { key, firstAt: entry.firstAt, nextAt: entry.nextAt, complete: true };
        }
      }
      return { key: `exact:${canonical}`, firstAt: canonical, nextAt: null, complete: false };
    }
    const latest = new Map(); let nextAt = null;
    for (const snapshot of manifest.snapshots) {
      if (snapshot.at <= canonical) latest.set(snapshot.source, snapshot);
      else { nextAt = snapshot.at; break; }
    }
    return { key: `catalog:${captureKey(latest.values())}`, firstAt: [...latest.values()].map((item) => item.at).sort().at(-1), nextAt, complete: true };
  };
  const state = () => ({ opened, loading: loading || manifestLoading, manifest, selection, error: error || manifestError,
    mode: selection ? 'history' : 'live', delivery, revision });
  const emit = () => { if (!destroyed) onChange(state()); };
  const cancel = () => { ++owner; request?.abort(); request = null; pending = null; loading = false; };
  const stopTimer = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const cancelManifest = () => {
    ++manifestOwner; if (manifestPending) manifestDirty = true;
    manifestRequest?.abort(); manifestRequest = null; manifestPending = null; manifestLoading = false; queuedInvalidation = false; stopTimer();
  };
  function arm() {
    stopTimer();
    if (!opened || destroyed || documentRef?.hidden || manifestPending || delivery === 'connected') return;
    const delay = checkedAt === null ? HISTORY_REFRESH_MS : Math.max(1000, HISTORY_REFRESH_MS - Math.max(0, now() - checkedAt));
    timer = setTimeoutImpl(() => { timer = undefined; void acquireManifest(true); }, delay);
  }
  function acquireManifest(background = false) {
    if (destroyed || !opened || documentRef?.hidden) return Promise.resolve(false);
    if (manifestPending) return manifestPending;
    stopTimer(); const generation = ++manifestOwner, controller = new AbortController(); manifestRequest = controller;
    const requestedRevision = revision; queuedInvalidation = false;
    manifestLoading = !background || !manifest; manifestError = null;
    if (manifestLoading) emit();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const work = (async () => {
      try {
        const response = await fetchImpl('/api/history', { signal, headers: { Accept: 'application/json' }, cache: 'no-cache' });
        const result = normalizeHistory(await readJson(response, signal)); signal.throwIfAborted();
        if (destroyed || !opened || documentRef?.hidden || generation !== manifestOwner) return false;
        manifest = result; manifestDirty = revision !== requestedRevision; return true;
      } catch (failure) {
        if (controller.signal.aborted || generation !== manifestOwner) return false;
        manifestDirty = true; manifestError = failure.message || 'Recorded coverage refresh is unavailable'; return false;
      } finally {
        if (generation === manifestOwner && !destroyed) {
          manifestRequest = null; manifestPending = null; manifestLoading = false; checkedAt = now(); emit();
          if (queuedInvalidation && opened && !documentRef?.hidden) void acquireManifest(true); else arm();
        }
      }
    })();
    manifestPending = work; return work;
  }
  // Collection revision invalidates the catalog, never the visitor's capture.
  // Keep the subscription while closed so its next open knows what changed;
  // this controller performs no archive requests outside visible open panels.
  function collectionRevision(value) {
    if (typeof value !== 'string' || !value || value.length > 160 || value === revision) return;
    revision = value; manifestDirty = true;
    cache.clear();
    if (!opened || destroyed || documentRef?.hidden) return;
    if (manifestPending) queuedInvalidation = true; else void acquireManifest(Boolean(manifest));
  }
  const update = (event) => {
    if (destroyed || !event) return;
    if (event.type === 'status' && ['connecting', 'connected', 'reconnecting', 'offline', 'hidden', 'unsupported'].includes(event.status)) {
      delivery = event.status; collectionRevision(event.revision); emit(); arm();
    } else if (event.type === 'collection' && event.schemaVersion === 1) collectionRevision(event.revision);
  };
  function acquire(at, window) {
    if (destroyed || !opened || documentRef?.hidden) return Promise.resolve(false);
    cancel(); const generation = owner, controller = new AbortController(); request = controller; loading = true; error = null; emit();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const work = (async () => {
      try {
        let result = selection?.at !== at ? cache.get(window.key)?.result : null;
        const cached = Boolean(result);
        if (!result) {
          const response = await fetchImpl(`/api/history?${new URLSearchParams({ at })}`, { signal, headers: { Accept: 'application/json' }, cache: 'no-cache' });
          result = normalizeHistory(await readJson(response, signal)); signal.throwIfAborted();
        }
        if (destroyed || !opened || documentRef?.hidden || generation !== owner) return false;
        if (!result.configured || !result.snapshots.length || result.snapshots.some((snapshot) => snapshot.at > at) ||
            !cached && result.selectedAt && result.selectedAt !== at) throw new Error('No recorded coverage is available at this time');
        let resolved = window;
        if (!window.complete && Object.hasOwn(result, 'nextCaptureAt')) {
          if (result.nextCaptureAt !== null && result.nextCaptureAt <= at) throw new Error('Recorded capture boundary is invalid');
          resolved = { key: `archive:${captureKey(result.snapshots)}`, firstAt: result.snapshots.at(-1).at,
            nextAt: result.nextCaptureAt, complete: true };
        }
        cache.delete(resolved.key); cache.set(resolved.key, { result, ...resolved, lastAt: manifest.lastAt });
        while (cache.size > HISTORY_CACHE_LIMIT) cache.delete(cache.keys().next().value);
        selection = { ...result, at, windowKey: resolved.key, windowKnown: resolved.complete };
        await onTimeChange({ mode: 'history', at, reports: selection.reports, snapshots: selection.snapshots });
        if (destroyed || !opened || documentRef?.hidden || generation !== owner) return false;
        return true;
      } catch (failure) {
        if (controller.signal.aborted || generation !== owner) return false;
        error = failure.message || 'Recorded history is unavailable'; return false;
      } finally { if (generation === owner && !destroyed) { request = null; pending = null; loading = false; emit(); } }
    })();
    pending = work; return work;
  }
  const visibility = () => { if (documentRef?.hidden) { cancel(); cancelManifest(); emit(); } else if (opened) void acquireManifest(Boolean(manifest)); };
  const reconnect = () => { if (opened && !destroyed && !documentRef?.hidden) void acquireManifest(Boolean(manifest)); };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  windowRef?.addEventListener?.('online', reconnect);
  let unsubscribeUpdates;
  try { unsubscribeUpdates = subscribeUpdates?.(update); } catch { delivery = 'unsupported'; }
  return {
    getState: state,
    open() {
      if (destroyed) return Promise.resolve(false);
      opened = true; emit();
      if (!manifest || manifestDirty || checkedAt === null || (delivery !== 'connected' && now() - checkedAt >= HISTORY_REFRESH_MS)) return acquireManifest(Boolean(manifest));
      arm(); return Promise.resolve(true);
    },
    close() { opened = false; cancel(); cancelManifest(); emit(); },
    refresh() { return acquireManifest(Boolean(manifest)); },
    select(at) {
      const canonical = stamp(at), window = windowAt(canonical);
      if (!window) return Promise.resolve(false);
      return acquire(canonical, window);
    },
    getWindow: windowAt,
    live() { if (destroyed) return; cancel(); selection = null; error = null; onTimeChange({ mode: 'live', at: null, reports: [], snapshots: [] }); emit(); },
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); cancelManifest(); cache.clear(); if (typeof unsubscribeUpdates === 'function') unsubscribeUpdates(); documentRef?.removeEventListener?.('visibilitychange', visibility); windowRef?.removeEventListener?.('online', reconnect); },
  };
}
