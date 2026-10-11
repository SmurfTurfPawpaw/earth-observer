import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerManager, STORAGE_KEY } from './layer-manager.js';

const catalog = [{ id: 'test', defaults: { mode: 'safe' } }];
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function environment(createLayer, overrides = {}) {
  const timers = new Map();
  let timerId = 0;
  const events = new Map();
  const document = { hidden: false, addEventListener: (name, callback) => events.set(name, callback), removeEventListener: (name) => events.delete(name) };
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const viewer = { scene: { requestRender() {} } };
  const manager = createLayerManager(viewer, () => {}, {
    catalog, createLayer, createServices: () => ({ destroy() {} }), document, storage,
    setInterval: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearInterval: (id) => timers.delete(id), ...overrides,
  });
  return { manager, timers, document, saved, storage, visibility: () => events.get('visibilitychange')?.() };
}
function engine(calls) {
  let params = {};
  return {
    updateInterval: 5000,
    init() { calls.push('init'); }, enable() { calls.push('enable'); },
    update() { calls.push('update'); }, disable() { calls.push('disable'); },
    destroy() { calls.push('destroy'); },
    setParams(value) { params = { ...params, ...value }; }, getParams() { return params; },
    getStats() { return { count: 7, lastUpdate: 123 }; },
  };
}

test('recorded mode pauses live display and polling without changing saved intent; visibility cannot resume it', async () => {
  const calls = [], env = environment(async () => engine(calls));
  await env.manager.setEnabled('test', true); const saved = env.saved.get(STORAGE_KEY);
  await env.manager.setTimelineMode('history');
  assert.equal(env.manager.getState().test.enabled, true); assert.equal(env.manager.getState().test.settledEnabled, false);
  assert.equal(env.manager.getState().test.status, 'paused'); assert.equal(env.manager.isEffectivelyEnabled('test'), false);
  assert.equal(env.saved.get(STORAGE_KEY), saved); assert.equal(env.timers.size, 0);
  assert.equal(await env.manager.refresh('test'), false); const updates = calls.filter((value) => value === 'update').length;
  env.document.hidden = true; env.visibility(); env.document.hidden = false; env.visibility(); await settle();
  assert.equal(calls.filter((value) => value === 'update').length, updates); assert.equal(env.timers.size, 0);
  await env.manager.setTimelineMode('live');
  assert.equal(env.manager.getState().test.settledEnabled, true); assert.equal(env.manager.isEffectivelyEnabled('test'), true);
  assert.equal(env.saved.get(STORAGE_KEY), saved); assert.equal(env.timers.size, 1); assert.equal(calls.filter((value) => value === 'init').length, 1);
  await env.manager.destroy();
});

test('recorded mode supersedes an in-flight enable and restores only the latest user intent', async () => {
  const calls = [], loaded = Promise.withResolvers(), env = environment(() => loaded.promise);
  const enabling = env.manager.setEnabled('test', true); await settle();
  const pausing = env.manager.setTimelineMode('history'); loaded.resolve(engine(calls));
  assert.equal(await enabling, false); await pausing;
  assert.equal(calls.includes('enable'), false); assert.equal(env.manager.getState().test.enabled, true);
  await env.manager.setEnabled('test', false); await env.manager.setTimelineMode('live');
  assert.equal(calls.includes('enable'), false); assert.equal(env.manager.getState().test.enabled, false);
  assert.equal(JSON.parse(env.saved.get(STORAGE_KEY)).layers.test.enabled, false);
  await env.manager.destroy();
});

