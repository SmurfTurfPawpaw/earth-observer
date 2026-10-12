import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusScenesApiHandler, FOCUS_SCENES_API_PATH } from './focus-scenes-api.js';
import { selectFocusScene } from './focus-scene-builder.js';
import { buildPreparedScene } from './prepared-scene-builder.js';
import { buildPreparedUsgsScene } from './prepared-usgs-scene.js';
import { decodeUsgsLiveDay, usgsLiveDayOverview, USGS_LIVE_DAY } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest, pluginJson } from '../src/core/plugin-evidence.js';
import { FOCUS_SCENE_POLICY, focusCellAt, applyFocusSceneDelta } from '../src/core/focus-scene-contract.js';
import { documentFixture } from './document-investigation-fixture.mjs';
import { runSourcePlugin } from './plugins/store.js';
import { USGS_LIVE_DAY_PLUGIN, collectUsgsLiveDay, usgsLiveDayItems } from './plugins/usgs-live-day.js';
import { ensurePreparedScene, PREPARED_SCENES_KEYS } from './prepared-scenes-store.js';
const CLOCK = Date.parse('2026-10-12T09:00:00.000Z'), AT = new Date(CLOCK).toISOString(), now = () => CLOCK;
const region = [0, 4, 0], selection = { schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves: [region], focus: region, featureBudget: 6 };
const query = (selection, extra = {}) => FOCUS_SCENES_API_PATH + '?' + new URLSearchParams({ source: 'earthquakes', cells: selection.leaves.map(leaf => leaf.join(':')).join(','),
  focus: selection.focus.join(':'), featureBudget: String(selection.featureBudget), ...extra });
const request = url => new Request(`https://example.test${url}`);
async function fixture(mag = 3, fence = 1, total = 1) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { generated: CLOCK, count: total, status: 200, url: USGS_LIVE_DAY.sourceUrl },
    features: Array.from({ length: total }, (_, i) => ({ type: 'Feature', id: `us-focus-api-${i}`, geometry: { type: 'Point', coordinates: [4, 50, 12] },
      properties: { mag, place: 'TEST ONLY', time: CLOCK - 600000, updated: CLOCK, type: 'earthquake' } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now }), overview = usgsLiveDayOverview(decoded), receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence,
    factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw), artifactSha256: await pluginFactsDigest(overview), capturedAt: AT, recordedAt: AT, sourceUpdatedAt: decoded.sourceGeneratedAt };
  const old = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId }, scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: total } });
  const prepared = await buildPreparedScene('earthquakes', { available: true, prepared: old }, { now });
  return { schemaVersion: 1, configured: true, available: true, pending: false, sourceKey: 'earthquakes', source: prepared.source,
    prepared, prior: null, check: null, stale: null, sourceGenerationAgeMs: null };
}

test('closed source/leaf query and cancellation reject before any stored IO; public handler never offers source acquisition', async () => {
  let reads = 0; const handler = createFocusScenesApiHandler({ now, read: () => { ++reads; assert.fail('Unexpected invalid-query read'); } });
  for (const uri of [query(selection) + '&source=gdacs', query(selection, { knownAt: AT }), query(selection, { url: 'https://example.test' }),
    query(selection, { source: '__proto__' }), query(selection, { cells: '0:4:0,1:8:0' }), query(selection, { cells: '0:4:0,0:4:0' }),
    query(selection, { cells: '0:4:0,0:3:0' }), query(selection, { focus: '0:5:0' }), query(selection, { featureBudget: '7' }),
    query(selection, { source: 'gdacs', fence: '1' }), query(selection, { cluster: 'x', sourceVersion: 'x' }), query(selection, { cells: '0:4:0,'.repeat(1000) })])
    assert.equal((await handler(request(uri), {})).status, 400, uri.slice(0, 150));
  const controller = new AbortController(); controller.abort();
  assert.equal((await handler(new Request('https://example.test' + query(selection), { signal: controller.signal }), {})).status, 408);
  assert.equal((await handler(new Request('https://example.test' + query(selection), { method: 'POST' }), {})).status, 405);
  assert.equal(await handler(request('/other'), {}), null); assert.equal(reads, 0);
});

