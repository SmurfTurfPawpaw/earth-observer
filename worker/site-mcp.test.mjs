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
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['source_capabilities', 'collection_status', 'list_world_events', 'event_detail', 'source_dossier', 'list_publications', 'caller_identity', 'collect_sources']);
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

test('typed evidence tools advertise fixed scopes, strict UTC and read-only annotations without opening arbitrary source inputs', async () => {
  const handle = createSiteMcpHandler(), listed = await (await handle(rpc('tools/list'))).json();
  const dossier = listed.result.tools.find(({ name }) => name === 'source_dossier'), publications = listed.result.tools.find(({ name }) => name === 'list_publications');
  assert.deepEqual(dossier.inputSchema.properties.dossierId.enum, ['belgium-natural-gas-origins']); assert.deepEqual(dossier.inputSchema.required, ['dossierId']);
  assert.deepEqual(publications.inputSchema.properties.pluginId.enum, ['ecb-press-v1', 'ec-press-v1']); assert.deepEqual(publications.inputSchema.required, ['pluginId']);
  for (const tool of [dossier, publications]) {
    assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.destructiveHint, false); assert.ok(new RegExp(tool.inputSchema.properties.knownAt.pattern).test('2026-10-10T12:00:00.000Z'));
    assert.ok(!new RegExp(tool.inputSchema.properties.knownAt.pattern).test('2026-10-10T12:00:00Z'));
  }
  assert.equal(publications.inputSchema.properties.limit.minimum, 1); assert.equal(publications.inputSchema.properties.limit.maximum, 40);
  assert.match(publications.inputSchema.properties.at.description, /independent/);
});

test('fixed dossier and publication readers return their exact receipts and independent source/knowledge cutoffs for an anonymous visitor', async () => {
  const reads = []; let writes = 0, upstream = 0;
  const receipt = { id: 'receipt:' + 'a'.repeat(64), capturedAt: '2026-10-10T11:59:00.000Z', recordedAt: '2026-10-10T12:00:00.000Z',
    rawSha256: 'b'.repeat(64), factsDigest: 'c'.repeat(64), artifactSha256: 'd'.repeat(64) };
  const gas = { schemaVersion: 1, configured: true, available: true, plugin: { id: 'eurostat-gas-origins-v1', scopeId: 'belgium-natural-gas-origins' }, receipt,
    artifact: { kind: 'dataset-dossier', referenceYears: ['2024'], unit: { code: 'TJ_GCV' } } };
  const ecb = { schemaVersion: 1, configured: true, available: true, plugin: { id: 'ecb-press-v1', scopeId: 'ecb-institutional-press-en-v1' }, receipt,
    items: [{ itemId: 'publication:fixture', publishedAt: '2026-10-07T08:00:00.000Z', firstRecordedAt: receipt.recordedAt, lastRecordedAt: receipt.recordedAt,
      evidence: { ...receipt, locator: { kind: 'rss-guid', guid: 'https://www.ecb.europa.eu//press/pr/date/2026/html/ecb.pr261007~0000000001.en.html' } } }], counts: { returned: 1, more: false } };
  const env = ownerEnv(), handle = createSiteMcpHandler({ now: () => NOW,
    readSourceDossier: async (receivedEnv, plugin, options) => { assert.equal(receivedEnv, env); reads.push({ plugin, ...options }); return gas; },
    readPublications: async (receivedEnv, plugin, options) => { assert.equal(receivedEnv, env); reads.push({ plugin, ...options }); return ecb; },
    collectionHandler: async () => { writes++; throw Error('unexpected writer'); }, fetchImpl: async () => { upstream++; throw Error('unexpected provider'); } });
  const cutoff = '2026-10-10T13:00:00.000Z', publicationAt = '2026-10-09T00:00:00.000Z';
  const dossier = await (await handle(call('source_dossier', { dossierId: 'belgium-natural-gas-origins', knownAt: cutoff }), env)).json();
  assert.equal(dossier.result.isError, false); assert.deepEqual(dossier.result.structuredContent, gas); assert.deepEqual(toolValue(dossier), gas);
  const publications = await (await handle(call('list_publications', { pluginId: 'ecb-press-v1', at: publicationAt, knownAt: cutoff, limit: 40 }), env)).json();
  assert.deepEqual(toolValue(publications), ecb); assert.deepEqual(publications.result.structuredContent.items[0].evidence, ecb.items[0].evidence);
  await handle(call('list_publications', { pluginId: 'ecb-press-v1' }), env);
  assert.deepEqual(reads.map(({ now, ...options }) => { assert.equal(now(), NOW); return options; }), [
    { plugin: 'eurostat-gas-origins-v1', knownAt: cutoff }, { plugin: 'ecb-press-v1', at: publicationAt, knownAt: cutoff, limit: 40 },
    { plugin: 'ecb-press-v1', at: null, knownAt: null, limit: 20 },
  ]);
  assert.equal(upstream, 0); assert.equal(writes, 0);
});

