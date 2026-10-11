import * as Cesium from 'cesium';
import { createSceneClock } from './scene-clock.js';

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

/** Calendar playback shares scene time; evidence requests occur at capture boundaries. */
export function createTimeline({ container, viewer, fetchImpl, onTimeChange = () => {}, onNavigate,
  documentRef = container?.ownerDocument || globalThis.document, setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout, now = Date.now, monotonicNow,
  windowRef = documentRef?.defaultView || globalThis.window, subscribeUpdates } = {}) {
  if (!container || !viewer?.earthTime || !documentRef) throw new TypeError('Timeline needs a container and astronomical clock');
  const node = (tag, className, value) => { const item = documentRef.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = value; return item; };
  const existingDock = container.parentElement?.className?.split(/\s+/).includes('earth-time-dock');
  const dock = existingDock ? container.parentElement : node('div', 'earth-time-dock');
  if (!existingDock) { container.replaceWith?.(dock); dock.append(container); }
  const summary = node('summary', 'timeline-summary');
  summary.setAttribute('aria-label', 'Calendar and recorded coverage');
  summary.setAttribute('aria-controls', 'timeline-calendar');
  const icon = node('span', 'timeline-clock-icon', '◷'); icon.setAttribute('aria-hidden', 'true');
  const mode = node('span', 'timeline-mode', 'Live'), clock = node('time', 'timeline-clock');
  const readout = node('div', 'timeline-readout'); readout.setAttribute('role', 'group'); readout.setAttribute('aria-label', 'Scene UTC time'); readout.append(icon, mode, clock);
  const transport = node('span', 'timeline-transport');
  transport.setAttribute('role', 'group'); transport.setAttribute('aria-label', 'World time controls');
  const play = node('button', 'icon-button timeline-play', '▶'); play.type = 'button'; play.id = 'timeline-play'; play.dataset.action = 'play';
  const live = node('button', 'timeline-live', 'Live'); live.type = 'button'; live.dataset.action = 'live'; live.setAttribute('aria-label', 'Return to current UTC and live layers');
  const rate = node('select', 'timeline-rate'); rate.id = 'timeline-rate'; rate.setAttribute('aria-label', 'History playback speed'); rate.title = 'Elapsed world time per second';
  for (const [value, label] of [[1, '1 s / s'], [60, '1 min / s'], [3600, '1 h / s'], [86400, '1 day / s']]) {
    const option = node('option', '', label); option.value = String(value); rate.append(option);
  }
  transport.append(play, rate, live); summary.append(node('span', 'timeline-chevron', '⌃'));
  const body = node('div', 'timeline-body'); body.id = 'timeline-calendar';
  const controls = node('div', 'timeline-controls');
  const back = node('button', 'icon-button', '‹'); back.type = 'button'; back.setAttribute('aria-label', 'Step backward in recorded time');
  const forward = node('button', 'icon-button', '›'); forward.type = 'button'; forward.setAttribute('aria-label', 'Step forward in recorded time');
  const slider = node('input', 'timeline-range'); slider.type = 'range'; slider.min = '0'; slider.max = '0'; slider.step = '1'; slider.value = '0'; slider.disabled = true; slider.setAttribute('aria-label', 'Choose historical UTC time');
  const date = node('input', 'timeline-date'); date.id = 'timeline-date'; date.type = 'datetime-local'; date.step = '1'; date.setAttribute('aria-label', 'Historical date and time in UTC'); date.title = 'UTC, within recorded coverage';
  const sunlight = node('button', 'timeline-sunlight', '☀'); sunlight.type = 'button'; sunlight.setAttribute('aria-label', 'Show or hide calculated UTC day and night'); sunlight.setAttribute('aria-pressed', 'true');
  const reload = node('button', 'icon-button', '↻'); reload.type = 'button'; reload.setAttribute('aria-label', 'Refresh recorded coverage');
  controls.append(back, date, forward, sunlight, reload);
  const ruler = node('div', 'timeline-ruler'), firstLabel = node('time'), lastLabel = node('time'); ruler.append(firstLabel, node('span', '', 'UTC'), lastLabel);
  const coverage = node('p', 'timeline-coverage'), captures = node('p', 'timeline-coverage'), status = node('p', 'timeline-status'); status.setAttribute('role', 'status');
  const note = node('p', 'timeline-note', 'Playback follows recorded coverage. Source evidence changes at its captured times; sunlight follows the selected UTC. Layers without historical support are unavailable in history. Base map imagery is not historical imagery.');
  const records = node('div', 'timeline-records'); records.setAttribute('aria-label', 'Recorded source metadata');
  body.append(controls, slider, ruler, status, coverage, captures, note, records); container.replaceChildren(summary, body);
  dock.replaceChildren(readout, transport, container);
  let destroyed = false, renderedSelection, controller, pendingAt = null, dragging = false, selecting = false, playIntent = false, seekOwner = 0;
  const fallbackClock = typeof viewer.earthTime.subscribeClock === 'function' ? null : createSceneClock({ documentRef, now, monotonicNow, setTimeoutImpl, clearTimeoutImpl });
  const sceneTime = fallbackClock || viewer.earthTime;
  if (fallbackClock && viewer.earthTime.getState().mode === 'history') fallbackClock.seek(viewer.earthTime.getState().at);
  const setTime = (at) => { viewer.earthTime.setTime(at); fallbackClock?.setTime(at); };
  const markers = [];
  const clearMarkers = () => { for (const entity of markers.splice(0)) viewer.entities?.remove(entity); };
  function showMarkers(state) {
    clearMarkers();
    for (const report of state.reports.filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon)).slice(0, 200)) {
      const usgsId = report.sourceId === 'usgs' && report.id.startsWith('usgs:') ? report.id.slice(5) : null;
      const observed = Date.parse(report.observedAt);
      markers.push(viewer.entities.add({ name: report.title,
        position: Cesium.Cartesian3.fromDegrees(report.lon, report.lat, 0),
        point: { pixelSize: 7, color: Cesium.Color.fromCssColorString('#9ddcc9'), outlineColor: Cesium.Color.fromCssColorString('#17212c'), outlineWidth: 1.5 },
        properties: { source: report.source, observedAt: report.observedAt, retrievedAt: report.retrievedAt, recordedAt: state.at, url: report.url,
          ...(usgsId ? { usgsId, ...(Number.isFinite(report.magnitude) ? { mag: report.magnitude } : {}), ...(Number.isFinite(observed) ? { time: observed } : {}) } : {}) },
      }));
    }
    viewer.scene.requestRender();
  }
  const syncClock = () => {
    if (destroyed || documentRef.hidden) return;
    const state = sceneTime.getState();
    clock.dateTime = state.at; clock.textContent = utc(state.at); mode.textContent = state.mode === 'live' ? 'Live' : state.playing ? 'Playing' : 'History';
    container.dataset.mode = dock.dataset.mode = state.mode; container.dataset.playing = dock.dataset.playing = String(Boolean(state.playing));
    summary.setAttribute('aria-expanded', String(Boolean(container.open))); summary.title = container.open ? 'Hide calendar and recorded coverage' : 'Show calendar and recorded coverage';
    play.textContent = state.playing || selecting && playIntent ? 'Ⅱ' : '▶';
    const playLabel = state.playing || selecting && playIntent ? 'Pause historical playback' : 'Play recorded history';
    play.setAttribute('aria-label', playLabel); play.title = playLabel;
    play.setAttribute('aria-pressed', String(Boolean(state.playing)));
    rate.value = String(state.rate || 3600); live.setAttribute('aria-pressed', String(state.mode === 'live'));
    const manifest = controller?.getState().manifest;
    play.disabled = typeof sceneTime.play !== 'function' || Boolean(manifest && (!manifest.firstAt || manifest.firstAt === manifest.lastAt));
    if (manifest?.firstAt && !dragging) {
      const at = pendingAt || (state.mode === 'history' ? state.at : manifest.lastAt);
      slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), Date.parse(at) / 1000)));
      slider.setAttribute('aria-valuetext', utc(at));
      if (documentRef.activeElement !== date) date.value = at.slice(0, 19);
    }
    if (playIntent && !selecting && !state.playing && state.mode === 'history') {
      playIntent = false; if (!container.open) controller?.close();
    }
    if (!playIntent || selecting || !state.playing || !controller?.getState().opened) return;
    const window = controller.getWindow(state.at);
    if (window && window.key !== controller.getState().selection?.windowKey) void selectTime(state.at, true);
  };
  function render(state) {
    const manifest = state.manifest, available = Boolean(manifest?.firstAt);
    const selectionChanged = state.selection?.windowKey !== renderedSelection?.windowKey || !state.selection !== !renderedSelection;
    if (available) {
      slider.min = String(Date.parse(manifest.firstAt) / 1000); slider.max = String(Date.parse(manifest.lastAt) / 1000);
      date.min = manifest.firstAt.slice(0, 19); date.max = manifest.lastAt.slice(0, 19);
      firstLabel.dateTime = manifest.firstAt; firstLabel.textContent = utc(manifest.firstAt).slice(0, 16);
      lastLabel.dateTime = manifest.lastAt; lastLabel.textContent = utc(manifest.lastAt).slice(0, 16);
      const selected = sceneTime.getState();
      if (selected.mode === 'live' || selected.at >= manifest.firstAt && selected.at <= manifest.lastAt) {
        sceneTime.setCoverage?.({ firstAt: manifest.firstAt, lastAt: manifest.lastAt });
      } else if (selected.playing) { playIntent = false; sceneTime.pause?.(); }
    }
    slider.disabled = !available || state.loading; date.disabled = !available || state.loading;
    back.disabled = forward.disabled = !available || state.loading;
    reload.disabled = state.loading;
    coverage.textContent = manifest?.configured === false ? 'Recording is not configured on this host.' : available ?
      `Recorded coverage: ${utc(manifest.firstAt)} — ${utc(manifest.lastAt)}.` : manifest ? 'No snapshots have been recorded yet.' : 'Open the timeline or press Play to load recorded coverage.';
    captures.hidden = !state.selection;
    captures.textContent = state.selection ? state.selection.snapshots.slice(0, 12).map((snapshot) => `${snapshot.source}: captured ${utc(snapshot.at)} · ${snapshot.recordCount} records`).join(' · ') : '';
    const located = state.selection?.reports.filter((report) => Number.isFinite(report.lat) && Number.isFinite(report.lon)).length || 0;
    status.dataset.delivery = state.delivery;
    status.title = state.delivery === 'connected' ? 'Recorded coverage follows committed collection updates.' : 'Recorded coverage checks every minute while open; source dates remain unchanged.';
    status.textContent = state.loading ? 'Loading recorded metadata…' : state.error || (state.selection ?
      `${state.selection.reports.length} recorded records${located ? ` · ${Math.min(200, located)} of ${located} reported locations mapped` : ''} · source dates remain unchanged.${state.selection.windowKnown === false ? ' Playback pauses here until the next capture boundary is available; calendar seeks remain available.' : ''}` :
      'Current UTC · live layers keep their own source update times.');
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
  controller = createHistoryController({ fetchImpl, documentRef, windowRef, now, setTimeoutImpl, clearTimeoutImpl, subscribeUpdates, onChange: render,
    async onTimeChange(state) {
      if (state.mode === 'live') { clearMarkers(); setTime(null); syncClock(); await onTimeChange(state); return; }
      await onTimeChange(state);
      if (destroyed || controller.getState().selection?.at !== state.at) return;
      setTime(state.at); showMarkers(state); syncClock();
    } });
  async function selectTime(at, resume = false) {
    const canonical = stamp(at); if (!canonical || destroyed) return false;
    const owner = ++seekOwner; playIntent = resume; selecting = true; pendingAt = canonical; sceneTime.pause?.(); syncClock();
    try {
      if (!controller.getState().opened) await controller.open();
      if (destroyed || owner !== seekOwner) return false;
      const accepted = await controller.select(canonical);
      if (destroyed || owner !== seekOwner) return false;
      selecting = false; pendingAt = null;
      if (accepted && playIntent && controller.getState().selection?.windowKnown) playIntent = sceneTime.play?.() === true; else playIntent = false;
      if (!container.open && !playIntent) controller.close();
      syncClock(); return accepted;
    } finally { if (owner === seekOwner) { selecting = false; pendingAt = null; syncClock(); } }
  }
  const toggle = () => { syncClock(); if (container.open || playIntent) void controller.open(); else controller.close(); };
  const drag = () => { dragging = true; playIntent = false; sceneTime.pause?.(); slider.setAttribute('aria-valuetext', utc(new Date(Number(slider.value) * 1000).toISOString())); };
  const choose = () => { dragging = false; void selectTime(new Date(Number(slider.value) * 1000).toISOString()); };
  const step = (direction) => {
    const manifest = controller.getState().manifest; if (!manifest?.firstAt) return;
    const start = Date.parse(manifest.firstAt), end = Date.parse(manifest.lastAt), span = end - start;
    const distance = span <= 7200000 ? 60000 : span <= 172800000 ? 3600000 : 86400000;
    const current = sceneTime.getState().mode === 'history' ? Date.parse(sceneTime.getState().at) : end;
    void selectTime(new Date(Math.max(start, Math.min(end, current + direction * distance))).toISOString());
  };
  const previous = () => step(-1), next = () => step(1);
  const goLive = (event) => { event?.stopPropagation?.(); ++seekOwner; playIntent = false; selecting = false; pendingAt = null; dragging = false; controller.live(); if (!container.open) controller.close(); };
  const playPause = async (event) => {
    event?.stopPropagation?.();
    if (sceneTime.getState().playing || selecting && playIntent) {
      ++seekOwner; playIntent = false; selecting = false; pendingAt = null; sceneTime.pause?.(); syncClock();
      if (!container.open) controller.close(); return;
    }
    const owner = ++seekOwner; playIntent = true; selecting = true; syncClock();
    await controller.open(); if (destroyed || owner !== seekOwner || !playIntent) return;
    const manifest = controller.getState().manifest;
    if (!manifest?.firstAt || manifest.firstAt === manifest.lastAt) { selecting = false; playIntent = false; syncClock(); return; }
    const state = sceneTime.getState(), at = state.mode === 'history' && state.at < manifest.lastAt ? state.at : manifest.firstAt;
    void selectTime(at, true);
  };
  const changeRate = (event) => { event?.stopPropagation?.(); sceneTime.setRate?.(Number(rate.value)); };
  const chooseDate = () => { const at = stamp(`${date.value}Z`); if (at) void selectTime(at); };
  const light = () => { const enabled = !viewer.earthTime.getState().lighting; viewer.earthTime.setLighting(enabled); sunlight.setAttribute('aria-pressed', String(enabled)); };
  const refresh = () => { void controller.refresh(); };
  const bindings = [[container, 'toggle', toggle], [slider, 'input', drag], [slider, 'change', choose], [date, 'change', chooseDate], [back, 'click', previous], [forward, 'click', next], [play, 'click', playPause], [rate, 'change', changeRate], [live, 'click', goLive], [sunlight, 'click', light], [reload, 'click', refresh]];
  for (const [element, name, callback] of bindings) element.addEventListener(name, callback);
  const unsubscribeClock = fallbackClock ? fallbackClock.subscribe(syncClock) : viewer.earthTime.subscribeClock(syncClock);
  render(controller.getState()); syncClock(); if (container.open) void controller.open();
  return {
    getState: controller.getState, live: goLive, seek: (at) => selectTime(at),
    destroy() {
      if (destroyed) return;
      destroyed = true; ++seekOwner; sceneTime.pause?.(); controller.destroy(); clearMarkers(); unsubscribeClock?.(); fallbackClock?.destroy();
      for (const [element, name, callback] of bindings) element.removeEventListener(name, callback);
      readout.remove?.(); transport.remove?.();
      if (!existingDock) dock.replaceWith?.(container);
    },
  };
}
