import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerManager, STORAGE_KEY, LAYER_ACTIVATION_LIMITS, LAYER_REFRESH_FOLLOWUP_MS } from './layer-manager.js';

const catalog = [{ id: 'test', defaults: { mode: 'safe' } }];
const microtasks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const settle = async () => { await microtasks(); await new Promise(resolve => setTimeout(resolve, 0)); await microtasks(); };
const replacement = async () => { await new Promise(resolve => setTimeout(resolve, LAYER_REFRESH_FOLLOWUP_MS + 10)); await settle(); };
function environment(createLayer, overrides = {}) {
  const timers = new Map();
  let timerId = 0;
  const events = new Map();
  const document = { hidden: false,
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    removeEventListener(name, callback) { events.get(name)?.delete(callback); } };
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const viewer = { scene: { requestRender() {} } };
  const manager = createLayerManager(viewer, () => {}, {
    catalog, createLayer, createServices: () => ({ destroy() {} }), document, storage,
    setInterval: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearInterval: (id) => timers.delete(id), ...overrides,
  });
  return { manager, viewer, timers, document, saved, storage, visibility: () => { for (const callback of events.get('visibilitychange') || []) callback(); } };
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

test('dated weather adapters remain active in history while live-only layers stay suspended', async () => {
  const calls = [], requested = [], env = environment(async (id, { fetchImpl }) => ({ ...engine(calls),
    update() { return fetchImpl(`/api/${id}`); },
  }), { catalog: [{ id: 'weather-radar', defaults: {} }, ...catalog],
    layerServiceRequirements: () => [], fetchImpl: async (url) => { requested.push(url); return new Response('{}'); } });
  await env.manager.setEnabled('weather-radar', true); await env.manager.setEnabled('test', true);
  const saved = env.saved.get(STORAGE_KEY);
  await env.manager.setTimelineMode('history');
  assert.equal(env.manager.getState()['weather-radar'].timelinePaused, false);
  assert.equal(env.manager.getState()['weather-radar'].sceneMode, 'history');
  assert.equal(env.manager.isEffectivelyEnabled('weather-radar'), true);
  assert.equal(env.manager.isEffectivelyEnabled('test'), false);
  const previous = requested.length;
  assert.equal(await env.manager.refresh('weather-radar'), true); assert.equal(await env.manager.refresh('test'), false);
  assert.deepEqual(requested.slice(previous), ['/api/weather-radar']);
  env.document.hidden = true; env.visibility(); assert.equal(env.timers.size, 0);
  env.document.hidden = false; env.visibility(); await settle(); assert.equal(env.timers.size, 1);
  assert.equal(env.saved.get(STORAGE_KEY), saved); await env.manager.destroy();
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

test('producer revisions coalesce one follow-up during an active refresh and respect hidden/history/disabled state', async () => {
  const calls = [], pending = Promise.withResolvers(); let count = 0, invalidations = 0;
  const env = environment(async () => ({ ...engine(calls),
    invalidatePreparedSnapshot() { invalidations++; },
    update() { count++; return count === 2 ? pending.promise : undefined; },
  }));
  assert.equal(env.manager.requestRefresh('test'), false);
  await env.manager.setEnabled('test', true);
  const refreshing = env.manager.refresh('test'); await settle();
  for (let i = 0; i < 8; i++) assert.equal(env.manager.requestRefresh('test'), true);
  assert.equal(count, 2); assert.equal(invalidations, 1);
  pending.resolve(); await refreshing; await settle(); assert.equal(count, 2, 'An active-read burst schedules one delayed replacement');
  assert.equal(env.manager.getState().test.workPhase, 'queued-update');
  await replacement(); assert.equal(count, 3); assert.equal(invalidations, 2);
  env.document.hidden = true; assert.equal(env.manager.requestRefresh('test'), false);
  env.document.hidden = false; await env.manager.setTimelineMode('history');
  assert.equal(env.manager.requestRefresh('test'), false);
  await env.manager.destroy(); assert.equal(env.manager.requestRefresh('test'), false);
});

test('producer revision survives lazy loading and historical pause until an allowed refresh', async () => {
  const loading = Promise.withResolvers(); let invalidations = 0, updates = 0;
  const env = environment(() => loading.promise);
  const enabling = env.manager.setEnabled('test', true); await settle();
  assert.equal(env.manager.requestRefresh('test'), false);
  loading.resolve({ ...engine([]), invalidatePreparedSnapshot() { invalidations++; }, update() { updates++; } });
  await enabling; assert.equal(invalidations, 1); assert.equal(updates, 1);
  await env.manager.setTimelineMode('history'); assert.equal(env.manager.requestRefresh('test'), false);
  assert.equal(invalidations, 1); assert.equal(updates, 1);
  await env.manager.setTimelineMode('live'); assert.equal(invalidations, 2); assert.equal(updates, 2);
  await env.manager.destroy();
});

const sourceEdition = fence => ({ schemaVersion: 1, type: 'plugin', pluginId: 'usgs-live-day-m2-5-v1', scopeId: 'usgs-live-day-m2-5-v1',
  receiptId: `receipt:${String(fence).repeat(64)}`, fence, factsDigest: 'a'.repeat(64), recordedAt: '2026-10-12T02:55:34.537Z' });
test('the latest reviewed source edition survives loading, hidden/history/disabled states and rejects foreign or old notifications', async () => {
  const loading = Promise.withResolvers(), invalidations = []; let updates = 0;
  const env = environment(() => loading.promise, { catalog: [{ id: 'earthquakes', defaults: {} }] });
  const enabling = env.manager.setEnabled('earthquakes', true); await settle();
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(1)), false);
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(3)), false);
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(2)), false);
  assert.equal(env.manager.requestRefresh('earthquakes', { ...sourceEdition(4), scopeId: 'foreign' }), false);
  loading.resolve({ ...engine([]), invalidatePreparedSnapshot(value) { invalidations.push(value); }, update() { updates++; } });
  await enabling; assert.equal(invalidations.length, 1); assert.equal(invalidations[0].fence, 3); assert.equal(updates, 1);
  env.document.hidden = true; env.visibility(); assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(4)), false); assert.equal(updates, 1);
  await env.manager.setTimelineMode('history'); env.document.hidden = false; env.visibility(); await settle();
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(5)), false); assert.equal(updates, 1);
  await env.manager.setEnabled('earthquakes', false); assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(6)), false);
  await env.manager.setTimelineMode('live'); assert.equal(updates, 1);
  await env.manager.setEnabled('earthquakes', true); assert.equal(updates, 2); assert.equal(invalidations.at(-1).fence, 6);
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(6)), false); assert.equal(updates, 2);
  await env.manager.destroy();
});

