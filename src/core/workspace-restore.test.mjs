import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRestore } from './workspace-restore.js';
import { createLayerManager, STORAGE_KEY } from './layer-manager.js';

const time = { mode: 'history', at: '2025-11-15T12:00:00.123Z', lens: 'known-then', rate: 86400 };
function fixture({ modeGate, layerGate, sceneGate } = {}) {
  const calls = [], commits = [], clock = {}, camera = {}; let mode = 'live', canceled = 0, transitions = 0;
  const manager = {
    setTimelineMode(value) { mode = value; calls.push(['mode', value]); return ++transitions === 1 && modeGate ? modeGate.promise : Promise.resolve(); },
    setLayerParams(id, value) { calls.push(['params', id, value]); },
    restore(ids) { calls.push(['layers', ids, mode, { ...clock }]); return layerGate?.promise || Promise.resolve(); },
  };
  const timeline = { restore(value) { calls.push(['scene', value]); return sceneGate?.promise || Promise.resolve(false); }, cancelRestore() { canceled++; } };
  const owner = createWorkspaceRestore({ manager, getTimeline: () => timeline,
    applyTemporal(value) { Object.assign(clock, value, { playing: false }); calls.push(['clock', value]); },
    applyCamera(value) { Object.assign(camera, value); calls.push(['camera', value]); }, applyArea(value) { calls.push(['area', value]); },
    onSettled() { commits.push({ camera: { ...camera }, clock: { ...clock } }); }, now: () => Date.parse('2026-10-12T06:00:00.000Z') });
  return { owner, calls, commits, clock, camera, manager, canceled: () => canceled };
}
test('historical suspension and exact paused clock precede every requested layer, and a source coverage gap still commits the chosen workspace', async () => {
  const f = fixture();
  const pending = f.owner.restore({ temporal: time, view: { lat: 50 }, layers: [], layerParams: { wind: { height: 10 } } });
  assert.equal(f.owner.isRestoring(), true); await pending;
  assert.equal(f.calls[0][0], 'clock'); assert.equal(f.calls[1][0], 'mode');
  const enabled = f.calls.find(call => call[0] === 'layers'); assert.deepEqual(enabled[1], []); assert.equal(enabled[2], 'history');
  assert.equal(enabled[3].at, time.at); assert.equal(enabled[3].playing, false); assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].clock.lens, 'known-then'); assert.equal(f.owner.isRestoring(), false); f.owner.destroy();
});
test('a superseded mode transition cannot enable old layers; late layer/scene completion cannot reapply an older camera or commit', async () => {
  const modeGate = Promise.withResolvers(), f = fixture({ modeGate });
  const older = f.owner.restore({ temporal: time, view: { lat: 10 }, layers: ['old'] });
  const latest = f.owner.restore({ temporal: { mode: 'live' }, view: { lat: 20 }, layers: [] });
  modeGate.resolve(); assert.equal(await older, false); assert.equal(await latest, true);
  assert.equal(f.calls.filter(call => call[0] === 'layers').length, 1); assert.equal(f.camera.lat, 20); assert.equal(f.commits.length, 1);
  const layerGate = Promise.withResolvers(), sceneGate = Promise.withResolvers(), g = fixture({ layerGate, sceneGate });
  const slow = g.owner.restore({ temporal: { mode: 'live' }, view: { lat: 30 }, layers: ['live'] }); await Promise.resolve();
  const now = g.owner.restore({ temporal: time, view: { lat: 40 }, layers: [] }); await Promise.resolve();
  layerGate.resolve(); sceneGate.resolve(false); assert.equal(await slow, false); assert.equal(await now, true);
  assert.equal(g.camera.lat, 40); assert.equal(g.clock.at, time.at); assert.equal(g.commits.length, 1); g.owner.destroy(); f.owner.destroy();
});
test('invalid/future restoration fails before any clock/layer work; cancellation and terminal disposal own pending completion', async () => {
  const f = fixture(); await assert.rejects(f.owner.restore({ temporal: { ...time, at: '2027-01-01T00:00:00.000Z' } }), /Future/);
  assert.equal(f.calls.length, 0);
  const sceneGate = Promise.withResolvers(), g = fixture({ sceneGate });
  const pending = g.owner.restore({ temporal: time, view: {}, layers: [] }); await Promise.resolve();
  g.owner.cancel(); assert.equal(g.canceled(), 1); sceneGate.resolve(); assert.equal(await pending, false); assert.equal(g.commits.length, 0);
  g.owner.destroy(); assert.equal(await g.owner.restore({ temporal: time }), false); assert.equal(g.canceled(), 2); f.owner.destroy();
});

