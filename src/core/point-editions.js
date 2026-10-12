import * as Cesium from 'cesium';
import { sceneWorkFor } from './scene-work.js';

const bridges = new WeakMap();
const abort = () => new DOMException('Point edition superseded', 'AbortError');
const now = () => globalThis.performance?.now?.() ?? Date.now();
const isolate = (...operations) => {
  let errors = 0;
  for (const operation of operations) { try { operation(); } catch { ++errors; } }
  return errors;
};

function immutableJson(value, depth = 0) {
  if (depth > 16) throw new TypeError('Point properties are too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutableJson(item, depth + 1)));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJson(item, depth + 1)])));
  throw new TypeError('Point properties must contain finite plain JSON');
}

function featureSpec(value) {
  if (value instanceof Cesium.Entity || !value || typeof value !== 'object' ||
      typeof value.id !== 'string' || !value.id.length || value.id.length > 512 ||
      typeof value.name !== 'string' || value.name.length > 4096 ||
      !value.position || !['x', 'y', 'z'].every(key => Number.isFinite(value.position[key])) ||
      !value.point || !value.properties || Array.isArray(value.properties)) throw new TypeError('Use a plain complete point feature');
  const point = value.point;
  if (!Number.isFinite(point.pixelSize) || point.pixelSize < 0 || point.pixelSize > 64 ||
      !Number.isFinite(point.outlineWidth) || point.outlineWidth < 0 || point.outlineWidth > 16 ||
      ![point.color, point.outlineColor].every(color => color instanceof Cesium.Color &&
        ['red', 'green', 'blue', 'alpha'].every(key => Number.isFinite(color[key]) && color[key] >= 0 && color[key] <= 1)))
    throw new TypeError('Use a bounded constant point style');
  return Object.freeze({ id: value.id, name: value.name,
    position: Object.freeze(Cesium.Cartesian3.clone(value.position)),
    point: Object.freeze({ pixelSize: point.pixelSize, outlineWidth: point.outlineWidth,
      color: Object.freeze(Cesium.Color.clone(point.color)), outlineColor: Object.freeze(Cesium.Color.clone(point.outlineColor)) }),
    properties: immutableJson(value.properties) });
}

/** One input bridge per viewer; native Entity/imagery picks keep their original handlers. */
function acquireBridge(viewer) {
  let bridge = bridges.get(viewer);
  if (!bridge) {
    const tokens = new WeakMap(), projections = new WeakMap(), clients = new Set(), actions = [];
    const handler = viewer.screenSpaceEventHandler;
    const alive = () => !viewer.isDestroyed?.();
    const metadata = entity => entity && typeof entity === 'object' ? projections.get(entity) : undefined;
    const materialize = (owner, feature) => {
      for (const entity of [viewer.selectedEntity, viewer.trackedEntity]) {
        const previous = metadata(entity);
        if (previous?.owner === owner && previous.id === feature.id) return entity;
      }
      const entity = new Cesium.Entity({ id: feature.id, name: feature.name, position: feature.position, properties: feature.properties });
      projections.set(entity, { owner, id: feature.id });
      return entity;
    };
    for (const type of [Cesium.ScreenSpaceEventType.LEFT_CLICK, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK]) {
      if (!handler?.getInputAction || !handler?.setInputAction) continue;
      const previous = handler.getInputAction(type);
      const action = event => {
        if (!alive()) return;
        // A later owner can retain this wrapper as its previous action.
        if (!clients.size) return previous?.(event);
        const picked = viewer.scene.pick?.(event.position);
        const token = picked?.id ?? picked?.primitive?.id;
        const target = token && typeof token === 'object' ? tokens.get(token) : undefined;
        if (!target) return previous?.(event);
        const feature = target.owner.resolve(token, target.id);
        // A retired or hidden owned marker is a miss, not an imagery/source lookup.
        if (!feature) return;
        const entity = materialize(target.owner, feature);
        if (type === Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) isolate(() => { viewer.trackedEntity = entity; });
        else {
          const same = viewer.selectedEntity === entity;
          isolate(() => { viewer.selectedEntity = entity; });
          if (same) isolate(() => viewer.selectedEntityChanged?.raiseEvent?.(entity));
        }
        viewer.scene.requestRender?.();
      };
      handler.setInputAction(action, type); actions.push({ type, previous, action });
    }
    bridge = {
      metadata, materialize,
      register(owner) { clients.add(owner); },
      token(owner, id) { const token = Object.freeze({ kind: 'static-point', id }); tokens.set(token, { owner, id }); return token; },
      release(owner) {
        clients.delete(owner);
        if (clients.size) return;
        for (const { type, previous, action } of actions) isolate(() => {
          if (!alive() || handler.getInputAction(type) !== action) return;
          if (previous) handler.setInputAction(previous, type); else handler.removeInputAction?.(type);
        });
        bridges.delete(viewer);
      },
    };
    bridges.set(viewer, bridge);
  }
  return bridge;
}

let sequence = 0;
/** Constant points avoid per-record Entity/PropertyBag/visualizer work. Hidden attachment is not GPU preparation. */
export function createStagedPointEdition({ viewer, name }) {
  if (!viewer?.scene?.primitives?.add || typeof name !== 'string' || !name || name.length > 96)
    throw new TypeError('A point edition needs one viewer and name');
  const key = `point-edition:${++sequence}:${name}`, bridge = acquireBridge(viewer);
  let current = null, visible = false, destroyed = false, generation = 0, metrics = null;
  const pending = new Map();
  const dispose = collection => {
    if (!collection) return 0;
    return isolate(() => { if (!viewer.isDestroyed?.()) viewer.scene.primitives.remove(collection); },
      () => { if (!collection.isDestroyed()) collection.destroy(); });
  };
  const discardPending = () => {
    for (const next of pending.values()) {
      next.controller.abort(); next.collection.show = false;
      // An asynchronous adapter must physically settle attachment before destruction.
      if (!next.attaching) { next.features.clear(); dispose(next.collection); }
    }
  };
  const assertCurrent = (owner, signal, isCurrent) => {
    signal?.throwIfAborted();
    if (destroyed || generation !== owner || !visible || viewer.isDestroyed?.() || isCurrent && !isCurrent()) throw abort();
  };
  const owner = {
    resolve(token, id) {
      return !destroyed && visible && !viewer.isDestroyed?.() && current?.tokens.get(id) === token ? current.features.get(id) : null;
    },
  };
  bridge.register(owner);
  const clearSelection = () => isolate(...['selectedEntity', 'trackedEntity'].map(property => () => {
    if (bridge.metadata(viewer[property])?.owner === owner) viewer[property] = undefined;
  }));
  const refreshSelection = next => {
    let errors = 0; const updated = new Set();
    for (const property of ['selectedEntity', 'trackedEntity']) {
      const entity = viewer[property], metadata = bridge.metadata(entity);
      if (metadata?.owner !== owner) continue;
      const feature = next.features.get(metadata.id);
      if (!feature) { errors += isolate(() => { viewer[property] = undefined; }); continue; }
      if (updated.has(entity)) continue; updated.add(entity);
      // Current source metadata is committed before selected-detail observers inspect it.
      // Updating the projection itself does not reopen a closed panel or steal focus.
      errors += isolate(() => { entity.properties = feature.properties; }, () => { entity.name = feature.name; },
        () => { entity.position = feature.position; });
    }
    return errors;
  };
  return {
    get source() { return current?.collection || null; },
    get collection() { return current?.collection || null; },
    get count() { return current?.features.size || 0; },
    getFeature: id => current?.features.get(id) || null,
    getMetrics: () => metrics && { ...metrics },
    setVisible(value) {
      if (destroyed) return;
      visible = Boolean(value);
      if (!visible) { ++generation; discardPending(); clearSelection(); }
      if (current) current.collection.show = visible;
      viewer.scene.requestRender?.();
    },
    clear() {
      if (destroyed) return;
      ++generation; discardPending(); clearSelection();
      const previous = current; current = null; metrics = null;
      if (previous) { previous.features.clear(); previous.tokens.clear(); dispose(previous.collection); }
      viewer.scene.requestRender?.();
    },
    async stage(records, project, { signal, work: suppliedWork, isCurrent, commit = () => {} } = {}) {
      if (destroyed) throw abort();
      const revision = ++generation; discardPending();
      const controller = new AbortController(), combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const valid = () => !destroyed && generation === revision && visible && !viewer.isDestroyed?.() && (!isCurrent || isCurrent());
      const work = suppliedWork || sceneWorkFor(viewer).scope({ key, signal: combined, isCurrent: valid });
      const next = { collection: new Cesium.PointPrimitiveCollection(), features: new Map(), tokens: new Map(), controller, attaching: false };
      next.collection.show = false; pending.set(revision, next);
      let promoted = false, outcome = 'error', preparationMs = 0, attachmentMs = 0, commitMs = 0, observerErrors = 0;
      try {
        assertCurrent(revision, combined, isCurrent); work.assertCurrent();
        const started = now();
        await work.prepare(records, record => {
          assertCurrent(revision, combined, isCurrent);
          const value = project(record);
          if (value && typeof value.then === 'function') { void Promise.resolve(value).catch(() => {}); throw new TypeError('Point projection must be synchronous'); }
          if (value == null) return;
          const feature = featureSpec(value);
          if (next.features.has(feature.id)) throw new TypeError('A complete point edition requires unique IDs');
          const token = bridge.token(owner, feature.id);
          next.features.set(feature.id, feature); next.tokens.set(feature.id, token);
          next.collection.add({ ...feature.point, position: feature.position, id: token });
        });
        preparationMs = now() - started;
        assertCurrent(revision, combined, isCurrent); work.assertCurrent();
        next.attaching = true; const attachmentAt = now();
        await viewer.scene.primitives.add(next.collection);
        attachmentMs = now() - attachmentAt; next.attaching = false;
        assertCurrent(revision, combined, isCurrent); work.assertCurrent();
        const commitAt = now();
        work.publish(() => {
          assertCurrent(revision, combined, isCurrent);
          commit(Object.freeze({ count: next.features.size }));
          assertCurrent(revision, combined, isCurrent);
          const previous = current; current = next; promoted = true;
          observerErrors += isolate(() => { next.collection.show = visible; }, () => { if (previous) previous.collection.show = false; });
          observerErrors += refreshSelection(next);
          if (previous) { previous.features.clear(); previous.tokens.clear(); observerErrors += dispose(previous.collection); }
          observerErrors += isolate(() => viewer.scene.requestRender?.());
        });
        commitMs = now() - commitAt;
        metrics = { count: next.features.size, preparationMs, attachmentMs, commitMs, observerErrors };
        outcome = 'complete'; return true;
      } catch (failure) { outcome = failure?.name === 'AbortError' ? 'cancelled' : 'error'; throw failure; }
      finally {
        pending.delete(revision);
        if (!promoted) { next.features.clear(); next.tokens.clear(); dispose(next.collection); }
        if (!suppliedWork) work.finish(outcome);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; visible = false; ++generation; discardPending(); clearSelection();
      const previous = current; current = null; metrics = null;
      if (previous) { previous.features.clear(); previous.tokens.clear(); dispose(previous.collection); }
      bridge.release(owner);
    },
  };
}
