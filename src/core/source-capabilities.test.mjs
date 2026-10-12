import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_CAPABILITIES, getSourceCapability, listSourceCapabilities } from './source-capabilities.js';
import { COLLECTOR_PLUGINS } from '../../worker/collector.js';
import { EONET_QUERY_URL } from '../../server/hosted/eonet-snapshot.js';
import { GDELT_SNAPSHOT_URL } from '../../server/hosted/gdelt-snapshot.js';
import { WEATHER_PRODUCTS } from '../layers/weather/source.js';
import { SOURCE_PLUGINS } from '../../worker/plugins/registry.js';
import { createSiteMcpHandler, SITE_MCP_PROTOCOL_VERSION } from '../../worker/site-mcp.js';

test('capability ledger agrees with retained acquisition adapters and bounds', () => {
  assert.deepEqual(listSourceCapabilities().filter((source) => source.implementation.collectorRegistry).map((source) => source.id), COLLECTOR_PLUGINS.map((plugin) => plugin.id));
  for (const plugin of COLLECTOR_PLUGINS) {
    const capability = getSourceCapability(plugin.id);
    assert.equal(capability.access.endpoint, plugin.endpoint);
    assert.equal(capability.bounds.maxRecords, plugin.maxRecords);
    assert.equal(capability.cadence.checkIntervalMs, plugin.checkIntervalMs);
    assert.equal(capability.implementation.independentTrigger, 'unverified');
  }
  assert.equal(getSourceCapability('eonet').access.endpoint, EONET_QUERY_URL);
  assert.equal(getSourceCapability('gdelt').access.endpoint, GDELT_SNAPSHOT_URL);
});

test('all actual timed weather products have bounded valid-frame capabilities', () => {
  for (const product of WEATHER_PRODUCTS) {
    const source = getSourceCapability(`nowcoast-${product}`);
    assert.ok(source, `${product} needs a reviewed time contract`);
    assert.equal(source.kind, 'observation-raster');
    assert.equal(source.history.current, 'provider-advertised-valid-frames');
    assert.equal(source.history.asKnownThen, 'unsupported');
    assert.equal(source.history.future, 'unsupported');
    assert.equal(source.interpolation.extrapolation, false);
    assert.equal(source.bounds.maxManifestFrames, 13);
  }
});

test('unknown sources fail closed and descriptive capabilities cannot be altered by consumers', () => {
  assert.equal(getSourceCapability('unreviewed-provider'), null);
  assert.equal(getSourceCapability('__proto__'), null);
  assert.equal(getSourceCapability(null), null);
  assert.throws(() => { getSourceCapability('gdelt').geography.type = 'exact-event-point'; }, TypeError);
  assert.throws(() => { SOURCE_CAPABILITIES.sources.push({ id: 'new' }); }, TypeError);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(SOURCE_CAPABILITIES)));
});

test('calculated astronomy is separate from observed acquisition and event prediction', () => {
  const source = getSourceCapability('astronomy');
  assert.equal(source.access.endpoint, null);
  assert.equal(source.cadence.checkIntervalMs, null);
  assert.equal(source.history.future, 'calculated');
  assert.equal(source.interpolation.mode, 'calculated');
  for (const source of listSourceCapabilities().filter((item) => item.implementation.collectorRegistry)) {
    assert.equal(source.history.future, 'unsupported');
    assert.equal(source.interpolation.extrapolation, false);
  }
});