test('a superseded rejecting mode barrier is obsolete while the latest completed scene survives; current failures still surface', async () => {
  const modeGate = Promise.withResolvers(), f = fixture({ modeGate });
  const old = f.owner.restore({ temporal: time, view: { lat: 10 }, layers: ['old'] });
  assert.equal(await f.owner.restore({ temporal: { mode: 'live' }, view: { lat: 20 }, layers: [] }), true);
  modeGate.reject(new Error('Old disable failed')); assert.equal(await old, false); assert.equal(f.commits.length, 1);
  assert.equal(f.camera.lat, 20); f.owner.destroy();
  const failure = Promise.withResolvers(), g = fixture({ modeGate: failure });
  const current = g.owner.restore({ temporal: time, view: {}, layers: [] }); const rejected = assert.rejects(current, /Current disable failed/);
  failure.reject(new Error('Current disable failed')); await rejected; assert.equal(g.commits.length, 0); g.owner.destroy();
});

test('checkpoint opens after synchronous full intent installation without waiting for layer or scene completion', async () => {
  const modeGate = Promise.withResolvers(), layerGate = Promise.withResolvers(), sceneGate = Promise.withResolvers();
  const f = fixture({ modeGate, layerGate, sceneGate }); assert.equal(f.owner.canCheckpoint(), true);
  const originalParams = f.manager.setLayerParams, originalLayers = f.manager.restore;
  f.manager.setLayerParams = (...args) => { assert.equal(f.owner.canCheckpoint(), false); originalParams(...args); };
  f.manager.restore = (...args) => { assert.equal(f.owner.canCheckpoint(), false); return originalLayers(...args); };
  const pending = f.owner.restore({ temporal: time, view: { lat: 50 }, layers: ['earthquakes', 'wind'], layerParams: { wind: { model: 'gfs' } } });
  assert.equal(f.owner.canCheckpoint(), false); modeGate.resolve(); await Promise.resolve();
  assert.equal(f.owner.canCheckpoint(), true); assert.equal(f.owner.isRestoring(), true);
  f.camera.lat = 51; layerGate.resolve(); sceneGate.resolve(false); await pending;
  assert.equal(f.commits[0].camera.lat, 51); assert.equal(f.owner.canCheckpoint(), true);
  f.owner.destroy(); assert.equal(f.owner.canCheckpoint(), false); f.owner.cancel(); assert.equal(f.owner.canCheckpoint(), false);
});

test('a newer applying owner closes checkpoint and old completion or failure cannot reopen it', async () => {
  for (const rejection of [false, true]) {
    const f = fixture(), firstLayers = Promise.withResolvers(), nextMode = Promise.withResolvers();
    let layerCalls = 0; f.manager.restore = () => ++layerCalls === 1 ? firstLayers.promise : Promise.resolve();
    const first = f.owner.restore({ temporal: time, view: { lat: 50 }, layers: ['earthquakes'] }); await Promise.resolve();
    assert.equal(f.owner.canCheckpoint(), true);
    f.manager.setTimelineMode = () => nextMode.promise;
    const latest = f.owner.restore({ temporal: { mode: 'live' }, view: { lat: 52 }, layers: [] });
    assert.equal(f.owner.canCheckpoint(), false);
    if (rejection) firstLayers.reject(new Error('TEST ONLY obsolete layer failure')); else firstLayers.resolve();
    assert.equal(await first, false); assert.equal(f.owner.canCheckpoint(), false);
    nextMode.resolve(); await latest; assert.equal(f.owner.canCheckpoint(), true); assert.equal(f.commits.length, 1); f.owner.destroy();
  }
});

