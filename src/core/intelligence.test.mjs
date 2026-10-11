import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligenceFeed, safeIntelligenceUrl, intelligenceTime, intelligenceReportDetails, INTELLIGENCE_REFRESH_MS } from './intelligence.js';

const payload = { reports: [{ id: 'one', title: 'Linked report', url: 'https://example.test/' }], sources: [{ id: 'gdelt', status: 'ready' }], nextRefreshMs: 300000 };
function environment(fetchImpl) {
  const events = new Map(), windowEvents = new Map(), timers = new Map(); let clock = 100000, nextTimer = 0;
  const states = [], documentRef = { hidden: false, addEventListener: (name, callback) => events.set(name, callback), removeEventListener: (name) => events.delete(name) };
  const windowRef = { addEventListener: (name, callback) => windowEvents.set(name, callback), removeEventListener: (name) => windowEvents.delete(name) };
  const feed = createIntelligenceFeed({ fetchImpl, documentRef, windowRef, now: () => clock, onChange: (state) => states.push(state),
    setTimeoutImpl: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeoutImpl: (id) => timers.delete(id) });
  return { feed, timers, states, documentRef, events, windowEvents, advance: (ms) => { clock += ms; }, visibility: () => events.get('visibilitychange')?.(),
    reconnect: () => windowEvents.get('online')?.(), fireTimer() { const [id, timer] = timers.entries().next().value; timers.delete(id); clock += timer.delay; timer.callback(); } };
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('curated metadata uses its source-date labels and cannot expose an incident-navigation action', () => {
  const detail = intelligenceReportDetails({ kind: 'curated-event', source: 'NASA EONET',
    sourceGeometryAt: '2021-01-01T00:00:00Z', closedAt: '2026-10-10T00:00:00Z', retrievedAt: '2026-10-11T00:00:00Z',
    lat: 50, lon: 4, publishedAt: '2026-10-11T00:00:00Z' });
  assert.equal(detail.curated, true); assert.equal(detail.canNavigate, false);
  assert.match(detail.source, /curated event metadata/);
  assert.deepEqual(detail.dates.map(([label]) => label), ['EONET geometry date', 'EONET closed date', 'Retrieved']);
  assert.equal(detail.dates[0][1], '2021-01-01T00:00:00Z');
});

test('only an opened visible panel fetches, cache survives close, and refresh timers use the remaining freshness interval', async () => {
  let requests = 0;
  const env = environment(async () => { requests++; return Response.json(payload); });
  assert.equal(requests, 0);
  assert.equal(await env.feed.refresh(), false);
  await env.feed.open(); assert.equal(requests, 1); assert.equal(env.timers.size, 1);
  env.feed.close(); assert.equal(env.timers.size, 0);
  env.advance(25000); await env.feed.open(); assert.equal(requests, 1);
  assert.equal([...env.timers.values()][0].delay, 35000);
  env.documentRef.hidden = true; env.visibility();
  assert.equal(env.timers.size, 0); assert.equal(await env.feed.refresh(true), false);
  env.advance(60000); env.documentRef.hidden = false; env.visibility(); await settle();
  assert.equal(requests, 2);
  env.feed.destroy(); assert.equal(env.timers.size, 0); assert.equal(env.events.size, 0); assert.equal(env.windowEvents.size, 0);
});

test('visible delivery checks every minute independently of source hints and forces transport revalidation', async () => {
  const calls = [], env = environment(async (url, init) => { calls.push({ url, init }); return Response.json(payload); });
  await env.feed.open();
  assert.equal(INTELLIGENCE_REFRESH_MS, 60000);
  assert.equal(calls[0].init.cache, undefined, 'First open may paint the browser snapshot immediately');
  assert.equal([...env.timers.values()][0].delay, 60000, 'The old five-minute response hint cannot slow delivery checks');
  env.fireTimer(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].init.cache, 'no-cache');
  assert.equal([...env.timers.values()][0].delay, 60000);
  assert.ok(calls.every(({ url }) => !new URL(url, 'https://fixture.invalid').searchParams.has('q')));
  env.feed.close(); assert.equal(env.timers.size, 0); env.reconnect(); await settle(); assert.equal(calls.length, 2);
  env.feed.destroy();
});

