import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitService } from '../sources/transitService.js';

const request = (path, method = 'GET') => ({
  url: `https://example.test${path}`,
  method,
});

test('portable service confines requests to registered feeds and GET', async (t) => {
  let calls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  for (const path of [
    '/other',
    '/api/transit/vehicles/unknown',
    '/api/transit/vehicles/https%3A%2F%2Fexample.test',
  ]) {
    assert.equal((await service.handle(request(path))).status, 404);
  }
  for (const method of ['POST', 'HEAD', 'TRACE']) {
    assert.equal(
      (await service.handle(request('/api/transit/feeds', method))).status,
      405,
    );
  }
  const response = await service.handle(request('/api/transit/feeds'));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).feeds.some((feed) => feed.id === 'mbta'));
  assert.equal(calls, 0);
  service.close();
  assert.equal(
    (await service.handle(request('/api/transit/feeds'))).status,
    503,
  );
});
