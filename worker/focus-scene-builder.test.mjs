import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFocusScene, diffFocusScenes, focusClusterMembers } from './focus-scene-builder.js';
import { buildPreparedScene } from './prepared-scene-builder.js';
import { buildPreparedUsgsScene } from './prepared-usgs-scene.js';
import { decodeUsgsLiveDay, usgsLiveDayOverview, USGS_LIVE_DAY } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest, pluginJson } from '../src/core/plugin-evidence.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { createWorldSourceItem } from '../src/core/world-model.js';
import { worldHash } from '../src/core/world-identity.js';
import { FOCUS_SCENE_POLICY, FOCUS_SCENE_LIMITS, focusCellAt, focusFeatureMatches, applyFocusSceneDelta } from '../src/core/focus-scene-contract.js';
const CLOCK = Date.parse('2026-10-12T09:00:00.000Z'), AT = new Date(CLOCK).toISOString(), now = () => CLOCK;
const select = (leaves, budget = 6, focus = leaves[0]) => ({ schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves, focus, featureBudget: budget });
const roots = Array.from({ length: 32 }, (_, i) => [0, i % 8, Math.floor(i / 8)]);
async function usgs(points, { mag = 3, fence = 1, title = 'TEST ONLY', updated = CLOCK - 600000 } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { generated: CLOCK - 1000, count: points.length, status: 200, url: USGS_LIVE_DAY.sourceUrl },
    features: points.map(([lon, lat], i) => ({ type: 'Feature', id: `us-focus-${i}`, geometry: { type: 'Point', coordinates: [lon, lat, 12] },
      properties: { mag, place: 'TEST ONLY', title, time: CLOCK - 600000, updated, type: 'earthquake', status: 'reviewed' } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now }), overview = usgsLiveDayOverview(decoded), receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence,
    factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview),
    capturedAt: AT, recordedAt: AT, sourceUpdatedAt: decoded.sourceGeneratedAt };
  const old = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId }, scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: points.length } });
  return buildPreparedScene('earthquakes', { available: true, prepared: old }, { now });
}

test('500 dense rows yield compact pins plus exact residual membership rather than full-record detail or silent truncation', async () => {
  const prepared = await usgs(Array.from({ length: 500 }, (_, i) => [4 + i * 0.00000001, 50]), { title: null });
  const local = select([focusCellAt({ lon: 4, lat: 50 }, 18)]), view = await selectFocusScene(prepared, local, { now });
  assert.equal(view.counts.sourceTotal, 500); assert.equal(view.counts.selectedMapped, 500); assert.equal(view.features.length, 6);
  assert.equal(view.counts.clusteredReports, 494); assert.equal(view.counts.outsideMapped, 0);
  const members = focusClusterMembers(prepared, view, view.clusters[0].id); assert.equal(members.length, 494);
  const shown = new Set(view.features.map(feature => feature.id)); assert.ok(members.every(member => !shown.has(member.id) && member.role === 'member'));
  assert.ok(view.features.every(feature => focusFeatureMatches('earthquakes', feature, prepared.content.features.find(full => full.id === feature.id))));
  assert.ok(view.features.every(feature => !Object.hasOwn(feature, 'record') && !Object.hasOwn(feature, 'provenance')));
  const long = await usgs([[4, 50]], { title: '🌍'.repeat(100) });
  const excerpt = (await selectFocusScene(long, local, { now })).features[0];
  assert.equal(excerpt.titleTruncated, true); assert.equal(new TextEncoder().encode(excerpt.title).length, 256);
  const viewBytes = new TextEncoder().encode(pluginJson(view)).length; assert.ok(viewBytes < FOCUS_SCENE_LIMITS.viewBytes);
  console.log(JSON.stringify({ fixture: '500 dense source reports', viewBytes, pins: view.features.length, residual: view.counts.clusteredReports }));
});

test('coincident reports/pole/dateline aliases do not become overlapping pins or fabricated offsets; every residual remains accessible', async () => {
  const prepared = await usgs(Array.from({ length: 50 }, () => [4, 50]), { mag: 6 });
  const view = await selectFocusScene(prepared, select([focusCellAt({ lon: 4, lat: 50 }, 18)]), { now });
  assert.equal(view.features.length, 1); assert.equal(view.counts.clusteredReports, 49); assert.equal(view.counts.highlights, 1);
  assert.deepEqual(view.features[0].geometry, { lon: 4, lat: 50, positionMeaning: 'source-reported-seismic-location' });
  assert.equal(focusClusterMembers(prepared, view, view.clusters[0].id).length, 49);
  const polar = await usgs([[-180, 90], [180, 90], [179, 90], [-179, 90]], { mag: 6 });
  const world = await selectFocusScene(polar, select(roots), { now });
  assert.equal(world.features.length, 1); assert.equal(world.counts.clusteredReports, 3); assert.equal(world.counts.selectedMapped, 4);
});