test('automatic revalidation retains dated records during body loading, and hiding cancels late delivery', async () => {
  const body = Promise.withResolvers(), began = Promise.withResolvers(); let calls = 0, signal;
  const original = indexedPayload();
  const env = environment(async (_url, init) => {
    if (++calls === 1) return Response.json(original);
    signal = init.signal; began.resolve(); return { ok: true, json: () => body.promise };
  });
  await env.feed.open(); await env.feed.setFilters({ category: 'all', q: 'Ukraine trade' });
  env.fireTimer(); await began.promise;
  assert.equal(env.feed.getState().loading, true);
  assert.deepEqual(env.feed.getState().payload.reports.map(({ id }) => id), ['ukraine-trade']);
  assert.equal(env.feed.getState().payload.reports[0].indexedAt, original.reports[0].indexedAt);
  env.documentRef.hidden = true; env.visibility(); assert.equal(signal.aborted, true); assert.equal(env.timers.size, 0);
  body.resolve({ ...original, reports: [] }); await settle();
  assert.deepEqual(env.feed.getState().payload.reports.map(({ id }) => id), ['ukraine-trade'], 'Canceled delivery cannot replace the retained local search');
  assert.equal(env.feed.getState().loading, false); env.feed.destroy();
});

test('reconnecting revalidates retained failed metadata promptly, keeps source dates, and pauses when hidden', async () => {
  const calls = [], original = indexedPayload();
  const env = environment(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 2) throw new Error('Connection interrupted');
    return Response.json(original);
  });
  await env.feed.open(); await env.feed.setFilters({ category: 'all', q: 'Ukraine' });
  env.fireTimer(); await settle();
  assert.match(env.feed.getState().error, /Connection interrupted/);
  assert.equal(env.feed.getState().payload.reports[0].retrievedAt, original.reports[0].retrievedAt);
  assert.equal(env.feed.getState().payload.sources[0].stale, true);
  assert.match(env.feed.getState().payload.sources[0].reason, /retained metadata keeps its original dates/);
  env.documentRef.hidden = true; env.visibility(); env.reconnect(); await settle(); assert.equal(calls.length, 2);
  env.documentRef.hidden = false; env.visibility(); await settle();
  assert.equal(calls.length, 3, 'Visible resumption retries a failed acquisition immediately');
  assert.equal(env.feed.getState().error, null); assert.equal(env.feed.getState().payload.sources[0].stale, undefined);
  env.reconnect(); await settle(); assert.equal(calls.length, 4); assert.equal(calls[3].init.cache, 'no-cache');
  assert.ok(calls.every(({ url }) => !url.includes('Ukraine') && !new URL(url, 'https://fixture.invalid').searchParams.has('q')));
  env.feed.destroy(); assert.equal(env.windowEvents.size, 0);
});

test('closing or hiding during body loading prevents late publication and permits a clean retry', async () => {
  const body = Promise.withResolvers(), reading = Promise.withResolvers(); let signal, requests = 0;
  const env = environment(async (_url, init) => {
    requests++; signal = init.signal;
    return { ok: true, json: () => { reading.resolve(); return requests === 1 ? body.promise : Promise.resolve(payload); } };
  });
  const opening = env.feed.open(); await reading.promise;
  env.feed.close(); assert.equal(signal.aborted, true); body.resolve(payload);
  assert.equal(await opening, false);
  assert.equal(env.feed.getState().payload, null);
  assert.equal(env.timers.size, 0);
  assert.equal(await env.feed.open(), true); assert.equal(requests, 2);
  env.feed.destroy();
});

test('new filters cancel an older response, encode only bounded API filters, and preserve explicit source errors', async () => {
  const old = Promise.withResolvers(), began = Promise.withResolvers(); let requests = 0, oldSignal, lastUrl;
  const env = environment(async (url, { signal }) => {
    requests++; lastUrl = url;
    if (requests === 1) { oldSignal = signal; began.resolve(); return { ok: true, json: () => old.promise }; }
    return Response.json({ error: 'Use a valid two-letter country code' }, { status: 400 });
  });
  const first = env.feed.open(); await began.promise;
  const second = env.feed.setFilters({ category: 'economy', country: 'XX', q: 'port trade' });
  assert.equal(oldSignal.aborted, true); old.resolve(payload);
  assert.equal(await first, false); assert.equal(await second, false);
  assert.equal(env.feed.getState().payload, null);
  assert.match(env.feed.getState().error, /two-letter country/);
  const url = new URL(lastUrl, 'https://earth-observer.test');
  assert.equal(url.pathname, '/api/intelligence');
  assert.equal(url.searchParams.get('category'), 'economy');
  assert.equal(url.searchParams.has('q'), false);
  assert.equal(env.timers.size, 1);
  env.feed.destroy();
});

test('links accept only publisher HTTP(S) URLs and timestamps never invent unavailable dates', () => {
  assert.equal(safeIntelligenceUrl('javascript:alert(1)'), null);
  assert.equal(safeIntelligenceUrl('data:text/html,unsafe'), null);
  assert.equal(safeIntelligenceUrl('https://name:password@example.test/'), null);
  assert.equal(safeIntelligenceUrl('https://publisher.example/report'), 'https://publisher.example/report');
  assert.equal(intelligenceTime(null), null);
  assert.equal(intelligenceTime('not a date'), null);
  assert.equal(intelligenceTime('2026-10-11T09:30:00Z'), '2026-10-11 09:30:00 UTC');
});