test('typed institutional/data plugins match the actual registry and cannot become four-source incident layers', () => {
  assert.equal(SOURCE_CAPABILITIES.schemaVersion, 1); assert.equal(SOURCE_CAPABILITIES.revision, 6);
  const typed = listSourceCapabilities().filter(source => source.implementation.typedPluginRegistry);
  assert.deepEqual(typed.map(source => source.id), SOURCE_PLUGINS.map(plugin => plugin.pluginId));
  for (const plugin of SOURCE_PLUGINS) {
    const source = getSourceCapability(plugin.pluginId);
    assert.equal(source.pluginId, plugin.pluginId); assert.equal(source.scopeId, plugin.scopeId); assert.equal(source.kind, plugin.kind);
    assert.equal(source.access.endpoint, plugin.sourceUrl); assert.equal(source.cadence.checkIntervalMs, plugin.cadenceMs);
    for (const key of ['maxResponseBytes', 'maxArtifactBytes', 'deadlineMs']) assert.equal(source.bounds[key], plugin[key]);
    assert.equal(source.bounds.maxRecords, plugin.maxItems); assert.equal(source.implementation.collectorRegistry, false);
    assert.equal(source.incidentLayer, false); assert.equal(source.implementation.independentTrigger, 'unverified');
    assert.equal(source.history.backfillImplemented, false); assert.equal(source.history.future, 'unsupported');
    assert.equal(source.interpolation.extrapolation, false); assert.equal(source.cadence.providerIntervalMs, null);
    assert.equal(COLLECTOR_PLUGINS.some(collector => collector.id === source.id), false);
    if(plugin.kind!=='observation-feed')assert.equal(COLLECTOR_PLUGINS.some(collector=>collector.id===source.sourceId),false);
    assert.throws(() => { source.incidentLayer = true; }, TypeError);
  }
  assert.equal(getSourceCapability('eurostat-gas-origins-v1').bounds.unit, 'TJ_GCV');
  assert.equal(getSourceCapability('eurostat-gas-origins-v1').bounds.frequency, 'A');
  assert.equal(getSourceCapability('ecb-press-v1').access.publicRead, '/api/publications');
  assert.equal(getSourceCapability('ec-press-v1').bounds.observedProviderWindow, 10);
  assert.equal(getSourceCapability('ec-press-v1').geography.type, 'none');
  assert.match(getSourceCapability('ec-press-v1').history.upstreamArchive, /body language is unknown/);
  const live=getSourceCapability('usgs-live-day-m2-5-v1');
  assert.equal(live.bounds.minimumMagnitude,2.5);assert.equal(live.bounds.windowHours,24);assert.equal(live.bounds.maxObservationRecords,500);
  assert.equal(live.access.publicRead,'/api/layers/earthquakes');assert.notEqual(live.access.endpoint,getSourceCapability('usgs').access.endpoint);
  assert.equal(getSourceCapability('usgs').bounds.minimumMagnitude,4.5);assert.equal(getSourceCapability('usgs').bounds.windowDays,7);
});

test('actual MCP capability schema and read-only tool return both typed entries without acquiring or publishing', async () => {
  let sideEffects = 0;
  const handle = createSiteMcpHandler({ fetchImpl: async () => { sideEffects++; throw Error('Unexpected acquisition'); },
    collectionHandler: async () => { sideEffects++; throw Error('Unexpected publication'); } });
  const request = (method, params) => new Request('https://giovannicallebaut.com/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', 'mcp-protocol-version': SITE_MCP_PROTOCOL_VERSION, 'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': SITE_MCP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {},
  } } }) });
  const listed = await (await handle(request('tools/list', {}))).json();
  const allowedIds = listed.result.tools.find(tool => tool.name === 'source_capabilities').inputSchema.properties.sourceId.enum;
  for (const plugin of SOURCE_PLUGINS) {
    assert.ok(allowedIds.includes(plugin.pluginId));
    const response = await handle(request('tools/call', { name: 'source_capabilities', arguments: { sourceId: plugin.pluginId } }));
    assert.equal(response.status, 200); const payload = await response.json(), source = JSON.parse(payload.result.content[0].text);
    assert.equal(source.id, plugin.pluginId); assert.equal(source.incidentLayer, false); assert.equal(source.implementation.collectorRegistry, false);
  }
  assert.equal(sideEffects, 0);
});
