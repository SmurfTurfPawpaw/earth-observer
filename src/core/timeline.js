import * as Cesium from 'cesium';
import { createLiveClock } from './live-clock.js';

const MAX_SNAPSHOTS = 5000, MAX_REPORTS = 1000, MAX_BYTES = 1024 * 1024;
export const HISTORY_REFRESH_MS = 60000;
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

/** The selectable range is exclusively the snapshots the server actually lists. */
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
      observedAt: stamp(item.observedAt), publishedAt: stamp(item.publishedAt), sourceGeometryAt: stamp(item.sourceGeometryAt),
      indexedAt: stamp(item.indexedAt), updatedAt: stamp(item.updatedAt), retrievedAt: stamp(item.retrievedAt),
      closedAt: stamp(item.closedAt) }];
  }) : [];
  return { configured: value.configured, at: stamp(value.at), snapshots, reports,
    firstAt: snapshots[0]?.at || null, lastAt: snapshots.at(-1)?.at || null };
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
    if (!opened || destroyed || documentRef?.hidden) return;
    if (manifestPending) queuedInvalidation = true; else void acquireManifest(Boolean(manifest));
  }
  const update = (event) => {
    if (destroyed || !event) return;
    if (event.type === 'status' && ['connecting', 'connected', 'reconnecting', 'offline', 'hidden', 'unsupported'].includes(event.status)) {
      delivery = event.status; collectionRevision(event.revision); emit(); arm();
    } else if (event.type === 'collection' && event.schemaVersion === 1) collectionRevision(event.revision);
  };
  function acquire(at) {
    if (destroyed || !opened || documentRef?.hidden) return Promise.resolve(false);
    cancel(); const generation = owner, controller = new AbortController(); request = controller; loading = true; error = null; emit();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const work = (async () => {
      try {
        const response = await fetchImpl(`/api/history?${new URLSearchParams({ at })}`, { signal, headers: { Accept: 'application/json' }, cache: 'no-cache' });
        const result = normalizeHistory(await readJson(response, signal)); signal.throwIfAborted();
        if (destroyed || !opened || documentRef?.hidden || generation !== owner) return false;
        if (!result.configured || !result.snapshots.length || result.snapshots.some((snapshot) => snapshot.at > at)) throw new Error('No recorded coverage is available at this time');
        selection = { ...result, at };
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
      const canonical = stamp(at);
      if (!canonical || !manifest?.snapshots.some((snapshot) => snapshot.at === canonical)) return Promise.resolve(false);
      return acquire(canonical);
    },
    live() { if (destroyed) return; cancel(); selection = null; error = null; onTimeChange({ mode: 'live', at: null, reports: [], snapshots: [] }); emit(); },
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); cancelManifest(); if (typeof unsubscribeUpdates === 'function') unsubscribeUpdates(); documentRef?.removeEventListener?.('visibilitychange', visibility); windowRef?.removeEventListener?.('online', reconnect); },
  };
}

