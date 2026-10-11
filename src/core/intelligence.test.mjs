import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligenceFeed, safeIntelligenceUrl, intelligenceTime } from './intelligence.js';

const payload = { reports: [{ id: 'one', title: 'Linked report', url: 'https://example.test/' }], sources: [{ id: 'gdelt', status: 'ready' }], nextRefreshMs: 300000 };
function environment(fetchImpl) {
  const events = new Map(), timers = new Map(); let clock = 100000, nextTimer = 0;
  const states = [], documentRef = { hidden: false, addEventListener: (name, callback) => events.set(name, callback), removeEventListener: (name) => events.delete(name) };
  const feed = createIntelligenceFeed({ fetchImpl, documentRef, now: () => clock, onChange: (state) => states.push(state),
    setTimeoutImpl: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeoutImpl: (id) => timers.delete(id) });
  return { feed, timers, states, documentRef, events, advance: (ms) => { clock += ms; }, visibility: () => events.get('visibilitychange')?.() };
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('only an opened visible panel fetches, cache survives close, and refresh timers use the remaining freshness interval', async () => {
  let requests = 0;
  const env = environment(async () => { requests++; return Response.json(payload); });
  assert.equal(requests, 0);
  assert.equal(await env.feed.refresh(), false);
  await env.feed.open(); assert.equal(requests, 1); assert.equal(env.timers.size, 1);
  env.feed.close(); assert.equal(env.timers.size, 0);
  env.advance(100000); await env.feed.open(); assert.equal(requests, 1);
  assert.equal([...env.timers.values()][0].delay, 200000);
  env.documentRef.hidden = true; env.visibility();
  assert.equal(env.timers.size, 0); assert.equal(await env.feed.refresh(true), false);
  env.advance(300000); env.documentRef.hidden = false; env.visibility(); await settle();
  assert.equal(requests, 2);
  env.feed.destroy(); assert.equal(env.timers.size, 0); assert.equal(env.events.size, 0);
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
  assert.equal(url.searchParams.get('q'), 'port trade');
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
