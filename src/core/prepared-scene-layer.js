import * as Cesium from 'cesium';
import { createRegionalSceneClient, regionalSelectionKey } from './regional-scene-client.js';
import { extractCameraDemand } from './spatial-demand.js';
import { sceneWorkFor } from './scene-work.js';
import { pluginJson } from './plugin-evidence.js';
import { FOCUS_SCENE_LIMITS, focusFeatureMatches } from './focus-scene-contract.js';
import { BEACON_STYLE, beaconGeometry, beaconHeadOptions, beaconBaseOptions, beaconStemOptions, beaconTipAt, beaconAnimatorFor } from './map-beacons.js';
import { MAP_SYMBOL_LABELS } from './map-symbols.js';
import { editableTarget } from './commands.js';

const isolate = (...operations) => { let errors = 0; for (const operation of operations) { try { operation(); } catch { ++errors; } } return errors; };
const abort = () => new DOMException('Prepared seismic display superseded', 'AbortError');
const clock = () => performance.now();

/** Public Billboard.ready fences image/WebGL-resource admission, not GPU completion.
 * The collection must update, while each staged billboard remains invisible. */
export function warmPreparedBillboards({ viewer, collection, signal, isCurrent = () => true, deadlineMs = 2000 } = {}) {
  if (!collection || !Number.isInteger(collection.length) || collection.length > 1200 || typeof isCurrent !== 'function' ||
      !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 2000) throw new TypeError('Use a bounded native symbol edition');
  const started = clock(), valid = () => !signal?.aborted && !viewer?.isDestroyed?.() && isCurrent();
  if (!valid()) return Promise.reject(signal?.reason || abort());
  for (let i = 0; i < collection.length; i++) collection.get(i).show = false;
  collection.show = true;
  if (!viewer?.scene?.postRender?.addEventListener) return Promise.resolve({ observed: false, ready: null, durationMs: 0, renderRequests: 0 });
  return new Promise((resolve, reject) => {
    let finished = false, renderRequests = 0, stopFrames, timer, poll;
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); clearInterval(poll);
      stopFrames?.(); signal?.removeEventListener('abort', canceled); if (error) reject(error); else resolve(result); };
    const canceled = () => finish(signal?.reason || abort());
    const check = requestFrame => {
      try {
        if (!valid()) return finish(signal?.reason || abort());
        let ready = true; for (let i = 0; i < collection.length; i++) if (!collection.get(i).ready) { ready = false; break; }
        if (ready) return finish(null, { observed: true, ready: true, durationMs: clock() - started, renderRequests });
        if (requestFrame && renderRequests < 42) { ++renderRequests; viewer.scene.requestRender(); }
      } catch (error) { finish(error); }
    };
    stopFrames = viewer.scene.postRender.addEventListener(() => check(false));
    signal?.addEventListener('abort', canceled, { once: true });
    timer = setTimeout(() => finish(Object.assign(new Error('Native symbols are not ready'), { code: 'symbol-readiness-timeout' })), deadlineMs);
    poll = setInterval(() => check(true), 50); check(true);
  });
}

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
  let cameraTimer, cameraStops = [], actions = [], stateListener, demandListener, clusterListener, featureListener, inspection, members, error = null,
    sourceErrorCode = null, displayErrorCode = null, pending = false, unavailable = false, metrics = null;
  let animator, displayEpoch = 0, cameraRevision = 0;
  const ownEntities = new WeakMap(), entityProofs = new WeakMap(), zoomed = new Map();
  const interactive = () => enabled && !destroyed && !documentRef?.hidden && !viewer?.isDestroyed?.() &&
    viewer?.earthTime?.getState?.()?.mode !== 'history';
  const clearSelection = () => isolate(...['selectedEntity', 'trackedEntity'].map(property => () => {
    if (ownEntities.has(viewer?.[property])) viewer[property] = undefined;
  }));
  const dispose = edition => {
    if (!edition) return;
    for (const release of edition.animations) isolate(release);
    isolate(() => { if (!edition.host.isDestroyed?.()) edition.host.scene.primitives.remove(edition.billboards); },
      () => { if (!edition.billboards.isDestroyed()) edition.billboards.destroy(); },
      () => { if (!edition.host.isDestroyed?.()) edition.host.scene.primitives.remove(edition.stems); },
      () => { if (!edition.stems.isDestroyed()) edition.stems.destroy(); });
    edition.items.clear(); edition.tokens.clear(); edition.beacons.clear();
  };
  const clear = () => {
    clearSelection(); const old = current; current = null; view = null; metrics = null; dispose(old); viewer?.scene?.requestRender?.();
  };
  const closeMembers = () => { members?.abort(abort()); members = null; };
  const cancelInspection = () => { inspection?.abort(abort()); inspection = null; closeMembers(); };
  const cancel = () => { request?.abort(abort()); request = null; ++cameraRevision; cancelInspection(); client.cancel?.(); clearTimeout(cameraTimer); cameraTimer = undefined; };
  const notify = () => { isolate(() => stateListener?.(), () => viewer?.scene?.requestRender?.()); };
  const unavailableText = () => displayErrorCode ? 'Map symbols unavailable' : sourceErrorCode === 'scene-byte-budget' ? 'Dense area requires aggregation' : 'Stored source view unavailable';
  const selectDemand = demand => {
    const key = regionalSelectionKey(demand);
    if (key === selectionKey) { desiredDemand = demand; return false; }
    cancel(); selectionKey = key; desiredDemand = demand; client.select?.(demand);
    // Keep exact retained positions while the new viewport loads. Its requested
    // completeness is separate from the last complete displayed selection.
    pending = true; unavailable = false; error = null; sourceErrorCode = null; displayErrorCode = null; notify(); return true;
  };
  const changed = () => {
    if (!enabled || destroyed || !viewer) return;
    let demandChanged;
    try { demandChanged = selectDemand(getDemand(viewer)); }
    catch { cancel(); clear(); selectionKey = null; desiredDemand = null; pending = true; return; }
    const revision = ++cameraRevision;
    clearTimeout(cameraTimer); cameraTimer = setTimeout(() => { cameraTimer = undefined;
      if (!interactive() || revision !== cameraRevision) return;
      if (demandChanged || pending) { isolate(() => demandListener?.(desiredDemand)); refresh(); }
      else if (current) { const edition = current; void retargetBeacons(edition, { valid: () => interactive() && current === edition && cameraRevision === revision }).catch(() => {}); }
    }, debounceMs);
  };
  const materialize = (feature, proofView = view) => {
    for (const entity of [viewer.selectedEntity, viewer.trackedEntity]) if (ownEntities.get(entity) === feature.id &&
        pluginJson(entityProofs.get(entity)?.source) === pluginJson(proofView.source)) return entity;
    const point = descriptor.position(feature), entity = new Cesium.Entity({ id: descriptor.entityId?.(feature) || feature.id,
      name: descriptor.title(feature), position: point ? Cesium.Cartesian3.fromDegrees(...point) : undefined,
      properties: descriptor.entityProperties(feature, proofView) });
    ownEntities.set(entity, feature.id); entityProofs.set(entity, { source: proofView.source, feature }); return entity;
  };
  const captureInspectionIntent = () => {
    const origin = documentRef?.activeElement, cameraOwner = cameraRevision, demandOwner = selectionKey;
    const workspaceOpen = id => { const element = documentRef?.getElementById?.(id); return element?.hidden === false && !element.inert; };
    const initialWorkspaces = new Map(['news-panel', 'notebook-panel'].map(id => [id, workspaceOpen(id)]));
    const initiallyEditing = editableTarget(origin) || documentRef?.getElementById?.('command-palette')?.open;
    return () => {
      if (initiallyEditing || cameraOwner !== cameraRevision || demandOwner !== selectionKey ||
          documentRef?.getElementById?.('command-palette')?.open || editableTarget(documentRef?.activeElement) ||
          [...initialWorkspaces].some(([id, open]) => !open && workspaceOpen(id))) return false;
      const active = documentRef?.activeElement, body = documentRef?.body, root = documentRef?.documentElement;
      if (active && active !== origin && active !== body && active !== root) return false;
      // A same-layer row refresh can remove the original button. Its BODY focus
      // is allowed; a different still-connected navigation control keeps intent.
      if ((active === body || active === root) && origin && origin !== body && origin !== root && origin.isConnected !== false) return false;
      return true;
    };
  };
  const inspectFeature = (item, capturedView, tracked = false, extraCurrent = () => true, external) => {
    if (!item || !interactive() || !capturedView) return false;
    const userIntent = captureInspectionIntent(); if (!userIntent()) return false;
    const apply = full => {
      const entity = materialize(full, capturedView), same = viewer.selectedEntity === entity;
      closeMembers(); isolate(() => { if (tracked) viewer.trackedEntity = entity; else viewer.selectedEntity = entity; },
        () => { if (!tracked && same) viewer.selectedEntityChanged?.raiseEvent?.(entity); },
        () => { if (!tracked && interactive() && viewer.selectedEntity === entity) featureListener?.(entity); }); return true;
    };
    if (item.record) return apply(item);
    if (typeof client.getFeature !== 'function') return false;
    inspection?.abort(abort()); const controller = new AbortController(); inspection = controller;
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    const valid = () => inspection === controller && !signal.aborted && interactive() && extraCurrent() && userIntent() &&
      view && pluginJson(view.source) === pluginJson(capturedView.source);
    return (async () => {
      try { const result = await client.getFeature(item, capturedView.source, { signal });
        if (!valid() || !focusFeatureMatches(descriptor.sourceKey, item, result?.feature) ||
            pluginJson(result.source) !== pluginJson(capturedView.source)) return false;
        return apply(result.feature);
      } catch { return false; } finally { if (inspection === controller) inspection = null; }
    })();
  };
  const inspectMembers = cell => {
    if (!current?.items.has(cell.id) || !interactive() || view?.scene.schemaVersion !== 2 ||
        typeof clusterListener !== 'function' || typeof client.getMembers !== 'function') return false;
    closeMembers(); const controller = new AbortController(); members = controller;
    const captured = view, demandKey = selectionKey;
    const valid = () => members === controller && !controller.signal.aborted && interactive() && selectionKey === demandKey &&
      view?.scene.version === captured.scene.version && pluginJson(view.source) === pluginJson(captured.source);
    const context = Object.freeze({ sourceKey: descriptor.sourceKey, sourceLabel: descriptor.sourceLabel, cluster: cell,
      source: captured.source, viewVersion: captured.scene.version, signal: controller.signal, isCurrent: valid,
      ...(cell.groups?.length > 1 ? {
        groups: Object.freeze(cell.groups.map(group => Object.freeze({ id: group.id,
          label: MAP_SYMBOL_LABELS[group.symbol] || MAP_SYMBOL_LABELS.notice, count: group.count }))),
        inspectGroup(id) {
          // The parent chooser closes before this call. Bind to its displayed edition,
          // not its retired controller, then acquire a fresh single-category context.
          if (!interactive() || selectionKey !== demandKey || view?.scene.version !== captured.scene.version ||
              pluginJson(view.source) !== pluginJson(captured.source)) return false;
          const group = cell.groups.find(item => item.id === id); return group ? inspectMembers(group) : false;
        },
      } : {}),
      async loadPage(cursor = null, { signal } = {}) {
        if (!valid()) throw abort(); if (cell.groups?.length > 1) throw new TypeError('Choose a retained source category first');
        const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        const page = await client.getMembers(captured, cell, cursor, { signal: combined });
        if (!valid() || combined.aborted) throw abort(); return page;
      },
      inspectMember(item, { signal } = {}) { const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        return valid() ? Promise.resolve(inspectFeature(item, captured, false, valid, combined)) : Promise.resolve(false); },
      onClose() { if (members === controller) closeMembers(); },
    });
    try { clusterListener(context); return true; } catch { closeMembers(); return false; }
  };
  const focusCluster = cell => {
    if (!current?.items.has(cell.id) || !interactive()) return false;
    if (cell.leaf?.[0] === FOCUS_SCENE_LIMITS.maxLevel) return inspectMembers(cell);
    const priorZoom = zoomed.get(cell.id);
    if (view.scene.schemaVersion === 2 && priorZoom && (priorZoom.epoch !== displayEpoch || clock() - priorZoom.clickedAt >= 500)) return inspectMembers(cell);
    zoomed.delete(cell.id); zoomed.set(cell.id, priorZoom?.epoch === displayEpoch ? priorZoom : { epoch: displayEpoch, clickedAt: clock() });
    while (zoomed.size > 128) zoomed.delete(zoomed.keys().next().value);
    viewer.camera?.flyTo?.({ destination: Cesium.Rectangle.fromDegrees(cell.bounds.west, cell.bounds.south, cell.bounds.east, cell.bounds.north), duration: .45 });
    return true;
  };
  const inspect = id => {
    const item = current?.items.get(id); if (!item || !interactive()) return false;
    if (item.bounds) return focusCluster(item);
    return inspectFeature(item, view);
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
      if (!feature.record) {
        const proof = entityProofs.get(entity);
        if (proof && pluginJson(proof.source) === pluginJson(view.source) && focusFeatureMatches(descriptor.sourceKey, feature, proof.feature)) continue;
        errors += isolate(() => { if (viewer.selectedEntity === entity) viewer.selectedEntity = undefined; },
          () => { if (viewer.trackedEntity === entity) viewer.trackedEntity = undefined; }); continue;
      }
      const oldFeature = previous?.items.get(ownEntities.get(entity));
      if (oldFeature && !oldFeature.bounds && previousView && descriptor.title(oldFeature) === descriptor.title(feature) &&
          pluginJson(descriptor.position(oldFeature)) === pluginJson(descriptor.position(feature)) &&
          pluginJson(descriptor.entityProperties(oldFeature, previousView)) === pluginJson(descriptor.entityProperties(feature, view))) continue;
      // Replacing the bag clears an old retained-proof attachment before corrected facts are observed.
      errors += isolate(() => { entity.properties = descriptor.entityProperties(feature, view); },
        () => { const point = descriptor.position(feature); entity.position = point ? Cesium.Cartesian3.fromDegrees(...point) : undefined; },
        () => { entity.name = descriptor.title(feature); });
      entityProofs.set(entity, { source: view.source, feature });
    }
    return errors;
  };
  async function retargetBeacons(edition, { signal, work, valid }) {
    const scope = work || sceneWorkFor(viewer).scope({ key: `prepared-${descriptor.sourceKey}-beacon-scale`, signal, isCurrent: valid });
    let outcome = 'error';
    try {
      const geometries = await scope.prepare([...edition.beacons.values()], beacon => {
        const coordinates = beacon.item.bounds ? [beacon.item.lon, beacon.item.lat] : descriptor.position(beacon.item);
        return { beacon, geometry: beaconGeometry(viewer, coordinates) };
      });
      scope.publish(() => {
        if (!valid()) throw abort(); animator?.settle();
        for (const { beacon, geometry } of geometries) {
          beacon.geometry = geometry; beacon.base.position = geometry.base; beacon.base.scale = 1;
          beacon.head.position = geometry.tip; beacon.stem.positions = [geometry.base, geometry.tip];
        }
        viewer.scene.requestRender?.();
      }); outcome = 'complete';
    } catch (error) { outcome = error?.name === 'AbortError' ? 'cancelled' : 'error'; throw error; }
    finally { if (!work) scope.finish(outcome); }
  }
  async function paint(nextView, { signal, work, valid }) {
    if (!valid()) throw abort();
    if (view?.scene.version === nextView.scene.version && current) {
      await retargetBeacons(current, { signal, work, valid });
      const apply = () => { if (!valid()) throw abort(); view = nextView; pending = false; unavailable = false; error = null; sourceErrorCode = null; displayErrorCode = null; notify(); };
      if (work) work.publish(apply); else apply(); return true;
    }
    const scope = work || sceneWorkFor(viewer).scope({ key: `prepared-${descriptor.sourceKey}-display`, signal, isCurrent: valid });
    const edition = { host: viewer, billboards: new Cesium.BillboardCollection(), stems: new Cesium.PolylineCollection(),
      items: new Map(), tokens: new Map(), beacons: new Map(), animations: [] };
    edition.billboards.show = edition.stems.show = false;
    let promoted = false, preparationMs, attachmentMs, symbolReadiness, commitMs, observerErrors = 0, outcome = 'error';
    try {
      const started = clock(), clusters = new Map();
      for (const cell of nextView.scene.clusters) {
        const key = cell.leaf?.join(':') || pluginJson(cell.bounds), group = clusters.get(key) || [];
        group.push(cell); clusters.set(key, group); edition.items.set(cell.id, cell);
      }
      const areaSymbols = [...clusters].map(([key, groups]) => groups.length === 1 ? groups[0] : Object.freeze({
        ...groups[0], id: `area:${descriptor.sourceKey}:${key}`, symbol: 'notice', category: 'notice',
        count: groups.reduce((sum, cell) => sum + cell.count, 0), groups: Object.freeze(groups) }));
      const rows = [...nextView.scene.features, ...areaSymbols, ...(nextView.scene.unmappedFeatures || [])];
      await scope.prepare(rows, item => {
        if (!valid()) throw abort();
        const token = Object.freeze({ kind: 'prepared-scene-symbol', sourceKey: descriptor.sourceKey, id: item.id }); edition.tokens.set(item.id, token); edition.items.set(item.id, item);
        const point = item.bounds ? [item.lon, item.lat] : descriptor.position(item);
        if (!point) return;
        const geometry = beaconGeometry(viewer, point), symbol = item.symbol || descriptor.symbol || 'notice',
          { image: headImage, ...headStyle } = beaconHeadOptions(symbol, { documentRef }),
          { image: baseImage, ...baseStyle } = beaconBaseOptions({ documentRef });
        const head = edition.billboards.add({ id: token,
          ...headStyle, position: geometry.tip,
          show: false, color: item.bounds ? Cesium.Color.WHITE : descriptor.color?.(item) || Cesium.Color.WHITE });
        head.setImage(`beacon-v1-head:${symbol}`, headImage);
        const base = edition.billboards.add({ id: token, ...baseStyle, position: geometry.base, color: Cesium.Color.WHITE, show: false });
        base.setImage('beacon-v1-base', baseImage);
        const stem = edition.stems.add(beaconStemOptions(geometry, { id: token }));
        edition.beacons.set(item.id, { head, base, stem, geometry, item });
      });
      preparationMs = clock() - started; scope.assertCurrent(); if (!valid()) throw abort();
      const attachAt = clock(); await edition.host.scene.primitives.add(edition.billboards);
      scope.assertCurrent(); if (!valid()) throw abort();
      await edition.host.scene.primitives.add(edition.stems); scope.assertCurrent(); if (!valid()) throw abort();
      attachmentMs = clock() - attachAt; scope.assertCurrent(); if (!valid()) throw abort();
      symbolReadiness = await warmPreparedBillboards({ viewer: edition.host, collection: edition.billboards, signal, isCurrent: valid });
      scope.assertCurrent(); if (!valid()) throw abort();
      const commitAt = clock(); scope.publish(() => {
        if (!valid()) throw abort(); const old = current, previousView = view;
        closeMembers(); if (previousView && pluginJson(previousView.source) !== pluginJson(nextView.source)) cancelInspection();
        if (previousView && pluginJson(previousView.source) !== pluginJson(nextView.source)) zoomed.clear();
        if (!previousView || regionalSelectionKey(previousView.scene.selection) !== regionalSelectionKey(nextView.scene.selection)) ++displayEpoch;
        view = nextView; current = edition; promoted = true; pending = false; unavailable = false; error = null; sourceErrorCode = null; displayErrorCode = null;
        observerErrors += isolate(() => { edition.billboards.show = edition.stems.show = enabled; },
          () => { if (old) old.billboards.show = old.stems.show = false; });
        for (const beacon of edition.beacons.values()) { beacon.head.show = beacon.base.show = true; }
        observerErrors += refreshSelection(edition, old, previousView); dispose(old);
        for (const [id, beacon] of edition.beacons) if (animator) observerErrors += isolate(() => edition.animations.push(animator.play({
          key: `${descriptor.sourceKey}:${id}`, revision: beacon.item.bounds ? null : beacon.item.revision,
          isCurrent: () => !destroyed && current === edition && !edition.billboards.isDestroyed(),
          apply(progress) { const tip = beaconTipAt(beacon.geometry, progress); beacon.head.position = tip;
            beacon.stem.positions = [beacon.geometry.base, tip]; beacon.base.scale = 1 + .4 * (1 - progress); },
        })));
        notify();
      });
      commitMs = clock() - commitAt; metrics = { count: rows.length, preparationMs, attachmentMs, commitMs, observerErrors,
        symbolReadiness: { ...symbolReadiness } }; outcome = 'complete'; return true;
    } catch (failure) { outcome = failure?.name === 'AbortError' ? 'cancelled' : 'error'; throw failure; }
    finally { if (!promoted) dispose(edition); if (!work) scope.finish(outcome); }
  }
  const layer = {
    id: descriptor.id, name: descriptor.name, icon: descriptor.icon, source: descriptor.sourceLabel, updateInterval: 60000,
    setDemandRefreshListener(value) { refresh = typeof value === 'function' ? value : requestRefresh; },
    setDemandListener(value) { demandListener = typeof value === 'function' ? value : null; },
    setClusterInspectionListener(value) { clusterListener = typeof value === 'function' ? value : null; if (!clusterListener) closeMembers(); },
    setFeatureInspectionListener(value) { featureListener = typeof value === 'function' ? value : null; },
    setRowControlsListener(value) { stateListener = typeof value === 'function' ? value : null; },
    setLocalArea() { /* Camera cells own the display scope; no browser source filtering. */ },
    invalidatePreparedSnapshot(revision) { const admitted = client.invalidate?.(revision) !== false; if (admitted) { request?.abort(abort()); pending = true; } return admitted; },
    init(value) {
      if (viewer || destroyed) throw new Error('Prepared seismic display already initialized'); viewer = value;
      if (viewer.scene.preRender?.addEventListener) animator = beaconAnimatorFor(viewer, { documentRef }).acquire(`prepared-${descriptor.sourceKey}`);
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
          else if (type === Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) inspectFeature(item, view, true);
          else inspect(token.id);
        };
        handler.setInputAction(action, type); actions.push({ type, previous, action });
      }
    },
    enable() { enabled = true; try { selectDemand(getDemand(viewer)); } catch { clear(); selectionKey = null; pending = true; }
      if (current) current.billboards.show = current.stems.show = true; },
    disable() { animator?.settle(); enabled = false; cancel(); zoomed.clear(); clearSelection(); if (current) current.billboards.show = current.stems.show = false; },
    async update(_viewer = viewer, { signal: external, work } = {}) {
      if (!interactive() || !viewer) return false;
      let demand; try { demand = getDemand(viewer); selectDemand(demand); } catch { cancel(); clear(); selectionKey = null; pending = true; return false; }
      request?.abort(abort()); const next = new AbortController(); request = next;
      const signal = external ? AbortSignal.any([next.signal, external]) : next.signal, key = selectionKey;
      const valid = () => interactive() && request === next && !signal.aborted && selectionKey === key;
      try {
        const result = await client.load(demand, { signal, onCached: cached => paint(cached, { signal, work, valid }) });
        if (!valid()) return false;
        if (result.pending) { pending = result.preparing === true; unavailable = !pending; sourceErrorCode = result.errorCode || null; displayErrorCode = null;
          error = unavailable && view ? unavailableText() : null;
          notify(); return false; }
        return await paint(result, { signal, work, valid });
      } catch (failure) {
        if (!valid() || failure?.name === 'AbortError') return false;
        pending = false; unavailable = true; displayErrorCode = failure?.code === 'symbol-readiness-timeout' ? failure.code : null;
        sourceErrorCode = displayErrorCode ? null : 'stored-scene-unavailable'; error = view ? unavailableText() : null; notify(); return false;
      } finally { if (request === next) request = null; }
    },
    getRowControls() {
      if (!enabled || !view) return { info: pending ? 'Preparing this area' : unavailableText() };
      const scene = view.scene;
      const count = scene.counts.selectedMapped ?? scene.counts.selectedReports;
      return { info: unavailable ? `${unavailableText()} · previous complete view retained` :
        `${count} ${descriptor.countLabel || 'reports'} · ${pending ? 'updating this area' : scene.clusters.length ? 'select an area to expand' : descriptor.locationLabel || 'source locations'}`,
        items: [...scene.features, ...scene.clusters, ...(scene.unmappedFeatures || [])].map(item => ({ id: item.id,
          label: item.bounds ? descriptor.clusterTitle?.(item) || `${item.count} ${descriptor.countLabel || 'reports'}` : descriptor.title(item),
          detail: item.bounds ? `${item.count} retained reports · inspect sources; not a reported event location` : descriptor.detail?.(item) || '',
          params: { inspect: item.id }, ...(item.bounds && scene.schemaVersion === 2 ? { inspectParams: { inspectMembers: item.id } } : {}) })) };
    },
    setParams(value) { if (typeof value?.inspectMembers === 'string') { const cell = current?.items.get(value.inspectMembers); return cell?.bounds ? inspectMembers(cell) : false; }
      const id = value?.inspect || descriptor.inspectParameter?.(value); if (typeof id === 'string') return inspect(id); return false; }, getParams: () => ({}),
    getAnalystRecords(maxCount = 2000) { if (!enabled || !view || typeof descriptor.analystRecord !== 'function') return [];
      return view.scene.features.filter(feature => feature.record).slice(0, Math.max(0, Math.min(500, Math.floor(maxCount) || 0))).map((feature, index) => descriptor.analystRecord(feature, index)).filter(Boolean); },
    getStats() {
      const source = view?.source, check = view?.check, age = view?.sourceGenerationAgeMs === null || !view ? null :
        view.sourceGenerationAgeMs + Math.max(0, Date.now() - view.browserReadAt);
      const sourceStats = view ? descriptor.stats(view) : {};
      return { lastUpdate: null, receipt: null, checkedAt: null, lastSuccessfulAt: null, sourceGeneratedAt: null,
        retainedSourceGeneratedAt: null, ...sourceStats, count: view?.scene.counts.selectedMapped ?? view?.scene.counts.selectedReports ?? 0,
        drawnCount: current?.beacons.size || 0,
        error, sourceErrorCode, displayErrorCode, pending, loading: pending && !view, status: pending ? 'preparing' : unavailable ? 'unavailable' : sourceStats.status || check?.status || null, sourceAgeMs: age,
        stale: unavailable || error || view?.browserCache || view?.stale || age !== null && age > 120000 ? true : view?.stale ?? null,
        degraded: Boolean(unavailable || error), snapshot: false,
        observedAt: null, browserCache: view?.browserCache ? 'STALE' : null,
        coverage: view ? unavailable ? `${descriptor.coverageLabel} · prior complete view retained` : pending ?
          `${descriptor.coverageLabel} · prior complete view while this area loads` : `${descriptor.coverageLabel} · complete selected cells` : null,
        cohortCoverage: view ? { ...view.scene.coverage, requestedViewportComplete: !pending && !unavailable && regionalSelectionKey(view.scene.selection) === selectionKey } : null,
        displayedSelection: view?.scene.selection || null, requestedSelection: desiredDemand?.schemaVersion === 2 ? {
          schemaVersion: 2, policyId: desiredDemand.policyId, leaves: desiredDemand.leaves, focus: desiredDemand.focus, featureBudget: desiredDemand.featureBudget } : desiredDemand ? {
          level: desiredDemand.level, cells: desiredDemand.cells, mode: desiredDemand.mode } : null,
        requestedViewportComplete: Boolean(view && !pending && !unavailable && regionalSelectionKey(view.scene.selection) === selectionKey),
        editionMetrics: metrics && { ...metrics, symbolReadiness: { ...metrics.symbolReadiness } }, regional: true, mode: view?.scene.schemaVersion === 2 ? 'mixed-focus' : view?.scene.selection.mode || null,
        interest: view?.scene.interest || null, beaconStyle: BEACON_STYLE, inspectionPending: Boolean(inspection) };
    },
    destroy() {
      if (destroyed) return; destroyed = true; enabled = false; cancel(); clear(); animator?.destroy(); animator = null; zoomed.clear(); client.destroy?.();
      for (const stop of cameraStops) isolate(stop); cameraStops = [];
      const handler = viewer?.screenSpaceEventHandler;
      for (const { type, previous, action } of actions) isolate(() => {
        if (viewer?.isDestroyed?.() || handler.getInputAction(type) !== action) return;
        if (previous) handler.setInputAction(previous, type); else handler.removeInputAction?.(type);
      });
      actions = []; stateListener = null; demandListener = null; clusterListener = null; featureListener = null; refresh = () => {}; viewer = null;
    },
  };
  return layer;
}
