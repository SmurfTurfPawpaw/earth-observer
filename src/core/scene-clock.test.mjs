import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneClock, MAX_SCENE_RATE } from './scene-clock.js';
import * as Cesium from 'cesium';
import { createHistoryController } from './timeline.js';
import { installAstronomy } from './astronomy.js';
import { getRenderGovernorDiagnostics } from '../renderGovernor.js';

const firstAt = '2026-10-11T09:00:00.000Z', lastAt = '2026-10-12T09:00:00.000Z';
function fixture() {
  let wall = Date.parse(lastAt), mono = 0, id = 0;
  const timers = new Map(), listeners = new Set();
  const documentRef = { hidden: false, addEventListener(_name, fn) { listeners.add(fn); }, removeEventListener(_name, fn) { listeners.delete(fn); } };
  const clock = createSceneClock({ now: () => wall, monotonicNow: () => mono, documentRef,
    setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: mono + delay }); return id; }, clearTimeoutImpl(value) { timers.delete(value); } });
  return { clock, timers, listeners, documentRef,
    jumpWall(ms) { wall += ms; },
    advance(ms) { wall += ms; mono += ms; for (const [key, timer] of [...timers]) if (timer.at <= mono && timers.delete(key)) timer.fn(); },
    visibility(hidden) { documentRef.hidden = hidden; for (const listener of listeners) listener(); },
  };
}

test('one scene clock follows UTC in Live and monotonic elapsed time in history, preserving rate changes and pauses', () => {
  const f = fixture(), states = []; f.clock.subscribe((state) => states.push(state));
  f.advance(2500); assert.equal(f.clock.getTimeMs(), Date.parse(lastAt) + 2500);
  f.clock.setCoverage({ firstAt, lastAt }); f.clock.seek(firstAt); f.clock.setRate(60); f.clock.play();
  f.advance(1500); assert.equal(f.clock.getTimeMs(), Date.parse(firstAt) + 90000);
  f.jumpWall(-7200000); assert.equal(f.clock.getTimeMs(), Date.parse(firstAt) + 90000, 'Wall-clock adjustments cannot change replay');
  f.clock.setRate(3600); f.advance(500); assert.equal(f.clock.getTimeMs(), Date.parse(firstAt) + 1890000);
  f.clock.pause(); const paused = f.clock.getState(); f.advance(5000); assert.deepEqual(f.clock.getState(), paused);
  assert.equal(f.timers.size, 0);
  f.clock.live(); assert.equal(f.clock.getState().mode, 'live'); assert.equal(f.timers.size, 1);
  assert.notEqual(f.clock.getTimeMs(), Date.parse(paused.at)); assert.ok(states.length > 2);
  f.clock.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});

test('coverage clamps seeks and stops playback exactly without looping, future extrapolation or duplicate timers', () => {
  const f = fixture(); f.clock.setCoverage({ firstAt, lastAt });
  f.clock.seek('2020-01-01T00:00:00.000Z'); assert.equal(f.clock.getState().at, firstAt);
  f.clock.setRate(MAX_SCENE_RATE); f.clock.play(); f.clock.play(); assert.equal(f.timers.size, 1);
  f.advance(1000); assert.equal(f.clock.getState().at, lastAt); assert.equal(f.clock.getState().playing, false); assert.equal(f.timers.size, 0);
  assert.equal(f.clock.play(), false);
  assert.throws(() => f.clock.setRate(0), /Playback rate/); assert.throws(() => f.clock.setRate(Infinity), /Playback rate/);
  assert.throws(() => f.clock.seek('2026-10-11'), /valid UTC/);
  assert.throws(() => f.clock.setCoverage({ firstAt: lastAt, lastAt: firstAt }), /ordered range/);
  f.clock.destroy(); assert.equal(f.clock.seek(firstAt), false);
});

test('hidden history suspends presentation without losing play intent, while Live catches up and subscriptions dispose', () => {
  const f = fixture(); f.clock.setCoverage({ firstAt, lastAt }); f.clock.seek(firstAt); f.clock.setRate(60); f.clock.play();
  f.advance(500); const at = f.clock.getState().at;
  f.visibility(true); assert.equal(f.timers.size, 0); f.advance(3600000); assert.equal(f.clock.getState().at, at);
  f.visibility(false); assert.equal(f.clock.getState().playing, true); f.advance(1000); assert.equal(f.clock.getTimeMs(), Date.parse(at) + 60000);
  f.clock.live(); f.visibility(true); f.advance(5000); f.visibility(false);
  assert.equal(f.clock.getState().mode, 'live'); assert.equal(f.clock.getState().suspended, false); assert.equal(f.timers.size, 1);
  f.clock.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});