test('missing, foreign and undeclared evidence-tool inputs fail before reads; only canonical millisecond UTC and integer publication limits are admitted', async () => {
  let reads = 0, writes = 0, upstream = 0;
  const handle = createSiteMcpHandler({ now: () => NOW, readSourceDossier: async () => { reads++; return {}; }, readPublications: async () => { reads++; return {}; },
    collectionHandler: async () => { writes++; }, fetchImpl: async () => { upstream++; } });
  const scopes = [['source_dossier', { dossierId: 'belgium-natural-gas-origins' }], ['list_publications', { pluginId: 'ecb-press-v1' }]];
  for (const [name, base] of scopes) {
    const invalid = [{}, { ...base, [name === 'source_dossier' ? 'dossierId' : 'pluginId']: 'foreign' }, null, [],
      { ...base, url: 'https://example.test/source' }, { ...base, action: 'collect' }, { ...base, token: TOKEN }, { ...base, code: 'fetch()' },
      ...['2026-02-30T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-10-10T12:00:00Z', '2026-10-10T14:00:00.000+02:00', '2026-10-10', null, 0].map(knownAt => ({ ...base, knownAt }))];
    if (name === 'list_publications') invalid.push(...[0, 41, '20', 1.5, null].map(limit => ({ ...base, limit })), { ...base, at: '2026-02-30T00:00:00.000Z' },
      { ...base, at: '2026-10-10T12:00:00Z' }, { ...base, at: '2027-01-01T00:00:00.000Z' });
    for (const args of invalid) assert.equal(toolValue(await (await handle(call(name, args))).json()).error, 'invalid_arguments');
  }
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(upstream, 0);
});

test('unconfigured source storage returns exact typed unavailability through real readers without acquiring, writing or scheduling work', async () => {
  let upstream = 0, writes = 0, scheduled = 0;
  const handle = createSiteMcpHandler({ now: () => NOW, fetchImpl: async () => { upstream++; throw Error('unexpected provider'); }, collectionHandler: async () => { writes++; } });
  const ctx = { waitUntil() { scheduled++; } }, env = { EARTH_STORE: { get: async () => null, put: async () => { writes++; } } };
  for (const [name, args, plugin] of [['source_dossier', { dossierId: 'belgium-natural-gas-origins' }, 'eurostat-gas-origins-v1'], ['list_publications', { pluginId: 'ecb-press-v1' }, 'ecb-press-v1']]) {
    const result = await (await handle(call(name, args), env, ctx)).json(), value = toolValue(result);
    assert.equal(result.result.isError, false); assert.equal(value.schemaVersion, 1); assert.equal(value.plugin.id, plugin); assert.equal(value.configured, false);
    assert.equal(value.available, false); assert.equal(value.receipt, null); assert.equal(value.artifact, null); assert.match(value.explanation, /not configured/);
    if (name === 'list_publications') { assert.deepEqual(value.items, []); assert.deepEqual(value.counts, { returned: 0, more: false }); }
  }
  assert.equal(upstream, 0); assert.equal(writes, 0); assert.equal(scheduled, 0);
});

test('new stored evidence tools preserve delivery budgets, deadline admission and unavailable-history explanations', async () => {
  const budget = { schemaVersion: 1, configured: true, available: false, receipt: null, artifact: null, items: [], counts: { returned: 0, more: false },
    errorCode: 'historical-delivery-budget', explanation: 'Knowledge-time query exceeds the retained pilot budget; no incomplete history substituted.' };
  const budgeted = createSiteMcpHandler({ readPublications: async () => budget });
  assert.deepEqual(toolValue(await (await budgeted(call('list_publications', { pluginId: 'ecb-press-v1' }))).json()), budget);
  const large = createSiteMcpHandler({ readSourceDossier: async () => ({ available: true, artifact: { content: 'x'.repeat(SITE_MCP_LIMITS.resultBytes) } }) });
  const limited = await large(call('source_dossier', { dossierId: 'belgium-natural-gas-origins' })), limitedText = await limited.text();
  assert.equal(toolValue(JSON.parse(limitedText)).error, 'result_too_large'); assert.ok(new TextEncoder().encode(limitedText).byteLength < SITE_MCP_LIMITS.resultBytes);
  const stalled = createSiteMcpHandler({ deadlineMs: 15, readPublications: async () => new Promise(() => {}) });
  assert.equal(toolValue(await (await stalled(call('list_publications', { pluginId: 'ecb-press-v1' }))).json()).error, 'request_deadline');
});

test('Commission publication tool keeps exact reviewed scope and metadata in an anonymous read without acquisition or writes', async () => {
  let reads = 0, writes = 0, fetches = 0;
  const payload = { schemaVersion: 1, available: true, plugin: { id: 'ec-press-v1', scopeId: 'ec-presscorner-en-metadata-v1' },
    items: [{ documentReference: 'statement_26_2127', documentType: 'statement', categories: ['POLICY_AREA=GROWTH,JFRC'] }], counts: { returned: 1, more: false } };
  const knownAt = '2026-10-10T13:00:00.000Z', at = '2026-10-09T00:00:00.000Z';
  const handle = createSiteMcpHandler({ now: () => NOW,
    readPublications: async (_, plugin, options) => { reads++; assert.equal(plugin, 'ec-press-v1'); assert.equal(options.knownAt, knownAt); assert.equal(options.at, at); assert.equal(options.limit, 20); return payload; },
    collectionHandler: async () => { writes++; }, fetchImpl: async () => { fetches++; } });
  const result = await (await handle(call('list_publications', { pluginId: 'ec-press-v1', at, knownAt }), {})).json();
  assert.deepEqual(toolValue(result), payload); assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(fetches, 0);
});
