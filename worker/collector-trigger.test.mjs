import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createCollectorTriggerHandler, collectorTriggerMessage, COLLECTOR_TRIGGER_BODY, COLLECTOR_TRIGGER_LIMITS } from './collector-trigger.js';
import { signHostedCollectionTrigger, runHostedCollectionTrigger, HOSTED_COLLECTOR_TRIGGER_URL } from '../scripts/trigger-hosted-collector.mjs';

const NOW = Date.parse('2026-10-11T22:20:00.000Z');
const KEY = 'trigger_fixture_'.padEnd(64, 'k'), TOKEN = 'collector_fixture_'.padEnd(64, 't');
const NONCE = 'a'.repeat(32);
const env = () => ({ EARTH_TRIGGER_HMAC_KEY: KEY, EARTH_COLLECTOR_TOKEN: TOKEN });
const stored = () => Response.json({ stored: true, collectedAt: new Date(NOW).toISOString(),
  plugins: ['usgs', 'gdacs', 'eonet', 'gdelt'], snapshots: [{}, {}], failures: [],
  prepared: { recordCount: 12 }, world: { stored: true }, updatesPublished: true,
  unsafe: { credential: TOKEN, signingKey: KEY }, providerFailure: 'Do not echo upstream content' });
function request({ body = COLLECTOR_TRIGGER_BODY, key = KEY, now = NOW, nonce = NONCE, headers = {}, method = 'POST', query = '' } = {}) {
  const timestamp = String(Math.floor(now / 1000));
  const signed = { 'content-type': 'application/json', 'x-earth-trigger-timestamp': timestamp,
    'x-earth-trigger-nonce': nonce, 'x-earth-trigger-signature': createHmac('sha256', key).update(collectorTriggerMessage(timestamp, nonce, body)).digest('hex') };
  const all = { ...signed, ...headers };
  for (const [name, value] of Object.entries(all)) if (value === null) delete all[name];
  return new Request(`https://owned.example/api/collector/trigger${query}`, { method, headers: all,
    ...(!['GET', 'HEAD'].includes(method) ? { body } : {}) });
}

test('authentication, fixed scope and configuration fail closed before any acquisition', async () => {
  let calls = 0;
  const handle = createCollectorTriggerHandler({ now: () => NOW, collectionHandler: async () => { calls++; return stored(); } });
  const configured = env();
  const trials = [
    [request({ method: 'GET' }), configured, 405],
    [request({ headers: { origin: 'https://owned.example' } }), configured, 401],
    [request({ query: '?action=publish' }), configured, 400],
    [request(), {}, 503],
    [request(), { ...configured, EARTH_TRIGGER_HMAC_KEY: TOKEN }, 503],
    [request({ headers: { 'x-earth-trigger-signature': null } }), configured, 401],
    [request({ key: 'wrong_fixture_'.padEnd(64, 'x') }), configured, 401],
    [request({ now: NOW - 31_000 }), configured, 401],
    [request({ now: NOW + 31_000 }), configured, 401],
    [request({ body: '{"action":"publish"}' }), configured, 400],
    [request({ body: '{"action":"collect", "url":"https://elsewhere.example"}' }), configured, 400],
    [request({ body: 'x'.repeat(65) }), configured, 413],
    [request({ headers: { 'content-length': '1000' } }), configured, 413],
    [request({ headers: { 'content-encoding': 'gzip' } }), configured, 400],
  ];
  for (const [input, settings, expected] of trials) assert.equal((await handle(input, settings)).status, expected);
  assert.equal(calls, 0);
  assert.equal(await handle(new Request('https://owned.example/api/other'), configured), null);
});