test('a reviewed publication invalidates the active read immediately and coalesces one replacement', async () => {
  let count = 0, readOwner, pendingRevision; const began = Promise.withResolvers(), invalidations = [];
  const env = environment(async () => ({ ...engine([]),
    invalidatePreparedSnapshot(value) { invalidations.push(value); pendingRevision = value; readOwner?.abort(); },
    async update(_viewer, { signal }) {
      count++; if (count !== 2) return true;
      readOwner = new AbortController(); const owned = AbortSignal.any([signal, readOwner.signal]); began.resolve(owned);
      return new Promise(resolve => owned.addEventListener('abort', () => resolve(false), { once: true }));
    },
  }), { catalog: [{ id: 'earthquakes', defaults: {} }] });
  await env.manager.setEnabled('earthquakes', true); const refreshing = env.manager.refresh('earthquakes'), active = await began.promise;
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(2)), true); assert.equal(active.aborted, true);
  assert.equal(env.manager.requestRefresh('earthquakes', sourceEdition(3)), true);
  await refreshing; await replacement(); assert.equal(count, 3); assert.equal(pendingRevision.fence, 3);
  assert.deepEqual(invalidations.map(value => value.fence), [2, 3, 3]); await env.manager.destroy();
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
  assert.equal(env.manager.getState().test.enabled, true, 'Unavailable activation preserves the explicit requested choice');
  assert.equal(env.manager.getState().test.settledEnabled, false);
  assert.equal(JSON.parse(env.saved.get(STORAGE_KEY)).layers.test.enabled, true);
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

