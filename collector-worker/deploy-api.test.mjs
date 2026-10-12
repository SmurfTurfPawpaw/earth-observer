import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { MINUTE_DEPLOYMENT as P, runMinuteTimerDeployment } from './deploy-api.mjs';

// Rebuild in memory so this contract gate also works on a clean clone, without
// installing tools or depending on the ignored operator artifact's presence.
const artifact = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['collector-worker/minute-trigger.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
const bytes = Buffer.from(artifact.outputFiles[0].contents);
assert.equal(createHash('sha256').update(bytes).digest('hex'), P.artifactSha256);
// Immutable reviewed legacy module fixture, compressed only to keep this test
// self-contained on clean clones after the entry point changes. No credentials.
const legacyBytes = gunzipSync(Buffer.from('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', 'base64'));
assert.equal(createHash('sha256').update(legacyBytes).digest('hex'), P.legacyArtifactSha256);
const accountId = 'a'.repeat(32), apiToken = 'test-only-api-token-'.repeat(3), hmacKey = 'k'.repeat(43);
const input = mode => ({ schemaVersion: 1, mode, accountId, apiToken });
const envelope = result => Response.json({ success: true, errors: [], messages: [], result });
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function provider({ existing = false, intercept } = {}) {
  const calls = [], state = { existing, tags: [], bytes, enabled: false, secret: false, publicHttp: false, cron: false, version: 1, extraBinding: null, flags: [], observability: { enabled: true } };
  async function fetchImpl(url, options) {
    calls.push({ url, ...options });
    assert.equal(new URL(url).origin, P.apiOrigin);
    assert.equal(options.headers.authorization, `Bearer ${apiToken}`);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    if (intercept) { const response = await intercept(url, options, state, calls); if (response) return response; }
    const base = `${P.apiOrigin}/client/v4/accounts/${accountId}/workers/scripts`;
    if (url === `${P.apiOrigin}/client/v4/accounts/${accountId}/workers/domains`) return envelope(state.domains || []);
    if (url === base && options.method === 'GET') return envelope(state.existing ? [{ id: P.scriptName }] : []);
    const suffix = url.slice(`${base}/${P.scriptName}`.length);
    if (options.method === 'GET') {
      if (suffix === '/script-settings') return envelope({ tags: state.tags, logpush: false, tail_consumers: [], observability: state.observability });
      if (suffix === '/settings') return envelope({ compatibility_date: P.compatibilityDate, compatibility_flags: state.flags, observability: state.observability });
      if (suffix === '/content/v2') return new Response(state.bytes, { headers: { 'content-type': 'application/javascript+module' } });
      const versionId = state.bootstrap ? uuid(state.version).replace('00000000', 'efe3d7d3') : uuid(state.version);
      if (suffix === '/deployments?per_page=1') return envelope({ deployments: [{ id: uuid(state.version + 100), versions: [{ percentage: 100, version_id: versionId }] }] });
      if (suffix === '/versions?per_page=1') return envelope({ items: [{ id: state.latestVersionId || versionId }] });
      if (suffix.startsWith('/versions/')) {
        const bindings = state.bootstrap ? [] : [{ name: 'EARTH_MINUTE_TIMER_ENABLED', type: 'plain_text', text: state.enabled ? '1' : '0' }];
        if (state.secret) bindings.push({ name: 'EARTH_TRIGGER_HMAC_KEY', type: 'secret_text' });
        if (state.extraBinding) bindings.push(state.extraBinding);
        return envelope({ id: versionId, resources: { bindings, script: { handlers: state.bootstrap ? ['fetch'] : ['fetch', 'scheduled'] }, script_runtime: { compatibility_date: P.compatibilityDate, ...(state.omitVersionFlags ? {} : { compatibility_flags: state.flags }) } } });
      }
      if (suffix === '/subdomain') return envelope({ enabled: state.publicHttp, previews_enabled: false });
      if (suffix === '/schedules') return envelope({ schedules: state.cron ? [{ cron: P.cron }] : [] });
    }
    if (options.method === 'PUT' && suffix === '?bindings_inherit=strict') {
      assert.ok(ArrayBuffer.isView(options.body));
      assert.ok(options.body.byteLength <= P.artifactBytes + 4096);
      assert.match(options.headers['content-type'], new RegExp(`^multipart/form-data; boundary=earth-minute-${P.artifactSha256}-[01]$`));
      const form = await new Response(options.body, { headers: { 'content-type': options.headers['content-type'] } }).formData();
      assert.deepEqual([...form.keys()], ['metadata', P.moduleName]);
      const metadata = JSON.parse(form.get('metadata'));
      assert.equal(metadata.main_module, P.moduleName);
      assert.deepEqual(metadata.compatibility_flags, [P.routingFlag]);
      assert.deepEqual(metadata.observability, state.bootstrap ? { enabled: true } : state.observability);
      assert.deepEqual(metadata.tail_consumers, []); assert.equal(metadata.logpush, false);
      assert.equal(metadata.bindings.length, state.secret ? 2 : 1);
      assert.deepEqual(metadata.bindings[0], { name: 'EARTH_MINUTE_TIMER_ENABLED', type: 'plain_text', text: metadata.bindings[0].text });
      assert.ok(['0', '1'].includes(metadata.bindings[0].text));
      if (state.secret) assert.deepEqual(metadata.bindings[1], { name: 'EARTH_TRIGGER_HMAC_KEY', type: 'inherit' });
      assert.equal(form.get(P.moduleName).name, P.moduleName);
      assert.equal(form.get(P.moduleName).type, 'application/javascript+module');
      state.bytes = new Uint8Array(await form.get(P.moduleName).arrayBuffer());
      assert.deepEqual(Buffer.from(state.bytes), bytes);
      state.tags = metadata.tags; state.flags = metadata.compatibility_flags; state.observability = metadata.observability; state.enabled = metadata.bindings[0].text === '1'; state.existing = true; state.bootstrap = false; state.version++;
      return envelope({ id: P.scriptName });
    }
    if (suffix === '/schedules' && options.method === 'PUT') {
      const schedules = JSON.parse(options.body); assert.ok(schedules.length <= 1);
      if (schedules.length) assert.deepEqual(schedules, [{ cron: P.cron }]);
      state.cron = schedules.length === 1; return envelope({ schedules });
    }
    if (suffix === '/subdomain' && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { enabled: false, previews_enabled: false });
      state.publicHttp = false; return envelope({ enabled: false, previews_enabled: false });
    }
    if (suffix === '/secrets' && options.method === 'PUT') {
      assert.deepEqual(JSON.parse(options.body), { name: 'EARTH_TRIGGER_HMAC_KEY', type: 'secret_text', text: hmacKey });
      assert.equal(state.enabled, false); assert.equal(state.cron, false); assert.equal(state.publicHttp, false);
      state.secret = true; state.version++; return envelope({ name: 'EARTH_TRIGGER_HMAC_KEY', type: 'secret_text' });
    }
    assert.fail(`Unexpected fixed operation ${options.method} ${suffix}`);
  }
  return { state, calls, fetchImpl };
}
const run = (control, mock, options = {}) => runMinuteTimerDeployment(control, { artifactBytes: bytes, fetchImpl: mock.fetchImpl, ...options });
const owned = mock => { mock.state.tags = ['earth-minute-trigger-v1', `sha256:${P.artifactSha256}`]; return mock; };
const legacy = mock => { owned(mock); mock.state.bytes = legacyBytes; mock.state.tags[1] = `sha256:${P.legacyArtifactSha256}`; return mock; };