test('topic mentions label countries and batch dates explicitly and cannot acquire map navigation from accidental coordinates', () => {
  const detail = intelligenceReportDetails({ kind: 'topic-mention', source: 'publisher.example', mentionedCountries: ['BE', 'DE'],
    publisherCountry: null, publishedAt: null, observedAt: null, indexedAt: '2026-10-11T10:00:00.000Z', lat: 50, lon: 4 });
  assert.match(detail.countries, /Countries mentioned: Belgium, Germany/);
  assert.match(detail.countries, /do not establish an incident location/); assert.doesNotMatch(detail.source, /publisher country/);
  assert.equal(detail.canNavigate, false); assert.equal(detail.dates.find(([label]) => label === 'GDELT batch')[1], '2026-10-11T10:00:00.000Z');
  assert.equal(detail.dates.find(([label]) => label === 'Published')[1], null);
  assert.equal(intelligenceReportDetails({ source: 'USGS', lat: 50, lon: 4 }).canNavigate, true);
});

test('saved browser reports retain their age and revalidation replaces them only while the panel is open', async () => {
  let callback, requests = 0, unsubscribed = false;
  const fetchImpl = async () => {
    requests++;
    return Response.json(payload, { headers: requests === 1 ? { 'x-browser-cache': 'STALE', 'x-browser-cached-at': '1000' } : {} });
  };
  fetchImpl.subscribe = (listener) => { callback = listener; return () => { unsubscribed = true; }; };
  const env = environment(fetchImpl);
  await env.feed.open();
  assert.equal(env.feed.getState().refreshedAt, 1000);
  assert.equal(env.feed.getState().payload.sources[0].stale, true);
  assert.match(env.feed.getState().payload.sources[0].reason, /Saved browser copy/);
  callback('http://localhost/api/intelligence?category=all'); await settle();
  assert.equal(requests, 2); assert.equal(env.feed.getState().payload.sources[0].stale, undefined);
  env.feed.close(); callback('http://localhost/api/intelligence?category=all'); await settle(); assert.equal(requests, 2);
  env.feed.destroy(); assert.equal(unsubscribed, true);
});