/** A compact UTC control with an expanded, dated archive independent of live layers. */
export function createTimeline({ container, viewer, fetchImpl, onTimeChange = () => {}, onNavigate,
  documentRef = container?.ownerDocument || globalThis.document, setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout, now = Date.now, windowRef = documentRef?.defaultView || globalThis.window, subscribeUpdates } = {}) {
  if (!container || !viewer?.earthTime || !documentRef) throw new TypeError('Timeline needs a container and astronomical clock');
  const node = (tag, className, value) => { const item = documentRef.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = value; return item; };
  const summary = node('summary', 'timeline-summary');
  const icon = node('span', 'timeline-clock-icon', '◷'); icon.setAttribute('aria-hidden', 'true');
  const mode = node('span', 'timeline-mode', 'Live'), clock = node('time', 'timeline-clock');
  summary.append(icon, mode, clock, node('span', 'timeline-chevron', '⌃'));
  const body = node('div', 'timeline-body');
  const controls = node('div', 'timeline-controls');
  const live = node('button', 'timeline-live', 'Live'); live.type = 'button'; live.setAttribute('aria-label', 'Return to current UTC and live layers');
  const back = node('button', 'icon-button', '‹'); back.type = 'button'; back.setAttribute('aria-label', 'Previous recorded snapshot');
  const forward = node('button', 'icon-button', '›'); forward.type = 'button'; forward.setAttribute('aria-label', 'Next recorded snapshot');
  const slider = node('input', 'timeline-range'); slider.type = 'range'; slider.min = '0'; slider.max = '0'; slider.step = '1'; slider.value = '0'; slider.disabled = true; slider.setAttribute('aria-label', 'Choose recorded UTC snapshot');
  const sunlight = node('button', 'timeline-sunlight', '☀'); sunlight.type = 'button'; sunlight.setAttribute('aria-label', 'Show or hide calculated UTC day and night'); sunlight.setAttribute('aria-pressed', 'true');
  const reload = node('button', 'icon-button', '↻'); reload.type = 'button'; reload.setAttribute('aria-label', 'Refresh recorded coverage');
  controls.append(live, back, slider, forward, sunlight, reload);
  const coverage = node('p', 'timeline-coverage'), captures = node('p', 'timeline-coverage'), status = node('p', 'timeline-status'); status.setAttribute('role', 'status');
  const note = node('p', 'timeline-note', 'Sun and Moon are calculated for UTC. Reviewing recorded metadata pauses live layers. Map imagery is not historical imagery. Satellite positions and orbit paths in Live mode are predictions from orbital elements.');
  const records = node('div', 'timeline-records'); records.setAttribute('aria-label', 'Recorded source metadata');
  body.append(controls, coverage, captures, status, note, records); container.replaceChildren(summary, body);
  let times = [], destroyed = false, renderedSelection, fallbackClock;
  const markers = [];
  const clearMarkers = () => { for (const entity of markers.splice(0)) viewer.entities?.remove(entity); };
  function showMarkers(state) {
    clearMarkers();
    for (const report of state.reports.filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon)).slice(0, 200)) {
      markers.push(viewer.entities.add({ name: `${report.title} · recorded metadata`,
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat, 1500),
        point: { pixelSize: 7, color: Cesium.Color.fromCssColorString('#ebcb90'), outlineColor: Cesium.Color.fromCssColorString('#17212c'), outlineWidth: 1.5 },
        properties: { source: report.source, observedAt: report.observedAt, retrievedAt: report.retrievedAt, recordedAt: state.at, url: report.url },
      }));
    }
    viewer.scene.requestRender();
  }
  const syncClock = () => {
    if (destroyed || documentRef.hidden) return;
    const state = fallbackClock?.getState() || viewer.earthTime.getState();
    clock.dateTime = state.at; clock.textContent = utc(state.at); mode.textContent = state.mode === 'live' ? 'Live' : 'Recorded';
    container.dataset.mode = state.mode;
  };
  function render(state) {
    const cursorAt = times[Number(slider.value)];
    times = [...new Set(state.manifest?.snapshots.map((snapshot) => snapshot.at) || [])];
    const selectionChanged = state.selection !== renderedSelection;
    const wantedAt = selectionChanged ? state.selection?.at : cursorAt || state.selection?.at;
    const wantedIndex = times.indexOf(wantedAt);
    slider.max = String(Math.max(0, times.length - 1));
    slider.value = String(wantedIndex >= 0 ? wantedIndex : Math.max(0, times.length - 1));
    slider.disabled = !times.length || state.loading;
    const index = Number(slider.value); back.disabled = !times.length || state.loading || index === 0;
    forward.disabled = !times.length || state.loading || index >= times.length - 1;
    reload.disabled = state.loading; live.setAttribute('aria-pressed', String(!state.selection));
    coverage.textContent = state.manifest?.configured === false ? 'Recording is not configured on this host.' : times.length ?
      `Recorded coverage: ${utc(times[0])} — ${utc(times.at(-1))} · ${times.length} capture times.` : state.manifest ? 'No snapshots have been recorded yet.' : 'Recorded coverage loads when this control opens.';
    captures.hidden = !state.selection;
    captures.textContent = state.selection ? state.selection.snapshots.slice(0, 12).map((snapshot) => `${snapshot.source}: captured ${utc(snapshot.at)} · ${snapshot.recordCount} records`).join(' · ') : '';
    const located = state.selection?.reports.filter((report) => Number.isFinite(report.lat) && Number.isFinite(report.lon)).length || 0;
    status.dataset.delivery = state.delivery;
    status.title = state.delivery === 'connected' ? 'Recorded coverage follows committed collection updates.' : 'Recorded coverage checks every minute while open; source dates remain unchanged.';
    status.textContent = state.loading ? 'Loading recorded metadata…' : state.error || (state.selection ? `${state.selection.reports.length} recorded records${located ? ` · ${Math.min(200, located)} of ${located} reported locations mapped` : ''} · source dates remain unchanged.` : 'Current UTC · live layers keep their own source update times.');
    if (!selectionChanged) { syncClock(); return; }
    renderedSelection = state.selection;
    if (!state.selection) { records.replaceChildren(); syncClock(); return; }
    const cards = state.selection.reports.slice(0, 40).map((report) => {
      const card = node('article', 'timeline-card'), anchor = node('a', '', report.title);
      anchor.href = report.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; card.append(anchor);
      const dates = report.kind === 'curated-event' ? [['Geometry', report.sourceGeometryAt], ['Closed', report.closedAt], ['Retrieved', report.retrievedAt]] :
        [['Event', report.observedAt], ['Published', report.publishedAt], ['Batch', report.indexedAt], ['Updated', report.updatedAt], ['Retrieved', report.retrievedAt]];
      card.append(node('p', '', [report.source, ...dates.filter(([, value]) => value).map(([label, value]) => `${label} ${utc(value)}`)].filter(Boolean).join(' · ')));
      if (Number.isFinite(report.lat) && typeof onNavigate === 'function') { const locate = node('button', '', 'View reported location'); locate.type = 'button'; locate.addEventListener('click', () => onNavigate(report)); card.append(locate); }
      return card;
    });
    records.replaceChildren(...cards);
    if (state.selection.reports.length > cards.length) records.append(node('p', 'timeline-note', `Showing ${cards.length} of ${state.selection.reports.length} recorded metadata records.`));
    syncClock();
  }
  const controller = createHistoryController({ fetchImpl, documentRef, windowRef, now, setTimeoutImpl, clearTimeoutImpl, subscribeUpdates, onChange: render,
    async onTimeChange(state) {
      if (state.mode === 'live') { clearMarkers(); viewer.earthTime.setTime(null); fallbackClock?.setTime(null); syncClock(); await onTimeChange(state); return; }
      await onTimeChange(state);
      if (destroyed || controller.getState().selection?.at !== state.at) return;
      viewer.earthTime.setTime(state.at); fallbackClock?.setTime(state.at); showMarkers(state); syncClock();
    } });
  const toggle = () => { if (container.open) void controller.open(); else controller.close(); };
  const choose = () => { const at = times[Number(slider.value)]; if (at) void controller.select(at); };
  const previous = () => { slider.value = String(Math.max(0, Number(slider.value) - 1)); choose(); };
  const next = () => { slider.value = String(Math.min(times.length - 1, Number(slider.value) + 1)); choose(); };
  const goLive = () => controller.live();
  const light = () => { const enabled = !viewer.earthTime.getState().lighting; viewer.earthTime.setLighting(enabled); sunlight.setAttribute('aria-pressed', String(enabled)); };
  const refresh = () => { void controller.refresh(); };
  for (const [element, name, callback] of [[container, 'toggle', toggle], [slider, 'change', choose], [back, 'click', previous], [forward, 'click', next], [live, 'click', goLive], [sunlight, 'click', light], [reload, 'click', refresh]]) element.addEventListener(name, callback);
  let unsubscribeClock;
  if (typeof viewer.earthTime.subscribeClock === 'function') unsubscribeClock = viewer.earthTime.subscribeClock(syncClock);
  else {
    fallbackClock = createLiveClock({ documentRef, now, setTimeoutImpl, clearTimeoutImpl });
    const current = viewer.earthTime.getState(); if (current.mode === 'history') fallbackClock.setTime(current.at);
    unsubscribeClock = fallbackClock.subscribe(syncClock);
  }
  render(controller.getState()); syncClock(); if (container.open) void controller.open();
  return {
    getState: controller.getState, live: goLive,
    destroy() {
      if (destroyed) return;
      destroyed = true; controller.destroy(); clearMarkers(); unsubscribeClock?.(); fallbackClock?.destroy();
      for (const [element, name, callback] of [[container, 'toggle', toggle], [slider, 'change', choose], [back, 'click', previous], [forward, 'click', next], [live, 'click', goLive], [sunlight, 'click', light], [reload, 'click', refresh]]) element.removeEventListener(name, callback);
    },
  };
}