test('plan uses authenticated complete listing and performs no resource writes', async () => {
  const mock = provider(), result = await run(input('plan'), mock);
  assert.equal(result.status, 'plan'); assert.equal(result.resource.state, 'absent'); assert.match(result.planId, /^[a-f0-9]{64}$/);
  assert.equal(result.freePlanVerified, false); assert.equal(result.runtimeVerified, false);
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].method, 'GET');
  assert.ok(!JSON.stringify(result).includes(apiToken));
});

test('paused upload, exact secret and enabled schedule each require coherent readback', async () => {
  const mock = provider(), plan = await run(input('plan'), mock);
  const result = await run({ ...input('deploy'), planId: plan.planId, hmacKey }, mock);
  assert.equal(result.status, 'configured_pending_runtime_verification'); assert.equal(result.mutations, 6);
  assert.deepEqual(mock.calls.filter(call => call.method !== 'GET').map(call => [call.method, new URL(call.url).pathname.split('/').at(-1)]),
    [['PUT', P.scriptName], ['PUT', 'schedules'], ['POST', 'subdomain'], ['PUT', 'secrets'], ['PUT', P.scriptName], ['PUT', 'schedules']]);
  assert.equal(result.resource.enabled, true); assert.equal(result.resource.secretPresent, true); assert.equal(result.resource.cronEnabled, true);
  assert.equal(result.resource.publicSubdomain, false); assert.equal(result.resource.customRoutesVerified, false);
  assert.equal(result.runtimeVerified, false); assert.equal(result.freePlanVerified, false);
  assert.ok(!JSON.stringify(result).includes(hmacKey)); assert.ok(!JSON.stringify(result).includes(apiToken));
  const repeat = await run(input('plan'), mock);
  const before = mock.calls.length, resumed = await run({ ...input('deploy'), planId: repeat.planId, hmacKey }, mock);
  assert.equal(resumed.mutations, 0); assert.ok(mock.calls.slice(before).every(call => call.method === 'GET'));
});

