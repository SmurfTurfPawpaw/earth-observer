import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionalSceneClient, normalizeRegionalSceneDelivery, applyRegionalSceneDelta, regionalSelection, REGIONAL_SCENE_LIMITS } from './regional-scene-client.js';
import { createPreparedUsgsApiHandler } from '../../worker/prepared-usgs-api.js';
import { buildPreparedUsgsScene, selectPreparedUsgsCells, diffPreparedUsgsViews } from '../../worker/prepared-usgs-scene.js';
import { USGS_LIVE_DAY, decodeUsgsLiveDay, usgsLiveDayOverview } from './usgs-live-day.js';
import { pluginFactsDigest, pluginBytesDigest } from './plugin-evidence.js';
import { buildPreparedScene } from '../../worker/prepared-scene-builder.js';
import { createPreparedScenesApiHandler } from '../../worker/prepared-scenes-api.js';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { createWorldSourceItem } from './world-model.js';
import { worldHash } from './world-identity.js';
import { PREPARED_SCENE_POLICY } from './prepared-scene-contract.js';
import { createFocusScenesApiHandler } from '../../worker/focus-scenes-api.js';
import { selectFocusScene } from '../../worker/focus-scene-builder.js';
import { FOCUS_SCENE_POLICY } from './focus-scene-contract.js';

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

async function gdacsFixture(advance = 0, red = true) {
  const capturedAt = new Date(NOW + advance).toISOString(), publishedAt = new Date(NOW + advance + 1000).toISOString();
  const records = [1, 2, 3].map(i => canonicalDiscoveryRecord({ id: `gdacs:FL:700${i}:1`, sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report',
    category: 'disasters', title: `Retained source notice ${i}`, eventType: 'FL', url: `https://www.gdacs.org/report.aspx?eventid=700${i}&eventtype=FL&episodeid=1`,
    lat: i === 3 ? null : 50, lon: i === 3 ? null : 4, alertLevel: i === 1 && red ? 'red' : 'orange',
    observedAt: new Date(NOW - 30000).toISOString(), updatedAt: new Date(NOW - 10000).toISOString(), retrievedAt: capturedAt }));
  const body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] }, bodySha256 = await worldHash(body),
    snapshotId = await worldHash({ ...body, records: records.map(({ retrievedAt: _clock, ...record }) => record) });
  const items = await Promise.all(records.map(async record => ({ ...await createWorldSourceItem(record, { snapshotId, capturedAt, recordedAt: publishedAt }),
    origin: { snapshotId, firstCapturedAt: capturedAt, firstRecordedAt: publishedAt, validation: 'retained-revision-index-only', bodyValidated: false } })));
  const cohort = { schemaVersion: 1, configured: true, available: true, kind: 'source-item-cohort', mode: 'current-retained-cohort',
    source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt, publishedAt }), readAt: publishedAt,
    cohort: { sourceId: 'gdacs', snapshotId, bodySha256, capturedAt, publishedAt, recordCount: 3 }, items,
    counts: { returned: 3, mapped: 2, unmapped: 1 }, coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100,
      completeRetainedCohort: true, completeProviderArchive: false }, operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
  const prepared = await buildPreparedScene('gdacs', cohort, { now: () => NOW + 60000 });
  return { configured: true, available: true, pending: false, source: prepared.source, prepared, prior: null, check: null, stale: null, sourceGenerationAgeMs: null };
}

