import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionalSceneClient, normalizeRegionalSceneDelivery, applyRegionalSceneDelta, regionalSelection, REGIONAL_SCENE_LIMITS } from './regional-scene-client.js';
import { createPreparedUsgsApiHandler } from '../../worker/prepared-usgs-api.js';
import { buildPreparedUsgsScene, selectPreparedUsgsCells, diffPreparedUsgsViews } from '../../worker/prepared-usgs-scene.js';
import { USGS_LIVE_DAY, decodeUsgsLiveDay, usgsLiveDayOverview } from './usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest } from './plugin-evidence.js';

const NOW = Date.parse('2026-10-12T09:00:00.000Z'), demand = { level: 0, cells: [[4, 0]], mode: 'features' };
async function fixture(mag = 3, fence = 1) {
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', metadata: { status: 200, url: USGS_LIVE_DAY.sourceUrl,
    generated: NOW - 2000, count: 2 }, features: [0, 1].map(i => ({ type: 'Feature', id: `us-test-${i}`,
      properties: { mag, place: 'Reported fixture', time: NOW - 4000, updated: NOW - 3000, type: i ? 'quarry blast' : 'earthquake', status: 'reviewed' },
      geometry: { type: 'Point', coordinates: [4 + i, 50, 12] } })) }));
  const decoded = decodeUsgsLiveDay(raw, { now: () => NOW }), overview = usgsLiveDayOverview(decoded);
  const receipt = { id: `receipt:${String(fence).padStart(64, '0')}`, fence, factsDigest: await pluginFactsDigest(decoded.canonicalFacts), rawSha256: await pluginBytesDigest(raw),
    artifactSha256: await pluginFactsDigest(overview), capturedAt: new Date(NOW - 1000).toISOString(), recordedAt: new Date(NOW).toISOString(), sourceUpdatedAt: decoded.sourceGeneratedAt };
  const prepared = await buildPreparedUsgsScene({ schemaVersion: 1, configured: true, available: true, knownAt: null,
    plugin: { id: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId }, scope: { id: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24 },
    version: receipt.id, receipt, records: decoded.canonicalFacts.records, overview, coverage: { complete: true, recordCount: 2 } });
  return { schemaVersion: 1, configured: true, available: true, pending: false, policyId: prepared.content.policyId, source: prepared.source,
    check: { checkedAt: new Date(NOW).toISOString(), nextCheckAt: new Date(NOW + 60000).toISOString(), lastSuccessfulAt: new Date(NOW).toISOString(),
      status: 'ready', sourceGeneratedAt: decoded.sourceGeneratedAt }, stale: false, sourceGenerationAgeMs: 2000, prepared, prior: null };
}
const envelope = async (value, selection = demand) => ({ ...value, prepared: undefined, prior: undefined, kind: 'prepared-usgs-scene-delivery', transport: 'snapshot',
  snapshotRequired: false, scene: await selectPreparedUsgsCells(value.prepared, selection), delta: null });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const revision = source => ({ schemaVersion: 1, pluginId: source.pluginId, scopeId: source.scopeId, receiptId: source.receiptId,
  fence: source.fence, factsDigest: source.factsDigest, recordedAt: source.recordedAt });

test('actual prepared server snapshots and A/B/A deltas preserve exact source types, dates and revisions', async () => {
  const a = await fixture(3, 1), b = await fixture(4, 2), again = await fixture(3, 3); let value = a;
  const handler = createPreparedUsgsApiHandler({ now: () => NOW, read: async () => value }), urls = [];
  const client = createRegionalSceneClient({ now: () => NOW, baseUrl: '/earth/', fetchImpl: async (url, options) => {
    urls.push([url, options]); return handler(new Request(`https://example.test${url.replace('/earth/', '/')}`, options), {});
  } });
  const first = await client.load(demand); assert.equal(first.scene.features[1].record.eventType, 'quarry blast');
  value = { ...b, prior: a.prepared }; const second = await client.load(demand);
  assert.equal(second.scene.features[0].record.mag, 4); assert.equal(second.scene.source.fence, 2);
  assert.equal(second.scene.contentDigest, null, 'a regional delta never borrows an old full-content proof');
  value = { ...again, prior: b.prepared }; const reverted = await client.load(demand);
  assert.equal(reverted.scene.features[0].record.mag, 3); assert.notEqual(reverted.scene.version, first.scene.version);
  assert.equal(reverted.source.capturedAt, again.source.capturedAt); assert.equal(reverted.source.recordedAt, again.source.recordedAt);
  assert.equal(urls[1][0].includes('baseVersion=view%3A'), true);
  for (const [url, options] of urls) { assert.equal(url.startsWith('/earth/api/layers/earthquakes/scene?'), true); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); }
  client.destroy();
});