test('dashboard placeholder, changed code and unrelated bindings fail closed before writes', async () => {
  for (const caseId of ['placeholder', 'code', 'binding']) {
    const mock = provider({ existing: true });
    if (caseId !== 'placeholder') owned(mock);
    if (caseId === 'code') mock.state.bytes = Buffer.from('export default {fetch(){return new Response("unrelated")}}');
    if (caseId === 'binding') mock.state.extraBinding = { name: 'EARTH_DB', type: 'd1', id: 'unrelated' };
    const result = await run(input('plan'), mock);
    assert.ok(['ownership_conflict', 'configuration_conflict'].includes(result.status));
    assert.ok(mock.calls.every(call => call.method === 'GET'));
  }
});

test('changed preflight invalidates earlier approval without overwriting even an owned paused Worker', async () => {
  const mock = provider(), plan = await run(input('plan'), mock);
  mock.state.existing = true; owned(mock);
  const result = await run({ ...input('deploy'), planId: plan.planId, hmacKey }, mock);
  assert.equal(result.status, 'plan_changed'); assert.equal(result.mutations, 0);
});

test('uncertain secret write stops immediately, retains safe phase and needs explicit readback', async () => {
  const mock = provider({ intercept: async (url, options, state) => {
    if (url.endsWith('/secrets') && options.method === 'PUT') { state.secret = true; throw new Error(`secret ${hmacKey} token ${apiToken}`); }
  } });
  const plan = await run(input('plan'), mock), result = await run({ ...input('deploy'), planId: plan.planId, hmacKey }, mock);
  assert.equal(result.status, 'api_unavailable'); assert.equal(result.uncertainStep, 'secret'); assert.equal(result.lastConfirmedStep, 'paused-readback');
  assert.equal(result.readbackRequired, true); assert.equal(mock.calls.at(-1).method, 'PUT'); assert.ok(mock.calls.at(-1).url.endsWith('/secrets'));
  assert.equal(mock.state.cron, false); assert.equal(mock.state.enabled, false);
  assert.ok(!JSON.stringify(result).includes(apiToken)); assert.ok(!JSON.stringify(result).includes(hmacKey));
});

