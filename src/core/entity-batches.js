import * as Cesium from 'cesium';
import { sceneWorkFor } from './scene-work.js';

const legacyOwner = {};
/** Compatibility assembly uses the same cooperative pump, without a scene commit. */
export async function stageEntities(records, createEntity, signal, suppliedWork) {
  const work = suppliedWork || sceneWorkFor(legacyOwner).scope({ key: 'legacy-entity-assembly', signal });
  let outcome = 'error';
  try {
    const entities = await work.prepare(records, createEntity);
    work.assertCurrent(); outcome = 'complete'; return entities;
  } catch (failure) {
    outcome = failure?.name === 'AbortError' ? 'cancelled' : 'error'; throw failure;
  } finally { if (!suppliedWork) work.finish(outcome); }
}

/** Legacy synchronous replacement; this does not bound visualizer/GPU work. */
export function replaceEntities(collection, entities) {
  collection.suspendEvents();
  try {
    collection.removeAll();
    for (const entity of entities) collection.add(entity);
  } finally { collection.resumeEvents(); }
}

let editionId = 0;
const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
const isolateObservers = (...operations) => {
  let errors = 0;
  for (const operation of operations) { try { operation(); } catch { ++errors; } }
  return errors;
};

/** Keep the last complete cohort visible while a hidden replacement is assembled. */
export function createStagedEntityEdition({ viewer, name }) {
  const key = `entity-edition:${name}:${++editionId}`;
  let current = new Cesium.CustomDataSource(name), visible = false, destroyed = false, generation = 0, metrics = null;
  current.show = false;
  const pending = new Map();
  const remove = source => {
    if (!source || viewer.isDestroyed?.()) return;
    viewer.dataSources.remove(source, true);
  };
  const discardPending = () => {
    for (const [source, controller] of pending) {
      controller.abort(); isolateObservers(() => remove(source), () => source.entities.removeAll());
    }
  };
  const initial = current;
  const attached = Promise.resolve(viewer.dataSources.add(initial)).then(() => {
    if (destroyed) isolateObservers(() => remove(initial));
  });
  // init remains synchronous; stage awaits attachment and surfaces a failure.
  attached.catch(() => {});
  const owns = (source, entity) => entity && source.entities.getById(entity.id) === entity;
  const remap = (property, previous, next) => {
    if (owns(previous, viewer[property])) viewer[property] = next?.entities.getById(viewer[property].id);
  };
  const assertCurrent = (owner, signal, isCurrent) => {
    signal?.throwIfAborted();
    if (destroyed || generation !== owner || !visible || viewer.isDestroyed?.() || isCurrent && !isCurrent())
      throw new DOMException('Entity edition superseded', 'AbortError');
  };
  return {
    get source() { return current; },
    getMetrics: () => metrics && { ...metrics },
    setVisible(value) {
      visible = Boolean(value) && !destroyed;
      if (!visible) { ++generation; discardPending(); }
      if (current) isolateObservers(() => { current.show = visible; });
      if (!visible && current) isolateObservers(() => remap('selectedEntity', current, null), () => remap('trackedEntity', current, null));
    },
    clear() {
      ++generation;
      discardPending();
      if (!current) return;
      isolateObservers(() => remap('selectedEntity', current, null), () => remap('trackedEntity', current, null),
        () => replaceEntities(current.entities, []));
    },
    async stage(records, createEntity, { signal, work: suppliedWork, isCurrent, commit = () => {} } = {}) {
      const owner = ++generation;
      discardPending();
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const valid = () => !destroyed && generation === owner && visible && !viewer.isDestroyed?.() && (!isCurrent || isCurrent());
      const work = suppliedWork || sceneWorkFor(viewer).scope({ key, signal: combined, isCurrent: valid });
      const next = new Cesium.CustomDataSource(name); next.show = false;
      pending.set(next, controller);
      let promoted = false, preparationMs = 0, attachmentMs = 0, commitMs = 0, observerErrors = 0, outcome = 'error';
      try {
        assertCurrent(owner, combined, isCurrent); work.assertCurrent();
        await attached;
        assertCurrent(owner, combined, isCurrent); work.assertCurrent();
        const started = monotonicNow();
        // Construction and insertion both happen off-scene through one shared budget.
        next.entities.suspendEvents();
        try {
          await work.prepare(records, record => {
            assertCurrent(owner, combined, isCurrent);
            const entity = createEntity(record);
            if (entity && typeof entity.then === 'function') {
              void Promise.resolve(entity).catch(() => {});
              throw new TypeError('Entity edition mapping must be synchronous');
            }
            if (entity != null) next.entities.add(entity);
          });
        } finally { next.entities.resumeEvents(); }
        preparationMs = monotonicNow() - started;
        assertCurrent(owner, combined, isCurrent); work.assertCurrent();
        const attachStarted = monotonicNow();
        await viewer.dataSources.add(next);
        attachmentMs = monotonicNow() - attachStarted;
        assertCurrent(owner, combined, isCurrent); work.assertCurrent();
        const commitStarted = monotonicNow();
        work.publish(() => {
          assertCurrent(owner, combined, isCurrent);
          const previous = current;
          // Source metadata is promoted before selection listeners inspect the new cohort.
          commit(next);
          current = next;
          // Cesium listeners can throw after accepting a selection or removal.
          // That cannot turn a complete accepted edition into a discarded one.
          promoted = true;
          observerErrors += isolateObservers(() => { next.show = visible; }, () => { previous.show = false; },
            () => remap('selectedEntity', previous, next),
            () => remap('trackedEntity', previous, next), () => remove(previous));
          viewer.scene?.requestRender?.();
        });
        commitMs = monotonicNow() - commitStarted;
        // Wall preparation includes queue waits. Attachment/commit do not prove GPU completion.
        metrics = { count: next.entities.values.length, preparationMs, attachmentMs, commitMs, observerErrors };
        outcome = 'complete';
        return true;
      } catch (failure) {
        outcome = failure?.name === 'AbortError' ? 'cancelled' : 'error'; throw failure;
      } finally {
        pending.delete(next);
        if (!promoted) isolateObservers(() => remove(next), () => next.entities.removeAll());
        if (!suppliedWork) work.finish(outcome);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; visible = false; ++generation;
      discardPending();
      isolateObservers(() => remap('selectedEntity', current, null), () => remap('trackedEntity', current, null), () => remove(current));
      current = null; metrics = null;
    },
  };
}
