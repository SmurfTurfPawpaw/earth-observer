import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStore } from './browser-store.js';
import { createCachedFetch } from './cached-fetch.js';
import { validateArea, inLocalArea, localCameraView } from './local-area.js';
import { loadSession, saveSession, initialWorkspace, locateVisitor, SESSION_KEY } from './session.js';
import { normalizeEvidence } from './evidence.js';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-feed-age-ms': '3000' } });
test('reload restores cached observations immediately, marks their age, and coalesces background updates', async () => {
  const store = createBrowserStore(null); let clock = 100000, calls = 0;
  const second = Promise.withResolvers();
  const fetch = createCachedFetch({ origin: 'https://test.example', store, now: () => clock, fetchImpl: async () => { calls++; return calls === 1 ? response({ value: 1 }) : second.promise; } });
  assert.equal((await (await fetch('/api/flights?lat=4&lon=5')).json()).value, 1);
  clock += 5000;
  const hit = await fetch('/api/flights?lat=4&lon=5'); assert.equal(hit.headers.get('x-browser-cache'), 'HIT'); assert.equal(hit.headers.get('x-feed-age-ms'), '8000'); assert.equal(calls, 1);
  clock += 20000;
  const updated = Promise.withResolvers(); fetch.subscribe(updated.resolve);
  const [stale, shared] = await Promise.all([fetch('/api/flights?lat=4&lon=5'), fetch('/api/flights?lat=4&lon=5')]);
  assert.equal(stale.headers.get('x-browser-cache'), 'STALE'); assert.equal(shared.headers.get('x-feed-cache'), 'STALE'); assert.equal(calls, 2);
  second.resolve(response({ value: 2 })); await updated.promise;
  assert.equal((await (await fetch('/api/flights?lat=4&lon=5')).json()).value, 2); fetch.destroy();
});
test('offline restore never reports fresh contact and expired observations cannot be replayed', async () => {
  let clock = 100000, connected = true, calls = 0;
  const fetch = createCachedFetch({ store: createBrowserStore(null), origin: 'https://test.example', now: () => clock, online: () => connected, fetchImpl: async () => { calls++; if (!connected) throw new Error('offline'); return response({}); } });
  await fetch('/api/flights?lat=4&lon=5'); connected = false; clock += 20000;
  assert.equal((await fetch('/api/flights?lat=4&lon=5')).headers.get('x-browser-cache'), 'OFFLINE'); assert.equal(calls, 1);
  clock += 400000; await assert.rejects(fetch('/api/flights?lat=4&lon=5'), /offline/); fetch.destroy();
});
test('authenticated requests and camera frames bypass persistent snapshots', async () => {
  let calls = 0; const fetch = createCachedFetch({ store: createBrowserStore(null), fetchImpl: async () => { calls++; return response({}); } });
  await fetch('/api/flights?lat=4&lon=5', { headers: { Authorization: 'test' } }); await fetch('/api/flights?lat=4&lon=5', { headers: { Authorization: 'test' } });
  await fetch('/api/cctv/frame/test'); await fetch('/api/cctv/frame/test'); assert.equal(calls, 4); fetch.destroy();
});
test('shared views take priority, local sessions restore, and first visitors request permission without blocking the globe', async () => {
  const data = new Map(), storage = { setItem: (key, value) => data.set(key, value), getItem: (key) => data.get(key) };
  const area = validateArea({ lat: 50.85031, lon: 4.35171, radiusKm: 10 }), view = localCameraView(area);
  saveSession(view, area, storage); const saved = loadSession(storage);
  assert.deepEqual(saved.area, area); assert.deepEqual(initialWorkspace('', saved, []).view, view);
  const shared = initialWorkspace('#lat=5&lon=6&layers=', saved, []); assert.equal(shared.view.lat, 5); assert.equal(shared.area, null); assert.equal(shared.requestLocation, false);
  assert.equal(initialWorkspace('', null, []).requestLocation, true);
  const result = await locateVisitor({ geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 50.85031, longitude: 4.35171, accuracy: 60 } }) } }); assert.equal(result.lat, 50.85);
  await assert.rejects(locateVisitor({ geolocation: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) } }), /not shared/);
});

