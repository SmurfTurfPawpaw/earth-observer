import * as Cesium from 'cesium';
import { TRANSIT_ENABLED_FEEDS, haversineKm, transitModeFor } from '../data/transitFeeds.js';

const FIX_MAX_AGE_MS = 600000;
const FEED_MAX_AGE_MS = 300000;
const MODE_COLORS = { bus: '#83d6a5', tram: '#dfbf71', subway: '#db9292', rail: '#c4b1e2', ferry: '#86ccd9', unknown: '#c2c9d0' };

/** Keep the source's latest reported coordinates; no journey is inferred between reports. */
export function normalizeTransitRecords(feed, snapshot, now = Date.now()) {
  if (!Array.isArray(snapshot?.vehicles)) throw new Error('Transit observations are invalid');
  const seen = new Set();
  return snapshot.vehicles.slice(0, 15000).flatMap((record) => {
    if (!record?.id || seen.has(record.id) || !Number.isFinite(record.lat) || !Number.isFinite(record.lon) || Math.abs(record.lat) > 90 || Math.abs(record.lon) > 180) return [];
    seen.add(record.id);
    const stamped = Number.isFinite(record.timestamp) && record.timestamp > 0 ? record.timestamp * 1000 : null;
    const fetchedAt = Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt > 0 ? snapshot.fetchedAt : null;
    const observedAt = stamped ?? fetchedAt;
    if (observedAt !== null && (now - observedAt > FIX_MAX_AGE_MS || observedAt > now + 10000)) return [];
    return [{ ...record, id: String(record.id), observedAt,
      timestampSource: record.timestampSource || (stamped ? 'vehicle' : fetchedAt ? 'fetch' : 'unknown'),
      mode: transitModeFor(feed, record.routeId), feed }];
  });
}

function viewCenter(viewer) {
  const rectangle = viewer.camera.computeViewRectangle?.(viewer.scene.globe?.ellipsoid);
  const position = rectangle ? Cesium.Rectangle.center(rectangle) : viewer.camera.positionCartographic;
  if (!position) return null;
  return { lat: Cesium.Math.toDegrees(position.latitude), lon: Cesium.Math.toDegrees(position.longitude) };
}

