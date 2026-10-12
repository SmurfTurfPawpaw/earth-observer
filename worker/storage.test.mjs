import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderStore } from './storage.js';

function bucket() {
  const objects = new Map(); let serial = 0;
  return {
    objects, writes: [],
    async get(key) { const object = objects.get(key); return object ? { etag: object.etag, json: async () => JSON.parse(object.body) } : null; },
    async put(key, body, options = {}) {
      this.writes.push({ key, options }); const previous = objects.get(key);
      if (options.onlyIf?.get?.('if-none-match') === '*' && previous || options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
      const value = { etag: String(++serial), body }; objects.set(key, value); return value;
    },
  };
}

test('R2 versioned missing-object admission is atomic and preserves provider JSON metadata', async () => {
  const binding = bucket(), one = createProviderStore({ EARTH_STORE: binding }), two = createProviderStore({ EARTH_STORE: binding });
  assert.deepEqual(await one.getVersioned('gdelt:snapshot'), { value: null, version: null });
  const admitted = await Promise.all([one.putIfVersion('gdelt:snapshot', { winner: 1 }, null), two.putIfVersion('gdelt:snapshot', { winner: 2 }, null)]);
  assert.deepEqual(admitted, [true, false]); assert.deepEqual(await two.get('gdelt:snapshot'), { winner: 1 });
  assert.equal(binding.writes[0].key, 'providers/gdelt%3Asnapshot.json');
  assert.equal(binding.writes[0].options.onlyIf.get('if-none-match'), '*');
  assert.equal(binding.writes[0].options.httpMetadata.contentType, 'application/json');
});

test('R2 existing-object writes admit only the exact retained version and reject late old writers', async () => {
  const binding = bucket(), one = createProviderStore({ EARTH_STORE: binding }), two = createProviderStore({ EARTH_STORE: binding });
  await one.put('state', { generation: 1 }); const prior = await two.getVersioned('state');
  assert.equal(typeof prior.version, 'string'); assert.deepEqual(prior.value, { generation: 1 });
  assert.equal(await two.putIfVersion('state', { generation: 2 }, prior.version), true);
  assert.equal(await one.putIfVersion('state', { generation: 0 }, prior.version), false);
  assert.deepEqual(await one.get('state'), { generation: 2 });
  assert.equal(binding.writes.at(-1).options.onlyIf.etagMatches, prior.version);
  assert.notEqual((await one.getVersioned('state')).version, prior.version);
});

test('invalid/missing R2 versions and uncertain acknowledgements never become unconditional commit proof', async () => {
  let writes = 0;
  const store = createProviderStore({ EARTH_STORE: { async get() { return { json: async () => ({}) }; }, async put() { writes++; } } });
  await assert.rejects(store.getVersioned('state'), /Missing provider object version/);
  for (const invalid of [undefined, '', 42, {}]) await assert.rejects(store.putIfVersion('state', {}, invalid), /Invalid provider object version/);
  assert.equal(writes, 0); assert.equal(await store.putIfVersion('state', {}, null), undefined); assert.equal(writes, 1);
});

test('KV retains its existing best-effort adapter and does not expose pretend atomic snapshot primitives', async () => {
  const data = new Map(); const store = createProviderStore({ EARTH_CACHE: {
    async get(key) { return data.get(key) ?? null; }, async put(key, value) { data.set(key, value); },
  } });
  assert.equal(store.getVersioned, undefined); assert.equal(store.putIfVersion, undefined);
  await store.put('state', { value: 7 }); assert.deepEqual(await store.get('state'), { value: 7 });
  assert.equal(await store.claim('group', 1000, 500), true); assert.equal(await store.claim('group', 1200, 500), false);
  assert.equal(await store.claim('group', 1500, 500), true);
});
