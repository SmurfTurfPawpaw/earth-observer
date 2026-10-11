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
  const entity = { selection, properties: { hasProperty: (key) => values.has(key),
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
