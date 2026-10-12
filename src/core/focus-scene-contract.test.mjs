import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_SCENE_POLICY, FOCUS_SCENE_GRIDS, focusSceneSelection, focusLeafBounds, focusCellAt,
  validateFocusFeature, focusFeatureMatches, validateFocusRegionalScene, applyFocusSceneDelta } from './focus-scene-contract.js';
import { decodeUsgsLiveDay, USGS_LIVE_DAY } from './usgs-live-day.js';
import { pluginFactsDigest } from './plugin-evidence.js';
import { selectFocusScene, diffFocusScenes } from '../../worker/focus-scene-builder.js';
const CLOCK = Date.parse('2026-10-12T09:00:00.000Z'), AT = new Date(CLOCK).toISOString(), now = () => CLOCK;
const selection = (leaves, focus = leaves[0], featureBudget = 6) => ({ schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves, focus, featureBudget });

test('mixed leaves reject overlaps/duplicates/noncanonical order and all-four refinement preserves the parent footprint', () => {
  const parent = [0, 4, 0], children = [[1, 8, 0], [1, 9, 0], [1, 8, 1], [1, 9, 1]];
  const result = focusSceneSelection(selection(children)); assert.ok(Object.isFrozen(result.leaves[0]));
  const bounds = focusLeafBounds(parent), childBounds = children.map(focusLeafBounds);
  const area = value => (value.east - value.west) * (value.north - value.south);
  assert.equal(childBounds.reduce((sum, value) => sum + area(value), 0), area(bounds));
  assert.deepEqual({ west: Math.min(...childBounds.map(v => v.west)), east: Math.max(...childBounds.map(v => v.east)),
    south: Math.min(...childBounds.map(v => v.south)), north: Math.max(...childBounds.map(v => v.north)) }, bounds);
  for (const leaves of [[parent, ...children], [children[0], children[0]], [...children].reverse(), [[19, 0, 0]], [[18, 2097152, 0]]])
    assert.throws(() => focusSceneSelection(selection(leaves)));
  assert.throws(() => focusSceneSelection(selection(children, parent)));
  assert.equal(FOCUS_SCENE_GRIDS[18][0], 2097152);
  assert.ok((focusLeafBounds([18, 0, 0]).east + 180) < 0.0002);
});

test('dateline and poles are admitted without a giant grid or dropping boundary points', () => {
  assert.deepEqual(focusCellAt({ lon: 180, lat: 90 }, 0), [0, 0, 0]);
  assert.deepEqual(focusCellAt({ lon: -180, lat: 90 }, 0), [0, 0, 0]);
  assert.deepEqual(focusCellAt({ lon: 179.999999, lat: -90 }, 18), [18, 2097151, 1048575]);
  const roots = Array.from({ length: 32 }, (_, i) => [0, i % 8, Math.floor(i / 8)]);
  const frozen = focusSceneSelection(selection(roots, roots[0], 0));
  assert.equal(frozen.leaves.length, 32); assert.equal(frozen.featureBudget, 0);
});

test('compact pin correlation requires exact retained facts, while a title remains a declared excerpt', async () => {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { generated: CLOCK, count: 1, status: 200, url: USGS_LIVE_DAY.sourceUrl },
    features: [{ type: 'Feature', id: 'test-proof', geometry: { type: 'Point', coordinates: [4, 50, 12] },
      properties: { mag: 3, time: CLOCK - 1000, updated: CLOCK, type: 'earthquake', title: 'A long source title', place: 'TEST ONLY' } }] }));
  const record = decodeUsgsLiveDay(raw, { now }).canonicalFacts.records[0], full = { id: `earthquake:${record.stableId}`, sourceRecordId: record.usgsId,
    revision: await pluginFactsDigest(record), record, geometry: { lon: record.lon, lat: record.lat, positionMeaning: 'source-reported-seismic-location' },
    category: 'seismic', symbol: 'seismic', provenance: null, sourceAssessment: null };
  const source = { pluginId: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId, receiptId: `receipt:${'1'.repeat(64)}`, fence: 1,
    factsDigest: '2'.repeat(64), rawSha256: '3'.repeat(64), artifactSha256: '4'.repeat(64), capturedAt: AT, recordedAt: AT, sourceGeneratedAt: AT, knowledgeMeaning: 'Test receipt' };
  const prepared = { kind: 'prepared-source-scene', sourceKey: 'earthquakes', source, content: { features: [full] },
    version: `prepared:${'5'.repeat(64)}`, contentDigest: '6'.repeat(64) };
  const view = await selectFocusScene(prepared, selection([[0, 4, 0]]), { now }), compact = view.features[0];
  assert.ok(focusFeatureMatches('earthquakes', compact, full));
  for (const [key, value] of [['sourceType', 'explosion'], ['magnitude', 4], ['depthKm', 0], ['observedAt', AT], ['updatedAt', null]])
    assert.equal(focusFeatureMatches('earthquakes', { ...compact, display: { ...compact.display, [key]: value } }, full), false, key);
  assert.equal(focusFeatureMatches('earthquakes', { ...compact, title: 'A short excerpt', titleTruncated: true }, full), true);
  assert.equal(focusFeatureMatches('earthquakes', { ...compact, geometry: { ...compact.geometry, lon: 5 } }, full), false);
  assert.throws(() => validateFocusFeature('earthquakes', { ...compact, title: '🌍'.repeat(65) }));
  assert.throws(() => validateFocusFeature('earthquakes', { ...compact, geometry: null }));
  const invalid = structuredClone(view); invalid.features[0].role = 'member';
  assert.throws(() => validateFocusRegionalScene(invalid, { now }));
  const falseDetail = structuredClone(view); falseDetail.features[0].role = 'detail'; falseDetail.counts.focusFeatures = 0; falseDetail.counts.details = 1;
  assert.throws(() => validateFocusRegionalScene(falseDetail, { now }));
  const falseHighlight = structuredClone(view); falseHighlight.features[0].role = 'highlight'; falseHighlight.counts.focusFeatures = 0; falseHighlight.counts.highlights = 1;
  assert.throws(() => validateFocusRegionalScene(falseHighlight, { now }));
  const same = diffFocusScenes(view, view); assert.equal(applyFocusSceneDelta(view, same, { now }).version, view.version);
  assert.throws(() => applyFocusSceneDelta(view, { ...same, upsertFeatures: [{ ...compact, title: 'Changed under same edition' }] }, { now }));
  assert.throws(() => applyFocusSceneDelta(view, { ...same, baseVersion: `view:${'0'.repeat(64)}` }, { now }));
});
