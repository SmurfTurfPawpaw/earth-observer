import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorldDossierBridge, matchingWorldEvent } from './world-dossier-bridge.js';
import { worldHash } from './world-model.js';
import { WORLD_SCENE_SCOPE } from './world-scene-controller.js';

const at = '2026-10-11T10:00:00.000Z';
const selection = { usgsId: 'us7000test', mag: 5.1, time: Date.parse(at), lat: 10, lon: 20 };
const id = `event:usgs:${await worldHash(['usgs', 'usgs:us7000test'])}`;
const event = { schemaVersion: 1, id, kind: 'earthquake', source: { id: 'usgs' },
  evidence: { sourceRecordId: 'usgs:us7000test', revision: 'a'.repeat(64), snapshotId: 'b'.repeat(64) },
  eventTime: { at }, reportedFacts: { magnitude: 5.1 }, place: { lat: 10, lon: 20 },
  knowledge: { firstRecordedAt: at }, capture: { publishedAt: at } };
function fixture() {
  const values = new Map();
  const entity = { selection: { ...selection }, properties: { hasProperty: (key) => values.has(key),
    addProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) } };
  const viewer = { selectedEntity: entity, earthTime: { getState: () => ({ mode: 'history', at }) },
    selectedEntityChanged: { addEventListener: () => () => {} } };
  return { values, entity, viewer };
}
const response = () => Response.json({ schemaVersion: 1, configured: true, available: true, knownAt: at, event });

test('the same source identity cannot substitute revised facts or evidence published after the cutoff', () => {
  assert.equal(matchingWorldEvent(event, selection, { id, knownAt: at }), event);
  assert.equal(matchingWorldEvent(event, { ...selection, mag: 5.2 }, { id, knownAt: at }), null);
  assert.equal(matchingWorldEvent({ ...event, place: { lat: 11, lon: 20 } }, selection, { id, knownAt: at }), null);
  assert.equal(matchingWorldEvent({ ...event, capture: { publishedAt: '2026-10-11T10:00:00.001Z' } }, selection, { id, knownAt: at }), null);
});
test('provided scientific update, review and event type bind retained proof while legacy missing fields remain admissible', () => {
  const current = { ...selection, updatedAt: Date.parse(at) - 1000, reviewStatus: 'reviewed', eventType: 'earthquake' };
  const scientific = { ...event, sourceTimes: { updatedAt: new Date(current.updatedAt).toISOString() }, reportedFacts: { ...event.reportedFacts, reviewStatus: 'reviewed' } };
  assert.equal(matchingWorldEvent(scientific, current, { id, knownAt: at }), scientific);
  assert.equal(matchingWorldEvent(scientific, { ...current, updatedAt: current.updatedAt + 1 }, { id, knownAt: at }), null);
  assert.equal(matchingWorldEvent(scientific, { ...current, updatedAt: NaN }, { id, knownAt: at }), null);
  assert.equal(matchingWorldEvent(scientific, { ...current, reviewStatus: 'automatic' }, { id, knownAt: at }), null);
  assert.equal(matchingWorldEvent(scientific, { ...current, eventType: 'quarry blast' }, { id, knownAt: at }), null);
  assert.equal(matchingWorldEvent(event, selection, { id, knownAt: at }), event, 'legacy and archive projections do not invent unavailable metadata requirements');
});

test('idle construction is request free and repeated exact historical selections reuse bounded evidence', async () => {
  const { viewer, values } = fixture(); let calls = 0;
  const bridge = installWorldDossierBridge({ viewer, readSelection: (entity) => entity?.selection,
    fetchImpl: async (url) => { calls++; assert.equal(new URL(url, 'https://example.com').searchParams.get('knownAt'), at); return response(); } });
  assert.equal(calls, 0);
  assert.equal(await bridge.refresh(), true); assert.equal(values.get('_worldEvent').id, id);
  assert.equal(await bridge.refresh(), true); assert.equal(calls, 1);
  bridge.destroy(); assert.equal(values.size, 0);
});

