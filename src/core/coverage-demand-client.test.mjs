import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageDemandClient } from './coverage-demand-client.js';

function fixture(options = {}) {
  let clock = 0, live = true; const timers = new Map(), calls = [], document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const client = createCoverageDemandClient({ baseUrl: '/earth/', now: () => clock, documentRef: document, isLive: () => live,
    getDemand: () => ({ tier: 'region', center: { lon: 4.3, lat: 50.8 } }),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 202 }); },
    schedule(fn, delay) { const id = Symbol(); timers.set(id, { fn, at: clock + delay }); return id; }, cancel(id) { timers.delete(id); }, ...options });
  return { client, calls, document, setLive(value) { live = value; }, async tick(ms) { clock += ms;
    const due = [...timers].filter(([, item]) => item.at <= clock); for (const [id, item] of due) { timers.delete(id); item.fn(); }
    await new Promise(resolve => setImmediate(resolve)); } };
}
test('one functional owner coalesces camera updates, renews bounded interest, and sends no raw coordinate/identity', async () => {
  const f = fixture(); for (let i = 0; i < 300; ++i) f.client.changed(); await f.tick(400);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/earth/api/coverage/demand');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { schemaVersion: 1, reason: 'viewport', sectors: [103] });
  assert.equal(f.calls[0].init.credentials, 'omit');
  for (let i = 0; i < 100; ++i) f.client.changed(); await f.tick(59000); assert.equal(f.calls.length, 1);
  await f.tick(1000); assert.equal(f.calls.length, 2); f.client.destroy(); await f.tick(60000); assert.equal(f.calls.length, 2);
});
test('QA, hidden, history and world views submit no functional demand', async () => {
  for (const options of [{ enabled: false }, { getDemand: () => ({ tier: 'world', center: { lon: 0, lat: 0 } }) }]) {
    const f = fixture(options); f.client.changed(); await f.tick(60000); assert.equal(f.calls.length, 0); f.client.destroy(); }
  const f = fixture(); f.document.hidden = true; f.client.changed(); await f.tick(60000); assert.equal(f.calls.length, 0);
  f.document.hidden = false; f.setLive(false); f.client.changed(); await f.tick(60000); assert.equal(f.calls.length, 0); f.client.destroy();
});