test('returning from history while a canceled read retires queues a fresh owned update', async () => {
  const began = Promise.withResolvers(), blocked = Promise.withResolvers(); let updates = 0, oldSignal;
  const env = environment(async () => ({ ...engine([]), async update(_viewer, { signal }) {
    if (++updates === 2) { oldSignal = signal; began.resolve(); await blocked.promise; } return !signal.aborted;
  } }));
  await env.manager.setEnabled('test', true); const pending = env.manager.refresh('test'); await began.promise;
  await env.manager.setTimelineMode('history'); assert.equal(oldSignal.aborted, true); await env.manager.setTimelineMode('live');
  assert.equal(updates, 2); blocked.resolve(); await pending; await replacement(); assert.equal(updates, 3);
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
  blocked.resolve(); await enabling; await replacement();
  assert.equal(updates, 2); assert.deepEqual(area, { lat: 50, lon: 4, radiusKm: 10 });
  assert.equal(env.manager.getState().test.refreshing, false); await env.manager.destroy();
});

function stagedEnvironment(t) {
  const ids = ['satellites', 'earthquakes', 'wind', 'gdacs-notices', 'flights'], starts = [], turns = new Map(), calls = [];
  const gates = new Map(ids.map(id => [id, Promise.withResolvers()])); let sequence = 0, active = 0, maximum = 0;
  const env = environment(async id => { starts.push(id); return { ...engine(calls), updateInterval: 0,
    async update() { active++; maximum = Math.max(maximum, active); try { await gates.get(id).promise; } finally { active--; } },
  }; }, { catalog: ids.map(id => ({ id, defaults: {} })), layerServiceRequirements: () => [],
    setTimeout: callback => { turns.set(++sequence, callback); return sequence; }, clearTimeout: id => turns.delete(id) });
  const turn = async () => { await microtasks(); const [id, callback] = turns.entries().next().value || []; if (callback) { turns.delete(id); callback(); } await microtasks(); return Boolean(callback); };
  const finish = async () => { for (const gate of gates.values()) gate.resolve(); for (let i = 0; i < ids.length * 3; i++) { await microtasks(); if (!await turn() && !turns.size) break; } };
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await env.manager.destroy(); });
  return { ...env, ids, starts, turns, gates, turn, finish, get active() { return active; }, get maximum() { return maximum; } };
}

test('all restored choices persist before staged starts; two physical activations hold their slots through initial data work and core sources start first', async t => {
  const env = stagedEnvironment(t), restoration = env.manager.restore(env.ids);
  assert.deepEqual(env.starts, []);
  assert.ok(Object.values(env.manager.getState()).every(state => state.enabled && state.queued && !state.settledEnabled));
  const saved = JSON.parse(env.saved.get(STORAGE_KEY)); assert.ok(env.ids.every(id => saved.layers[id].enabled));
  assert.equal(await env.turn(), true); assert.deepEqual(env.starts, ['earthquakes']);
  assert.equal(await env.turn(), true); assert.deepEqual(env.starts, ['earthquakes', 'gdacs-notices']);
  assert.equal(env.active, LAYER_ACTIVATION_LIMITS.concurrent); assert.equal(await env.turn(), false);
  assert.equal(env.manager.getState().satellites.status, 'queued');
  env.gates.get('earthquakes').resolve(); await microtasks(); assert.equal(await env.turn(), true);
  assert.deepEqual(env.starts, ['earthquakes', 'gdacs-notices', 'satellites']);
  assert.ok(env.maximum <= LAYER_ACTIVATION_LIMITS.concurrent);
  await env.finish(); await restoration;
  assert.deepEqual(env.starts, ['earthquakes', 'gdacs-notices', 'satellites', 'wind', 'flights']);
  assert.ok(Object.values(env.manager.getState()).every(state => state.enabled && state.settledEnabled && !state.queued && !state.activating));
});

