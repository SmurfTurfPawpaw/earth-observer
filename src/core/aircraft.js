import * as Cesium from 'cesium';

function viewQuery(viewer) {
  const canvas = viewer.canvas;
  const center = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  const position = center ? Cesium.Cartographic.fromCartesian(center) : viewer.camera.positionCartographic;
  return { latitude: Cesium.Math.toDegrees(position.latitude), longitude: Cesium.Math.toDegrees(position.longitude) };
}

/** Render receiver observations at their reported coordinates, with no extrapolated motion. */
export function createObservedAircraftLayer({ id = 'flights', source }) {
  if (!source?.getSnapshot) throw new TypeError('An aircraft observation source is required');
  let viewer, dataSource, request, removeMoveEnd, manager, viewTimer;
  let enabled = false, count = 0, lastUpdate = null, observedAtMs = null, ageMs = null, stale = false, coverage = null, error = null;
  const military = id === 'military';
  const layer = {
    id,
    updateInterval: 30000,
    attachDataManager(nextManager) { manager = nextManager; },
    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(`${id}-observations`);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
        if (!enabled) return;
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => { if (enabled) void manager?.refresh(id); }, 350);
      });
    },
    enable() { enabled = true; dataSource.show = true; },
    disable() {
      enabled = false; request?.abort(); request = null; clearTimeout(viewTimer);
      if (dataSource) dataSource.show = false;
      if (String(viewer?.selectedEntity?.id || '').startsWith(`${id}:`)) viewer.selectedEntity = undefined;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const snapshot = await source.getSnapshot(viewQuery(viewer), { signal: combined });
        combined.throwIfAborted();
        if (!enabled || request !== controller) return false;
        if (!Array.isArray(snapshot.records)) throw new Error('Aircraft observations are invalid');
        const entities = [];
        const seen = new Set();
        for (const record of snapshot.records.slice(0, 5000)) {
          if (!record.id || seen.has(record.id) || !Number.isFinite(record.latitude) || !Number.isFinite(record.longitude) || Math.abs(record.latitude) > 90 || Math.abs(record.longitude) > 180) continue;
          seen.add(record.id);
          const label = record.callsign || record.registration || record.id;
          const altitude = record.onGround ? 0 : Number.isFinite(record.ellipsoidAltitudeM) ? record.ellipsoidAltitudeM : Number.isFinite(record.baroAltitudeM) ? record.baroAltitudeM : 0;
          const observed = Number.isFinite(record.positionTimeMs) ? record.positionTimeMs : snapshot.observedAtMs;
          const properties = {
            icao24: record.id,
            source: snapshot.source || 'adsb.lol',
            positionType: 'Receiver observation',
            ...(Number.isFinite(observed) ? { positionObservedAt: new Date(observed).toISOString(), observationAgeSeconds: Math.max(0, Math.round((Date.now() - observed) / 1000)) } : { positionObservedAt: 'Unknown' }),
            ...(record.registration ? { registration: record.registration } : {}),
            ...(record.typeCode ? { aircraftType: record.typeCode } : {}),
            ...(record.operator ? { operator: record.operator } : {}),
            ...(Number.isFinite(record.baroAltitudeM) ? { barometricAltitudeM: Math.round(record.baroAltitudeM) } : {}),
            ...(Number.isFinite(record.ellipsoidAltitudeM) ? { geometricAltitudeM: Math.round(record.ellipsoidAltitudeM) } : {}),
            ...(Number.isFinite(record.speedMps) ? { reportedSpeedKmH: Number((record.speedMps * 3.6).toFixed(1)) } : {}),
            ...(Number.isFinite(record.courseDeg) ? { reportedCourseDegrees: record.courseDeg } : {}),
            onGround: Boolean(record.onGround),
            ...(snapshot.stale ? { freshness: 'Older feed' } : {}),
          };
          entities.push(new Cesium.Entity({
            id: `${id}:${record.id}`, name: String(label),
            position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, altitude),
            point: {
              pixelSize: military ? 7 : 6,
              color: Cesium.Color.fromCssColorString(military ? '#e8bd80' : '#93cde3'),
              outlineColor: Cesium.Color.fromCssColorString('#14202b'), outlineWidth: 1,
            },
            label: {
              text: String(label), font: '11px sans-serif', fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.fromCssColorString('#101820'), outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(9, -8),
              horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 150000),
            },
            properties,
          }));
        }
        const selected = String(viewer.selectedEntity?.id || '');
        const ownsSelection = selected.startsWith(`${id}:`);
        dataSource.entities.removeAll();
        for (const entity of entities) dataSource.entities.add(entity);
        if (ownsSelection) viewer.selectedEntity = dataSource.entities.getById(selected);
        count = entities.length; lastUpdate = Date.now();
        observedAtMs = snapshot.observedAtMs ?? null;
        ageMs = snapshot.ageMs ?? null; stale = snapshot.stale === true;
        coverage = snapshot.coverage || null; error = null;
        viewer.scene.requestRender();
        return true;
      } catch (failure) {
        if (combined.aborted) return false;
        error = failure.message || 'Aircraft source unavailable'; stale = count > 0;
        return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count, lastUpdate, refreshedAt: lastUpdate, observedAtMs, ageMs, stale, coverage, error }),
    getRowControls: () => ({ info: `${coverage || (military ? 'Public military receiver observations.' : 'Receiver observations near the center of the current view.')} Positions change when the feed refreshes; no movement is extrapolated.` }),
    destroy() {
      enabled = false; request?.abort(); request = null; clearTimeout(viewTimer); removeMoveEnd?.();
      if (dataSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(dataSource, true);
      viewer = null; dataSource = null; manager = null; count = 0;
    },
  };
  return layer;
}
