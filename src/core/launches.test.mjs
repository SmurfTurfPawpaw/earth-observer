import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLaunchRecords, createLaunchSitesLayer } from './launches.js';

const record = { id: 'launch-1', name: 'Example mission', net: '2026-10-15T12:30:00Z',
  pad: { latitude: '28.6', longitude: '-80.6', name: 'Public launch pad', location: { name: 'Florida' } },
  status: { name: 'Go' }, launch_service_provider: { name: 'Example provider' } };

test('launch markers require published coordinates and deduplicate records', () => {
  const records = normalizeLaunchRecords({ results: [record, record,
    { ...record, id: 'missing', pad: { latitude: null, longitude: null } },
    { ...record, id: 'invalid', pad: { latitude: 190, longitude: 10 } }] });
  assert.equal(records.length, 1);
  assert.equal(records[0].scheduledAt, Date.parse(record.net));
  assert.equal(records[0].latitude, 28.6);
});

test('missions create fixed site entities, preserve stale indication and cancel on disable', async () => {
  const sources = new Set();
  const viewer = { dataSources: { add: (source) => sources.add(source), remove: (source) => sources.delete(source) },
    scene: { requestRender() {} }, camera: { flyTo() {} }, isDestroyed: () => false };
  let signal;
  const layer = createLaunchSitesLayer({ source: { async getLaunchSnapshot(options) {
    signal = options.signal; return { payload: { results: [record] }, stale: true };
  } } });
  layer.init(viewer); layer.enable(); await layer.update(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().stale, true);
  const entity = [...sources][0].entities.values[0];
  assert.equal(entity.properties.positionMeaning.getValue(), 'Fixed launch site; no rocket location is represented');
  assert.equal(entity.position.isConstant, true);
  layer.disable(); assert.equal([...sources][0].show, false);
  assert.equal(signal.aborted, false);
  layer.destroy(); assert.equal(sources.size, 0);
});
