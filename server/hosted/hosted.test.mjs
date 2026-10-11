import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMiddlewareStack } from './middleware.js';
import { createHostedServer } from '../index.js';
import { aircraftProxy } from './aircraft.js';
import { celestrakProxy } from '../providers/space/celestrak.js';
import { hostedProviders } from './providers.js';

async function withServer(providers, fn, distDir) {
  const server = createHostedServer({ providers, distDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

test('middleware preserves mount queries, restores URLs for next and respects path boundaries', async () => {
  const stack = createMiddlewareStack(), seen = [];
  stack.use('/api/feed', (req, res, next) => { seen.push(req.url); return next(); });
  stack.use((req, res) => { seen.push(req.url); res.writableEnded = true; });
  await stack.handle({ url: '/api/feed?x=1' }, {}, () => assert.fail());
  assert.deepEqual(seen, ['/?x=1', '/api/feed?x=1']); seen.length = 0;
  await stack.handle({ url: '/api/feed-other' }, {}, () => assert.fail());
  assert.deepEqual(seen, ['/api/feed-other']);
});

test('the default production provider set mounts economics and validates its filters before acquisition', async () => {
  await withServer(hostedProviders(), async (url) => {
    const response = await fetch(url + '/api/economics?country=BE&unexpected=1');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Unknown or repeated/);
    assert.equal((await fetch(url + '/api/economics/unlisted')).status, 404);
  });
});

test('production serves only the build with headers, correct gzip and API method restrictions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'earth-hosted-'));
  try {
    const dist = path.join(root, 'dist'); await mkdir(dist);
    await writeFile(path.join(dist, 'index.html'), '<title>Earth Observer</title>');
    await writeFile(path.join(root, '.env'), 'PRIVATE=secret');
    await withServer([], async (url) => {
      const response = await fetch(url);
      assert.equal(response.status, 200); assert.match(await response.text(), /Earth Observer/);
      assert.equal(response.headers.get('content-encoding'), 'gzip');
      assert.equal((await fetch(url, { headers: { 'Accept-Encoding': 'gzip;q=0' } })).headers.get('content-encoding'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      for (const file of ['/.env', '/%2e%2e/.env', '/api/setup/keys', '/server/index.js', '/missing'])
        assert.equal((await fetch(url + file)).status, 404, file);
      assert.equal((await fetch(url + '/api/firms', { method: 'POST' })).status, 405);
      assert.deepEqual(await (await fetch(url + '/healthz')).json(), { status: 'ok' });
    }, dist);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aircraft requests coalesce, validate coordinates and serve stale without retry storms', async () => {
  let requests = 0, clock = 100000, fail = false;
  const plugin = aircraftProxy({ now: () => clock, fetchImpl: async () => {
    requests++; await new Promise((resolve) => setTimeout(resolve, 15));
    return fail ? new Response('', { status: 503 }) : Response.json({ ac: [{ hex: 'abc123' }] });
  } });
  await withServer([plugin], async (url) => {
    const endpoint = url + '/api/flights?lat=50.8&lon=4.3';
    const results = await Promise.all(Array.from({ length: 6 }, () => fetch(endpoint)));
    assert.ok(results.every((response) => response.status === 200)); assert.equal(requests, 1);
    assert.equal((await fetch(url + '/api/flights?lat=999&lon=2')).status, 400);
    assert.equal((await fetch(endpoint)).headers.get('x-feed-cache'), 'HIT');
    fail = true; clock += 31000;
    assert.equal((await fetch(endpoint)).headers.get('x-feed-cache'), 'STALE');
    await fetch(endpoint); assert.equal(requests, 2);
    assert.equal((await fetch(url + '/api/military')).status, 503);
    await fetch(url + '/api/military'); assert.equal(requests, 3);
  });
});

test('CelesTrak rejects unknown groups, coalesces initial loads and persists stops across restarts', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'earth-tle-'));
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests++; assert.equal(options.redirect, 'manual'); return new Response('', { status: 301 });
  };
  try {
    await withServer([celestrakProxy({ cacheDir, fetchImpl })], async (url) => {
      assert.equal((await fetch(url + '/api/celestrak/arbitrary')).status, 400);
      const results = await Promise.all(Array.from({length: 5}, () => fetch(url + '/api/celestrak/stations')));
      assert.ok(results.every((response) => response.status === 503)); assert.equal(requests, 1);
      await fetch(url + '/api/celestrak/visual'); assert.equal(requests, 1);
    });
    await withServer([celestrakProxy({ cacheDir, fetchImpl })], async (url) => {
      await Promise.all(['stations', 'visual'].map((group) => fetch(url + '/api/celestrak/' + group)));
      assert.equal(requests, 1);
    });
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