test('history aborts an owned live refresh and rapid return to Live cannot allow stale re-enabling', async () => {
  const calls = [], began = Promise.withResolvers(); let updates = 0;
  const env = environment(async () => ({ ...engine(calls), update(_viewer, { signal }) {
    if (++updates !== 1) { calls.push('update'); return; }
    began.resolve(signal); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } }));
  const enabling = env.manager.setEnabled('test', true), signal = await began.promise;
  const pause = env.manager.setTimelineMode('history'); assert.equal(signal.aborted, true);
  const resume = env.manager.setTimelineMode('live'); await Promise.all([enabling, pause, resume]);
  assert.equal(env.manager.getState().test.enabled, true); assert.equal(env.manager.getState().test.settledEnabled, true);
  assert.equal(env.manager.getState().test.status, 'ready'); assert.equal(env.timers.size, 1);
  await env.manager.destroy();
});

test('imports only on enable, initializes once, polls only while enabled and cleans up', async () => {
  const calls = [];
  const env = environment(async () => { calls.push('load'); return engine(calls); });
  assert.deepEqual(calls, []);
  assert.equal(await env.manager.setEnabled('test', true), true);
  assert.deepEqual(calls, ['load', 'init', 'enable', 'update']);
  assert.equal(env.manager.getState().test.count, 7);
  assert.equal(env.timers.size, 1);
  await env.manager.setEnabled('test', false);
  assert.equal(env.timers.size, 0);
  await env.manager.setEnabled('test', true);
  assert.equal(calls.filter((value) => value === 'init').length, 1);
  await env.manager.destroy();
  assert.equal(env.timers.size, 0);
  assert.equal(calls.at(-1), 'destroy');
});

test('a newer disable supersedes a pending import without activating the layer', async () => {
  const calls = [];
  const loaded = Promise.withResolvers();
  const env = environment(() => loaded.promise);
  const enabling = env.manager.setEnabled('test', true);
  await settle();
  const disabling = env.manager.setEnabled('test', false);
  loaded.resolve(engine(calls));
  assert.equal(await enabling, false);
  assert.equal(await disabling, true);
  assert.equal(env.manager.getState().test.enabled, false);
  assert.equal(calls.includes('init'), false);
  assert.equal(env.timers.size, 0);
  await env.manager.destroy();
});