test('malformed cells, inconsistent clusters, foreign positions and non-exact deltas fail admission', async () => {
  for (const input of [{ ...demand, level: 3 }, { ...demand, cells: [[4, 0], [4, 0]] }, { ...demand, cells: [[4, 1], [4, 0]] }, { ...demand, mode: 'heatmap' }])
    assert.throws(() => regionalSelection(input), TypeError);
  const a = await fixture(), b = await fixture(4, 2), initial = await envelope(a), next = await envelope(b);
  const admitted = normalizeRegionalSceneDelivery(initial, demand, { now: () => NOW });
  const delta = diffPreparedUsgsViews(initial.scene, next.scene);
  for (const changed of [{ ...delta, baseVersion: `view:${'f'.repeat(64)}` }, { ...delta, source: { ...delta.source, fence: 0 } },
    { ...delta, removeFeatureIds: ['earthquake:unknown'] }, { ...delta, upsertFeatures: [...delta.upsertFeatures, delta.upsertFeatures[0]] }])
    assert.throws(() => applyRegionalSceneDelta(admitted.scene, changed, { now: () => NOW }), TypeError);
  const sameVersion = diffPreparedUsgsViews(initial.scene, initial.scene);
  assert.throws(() => applyRegionalSceneDelta(admitted.scene, { ...sameVersion, upsertFeatures: delta.upsertFeatures }, { now: () => NOW }), TypeError);
  const counterfeit = structuredClone(initial); counterfeit.scene.features[0].record.mag = 4;
  assert.throws(() => normalizeRegionalSceneDelivery(counterfeit, demand, { base: admitted.scene, now: () => NOW }), TypeError);
  const wrong = structuredClone(initial); wrong.scene.features[0].record.lon = -120;
  assert.throws(() => normalizeRegionalSceneDelivery(wrong, demand, { now: () => NOW }), TypeError);
  const selection = { ...demand, mode: 'clusters' }, grouped = await envelope(a, selection), bad = structuredClone(grouped); bad.scene.clusters[0].lon += 1;
  assert.throws(() => normalizeRegionalSceneDelivery(bad, selection, { now: () => NOW }), TypeError);
  assert.equal(normalizeRegionalSceneDelivery(grouped, selection, { now: () => NOW }).scene.clusters[0].count, 2);
});

test('a corrupt delta gets one bounded full snapshot recovery rather than an unbounded retry loop', async () => {
  const a = await fixture(), first = await envelope(a); let calls = 0;
  const client = createRegionalSceneClient({ now: () => NOW, fetchImpl: async url => {
    calls++; if (calls === 2) return json({ ...first, transport: 'delta', scene: null, delta: { baseVersion: 'wrong' } });
    if (calls === 3) assert.equal(new URL(url, 'https://example.test').searchParams.has('baseVersion'), false);
    return json(first);
  } });
  await client.load(demand); assert.equal((await client.load(demand)).scene.version, first.scene.version); assert.equal(calls, 3); client.destroy();
});

