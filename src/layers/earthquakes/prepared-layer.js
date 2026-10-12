import * as Cesium from 'cesium';
import { createRegionalSceneClient, regionalSelectionKey } from '../../core/regional-scene-client.js';
import { extractCameraDemand } from '../../core/spatial-demand.js';
import { sceneWorkFor } from '../../core/scene-work.js';
import { mapSymbolImage } from '../../core/map-symbols.js';
import { depthColor, mapAnalystRecord } from './model.js';

const isolate = (...operations) => { let errors = 0; for (const operation of operations) { try { operation(); } catch { ++errors; } } return errors; };
const abort = () => new DOMException('Prepared seismic display superseded', 'AbortError');
const clock = () => performance.now();

/** Current-only, bounded native symbols. Historical evidence keeps its separate renderer. */
export function createPreparedEarthquakesLayer({ client = createRegionalSceneClient(),
  getDemand = viewer => extractCameraDemand(viewer, Cesium), requestRefresh = () => {}, debounceMs = 200 } = {}) {
  if (typeof client?.load !== 'function' || typeof getDemand !== 'function' || typeof requestRefresh !== 'function' ||
      !Number.isInteger(debounceMs) || debounceMs < 150 || debounceMs > 250) throw new TypeError('Use a bounded prepared seismic display');
  let viewer, enabled = false, destroyed = false, request, current, view, selectionKey, desiredDemand, refresh = requestRefresh;
  let cameraTimer, cameraStops = [], actions = [], stateListener, error = null, pending = false, unavailable = false, metrics = null;
  const ownEntities = new WeakSet();
  const clearSelection = () => isolate(...['selectedEntity', 'trackedEntity'].map(property => () => {
    if (ownEntities.has(viewer?.[property])) viewer[property] = undefined;
  }));
  const dispose = edition => {
    if (!edition) return;
    isolate(() => { if (!edition.host.isDestroyed?.()) edition.host.scene.primitives.remove(edition.billboards); },
      () => { if (!edition.host.isDestroyed?.()) edition.host.scene.primitives.remove(edition.labels); },
      () => { if (!edition.billboards.isDestroyed()) edition.billboards.destroy(); },
      () => { if (!edition.labels.isDestroyed()) edition.labels.destroy(); });
    edition.items.clear(); edition.tokens.clear();
  };
  const clear = () => {
    clearSelection(); const old = current; current = null; view = null; metrics = null; dispose(old); viewer?.scene?.requestRender?.();
  };
  const cancel = () => { request?.abort(abort()); request = null; client.cancel?.(); clearTimeout(cameraTimer); cameraTimer = undefined; };
  const notify = () => { isolate(() => stateListener?.(), () => viewer?.scene?.requestRender?.()); };
  const selectDemand = demand => {
    const key = regionalSelectionKey(demand);
    if (key === selectionKey) { desiredDemand = demand; return false; }
    cancel(); selectionKey = key; desiredDemand = demand; client.select?.(demand);
    // Keep exact retained positions while the new viewport loads. Its requested
    // completeness is separate from the last complete displayed selection.
    pending = true; unavailable = false; error = null; notify(); return true;
  };
  const changed = () => {
    if (!enabled || destroyed || !viewer) return;
    try { if (!selectDemand(getDemand(viewer))) return; }
    catch { cancel(); clear(); selectionKey = null; desiredDemand = null; pending = true; return; }
    clearTimeout(cameraTimer); cameraTimer = setTimeout(() => { cameraTimer = undefined;
      if (enabled && !destroyed) refresh(); }, debounceMs);
  };
  const properties = (feature, source) => ({ usgsId: feature.record.usgsId, mag: feature.record.mag, place: feature.record.place,
    time: feature.record.time, depth: feature.record.depthKm, sourceUrl: feature.record.sourceUrl, updatedAt: feature.record.updatedAt,
    eventType: feature.record.eventType, reviewStatus: feature.record.reviewStatus, sourceTitle: feature.record.sourceTitle,
    sourceReceiptId: source.receiptId, sourceFeatureRevision: feature.revision, sourceFence: source.fence,
    sourceRecordedAt: source.recordedAt, sourceCapturedAt: source.capturedAt,
    sourceKnowledgeMeaning: source.knowledgeMeaning });
  const materialize = feature => {
    for (const entity of [viewer.selectedEntity, viewer.trackedEntity]) if (ownEntities.has(entity) && entity.id === feature.id) return entity;
    const entity = new Cesium.Entity({ id: feature.id, name: feature.record.sourceTitle || `${feature.record.mag} · ${feature.record.place}`,
      position: Cesium.Cartesian3.fromDegrees(feature.record.lon, feature.record.lat), properties: properties(feature, view.source) });
    ownEntities.add(entity); return entity;
  };
  const focusCluster = cell => {
    if (!current?.items.has(cell.id) || !enabled || destroyed) return false;
    viewer.camera?.flyTo?.({ destination: Cesium.Rectangle.fromDegrees(cell.bounds.west, cell.bounds.south, cell.bounds.east, cell.bounds.north), duration: .45 });
    return true;
  };
  const inspect = id => {
    const item = current?.items.get(id); if (!item || !enabled || destroyed) return false;
    if (item.bounds) return focusCluster(item);
    const entity = materialize(item), same = viewer.selectedEntity === entity;
    isolate(() => { viewer.selectedEntity = entity; }, () => { if (same) viewer.selectedEntityChanged?.raiseEvent?.(entity); });
    return true;
  };
  const refreshSelection = edition => {
    const seen = new Set(); let errors = 0;
    for (const property of ['selectedEntity', 'trackedEntity']) {
      const entity = viewer[property]; if (!ownEntities.has(entity)) continue;
      const feature = edition.items.get(entity.id);
      if (!feature || feature.bounds) { errors += isolate(() => { viewer[property] = undefined; }); continue; }
      if (seen.has(entity)) continue; seen.add(entity);
      // Replacing the bag clears an old retained-proof attachment before corrected facts are observed.
      errors += isolate(() => { entity.properties = properties(feature, view.source); },
        () => { entity.position = Cesium.Cartesian3.fromDegrees(feature.record.lon, feature.record.lat); },
        () => { entity.name = feature.record.sourceTitle || `${feature.record.mag} · ${feature.record.place}`; });
    }
    return errors;
  };
  async function paint(nextView, { signal, work, valid }) {
    if (!valid()) throw abort();
    if (view?.scene.version === nextView.scene.version && current) {
      const apply = () => { if (!valid()) throw abort(); view = nextView; pending = false; unavailable = false; error = null; notify(); };
      if (work) work.publish(apply); else apply(); return true;
    }
    const scope = work || sceneWorkFor(viewer).scope({ key: 'prepared-usgs-display', signal, isCurrent: valid });
    const edition = { host: viewer, billboards: new Cesium.BillboardCollection(), labels: new Cesium.LabelCollection(), items: new Map(), tokens: new Map() };
    edition.billboards.show = false; edition.labels.show = false;
    let promoted = false, preparationMs, attachmentMs, commitMs, observerErrors = 0, outcome = 'error';
    try {
      const started = clock(), rows = nextView.scene.selection.mode === 'features' ? nextView.scene.features : nextView.scene.clusters;
      await scope.prepare(rows, item => {
        if (!valid()) throw abort();
        const token = Object.freeze({ kind: 'prepared-usgs-symbol', id: item.id }); edition.tokens.set(item.id, token); edition.items.set(item.id, item);
        if (item.bounds) {
          edition.billboards.add({ id: token, image: mapSymbolImage('notice'), position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat),
            color: Cesium.Color.fromCssColorString('#9dc2d7'), width: 32, height: 32 });
          edition.labels.add({ id: token, text: String(item.count), position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat),
            font: '600 12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#15212c'), outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER });
        } else {
          edition.billboards.add({ id: token, image: mapSymbolImage('seismic'), position: Cesium.Cartesian3.fromDegrees(item.record.lon, item.record.lat),
            color: depthColor(item.record.depthKm ?? 0), width: 22, height: 22 });
        }
      });
      preparationMs = clock() - started; scope.assertCurrent(); if (!valid()) throw abort();
      const attachAt = clock(); await edition.host.scene.primitives.add(edition.billboards);
      scope.assertCurrent(); if (!valid()) throw abort();
      await edition.host.scene.primitives.add(edition.labels);
      attachmentMs = clock() - attachAt; scope.assertCurrent(); if (!valid()) throw abort();
      const commitAt = clock(); scope.publish(() => {
        if (!valid()) throw abort(); const old = current; view = nextView; current = edition; promoted = true; pending = false; unavailable = false; error = null;
        observerErrors += isolate(() => { edition.billboards.show = enabled; edition.labels.show = enabled; },
          () => { if (old) { old.billboards.show = false; old.labels.show = false; } });
        observerErrors += refreshSelection(edition); dispose(old); notify();
      });
      commitMs = clock() - commitAt; metrics = { count: rows.length, preparationMs, attachmentMs, commitMs, observerErrors }; outcome = 'complete'; return true;
    } catch (failure) { outcome = failure?.name === 'AbortError' ? 'cancelled' : 'error'; throw failure; }
    finally { if (!promoted) dispose(edition); if (!work) scope.finish(outcome); }
  }
  const layer = {
    id: 'earthquakes', name: 'Seismic reports (24h)', icon: '🌋', source: 'USGS', updateInterval: 60000,
    setDemandRefreshListener(value) { refresh = typeof value === 'function' ? value : requestRefresh; },
    setRowControlsListener(value) { stateListener = typeof value === 'function' ? value : null; },
    setLocalArea() { /* Camera cells own the display scope; no browser source filtering. */ },
    invalidatePreparedSnapshot(revision) { const admitted = client.invalidate?.(revision) !== false; if (admitted) { request?.abort(abort()); pending = true; } return admitted; },
    init(value) {
      if (viewer || destroyed) throw new Error('Prepared seismic display already initialized'); viewer = value;
      for (const event of [viewer.camera?.changed, viewer.camera?.moveEnd]) if (event?.addEventListener) cameraStops.push(event.addEventListener(changed));
      const handler = viewer.screenSpaceEventHandler;
      for (const type of [Cesium.ScreenSpaceEventType.LEFT_CLICK, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK]) {
        if (!handler?.getInputAction || !handler?.setInputAction) continue;
        const previous = handler.getInputAction(type), action = event => {
          if (destroyed) return previous?.(event);
          const picked = viewer.scene.pick?.(event.position), token = picked?.id ?? picked?.primitive?.id;
          if (token?.kind !== 'prepared-usgs-symbol') return previous?.(event);
          if (!enabled || current?.tokens.get(token.id) !== token) return;
          const item = current.items.get(token.id);
          if (item.bounds) focusCluster(item);
          else if (type === Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) isolate(() => { viewer.trackedEntity = materialize(item); });
          else inspect(token.id);
        };
        handler.setInputAction(action, type); actions.push({ type, previous, action });
      }
    },
    enable() { enabled = true; try { selectDemand(getDemand(viewer)); } catch { clear(); selectionKey = null; pending = true; }
      if (current) { current.billboards.show = true; current.labels.show = true; } },
    disable() { enabled = false; cancel(); clearSelection(); if (current) { current.billboards.show = false; current.labels.show = false; } },
    async update(_viewer = viewer, { signal: external, work } = {}) {
      if (!enabled || destroyed || !viewer) return false;
      let demand; try { demand = getDemand(viewer); selectDemand(demand); } catch { cancel(); clear(); selectionKey = null; pending = true; return false; }
      request?.abort(abort()); const next = new AbortController(); request = next;
      const signal = external ? AbortSignal.any([next.signal, external]) : next.signal, key = selectionKey;
      const valid = () => enabled && !destroyed && request === next && !signal.aborted && selectionKey === key;
      try {
        const result = await client.load(demand, { signal, onCached: cached => paint(cached, { signal, work, valid }) });
        if (!valid()) return false;
        if (result.pending) { unavailable = result.errorCode === 'stored-scene-unavailable'; pending = !unavailable; error = null; notify(); return false; }
        return await paint(result, { signal, work, valid });
      } catch (failure) {
        if (!valid() || failure?.name === 'AbortError') return false;
        pending = false; unavailable = true; error = view ? 'Stored seismic view unavailable' : null; notify(); return false;
      } finally { if (request === next) request = null; }
    },
    getRowControls() {
      if (!enabled || !view) return { info: pending ? 'Preparing this area' : 'Stored source view unavailable' };
      const scene = view.scene;
      return { info: scene.selection.mode === 'clusters' ? `${scene.counts.selectedReports} reports · select an area to expand` :
        `${scene.counts.selectedReports} reports · reported locations`, items: (scene.selection.mode === 'clusters' ? scene.clusters : scene.features).map(item =>
        ({ id: item.id, label: item.bounds ? `${item.count} reports` : `M${item.record.mag.toFixed(1)} · ${item.record.place}`,
          detail: item.bounds ? 'Area summary; not an epicenter' : new Date(item.record.time).toISOString(), params: { inspect: item.id } })) };
    },
    setParams(value) { if (typeof value?.inspect === 'string') inspect(value.inspect); }, getParams: () => ({}),
    getAnalystRecords(maxCount = 2000) { if (!enabled || !view || view.scene.selection.mode !== 'features') return [];
      return view.scene.features.slice(0, Math.max(0, Math.min(500, Math.floor(maxCount) || 0))).map(({ record }, index) =>
        mapAnalystRecord({ id: record.usgsId, mag: record.mag, place: record.place, time: record.time, depth: record.depthKm, lat: record.lat, lon: record.lon }, index)); },
    getStats() {
      const source = view?.source, check = view?.check, age = view?.sourceGenerationAgeMs === null || !view ? null :
        view.sourceGenerationAgeMs + Math.max(0, Date.now() - view.browserReadAt);
      return { count: view?.scene.counts.selectedReports || 0, drawnCount: current?.items.size || 0, lastUpdate: source ? Date.parse(source.recordedAt) : null,
        error, pending, status: pending ? 'preparing' : unavailable ? 'unavailable' : check?.status || null, sourceAgeMs: age,
        stale: Boolean(unavailable || error || view?.browserCache || view?.stale || age !== null && age > 120000), degraded: Boolean(unavailable || error), snapshot: false,
        receipt: source ? { id: source.receiptId, fence: source.fence, recordedAt: source.recordedAt, capturedAt: source.capturedAt,
          factsDigest: source.factsDigest, rawSha256: source.rawSha256, artifactSha256: source.artifactSha256, sourceUpdatedAt: source.sourceGeneratedAt } : null,
        checkedAt: check?.checkedAt || null, lastSuccessfulAt: check?.lastSuccessfulAt || null, sourceGeneratedAt: check?.sourceGeneratedAt || null,
        retainedSourceGeneratedAt: source?.sourceGeneratedAt || null, observedAt: null, browserCache: view?.browserCache ? 'STALE' : null,
        coverage: view ? pending ? 'M2.5+ · rolling 24 hours · prior complete view while this area loads' :
          'M2.5+ · rolling 24 hours · complete selected cells' : null,
        cohortCoverage: view ? { ...view.scene.coverage, requestedViewportComplete: !pending && regionalSelectionKey(view.scene.selection) === selectionKey } : null,
        displayedSelection: view?.scene.selection || null, requestedSelection: desiredDemand ? {
          level: desiredDemand.level, cells: desiredDemand.cells, mode: desiredDemand.mode } : null,
        requestedViewportComplete: Boolean(view && !pending && regionalSelectionKey(view.scene.selection) === selectionKey),
        editionMetrics: metrics && { ...metrics }, regional: true, mode: view?.scene.selection.mode || null };
    },
    destroy() {
      if (destroyed) return; destroyed = true; enabled = false; cancel(); clear(); client.destroy?.();
      for (const stop of cameraStops) isolate(stop); cameraStops = [];
      const handler = viewer?.screenSpaceEventHandler;
      for (const { type, previous, action } of actions) isolate(() => {
        if (viewer?.isDestroyed?.() || handler.getInputAction(type) !== action) return;
        if (previous) handler.setInputAction(previous, type); else handler.removeInputAction?.(type);
      });
      actions = []; stateListener = null; refresh = () => {}; viewer = null;
    },
  };
  return layer;
}
