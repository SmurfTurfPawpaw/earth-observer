import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { PRIVATE_DEPLOY_HANDOFF as P, safeDeploymentSummary, startPrivateDeployHandoff } from './private-deploy-handoff.mjs';

const accountId = 'a'.repeat(32), hmacKey = 'h'.repeat(43), nonce = 'b'.repeat(64), apiToken = 'test-only-token-'.repeat(3);
const initialization = mode => ({ schemaVersion: 1, mode, accountId, hmacKey, nonce, ...(['deploy', 'upgrade-routing', 'upgrade-runtime'].includes(mode) ? { planId: 'c'.repeat(64) } : {}) });
const url = relay => `http://${P.host}:${relay.port}${P.path}`;
const options = extra => ({ method: 'POST', headers: { 'content-type': 'application/json', [P.nonceHeader]: nonce, ...extra?.headers },
  body: JSON.stringify({ schemaVersion: 1, apiToken }), ...extra, ...(extra?.headers ? { headers: { 'content-type': 'application/json', [P.nonceHeader]: nonce, ...extra.headers } } : {}) });
const plan = { schemaVersion: 1, status: 'plan', planId: 'd'.repeat(64), resource: { state: 'absent' }, mutations: 0, operations: ['paused-upload', 'minute-cron'] };

test('one-use relay passes token in RAM to a GET-only plan and returns sanitized metadata', async () => {
  const logs = [], received = [];
  const relay = await startPrivateDeployHandoff(initialization('plan'), { artifactLoader: async () => new Uint8Array([1]),
    deploy: async (control, settings) => { received.push({ ...control }); assert.ok(settings.signal instanceof AbortSignal); return { ...plan, apiToken, hmacKey, error: apiToken }; },
    logger: value => logs.push(value) });
  try {
    const response = await fetch(url(relay), options()); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.status, 'accepted'); assert.equal(result.result.status, 'plan');
    const terminal = await relay.finished; assert.equal(terminal.planId, plan.planId);
    assert.deepEqual(received, [{ schemaVersion: 1, mode: 'plan', accountId, apiToken }]);
    assert.ok(logs.some(log => log.status === 'ready' && log.host === '127.0.0.1'));
    assert.ok(!JSON.stringify([result, terminal, logs]).includes(apiToken)); assert.ok(!JSON.stringify(logs).includes(hmacKey)); assert.ok(!JSON.stringify(logs).includes(nonce));
    await assert.rejects(fetch(url(relay), options()));
  } finally { relay.close(); }
});

test('Origin, wrong nonce, method, query, foreign Host and extra fields never consume authorization', async () => {
  let calls = 0;
  const relay = await startPrivateDeployHandoff(initialization('plan'), { artifactLoader: async () => new Uint8Array(), deploy: async () => { calls++; return plan; } });
  try {
    for (const [suffix, change] of [
      ['', { headers: { origin: 'http://foreign.example' } }],
      ['', { headers: { [P.nonceHeader]: 'e'.repeat(64) } }],
      ['', { method: 'OPTIONS', body: undefined }],
      ['?secret=ignored', {}],
      ['', { body: JSON.stringify({ schemaVersion: 1, apiToken, sourceUrl: 'https://foreign.example' }) }],
      ['', { body: `{"schemaVersion":1,"apiToken":"${apiToken}","apiToken":"${apiToken}"}` }],
    ]) {
      const response = await fetch(url(relay) + suffix, options(change)); assert.ok(response.status >= 400, JSON.stringify({ suffix, change }));
      assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(calls, 0);
    }
    // Fetch normalizes Host; use native HTTP to prove the actual Host gate.
    const wrongHost = await new Promise((resolve, reject) => {
      const request = httpRequest(url(relay), { method: 'POST', headers: { 'content-type': 'application/json',
        [P.nonceHeader]: nonce, host: `localhost:${relay.port}` } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end(JSON.stringify({ schemaVersion: 1, apiToken }));
    });
    assert.equal(wrongHost, 403); assert.equal(calls, 0);
    assert.equal((await fetch(url(relay), options())).status, 200); await relay.finished; assert.equal(calls, 1);
  } finally { relay.close(); }
});

test('declared and streamed bodies remain bounded and no token is accepted on overflow', async () => {
  let calls = 0;
  const relay = await startPrivateDeployHandoff(initialization('plan'), { artifactLoader: async () => new Uint8Array(), deploy: async () => { calls++; return plan; } });
  try {
    const large = await fetch(url(relay), options({ body: 'x'.repeat(P.bodyBytes + 1) })); assert.equal(large.status, 413); assert.equal(calls, 0);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(P.bodyBytes + 1))); controller.close(); } });
    const streamed = await fetch(url(relay), options({ body, duplex: 'half' })); assert.equal(streamed.status, 413); assert.equal(calls, 0);
    assert.equal((await fetch(url(relay), options())).status, 200); await relay.finished; assert.equal(calls, 1);
  } finally { relay.close(); }
});