test('snapshots/current-prior deltas/fence waits preserve immutable clocks and exact bases; evicted editions recover as full snapshots', async () => {
  const a = await fixture(3, 1), b = await fixture(4, 2), c = await fixture(5, 3); let value = a, reads = 0;
  const handler = createFocusScenesApiHandler({ now, read: async (_env, source, options) => { ++reads; assert.equal(source, 'earthquakes'); assert.ok(options.signal); return value; } }), env = {};
  const initial = await (await handler(request(query(selection)), env)).json(); assert.equal(initial.transport, 'snapshot');
  value = { ...b, prior: a.prepared };
  const next = await (await handler(request(query(selection, { baseVersion: initial.scene.version })), env)).json(); assert.equal(next.transport, 'delta');
  const applied = applyFocusSceneDelta(initial.scene, next.delta, { now }); assert.equal(applied.features[0].display.magnitude, 4);
  assert.equal(applied.source.recordedAt, AT); assert.equal(applied.source.fence, 2);
  const cold = createFocusScenesApiHandler({ now, read: async () => value });
  assert.equal((await (await cold(request(query(selection, { baseVersion: initial.scene.version })), {})).json()).transport, 'delta');
  const same = await (await handler(request(query(selection, { baseVersion: applied.version })), env)).json();
  assert.equal(same.delta.upsertFeatures.length, 0); assert.equal(same.delta.removeFeatureIds.length, 0);
  assert.equal((await handler(request(query(selection, { fence: '4' })), env)).status, 409);
  value = { ...c, prior: b.prepared };
  const old = await (await handler(request(query(selection, { baseVersion: initial.scene.version })), env)).json();
  assert.equal(old.transport, 'snapshot'); assert.equal(old.snapshotRequired, true); assert.equal(old.recoveryReason, 'base-not-retained');
  assert.equal(reads, 5);
});

test('coincident members are pinned to exact source/display priority minute and residual exclusions, with scoped 50-row pagination', async () => {
  const a = await fixture(6, 1, 101), b = await fixture(5, 2, 101); let stored = a, clock = CLOCK, readCalls = 0;
  const localLeaf = focusCellAt({ lon: 4, lat: 50 }, 18), local = { ...selection, leaves: [localLeaf], focus: localLeaf };
  const handler = createFocusScenesApiHandler({ now: () => clock, read: async (_env, _source, options) => { ++readCalls; assert.equal(options.includePrior, true); return stored; } });
  const view = await selectFocusScene(a.prepared, local, { now }), cluster = view.clusters[0]; assert.equal(cluster.count, 100);
  const fixed = { sourceVersion: a.source.receiptId, viewVersion: view.version, asOf: view.interest.evaluatedAt, cluster: cluster.id };
  stored = { ...b, prior: a.prepared };
  const first = await (await handler(request(query(local, fixed)), {})).json();
  assert.equal(first.kind, 'focus-members-delivery'); assert.equal(first.source.fence, 1); assert.equal(first.source.recordedAt, AT);
  assert.equal(first.count, 100); assert.equal(first.returned, 50); assert.equal(first.members.length, 50); assert.ok(first.nextCursor);
  assert.ok(first.members.every(member => member.role === 'member' && member.id !== view.features[0].id && !Object.hasOwn(member, 'record')));
  const second = await (await handler(request(query(local, { ...fixed, cursor: first.nextCursor })), {})).json();
  assert.equal(second.returned, 50); assert.equal(second.nextCursor, null); assert.equal(new Set([...first.members, ...second.members].map(m => m.id)).size, 100);
  for (const extra of [{ viewVersion: `view:${'f'.repeat(64)}` }, { sourceVersion: `receipt:${'f'.repeat(64)}` },
    { cursor: `members:${'f'.repeat(64)}:50` }, { cluster: cluster.id.replace('seismic', 'notice') }]) {
    const response = await handler(request(query(local, { ...fixed, ...extra })), {}); assert.equal(response.status, 409); assert.equal((await response.json()).refreshRequired, true);
  }
  const before = readCalls; clock += 3600001;
  assert.equal((await handler(request(query(local, fixed)), {})).status, 409); assert.equal(readCalls, before);
  clock = CLOCK;
  assert.equal((await handler(request(query(local, { ...fixed, asOf: '2026-10-12T09:01:00.000Z' })), {})).status, 409); assert.equal(readCalls, before);
  for (const extra of [{ limit: '51' }, { fence: '1' }, { asOf: '2026-10-12T09:00:00.001Z' }, { knownAt: AT }])
    assert.equal((await handler(request(query(local, { ...fixed, ...extra })), {})).status, 400);
  assert.equal(readCalls, before);
});

test('interest-minute changes are exact deltas without changed source facts and member inspection does not borrow new-source freshness', async () => {
  const source = await fixture(6, 1, 2); let clock = CLOCK;
  const handler = createFocusScenesApiHandler({ now: () => clock, read: async () => source }), env = {};
  const first = await (await handler(request(query(selection)), env)).json(); const sourceVersion = source.prepared.version;
  clock += 3600000;
  const later = await (await handler(request(query(selection, { baseVersion: first.scene.version })), env)).json();
  assert.equal(later.transport, 'delta'); assert.notEqual(later.delta.version, first.scene.version);
  assert.equal(source.prepared.version, sourceVersion); assert.deepEqual(later.source, first.source);
  const applied = applyFocusSceneDelta(first.scene, later.delta, { now: () => clock }); assert.equal(applied.counts.highlights, 0);
});

