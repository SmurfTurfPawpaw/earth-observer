import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateEonetSnapshot, writeEonetSnapshot, loadEonetRetryState } from './eonet-snapshot.mjs';
import { EONET_QUERY_URL, EONET_UPSTREAM_MAX_BYTES, EONET_SNAPSHOT_MAX_BYTES } from '../server/hosted/eonet-snapshot.js';
const at = Date.parse('2026-10-11T12:00:00.000Z');
const event = { id: 'EONET_1', title: 'Synthetic volcano reference', closed: null,
  categories: [{ id: 'volcanoes', title: 'Volcanoes' }], sources: [{ id: 'SIVolcano', url: 'https://volcano.si.edu/' }], geometry: [{ date: '2026-10-10T00:00:00Z', coordinates: [1, 2] }] };
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-cache' } });

test('generation performs exactly one fixed uncached request, copies only approved metadata and records completion time', async () => {
  let calls = 0, clock = at;
  const result = await generateEonetSnapshot({ now: () => clock, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, EONET_QUERY_URL); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit');
    clock += 25; return response({ events: [event], description: 'Raw provider description' });
  } });
  assert.equal(result.status, 'generated'); assert.equal(calls, 1); assert.ok(result.bytes.byteLength <= EONET_SNAPSHOT_MAX_BYTES);
  assert.equal(result.snapshot.retrievedAt, new Date(at + 25).toISOString()); assert.equal(result.retryState.lastAttemptAt, new Date(at).toISOString());
  assert.equal(result.retryState.lastSuccessAt, result.snapshot.retrievedAt); assert.equal(result.retryState.failures, 0);
  assert.equal(new TextDecoder().decode(result.bytes).includes('"coordinates"'), false);
});

test('the observed RSS media-type exception still requires valid JSON and the full fixed-endpoint schema', async () => {
  let calls = 0;
  const result = await generateEonetSnapshot({ now: () => at, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, EONET_QUERY_URL); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ events: [event] }), { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'generated'); assert.equal(result.snapshot.records.length, 1);
  assert.deepEqual(result.upstream, { status: 200, mediaType: 'application/rss+xml' });
  assert.equal(result.snapshot.records[0].sourceId, 'eonet'); assert.equal(result.snapshot.records[0].sourceGeometryAt, '2026-10-10T00:00:00.000Z');
});

test('XML, HTML, invalid JSON metadata and unknown media types preserve last-good bytes with bounded body-free diagnostics', async () => {
  const root = path.resolve(tmpdir()), directory = await mkdtemp(path.join(root, 'earth-eonet-'));
  assert.ok(directory.startsWith(root + path.sep)); assert.match(path.basename(directory), /^earth-eonet-/);
  try {
    const good = await generateEonetSnapshot({ now: () => at, fetchImpl: async () => response({ events: [event] }) });
    const destination = await writeEonetSnapshot(directory, good), original = await readFile(destination, 'utf8');
    for (const [mediaType, body] of [
      ['application/rss+xml', '<rss><channel>synthetic body must stay private</channel></rss>'],
      ['application/rss+xml', '<html>synthetic body must stay private</html>'],
      ['text/html', '<html>synthetic body must stay private</html>'],
      ['application/rss+xml', JSON.stringify({ events: [{ ...event, id: 'invalid' }] })],
      ['application/rss+xml-extra', JSON.stringify({ events: [event] })],
      [`application/${'x'.repeat(1000)}`, JSON.stringify({ events: [event] })],
    ]) {
      let calls = 0;
      const failed = await generateEonetSnapshot({ now: () => at, fetchImpl: async () => {
        calls++; return new Response(body, { status: 200, headers: { 'content-type': mediaType } });
      } });
      assert.equal(calls, 1); assert.equal(failed.status, 'skipped'); assert.equal(failed.bytes, undefined);
      assert.equal(failed.upstream.status, 200); assert.equal(failed.upstream.mediaType, mediaType.slice(0, 80));
      assert.ok(failed.reason.length <= 190); assert.equal(JSON.stringify(failed).includes('synthetic body must stay private'), false);
      assert.equal(await writeEonetSnapshot(directory, failed), false); assert.equal(await readFile(destination, 'utf8'), original);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rate-limit Retry-After persists across scheduled runs with no immediate retry or fanout', async () => {
  let calls = 0;
  const result = await generateEonetSnapshot({ now: () => at, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '7200' } }); } });
  assert.equal(result.status, 'skipped'); assert.equal(result.retryState.retryAt, at + 7200000); assert.equal(calls, 1);
  const skipped = await generateEonetSnapshot({ now: () => at + 1800000, previousRetryState: result.retryState, fetchImpl() { assert.fail('Backoff HTTP attempt'); } });
  assert.equal(skipped.status, 'skipped'); assert.deepEqual(skipped.retryState, result.retryState);
  const prior = { ...result.retryState, retryAt: at, failures: 3 };
  const failed = await generateEonetSnapshot({ now: () => at, previousRetryState: prior, fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(failed.retryState.retryAt, at + 2400000);
});

test('oversized streams, invalid metadata, redirects and timeouts skip publication with one attempt', async () => {
  for (const fetchImpl of [
    async () => new Response(new Uint8Array(EONET_UPSTREAM_MAX_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
    async () => response({ events: Array.from({ length: 61 }, () => event) }),
    async () => response({ events: [{ ...event, geometry: [{ date: '2026-10-12T00:00:00Z' }] }] }),
    async () => { throw new TypeError('Redirect refused'); },
    async () => { throw new DOMException('Timed out', 'TimeoutError'); },
  ]) {
    let calls = 0; const result = await generateEonetSnapshot({ now: () => at, fetchImpl: (...args) => { calls++; return fetchImpl(...args); } });
    assert.equal(result.status, 'skipped'); assert.equal(calls, 1); assert.equal(result.bytes, undefined); assert.ok(result.retryState.retryAt > at);
  }
});

test('a normalized output exceeding its stricter bound is never published', async () => {
  const events = Array.from({ length: 60 }, (_, index) => ({ ...event, id: `EONET_${index}`, title: '長'.repeat(160),
    sources: Array.from({ length: 4 }, (_, source) => ({ id: `S${source}`, url: `https://example.com/${source}/${'x'.repeat(450)}` })) }));
  const result = await generateEonetSnapshot({ now: () => at, fetchImpl: async () => response({ events }) });
  assert.equal(result.status, 'skipped'); assert.match(result.reason, /oversized|100 KiB/);
});

test('skipped acquisition cannot overwrite an existing last-good local asset; retry-state reads are bounded', async () => {
  const root = path.resolve(tmpdir()), directory = await mkdtemp(path.join(root, 'earth-eonet-'));
  assert.ok(directory.startsWith(root + path.sep)); assert.match(path.basename(directory), /^earth-eonet-/);
  try {
    const result = await generateEonetSnapshot({ now: () => at, fetchImpl: async () => response({ events: [event] }) });
    const destination = await writeEonetSnapshot(directory, result), original = await readFile(destination, 'utf8');
    assert.equal(await writeEonetSnapshot(directory, { status: 'skipped' }), false); assert.equal(await readFile(destination, 'utf8'), original);
    const stateFile = path.join(directory, 'state.json'); await writeFile(stateFile, JSON.stringify(result.retryState));
    assert.deepEqual(await loadEonetRetryState(stateFile), result.retryState);
    await writeFile(stateFile, 'x'.repeat(8193)); assert.equal(await loadEonetRetryState(stateFile), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