test('a newer restore and explicit disable cancel queued admissions before any construction without releasing an unsettled physical slot', async t => {
  const env = stagedEnvironment(t), first = env.manager.restore(env.ids); await env.turn();
  assert.deepEqual(env.starts, ['earthquakes']);
  const latest = env.manager.restore(['wind']), disable = env.manager.setEnabled('wind', false);
  await microtasks(); assert.equal(env.active, 1, 'Abort intent cannot count ignored asynchronous work as already retired');
  env.gates.get('earthquakes').resolve(); await env.finish(); await Promise.all([first, latest, disable]);
  assert.deepEqual(env.starts, ['earthquakes']);
  assert.ok(Object.values(env.manager.getState()).every(state => !state.enabled && !state.settledEnabled));
  assert.ok(Object.values(JSON.parse(env.saved.get(STORAGE_KEY)).layers).every(state => !state.enabled));
});

test('History preserves every requested layer without activation and cancels a queued return to Live; destroy settles queued callers without new work', async t => {
  const env = stagedEnvironment(t); await env.manager.setTimelineMode('history'); await env.manager.restore(env.ids);
  assert.equal(env.starts.length, 0); assert.equal(env.turns.size, 0);
  assert.ok(Object.values(env.manager.getState()).every(state => state.enabled && state.timelinePaused && state.status === 'paused'));
  const saved = env.saved.get(STORAGE_KEY), live = env.manager.setTimelineMode('live'); await microtasks();
  const history = env.manager.setTimelineMode('history'); await microtasks(); await env.turn(); await Promise.all([live, history]);
  assert.equal(env.starts.length, 0); assert.equal(env.saved.get(STORAGE_KEY), saved);
  const again = env.manager.setTimelineMode('live'); await microtasks(); const stopped = env.manager.destroy();
  assert.equal(env.turns.size, 0); await Promise.all([again, stopped]); assert.equal(env.starts.length, 0);
});

test('hiding before admission cancels the queued starts and returns visible intent through the same bounded gate', async t => {
  const env = stagedEnvironment(t), restoration = env.manager.restore(env.ids); await microtasks();
  env.document.hidden = true; env.visibility(); await restoration;
  assert.equal(env.turns.size, 0); assert.equal(env.starts.length, 0);
  assert.ok(Object.values(env.manager.getState()).every(state => state.enabled && !state.queued && state.status === 'paused'));
  env.document.hidden = false; env.visibility(); await env.finish(); await microtasks();
  assert.deepEqual(env.starts.slice(0, 2), ['earthquakes', 'gdacs-notices']);
  assert.ok(Object.values(env.manager.getState()).every(state => state.enabled && state.settledEnabled));
});

test('an unavailable layer keeps its selection and does not retry or starve the next admission until a new explicit action', async t => {
  // Update failures preserve dated/last-known engines; initialization failure
  // exercises the admission cleanup and retained explicit choice contract.
  let attempts = 0;
  const broken = environment(async id => ({ ...engine([]), init() { if (id === 'earthquakes') { attempts++; throw new Error('TEST ONLY initialization unavailable'); } }, updateInterval: 0 }),
    { catalog: [{ id: 'earthquakes', defaults: {} }, { id: 'gdacs-notices', defaults: {} }], layerServiceRequirements: () => [] });
  t.after(() => broken.manager.destroy());
  await broken.manager.restore(['earthquakes', 'gdacs-notices']);
  assert.equal(broken.manager.getState().earthquakes.status, 'error'); assert.equal(broken.manager.getState().earthquakes.enabled, true);
  assert.equal(broken.manager.getState()['gdacs-notices'].settledEnabled, true);
  assert.equal(JSON.parse(broken.saved.get(STORAGE_KEY)).layers.earthquakes.enabled, true);
  await settle(); assert.equal(broken.manager.getState().earthquakes.status, 'error'); assert.equal(attempts, 1);
  assert.equal(await broken.manager.setEnabled('earthquakes', true), false); assert.equal(attempts, 2, 'One manual retry owns one bounded new admission');
  assert.equal(broken.manager.getState().earthquakes.enabled, true);
});

