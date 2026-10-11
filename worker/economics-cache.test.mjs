import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarthRuntime } from './index.js';

const AT = Date.parse('2026-10-11T00:00:00Z');
const request = () => new Request('https://example.com/earth/api/economics?country=BE');
const fixture = [{ page: 1, pages: 1, total: 1, sourceid: null, lastupdated: '2026-10-08' },
  [{ indicator: { id: 'NY.GDP.MKTP.CD' }, countryiso3code: 'BEL', date: '2025', value: 123 }]];

test('Worker economics persists only bounded annual country observations and cold runtimes reuse R2', async () => {
  const records = new Map(), paths = [];
  const env = { EARTH_STORE: {
    async get(path) { paths.push(path); const saved = records.get(path); return saved ? { json: async () => JSON.parse(saved) } : null; },
    async put(path, value) { records.set(path, value); },
  } };
  let calls = 0;
  const first = createEarthRuntime({ now: () => AT, cache: null, fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual'); return Response.json(fixture);
  } });
  const original = await (await first.fetch(request(), env)).json(); first.close();
  assert.equal(original.status, 'ready'); assert.equal(calls, 1); assert.equal(records.size, 1);
  const key = 'providers/economics%3Aannual%3ABEL.json';
  const saved = JSON.parse(records.get(key));
  assert.equal(saved.country, 'BEL'); assert.equal(saved.observations.length, 1);
  assert.equal(saved.source, undefined); assert.equal(saved.indicators, undefined);
  const cold = createEarthRuntime({ now: () => AT + 600000, cache: null, fetchImpl: async () => { calls++; throw new Error('Cold cache should suffice'); } });
  const response = await cold.fetch(request(), env), restored = await response.json();
  assert.equal(restored.status, 'ready'); assert.equal(restored.retrievedAt, original.retrievedAt);
  assert.equal(restored.source.ageMs, 600000); assert.equal(response.headers.get('x-feed-age-ms'), '600000');
  assert.equal(calls, 1); assert.ok(paths.every((path) => path === key)); cold.close();
});

test('Worker economics edge hits expose current retrieval age without altering observation dates', async () => {
  let at = AT, saved, calls = 0;
  const cache = { async match() { return saved?.clone(); }, async put(_key, response) { saved = response; } };
  const runtime = createEarthRuntime({ cache, now: () => at, fetchImpl: async () => { calls++; return Response.json(fixture); } });
  const original = await (await runtime.fetch(request())).json();
  at += 300000;
  const hit = await runtime.fetch(request()), payload = await hit.json();
  assert.equal(calls, 1); assert.equal(hit.headers.get('x-feed-age-ms'), '300000');
  assert.equal(payload.retrievedAt, original.retrievedAt);
  assert.equal(payload.source.ageCalculatedAt, new Date(AT).toISOString(), 'JSON age identifies its calculation time');
  assert.equal(payload.indicators[0].year, 2025); runtime.close();
});