test('session v3 retains paused historical UTC/lens/rate; explicit legacy and v4 time-only links outrank saved History', () => {
  const values = new Map(), storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) };
  const options = { now: Date.parse('2026-10-12T06:00:00.000Z') }, temporal = { mode: 'history', at: '2025-11-15T12:00:00.123Z', lens: 'known-then', rate: 86400 };
  const view = localCameraView({ lat: 50.85, lon: 4.35, radiusKm: 10 });
  saveSession(view, null, storage, { ...temporal, playing: true }, options); const saved = loadSession(storage, options);
  assert.equal(saved.version, 3); assert.deepEqual(saved.temporal, temporal); assert.equal(Object.hasOwn(saved.temporal, 'playing'), false);
  assert.deepEqual(initialWorkspace('', saved, [], options).temporal, temporal);
  for (const hash of ['#v=1&lat=4', '#v=3&layers=']) assert.deepEqual(initialWorkspace(hash, saved, [], options).temporal, { mode: 'live' });
  const timeOnly = initialWorkspace('#v=4&mode=history&at=2025-11-14T12:00:00.456Z&lens=reconstruction&rate=60', saved, [], options);
  assert.equal(timeOnly.requestLocation, false); assert.equal(timeOnly.temporal.at, '2025-11-14T12:00:00.456Z');
  assert.throws(() => initialWorkspace('#v=4&mode=history&at=bad&lens=unknown', saved, [], options), /History/);
  values.set(SESSION_KEY, JSON.stringify({ ...saved, temporal: { ...temporal, at: '2027-01-01T00:00:00.000Z' } }));
  assert.throws(() => initialWorkspace('', loadSession(storage, options), [], options), /Saved workspace.*Future/);
  assert.deepEqual(initialWorkspace('#v=3&layers=', loadSession(storage, options), [], options).temporal, { mode: 'live' });
  saveSession(view, null, storage, { mode: 'live', at: temporal.at }, options);
  assert.deepEqual(loadSession(storage, options).temporal, { mode: 'live' });
  values.set(SESSION_KEY, JSON.stringify({ version: 2, view, area: null })); assert.deepEqual(loadSession(storage, options).temporal, { mode: 'live' });
  saveSession({ ...view, roll: 359 }, null, storage, temporal, options); assert.equal(loadSession(storage, options).view.roll, -1);
});
test('local circles include nearby records across the date line and reject distant points', () => {
  const area = validateArea({ lat: 0, lon: 179.99, radiusKm: 10 });
  assert.equal(inLocalArea(0, -179.99, area), true); assert.equal(inLocalArea(0, 170, area), false); assert.equal(validateArea({ lat: 100, lon: 0 }), null);
});
test('evidence retains source links and uncertainty, bounds fields and rejects executable links', () => {
  const record = normalizeEvidence({ title: ' A report ', note: 'source note', sourceUrl: 'https://example.com/report', location: { lat: 4.123456, lon: 5.123456 } }, { id: 'test', now: 0 });
  assert.equal(record.title, 'A report'); assert.equal(record.verification, 'User note; unverified'); assert.equal(record.location.lat, 4.123); assert.equal(record.createdAt, '1970-01-01T00:00:00.000Z');
  assert.throws(() => normalizeEvidence({ title: 'test', note: 'test', sourceUrl: 'javascript:alert(1)' }), /public HTTP/);
  assert.throws(() => normalizeEvidence({ title: 'test', note: '' }), /note or photograph/);
});

test('production-lowered evidence IDs can be generated without injected test identities', async () => {
  const source = await readFile(new URL('./evidence.js', import.meta.url), 'utf8');
  const { code } = await transform(source, { format: 'esm', target: 'es2019', minify: true });
  const compiled = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const first = compiled.normalizeEvidence({ title: 'Test', note: 'Private test note' });
  const second = compiled.normalizeEvidence({ title: 'Test', note: 'Private test note' });
  assert.match(first.id, /^[a-f0-9-]{36}$/i);
  assert.notEqual(first.id, second.id);
});