test('initial source failure without retained data is unavailable while an existing dated display survives the same failure', async t => {
  for (const retained of [false, true]) {
    const calls = [], env = environment(async () => ({ ...engine(calls), update() { throw new Error('TEST ONLY initial source unavailable'); },
      getStats() { return { count: retained ? 7 : 0, lastUpdate: retained ? 123 : null }; } }));
    t.after(() => env.manager.destroy());
    assert.equal(await env.manager.setEnabled('test', true), retained);
    const state = env.manager.getState().test;
    assert.equal(state.enabled, true); assert.equal(state.settledEnabled, retained);
    assert.equal(state.status, retained ? 'ready' : 'error'); assert.match(state.error, /source unavailable/);
    assert.equal(JSON.parse(env.saved.get(STORAGE_KEY)).layers.test.enabled, true);
    assert.equal(calls.includes('destroy'), !retained, 'A retained source display is not discarded for failed revalidation');
  }
});

function controlledWork(t, ids, update) {
  const turns = new Map(), gates = new Map(), starts = [], counts = new Map(); let sequence = 0, active = 0, maximum = 0;
  const env = environment(async id => ({ ...engine([]), updateInterval: 0,
    async update(viewer, options) {
      const count = (counts.get(id) || 0) + 1; counts.set(id, count); starts.push(`${id}:${count}`);
      const gate = Promise.withResolvers(); gates.set(`${id}:${count}`, gate);
      active++; maximum = Math.max(maximum, active);
      try { return await update({ id, count, gate, viewer, ...options }); } finally { active--; }
    },
  }), { catalog: ids.map(id => ({ id, defaults: {} })), layerServiceRequirements: () => [],
    setTimeout(callback, delay) { turns.set(++sequence, { callback, delay }); return sequence; }, clearTimeout: id => turns.delete(id) });
  const turn = async (delay = 0) => {
    await microtasks(); const candidate = [...turns].find(([, value]) => value.delay === delay);
    if (!candidate) return false; const [id, value] = candidate; turns.delete(id); value.callback(); await microtasks(); return true;
  };
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await env.manager.destroy(); });
  return { ...env, gates, starts, counts, turns, turn, get active() { return active; }, get maximum() { return maximum; } };
}

test('recurring refresh and initial activation share two physical permits; disabled queued work never starts and ignored cancellation keeps its slot', async t => {
  const ids = ['fires', 'cameras', 'dams'];
  const env = controlledWork(t, ids, async ({ count, gate, work }) => { work.assertCurrent(); if (count > 1) await gate.promise; return true; });
  const restored = env.manager.restore(ids); for (let i = 0; i < ids.length; i++) await env.turn(); await restored;
  const first = env.manager.refresh('fires'), second = env.manager.refresh('cameras'); await env.turn(); await env.turn();
  const queued = env.manager.refresh('dams'); await microtasks();
  assert.equal(env.manager.getWorkState().activeUpdates, 2); assert.equal(env.manager.getWorkState().queuedUpdates, 1);
  assert.equal(env.manager.getState().dams.workPhase, 'queued-update'); assert.equal(env.counts.get('dams'), 1);
  await env.manager.setEnabled('dams', false); assert.equal(await queued, false); assert.equal(env.counts.get('dams'), 1);
  const reenabling = env.manager.setEnabled('dams', true); await microtasks();
  await env.manager.setEnabled('fires', false);
  assert.equal(env.manager.getWorkState().activeUpdates, 2, 'An ignored aborted source still owns its physical permit');
  assert.equal(await env.turn(), false, 'No third source starts while two requests remain physically unsettled');
  env.gates.get('fires:2').resolve(); assert.equal(await first, false); await env.turn();
  assert.equal(env.counts.get('dams'), 2); assert.equal(env.maximum, 2);
  env.gates.get('cameras:2').resolve(); env.gates.get('dams:2').resolve(); await Promise.all([second, reenabling]);
  assert.equal(env.manager.getWorkState().activeUpdates, 0); assert.equal(env.manager.getWorkState().queuedUpdates, 0);
});

