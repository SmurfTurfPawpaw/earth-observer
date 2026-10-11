import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCollector } from './index.js';
import { createCollectorDaemon, COLLECTOR_PUBLISH_URL } from '../scripts/collector-daemon.mjs';

test('only the scheduled collector action sends the fixed authenticated POST; state/backoff/status are bounded and secret-free', { timeout: 2000 }, async () => {
  let clock = Date.parse('2026-10-11T16:00:00Z'), calls = 0, writes = 0;
  const values = new Map(), writeTimes = new Map(), token = 'synthetic-secret-12345678901234567890';
  const env = { EARTH_TARGET_ORIGIN: 'https://giovannicallebaut.com', EARTH_COLLECTOR_TOKEN: token,
    COLLECTOR_STATE: { async get(key) { return values.get(key) ?? null; }, async put(key, value) {
      assert.ok(!writeTimes.has(key) || clock - writeTimes.get(key) >= 1000, 'same-key KV write must not occur twice within a second');
      writeTimes.set(key, clock); writes++; values.set(key, value);
    } } };
  const fetchImpl = async (address, options) => {
    calls++; assert.equal(address, 'https://giovannicallebaut.com/earth/api/collector'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.deepEqual(JSON.parse(options.body), { action: 'collect' });
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit');
    return calls === 1 ? Response.json({ checkedAt: new Date(clock).toISOString(), sources: [] }) : new Response('Synthetic rejected body', { status: 429, headers: { 'retry-after': '7200' } });
  };
  const collector = createCollector({ now: () => clock, fetchImpl });
  const beforeWrites = writes;
  for (const url of ['https://collector.example/status?target=https://attacker.example', 'https://collector.example/']) {
    const publicResponse = await collector.fetch(new Request(url), env); assert.equal(publicResponse.status, 200); assert.equal(calls, 0);
    assert.equal(JSON.stringify(await publicResponse.json()).includes(token), false);
  }
  assert.equal(writes, beforeWrites); assert.equal((await collector.fetch(new Request('https://collector.example/status', { method: 'POST' }), env)).status, 405);
  const results = await Promise.all(Array.from({ length: 8 }, () => collector.run(env))); assert.equal(calls, 1);
  for (const result of results) { assert.equal(result.outcome, 'accepted'); assert.equal(result.lastSuccessAt, new Date(clock).toISOString()); assert.equal(JSON.stringify(result).includes(token), false); }
  clock += 60000; const failed = await collector.run(env); assert.equal(calls, 2); assert.equal(failed.outcome, 'http-error'); assert.equal(failed.retryAt, new Date(clock + 7200000).toISOString());
  clock += 60000; const freshInstance = createCollector({ now: () => clock, fetchImpl });
  assert.equal((await freshInstance.run(env)).outcome, 'waiting'); assert.equal(calls, 2);
  for (const origin of ['https://attacker.example', 'https://giovannicallebaut.com.evil.example', 'http://giovannicallebaut.com', 'https://giovannicallebaut.com/earth/', 'https://user@giovannicallebaut.com', 'https://giovannicallebaut.com/?x=1'])
    assert.equal((await collector.run({ ...env, EARTH_TARGET_ORIGIN: origin })).outcome, 'invalid-configuration');
  assert.equal((await collector.run({ ...env, EARTH_COLLECTOR_TOKEN: undefined })).outcome, 'invalid-configuration'); assert.equal(calls, 2);
  const blocked = createCollector({ now: () => clock, storageTimeoutMs: 10, fetchImpl() { assert.fail('Storage-blocked request'); } });
  assert.equal((await blocked.run({ ...env, COLLECTOR_STATE: { get: () => new Promise(() => {}), put() {} } })).outcome, 'storage-unavailable');
  const timed = createCollector({ now: () => clock, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal((await timed.run({ ...env, COLLECTOR_STATE: undefined })).outcome, 'timeout');
  const blockedWrite = createCollector({ now: () => clock, storageTimeoutMs: 10, fetchImpl() { assert.fail('Storage-write-blocked request'); } });
  assert.equal((await blockedWrite.run({ ...env, COLLECTOR_STATE: { async get() { return null; }, put: () => new Promise(() => {}) } })).outcome, 'storage-unavailable');
  for (const makeResponse of [
    () => new Response('<html>private target body</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('x'.repeat(16385), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const invalid = createCollector({ now: () => clock, fetchImpl: async () => makeResponse() });
    const result = await invalid.run({ ...env, COLLECTOR_STATE: undefined }); assert.equal(result.outcome, 'invalid-response');
    assert.equal(JSON.stringify(result).includes('private target body'), false);
  }
  let localCycles = 0; const logs = [], localSecret = 'e'.repeat(64);
  const daemon = createCollectorDaemon({ credential: localSecret, once: true, now: () => clock, logger: (value) => logs.push(value),
    pipelineFactory(options) {
      assert.equal(options.publishUrl, COLLECTOR_PUBLISH_URL); assert.equal(options.publishCredential, localSecret);
      return { async cycle() { localCycles++; return { status: 'partial', published: false, recordCount: 12, secret: localSecret, rawResponse: 'Private pipeline content' }; } };
    } });
  await daemon.start(); assert.equal(localCycles, 1); assert.equal(daemon.status().running, false); assert.equal(daemon.status().cycleRunning, false);
  assert.equal(logs.at(-1).outcome, 'partial'); assert.equal(logs.at(-1).published, false); assert.equal(logs.at(-1).recordCount, 12);
  assert.equal(JSON.stringify(logs).includes(localSecret), false); assert.equal(JSON.stringify(logs).includes('Private pipeline content'), false);
  daemon.stop(); assert.equal(daemon.status().stopped, true);
});