export function createObservedTransitLayer({ fetchImpl = (...args) => fetch(...args), catalog = TRANSIT_ENABLED_FEEDS } = {}) {
  let viewer, dataSource, request, manager, removeMoveEnd, viewTimer, onChange;
  let enabled = false, lastUpdate = null, count = 0, active = [], error = null, zoomIn = false;
  const snapshots = new Map(), credits = new Map();
  const creditDisplay = () => viewer?.cesiumWidget?.creditDisplay || viewer?.creditDisplay || viewer?.scene?.frameState?.creditDisplay;
  const removeCredits = () => {
    for (const credit of credits.values()) creditDisplay()?.removeStaticCredit(credit);
    credits.clear();
  };
  const layer = {
    id: 'transit', updateInterval: 30000,
    attachDataManager(nextManager) { manager = nextManager; },
    setRowControlsListener(listener) { onChange = listener; },
    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('transit-observations'); dataSource.show = false;
      viewer.dataSources.add(dataSource);
      removeMoveEnd = viewer.camera.moveEnd?.addEventListener(() => {
        if (!enabled) return;
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => { if (enabled) void manager?.refresh('transit'); }, 350);
      });
    },
    enable() { enabled = true; dataSource.show = true; },
    disable() {
      enabled = false; request?.abort(); request = null; clearTimeout(viewTimer);
      if (dataSource) dataSource.show = false;
      snapshots.clear(); active = []; count = 0; removeCredits();
      if (String(viewer?.selectedEntity?.id || '').startsWith('transit:')) viewer.selectedEntity = undefined;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const center = viewCenter(viewer);
        zoomIn = (viewer.camera.positionCartographic?.height ?? Infinity) > 3000000;
        const desired = !zoomIn && center ? catalog.filter((feed) => haversineKm(center.lat, center.lon, feed.center.lat, feed.center.lon) <= feed.loadRadiusKm) : [];
        const results = await Promise.all(desired.map(async (feed) => {
          try {
            const response = await fetchImpl(`/api/transit/vehicles/${encodeURIComponent(feed.id)}`, { signal: combined, headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`${feed.name} HTTP ${response.status}`);
            const snapshot = await response.json();
            if (!Array.isArray(snapshot?.vehicles)) throw new Error(`${feed.name} observations are invalid`);
            const contact = Number(response.headers.get('x-transit-contact'));
            return { feed, snapshot, stale: response.headers.get('x-gev-cache') === 'STALE-ERROR',
              contactedAt: Number.isFinite(contact) && contact > 0 ? contact : snapshot.fetchedAt, error: null };
          } catch (failure) {
            if (combined.aborted) throw failure;
            return { ...snapshots.get(feed.id), feed, stale: true, error: failure.message || `${feed.name} unavailable` };
          }
        }));
        combined.throwIfAborted();
        if (!enabled || request !== controller) return false;
        const now = Date.now();
        snapshots.clear();
        for (const result of results) snapshots.set(result.feed.id, result);
        active = desired; error = results.find((result) => result.error)?.error || null;
        const entities = [];
        for (const result of results) {
          if (!result.snapshot || !Number.isFinite(result.contactedAt) || now - result.contactedAt > FEED_MAX_AGE_MS) continue;
          for (const record of normalizeTransitRecords(result.feed, result.snapshot, now)) {
            if (entities.length >= 15000) break;
            entities.push(new Cesium.Entity({
              id: `transit:${result.feed.id}:${record.id}`,
              name: `${result.feed.name} · ${record.routeId ? 'Route ' + record.routeId : record.label || record.id}`,
              position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 8),
              point: { pixelSize: 7, color: Cesium.Color.fromCssColorString(MODE_COLORS[record.mode] || MODE_COLORS.unknown),
                outlineColor: Cesium.Color.fromCssColorString('#19252c'), outlineWidth: 1 },
              properties: {
                vehicleId: record.id, agency: result.feed.name, route: String(record.routeId || ''),
                mode: record.mode, source: result.feed.attribution,
                positionMeaning: record.mode === 'subway' ? 'Reported coordinates shown at surface level; depth is not provided' : 'Latest reported coordinates; no movement is extrapolated',
                positionObservedAt: record.observedAt === null ? 'Unknown' : new Date(record.observedAt).toISOString(),
                timestampSource: record.timestampSource === 'vehicle' ? 'Vehicle report' : record.timestampSource === 'header' ? 'Feed header' : record.timestampSource === 'fetch' ? 'Provider fetch time; vehicle time unavailable' : 'Unknown',
                status: String(record.status || ''), stop: String(record.stopId || ''),
                ...(Number.isFinite(record.speedMps) ? { reportedSpeedKmH: Number((record.speedMps * 3.6).toFixed(1)) } : {}),
                freshness: result.stale || (record.observedAt !== null && now - record.observedAt > 90000) ? 'Older report' : 'Recent report',
                license: result.feed.license, sourceUrl: result.feed.licenseUrl,
              },
            }));
          }
        }
        const selection = String(viewer.selectedEntity?.id || '');
        dataSource.entities.removeAll();
        for (const entity of entities) dataSource.entities.add(entity);
        if (selection.startsWith('transit:')) viewer.selectedEntity = dataSource.entities.getById(selection);
        removeCredits();
        for (const result of results) {
          const delivery = Number.isFinite(result.snapshot?.fetchedAt) ? ` · delivery ${new Date(result.snapshot.fetchedAt).toISOString()}` : '';
          const credit = new Cesium.Credit(`${result.feed.attribution}${delivery}`, true);
          creditDisplay()?.addStaticCredit(credit); credits.set(result.feed.id, credit);
        }
        count = entities.length; lastUpdate = now;
        viewer.scene.requestRender(); onChange?.(); return true;
      } catch (failure) {
        if (combined.aborted) return false;
        error = failure.message || 'Transit observations unavailable'; onChange?.(); return false;
      } finally { if (request === controller) request = null; }
    },
    getStats() {
      const now = Date.now(), results = [...snapshots.values()];
      const sourceObservation = (result) => Number.isFinite(result.snapshot?.feedTimestamp) ? result.snapshot.feedTimestamp * 1000 : result.snapshot?.fetchedAt;
      const staleFeeds = results.filter((result) => result.stale || !result.snapshot || now - result.contactedAt > 90000 || (Number.isFinite(sourceObservation(result)) && now - sourceObservation(result) > 90000)).length;
      const observations = results.map(sourceObservation).filter((value) => Number.isFinite(value) && value > 0);
      const observedAtMs = observations.length ? Math.min(...observations) : null;
      return { count, lastUpdate, refreshedAt: lastUpdate, observedAtMs,
        ageMs: observedAtMs === null ? null : Math.max(0, now - observedAtMs),
        stale: results.length > 0 && staleFeeds === results.length,
        degraded: Boolean(error) || (staleFeeds > 0 && staleFeeds < results.length), error,
        source: active.map((feed) => feed.name).join(' · ') || 'GTFS-Realtime',
        status: zoomIn ? 'zoom-in' : active.length ? 'observed' : 'no-feed',
        coverage: zoomIn ? 'Zoom below 3,000 km to load local agency feeds' : active.length ? active.map((feed) => feed.name).join(' · ') : 'No approved feed covers the center of this view' };
    },
    getRowControls: () => ({ info: 'Static observed positions update with the agency feed. Choose an agency to view its coverage.',
      chips: catalog.map((feed) => ({ label: feed.name, title: feed.region, params: { focusAgency: feed.id }, active: active.some((entry) => entry.id === feed.id) })) }),
    setParams({ focusAgency } = {}) {
      const feed = catalog.find((entry) => entry.id === focusAgency);
      if (feed && enabled) viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(feed.center.lon, feed.center.lat, 70000), duration: 1 });
    },
    getParams: () => ({}),
    destroy() {
      this.disable(); removeMoveEnd?.(); onChange = null;
      if (dataSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(dataSource, true);
      viewer = null; dataSource = null; manager = null;
    },
  };
  return layer;
}