test('dense500 delivery stays bounded and counted; pending/ignored-reader deadline/corrupt authority fail without preparation writes', async () => {
  const stored = await fixture(3, 1, 500), handler = createFocusScenesApiHandler({ now, read: async () => stored });
  const response = await handler(request(query(selection)), {}); assert.equal(response.status, 200);
  const bytes = new TextEncoder().encode(await response.clone().text()).length, result = await response.json();
  assert.equal(result.scene.counts.selectedMapped, 500); assert.equal(result.scene.counts.clusteredReports, 499);
  assert.equal(result.scene.features.length, 1); assert.ok(bytes < 128 * 1024);
  console.log(JSON.stringify({ fixture: '500 coincident stored reports outer envelope', bytes, selectedMapped: 500, pins: 1, residual: 499 }));
  const pending = createFocusScenesApiHandler({ now, read: async () => ({ configured: true, available: false, pending: true }) });
  const waiting = await pending(request(query(selection)), {}); assert.equal(waiting.status, 503); assert.equal((await waiting.json()).pending, true);
  let observedSignal; const hung = createFocusScenesApiHandler({ now, deadlineMs: 10, read: (_env, _source, { signal }) => { observedSignal = signal; return new Promise(() => {}); } });
  assert.equal((await hung(request(query(selection)), {})).status, 503); assert.equal(observedSignal.aborted, true);
  const corrupt = createFocusScenesApiHandler({ now, read: async () => ({ ...stored, source: { ...stored.source, fence: 100 } }) });
  const bad = await corrupt(request(query(selection)), {}); assert.equal(bad.status, 503); assert.equal((await bad.json()).available, false);
  assert.equal(pluginJson(stored.prepared.source), pluginJson(stored.source));
});

test('real SQLite source receipts and immutable R2 derivative feed the default public reader with zero writes/provider calls', async t => {
  const f = await documentFixture(t, { documents: false }); f.setClock(CLOCK);
  const etags = new Map(); let sequence = 0;
  f.env.EARTH_STORE = {
    async get(key) { f.activity.objects.push({ operation: 'get', key }); const bytes = f.objects.get(key);
      return bytes ? { size: bytes.length, etag: etags.get(key), arrayBuffer: async () => new Uint8Array(bytes).buffer } : null; },
    async put(key, value, options = {}) { f.activity.objects.push({ operation: 'put', key });
      if (options.onlyIf?.get?.('if-none-match') === '*' && f.objects.has(key) || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== etags.get(key)) return null;
      f.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
      const etag = `test-focus-${++sequence}`; etags.set(key, etag); return { etag }; },
  };
  const descriptor = { ...USGS_LIVE_DAY_PLUGIN, collect: collectUsgsLiveDay, items: usgsLiveDayItems };
  const acquire = mag => runSourcePlugin(f.env, descriptor, { now: f.now, fetchImpl: async () => {
    f.activity.providers.push('TEST ONLY fixed fixture');
    return new Response(JSON.stringify({ type: 'FeatureCollection', metadata: { generated: f.now(), count: 1, status: 200, url: USGS_LIVE_DAY.sourceUrl },
      features: [{ type: 'Feature', id: 'us-native-focus', geometry: { type: 'Point', coordinates: [4, 50, 12] },
        properties: { mag, time: CLOCK - 600000, updated: CLOCK, type: 'earthquake', place: 'TEST ONLY' } }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal((await acquire(3)).status, 'stored'); assert.equal((await ensurePreparedScene(f.env, 'earthquakes', { now: f.now })).status, 'prepared');
  // Cold reader revalidates retained bytes through the real storage module.
  const env = { ...f.env, EARTH_STORE: { ...f.env.EARTH_STORE } }, handler = createFocusScenesApiHandler({ now: f.now }); f.reset();
  const first = await handler(request(query(selection)), env); assert.equal(first.status, 200);
  const view = await first.json(); assert.equal(view.scene.features[0].display.magnitude, 3); assert.equal(view.source.recordedAt, AT);
  assert.equal(f.activity.sql.some(row => row.write), false); assert.equal(f.activity.objects.some(row => row.operation === 'put'), false);
  assert.equal(f.activity.providers.length, 0); assert.ok(f.activity.objects.some(row => row.key === PREPARED_SCENES_KEYS.earthquakes.current));
  f.advance(60001); assert.equal((await acquire(4)).status, 'stored'); f.reset();
  const pending = await handler(request(query(selection)), env); assert.equal(pending.status, 503); assert.equal((await pending.json()).pending, true);
  assert.equal(f.activity.sql.some(row => row.write), false); assert.equal(f.activity.objects.some(row => row.operation === 'put'), false);
  assert.equal(f.activity.providers.length, 0);
});