test('simultaneous submissions cannot invoke deployment twice', async () => {
  let resolve, calls = 0; const started = new Promise(accept => { resolve = accept; }); let complete;
  const pending = new Promise(accept => { complete = accept; });
  const relay = await startPrivateDeployHandoff(initialization('deploy'), { artifactLoader: async () => new Uint8Array(),
    deploy: async control => { calls++; assert.equal(control.hmacKey, hmacKey); assert.equal(control.planId, 'c'.repeat(64)); resolve(); await pending; return plan; } });
  try {
    const first = fetch(url(relay), options()); await started;
    await assert.rejects(fetch(url(relay), options())); assert.equal(calls, 1);
    complete(); assert.equal((await first).status, 200); await relay.finished;
  } finally { complete(); relay.close(); }
});

test('deadline cancels admitted work, closes sockets and does not expose injected error text', async () => {
  const logs = []; let invoked;
  const relay = await startPrivateDeployHandoff(initialization('deploy'), { deadlineMs: 50, artifactLoader: async () => new Uint8Array(),
    deploy: async (_control, { signal }) => { invoked = signal; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error(apiToken); },
    logger: value => logs.push(value) });
  const response = fetch(url(relay), options()).catch(() => null);
  const result = await relay.finished; await response;
  assert.equal(result.status, 'cancelled'); assert.equal(result.readbackRequired, true); assert.equal(invoked.aborted, true);
  assert.ok(!JSON.stringify([result, logs]).includes(apiToken)); await assert.rejects(fetch(url(relay), options()));
});

test('explicit close and invalid setup cannot leave an accepting listener', async () => {
  await assert.rejects(startPrivateDeployHandoff({ ...initialization('plan'), nonce: 'short' }));
  await assert.rejects(startPrivateDeployHandoff(initialization('plan'), { deadlineMs: 120001 }));
  const relay = await startPrivateDeployHandoff(initialization('plan'));
  relay.close(); assert.equal((await relay.finished).status, 'cancelled'); await assert.rejects(fetch(url(relay), options()));
  const safe = safeDeploymentSummary({ status: apiToken, resource: { state: 'owned', secret: hmacKey }, unknown: nonce });
  assert.equal(safe.status, 'api_unavailable'); assert.ok(!JSON.stringify(safe).includes(apiToken)); assert.ok(!JSON.stringify(safe).includes(hmacKey));
});

