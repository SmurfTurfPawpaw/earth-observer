import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteMcpHandler, SITE_MCP_LIMITS, SITE_MCP_PROTOCOL_VERSION } from './site-mcp.js';

const URL = 'https://giovannicallebaut.com/mcp';
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPS_KEY = 'io.modelcontextprotocol/clientCapabilities';
const INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const NOW = Date.parse('2026-10-11T22:00:00.000Z');
const OWNER = 'site-scoped-owner-fixture';
const TOKEN = 'test_collector_fixture_'.padEnd(64, 'x');
const ownerEnv = () => ({ EARTH_MCP_TRUST_SITES_IDENTITY: '1', EARTH_OWNER_USER_ID: OWNER, EARTH_COLLECTOR_TOKEN: TOKEN });

function rpc(method, params = {}, { modern = true, headerOverrides = {}, bodyOverrides = {}, id = 1 } = {}) {
  const headers = { 'content-type': 'application/json',
    ...(modern ? { 'mcp-protocol-version': SITE_MCP_PROTOCOL_VERSION, 'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}) } : {}), ...headerOverrides };
  const value = { jsonrpc: '2.0', id, method, params: { ...params,
    ...(modern ? { _meta: { [VERSION_KEY]: SITE_MCP_PROTOCOL_VERSION, [CAPS_KEY]: {} } } : {}) }, ...bodyOverrides };
  for (const [key, value] of Object.entries(headers)) if (value === null) delete headers[key];
  return new Request(URL, { method: 'POST', headers, body: JSON.stringify(value) });
}
const call = (name, args = {}, options) => rpc('tools/call', { name, arguments: args }, options);
const toolValue = (payload) => JSON.parse(payload.result.content[0].text);

test('modern discovery and tool calls carry required result identity and bounded schemas', async () => {
  const handle = createSiteMcpHandler();
  const discovery = await (await handle(rpc('server/discover'))).json();
  assert.equal(discovery.result.resultType, 'complete');
  assert.equal(discovery.result._meta[INFO_KEY].name, 'earth-observer');
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  assert.equal(discovery.result.ttlMs, 0);
  assert.equal(discovery.result.cacheScope, 'private');
  const listed = await (await handle(rpc('tools/list'))).json();
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['source_capabilities', 'collection_status', 'list_world_events', 'event_detail', 'caller_identity', 'collect_sources']);
  assert.equal(listed.result.tools.find(({ name }) => name === 'collect_sources').inputSchema.additionalProperties, false);
  const bare = await (await handle(rpc('server/discover', {}, { modern: false }))).json();
  assert.deepEqual(bare.result.supportedVersions, discovery.result.supportedVersions);
});

test('modern envelope/header mismatches and unsupported revisions fail before side effects', async () => {
  let writes = 0;
  const handle = createSiteMcpHandler({ collectionHandler: async () => { writes++; throw Error('unexpected'); } });
  for (const headers of [{ 'mcp-protocol-version': null }, { 'mcp-method': 'tools/list' }, { 'mcp-name': 'collection_status' }]) {
    const response = await handle(call('collect_sources', {}, { headerOverrides: { 'oai-authenticated-user-id': OWNER, ...headers } }), ownerEnv());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32020);
  }
  const unsupported = await handle(rpc('server/discover', {}, { bodyOverrides: { params: { _meta: { [VERSION_KEY]: '2099-01-01', [CAPS_KEY]: {} } } } }));
  assert.equal((await unsupported.json()).error.code, -32022);
  assert.equal(writes, 0);
});

test('stored-only reads cannot fetch providers, publish, or claim missing world data', async () => {
  let upstream = 0, writes = 0, storedReads = 0;
  const env = { EARTH_STORE: { get: async () => { storedReads++; return null; }, put: async () => { writes++; } } };
  const handle = createSiteMcpHandler({ fetchImpl: async () => { upstream++; throw Error('Provider access is forbidden for reads'); } });
  for (const name of ['source_capabilities', 'collection_status', 'list_world_events', 'caller_identity']) {
    const output = await (await handle(call(name), env)).json();
    if (name === 'list_world_events') assert.equal(toolValue(output).error, 'stored_data_unavailable');
    else assert.equal(output.result.isError, false);
  }
  assert.ok(storedReads > 0);
  assert.equal(upstream, 0);
  assert.equal(writes, 0);
});

test('identity returns only the current caller, and owner write gates fail closed', async () => {
  let writes = 0;
  const handle = createSiteMcpHandler({ collectionHandler: async () => { writes++; throw Error('unexpected'); } });
  const trials = [
    [{ ...ownerEnv(), EARTH_MCP_TRUST_SITES_IDENTITY: '0' }, { 'oai-authenticated-user-id': OWNER }],
    [ownerEnv(), {}],
    [ownerEnv(), { 'oai-authenticated-user-id': 'another-user' }],
    [{ ...ownerEnv(), EARTH_OWNER_USER_ID: '' }, { 'oai-authenticated-user-id': OWNER }],
    [ownerEnv(), { 'oai-authenticated-user-email': 'owner@example.test', 'oai-authenticated-user-full-name': OWNER }],
    [ownerEnv(), { 'oai-authenticated-user-id': OWNER, origin: 'https://giovannicallebaut.com' }],
  ];
  for (const [env, headers] of trials) {
    const output = await (await handle(call('collect_sources', {}, { headerOverrides: headers }), env)).json();
    assert.equal(output.result.isError, true);
    assert.equal(toolValue(output).error, 'owner_required');
  }
  const response = await handle(call('caller_identity', {}, { headerOverrides: {
    'oai-authenticated-user-id': 'another-user', 'oai-authenticated-user-email': 'hidden@example.test',
  } }), ownerEnv());
  const text = await response.text(), value = toolValue(JSON.parse(text));
  assert.equal(value.siteScopedUserId, 'another-user');
  assert.equal(value.isOwner, false);
  assert.ok(!text.includes('hidden@example.test'));
  assert.ok(!text.includes(OWNER));
  assert.equal(writes, 0);
});

test('server-only identity probe is opt-in, unverified and cannot grant owner collection', async () => {
  let writes = 0;
  const handle = createSiteMcpHandler({ collectionHandler: async () => { writes++; throw Error('unexpected'); } });
  const headers = { 'oai-authenticated-user-id': OWNER };
  const hiddenEnv = { ...ownerEnv(), EARTH_MCP_TRUST_SITES_IDENTITY: '0' };
  const hidden = toolValue(await (await handle(call('caller_identity', {}, { headerOverrides: headers }), hiddenEnv)).json());
  assert.equal(hidden.siteScopedUserId, null);
  assert.equal(Object.hasOwn(hidden, 'candidateHeaderId'), false);
  const probeEnv = { ...hiddenEnv, EARTH_MCP_IDENTITY_PROBE: '1' };
  const probe = toolValue(await (await handle(call('caller_identity', {}, { headerOverrides: headers }), probeEnv)).json());
  assert.equal(probe.candidateHeaderId, OWNER);
  assert.equal(probe.unverified, true);
  assert.equal(probe.identityTrusted, false);
  assert.equal(probe.siteScopedUserId, null);
  assert.equal(probe.isOwner, false);
  const denied = toolValue(await (await handle(call('collect_sources', {}, { headerOverrides: headers }), probeEnv)).json());
  assert.equal(denied.error, 'owner_required');
  const invalid = toolValue(await (await handle(call('caller_identity', {}, { headerOverrides: {
    'oai-authenticated-user-id': 'x'.repeat(257),
  } }), probeEnv)).json());
  assert.equal(invalid.candidateHeaderId, null);
  assert.equal(writes, 0);
});

test('owner writer delegates once to the existing handler with a server-only credential', async () => {
  let writes = 0, current = NOW;
  const handle = createSiteMcpHandler({ now: () => current, collectionHandler: async (request, _env, _ctx, options) => {
    writes++;
    assert.equal(request.url, 'https://earth-observer.internal/api/collector');
    assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(request.headers.has('origin'), false);
    assert.deepEqual(await request.json(), { action: 'collect' });
    assert.equal(typeof options.fetchImpl, 'function');
    return Response.json({ configured: true, stored: true, collectedAt: new Date(current).toISOString(), updatesPublished: true,
      privateFixture: TOKEN, packet: { neverReturnRawCollectionPacket: true } });
  } });
  const env = ownerEnv(), headers = { 'oai-authenticated-user-id': OWNER };
  const firstText = await (await handle(call('collect_sources', {}, { headerOverrides: headers }), env)).text();
  const first = JSON.parse(firstText);
  assert.equal(toolValue(first).stored, true);
  assert.ok(!firstText.includes(TOKEN));
  assert.ok(!firstText.includes('neverReturnRawCollectionPacket'));
  const second = await (await handle(call('collect_sources', {}, { headerOverrides: headers }), env)).json();
  assert.equal(toolValue(second).error, 'collection_busy');
  assert.equal(writes, 1);
  current += 60_000;
  assert.equal((await (await handle(call('collect_sources', {}, { headerOverrides: headers }), env)).json()).result.isError, false);
  assert.equal(writes, 2);
});

test('invalid bodies, methods, notifications and undeclared arguments cannot trigger collection', async () => {
  let writes = 0;
  const handle = createSiteMcpHandler({ collectionHandler: async () => { writes++; throw Error('unexpected'); } });
  assert.equal(await handle(new Request('https://giovannicallebaut.com/earth/')), null);
  assert.equal((await handle(new Request(URL))).status, 405);
  assert.equal((await handle(new Request(URL, { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await handle(new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[' }))).status, 400);
  assert.equal((await handle(new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(SITE_MCP_LIMITS.bodyBytes + 1) }))).status, 413);
  const foreign = await handle(call('collect_sources', {}, { headerOverrides: { origin: 'https://foreign.example', 'oai-authenticated-user-id': OWNER } }), ownerEnv());
  assert.equal(foreign.status, 403);
  const missingId = await handle(call('collect_sources', {}, { bodyOverrides: { id: undefined }, headerOverrides: { 'oai-authenticated-user-id': OWNER } }), ownerEnv());
  assert.equal(missingId.status, 400);
  for (const args of [{ url: 'https://example.test' }, { token: TOKEN }, { code: 'return true' }, { action: 'publish' }]) {
    const result = await (await handle(call('collect_sources', args, { headerOverrides: { 'oai-authenticated-user-id': OWNER } }), ownerEnv())).json();
    assert.equal(toolValue(result).error, 'invalid_arguments');
  }
  assert.equal(writes, 0);
});

test('world time/identity queries are bounded and retain stored semantics without source acquisition', async () => {
  const calls = [];
  const handle = createSiteMcpHandler({ now: () => NOW, readEvents: async (_env, args) => {
    calls.push(args); return { available: true, events: [{ id: args.id || 'event:usgs:' + 'a'.repeat(64) }], knownAt: args.knownAt || new Date(NOW).toISOString() };
  } });
  for (const args of [{ knownAt: '2026-02-30T00:00:00Z' }, { knownAt: '2027-01-01T00:00:00Z' }, { limit: 51 }, { limit: '20' }, { limit: 0 }]) {
    const output = await (await handle(call('list_world_events', args))).json();
    assert.equal(toolValue(output).error, 'invalid_arguments');
  }
  const cutoff = '2026-09-10T10:00:00.000Z';
  const result = await (await handle(call('list_world_events', { knownAt: cutoff, limit: 3 }))).json();
  assert.equal(toolValue(result).knownAt, cutoff);
  const id = 'event:usgs:' + 'b'.repeat(64);
  const detail = await (await handle(call('event_detail', { id, knownAt: cutoff }))).json();
  assert.equal(toolValue(detail).event.id, id);
  assert.deepEqual(calls, [{ knownAt: cutoff, limit: 3 }, { id, knownAt: cutoff, limit: 1 }]);
});

test('deadlines, oversized results and request admission bound resource use', async () => {
  let canceled = false;
  const handle = createSiteMcpHandler({ deadlineMs: 15 });
  const stalled = new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ cancel() { canceled = true; } }) });
  const timedOut = await (await handle(stalled)).json();
  assert.equal(toolValue(timedOut).error, 'request_deadline');
  assert.equal(canceled, true);
  let completeWrite, writeCalls = 0;
  const writing = createSiteMcpHandler({ deadlineMs: 15, now: () => NOW, collectionHandler: async () => {
    writeCalls++;
    return new Promise((resolve) => { completeWrite = resolve; });
  } });
  const env = ownerEnv(), options = { headerOverrides: { 'oai-authenticated-user-id': OWNER } };
  const pending = await (await writing(call('collect_sources', {}, options), env)).json();
  assert.equal(toolValue(pending).error, 'request_deadline');
  assert.match(toolValue(pending).message, /may have committed/);
  const retry = await (await writing(call('collect_sources', {}, options), env)).json();
  assert.equal(toolValue(retry).error, 'collection_busy');
  assert.equal(writeCalls, 1);
  completeWrite(Response.json({ configured: true, stored: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const large = createSiteMcpHandler({ readEvents: async () => ({ available: true, events: [{ text: 'x'.repeat(300_000) }] }) });
  const limited = await large(call('list_world_events'));
  const limitedText = await limited.text();
  assert.equal(toolValue(JSON.parse(limitedText)).error, 'result_too_large');
  assert.ok(new TextEncoder().encode(limitedText).byteLength < SITE_MCP_LIMITS.resultBytes);
  const admitted = createSiteMcpHandler();
  for (let i = 0; i < SITE_MCP_LIMITS.requestsPerCaller; i++) assert.equal((await admitted(rpc('server/discover'))).status, 200);
  const busy = await admitted(rpc('server/discover'));
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '60');
});