test('hidden visibility invalidates a scheduled follow-up and a new visible owner survives an ignored-abort read', async t => {
  const signals = [];
  const env = controlledWork(t, ['test'], async ({ count, gate, signal }) => { signals.push(signal); if (count === 2 || count === 3) await gate.promise; return true; });
  const enabled = env.manager.setEnabled('test', true); await env.turn(); await enabled;
  const pending = env.manager.refresh('test'); await env.turn(); env.manager.requestRefresh('test');
  env.gates.get('test:2').resolve(); await pending;
  assert.ok([...env.turns.values()].some(value => value.delay === LAYER_REFRESH_FOLLOWUP_MS));
  env.document.hidden = true; env.visibility(); assert.equal(env.turns.size, 0);
  env.document.hidden = false; env.visibility(); await env.turn(); assert.equal(env.counts.get('test'), 3);
  env.manager.requestRefresh('test'); env.document.hidden = true; env.visibility(); env.document.hidden = false; env.visibility();
  assert.equal(signals[2].aborted, true); assert.equal(env.manager.getWorkState().activeUpdates, 1);
  assert.equal(await env.turn(), false); assert.equal(env.counts.get('test'), 3);
  env.gates.get('test:3').resolve(); await microtasks();
  assert.equal(await env.turn(LAYER_REFRESH_FOLLOWUP_MS), true); assert.equal(await env.turn(), true);
  assert.equal(env.counts.get('test'), 4); assert.equal(signals[3].aborted, false);
  assert.equal(env.manager.getWorkState().activeUpdates, 0); assert.equal(env.turns.size, 0);
});

test('waiting background work ages past repeated high-priority refreshes without exceeding the shared permit limit', async t => {
  const core = 'earthquakes', notices = 'gdacs-notices', background = 'background';
  const env = controlledWork(t, [background, core, notices], async ({ gate }) => { await gate.promise; return true; });
  const restored = env.manager.restore([background, core, notices]); await env.turn(); await env.turn();
  env.gates.get(`${core}:1`).resolve(); await microtasks();
  for (let count = 2; count <= 3; count++) {
    const refresh = env.manager.refresh(core); await env.turn(); assert.equal(env.counts.get(core), count);
    env.gates.get(`${core}:${count}`).resolve(); await refresh;
  }
  const nextCore = env.manager.refresh(core); await env.turn();
  assert.equal(env.starts.at(-1), `${background}:1`, 'A queued lower-priority layer takes precedence once four admissions have passed');
  assert.equal(env.counts.get(core), 3); assert.equal(env.maximum, 2);
  env.gates.get(`${background}:1`).resolve(); await microtasks(); await env.turn();
  assert.equal(env.counts.get(core), 4); env.gates.get(`${core}:4`).resolve(); env.gates.get(`${notices}:1`).resolve();
  await Promise.all([restored, nextCore]); assert.equal(env.manager.getWorkState().activeUpdates, 0);
});

test('init, enable and initial update reuse one work owner; cooperative preparation publishes complete metrics and unchanged updates stay complete', async t => {
  const phases = [], committed = [], owners = [], measured = { count: 3, preparationMs: 5, attachmentMs: 2, commitMs: 1, observerErrors: 0 };
  const env = environment(async () => ({ updateInterval: 0,
    async init(_viewer, { work }) { owners.push(work); await work.prepare([1, 2, 3], value => value * 2); },
    enable(_viewer, { work }) { owners.push(work); work.assertCurrent(); },
    async update(_viewer, { work }) { owners.push(work); const values = await work.prepare([4, 5, 6], value => value * 2); work.publish(() => committed.push(values)); return false; },
    getStats: () => ({ count: 3, lastUpdate: 123, editionMetrics: { ...measured, bad: Infinity } }), disable() {}, destroy() {},
  }));
  t.after(() => env.manager.destroy()); env.manager.subscribe(state => phases.push(state.test.workPhase));
  assert.equal(await env.manager.setEnabled('test', true), true);
  assert.equal(new Set(owners).size, 1, 'Preparation never recursively acquires the physical initial-update permit');
  assert.deepEqual(committed, [[8, 10, 12]]); assert.equal(env.manager.getState().test.workPhase, 'complete');
  assert.equal(env.manager.getState().test.refreshedAt, null); assert.equal(env.manager.getState().test.lastUpdate, 123);
  assert.equal(env.manager.getState().test.preparedCount, 3); assert.deepEqual(env.manager.getState().test.editionMetrics, measured);
  assert.ok(phases.includes('queued-prepare')); assert.equal(env.manager.getWorkState().activeUpdates, 0);
});