test('readback disagreement cannot activate Cron after an accepted secret', async () => {
  const mock = provider({ intercept: async (url, options, state) => {
    if (url.endsWith('/secrets') && options.method === 'PUT') { state.secret = true; state.enabled = true; return envelope({ name: 'EARTH_TRIGGER_HMAC_KEY' }); }
  } });
  const plan = await run(input('plan'), mock), result = await run({ ...input('deploy'), planId: plan.planId, hmacKey }, mock);
  assert.equal(result.status, 'readback_failed'); assert.equal(result.step, 'secret-readback'); assert.equal(mock.state.cron, false);
  assert.equal(mock.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/schedules')).length, 1);
});

test('redirect, HTTP errors, oversized and stalled bodies do not imply absence or retry', async () => {
  for (const variant of ['redirect', 'error', 'oversize', 'stall']) {
    let count = 0, cancelled = false;
    const fetchImpl = async () => {
      count++;
      if (variant === 'redirect') { const response = envelope([]); Object.defineProperty(response, 'redirected', { value: true }); return response; }
      if (variant === 'error') return Response.json({ success: false, errors: [{ code: 10007, message: apiToken }], result: null }, { status: 404 });
      if (variant === 'oversize') return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json', 'content-length': String(P.responseBytes + 1) } });
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await runMinuteTimerDeployment(input('plan'), { artifactBytes: bytes, fetchImpl, requestMs: 20 });
    assert.notEqual(result.status, 'plan'); assert.equal(count, 1); assert.equal(result.mutations, 0);
    assert.ok(!JSON.stringify(result).includes(apiToken)); if (['oversize', 'stall'].includes(variant)) assert.equal(cancelled, true);
  }
});

test('invalid credential/control, foreign artifact and pre-cancellation never dispatch', async () => {
  const mock = provider(), abort = new AbortController(); abort.abort();
  assert.equal((await run(input('plan'), mock, { signal: abort.signal })).status, 'cancelled');
  assert.equal((await run({ ...input('plan'), sourceUrl: 'https://foreign.example' }, mock)).status, 'invalid_control');
  assert.equal((await runMinuteTimerDeployment(input('plan'), { artifactBytes: Buffer.from('wrong'), fetchImpl: mock.fetchImpl })).status, 'artifact_invalid');
  assert.equal(mock.calls.length, 0);
});

test('cross-realm uint8 evidence preserves the exact pin while other views remain inadmissible', async () => {
  const foreignBytes = runInNewContext('new Uint8Array(values)', { values: Array.from(bytes) });
  assert.equal(foreignBytes instanceof Uint8Array, false);
  const mock = provider();
  assert.equal((await runMinuteTimerDeployment(input('plan'), { artifactBytes: foreignBytes, fetchImpl: mock.fetchImpl })).status, 'plan');
  assert.equal(mock.calls.length, 1);
  for (const wrong of [new Uint8ClampedArray(bytes), new Int8Array(bytes), new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)]) {
    const blocked = provider();
    assert.equal((await runMinuteTimerDeployment(input('plan'), { artifactBytes: wrong, fetchImpl: blocked.fetchImpl })).status, 'artifact_invalid');
    assert.equal(blocked.calls.length, 0);
  }
});

test('incomplete listings and malformed version array fields are never ownership proof', async () => {
  const incomplete = provider({ intercept: async (url, options) => {
    if (url.endsWith('/workers/scripts')) return Response.json({ success: true, errors: [], result: [], result_info: { count: 0, total_count: 1, page: 1, total_pages: 2 } });
  } });
  assert.equal((await run(input('plan'), incomplete)).status, 'invalid_response');
  assert.equal(incomplete.calls.length, 1);
  const malformed = owned(provider({ existing: true, intercept: async (url, options) => {
    if (url.includes('/versions/')) return envelope({ id: uuid(1), resources: { bindings: [], script: { handlers: 'scheduled fetch' },
      script_runtime: { compatibility_date: P.compatibilityDate, compatibility_flags: {} } } });
  } }));
  assert.equal((await run(input('plan'), malformed)).status, 'configuration_conflict');
  assert.ok(malformed.calls.every(call => call.method === 'GET'));
});

test('multipart content readback admits exactly the pinned single module', async () => {
  const mock = owned(provider({ existing: true, intercept: async (url, options) => {
    if (url.endsWith('/content/v2') && options.method === 'GET') {
      const form = new FormData(); form.set(P.moduleName, new Blob([bytes], { type: 'application/javascript+module' }), P.moduleName);
      return new Response(form);
    }
  } }));
  assert.equal((await run(input('plan'), mock)).status, 'plan');
});

test('CLI rejects argv secrets and invalid stdin without echo or environment fallback', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./deploy-api.mjs', import.meta.url)), 'private-argv-sentinel'],
    { env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken, EARTH_TRIGGER_HMAC_KEY: hmacKey }, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [], errors = []; child.stdout.on('data', part => output.push(part)); child.stderr.on('data', part => errors.push(part)); child.stdin.end('{}');
  const exit = await new Promise(resolve => child.on('close', resolve)), text = Buffer.concat(output).toString();
  assert.equal(exit, 1); assert.equal(JSON.parse(text).status, 'invalid_control'); assert.equal(Buffer.concat(errors).length, 0);
  assert.ok(!text.includes('private-argv-sentinel')); assert.ok(!text.includes(apiToken)); assert.ok(!text.includes(hmacKey));
});