function indexedPayload() {
  const retrievedAt = new Date(100000).toISOString();
  const records = [{ id: 'ukraine-trade', sourceId: 'gdelt', kind: 'topic-mention', source: 'world.example',
    url: 'https://world.example/article', category: 'economy', themes: ['WB_698_TRADE', 'SANCTIONS'],
    mentionedCountries: ['UA'], indexedAt: retrievedAt, retrievedAt },
  { id: 'belgium-fire', sourceId: 'gdelt', kind: 'topic-mention', source: 'regional.example',
    url: 'https://regional.example/article', category: 'disasters', themes: ['DISASTER_FIRE'],
    mentionedCountries: ['BE'], indexedAt: retrievedAt, retrievedAt }];
  return { ...payload, reports: records, indexRecords: records, indexCoverage: { schemaVersion: 1,
    sources: [{ id: 'gdelt', generation: 'one', expiresAt: new Date(100000 + 86400000).toISOString(), coverage: 'Reviewed topic metadata' }] } };
}
test('country names, topics and publisher domains search all indexed metadata without another request or transmitting free text', async () => {
  const urls = [], env = environment(async (url) => { urls.push(url); return Response.json(indexedPayload()); });
  await env.feed.open();
  await env.feed.setFilters({ category: 'all', q: 'Ukraine trade' });
  assert.deepEqual(env.feed.getState().payload.reports.map((report) => report.id), ['ukraine-trade']);
  assert.ok(env.feed.getState().payload.reports[0].matchReasons.some((reason) => reason.includes('Country mentioned')));
  await env.feed.setFilters({ category: 'all', q: 'regional.example' });
  assert.deepEqual(env.feed.getState().payload.reports.map((report) => report.id), ['belgium-fire']);
  assert.equal(urls.length, 1); assert.equal(new URL(urls[0], 'https://example.test').searchParams.has('q'), false);
  assert.equal(env.feed.getState().payload.indexedRecords, 2);
  await env.feed.setFilters({ category: 'all', q: 'WB_698_TRADE' });
  assert.equal(env.feed.getState().filters.q, 'Trade');
  assert.equal(env.feed.getState().error, null);
  assert.deepEqual(env.feed.getState().payload.reports.map((report) => report.id), ['ukraine-trade']);
  await env.feed.setFilters({ category: 'all', q: '' });
  assert.deepEqual(env.feed.getState().payload.reports.map((report) => report.id), ['ukraine-trade', 'belgium-fire']);
  assert.equal(urls.length, 1); env.feed.destroy();
});
test('a query changed during acquisition uses the new local query without aborting or duplicating the shared fetch', async () => {
  const body = Promise.withResolvers(), began = Promise.withResolvers(); let count = 0, signal;
  const env = environment(async (_url, init) => { count++; signal = init.signal; began.resolve(); return { ok: true, json: () => body.promise }; });
  const opening = env.feed.open(); await began.promise;
  const searching = env.feed.setFilters({ category: 'all', q: 'Ukraine' });
  assert.equal(signal.aborted, false); assert.equal(count, 1);
  body.resolve(indexedPayload()); await Promise.all([opening, searching]);
  assert.deepEqual(env.feed.getState().payload.reports.map((report) => report.id), ['ukraine-trade']); env.feed.destroy();
});
test('local searches discard expired metadata and invalid text cannot trigger requests', async () => {
  let count = 0; const env = environment(async () => { count++; return Response.json(indexedPayload()); });
  await env.feed.open(); env.feed.close(); env.advance(86400001);
  await env.feed.setFilters({ category: 'all', q: 'Ukraine' });
  assert.equal(env.feed.getState().payload.reports.length, 0); assert.equal(env.feed.getState().payload.indexedRecords, 0);
  assert.equal(count, 1);
  assert.equal(await env.feed.setFilters({ category: 'all', q: '<private>' }), false);
  assert.match(env.feed.getState().error, /Search needs/); assert.equal(count, 1); env.feed.destroy();
});
test('clearing a local search cannot resurrect expired grouped cards or related source links', async () => {
  const incoming = indexedPayload();
  // One GKG batch expires before the next coarse feed-refresh boundary.
  incoming.indexRecords[0].indexedAt = new Date(100000 - 86400000 + 60000).toISOString();
  incoming.reports = [{ ...incoming.indexRecords[0], relatedReports: [incoming.indexRecords[1]] }];
  const env = environment(async () => Response.json(incoming)); await env.feed.open();
  assert.equal(env.feed.getState().payload.reports[0].id, 'ukraine-trade');
  env.advance(120000); await env.feed.setFilters({ category: 'all', q: '' });
  assert.equal(env.feed.getState().payload.indexedRecords, 1);
  assert.equal(env.feed.getState().payload.reports[0].id, 'belgium-fire');
  assert.deepEqual(env.feed.getState().payload.reports[0].relatedReports, []);
  await env.feed.setFilters({ category: 'all', q: 'Ukraine' });
  assert.equal(env.feed.getState().payload.reports.length, 0);
  await env.feed.setFilters({ category: 'all', q: '' });
  assert.deepEqual(env.feed.getState().payload.reports.map((report) => report.id), ['belgium-fire']); env.feed.destroy();
});
test('reopening after expiry and a failed refresh removes old cards and local searches preserve the failure warning', async () => {
  let requests = 0;
  const env = environment(async () => { if (++requests > 1) throw new Error('Source refresh failed'); return Response.json(indexedPayload()); });
  await env.feed.open(); env.feed.close(); env.advance(86400001);
  assert.equal(await env.feed.open(), false);
  assert.equal(env.feed.getState().payload.reports.length, 0);
  assert.equal(env.feed.getState().payload.indexedRecords, 0);
  assert.equal(env.feed.getState().payload.sources[0].status, 'stale');
  assert.equal(env.feed.getState().payload.sources[0].stale, true);
  await env.feed.setFilters({ category: 'all', q: 'Trade' });
  await env.feed.setFilters({ category: 'all', q: '' });
  assert.equal(env.feed.getState().payload.reports.length, 0);
  assert.match(env.feed.getState().error, /Source refresh failed/);
  assert.equal(requests, 2); env.feed.destroy();
});
test('local hazard searches retain related source links and each original observation date', async () => {
  const stamp = new Date(100000).toISOString();
  const records = ['usgs', 'gdacs'].map((sourceId) => ({ id: sourceId, sourceId, kind: 'hazard-report',
    title: 'Earthquake report', url: `https://${sourceId}.example/report`, source: sourceId,
    category: 'disasters', eventType: 'EQ', lat: 42, lon: 4, observedAt: stamp, retrievedAt: stamp }));
  const incoming = { ...payload, reports: records, indexRecords: records, indexCoverage: { schemaVersion: 1,
    sources: records.map(({ sourceId }) => ({ id: sourceId, generation: 'one', expiresAt: new Date(86500000).toISOString() })) } };
  const env = environment(async () => Response.json(incoming)); await env.feed.open();
  await env.feed.setFilters({ category: 'all', q: 'Earthquake' });
  const result = env.feed.getState().payload;
  assert.equal(result.matchCount, 2); assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].relatedReports.length, 1);
  assert.equal(result.reports[0].observedAt, stamp); assert.equal(result.reports[0].relatedReports[0].observedAt, stamp);
  assert.match(result.reports[0].relatedReports[0].relatedReason, /may use the same measurements/); env.feed.destroy();
});