test('Node signer interoperates with WebCrypto and delegates only the fixed server-authenticated collect action', async () => {
  let calls = 0;
  const configured = env(), context = { fixture: true };
  const handle = createCollectorTriggerHandler({ now: () => NOW, collectionHandler: async (internal, settings, ctx, options) => {
    calls++;
    assert.equal(internal.url, 'https://earth-observer.internal/api/collector');
    assert.equal(internal.method, 'POST'); assert.equal(internal.headers.has('origin'), false);
    assert.equal(internal.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(await internal.text(), COLLECTOR_TRIGGER_BODY);
    assert.equal(settings, configured); assert.equal(ctx, context);
    assert.equal(options.now(), NOW); assert.ok(internal.signal);
    return stored();
  } });
  const response = await handle(new Request('https://owned.example/api/collector/trigger', {
    method: 'POST', headers: signHostedCollectionTrigger(KEY, { now: NOW, nonce: NONCE }), body: COLLECTOR_TRIGGER_BODY }), configured, context);
  assert.equal(response.status, 200);
  const text = await response.text(), summary = JSON.parse(text);
  assert.deepEqual(summary, { schemaVersion: 1, status: 'stored', stored: true, collectedAt: new Date(NOW).toISOString(),
    checkedAt: null, heartbeat: false, factualPublication: false, completionRepaired: false, notificationRepaired: false,
    sourceCount: 4, snapshotCount: 2, failureCount: 0, recordCount: 12, worldStored: true, updatesPublished: true });
  assert.ok(!text.includes(KEY)); assert.ok(!text.includes(TOKEN)); assert.ok(!text.includes('upstream'));
  assert.equal(calls, 1);
});

test('compact hosted checks carry their count and operational clock without claiming a new factual publication', async () => {
  const capture = new Date(NOW - 60000).toISOString(), check = new Date(NOW).toISOString();
  const configured = env(), handle = createCollectorTriggerHandler({ now: () => NOW, collectionHandler: async () => Response.json({
    stored: true, heartbeat: true, factualPublication: false, collectedAt: capture, checkedAt: check,
    plugins: ['usgs', 'gdacs', 'eonet', 'gdelt'], recordCount: 12, snapshots: [], failures: [],
    completionRepaired: true, notificationRepaired: true, unsafe: KEY }) });
  const result = await runHostedCollectionTrigger({ key: KEY, now: () => NOW, nonce: NONCE,
    fetchImpl: (_url, init) => handle(new Request('https://owned.example/api/collector/trigger', init), configured) });
  assert.equal(result.ok, true); assert.equal(result.summary.recordCount, 12); assert.equal(result.summary.snapshotCount, 0);
  assert.equal(result.summary.collectedAt, capture); assert.equal(result.summary.checkedAt, check);
  assert.equal(result.summary.heartbeat, true); assert.equal(result.summary.factualPublication, false);
  assert.equal(result.summary.worldStored, false); assert.equal(result.summary.updatesPublished, false);
  assert.equal(result.summary.completionRepaired, true); assert.equal(result.summary.notificationRepaired, true);
  assert.equal(JSON.stringify(result.summary).includes(KEY), false);
});

test('empty signed body is accepted; same-isolate replay and minute admission prevent duplicate invocation', async () => {
  let calls = 0;
  const configured = env(), handle = createCollectorTriggerHandler({ now: () => NOW, collectionHandler: async () => { calls++; return stored(); } });
  assert.equal((await handle(request({ body: '' }), configured)).status, 200);
  assert.equal((await handle(request({ body: '' }), configured)).status, 409);
  assert.equal((await handle(request({ nonce: 'b'.repeat(32) }), configured)).status, 429);
  assert.equal(calls, 1);
});

test('deadline aborts provider work, retains pending admission, and reports uncertain storage without blind retries', async () => {
  let clock = NOW, calls = 0, entered, release, providerSignal;
  const arrived = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const configured = env();
  const handle = createCollectorTriggerHandler({ now: () => clock, deadlineMs: 30,
    fetchImpl: async (_url, options) => { providerSignal = options.signal; return new Response(''); },
    collectionHandler: async (_request, _env, _ctx, options) => {
      calls++; await options.fetchImpl('https://fixed-source.example'); entered(); await held; return stored();
    } });
  const first = handle(request(), configured); await arrived;
  assert.equal((await handle(request({ nonce: 'b'.repeat(32) }), configured)).status, 429);
  const timedOut = await first, payload = await timedOut.json();
  assert.equal(timedOut.status, 504); assert.equal(payload.status, 'uncertain');
  assert.equal(payload.stored, null); assert.equal(payload.readStatusBeforeRetry, true); assert.equal(providerSignal.aborted, true);
  clock += 61_000;
  assert.equal((await handle(request({ now: clock, nonce: 'c'.repeat(32) }), configured)).status, 429,
    'Timed-out collection keeps its slot until the underlying operation actually settles');
  assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await handle(request({ now: clock, nonce: 'd'.repeat(32) }), configured)).status, 200);
  assert.equal(calls, 2);
});