test('bootstrap inspection transport retains hashes and typed counts without code/secret values', async () => {
  const state = { state: 'bootstrap', versionId: 'efe3d7d3-0000-4000-8000-000000000001', deploymentId: '00000000-0000-4000-8000-000000000002',
    sourceSha256: 'f'.repeat(64), sourceBytes: 333, compatibilityDate: '2026-10-11', bindingCount: 0, bindings: [],
    tailConsumerCount: 0, scheduleCount: 0, customDomainCount: 0, workersDevEnabled: true, previewsEnabled: true, zoneRoutes: 'unverified', code: apiToken };
  const relay = await startPrivateDeployHandoff(initialization('inspect-bootstrap'), { artifactLoader: async () => new Uint8Array(),
    deploy: async control => { assert.equal(control.mode, 'inspect-bootstrap'); assert.equal(control.hmacKey, undefined); return { status: 'bootstrap_inspected', resource: state, mutations: 0 }; } });
  try {
    const response = await fetch(url(relay), options()), payload = await response.json(); await relay.finished;
    assert.equal(payload.result.status, 'bootstrap_inspected'); assert.equal(payload.result.resource.sourceSha256, state.sourceSha256);
    assert.equal(payload.result.resource.versionId, state.versionId); assert.equal(payload.result.resource.zoneRoutes, 'unverified');
    assert.ok(!JSON.stringify(payload).includes(apiToken)); assert.equal(payload.result.resource.code, undefined);
  } finally { relay.close(); }
});

test('routing upgrade transfers approval but not a replacement HMAC key', async () => {
  const resource = { state: 'owned', versionId: '00000000-0000-4000-8000-000000000001', latestUploadedVersionId: '00000000-0000-4000-8000-000000000001',
    enabled: true, secretPresent: true, cronEnabled: true, publicSubdomain: false, compatibilityFlags: ['global_fetch_strictly_public'], routingReady: true };
  const relay = await startPrivateDeployHandoff(initialization('upgrade-routing'), { artifactLoader: async () => new Uint8Array(),
    deploy: async control => {
      assert.deepEqual(control, { schemaVersion: 1, mode: 'upgrade-routing', accountId, apiToken, planId: 'c'.repeat(64) });
      return { status: 'configured_pending_runtime_verification', resource, mutations: 1 };
    } });
  try {
    const response = await fetch(url(relay), options()), payload = await response.json(); await relay.finished;
    assert.equal(payload.result.resource.routingReady, true); assert.deepEqual(payload.result.resource.compatibilityFlags, resource.compatibilityFlags);
    assert.equal(payload.result.resource.latestUploadedVersionId, resource.latestUploadedVersionId);
    assert.ok(!JSON.stringify(payload).includes(apiToken)); assert.ok(!JSON.stringify(payload).includes(hmacKey));
  } finally { relay.close(); }
});

test('an unexpected admitted routing-upgrade failure conservatively requires readback', async () => {
  const relay = await startPrivateDeployHandoff(initialization('upgrade-routing'), { artifactLoader: async () => new Uint8Array(), deploy: async () => { throw new Error(apiToken); } });
  try {
    const response = await fetch(url(relay), options()), payload = await response.json(); await relay.finished;
    assert.equal(payload.result.status, 'api_unavailable'); assert.equal(payload.result.readbackRequired, true);
    assert.ok(!JSON.stringify(payload).includes(apiToken)); assert.ok(!JSON.stringify(payload).includes(hmacKey));
  } finally { relay.close(); }
});

test('runtime upgrade carries the new code identity and approval without forwarding the HMAC', async () => {
  const relay = await startPrivateDeployHandoff(initialization('upgrade-runtime'), { artifactLoader: async () => new Uint8Array(), deploy: async control => {
    assert.deepEqual(control, { schemaVersion: 1, mode: 'upgrade-runtime', accountId, apiToken, planId: 'c'.repeat(64) });
    return { status: 'runtime_upgrade_required', mutations: 0, operations: ['runtime-upgrade'], resource: { state: 'owned',
      runtimeReady: false, sourceSha256: 'cac8817f512df979a71cb6c1b2c95703c5226c000e5d78be02435d18ac28d803', sourceBytes: 9812 } };
  } });
  try {
    const response = await fetch(url(relay), options()), payload = await response.json(); await relay.finished;
    assert.equal(payload.result.status, 'runtime_upgrade_required'); assert.equal(payload.result.resource.runtimeReady, false);
    assert.deepEqual(payload.result.operations, ['runtime-upgrade']); assert.ok(!JSON.stringify(payload).includes(hmacKey));
  } finally { relay.close(); }
});