test('native astronomical frames read the shared clock continuously and release their render hold on pause', (t) => {
  for (const key of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: class BrowserGraphicsType {} });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const f = fixture(), viewer = { clock: new Cesium.Clock(), scene: { globe: {}, requestRenderMode: true, requestRender() {} }, isDestroyed: () => false };
  const astronomy = installAstronomy(viewer, { sceneClock: f.clock, documentRef: f.documentRef });
  astronomy.setCoverage({ firstAt, lastAt }); astronomy.seek(firstAt); astronomy.setRate(3600); astronomy.play();
  assert.equal(viewer.scene.requestRenderMode, false);
  f.advance(125); viewer.clock.tick();
  assert.equal(Cesium.JulianDate.toIso8601(viewer.clock.currentTime, 3), '2026-10-11T09:07:30.000Z');
  assert.equal(astronomy.getState().at, '2026-10-11T09:07:30.000Z');
  astronomy.pause(); assert.equal(viewer.scene.requestRenderMode, true); assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
  astronomy.setTime(); assert.equal(viewer.clock.clockStep, Cesium.ClockStep.SYSTEM_CLOCK);
  astronomy.destroy(); f.clock.destroy(); assert.equal(viewer.clock.onTick.numberOfListeners, 0);
});

test('calendar seeks reuse bounded capture windows and never select a later revision or retime source evidence', async () => {
  const captures = [{ source: 'usgs', at: firstAt, id: 'original', recordCount: 1 }, { source: 'usgs', at: lastAt, id: 'corrected', recordCount: 1 }];
  let calls = 0;
  const controller = createHistoryController({ documentRef: { hidden: false }, fetchImpl: async (url) => {
    calls++;
    if (url === '/api/history') return Response.json({ configured: true, snapshots: captures });
    const at = new URL(url, 'https://example.test').searchParams.get('at');
    const snapshot = at < lastAt ? captures[0] : captures[1];
    return Response.json({ configured: true, snapshots: [snapshot], reports: [{ id: snapshot.id, sourceId: 'usgs', title: snapshot.id,
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/fixture', observedAt: firstAt, retrievedAt: snapshot.at }] });
  } });
  await controller.open(); await controller.select(firstAt);
  const middle = '2026-10-11T12:34:56.000Z'; await controller.select(middle);
  assert.equal(calls, 2, 'Moving within one capture window acquires no new dataset');
  assert.equal(controller.getState().selection.at, middle);
  assert.equal(controller.getState().selection.reports[0].retrievedAt, firstAt);
  await controller.select(lastAt); assert.equal(controller.getState().selection.reports[0].id, 'corrected');
  await controller.select(middle); assert.equal(controller.getState().selection.reports[0].id, 'original'); assert.equal(calls, 3);
  assert.equal(await controller.select('2020-01-01T00:00:00.000Z'), false);
  controller.destroy();
});

test('a bounded recent catalog cannot collapse distinct older dates, while proven archive boundaries support backward reuse', async () => {
  const original = { source: 'usgs', at: '2026-10-01T00:00:00.000Z', id: 'original', recordCount: 1 };
  const corrected = { ...original, at: '2026-10-05T00:00:00.000Z', id: 'corrected' };
  const recent = { ...original, at: firstAt, id: 'recent' };
  const early = '2026-10-02T12:00:00.000Z', later = '2026-10-06T00:00:00.000Z';
  for (const hasBoundaries of [false, true]) {
    let requests = 0;
    const controller = createHistoryController({ documentRef: { hidden: false }, fetchImpl: async (url) => {
      requests++;
      if (url === '/api/history') return Response.json({ configured: true, indexMode: 'd1-full-history',
        firstAt: original.at, lastAt: recent.at, snapshots: [recent] });
      const at = new URL(url, 'https://example.test').searchParams.get('at');
      const capture = at < corrected.at ? original : corrected;
      return Response.json({ configured: true, indexMode: 'd1-full-history', selectedAt: at,
        firstAt: original.at, lastAt: recent.at, snapshots: [capture],
        ...(hasBoundaries ? { nextCaptureAt: capture === original ? corrected.at : recent.at } : {}),
        reports: [{ id: capture.id, sourceId: 'usgs', title: capture.id, url: 'https://example.test/evidence',
          observedAt: original.at, retrievedAt: capture.at }] });
    } });
    await controller.open(); assert.equal(controller.getState().manifest.firstAt, original.at);
    await controller.select(early); assert.equal(controller.getState().selection.windowKnown, hasBoundaries);
    if (hasBoundaries) {
      await controller.select('2026-10-04T00:00:00.000Z');
      await controller.select('2026-10-01T12:00:00.000Z');
      assert.equal(requests, 2, 'An as-of response can serve earlier and later dates only inside its proven interval');
    }
    await controller.select(later); assert.equal(controller.getState().selection.reports[0].id, corrected.id);
    assert.equal(requests, 3, 'The newer correction requires another acquisition outside the bounded catalog');
    await controller.select('2026-10-02T12:01:00.000Z'); assert.equal(controller.getState().selection.reports[0].id, original.id);
    assert.equal(controller.getState().selection.reports[0].retrievedAt, original.at);
    assert.equal(requests, hasBoundaries ? 3 : 4, 'No unproven older interval can reuse a different date');
    controller.destroy();
  }
});
