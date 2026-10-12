import * as Cesium from 'cesium';
import { createRegionalSceneClient, regionalSelectionKey } from './regional-scene-client.js';
import { extractCameraDemand } from './spatial-demand.js';
import { sceneWorkFor } from './scene-work.js';
import { mapSymbolImage, mapClusterBadge } from './map-symbols.js';
import { pluginJson } from './plugin-evidence.js';

const isolate = (...operations) => { let errors = 0; for (const operation of operations) { try { operation(); } catch { ++errors; } } return errors; };
const abort = () => new DOMException('Prepared seismic display superseded', 'AbortError');
const clock = () => performance.now();
export const PREPARED_CLUSTER_LAYOUT = Object.freeze({ policyId: 'fixed-source-category-screen-slots-v1', maxOffsetPx: 71,
  meaning: 'Category summary badges use bounded screen offsets around the unchanged derived cell center; source features are not offset' });
const GDACS_CLUSTER_SLOTS = Object.freeze({ seismic: [54, 46], flood: [54, 0], cyclone: [54, -46], volcano: [0, -46],
  wildfire: [-54, -46], drought: [-54, 0], notice: [-54, 46] });

/** Current-only, bounded native symbols. Historical evidence keeps its separate renderer. */
export function createPreparedSceneLayer({ descriptor, client,
  getDemand = viewer => extractCameraDemand(viewer, Cesium), requestRefresh = () => {}, debounceMs = 200,
  documentRef = globalThis.document } = {}) {
  if (!descriptor || !['earthquakes', 'gdacs'].includes(descriptor.sourceKey) ||
      descriptor.id !== (descriptor.sourceKey === 'earthquakes' ? 'earthquakes' : 'gdacs-notices') ||
      !['title', 'position', 'entityProperties', 'stats'].every(key => typeof descriptor[key] === 'function'))
    throw new TypeError('Use a reviewed prepared-scene source descriptor');
  client ||= createRegionalSceneClient({ sourceKey: descriptor.sourceKey });
  if (typeof client?.load !== 'function' || typeof getDemand !== 'function' || typeof requestRefresh !== 'function' ||
      !Number.isInteger(debounceMs) || debounceMs < 150 || debounceMs > 250) throw new TypeError('Use a bounded prepared seismic display');
  let viewer, enabled = false, destroyed = false, request, current, view, selectionKey, desiredDemand, refresh = requestRefresh;
  let cameraTimer, cameraStops = [], actions = [], stateListener, demandListener, error = null, sourceErrorCode = null, pending = false, unavailable = false, metrics = null;
  const ownEntities = new WeakMap();
  const interactive = () => enabled && !destroyed && !documentRef?.hidden && !viewer?.isDestroyed?.() &&
    viewer?.earthTime?.getState?.()?.mode !== 'history';
  const clearSelection = () => isolate(...['selectedEntity', 'trackedEntity'].map(property => () => {
    if (ownEntities.has(viewer?.[property])) viewer[property] = undefined;
  }));
  const dispose = edition => {
    if (!edition) return;
    isolate(() => { if (!edition.host.isDestroyed?.()) edition.host.scene.primitives.remove(edition.billboards); },
      () => { if (!edition.billboards.isDestroyed()) edition.billboards.destroy(); });
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
    pending = true; unavailable = false; error = null; sourceErrorCode = null; notify(); return true;
  };
  const changed = () => {
    if (!enabled || destroyed || !viewer) return;
    try { if (!selectDemand(getDemand(viewer))) return; }
    catch { cancel(); clear(); selectionKey = null; desiredDemand = null; pending = true; return; }
    clearTimeout(cameraTimer); cameraTimer = setTimeout(() => { cameraTimer = undefined;
      if (enabled && !destroyed) { isolate(() => demandListener?.(desiredDemand)); refresh(); } }, debounceMs);
  };
  const materialize = feature => {
    for (const entity of [viewer.selectedEntity, viewer.trackedEntity]) if (ownEntities.get(entity) === feature.id) return entity;
    const point = descriptor.position(feature), entity = new Cesium.Entity({ id: descriptor.entityId?.(feature) || feature.id,
      name: descriptor.title(feature), position: point ? Cesium.Cartesian3.fromDegrees(...point) : undefined,
      properties: descriptor.entityProperties(feature, view) });
    ownEntities.set(entity, feature.id); return entity;
  };
  const focusCluster = cell => {
    if (!current?.items.has(cell.id) || !interactive()) return false;
    viewer.camera?.flyTo?.({ destination: Cesium.Rectangle.fromDegrees(cell.bounds.west, cell.bounds.south, cell.bounds.east, cell.bounds.north), duration: .45 });
    return true;
  };
  const inspect = id => {
    const item = current?.items.get(id); if (!item || !interactive()) return false;
    if (item.bounds) return focusCluster(item);
    const entity = materialize(item), same = viewer.selectedEntity === entity;
    isolate(() => { viewer.selectedEntity = entity; }, () => { if (same) viewer.selectedEntityChanged?.raiseEvent?.(entity); });
    return true;
  };
  const refreshSelection = (edition, previous, previousView) => {
    const seen = new Set(); let errors = 0;
    for (const property of ['selectedEntity', 'trackedEntity']) {
      const entity = viewer[property]; if (!ownEntities.has(entity)) continue;
      const feature = edition.items.get(ownEntities.get(entity));
      if (!feature || feature.bounds) {
        // Render membership can change while immutable source facts do not.
        // A demoted/offscreen selection keeps its exact source proof; a new
        // factual basis without that row cannot inherit it.
        if (previousView && pluginJson(previousView.source) === pluginJson(view.source)) continue;
        errors += isolate(() => { viewer[property] = undefined; }); continue;
      }
      if (seen.has(entity)) continue; seen.add(entity);
      const oldFeature = previous?.items.get(ownEntities.get(entity));
      if (oldFeature && !oldFeature.bounds && previousView && descriptor.title(oldFeature) === descriptor.title(feature) &&
          pluginJson(descriptor.position(oldFeature)) === pluginJson(descriptor.position(feature)) &&
          pluginJson(descriptor.entityProperties(oldFeature, previousView)) === pluginJson(descriptor.entityProperties(feature, view))) continue;
      // Replacing the bag clears an old retained-proof attachment before corrected facts are observed.
      errors += isolate(() => { entity.properties = descriptor.entityProperties(feature, view); },
        () => { const point = descriptor.position(feature); entity.position = point ? Cesium.Cartesian3.fromDegrees(...point) : undefined; },
        () => { entity.name = descriptor.title(feature); });
    }
    return errors;
  };
  async function paint(nextView, { signal, work, valid }) {
    if (!valid()) throw abort();
    if (view?.scene.version === nextView.scene.version && current) {
      const apply = () => { if (!valid()) throw abort(); view = nextView; pending = false; unavailable = false; error = null; sourceErrorCode = null; notify(); };
      if (work) work.publish(apply); else apply(); return true;
    }
    const scope = work || sceneWorkFor(viewer).scope({ key: `prepared-${descriptor.sourceKey}-display`, signal, isCurrent: valid });
    const edition = { host: viewer, billboards: new Cesium.BillboardCollection(), items: new Map(), tokens: new Map() };
    edition.billboards.show = false;
    let promoted = false, preparationMs, attachmentMs, commitMs, observerErrors = 0, outcome = 'error';
    try {
      const started = clock(), rows = [...nextView.scene.features, ...nextView.scene.clusters, ...(nextView.scene.unmappedFeatures || [])];
      await scope.prepare(rows, item => {
        if (!valid()) throw abort();
        const token = Object.freeze({ kind: 'prepared-scene-symbol', sourceKey: descriptor.sourceKey, id: item.id }); edition.tokens.set(item.id, token); edition.items.set(item.id, item);
        if (item.bounds) {
          const slot = descriptor.sourceKey === 'earthquakes' ? [0, 46] : GDACS_CLUSTER_SLOTS[item.symbol || 'notice'];
          edition.billboards.add({ id: token, ...mapClusterBadge(item.count, item.symbol || descriptor.symbol || 'notice'),
            position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat), color: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(...slot) });
        } else {
          const point = descriptor.position(item);
          if (point) edition.billboards.add({ id: token, image: mapSymbolImage(item.symbol || descriptor.symbol || 'notice'),
            position: Cesium.Cartesian3.fromDegrees(...point), color: descriptor.color?.(item) || Cesium.Color.WHITE, width: 22, height: 22 });
        }
      });
      preparationMs = clock() - started; scope.assertCurrent(); if (!valid()) throw abort();
      const attachAt = clock(); await edition.host.scene.primitives.add(edition.billboards);
      scope.assertCurrent(); if (!valid()) throw abort();
      attachmentMs = clock() - attachAt; scope.assertCurrent(); if (!valid()) throw abort();
      const commitAt = clock(); scope.publish(() => {
        if (!valid()) throw abort(); const old = current, previousView = view; view = nextView; current = edition; promoted = true; pending = false; unavailable = false; error = null; sourceErrorCode = null;
        observerErrors += isolate(() => { edition.billboards.show = enabled; }, () => { if (old) old.billboards.show = false; });
        observerErrors += refreshSelection(edition, old, previousView); dispose(old); notify();
      });
      commitMs = clock() - commitAt; metrics = { count: rows.length, preparationMs, attachmentMs, commitMs, observerErrors }; outcome = 'complete'; return true;
    } catch (failure) { outcome = failure?.name === 'AbortError' ? 'cancelled' : 'error'; throw failure; }
    finally { if (!promoted) dispose(edition); if (!work) scope.finish(outcome); }
  }
  const layer = {
    id: descriptor.id, name: descriptor.name, icon: descriptor.icon, source: descriptor.sourceLabel, updateInterval: 60000,
    setDemandRefreshListener(value) { refresh = typeof value === 'function' ? value : requestRefresh; },
    setDemandListener(value) { demandListener = typeof value === 'function' ? value : null; },
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
          if (token?.kind !== 'prepared-scene-symbol' || token.sourceKey !== descriptor.sourceKey) return previous?.(event);
          if (!interactive() || current?.tokens.get(token.id) !== token) return;
          const item = current.items.get(token.id);
          if (item.bounds) focusCluster(item);
          else if (type === Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) isolate(() => { viewer.trackedEntity = materialize(item); });
          else inspect(token.id);
        };
        handler.setInputAction(action, type); actions.push({ type, previous, action });
      }
    },
    enable() { enabled = true; try { selectDemand(getDemand(viewer)); } catch { clear(); selectionKey = null; pending = true; }
      if (current) current.billboards.show = true; },
    disable() { enabled = false; cancel(); clearSelection(); if (current) current.billboards.show = false; },
    async update(_viewer = viewer, { signal: external, work } = {}) {
      if (!interactive() || !viewer) return false;
      let demand; try { demand = getDemand(viewer); selectDemand(demand); } catch { cancel(); clear(); selectionKey = null; pending = true; return false; }
      request?.abort(abort()); const next = new AbortController(); request = next;
      const signal = external ? AbortSignal.any([next.signal, external]) : next.signal, key = selectionKey;
      const valid = () => enabled && !destroyed && request === next && !signal.aborted && selectionKey === key;
      try {
        const result = await client.load(demand, { signal, onCached: cached => paint(cached, { signal, work, valid }) });
        if (!valid()) return false;
        if (result.pending) { pending = result.preparing === true; unavailable = !pending; sourceErrorCode = result.errorCode || null;
          error = unavailable && view ? sourceErrorCode === 'scene-byte-budget' ? 'Dense area requires aggregation' : 'Stored source view unavailable' : null;
          notify(); return false; }
        return await paint(result, { signal, work, valid });
      } catch (failure) {
        if (!valid() || failure?.name === 'AbortError') return false;
        pending = false; unavailable = true; sourceErrorCode = 'stored-scene-unavailable'; error = view ? 'Stored source view unavailable' : null; notify(); return false;
      } finally { if (request === next) request = null; }
    },
    getRowControls() {
      if (!enabled || !view) return { info: sourceErrorCode === 'scene-byte-budget' ? 'Dense area requires aggregation' : pending ? 'Preparing this area' : 'Stored source view unavailable' };
      const scene = view.scene;
      const count = scene.counts.selectedMapped ?? scene.counts.selectedReports;
      return { info: unavailable ? `${sourceErrorCode === 'scene-byte-budget' ? 'Dense area requires aggregation' : 'Stored source view unavailable'} · previous complete view retained` :
        `${count} ${descriptor.countLabel || 'reports'} · ${pending ? 'updating this area' : scene.clusters.length ? 'select an area to expand' : descriptor.locationLabel || 'source locations'}`,
        items: [...scene.features, ...scene.clusters, ...(scene.unmappedFeatures || [])].map(item => ({ id: item.id,
          label: item.bounds ? descriptor.clusterTitle?.(item) || `${item.count} ${descriptor.countLabel || 'reports'}` : descriptor.title(item),
          detail: item.bounds ? 'Area summary; not a reported event location' : descriptor.detail?.(item) || '', params: { inspect: item.id } })) };
    },
    setParams(value) { const id = value?.inspect || descriptor.inspectParameter?.(value); if (typeof id === 'string') return inspect(id); return false; }, getParams: () => ({}),
    getAnalystRecords(maxCount = 2000) { if (!enabled || !view || typeof descriptor.analystRecord !== 'function') return [];
      return view.scene.features.slice(0, Math.max(0, Math.min(500, Math.floor(maxCount) || 0))).map((feature, index) => descriptor.analystRecord(feature, index)).filter(Boolean); },
    getStats() {
      const source = view?.source, check = view?.check, age = view?.sourceGenerationAgeMs === null || !view ? null :
        view.sourceGenerationAgeMs + Math.max(0, Date.now() - view.browserReadAt);
      const sourceStats = view ? descriptor.stats(view) : {};
      return { lastUpdate: null, receipt: null, checkedAt: null, lastSuccessfulAt: null, sourceGeneratedAt: null,
        retainedSourceGeneratedAt: null, ...sourceStats, count: view?.scene.counts.selectedMapped ?? view?.scene.counts.selectedReports ?? 0,
        drawnCount: current?.billboards.length || 0,
        error, sourceErrorCode, pending, loading: pending && !view, status: pending ? 'preparing' : unavailable ? 'unavailable' : sourceStats.status || check?.status || null, sourceAgeMs: age,
        stale: unavailable || error || view?.browserCache || view?.stale || age !== null && age > 120000 ? true : view?.stale ?? null,
        degraded: Boolean(unavailable || error), snapshot: false,
        observedAt: null, browserCache: view?.browserCache ? 'STALE' : null,
        coverage: view ? unavailable ? `${descriptor.coverageLabel} · prior complete view retained` : pending ?
          `${descriptor.coverageLabel} · prior complete view while this area loads` : `${descriptor.coverageLabel} · complete selected cells` : null,
        cohortCoverage: view ? { ...view.scene.coverage, requestedViewportComplete: !pending && !unavailable && regionalSelectionKey(view.scene.selection) === selectionKey } : null,
        displayedSelection: view?.scene.selection || null, requestedSelection: desiredDemand ? {
          level: desiredDemand.level, cells: desiredDemand.cells, mode: desiredDemand.mode } : null,
        requestedViewportComplete: Boolean(view && !pending && !unavailable && regionalSelectionKey(view.scene.selection) === selectionKey),
        editionMetrics: metrics && { ...metrics }, regional: true, mode: view?.scene.selection.mode || null,
        interest: view?.scene.interest || null, clusterLayout: PREPARED_CLUSTER_LAYOUT };
    },
    destroy() {
      if (destroyed) return; destroyed = true; enabled = false; cancel(); clear(); client.destroy?.();
      for (const stop of cameraStops) isolate(stop); cameraStops = [];
      const handler = viewer?.screenSpaceEventHandler;
      for (const { type, previous, action } of actions) isolate(() => {
        if (viewer?.isDestroyed?.() || handler.getInputAction(type) !== action) return;
        if (previous) handler.setInputAction(previous, type); else handler.removeInputAction?.(type);
      });
      actions = []; stateListener = null; demandListener = null; refresh = () => {}; viewer = null;
    },
  };
  return layer;
}
