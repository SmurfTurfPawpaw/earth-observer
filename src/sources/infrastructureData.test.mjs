import test from 'node:test';
import assert from 'node:assert/strict';
import { createInfrastructureSource, featurePoint } from './infrastructureData.js';

const fixture = [
  { type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [4, 50] }, properties: { tags: { name: 'Shared name', operator: 'Example operator', capacity: '20 MW' } } },
  { type: 'Feature', id: 2, geometry: { type: 'Polygon', coordinates: [[[4, 50], [5, 50], [4, 51], [4, 50]]] }, properties: { tags: { name: 'Shared name' } } },
].map((feature) => JSON.stringify(feature)).join('\n');

test('a multiline dam retains its representative point rather than disappearing from the inventory', () => {
  assert.deepEqual(featurePoint({ geometry: { type: 'MultiLineString', coordinates: [[[4, 50], [6, 50]], [[5, 53]]] } }), { lon: 5, lat: 51 });
});

test('infrastructure source preserves distinct identities and approximate geometry meaning, then caches', async () => {
  let requests = 0;
  const source = createInfrastructureSource({ fetchImpl: async () => { requests++; return { ok: true, text: async () => fixture }; } });
  const records = await source.getRecords('local-datacenters');
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.id), ['1', '2']);
  assert.equal(records[0].name, records[1].name);
  assert.equal(records[0].approximate, false);
  assert.equal(records[1].approximate, true);
  assert.equal(records[1].geometryType, 'Polygon');
  assert.equal(records[0].operator, 'Example operator');
  assert.equal(records[0].capacity, '20 MW');
  assert.equal(await source.getRecords('local-datacenters'), records);
  assert.equal(requests, 1);
});

test('an abort during response-body reading cannot publish a source cache entry', async () => {
  let requests = 0;
  const body = Promise.withResolvers(), reading = Promise.withResolvers();
  const source = createInfrastructureSource({ fetchImpl: async () => {
    requests++;
    return { ok: true, text: () => { reading.resolve(); return requests === 1 ? body.promise : Promise.resolve(fixture); } };
  } });
  const controller = new AbortController();
  const aborted = source.getRecords('local-datacenters', { signal: controller.signal });
  await reading.promise; controller.abort(); body.resolve('invalid JSON must never be parsed after cancellation');
  await assert.rejects(aborted, { name: 'AbortError' });
  const records = await source.getRecords('local-datacenters');
  assert.equal(records.length, 2);
  assert.equal(requests, 2);
  await assert.rejects(source.getRecords('local-datacenters', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await source.getRecords('local-datacenters'), records);
  assert.equal(requests, 2);
});