test('both closed sources use one generic client with complete highlight/residual partitions and exact GDACS no-fence deltas', async () => {
  const usgs = await fixture(6), usgsPrepared = await buildPreparedScene('earthquakes', usgs, { now: () => NOW }),
    gdacs = await gdacsFixture(), corrected = await gdacsFixture(2000, false);
  let gdacsHead = gdacs; const requests = [];
  const handler = createPreparedScenesApiHandler({ now: () => NOW, read: async (_env, source) => source === 'earthquakes' ?
    { ...usgs, prepared: usgsPrepared, source: usgsPrepared.source } : gdacsHead });
  const fetchImpl = async (url, options) => { requests.push(url); return handler(new Request(`https://example.test${url}`, options), {}); };
  const selection = { ...demand, mode: 'clusters' }, a = createRegionalSceneClient({ sourceKey: 'earthquakes', now: () => NOW, fetchImpl }),
    b = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, fetchImpl });
  const seismic = await a.load(selection), notices = await b.load(selection);
  assert.equal(seismic.scene.features.length, 1); assert.equal(seismic.scene.clusters[0].count, 1, 'reported quarry blast remains in residual counts');
  assert.equal(notices.scene.counts.selectedMapped, notices.scene.features.length + notices.scene.clusters.reduce((sum, cell) => sum + cell.count, 0));
  assert.equal(notices.scene.unmappedFeatures.length, 1); assert.equal(notices.check, null); assert.equal(notices.stale, null);
  assert.equal(Object.hasOwn(notices.source, 'fence'), false); assert.equal(notices.scene.features[0].sourceAssessment.reach, 'unresolved');
  gdacsHead = { ...corrected, prior: gdacs.prepared }; b.invalidate(); let cached = 0;
  const next = await b.load(selection, { onCached: () => cached++ }); assert.equal(cached, 0); assert.equal(next.source.version, corrected.source.version);
  assert.equal(next.scene.counts.highlights, 0); assert.equal(next.scene.counts.clusteredReports, 2);
  for (const url of requests) { const params = new URL(url, 'https://example.test').searchParams;
    assert.equal(url.startsWith('/api/layers/scenes?'), true); if (params.get('source') === 'gdacs') assert.equal(params.has('fence'), false); }
  a.destroy(); b.destroy(); assert.throws(() => createRegionalSceneClient({ sourceKey: 'arbitrary-url' }), TypeError);
});

test('generic preparation retries are at most two, real unavailability does not retry, and cancellation stops a retry owner', async () => {
  const gdacs = await gdacsFixture(); let calls = 0;
  const handler = createPreparedScenesApiHandler({ now: () => NOW, read: async () => ++calls <= 2 ?
    { configured: true, available: false, pending: true } : gdacs });
  const client = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, retryDelayMs: 5,
    fetchImpl: (url, options) => handler(new Request(`https://example.test${url}`, options), {}) });
  assert.equal((await client.load({ ...demand, mode: 'clusters' })).scene.counts.selectedMapped, 2); assert.equal(calls, 3); client.destroy();
  calls = 0; const unavailable = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, retryDelayMs: 5, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ schemaVersion: 1, policyId: PREPARED_SCENE_POLICY, sourceKey: 'gdacs', kind: 'prepared-scene-delivery',
      configured: true, available: false, pending: false, scene: null, delta: null }),
      { status: 503, headers: { 'content-type': 'application/json' } }); } });
  const absent = await unavailable.load(demand); assert.equal(absent.errorCode, 'stored-scene-unavailable'); assert.equal(absent.preparing, false);
  assert.equal(calls, 1); unavailable.destroy();
  const started = Promise.withResolvers(); calls = 0;
  const canceled = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, fetchImpl: async () => { calls++; started.resolve();
    return new Response(JSON.stringify({ schemaVersion: 1, policyId: PREPARED_SCENE_POLICY, sourceKey: 'gdacs', kind: 'prepared-scene-delivery',
      configured: true, available: false, pending: true, scene: null, delta: null }),
      { status: 503, headers: { 'content-type': 'application/json' } }); } });
  const waiting = canceled.load(demand), rejected = assert.rejects(waiting, { name: 'AbortError' }); await started.promise;
  canceled.cancel(); await rejected; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1); canceled.destroy();
});

