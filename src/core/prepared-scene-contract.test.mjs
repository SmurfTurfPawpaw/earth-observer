import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedSceneSelection, preparedSceneSource, comparePreparedSceneSources, PREPARED_SCENE_SOURCES } from './prepared-scene-contract.js';
const AT = '2026-10-12T09:00:00.000Z', now = () => Date.parse(AT), H = 'a'.repeat(64);
const source = { pluginId: PREPARED_SCENE_SOURCES.earthquakes.scopeId, scopeId: PREPARED_SCENE_SOURCES.earthquakes.scopeId,
  receiptId: `receipt:${H}`, fence: 1, factsDigest: H, rawSha256: H, artifactSha256: H,
  capturedAt: AT, recordedAt: AT, sourceGeneratedAt: AT, knowledgeMeaning: 'Whole cohort' };
test('closed geographic/source contract admits canonical cells and original clocks but rejects duplicates and foreign bases', () => {
  assert.deepEqual(preparedSceneSelection({ level: 2, cells: [[0, 0], [127, 0]], mode: 'features', ignoredCamera: true }),
    { level: 2, cells: [[0, 0], [127, 0]], mode: 'features' });
  for (const input of [{ level: 3, cells: [], mode: 'features' }, { level: 0, cells: [[0, 0], [0, 0]], mode: 'clusters' },
    { level: 0, cells: [[8, 0]], mode: 'clusters' }]) assert.throws(() => preparedSceneSelection(input));
  assert.equal(preparedSceneSource('earthquakes', source, { now }), source);
  assert.throws(() => preparedSceneSource('gdacs', source, { now })); assert.throws(() => preparedSceneSource('earthquakes', { ...source, inventedConfidence: 1 }, { now }));
});
test('source ordering uses actual capture fence or monotonic GDACS cohort clocks without fabricating a fence', () => {
  assert.equal(comparePreparedSceneSources('earthquakes', { ...source, fence: 2 }, source), 1);
  assert.equal(comparePreparedSceneSources('earthquakes', { ...source, factsDigest: 'b'.repeat(64) }, source), null);
  const gdacs = { sourceId: 'gdacs', scopeId: PREPARED_SCENE_SOURCES.gdacs.scopeId, version: H, snapshotId: H, bodySha256: H,
    capturedAt: AT, publishedAt: AT, knowledgeMeaning: 'Normalized cohort' };
  assert.equal(preparedSceneSource('gdacs', gdacs, { now }), gdacs); assert.equal(Object.hasOwn(gdacs, 'fence'), false);
  assert.equal(comparePreparedSceneSources('gdacs', { ...gdacs, version: 'b'.repeat(64) }, gdacs), null);
  assert.equal(comparePreparedSceneSources('gdacs', { ...gdacs, capturedAt: '2026-10-12T09:01:00.000Z', publishedAt: '2026-10-12T09:01:00.000Z' }, gdacs), 1);
});