test('checkpoint failure scope distinguishes unapplied intent from failed source completion, while explicit cancellation restores user ownership', async () => {
  const modeGate = Promise.withResolvers(), before = fixture({ modeGate });
  const rejected = assert.rejects(before.owner.restore({ temporal: time, view: {}, layers: [] }), /TEST ONLY mode failure/);
  modeGate.reject(new Error('TEST ONLY mode failure')); await rejected;
  assert.equal(before.owner.canCheckpoint(), false); assert.equal(before.owner.isRestoring(), false);
  before.owner.cancel(); assert.equal(before.owner.canCheckpoint(), true); before.owner.destroy();
  const layerGate = Promise.withResolvers(), after = fixture({ layerGate });
  const sourceFailure = assert.rejects(after.owner.restore({ temporal: time, view: {}, layers: [] }), /TEST ONLY source failure/);
  await Promise.resolve(); assert.equal(after.owner.canCheckpoint(), true);
  layerGate.reject(new Error('TEST ONLY source failure')); await sourceFailure;
  assert.equal(after.owner.canCheckpoint(), true); assert.equal(after.commits.length, 0); after.owner.destroy();
});

test('actual staged manager installs every requested choice before source admissions so camera edits can checkpoint while loading', async () => {
  const ids = ['earthquakes', 'gdacs-notices', 'wind'], turns = new Map(), values = new Map(), camera = {}, savedViews = [], sceneGate = Promise.withResolvers();
  let timerId = 0, constructed = 0;
  const manager = createLayerManager({ scene: { requestRender() {} } }, () => {}, {
    catalog: ids.map(id => ({ id, defaults: {} })), layerServiceRequirements: () => [],
    createLayer: async () => { constructed++; return { init() {}, enable() {}, disable() {}, destroy() {}, update() {}, getStats: () => ({ count: 0 }) }; },
    storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    document: { hidden: false }, setTimeout: callback => { turns.set(++timerId, callback); return timerId; }, clearTimeout: id => turns.delete(id),
  });
  const checkpoint = () => { if (owner.canCheckpoint()) savedViews.push({ ...camera, layers: Object.keys(manager.getState()).filter(id => manager.getState()[id].enabled) }); };
  const owner = createWorkspaceRestore({ manager, getTimeline: () => ({ restore: () => sceneGate.promise, cancelRestore() {} }),
    applyTemporal() {}, applyArea() {}, applyCamera: view => Object.assign(camera, view), onSettled: checkpoint });
  const restoration = owner.restore({ temporal: { mode: 'live' }, view: { lat: 50 }, layers: ids });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(owner.isRestoring(), true); assert.equal(owner.canCheckpoint(), true); assert.equal(constructed, 0);
  assert.ok(ids.every(id => manager.getState()[id].queued));
  assert.ok(ids.every(id => JSON.parse(values.get(STORAGE_KEY)).layers[id].enabled));
  camera.lat = 51; checkpoint(); assert.deepEqual(savedViews[0], { lat: 51, layers: ids });
  for (let i = 0; i < ids.length * 4; i++) { const [id, callback] = turns.entries().next().value || []; if (callback) { turns.delete(id); callback(); } for (let j = 0; j < 20; j++) await Promise.resolve(); }
  sceneGate.resolve(false); await restoration; assert.equal(savedViews.at(-1).lat, 51); assert.equal(constructed, ids.length);
  owner.destroy(); await manager.destroy(); assert.equal(owner.canCheckpoint(), false);
});