test('task-owned bootstrap inspection is stored metadata only; exact code/version proof is separately required', async () => {
  // Actual dashboard shell settings use null for absent tags/tail consumers.
  const mock = provider({ existing: true, intercept: async (url, _options, state) => {
    if (url.endsWith('/script-settings') && state.bootstrap)
      return envelope({ logpush: false, tags: null, tail_consumers: null, observability: { enabled: true } });
    if (url.endsWith('/workers/domains')) return Response.json({ success: true, errors: null, messages: null, result: [],
      result_info: { page: 1, per_page: 0, count: 0, total_count: 0 } });
  } }); mock.state.bootstrap = true;
  mock.state.bytes = Buffer.from('export default {fetch(){return new Response("Hello World")}}');
  const inspected = await run(input('inspect-bootstrap'), mock);
  assert.equal(inspected.status, 'bootstrap_inspected'); assert.equal(inspected.mutations, 0);
  assert.equal(inspected.resource.versionId, 'efe3d7d3-0000-4000-8000-000000000001');
  assert.equal(inspected.resource.sourceSha256, createHash('sha256').update(mock.state.bytes).digest('hex'));
  assert.deepEqual(inspected.resource.bindings, []); assert.equal(inspected.resource.zoneRoutes, 'unverified');
  assert.equal(inspected.resource.tailConsumerCount, 0);
  assert.ok(!JSON.stringify(inspected).includes('Hello World'));
  assert.equal((await run(input('plan'), mock)).status, 'ownership_conflict');
  const bootstrapProof = { versionId: inspected.resource.versionId, sourceSha256: inspected.resource.sourceSha256, taskOwnedNoZoneRoutes: true };
  const planResult = await run({ ...input('plan'), bootstrapProof }, mock); assert.equal(planResult.status, 'plan');
  const deployed = await run({ ...input('deploy'), planId: planResult.planId, hmacKey, bootstrapProof }, mock);
  assert.equal(deployed.status, 'configured_pending_runtime_verification'); assert.equal(deployed.mutations, 6);
  assert.equal((await run({ ...input('plan'), bootstrapProof }, mock)).status, 'ownership_conflict');
});

test('bootstrap rejects changed exact version/source, nonempty bindings/domains and missing route attestation', async () => {
  for (const variant of ['version', 'source', 'binding', 'domain', 'attestation']) {
    const mock = provider({ existing: true }); mock.state.bootstrap = true;
    mock.state.bytes = Buffer.from('export default {fetch(){return new Response("Hello World")}}');
    const inspected = await run(input('inspect-bootstrap'), mock);
    const proof = { versionId: inspected.resource.versionId, sourceSha256: inspected.resource.sourceSha256, taskOwnedNoZoneRoutes: true };
    if (variant === 'version') mock.state.version++;
    if (variant === 'source') mock.state.bytes = Buffer.from('different');
    if (variant === 'binding') mock.state.extraBinding = { name: 'PRIVATE', type: 'secret_text' };
    if (variant === 'domain') mock.state.domains = [{ service: P.scriptName }];
    if (variant === 'attestation') proof.taskOwnedNoZoneRoutes = false;
    const result = await run({ ...input('plan'), bootstrapProof: proof }, mock);
    assert.ok(['ownership_conflict', 'invalid_control'].includes(result.status), variant);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
  }
});

test('nullable success errors do not relax HTTP/error failure or domain completeness admission', async () => {
  for (const variant of ['nonempty', 'malformed', 'failed', 'http', 'incomplete']) {
    const mock = provider({ existing: true, intercept: async url => {
      if (url.endsWith('/workers/domains')) {
        const payload = { success: true, errors: null, result: [], result_info: { count: 0, total_count: 0 } };
        if (variant === 'nonempty') payload.errors = [{ code: 1000 }];
        if (variant === 'malformed') payload.errors = {};
        if (variant === 'failed') payload.success = false;
        if (variant === 'incomplete') payload.result_info.total_count = 1;
        return Response.json(payload, { status: variant === 'http' ? 403 : 200 });
      }
    } });
    mock.state.bootstrap = true;
    const result = await run(input('inspect-bootstrap'), mock);
    assert.equal(result.status, variant === 'incomplete' ? 'invalid_response' : 'api_rejected');
    assert.equal(result.mutations, 0);
  }
});