test('disable aborts outstanding refresh before settling and no poll survives', async () => {
  const calls = [];
  const active = Promise.withResolvers();
  const env = environment(async () => ({
    ...engine(calls),
    update(_viewer, { signal }) {
      active.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  }));
  const enabling = env.manager.setEnabled('test', true);
  const signal = await active.promise;
  const disabling = env.manager.setEnabled('test', false);
  assert.equal(signal.aborted, true);
  await Promise.all([enabling, disabling]);
  assert.equal(env.manager.getState().test.settledEnabled, false);
  assert.equal(env.timers.size, 0);
  await env.manager.destroy();
});

test('failed partial initialization is destroyed and a later retry creates a fresh engine', async () => {
  const calls = [];
  let attempts = 0;
  const env = environment(async () => {
    const module = engine(calls);
    if (++attempts === 1) module.init = () => { throw new Error('Startup failed'); };
    return module;
  });
  assert.equal(await env.manager.setEnabled('test', true), false);
  assert.equal(env.manager.getState().test.status, 'error');
  assert.match(env.manager.getState().test.error, /Startup failed/);
  assert.ok(calls.includes('destroy'));
  assert.equal(await env.manager.setEnabled('test', true), true);
  assert.equal(attempts, 2);
  await env.manager.destroy();
});

test('hidden tabs suspend polling and resume without losing enabled intent', async () => {
  const calls = [];
  const env = environment(async () => engine(calls));
  await env.manager.setEnabled('test', true);
  env.document.hidden = true; env.visibility();
  assert.equal(env.timers.size, 0);
  assert.equal(await env.manager.refresh('test'), false);
  assert.equal(env.manager.getState().test.enabled, true);
  env.document.hidden = false; env.visibility();
  await settle();
  assert.equal(env.timers.size, 1);
  assert.equal(calls.filter((value) => value === 'update').length, 2);
  await env.manager.destroy();
});

test('restores validated known layer settings and ignores removed layers', async () => {
  const calls = [];
  const env = environment(async () => engine(calls));
  env.saved.set(STORAGE_KEY, JSON.stringify({ version: 1, layers: {
    test: { enabled: true, params: { mode: 'saved' } }, removed: { enabled: true },
  } }));
  await env.manager.restore();
  assert.equal(env.manager.getState().test.enabled, true);
  assert.equal(env.manager.getLayerParams('test').mode, 'saved');
  const saved = JSON.parse(env.saved.get(STORAGE_KEY));
  assert.equal(saved.layers.removed, undefined);
  await env.manager.destroy();
});

test('selective warm-up loads code without constructing, initializing or polling a layer', async () => {
  const calls = [];
  const env = environment(async () => { calls.push('construct'); return engine(calls); }, {
    preloadLayer: async () => { calls.push('code'); },
    createServices: () => { calls.push('services'); return {}; },
    layerServiceRequirements: () => ['weatherClock'],
  });
  assert.equal(await env.manager.preload('test'), true);
  assert.deepEqual(calls, ['code']);
  assert.equal(env.manager.getState().test.enabled, false);
  assert.equal(env.timers.size, 0);
  env.document.hidden = true;
  assert.equal(await env.manager.preload('test'), false);
  assert.deepEqual(calls, ['code']);
  await env.manager.destroy();
});

test('engine code and only its requested services load concurrently', async () => {
  const calls = [], codeReady = Promise.withResolvers(), serviceReady = Promise.withResolvers();
  const expectedServices = { weatherClock: {} };
  const env = environment(async (_id, { services }) => {
    assert.equal(services, expectedServices); return engine(calls);
  }, {
    preloadLayer: () => { calls.push('code'); return codeReady.promise; },
    layerServiceRequirements: () => ['weatherClock'],
    createServices: () => ({
      ensure(names) { assert.deepEqual(names, ['weatherClock']); calls.push('services'); return serviceReady.promise; },
      async destroy() { calls.push('services-destroy'); },
    }),
  });
  const enabling = env.manager.setEnabled('test', true);
  await settle();
  assert.ok(calls.includes('code'));
  assert.ok(calls.includes('services'));
  assert.equal(calls.includes('init'), false);
  codeReady.resolve(); serviceReady.resolve(expectedServices);
  assert.equal(await enabling, true);
  await env.manager.destroy();
  assert.equal(calls.at(-1), 'services-destroy');
});

test('data-saving and slow connections skip optional warm-up without blocking required code', async () => {
  for (const connection of [{ saveData: true }, { effectiveType: 'slow-2g' }, { effectiveType: '2g' }]) {
    const calls = [];
    const env = environment(async () => engine(calls), {
      connection, preloadLayer: async () => { calls.push('code'); },
    });
    assert.equal(await env.manager.preload('test'), false);
    assert.deepEqual(calls, []);
    assert.equal(await env.manager.setEnabled('test', true), true);
    assert.ok(calls.includes('code'));
    assert.ok(calls.includes('update'));
    await env.manager.destroy();
  }
});

test('changing the local area cancels pending data and queues its replacement even for static layers', async () => {
  const started = Promise.withResolvers(), blocked = Promise.withResolvers(); let updates = 0, firstSignal, area;
  const env = environment(async () => ({ init() {}, enable() {}, disable() {}, destroy() {}, updateInterval: 0,
    setLocalArea(value) { area = value; },
    async update(_viewer, { signal }) {
      updates++;
      if (updates === 1) { firstSignal = signal; started.resolve(); await blocked.promise; }
      return !signal.aborted;
    },
  }));
  const enabling = env.manager.setEnabled('test', true); await started.promise;
  env.manager.setLocalArea({ lat: 50, lon: 4, radiusKm: 10 });
  assert.equal(firstSignal.aborted, true);
  blocked.resolve(); await enabling; await settle();
  assert.equal(updates, 2); assert.deepEqual(area, { lat: 50, lon: 4, radiusKm: 10 });
  assert.equal(env.manager.getState().test.refreshing, false); await env.manager.destroy();
});