test('maximum128 disjoint fine leaves retain500 spread reports with bounded pins/residual counts and full-source revisions', async () => {
  const anchors = Array.from({ length: 128 }, (_, i) => [i - 64, 50]), points = Array.from({ length: 500 }, (_, i) => anchors[i % anchors.length]);
  const prepared = await usgs(points, { mag: 6, title: null });
  const leaves = anchors.map(([lon, lat]) => focusCellAt({ lon, lat }, 7)).sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  const view = await selectFocusScene(prepared, select(leaves), { now }), bytes = new TextEncoder().encode(pluginJson(view)).length;
  assert.equal(view.selection.leaves.length, 128); assert.equal(view.counts.selectedMapped, 500); assert.equal(view.counts.outsideMapped, 0);
  assert.ok(view.features.length <= 64); assert.equal(view.counts.clusteredReports + view.features.length, 500);
  assert.equal(new Set(view.features.map(feature => feature.id)).size, view.features.length);
  for (const cluster of view.clusters) assert.equal(focusClusterMembers(prepared, view, cluster.id).length, cluster.count);
  assert.ok(bytes <= FOCUS_SCENE_LIMITS.viewBytes);
  console.log(JSON.stringify({ fixture: '500 spread reports/128 fine leaves', viewBytes: bytes, pins: view.features.length, clusters: view.clusters.length,
    residual: view.counts.clusteredReports }));
});

test('highlight/focus/singleton detail budgets share one counted partition and interest expiry never alters source revisions/dates', async () => {
  const points = Array.from({ length: 80 }, (_, i) => [4 + i * 0.0004, 50]);
  const prepared = await usgs(points, { mag: 6 }), leaves = [...new Map(points.map(([lon, lat]) => { const leaf = focusCellAt({ lon, lat }, 7); return [leaf.join(':'), leaf]; })).values()];
  // Independently located residual cells are the only eligible singleton details.
  const all = await usgs(Array.from({ length: 80 }, (_, i) => [-40 + i * 0.5, 50]), { mag: 6 });
  const detailedLeaves = [...new Map(all.content.features.map(f => { const leaf = focusCellAt(f.geometry, 7); return [leaf.join(':'), leaf]; })).values()].sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  const view = await selectFocusScene(all, select(detailedLeaves), { now });
  assert.equal(view.counts.highlights, 16); assert.ok(view.counts.focusFeatures <= 6); assert.equal(view.counts.details, 42);
  assert.ok(view.features.length <= 64); assert.equal(view.counts.selectedMapped, 80);
  assert.equal(view.features.length + view.clusters.reduce((sum, group) => sum + group.count, 0), 80);
  const byId = new Map(all.content.features.map(feature => [feature.id, feature]));
  assert.ok(view.features.every(feature => feature.revision === byId.get(feature.id).revision));
  const later = await selectFocusScene(all, select(detailedLeaves), { now: () => CLOCK + 3600000 });
  assert.equal(later.counts.highlights, 0); assert.deepEqual(later.source, view.source); assert.notEqual(later.version, view.version);
  const applied = applyFocusSceneDelta(view, diffFocusScenes(view, later), { now: () => CLOCK + 3600000 });
  assert.deepEqual(applied.features, later.features); assert.deepEqual(applied.counts, later.counts);
  const coarse = await selectFocusScene(prepared, select(roots, 0), { now: () => CLOCK + 3600000 });
  assert.equal(coarse.features.length, 0); assert.equal(coarse.counts.clusteredReports, 80); assert.equal(leaves.length, 1);
});

test('GDACS unlocated metadata and source assessments retain their own cohort clocks without made-up geography or reach', async () => {
  const records = [0, 1].map(i => canonicalDiscoveryRecord({ id: `gdacs:FL:${1000 + i}:1`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report', category: 'disasters',
    title: 'TEST ONLY flood', eventType: 'FL', alertLevel: 'Red', url: `https://www.gdacs.org/report.aspx?eventid=${1000 + i}&episodeid=1&eventtype=FL`,
    ...(i ? {} : { lon: 4, lat: 50 }), observedAt: AT, updatedAt: AT, retrievedAt: AT }));
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] }, snapshotId = await worldHash({ ...body, records: records.map(({ retrievedAt, ...r }) => r) });
  const items = await Promise.all(records.map(async record => ({ ...await createWorldSourceItem(record, { snapshotId, capturedAt: AT, recordedAt: AT }),
    origin: { snapshotId, firstCapturedAt: AT, firstRecordedAt: AT, validation: 'retained-revision-index-only', bodyValidated: false } })));
  const input = { schemaVersion: 1, kind: 'source-item-cohort', configured: true, available: true, mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' }, version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: AT }),
    readAt: AT, cohort: { sourceId: 'gdacs', snapshotId, capturedAt: AT, publishedAt: AT, bodySha256: await worldHash(body), recordCount: 2 }, items,
    counts: { returned: 2, mapped: 1, unmapped: 1 }, coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100,
      completeRetainedCohort: true, completeProviderArchive: false }, operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
  const prepared = await buildPreparedScene('gdacs', input, { now }), view = await selectFocusScene(prepared, select(roots, 0), { now });
  assert.equal(view.counts.mappedTotal, 1); assert.equal(view.counts.unmappedTotal, 1); assert.equal(view.unmappedFeatures[0].geometry, null);
  assert.equal(view.features[0].sourceAssessment.level, 'Red'); assert.equal(view.features[0].sourceAssessment.reach, 'unresolved');
  assert.equal(Object.hasOwn(view.source, 'fence'), false); assert.deepEqual(view.source, prepared.source);
  assert.ok(focusFeatureMatches('gdacs', view.features[0], prepared.content.features.find(f => f.id === view.features[0].id)));
  const controller = new AbortController(); controller.abort(); await assert.rejects(selectFocusScene(prepared, select(roots), { now, signal: controller.signal }));
});