const focusDemand = { schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves: [[0, 4, 0]], focus: [0, 4, 0], featureBudget: 0 };
test('mixed focus transport uses exact deltas and loads full source evidence only on demand, sharing one bounded cache', async () => {
  const a = await gdacsFixture(), b = await gdacsFixture(2000, false); let stored = a;
  const focus = createFocusScenesApiHandler({ now: () => NOW, read: async () => stored }),
    detail = createPreparedScenesApiHandler({ now: () => NOW, read: async () => stored }), requests = [];
  const client = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, baseUrl: '/earth/', fetchImpl: (url, options) => {
    requests.push(url); const request = new Request(`https://example.test${url.replace('/earth/', '/')}`, options);
    return request.url.includes('/focus-scenes?') ? focus(request, {}) : detail(request, {});
  } });
  const first = await client.load(focusDemand); assert.equal(first.scene.schemaVersion, 2); assert.equal(first.scene.counts.selectedMapped, 2);
  assert.equal(first.scene.features.length, 1); assert.equal(Object.hasOwn(first.scene.features[0], 'record'), false);
  assert.equal(requests.length, 1, 'display does not eagerly fetch full evidence');
  const compact = first.scene.features[0], proof = await client.getFeature(compact, first.source);
  assert.equal(proof.feature.record.title, compact.title); assert.equal(proof.feature.provenance.evidence.snapshotId, first.source.snapshotId);
  const cachedProof = await client.getFeature(compact, first.source); assert.equal(requests.length, 2, 'exact proof reuses the same bounded LRU');
  assert.equal(cachedProof.current, false); assert.equal(cachedProof.check, null); assert.equal(cachedProof.browserCache, true);
  const members = await client.getMembers(first, first.scene.clusters[0]); assert.equal(members.count, 1); assert.equal(members.members[0].role, 'member');
  assert.notEqual(members.members[0].id, compact.id, 'residual membership excludes the separately drawn pin');
  stored = { ...b, prior: a.prepared }; client.invalidate(); const next = await client.load(focusDemand);
  assert.equal(next.scene.features.length, 0); assert.equal(next.scene.counts.clusteredReports, 2); assert.notEqual(next.source.version, first.source.version);
  assert.equal(client.getState().cacheEntries, 2); assert.ok(client.getState().cacheBytes <= REGIONAL_SCENE_LIMITS.cacheBytes);
  assert.ok(requests.every(url => url.startsWith('/earth/api/layers/'))); client.destroy();
  await assert.rejects(client.getFeature(compact, first.source), { name: 'AbortError' });
});

test('lazy detail and residual pages reject mismatched source provenance, display facts, category, membership and late cancellation', async () => {
  const a = await gdacsFixture(), b = await gdacsFixture(2000), scene = await selectFocusScene(b.prepared, focusDemand, { now: () => NOW }),
    compact = scene.features[0], old = a.prepared.content.features.find(feature => feature.id === compact.id);
  let payload = { schemaVersion: 1, kind: 'prepared-scene-feature-delivery', sourceKey: 'gdacs', configured: true, available: true,
    pending: false, current: true, source: b.source, check: null, stale: null, sourceGenerationAgeMs: null, feature: old };
  const client = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, fetchImpl: async () => json(payload) });
  await assert.rejects(client.getFeature(compact, b.source), TypeError, 'old cohort provenance cannot be rebound to a new source wrapper');
  payload = { ...payload, feature: b.prepared.content.features.find(feature => feature.id === compact.id) };
  await assert.rejects(client.getFeature({ ...compact, display: { ...compact.display, sourceType: 'invented' } }, b.source), TypeError);
  client.destroy();
  const wrapper = { scene, source: b.source }, cluster = scene.clusters[0], api = createFocusScenesApiHandler({ now: () => NOW, read: async () => b });
  for (const mutate of [value => { value.members[0].role = 'highlight'; }, value => { value.members[0].geometry.lon = -120; },
    value => { value.members[0] = { ...compact, role: 'member' }; }, value => { value.asOf = new Date(NOW - 60000).toISOString(); }]) {
    const faulty = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW, fetchImpl: async (url, options) => {
      const value = await (await api(new Request(`https://example.test${url}`, options), {})).json(); mutate(value); return json(value);
    } });
    await assert.rejects(faulty.getMembers(wrapper, cluster), TypeError); faulty.destroy();
  }
  const started = Promise.withResolvers(), gate = Promise.withResolvers(), delayed = createRegionalSceneClient({ sourceKey: 'gdacs', now: () => NOW,
    fetchImpl: async (_url, options) => { started.resolve(options.signal); return gate.promise; } });
  const pending = delayed.getFeature(compact, b.source), rejected = assert.rejects(pending, { name: 'AbortError' });
  const signal = await started.promise; delayed.cancel(); assert.equal(signal.aborted, true); await rejected;
  gate.resolve(json(payload)); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(delayed.getState().cacheEntries, 0); delayed.destroy();
});
