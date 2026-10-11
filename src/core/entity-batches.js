/** Prepare large point sets without blocking interaction; publish only a complete set. */
export async function stageEntities(records, createEntity, signal) {
  const entities = [];
  let started = performance.now();
  for (let i = 0; i < records.length; i++) {
    signal?.throwIfAborted();
    entities.push(createEntity(records[i]));
    if (i + 1 < records.length && (i + 1) % 128 === 0 && performance.now() - started >= 6) {
      if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
      else await new Promise((resolve) => setTimeout(resolve, 0));
      started = performance.now();
    }
  }
  signal?.throwIfAborted();
  return entities;
}

/** One collection notification per refresh, instead of one per added point. */
export function replaceEntities(collection, entities) {
  collection.suspendEvents();
  try {
    collection.removeAll();
    for (const entity of entities) collection.add(entity);
  } finally { collection.resumeEvents(); }
}
