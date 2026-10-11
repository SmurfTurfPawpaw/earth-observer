import * as Cesium from 'cesium';
import { inLocalArea, validateArea } from './local-area.js';
import { createAircraftMotion, AIRCRAFT_HORIZON_MS, AIRCRAFT_PRESENTATION_DELAY_MS, AIRCRAFT_INTERPOLATION_GAP_MS } from './aircraft-motion.js';

function viewQuery(viewer) {
  const canvas = viewer.canvas;
  const center = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  const position = center ? Cesium.Cartographic.fromCartesian(center) : viewer.camera.positionCartographic;
  return { latitude: Cesium.Math.toDegrees(position.latitude), longitude: Cesium.Math.toDegrees(position.longitude) };
}
const iso = (at) => Number.isFinite(at) && at > 0 && at <= 8640000000000000 ? new Date(at).toISOString() : 'Unknown';
const meaning = (mode) => mode === 'estimated' ? 'Estimated position' : mode === 'expired' ? 'Expired estimate' : 'Receiver observation';

/** Keep source fixes exact; optional bounded motion is separate display state. */
export function createObservedAircraftLayer({ id = 'flights', source, render, documentRef = globalThis.document,
  predictionEnabled = false, horizonMs = AIRCRAFT_HORIZON_MS, correctionMs = 1200, now = Date.now,
  presentationDelayMs = AIRCRAFT_PRESENTATION_DELAY_MS, maxInterpolationGapMs = AIRCRAFT_INTERPOLATION_GAP_MS, interpolationMethod = 'endpoint-motion',
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  if (!source?.getSnapshot) throw new TypeError('An aircraft observation source is required');
  createAircraftMotion({ predictionEnabled, horizonMs, correctionMs, maxInterpolationGapMs, interpolationMethod });
  if (!Number.isFinite(presentationDelayMs) || presentationDelayMs < 0 || presentationDelayMs > 60000) throw new TypeError('Aircraft presentation delay must be finite and bounded');
  let viewer, dataSource, request, removeMoveEnd, manager, viewTimer, expiryTimer, removeFrame;
  let localArea, contextLost = false, holding = false, destroyed = false;
  let enabled = false, count = 0, lastUpdate = null, observedAtMs = null, ageMs = null, stale = false, coverage = null, error = null;
  const military = id === 'military', owner = 'aircraft:' + id, entries = new Map(), moving = new Set();
  const observedColor = Cesium.Color.fromCssColorString(military ? '#e8bd80' : '#93cde3');
  const available = () => enabled && !destroyed && !contextLost && !documentRef?.hidden && viewer && !viewer.isDestroyed?.();
  const stopExpiry = () => { if (expiryTimer !== undefined) clearTimeoutImpl(expiryTimer); expiryTimer = undefined; };
  const stopMotion = () => {
    stopExpiry(); removeFrame?.(); removeFrame = null; moving.clear();
    if (holding) render?.releaseContinuousRender?.(owner); holding = false;
  };
  function style(entry, mode) {
    if (entry.styledMode === mode) return;
    const estimated = mode !== 'observed';
    entry.entity.point.color = estimated ? observedColor.withAlpha(.55) : observedColor;
    entry.entity.point.outlineColor = estimated ? Cesium.Color.WHITE.withAlpha(.8) : Cesium.Color.fromCssColorString('#14202b');
    entry.entity.point.outlineWidth = estimated ? 1.5 : 1;
    entry.styledMode = mode;
  }
  function present(entry, atMs) {
    const state = entry.motion.sample(atMs - presentationDelayMs, { wallTimeMs: atMs }); if (!state) return false;
    entry.display = state;
    const { position } = state;
    Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.altitudeM, undefined, entry.cartesian);
    entry.entity.position.setValue(entry.cartesian);
    style(entry, state.mode);
    return state.active;
  }
  function armExpiry() {
    stopExpiry(); if (!available() || !predictionEnabled) return;
    const current = now(), deadlines = [...entries.values()].flatMap((entry) => [entry.display?.nextActivationMs, entry.display?.validUntilMs]).filter(Number.isFinite).map((at) => at + presentationDelayMs).filter((at) => at > current);
    if (deadlines.length) expiryTimer = setTimeoutImpl(() => { expiryTimer = undefined; refreshMotion(); viewer?.scene.requestRender(); }, Math.max(1, Math.min(...deadlines) - current));
  }
  function frame() {
    if (!available()) { stopMotion(); return; }
    const current = now();
    for (const entry of moving) if (!present(entry, current)) moving.delete(entry);
    if (!moving.size) refreshMotion();
  }
  function refreshMotion() {
    moving.clear();
    if (!available()) { stopMotion(); return; }
    const current = now();
    for (const entry of entries.values()) if (present(entry, current)) moving.add(entry);
    if (moving.size) {
      if (!removeFrame) removeFrame = viewer.scene.preRender?.addEventListener(frame);
      if (!holding) { render?.holdContinuousRender?.(owner); holding = true; }
    } else { removeFrame?.(); removeFrame = null; if (holding) render?.releaseContinuousRender?.(owner); holding = false; }
    armExpiry();
  }
  function properties(entry, record, snapshot) {
    const dynamic = (read) => new Cesium.CallbackProperty(() => read(entry.display), false);
    return {
      source: snapshot.source || 'adsb.lol', icao24: record.id,
      positionType: dynamic((state) => state?.bufferState === 'awaiting-buffer' && state.basisObservedAtMs.length > 1 ? 'Buffered receiver observation' : meaning(state?.mode)),
      positionObservedAt: iso(record.positionTimeMs), positionTimeQuality: record.positionTimeQuality || 'unknown',
      displayObservedAt: dynamic((state) => state?.displayObservedAtMs ? iso(state.displayObservedAtMs) : undefined),
      observedLatitude: record.latitude, observedLongitude: record.longitude,
      estimatedLatitude: dynamic((state) => state?.mode !== 'observed' ? state?.position.latitude : undefined),
      estimatedLongitude: dynamic((state) => state?.mode !== 'observed' ? state?.position.longitude : undefined),
      estimatedAltitudeM: dynamic((state) => state?.mode !== 'observed' && state?.position.altitudeType !== 'unknown' ? Number(state.position.altitudeM.toFixed(1)) : undefined),
      estimatedAltitudeType: dynamic((state) => state?.mode !== 'observed' ? state?.position.altitudeType : undefined),
      estimatedAt: dynamic((state) => state?.estimatedAtMs ? iso(state.estimatedAtMs) : undefined),
      motionModel: dynamic((state) => state?.mode !== 'observed' ? state?.model : undefined),
      presentationDelaySeconds: predictionEnabled ? presentationDelayMs / 1000 : undefined,
      bufferState: dynamic((state) => predictionEnabled ? state?.bufferState : undefined),
      bufferObservedAt: dynamic((state) => ['interpolating', 'awaiting-buffer'].includes(state?.bufferState) && state.basisObservedAtMs.length > 1 ? state.basisObservedAtMs.map(iso).join(' → ') : undefined),
      motionStopsAt: dynamic((state) => predictionEnabled && state?.validUntilMs ? iso(state.validUntilMs) : undefined),
      observationAgeSeconds: dynamic(() => Number.isFinite(record.positionTimeMs) ? Math.max(0, Math.round((now() - record.positionTimeMs) / 1000)) : undefined),
      correctionRemainingM: dynamic((state) => state?.correctionRemainingM > .1 ? Number(state.correctionRemainingM.toFixed(1)) : undefined),
      previousPredictionErrorM: dynamic((state) => Number.isFinite(state?.lastErrorM) ? Number(state.lastErrorM.toFixed(1)) : undefined),
      predictionErrorHorizonSeconds: dynamic((state) => Number.isFinite(state?.lastErrorM) ? state.lastErrorForecastHorizonMs / 1000 : undefined),
      openLoopDiagnosticErrorM: dynamic((state) => Number.isFinite(state?.diagnosticErrorM) ? Number(state.diagnosticErrorM.toFixed(1)) : undefined),
      openLoopDiagnosticHorizonSeconds: dynamic((state) => Number.isFinite(state?.diagnosticErrorM) ? state.diagnosticForecastHorizonMs / 1000 : undefined),
      ...(record.registration ? { registration: record.registration } : {}), ...(record.typeCode ? { aircraftType: record.typeCode } : {}),
      ...(record.operator ? { operator: record.operator } : {}),
      ...(Number.isFinite(record.baroAltitudeM) ? { barometricAltitudeM: Math.round(record.baroAltitudeM) } : {}),
      ...(Number.isFinite(record.ellipsoidAltitudeM) ? { geometricAltitudeM: Math.round(record.ellipsoidAltitudeM) } : {}),
      ...(Number.isFinite(record.speedMps) ? { reportedSpeedKmH: Number((record.speedMps * 3.6).toFixed(1)) } : {}),
      ...(Number.isFinite(record.courseDeg) ? { reportedCourseDegrees: record.courseDeg } : {}),
      ...(Number.isFinite(record.verticalRateMps) ? { reportedVerticalRateMps: record.verticalRateMps, verticalRateAltitudeType: record.verticalRateAltitudeType || 'unknown' } : {}),
      ...(record.accuracy ? Object.fromEntries(Object.entries(record.accuracy).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => ['reportedAccuracy' + key[0].toUpperCase() + key.slice(1), value])) : {}),
      onGround: Boolean(record.onGround), ...(snapshot.stale ? { freshness: 'Older feed' } : {}),
    };
  }
  function add(record) {
    const label = String(record.callsign || record.registration || record.id);
    const entity = new Cesium.Entity({ id: id + ':' + record.id, name: label,
      position: new Cesium.ConstantPositionProperty(Cesium.Cartesian3.ZERO),
      point: { pixelSize: military ? 7 : 6, color: observedColor, outlineColor: Cesium.Color.fromCssColorString('#14202b'), outlineWidth: 1 },
      label: { text: label, font: '11px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#101820'), outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(9, -8), horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 150000) },
    });
    const entry = { entity, cartesian: new Cesium.Cartesian3(), motion: createAircraftMotion({ predictionEnabled, horizonMs, correctionMs, maxInterpolationGapMs, interpolationMethod }), display: null };
    entries.set(record.id, entry); dataSource.entities.add(entity); return entry;
  }
  function remove(key, entry) {
    moving.delete(entry); entries.delete(key); dataSource.entities.remove(entry.entity);
    if (viewer.selectedEntity === entry.entity) viewer.selectedEntity = undefined;
    if (viewer.trackedEntity === entry.entity) viewer.trackedEntity = undefined;
  }
  const visibility = () => {
    if (documentRef?.hidden) { request?.abort(); clearTimeoutImpl(viewTimer); stopMotion(); }
    else { refreshMotion(); if (available()) viewer.scene.requestRender(); }
  };
  const lost = () => { contextLost = true; request?.abort(); clearTimeoutImpl(viewTimer); stopMotion(); };
  const layer = {
    id, updateInterval: 30000,
    attachDataManager(nextManager) { manager = nextManager; }, setLocalArea(value) { localArea = validateArea(value); },
    init(nextViewer) {
      viewer = nextViewer; dataSource = new Cesium.CustomDataSource(id + '-observations'); dataSource.show = false; viewer.dataSources.add(dataSource);
      removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
        if (!available()) return; clearTimeoutImpl(viewTimer);
        viewTimer = setTimeoutImpl(() => { if (available()) void manager?.refresh(id); }, 350);
      });
      documentRef?.addEventListener?.('visibilitychange', visibility);
      (viewer.scene.canvas || viewer.canvas)?.addEventListener?.('webglcontextlost', lost);
    },
    enable() { if (destroyed) return; enabled = true; dataSource.show = true; refreshMotion(); },
    disable() {
      enabled = false; request?.abort(); request = null; clearTimeoutImpl(viewTimer); stopMotion();
      if (dataSource) dataSource.show = false;
      if (String(viewer?.selectedEntity?.id || '').startsWith(id + ':')) viewer.selectedEntity = undefined;
      if (String(viewer?.trackedEntity?.id || '').startsWith(id + ':')) viewer.trackedEntity = undefined;
    },
    async update(_viewer, { signal } = {}) {
      if (!available()) return false;
      request?.abort(); const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const query = localArea ? { latitude: localArea.lat, longitude: localArea.lon, radiusKm: localArea.radiusKm } : viewQuery(viewer);
        const snapshot = await source.getSnapshot(query, { signal: combined }); combined.throwIfAborted();
        if (!available() || request !== controller) return false;
        if (!Array.isArray(snapshot.records)) throw new Error('Aircraft observations are invalid');
        const seen = new Set(), current = now();
        for (const record of snapshot.records.slice(0, 5000)) {
          if (!record.id || seen.has(record.id) || !Number.isFinite(record.latitude) || !Number.isFinite(record.longitude) || Math.abs(record.latitude) > 90 || Math.abs(record.longitude) > 180 || !inLocalArea(record.latitude, record.longitude, localArea)) continue;
          seen.add(record.id); const entry = entries.get(record.id) || add(record);
          const admission = entry.motion.admit(record, current, { displayAtMs: current - presentationDelayMs });
          if (!admission.accepted) continue;
          entry.entity.name = String(record.callsign || record.registration || record.id); entry.entity.label.text = entry.entity.name;
          present(entry, current); entry.entity.properties = properties(entry, record, snapshot);
        }
        for (const [key, entry] of entries) if (!seen.has(key)) remove(key, entry);
        count = entries.size; lastUpdate = current; observedAtMs = snapshot.observedAtMs ?? null; ageMs = snapshot.ageMs ?? null;
        stale = snapshot.stale === true; coverage = snapshot.coverage || null; error = null; refreshMotion(); viewer.scene.requestRender(); return true;
      } catch (failure) {
        if (combined.aborted) return false; error = failure.message || 'Aircraft source unavailable'; stale = count > 0; return false;
      } finally { if (request === controller) request = null; }
    },
    getStats() {
      const states = [...entries.values()].map((entry) => entry.display);
      return { count, lastUpdate, refreshedAt: lastUpdate, observedAtMs, ageMs, stale, coverage, error, predictionEnabled: Boolean(predictionEnabled), horizonMs, presentationDelayMs, maxInterpolationGapMs, interpolationMethod,
        interpolatingCount: states.filter((state) => state?.bufferState === 'interpolating').length, edgePredictionCount: states.filter((state) => state?.bufferState === 'edge-prediction').length,
        estimatedCount: states.filter((state) => state?.mode === 'estimated').length, expiredCount: states.filter((state) => state?.mode === 'expired').length, motionActiveCount: moving.size };
    },
    getRowControls: () => ({ info: (coverage || (military ? 'Public military receiver observations.' : 'Receiver observations near the center of the current view.')) + ' ' +
      (predictionEnabled ? 'Outlined dots use a ' + presentationDelayMs / 1000 + 's observation buffer and at most ' + horizonMs / 1000 + 's edge prediction. Select a dot for original measured coordinates and dates.' : 'Positions stay at their reported coordinates.') }),
    destroy() {
      if (destroyed) return; layer.disable(); destroyed = true; removeMoveEnd?.(); documentRef?.removeEventListener?.('visibilitychange', visibility);
      (viewer?.scene.canvas || viewer?.canvas)?.removeEventListener?.('webglcontextlost', lost);
      if (dataSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(dataSource, true);
      entries.clear(); moving.clear(); viewer = null; dataSource = null; manager = null; count = 0;
    },
  };
  return layer;
}
