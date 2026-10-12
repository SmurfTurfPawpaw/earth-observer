import { worldHash } from './world-model.js';
import { WORLD_SCENE_SCOPE } from './world-scene-controller.js';

const MAX_BYTES = 256 * 1024;
const iso = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Reject another event or revision, even when its stable USGS identity matches. */
export function matchingWorldEvent(event, selected, { id, knownAt, revision, archiveScope } = {}) {
  const publishedAt = archiveScope ? event?.archive?.publishedAt : event?.capture?.publishedAt;
  if (!event || event.id !== id || event.schemaVersion !== 1 || event.kind !== 'earthquake' ||
      event.source?.id !== 'usgs' || event.evidence?.sourceRecordId !== `usgs:${selected.usgsId}` ||
      !/^[a-f0-9]{64}$/.test(event.evidence?.revision || '') || !/^[a-f0-9]{64}$/.test(event.evidence?.snapshotId || '') ||
      !Number.isFinite(selected.time) || !Number.isFinite(new Date(selected.time).getTime()) ||
      iso(event.eventTime?.at) !== new Date(selected.time).toISOString() ||
      event.reportedFacts?.magnitude !== selected.mag ||
      !Number.isFinite(selected.lat) || !Number.isFinite(selected.lon) ||
      Math.abs(event.place?.lat - selected.lat) > .00001 || Math.abs(event.place?.lon - selected.lon) > .00001 ||
      !Number.isFinite(event.place?.lat) || !Number.isFinite(event.place?.lon) ||
      !iso(publishedAt) || !iso(event.knowledge?.firstRecordedAt) || event.knowledge.firstRecordedAt > publishedAt ||
      revision && event.evidence.revision !== revision ||
      archiveScope && (event.archive?.scopeId !== archiveScope || !/^[a-f0-9]{64}$/.test(event.archive.chunkId || '')) ||
      knownAt && (publishedAt > knownAt || event.knowledge.firstRecordedAt > knownAt)) return null;
  return event;
}

/** Selected features use retained evidence; idle frames perform no work or acquisition. */
export function installWorldDossierBridge({ viewer, readSelection, fetchImpl = globalThis.fetch,
  subscribeUpdates, url = `${import.meta.env?.BASE_URL || '/'}api/world/events`,
  sceneUrl = `${import.meta.env?.BASE_URL || '/'}api/world/scene/events`, now = Date.now } = {}) {
  let destroyed = false, generation = 0, request;
  const cache = new Map();
  const clear = (entity) => { if (entity?.properties?.hasProperty?.('_worldEvent')) entity.properties.removeProperty('_worldEvent'); };
  async function refresh() {
    const owner = ++generation; request?.abort(); request = undefined;
    const entity = viewer.selectedEntity;
    let selected;
    try { selected = readSelection(entity); } catch { return false; }
    if (!selected || !/^[a-zA-Z0-9_-]{1,100}$/.test(selected.usgsId || '')) { clear(entity); return false; }
    const scene = viewer.earthTime.getState();
    const context = selected._worldScene;
    const ownedScene = context !== undefined;
    const archiveScope = ownedScene ? WORLD_SCENE_SCOPE : null;
    if (ownedScene && (scene.mode !== 'history' || context?.schemaVersion !== 1 || context.scopeId !== archiveScope || context.window !== '7d' ||
        !['reconstruction', 'as-known'].includes(context.mode) || context.knownMode !== (context.mode === 'as-known' ? 'scene' : 'none') ||
        !/^archive:\d+$/.test(context.version || '') || !/^[a-f0-9]{64}$/.test(context.revision || '') ||
        context.sourceRecordId !== `usgs:${selected.usgsId}` || !iso(scene.at))) { clear(entity); return false; }
    const knownAt = scene.mode === 'history' && (!ownedScene || context.mode === 'as-known') ? iso(scene.at) : null;
    if (scene.mode === 'history' && (!ownedScene || context.mode === 'as-known') && !knownAt) return false;
    let id;
    try { id = `event:usgs:${await worldHash(['usgs', `usgs:${selected.usgsId}`])}`; } catch { return false; }
    if (destroyed || owner !== generation || viewer.selectedEntity !== entity) return false;
    // A report opened from source context is a fixed retained revision. It is
    // not a scene feature and never borrows the selected historical cutoff.
    if (selected._worldReport?.schemaVersion === 1 && selected._worldReport.kind === 'retained-source-context') {
      const valid = Boolean(matchingWorldEvent(selected._worldEvent, selected, { id, revision: selected._worldReport.revision }));
      if (!valid) clear(entity);
      return valid;
    }
    if (ownedScene && (context.eventId !== id || selected.time > Date.parse(scene.at) || selected.time <= Date.parse(scene.at) - 7 * 86400000)) { clear(entity); return false; }
    const matchOptions = { id, knownAt, ...(ownedScene ? { archiveScope, revision: context.revision } : {}) };
    // A complete scene already carries its admitted projection. Keep it; a
    // recent live-membership endpoint cannot establish archived evidence.
    if (ownedScene && matchingWorldEvent(selected._worldEvent, selected, matchOptions)) return true;
    clear(entity);
    const key = ownedScene ? `${id}:scene:${context.version}:${context.revision}:${scene.at}:${context.mode}` : `${id}:${knownAt || 'live'}`;
    let event = cache.get(key);
    try {
      if (!event || now() - event.cachedAt > 60000) {
        const controller = new AbortController(); request = controller;
        const endpoint = ownedScene ? `${sceneUrl}/${id}?${new URLSearchParams({ at: iso(scene.at), window: '7d', scope: archiveScope,
          revision: context.revision, ...(knownAt ? { knownMode: 'scene' } : {}) })}` : `${url}/${id}${knownAt ? `?${new URLSearchParams({ knownAt })}` : ''}`;
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
            knownAt && payload.knownAt !== knownAt || ownedScene && (payload.scope?.id !== archiveScope || payload.at !== iso(scene.at) ||
              payload.mode !== context.mode || payload.version !== context.version || payload.knownMode !== context.knownMode)) return false;
        event = { value: payload.event, cachedAt: now() };
        if (destroyed || owner !== generation) return false;
        cache.set(key, event);
        if (cache.size > 24) cache.delete(cache.keys().next().value);
      }
      const value = matchingWorldEvent(event.value, selected, matchOptions);
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
