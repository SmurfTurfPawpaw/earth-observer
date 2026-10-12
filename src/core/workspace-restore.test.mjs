import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRestore } from './workspace-restore.js';

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
  return { owner, calls, commits, clock, camera, canceled: () => canceled };
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
