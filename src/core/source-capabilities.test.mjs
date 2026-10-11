import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_CAPABILITIES, getSourceCapability, listSourceCapabilities } from './source-capabilities.js';
import { COLLECTOR_PLUGINS } from '../../worker/collector.js';
import { EONET_QUERY_URL } from '../../server/hosted/eonet-snapshot.js';
import { GDELT_SNAPSHOT_URL } from '../../server/hosted/gdelt-snapshot.js';
import { WEATHER_PRODUCTS } from '../layers/weather/source.js';

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