test('stalled body, expired admission-time signature and isolate request ceiling have zero collector side effects', async () => {
  let calls = 0, clock = NOW;
  const configured = env();
  const handle = createCollectorTriggerHandler({ now: () => clock, deadlineMs: 15, collectionHandler: async () => { calls++; return stored(); } });
  const stalled = new Request('https://owned.example/api/collector/trigger', { method: 'POST', duplex: 'half',
    headers: signHostedCollectionTrigger(KEY, { now: NOW, nonce: NONCE }), body: new ReadableStream({ start() {} }) });
  const result = await handle(stalled, configured), payload = await result.json();
  assert.equal(result.status, 504); assert.equal(payload.status, 'deadline'); assert.equal(payload.collectionMayHaveCommitted, false);
  let bodyController;
  const expired = new Request('https://owned.example/api/collector/trigger', { method: 'POST', duplex: 'half',
    headers: signHostedCollectionTrigger(KEY, { now: NOW, nonce: NONCE }), body: new ReadableStream({ start(controller) { bodyController = controller; } }) });
  const delayedBody = handle(expired, configured);
  await new Promise(resolve => setImmediate(resolve));
  clock = NOW + 31_000;
  bodyController.enqueue(new TextEncoder().encode(COLLECTOR_TRIGGER_BODY)); bodyController.close();
  assert.equal((await delayedBody).status, 401);
  const ceiling = createCollectorTriggerHandler({ now: () => NOW, collectionHandler: async () => { calls++; return stored(); } });
  for (let i = 0; i < COLLECTOR_TRIGGER_LIMITS.requestsPerIsolate; i++) assert.equal((await ceiling(request(), {})).status, 503);
  assert.equal((await ceiling(request(), configured)).status, 429); assert.equal(calls, 0);
});

test('storage failures and oversized internal responses never expose raw response fields or secrets', async () => {
  for (const output of [Response.json({ stored: false, failures: [TOKEN], error: KEY }),
    Response.json({ stored: true, secret: KEY, huge: 'x'.repeat(COLLECTOR_TRIGGER_LIMITS.responseBytes) })]) {
    const handle = createCollectorTriggerHandler({ now: () => NOW, collectionHandler: async () => output });
    const result = await handle(request(), env()), text = await result.text();
    assert.ok(result.status >= 400); assert.ok(!text.includes(KEY)); assert.ok(!text.includes(TOKEN));
  }
});

test('built-in client targets only the compiled endpoint and prints only allowlisted bounded status', async () => {
  const result = await runHostedCollectionTrigger({ key: KEY, now: () => NOW, nonce: NONCE,
    fetchImpl: async (url, options) => {
      assert.equal(url, HOSTED_COLLECTOR_TRIGGER_URL); assert.equal(options.method, 'POST');
      assert.equal(options.body, COLLECTOR_TRIGGER_BODY); assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
      assert.equal(options.headers['x-earth-trigger-signature'], signHostedCollectionTrigger(KEY, { now: NOW, nonce: NONCE })['x-earth-trigger-signature']);
      return Response.json({ status: 'stored', stored: true, sourceCount: 4, snapshotCount: 2, recordCount: 3,
        failureCount: 0, worldStored: true, updatesPublished: true, privateToken: TOKEN, signingKey: KEY });
    } });
  assert.equal(result.ok, true); assert.equal(result.summary.sourceCount, 4);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.deepEqual(await runHostedCollectionTrigger({}), { ok: false, summary: { status: 'unconfigured', stored: false } });
});

test('client bounds stalled fetches, oversized bodies and unknown response schemas without raw errors', async () => {
  const blocked = await runHostedCollectionTrigger({ key: KEY, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  assert.equal(blocked.ok, false); assert.equal(blocked.summary.status, 'uncertain'); assert.equal(blocked.summary.readStatusBeforeRetry, true);
  for (const output of [Response.json({ status: 'stored', stored: true, data: 'x'.repeat(5000) }),
    Response.json({ status: KEY, stored: true }), new Response(KEY, { status: 503 })]) {
    const result = await runHostedCollectionTrigger({ key: KEY, fetchImpl: async () => output });
    assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes(KEY));
  }
});
