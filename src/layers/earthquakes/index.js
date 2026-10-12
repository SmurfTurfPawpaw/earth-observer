import * as Cesium from 'cesium';
import { inLocalArea, validateArea } from '../../core/local-area.js';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';

/** Own one earthquake display and its refresh lifecycle. */
export function createEarthquakesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _snapshot = null;
  let _stateListener = null;
  let localArea;
  let publishedRows = new Map();

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,
    setLocalArea(value) {
      const next = validateArea(value);
      if (JSON.stringify(next) !== JSON.stringify(localArea)) _request?.abort();
      localArea = next;
    },
    setRowControlsListener(value) { _stateListener = typeof value === 'function' ? value : null; },
    invalidatePreparedSnapshot(revision) { return source.invalidate?.(revision) !== false; },

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('earthquakes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // Fixed pixel markers need no per-frame animation or render hold.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer, { signal: external } = {}) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const signal = AbortSignal.any([request.signal, external].filter(Boolean));
      const current = () => !signal.aborted && _request === request && _enabled && Boolean(_dataSource);
      try {
        const reconcileSnapshot = snapshot => {
          if (!current()) return false;
          const rows = Array.isArray(snapshot) ? snapshot : snapshot.records;

          const wanted = new Map();
          let count = 0;
          const overlayEntries = [];

          for (const row of rows) {
            const { stableId, usgsId, lon, lat, depthKm, mag, place, time } = row;
            if (!inLocalArea(lat, lon, localArea)) continue;
            count++;
            const color = depthColor(depthKm || 0);

            const position = Cesium.Cartesian3.fromDegrees(lon, lat);
            const id = `earthquake:${stableId}`, facts = { usgsId, mag, place, time, depth: depthKm,
              ...Object.fromEntries(['sourceUrl', 'updatedAt', 'eventType', 'reviewStatus', 'sourceTitle']
                .filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) };
            const record = { lon, lat, ...facts }, previous = publishedRows.get(id), existing = _dataSource.entities.getById(id);
            const changed = !previous || new Set([...Object.keys(record), ...Object.keys(previous)]).size !== Object.keys(record).length ||
              Object.keys(record).some(key => previous[key] !== record[key]);
            wanted.set(id, { record, facts, position, color, existing, changed, added: existing ? null :
              new Cesium.Entity({
                id,
                position,
                point: {
                  pixelSize: 11,
                  color,
                  outlineColor: Cesium.Color.fromCssColorString('#17212c'),
                  outlineWidth: 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                },
                properties: facts,
              }) });
            overlayEntries.push(
              createEarthquakeOverlayEntry({
                id: String(stableId),
                position,
                magnitude: mag,
                accent: color.toCssColorString(),
              }),
            );
          }

          // Keep unchanged object/property identity: Cesium clears its selection
          // when that object is removed, even if another entity uses the same ID.
          const entities = _dataSource.entities; entities.suspendEvents();
          try {
            for (const entity of entities.values.slice()) if (!wanted.has(entity.id)) entities.remove(entity);
            for (const [id, next] of wanted) {
              if (!next.existing) { entities.add(next.added); continue; }
              if (!next.changed) continue;
              const entity = next.existing, previous = publishedRows.get(id);
              // Retained proof belongs to its old exact facts; remove it before
              // any corrected position or property can become visible.
              if (entity.properties.hasProperty('_worldEvent')) entity.properties.removeProperty('_worldEvent');
              for (const key of ['sourceUrl', 'updatedAt', 'eventType', 'reviewStatus', 'sourceTitle'])
                if (!Object.hasOwn(next.facts, key) && entity.properties.hasProperty(key)) entity.properties.removeProperty(key);
              if (!previous || previous.lon !== next.record.lon || previous.lat !== next.record.lat) entity.position = next.position;
              for (const [key, value] of Object.entries(next.facts)) if (!previous || previous[key] !== value || !entity.properties.hasProperty(key)) {
                if (!entity.properties.hasProperty(key)) entity.properties.addProperty(key, value);
                else entity.properties[key] = value;
              }
              if (!previous || previous.depth !== next.record.depth) entity.point.color = next.color;
            }
            publishedRows = new Map([...wanted].map(([id, next]) => [id, next.record]));
          } finally { entities.resumeEvents(); }
          if (_enabled) {
            overlayHost.setEntries(
              EARTHQUAKE_OVERLAY_SOURCE_ID,
              selectEarthquakeOverlayCohort(overlayEntries),
              {
                cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
                collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
                moving: false,
              },
            );
          }

          _count = count;
          _snapshot = Array.isArray(snapshot) ? null : snapshot;
          _lastUpdate = _snapshot ? Date.parse(_snapshot.receipt.recordedAt) : Date.now();
          if (!_snapshot?.browserCache) _lastError = null;
          _stateListener?.();
          viewer.scene?.requestRender?.();
          return true;
        };
        const snapshot = await source.getSnapshot({ signal, onCached: reconcileSnapshot });
        if (!current()) return false;
        return reconcileSnapshot(snapshot);
      } catch (e) {
        if (!current() || e?.name === 'AbortError')
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || 'Earthquake source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      publishedRows.clear();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _snapshot = null;
      _stateListener = null;
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.usgsId?.getValue(now) ?? null,
              mag: p?.mag?.getValue(now),
              place: p?.place?.getValue(now),
              time: p?.time?.getValue(now),
              depth: p?.depth?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      const elapsed = _snapshot ? Math.max(0, Date.now() - _snapshot.browserReadAt) : 0;
      const sourceAgeMs = _snapshot ? _snapshot.sourceGenerationAgeMs + elapsed : null;
      const stale = Boolean(_lastError || _snapshot?.stale || sourceAgeMs !== null && sourceAgeMs > 120000);
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt: null,
        sourceAgeMs,
        stale,
        degraded: stale,
        status: _lastError ? 'unavailable' : _snapshot?.check.status || null,
        snapshot: false,
        browserCache: _snapshot?.browserCache || null,
        browserCachedAt: _snapshot?.browserCachedAt || null,
        receipt: _snapshot?.receipt || null,
        checkedAt: _snapshot?.check.checkedAt || null,
        lastSuccessfulAt: _snapshot?.check.lastSuccessfulAt || null,
        sourceGeneratedAt: _snapshot?.check.sourceGeneratedAt || null,
        retainedSourceGeneratedAt: _snapshot?.receipt.sourceUpdatedAt || null,
        factualEditionAgeMs: _snapshot ? _snapshot.factualEditionAgeMs + elapsed : null,
        retainedSourceGenerationAgeMs: _snapshot ? _snapshot.retainedSourceGenerationAgeMs + elapsed : null,
        coverage: _snapshot ? 'M2.5+ · rolling 24 hours · complete retained cohort' : null,
        cohortCoverage: _snapshot?.coverage || null,
      };
    },
  };
  return layer;
}
