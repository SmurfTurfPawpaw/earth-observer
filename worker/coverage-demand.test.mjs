import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageDemandHandler } from './coverage-demand.js';
const NOW = Date.parse('2026-10-12T12:00:00.000Z'), env = { EARTH_DB: { prepare() {}, batch() {} } };
const request = (body = { schemaVersion: 1, reason: 'viewport', sectors: [103] }, options = {}) => new Request('https://owned.example/api/coverage/demand', {
  method: 'POST', headers: { origin: 'https://owned.example', 'content-type': 'application/json', 'x-earth-client': 'interactive-viewport-v1', ...options.headers },
  body: JSON.stringify(body), ...options });

test('functional interest is coarse, bounded and expires independently of source collection', async () => {
  const queued = [];
  const handle = createCoverageDemandHandler({ now: () => NOW, admit: () => true,
    enqueue: async (_env, value) => { queued.push(value); return { configured: true, enqueued: true }; } });
  const response = await handle(request(), env), value = await response.json();
  assert.equal(response.status, 202); assert.equal(value.accepted, true);
  assert.deepEqual(queued, [{ sectorId: 103, reason: 'viewport', priority: 30, expiresAt: '2026-10-12T12:02:00.000Z' }]);
  assert.ok(!JSON.stringify(value).includes('identity'));
});
test('origin, fixed schema, request budget and body ceiling are admitted before database work', async () => {
  let writes = 0;
  const handle = createCoverageDemandHandler({ admit: () => true, enqueue: async () => { writes++; return { configured: true }; } });
  for (const value of [ { schemaVersion: 1, reason: 'urgent', sectors: [1] }, { schemaVersion: 1, reason: 'viewport', sectors: [1, 1] },
    { schemaVersion: 1, reason: 'viewport', sectors: [0] }, { schemaVersion: 1, reason: 'viewport', sectors: [1], lat: 50 },
    { schemaVersion: 1, reason: 'viewport', sectors: [1, 2, 3, 4, 5] } ]) assert.equal((await handle(request(value), env)).status, 400);
  assert.equal((await handle(request({}, { headers: { origin: 'https://other.example' } }), env)).status, 403);
  assert.equal((await handle(request('x'.repeat(513)), env)).status, 400);
  assert.equal((await createCoverageDemandHandler({ admit: () => false })(request(), env)).status, 429);
  assert.equal(writes, 0);
  assert.equal((await handle(new Request('https://owned.example/api/coverage/demand'), env)).status, 405);
  assert.equal(await handle(new Request('https://owned.example/api/other'), env), null);
});