test('a late response cannot attach evidence to a replaced selection', async () => {
  const { viewer, values } = fixture(); let release, started;
  const begun = new Promise((resolve) => { started = resolve; });
  const bridge = installWorldDossierBridge({ viewer, readSelection: (entity) => entity?.selection,
    fetchImpl: async () => { started(); return new Promise((resolve) => { release = resolve; }); } });
  const pending = bridge.refresh(); await begun;
  viewer.selectedEntity = undefined; await bridge.refresh(); release(response());
  assert.equal(await pending, false); assert.equal(values.size, 0); bridge.destroy();
});

test('same-entity corrections fence both late transport and body completion, then admit only the new current facts', async () => {
  for (const phase of ['transport', 'body']) {
    const f = fixture(); let release, started, count = 0;
    const begun = new Promise(resolve => { started = resolve; });
    const corrected = { ...selection, mag: 5.2, lat: 11 }, correctedEvent = { ...event, reportedFacts: { magnitude: 5.2 }, place: { lat: 11, lon: 20 },
      evidence: { ...event.evidence, revision: 'c'.repeat(64) } };
    const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: entity => entity?.selection, fetchImpl: async () => {
      if (++count > 1) return Response.json({ schemaVersion: 1, configured: true, available: true, knownAt: at, event: correctedEvent });
      if (phase === 'transport') { started(); return new Promise(resolve => { release = () => resolve(response()); }); }
      const text = JSON.stringify({ schemaVersion: 1, configured: true, available: true, knownAt: at, event });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(text.slice(0, 40)));
        release = () => { controller.enqueue(new TextEncoder().encode(text.slice(40))); controller.close(); }; started();
      } }), { headers: { 'content-type': 'application/json' } });
    } });
    const pending = bridge.refresh(); await begun;
    // Mutate the captured object itself, just as a property bag can change while
    // the picked Cesium entity survives. A reference equality guard is insufficient.
    Object.assign(f.entity.selection, corrected); release();
    assert.equal(await pending, false); assert.equal(f.values.has('_worldEvent'), false);
    assert.equal(await bridge.refresh(), true); assert.equal(f.values.get('_worldEvent').reportedFacts.magnitude, 5.2);
    assert.equal(count, 2); bridge.destroy();
  }
});

test('a corrected same-identity selection bypasses old cached proof; proof changes and live clock ticks create no feedback acquisition', async () => {
  const f = fixture(); let count = 0;
  f.viewer.earthTime.getState = () => ({ mode: 'live', at: new Date(Date.parse(at) + count * 1000).toISOString() });
  const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: entity => entity?.selection, fetchImpl: async () => {
    count++; const facts = count === 1 ? event : { ...event, reportedFacts: { magnitude: 5.2 } };
    return Response.json({ schemaVersion: 1, configured: true, available: true, event: facts });
  } });
  assert.equal(await bridge.refresh(), true); f.entity.selection._worldEvent = f.values.get('_worldEvent');
  assert.equal(await bridge.refresh(), true); assert.equal(count, 1, 'proof itself and ticking current UTC do not invalidate unchanged source facts');
  f.entity.selection.mag = 5.2;
  assert.equal(await bridge.refresh(), true); assert.equal(count, 2); assert.equal(f.values.get('_worldEvent').reportedFacts.magnitude, 5.2); bridge.destroy();
});

test('a retained source-context report stays fixed across globe history and live collection updates without a scene pin', async () => {
  const f = fixture(); let update;
  f.entity.selection = { ...selection, _worldEvent: event,
    _worldReport: { schemaVersion: 1, kind: 'retained-source-context', revision: event.evidence.revision } };
  f.values.set('_worldEvent', event);
  f.viewer.earthTime.getState = () => ({ mode: 'history', at: '2025-10-08T00:00:00.000Z' });
  const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: entity => entity?.selection,
    fetchImpl() { throw new Error('A context report already has its fixed retained projection'); }, subscribeUpdates(listener) { update = listener; } });
  assert.equal(await bridge.refresh(), true); assert.equal(f.values.get('_worldEvent'), event);
  f.viewer.earthTime.getState = () => ({ mode: 'live', at }); update({ type: 'collection' });
  assert.equal(await bridge.refresh(), true); assert.equal(f.values.get('_worldEvent'), event); bridge.destroy();
});

