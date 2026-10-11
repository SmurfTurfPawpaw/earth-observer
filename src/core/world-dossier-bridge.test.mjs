import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorldDossierBridge, matchingWorldEvent } from './world-dossier-bridge.js';
import { worldHash } from './world-model.js';

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
