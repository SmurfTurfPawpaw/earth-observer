import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createHistoryController, normalizeHistory } from './timeline.js';
import { installAstronomy, ASTRONOMY_REFRESH_MS } from './astronomy.js';

const first = '2026-10-11T09:00:00.000Z', last = '2026-10-11T09:15:00.000Z';
const snapshots = [{ at: first, id: 'one', source: 'usgs', recordCount: 1 }, { at: last, id: 'two', source: 'usgs', recordCount: 1 }];
const report = { id: 'eq-one', kind: 'hazard-report', sourceId: 'usgs', source: 'USGS', title: 'Recorded earthquake',
  url: 'https://earthquake.usgs.gov/earthquakes/eventpage/fixture', lat: 50, lon: 4, observedAt: first, retrievedAt: last };
function documentFixture() {
  const listeners = new Map();
  return { hidden: false, listeners, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, visibility() { for (const fn of listeners.get('visibilitychange') || []) fn(); } };
}

test('recorded range comes only from actual listed captures and topic/curated metadata cannot invent incident coordinates', () => {
  const normalized = normalizeHistory({ configured: true, firstAt: '1900-01-01T00:00:00Z', lastAt: '2099-01-01T00:00:00Z', snapshots: snapshots.toReversed(),
    reports: [report, { ...report, kind: 'curated-event' }, { ...report, kind: 'topic-mention' }, { ...report, url: 'javascript:alert(1)' }] });
  assert.equal(normalized.firstAt, first); assert.equal(normalized.lastAt, last);
  assert.deepEqual(normalized.snapshots, snapshots); assert.equal(normalized.reports.length, 3);
  assert.equal(normalized.reports[0].lat, 50); assert.equal(normalized.reports[1].lat, undefined); assert.equal(normalized.reports[2].lat, undefined);
  assert.equal(normalized.reports[0].observedAt, first); assert.equal(normalized.reports[0].retrievedAt, last);
  assert.throws(() => normalizeHistory({ configured: true, snapshots: [{ at: 'invalid' }] }), /no usable snapshots/);
});

test('history is lazy, requests only recorded UTC values, and Live clears the selected archive without another fetch', async () => {
  const calls = [], changes = [], documentRef = documentFixture();
  const controller = createHistoryController({ documentRef, onTimeChange: (state) => changes.push(state), fetchImpl: async (url) => {
    calls.push(url); return Response.json(url === '/api/history' ? { configured: true, snapshots } : { configured: true, at: first, snapshots: [snapshots[0]], reports: [report] });
  } });
  assert.equal(calls.length, 0); assert.equal(await controller.select(first), false);
  await controller.open(); assert.equal(calls.length, 1);
  assert.equal(await controller.select('1900-01-01T00:00:00Z'), false); assert.equal(calls.length, 1);
  assert.equal(await controller.select(first), true);
  assert.equal(calls[1], `/api/history?${new URLSearchParams({ at: first })}`);
  assert.equal(changes[0].mode, 'history'); assert.equal(changes[0].reports[0].observedAt, first);
  controller.live(); assert.equal(controller.getState().selection, null); assert.equal(changes.at(-1).mode, 'live'); assert.equal(calls.length, 2);
  controller.destroy(); assert.equal(documentRef.listeners.get('visibilitychange').size, 0);
});

test('closing or hiding cancels historical bodies and prevents late data from changing time', async () => {
  for (const hidden of [false, true]) {
    const body = Promise.withResolvers(), began = Promise.withResolvers(), changes = [], documentRef = documentFixture(); let signal;
    const controller = createHistoryController({ documentRef, onTimeChange: (state) => changes.push(state), fetchImpl: async (url, init) => {
      if (url === '/api/history') return Response.json({ configured: true, snapshots });
      signal = init.signal; return { ok: true, json() { began.resolve(); return body.promise; } };
    } });
    await controller.open(); const selecting = controller.select(first); await began.promise;
    if (hidden) { documentRef.hidden = true; documentRef.visibility(); } else controller.close();
    assert.equal(signal.aborted, true); body.resolve({ configured: true, snapshots: [snapshots[0]], reports: [report] });
    assert.equal(await selecting, false); assert.equal(controller.getState().selection, null); assert.equal(changes.length, 0);
    controller.destroy();
  }
});

test('an unavailable or future archive never replaces the last accepted recorded time', async () => {
  let calls = 0;
  const controller = createHistoryController({ documentRef: documentFixture(), fetchImpl: async (url) => {
    if (url === '/api/history') return Response.json({ configured: true, snapshots });
    if (++calls === 1) return Response.json({ configured: true, snapshots: [snapshots[0]], reports: [report] });
    return Response.json({ configured: true, snapshots: [snapshots[1]], reports: [report] });
  } });
  await controller.open(); await controller.select(first);
  assert.equal(await controller.select(first), false);
  assert.equal(controller.getState().selection.at, first); assert.match(controller.getState().error, /No recorded coverage/);
  controller.destroy();
});

test('astronomical UTC freezes for history, restores system time in Live, and refreshes only visible Live frames', (t) => {
  // Cesium's native Moon material performs browser-type checks during creation;
  // no texture or graphics context is acquired in this CPU-only lifecycle test.
  for (const key of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: class BrowserGraphicsType {} });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const documentRef = documentFixture(), timers = new Map(); let next = 0, frames = 0;
  const viewer = { clock: new Cesium.Clock(), scene: { globe: {}, requestRender() { frames++; } }, isDestroyed: () => false };
  const astronomy = installAstronomy(viewer, { documentRef, setTimeoutImpl(fn, delay) { timers.set(++next, { fn, delay }); return next; }, clearTimeoutImpl(id) { timers.delete(id); } });
  assert.equal(viewer.scene.globe.enableLighting, true); assert.equal(viewer.scene.globe.showGroundAtmosphere, false);
  assert.notEqual(viewer.scene.globe.lightingFadeOutDistance, viewer.scene.globe.lightingFadeInDistance);
  assert.ok(viewer.scene.sun instanceof Cesium.Sun); assert.ok(viewer.scene.moon instanceof Cesium.Moon); assert.equal(viewer.scene.sunBloom, false);
  assert.equal(viewer.clock.clockStep, Cesium.ClockStep.SYSTEM_CLOCK); assert.equal([...timers.values()][0].delay, ASTRONOMY_REFRESH_MS);
  astronomy.setTime(first); assert.equal(timers.size, 0); assert.equal(astronomy.getState().mode, 'history');
  assert.equal(Cesium.JulianDate.toIso8601(viewer.clock.tick(), 3), first); assert.equal(viewer.clock.shouldAnimate, false);
  astronomy.setTime(); assert.equal(viewer.clock.clockStep, Cesium.ClockStep.SYSTEM_CLOCK); assert.equal(viewer.clock.shouldAnimate, true);
  documentRef.hidden = true; documentRef.visibility(); assert.equal(timers.size, 0); const hiddenFrames = frames;
  astronomy.setLighting(false); assert.equal(frames, hiddenFrames);
  documentRef.hidden = false; documentRef.visibility(); assert.equal(timers.size, 1); assert.ok(frames > hiddenFrames);
  astronomy.destroy(); assert.equal(timers.size, 0); assert.equal(viewer.scene.sun, undefined); assert.equal(viewer.scene.moon, undefined);
});
