import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { celestrakProxy } from './celestrak.js';
import { createSpaceHandler } from '../../../worker/space.js';

const TLE = 'TEST\n1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const START = Date.parse('2026-10-11T00:00:00Z');
function transport() {
  let clock = START, fail = false, calls = 0;
  return {
    now: () => clock,
    fetchImpl: async () => { calls++; return fail ? new Response('denied', { status: 403 }) : new Response(TLE); },
    advance: (ms) => { clock += ms; }, fail: () => { fail = true; },
    get calls() { return calls; },
  };
}
function assertProvenance(value, expectedStatus, age) {
  const header = (name) => value.headers.get(name);
  assert.equal(header('x-tle-cache'), expectedStatus);
  assert.equal(header('x-feed-retrieved-at'), new Date(START).toISOString());
  assert.equal(Number(header('x-feed-age-ms')), age);
}

test('Worker TLE persistence preserves acquisition dates through reuse, provider stop and cold restart', async () => {
  const data = new Map(), provider = transport();
  const store = { get: async (key) => data.get(key), put: async (key, value) => data.set(key, value), claim: async () => true };
  const request = new Request('https://example.com/api/celestrak/stations');
  const handler = createSpaceHandler({ ...provider, store });
  assertProvenance(await handler(request), 'MISS', 0);
  provider.advance(3600000);
  assertProvenance(await handler(request), 'HIT', 3600000);
  assert.equal(provider.calls, 1);
  provider.fail(); provider.advance(6 * 3600000);
  const retained = await handler(request);
  assert.equal(retained.status, 200);
  assert.equal(await retained.text(), TLE);
  assertProvenance(retained, 'STALE-ERROR', 7 * 3600000);
  const restarted = createSpaceHandler({ ...provider, store });
  assertProvenance(await restarted(request), 'STALE-ERROR', 7 * 3600000);
  assert.equal(provider.calls, 2);
});

function nodeHandler(plugin) {
  let handler;
  plugin.configurePreviewServer({ middlewares: { use: (_mount, callback) => { handler = callback; } } });
  return async () => {
    let status, headers, body;
    await handler({ url: '/stations' }, {
      writeHead: (code, values) => { status = code; headers = new Headers(values); },
      end: (text) => { body = text; },
    });
    return { status, headers, body };
  };
}

test('Node TLE disk cache exports the same unchanged source dates after failed acquisition and restart', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'earth-tle-provenance-'));
  const provider = transport();
  try {
    const handler = nodeHandler(celestrakProxy({ ...provider, cacheDir }));
    assertProvenance(await handler(), 'MISS', 0);
    provider.advance(3600000);
    assertProvenance(await handler(), 'HIT', 3600000);
    assert.equal(provider.calls, 1);
    provider.fail(); provider.advance(6 * 3600000);
    const retained = await handler();
    assert.equal(retained.body, TLE);
    assertProvenance(retained, 'STALE-ERROR', 7 * 3600000);
    const restarted = nodeHandler(celestrakProxy({ ...provider, cacheDir }));
    assertProvenance(await restarted(), 'STALE-ERROR', 7 * 3600000);
    assert.equal(provider.calls, 2);
  } finally {
    assert.equal(path.dirname(cacheDir), path.resolve(tmpdir()));
    await rm(cacheDir, { recursive: true, force: true });
  }
});