test('latest demand, explicit cancellation and SSE fence abort old ownership before any late cache publication', async () => {
  const a = await fixture(), b = await fixture(4, 2), started = Promise.withResolvers(), gate = Promise.withResolvers(); let calls = 0;
  const client = createRegionalSceneClient({ now: () => NOW, fetchImpl: async (_url, options) => {
    if (++calls === 1) { started.resolve(options.signal); return gate.promise; } return json(await envelope(b, { ...demand, cells: [[0, 0]] }));
  } });
  const old = client.load(demand), rejected = assert.rejects(old, { name: 'AbortError' }); const signal = await started.promise;
  client.select({ ...demand, cells: [[0, 0]] }); assert.equal(signal.aborted, true); await rejected;
  const next = await client.load({ ...demand, cells: [[0, 0]] }); gate.resolve(json(await envelope(a))); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(next.scene.features.length, 0); assert.equal(client.getState().cacheEntries, 1);
  assert.equal(client.invalidate({ ...revision(b.source), fence: 3, receiptId: `receipt:${'3'.padStart(64, '0')}` }), true);
  assert.equal(client.invalidate(revision(a.source)), false);
  client.destroy(); await assert.rejects(client.load(demand), { name: 'AbortError' });
});

test('same scope can paint a dated complete cache during pending; a newer source fence never paints older cache', async () => {
  const a = await fixture(), b = await fixture(4, 2), first = await envelope(a); let pending = false, cached = 0, url;
  const client = createRegionalSceneClient({ now: () => NOW, fetchImpl: async value => {
    url = value; return pending ? new Response(JSON.stringify({ schemaVersion: 1, configured: true, available: false, pending: true,
      scene: null, delta: null }), { status: 503, headers: { 'content-type': 'application/json' } }) : json(first);
  } });
  await client.load(demand); pending = true;
  const result = await client.load(demand, { onCached: value => { cached++; assert.equal(value.browserCache, true); assert.equal(value.source.receiptId, a.source.receiptId); } });
  assert.equal(result.pending, true); assert.equal(cached, 1); client.invalidate(revision(b.source));
  await client.load(demand, { onCached: () => cached++ }); assert.equal(cached, 1); assert.equal(new URL(url, 'https://example.test').searchParams.get('fence'), '2'); client.destroy();
});

test('body and deadline limits are enforced, a hanging read cannot populate cache, and complete cache storage stays bounded', async () => {
  const a = await fixture(), first = await envelope(a), gate = Promise.withResolvers();
  const hanging = createRegionalSceneClient({ now: () => NOW, deadlineMs: 15, fetchImpl: () => gate.promise });
  await assert.rejects(hanging.load(demand), { name: 'TimeoutError' }); gate.resolve(json(first)); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(hanging.getState().cacheEntries, 0); hanging.destroy();
  const oversized = createRegionalSceneClient({ now: () => NOW, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json',
    'content-length': String(REGIONAL_SCENE_LIMITS.bytes + 1) } }) });
  await assert.rejects(oversized.load(demand), TypeError); oversized.destroy();
  const client = createRegionalSceneClient({ now: () => NOW, fetchImpl: async url => { const p = new URL(url, 'https://example.test').searchParams;
    return json(await envelope(a, { level: Number(p.get('level')), mode: p.get('mode'), cells: p.get('cells').split(',').map(cell => cell.split(':').map(Number)) })); } });
  for (let i = 0; i < 20; i++) await client.load({ level: 1, cells: [[i, 0]], mode: 'features' });
  assert.equal(client.getState().cacheEntries, 16); assert.ok(client.getState().cacheBytes <= REGIONAL_SCENE_LIMITS.cacheBytes); client.destroy();
});

test('the highest observed source head fences regressed snapshots and cached views in other camera scopes before SSE arrives', async () => {
  const a = await fixture(), b = await fixture(4, 2); let head = a, cached = 0, lastUrl;
  const client = createRegionalSceneClient({ now: () => NOW, fetchImpl: async url => { lastUrl = url;
    const params = new URL(url, 'https://example.test').searchParams, selected = { level: Number(params.get('level')), mode: params.get('mode'),
      cells: params.get('cells').split(',').map(value => value.split(':').map(Number)) };
    return json(await envelope(head, selected));
  } });
  await client.load(demand); head = b; await client.load({ ...demand, cells: [[0, 0]] }); head = a;
  await assert.rejects(client.load(demand, { onCached: () => cached++ }), TypeError);
  assert.equal(cached, 0); assert.equal(new URL(lastUrl, 'https://example.test').searchParams.get('fence'), '2');
  assert.equal(client.getState().expected.fence, 2); client.destroy();
});
