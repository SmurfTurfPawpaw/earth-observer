import { worldHash } from './world-model.js';

const MAX_BYTES = 256 * 1024;
const iso = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Reject another event or revision, even when its stable USGS identity matches. */
export function matchingWorldEvent(event, selected, { id, knownAt } = {}) {
  if (!event || event.id !== id || event.schemaVersion !== 1 || event.kind !== 'earthquake' ||
      event.source?.id !== 'usgs' || event.evidence?.sourceRecordId !== `usgs:${selected.usgsId}` ||
      !/^[a-f0-9]{64}$/.test(event.evidence?.revision || '') || !/^[a-f0-9]{64}$/.test(event.evidence?.snapshotId || '') ||
      !Number.isFinite(selected.time) || !Number.isFinite(new Date(selected.time).getTime()) ||
      iso(event.eventTime?.at) !== new Date(selected.time).toISOString() ||
      event.reportedFacts?.magnitude !== selected.mag ||
      !Number.isFinite(selected.lat) || !Number.isFinite(selected.lon) ||
      Math.abs(event.place?.lat - selected.lat) > .00001 || Math.abs(event.place?.lon - selected.lon) > .00001 ||
      !Number.isFinite(event.place?.lat) || !Number.isFinite(event.place?.lon) ||
      !iso(event.capture?.publishedAt) || !iso(event.knowledge?.firstRecordedAt) ||
      knownAt && (event.capture.publishedAt > knownAt || event.knowledge.firstRecordedAt > knownAt)) return null;
  return event;
}

/** Selected features use retained evidence; idle frames perform no work or acquisition. */
export function installWorldDossierBridge({ viewer, readSelection, fetchImpl = globalThis.fetch,
  subscribeUpdates, url = `${import.meta.env?.BASE_URL || '/'}api/world/events`, now = Date.now } = {}) {
  let destroyed = false, generation = 0, request;
  const cache = new Map();
  const clear = (entity) => { if (entity?.properties?.hasProperty?.('_worldEvent')) entity.properties.removeProperty('_worldEvent'); };
  async function refresh() {
    const owner = ++generation; request?.abort(); request = undefined;
    const entity = viewer.selectedEntity;
    clear(entity);
    let selected;
    try { selected = readSelection(entity); } catch { return false; }
    if (!selected || !/^[a-zA-Z0-9_-]{1,100}$/.test(selected.usgsId || '')) return false;
    const scene = viewer.earthTime.getState();
    const knownAt = scene.mode === 'history' ? iso(scene.at) : null;
    if (scene.mode === 'history' && !knownAt) return false;
    let id;
    try { id = `event:usgs:${await worldHash(['usgs', `usgs:${selected.usgsId}`])}`; } catch { return false; }
    if (destroyed || owner !== generation || viewer.selectedEntity !== entity) return false;
    const key = `${id}:${knownAt || 'live'}`;
    let event = cache.get(key);
    try {
      if (!event || now() - event.cachedAt > 60000) {
        const controller = new AbortController(); request = controller;
        const endpoint = `${url}/${id}${knownAt ? `?${new URLSearchParams({ knownAt })}` : ''}`;
        const response = await fetchImpl(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store' });
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) return false;
        const reader = response.body?.getReader(); if (!reader) return false;
        let size = 0, body = '', decoder = new TextDecoder();
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_BYTES) { await reader.cancel(); return false; }
            body += decoder.decode(part.value, { stream: true });
          }
        } finally { reader.releaseLock(); }
        const payload = JSON.parse(body + decoder.decode());
        if (payload.schemaVersion !== 1 || payload.available !== true || payload.configured !== true ||
            knownAt && payload.knownAt !== knownAt) return false;
        event = { value: payload.event, cachedAt: now() };
        if (destroyed || owner !== generation) return false;
        cache.set(key, event);
        if (cache.size > 24) cache.delete(cache.keys().next().value);
      }
      const value = matchingWorldEvent(event.value, selected, { id, knownAt });
      if (!value || destroyed || owner !== generation || viewer.selectedEntity !== entity) return false;
      entity.properties.addProperty('_worldEvent', value);
      return true;
    } catch { return false; }
    finally { if (owner === generation) request = undefined; }
  }
  const unsubscribeSelection = viewer.selectedEntityChanged.addEventListener(() => { void refresh(); });
  const unsubscribeUpdates = subscribeUpdates?.((update) => {
    if (update.type !== 'collection') return;
    for (const key of cache.keys()) if (key.endsWith(':live')) cache.delete(key);
    if (viewer.earthTime.getState().mode === 'live') void refresh();
  });
  return { refresh, destroy() {
    destroyed = true; ++generation; request?.abort(); cache.clear();
    clear(viewer.selectedEntity); unsubscribeSelection?.(); unsubscribeUpdates?.();
  } };
}