test('current reviewed runtime without the public flag needs one identical-code routing upload', async () => {
  const mock = owned(provider({ existing: true })); Object.assign(mock.state, { enabled: true, secret: true, cron: true });
  assert.equal((await run(input('verify'), mock)).status, 'routing_upgrade_required');
  const plan = await run(input('plan'), mock); assert.deepEqual(plan.operations, ['routing-upgrade']); assert.deepEqual(plan.resource.compatibilityFlags, []);
  const bodyBefore = Buffer.from(mock.state.bytes), result = await run({ ...input('upgrade-routing'), planId: plan.planId }, mock);
  assert.equal(result.status, 'configured_pending_runtime_verification'); assert.equal(result.mutations, 1); assert.equal(result.resource.routingReady, true);
  assert.deepEqual(mock.calls.filter(call => call.method !== 'GET').map(call => [call.method, new URL(call.url).search]), [['PUT', '?bindings_inherit=strict']]);
  assert.deepEqual(Buffer.from(mock.state.bytes), bodyBefore); assert.equal(mock.state.secret, true); assert.equal(mock.state.enabled, true);
  assert.equal(mock.state.cron, true); assert.equal(mock.state.publicHttp, false);
  const desired = await run(input('plan'), mock); assert.deepEqual(desired.operations, []);
  assert.equal((await run({ ...input('upgrade-routing'), planId: desired.planId }, mock)).mutations, 0);
});

test('routing flag state fences approval and uncertain upgrades cannot retry or accept other flags', async () => {
  const mock = owned(provider({ existing: true })); Object.assign(mock.state, { enabled: true, secret: true, cron: true });
  const plan = await run(input('plan'), mock); mock.state.flags = [P.routingFlag];
  assert.equal((await run({ ...input('upgrade-routing'), planId: plan.planId }, mock)).status, 'plan_changed');
  mock.state.flags = ['nodejs_compat']; assert.equal((await run(input('plan'), mock)).status, 'configuration_conflict');
  assert.ok(mock.calls.every(call => call.method === 'GET'));
  const uncertain = owned(provider({ existing: true, intercept: async (_url, options) => { if (options.method === 'PUT') throw new Error(apiToken); } }));
  Object.assign(uncertain.state, { enabled: true, secret: true, cron: true }); const approved = await run(input('plan'), uncertain);
  const result = await run({ ...input('upgrade-routing'), planId: approved.planId }, uncertain);
  assert.equal(result.uncertainStep, 'routing-upgrade'); assert.equal(result.readbackRequired, true);
  assert.equal(uncertain.calls.filter(call => call.method === 'PUT').length, 1); assert.equal(uncertain.calls.at(-1).method, 'PUT');
});