test('a rejected source-context revision is removed rather than remaining renderable in the dossier', async () => {
  const f = fixture();
  f.entity.selection = { ...selection, _worldEvent: event,
    _worldReport: { schemaVersion: 1, kind: 'retained-source-context', revision: 'd'.repeat(64) } };
  f.values.set('_worldEvent', event);
  const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: entity => entity?.selection,
    fetchImpl() { throw new Error('Rejected source context cannot acquire another projection'); } });
  assert.equal(await bridge.refresh(), false); assert.equal(f.values.has('_worldEvent'), false); bridge.destroy();
});

const historicalAt = '2025-06-01T12:00:00.000Z', retainedAt = '2026-10-12T02:00:00.000Z';
function archiveFixture(mode = 'reconstruction') {
  const f = fixture();
  const context = { schemaVersion: 1, scopeId: WORLD_SCENE_SCOPE, window: '7d', mode, knownMode: mode === 'as-known' ? 'scene' : 'none', version: 'archive:1',
    revision: event.evidence.revision, sourceRecordId: event.evidence.sourceRecordId, eventId: id };
  f.entity.selection = { ...selection, time: Date.parse(historicalAt), _worldScene: context };
  f.viewer.earthTime.getState = () => ({ mode: 'history', at: historicalAt });
  const archived = { ...event, eventTime: { at: historicalAt }, knowledge: { firstRecordedAt: retainedAt }, capture: undefined,
    archive: { scopeId: WORLD_SCENE_SCOPE, chunkId: 'c'.repeat(64), publishedAt: retainedAt, capturedAt: retainedAt } };
  return { ...f, context, archived };
}

test('Reconstruction can cite an older event retained today through the scoped scene route and exact revision', async () => {
  const f = archiveFixture(); let calls = 0;
  const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: (entity) => entity?.selection, fetchImpl: async (url) => {
    calls++; const request = new URL(url, 'https://example.test');
    assert.equal(request.pathname, `/api/world/scene/events/${id}`); assert.equal(request.searchParams.get('at'), historicalAt);
    assert.equal(request.searchParams.get('revision'), event.evidence.revision); assert.equal(request.searchParams.has('knownAt'), false); assert.equal(request.searchParams.has('knownMode'), false);
    return Response.json({ schemaVersion: 1, configured: true, available: true, scope: { id: WORLD_SCENE_SCOPE }, at: historicalAt, mode: 'reconstruction', knownMode: 'none', version: 'archive:1', event: f.archived });
  } });
  assert.equal(await bridge.refresh(), true); assert.equal(f.values.get('_worldEvent').knowledge.firstRecordedAt, retainedAt); assert.equal(calls, 1); bridge.destroy();
});

test('already admitted full archive projections bypass recent live membership and preserve their original dates', async () => {
  const f = archiveFixture(); f.entity.selection._worldEvent = f.archived; f.values.set('_worldEvent', f.archived);
  const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: (entity) => entity?.selection, fetchImpl() { throw new Error('The scene already supplied this projection'); } });
  assert.equal(await bridge.refresh(), true); assert.equal(f.values.get('_worldEvent'), f.archived); bridge.destroy();
});

test('a Known then archive selection cannot use later retained evidence, and Reconstruction cannot silently replace its point revision', async () => {
  for (const knownThen of [true, false]) {
    const f = archiveFixture(knownThen ? 'as-known' : 'reconstruction');
    const bridge = installWorldDossierBridge({ viewer: f.viewer, readSelection: (entity) => entity?.selection, fetchImpl: async () => Response.json({
      schemaVersion: 1, configured: true, available: true, scope: { id: WORLD_SCENE_SCOPE }, at: historicalAt,
      knownAt: knownThen ? historicalAt : null, knownMode: knownThen ? 'scene' : 'none', mode: f.context.mode, version: 'archive:1',
      event: knownThen ? f.archived : { ...f.archived, evidence: { ...f.archived.evidence, revision: 'd'.repeat(64) } } }) });
    assert.equal(await bridge.refresh(), false); assert.equal(f.values.has('_worldEvent'), false); bridge.destroy();
  }
});
