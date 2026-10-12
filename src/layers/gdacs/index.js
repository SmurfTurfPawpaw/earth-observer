import * as Cesium from 'cesium';
import { inLocalArea, validateArea } from '../../core/local-area.js';
import { mappedGdacsRecord } from '../../core/gdacs-source-items.js';
import { gdacsNoticeType } from '../../core/gdacs-dossier.js';
import { createMapBillboard, gdacsMapSymbol, gdacsAlertColor, mapSymbolImage } from '../../core/map-symbols.js';

const noticeId = item => `gdacs-notice:${item.itemId}`;
const sourceDate = value => value ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : 'Date not reported';

/** Constant source notices, not inferred world incidents or historical features. */
export function createGdacsNoticesLayer({ source, documentRef = globalThis.document } = {}) {
  if (typeof source?.getSnapshot !== 'function') throw new TypeError('GDACS notices require a stored cohort source');
  let viewer, dataSource, request, enabled = false, localArea, snapshot, error, listener;
  let previous = new Map();
  const basis = (value, item) => ({ schemaVersion: 1, version: value.version, source: value.source, item, cohort: value.cohort,
    coverage: value.coverage, operational: value.operational, history: value.history });
  function reconcile(value, owner, signal) {
    if (signal.aborted || request !== owner || !enabled || !dataSource) return false;
    const wanted = new Set(), next = new Map(), entities = dataSource.entities;
    entities.suspendEvents();
    try {
      for (const item of value.items) {
        const id = noticeId(item), record = item.record, mapped = mappedGdacsRecord(record), old = previous.get(id);
        const symbol = gdacsMapSymbol(record), color = gdacsAlertColor(record.alertLevel);
        wanted.add(id); next.set(id, { revision: item.revision, version: value.version, lat: record.lat, lon: record.lon, symbol, color });
        let entity = entities.getById(id);
        if (!entity) entity = entities.add(new Cesium.Entity({ id, name: record.title, properties: { _gdacsNotice: basis(value, item) } }));
        else if (!old || old.revision !== item.revision || old.version !== value.version) {
          entity.name = record.title;
          entity.properties._gdacsNotice = basis(value, item);
        }
        if (mapped) {
          if (!old || old.lat !== record.lat || old.lon !== record.lon || !entity.position)
            entity.position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
          if (!entity.billboard) entity.billboard = createMapBillboard(symbol, {
            color: Cesium.Color.fromCssColorString(color), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND });
          else {
            if (!old || old.symbol !== symbol) entity.billboard.image = mapSymbolImage(symbol);
            if (!old || old.color !== color) entity.billboard.color = Cesium.Color.fromCssColorString(color);
          }
          entity.show = inLocalArea(record.lat, record.lon, localArea);
        } else {
          entity.position = undefined; entity.billboard = undefined; entity.show = false;
        }
      }
      for (const entity of entities.values.slice()) if (!wanted.has(entity.id)) entities.remove(entity);
      previous = next;
    } finally { entities.resumeEvents(); }
    snapshot = value;
    if (!value.browserCache) error = null;
    listener?.(); viewer.scene?.requestRender?.(); return true;
  }
  const layer = {
    id: 'gdacs-notices', name: 'Disaster notices · GDACS', source: 'GDACS', updateInterval: 60000,
    setLocalArea(value) {
      const next = validateArea(value); if (JSON.stringify(next) !== JSON.stringify(localArea)) request?.abort(); localArea = next;
    },
    setRowControlsListener(value) { listener = typeof value === 'function' ? value : null; },
    invalidatePreparedSnapshot() { return source.invalidate?.() !== false; },
    init(value) {
      if (viewer) throw new Error('GDACS notice layer is already initialized'); viewer = value;
      dataSource = new Cesium.CustomDataSource('gdacs-notices'); dataSource.show = false; viewer.dataSources.add(dataSource);
    },
    enable() { enabled = true; if (dataSource) dataSource.show = true; },
    disable() { request?.abort(); request = null; enabled = false; if (dataSource) dataSource.show = false; },
    async update(_viewer = viewer, { signal: external } = {}) {
      if (!enabled || !dataSource) return false;
      request?.abort(); const owner = new AbortController(); request = owner;
      const signal = AbortSignal.any([owner.signal, external].filter(Boolean));
      try {
        const value = await source.getSnapshot({ signal, onCached: cached => reconcile(cached, owner, signal) });
        return reconcile(value, owner, signal);
      } catch (failure) {
        if (signal.aborted || request !== owner || !enabled || failure?.name === 'AbortError') return false;
        error = failure?.message || 'Stored GDACS notices unavailable'; return false;
      } finally { if (request === owner) request = null; }
    },
    setParams(values) {
      if (!enabled || !dataSource?.show || documentRef?.hidden || viewer?.isDestroyed?.() ||
          viewer?.earthTime?.getState?.()?.mode === 'history' || !/^item:[a-f0-9]{64}$/.test(values?.inspectItem || '')) return false;
      const entity = dataSource?.entities.getById(`gdacs-notice:${values.inspectItem}`);
      if (!entity || !previous.has(entity.id)) return false;
      // An unlocated notice is a source-context selection with no position or
      // graphics. Inspection never manufactures a pin or moves scene/camera.
      if (viewer.selectedEntity === entity) {
        // Layers can obscure the dossier while keeping Cesium's selection.
        // Re-present its current evidence without a clear/reselect transition.
        if (typeof viewer.selectedEntityChanged?.raiseEvent !== 'function') return false;
        viewer.selectedEntityChanged.raiseEvent(entity);
      } else viewer.selectedEntity = entity;
      viewer.scene?.requestRender?.(); return true;
    },
    getParams() { return {}; },
    getRowControls() {
      if (!snapshot) return { info: error || 'Retained GDACS notices are not loaded.' };
      const count = snapshot.counts;
      return { info: `${count.returned} retained notices · ${count.mapped} with indicative locations · ${count.unmapped} without a location. Operational freshness unknown.`,
        items: snapshot.items.map(item => ({ id: item.itemId,
          label: item.record.title.slice(0, 100), detail: `${gdacsNoticeType(item.record.eventType)} · ${mappedGdacsRecord(item.record) ? 'Indicative location' : 'Location not reported'} · source revised ${sourceDate(item.record.updatedAt)}`,
          params: { inspectItem: item.itemId } })) };
    },
    getStats() {
      return { count: dataSource?.entities.values.filter(entity => entity.show && Boolean(entity.position)).length || 0,
        lastUpdate: snapshot ? Date.parse(snapshot.cohort.publishedAt) : null, error: error || null,
        status: error ? 'unavailable' : 'unknown', sourceAgeMs: null, observedAt: null, checkedAt: null,
        stale: error || snapshot?.browserCache ? true : null, degraded: Boolean(error), snapshot: false,
        browserCache: snapshot?.browserCache || null, browserCachedAt: snapshot?.browserCachedAt || null,
        coverage: snapshot ? 'Retained seven-day GDACS notice sample · indicative locations · operational freshness unknown' : null,
        cohortCoverage: snapshot?.coverage || null, cohort: snapshot?.cohort || null, sourceGenerationAgeMs: null };
    },
    destroy() {
      request?.abort(); request = null; source.invalidate?.(); enabled = false;
      if (dataSource) viewer?.dataSources.remove(dataSource, true);
      dataSource = null; viewer = null; snapshot = null; error = null; listener = null; previous.clear();
    },
  };
  return layer;
}