test('an undeployed latest upload is never an admitted secret inheritance source', async () => {
  const mock = owned(provider({ existing: true })); Object.assign(mock.state, { enabled: true, secret: true, cron: true, latestVersionId: uuid(99) });
  const result = await run(input('plan'), mock);
  assert.equal(result.status, 'configuration_conflict'); assert.equal(result.mutations, 0);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('routing upgrade binds and preserves supported existing observability, rejecting off or unfamiliar settings', async () => {
  // Actual sanitized account readback: optional flags were absent from runtime
  // resources, while current /settings explicitly reported the empty flag list.
  const settings = { enabled: true, head_sampling_rate: 1, redact_query_string: false,
    logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true }, traces: { enabled: false, persist: true, head_sampling_rate: 1 } };
  const mock = owned(provider({ existing: true })); Object.assign(mock.state, { enabled: true, secret: true, cron: true, observability: settings });
  mock.state.omitVersionFlags = true;
  let plan = await run(input('plan'), mock);
  assert.deepEqual(plan.resource.observability, settings); assert.match(plan.resource.observabilityDigest, /^[a-f0-9]{64}$/);
  mock.state.observability = { ...settings, head_sampling_rate: 0.5 };
  assert.equal((await run({ ...input('upgrade-routing'), planId: plan.planId }, mock)).status, 'plan_changed');
  plan = await run(input('plan'), mock); const result = await run({ ...input('upgrade-routing'), planId: plan.planId }, mock);
  assert.equal(result.mutations, 1); assert.deepEqual(result.resource.observability, { ...settings, head_sampling_rate: 0.5 });
  for (const observability of [{ enabled: false }, { enabled: true, unknown: apiToken }, { ...settings, traces: { enabled: true } }]) {
    mock.state.observability = observability; const denied = await run(input('plan'), mock);
    assert.equal(denied.status, 'configuration_conflict'); assert.equal(denied.mutations, 0); assert.ok(!JSON.stringify(denied).includes(apiToken));
  }
});

test('current settings cannot disagree with present immutable version flags or the reviewed runtime date', async () => {
  for (const mismatch of ['flags', 'date', 'observability']) {
    const mock = owned(provider({ existing: true, intercept: async (url, options, state) => {
      if (options.method === 'GET' && url.endsWith('/settings')) return envelope({ compatibility_date: mismatch === 'date' ? '2026-10-12' : P.compatibilityDate,
        compatibility_flags: mismatch === 'flags' ? [P.routingFlag] : state.flags,
        observability: mismatch === 'observability' ? { enabled: true, head_sampling_rate: 0.5 } : state.observability });
    } }));
    Object.assign(mock.state, { enabled: true, secret: true, cron: true });
    const result = await run(input('plan'), mock); assert.equal(result.status, 'configuration_conflict'); assert.equal(result.mutations, 0);
  }
});

test('the known legacy runtime has one explicit new-code upgrade preserving existing capabilities', async () => {
  const mock = legacy(provider({ existing: true })); Object.assign(mock.state, { enabled: true, secret: true, cron: true, flags: [P.routingFlag] });
  const verified = await run(input('verify'), mock);
  assert.equal(verified.status, 'runtime_upgrade_required'); assert.equal(verified.resource.runtimeReady, false);
  assert.equal(verified.resource.sourceSha256, P.legacyArtifactSha256);
  const plan = await run(input('plan'), mock); assert.deepEqual(plan.operations, ['runtime-upgrade']);
  const before = mock.calls.length;
  const result = await run({ ...input('upgrade-runtime'), planId: plan.planId }, mock);
  assert.equal(result.status, 'configured_pending_runtime_verification'); assert.equal(result.mutations, 1);
  assert.equal(result.resource.runtimeReady, true); assert.equal(result.resource.sourceSha256, P.artifactSha256);
  assert.deepEqual(mock.calls.slice(before).filter(call => call.method !== 'GET').map(call => [call.method, new URL(call.url).search]), [['PUT', '?bindings_inherit=strict']]);
  assert.deepEqual(Buffer.from(mock.state.bytes), bytes); assert.equal(mock.state.enabled, true); assert.equal(mock.state.secret, true);
  assert.equal(mock.state.cron, true); assert.equal(mock.state.publicHttp, false);
  const current = await run(input('plan'), mock); assert.deepEqual(current.operations, []);
  assert.equal((await run({ ...input('upgrade-runtime'), planId: current.planId }, mock)).mutations, 0);
});

test('runtime migration rejects wrong code tags, absent routing, replacement keys and implicit routing upgrades', async () => {
  const mock = legacy(provider({ existing: true })); Object.assign(mock.state, { enabled: true, secret: true, cron: true, flags: [P.routingFlag] });
  const plan = await run(input('plan'), mock);
  assert.equal((await run({ ...input('upgrade-routing'), planId: plan.planId }, mock)).status, 'configuration_conflict');
  assert.equal((await run({ ...input('upgrade-runtime'), planId: plan.planId, hmacKey }, mock)).status, 'invalid_control');
  mock.state.tags[1] = `sha256:${P.artifactSha256}`;
  assert.equal((await run(input('plan'), mock)).status, 'ownership_conflict');
  mock.state.tags[1] = `sha256:${P.legacyArtifactSha256}`; mock.state.flags = [];
  assert.equal((await run(input('plan'), mock)).status, 'configuration_conflict');
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('an uncertain runtime upload stops for readback and unchanged legacy code cannot pass final readback', async () => {
  for (const variant of ['uncertain', 'not-adopted']) {
    const mock = legacy(provider({ existing: true, intercept: async (_url, options) => {
      if (options.method === 'PUT') { if (variant === 'uncertain') throw new Error(apiToken); return envelope({ id: P.scriptName }); }
    } }));
    Object.assign(mock.state, { enabled: true, secret: true, cron: true, flags: [P.routingFlag] });
    const plan = await run(input('plan'), mock), result = await run({ ...input('upgrade-runtime'), planId: plan.planId }, mock);
    assert.equal(result.readbackRequired, true); assert.equal(result.mutations, 1);
    assert.equal(result.status, variant === 'uncertain' ? 'api_unavailable' : 'readback_failed');
    if (variant === 'uncertain') assert.equal(result.uncertainStep, 'runtime-upgrade');
    assert.equal(mock.calls.filter(call => call.method !== 'GET').length, 1);
  }
});
