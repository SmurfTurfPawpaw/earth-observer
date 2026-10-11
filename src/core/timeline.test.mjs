import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createHistoryController, createTimeline, normalizeHistory, HISTORY_REFRESH_MS } from './timeline.js';
import { installAstronomy, ASTRONOMY_REFRESH_MS, CARTOGRAPHIC_NIGHT_OPACITY } from './astronomy.js';
import { createLiveClock } from './live-clock.js';
import { createSceneClock } from './scene-clock.js';

const first = '2026-10-11T09:00:00.000Z', last = '2026-10-11T09:15:00.000Z';
const snapshots = [{ at: first, id: 'one', source: 'usgs', recordCount: 1 }, { at: last, id: 'two', source: 'usgs', recordCount: 1 }];
const report = { id: 'eq-one', kind: 'hazard-report', sourceId: 'usgs', source: 'USGS', title: 'Recorded earthquake',
  url: 'https://earthquake.usgs.gov/earthquakes/eventpage/fixture', lat: 50, lon: 4, observedAt: first, retrievedAt: last };
function documentFixture() {
  const listeners = new Map();
  return { hidden: false, listeners, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, visibility() { for (const fn of listeners.get('visibilitychange') || []) fn(); } };
}
function scheduler() {
  const timers = new Map(); let clock = 0, id = 0;
  return { timers, now: () => clock, setTimeoutImpl(fn, ms) { timers.set(++id, { fn, at: clock + ms }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.delete(id)) timer.fn(); } };
}
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };

test('connected collection delivery invalidates coverage by revision without polling, changing selected facts, or fetching closed panels', async () => {
  const timing = scheduler(), changes = [], states = []; let listener, manifests = 0, unsubscribed = false;
  const appended = { at: '2026-10-11T09:30:00.000Z', id: 'three', source: 'usgs', recordCount: 1 };
  const controller = createHistoryController({ ...timing, documentRef: documentFixture(), onChange: (state) => states.push(state), onTimeChange: (state) => changes.push(state),
    subscribeUpdates(callback) { listener = callback; callback({ type: 'status', status: 'connected', revision: 'r1' }); return () => { unsubscribed = true; }; },
    fetchImpl: async (url) => url === '/api/history' ? Response.json({ configured: true, snapshots: ++manifests === 1 ? snapshots : [...snapshots, appended] }) :
      Response.json({ configured: true, snapshots: [snapshots[0]], reports: [report] }),
  });
  assert.equal(manifests, 0); await controller.open(); await controller.select(first);
  const selected = controller.getState().selection, count = states.length;
  assert.equal(timing.timers.size, 0); timing.advance(60000); await settle(); assert.equal(manifests, 1);
  listener({ type: 'collection', schemaVersion: 1, revision: 'r1' }); listener({ type: 'collection', schemaVersion: 2, revision: 'r2' });
  assert.equal(manifests, 1);
  listener({ type: 'collection', schemaVersion: 1, revision: 'r2' }); await settle();
  assert.equal(manifests, 2); assert.equal(controller.getState().manifest.lastAt, appended.at);
  assert.equal(controller.getState().selection, selected); assert.equal(changes.length, 1);
  assert.ok(states.slice(count).every((state) => state.loading === false));
  controller.close(); listener({ type: 'collection', schemaVersion: 1, revision: 'r3' }); await settle(); assert.equal(manifests, 2);
  await controller.open(); assert.equal(manifests, 3); assert.equal(timing.timers.size, 0);
  listener({ type: 'status', status: 'reconnecting' }); assert.equal(timing.timers.size, 1);
  listener({ type: 'status', status: 'connected', revision: 'r3' }); assert.equal(timing.timers.size, 0);
  controller.destroy(); assert.equal(unsubscribed, true); listener({ type: 'collection', schemaVersion: 1, revision: 'r4' }); assert.equal(manifests, 3);
});

test('revision events during a manifest request coalesce into one follow-up, and hidden collection updates wait for visibility', async () => {
  const timing = scheduler(), documentRef = documentFixture(), body = Promise.withResolvers(), began = Promise.withResolvers();
  let listener, manifests = 0, oldSignal;
  const appended = { at: '2026-10-11T09:30:00.000Z', id: 'three', source: 'usgs', recordCount: 1 };
  const controller = createHistoryController({ ...timing, documentRef,
    subscribeUpdates(callback) { listener = callback; callback({ type: 'status', status: 'connected', revision: 'r1' }); return () => {}; },
    fetchImpl: async (_url, init) => {
      if (++manifests === 2) { oldSignal = init.signal; return { ok: true, json() { began.resolve(); return body.promise; } }; }
      return Response.json({ configured: true, snapshots: manifests > 2 ? [...snapshots, appended] : snapshots });
    },
  });
  await controller.open(); listener({ type: 'collection', schemaVersion: 1, revision: 'r2' }); await began.promise;
  listener({ type: 'collection', schemaVersion: 1, revision: 'r3' }); listener({ type: 'collection', schemaVersion: 1, revision: 'r4' });
  assert.equal(manifests, 2); body.resolve({ configured: true, snapshots }); await settle();
  assert.equal(manifests, 3); assert.equal(controller.getState().manifest.lastAt, appended.at); assert.equal(oldSignal.aborted, false);
  documentRef.hidden = true; documentRef.visibility(); listener({ type: 'collection', schemaVersion: 1, revision: 'r5' });
  assert.equal(manifests, 3); assert.equal(timing.timers.size, 0);
  documentRef.hidden = false; documentRef.visibility(); await settle(); assert.equal(manifests, 4); assert.equal(timing.timers.size, 0);
  controller.destroy();
});

test('minute manifest renewal preserves the selected capture and original source dates without showing a loading state', async () => {
  const timing = scheduler(), states = [], changes = [], calls = []; let manifests = 0;
  const appended = { at: '2026-10-11T09:30:00.000Z', id: 'three', source: 'usgs', recordCount: 1 };
  const controller = createHistoryController({ ...timing, documentRef: documentFixture(), onChange: (state) => states.push(state), onTimeChange: (state) => changes.push(state),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === '/api/history') return Response.json({ configured: true, snapshots: ++manifests === 1 ? snapshots : [...snapshots, appended] });
      return Response.json({ configured: true, snapshots: [snapshots[0]], reports: [{ ...report, retrievedAt: first }] });
    } });
  await controller.open(); await controller.select(first);
  const selected = controller.getState().selection, stateCount = states.length;
  assert.equal(timing.timers.size, 1); assert.equal(HISTORY_REFRESH_MS, 60000);
  timing.advance(60000); await settle();
  assert.equal(manifests, 2); assert.equal(controller.getState().manifest.lastAt, appended.at);
  assert.equal(controller.getState().selection, selected); assert.equal(selected.reports[0].retrievedAt, first);
  assert.equal(changes.length, 1, 'Discovering more capture times cannot move the model clock or replace selected facts');
  assert.ok(states.slice(stateCount).every((state) => state.loading === false));
  assert.ok(calls.every(({ init }) => init.cache === 'no-cache'));
  controller.close(); assert.equal(timing.timers.size, 0); timing.advance(60000); await settle(); assert.equal(manifests, 2);
  controller.destroy();
});

test('a scheduled manifest check cannot cancel an in-flight capture selection; hide and destroy cancel both independently', async () => {
  for (const closing of ['close', 'hide', 'destroy']) {
    const timing = scheduler(), documentRef = documentFixture(), began = Promise.withResolvers(), body = Promise.withResolvers(), changes = [];
    let manifests = 0, selectedSignal;
    const controller = createHistoryController({ ...timing, documentRef, onTimeChange: (state) => changes.push(state), fetchImpl: async (url, init) => {
      if (url === '/api/history') { manifests++; return Response.json({ configured: true, snapshots }); }
      selectedSignal = init.signal; return { ok: true, json() { began.resolve(); return body.promise; } };
    } });
    await controller.open(); const selection = controller.select(first); await began.promise;
    timing.advance(60000); await settle();
    assert.equal(manifests, 2); assert.equal(selectedSignal.aborted, false); assert.equal(controller.getState().loading, true);
    if (closing === 'hide') { documentRef.hidden = true; documentRef.visibility(); } else controller[closing]();
    assert.equal(selectedSignal.aborted, true); assert.equal(timing.timers.size, 0);
    body.resolve({ configured: true, snapshots: [snapshots[0]], reports: [report] });
    assert.equal(await selection, false); assert.equal(changes.length, 0); assert.equal(controller.getState().selection, null);
    controller.destroy();
  }
});

test('visible reconnect renews coverage, coalesces requests and rejects a canceled background body', async () => {
  const timing = scheduler(), documentRef = documentFixture(), windowRef = documentFixture(), body = Promise.withResolvers(), began = Promise.withResolvers();
  const appended = { at: '2026-10-11T09:30:00.000Z', id: 'three', source: 'usgs', recordCount: 1 };
  let calls = 0, oldSignal;
  const controller = createHistoryController({ ...timing, documentRef, windowRef, fetchImpl: async (_url, init) => {
    if (++calls === 2) { oldSignal = init.signal; return { ok: true, json() { began.resolve(); return body.promise; } }; }
    return Response.json({ configured: true, snapshots: calls > 2 ? [...snapshots, appended] : snapshots });
  } });
  const reconnect = () => { for (const fn of windowRef.listeners.get('online') || []) fn(); };
  await controller.open(); timing.advance(60000); await began.promise; reconnect(); assert.equal(calls, 2);
  documentRef.hidden = true; documentRef.visibility(); assert.equal(oldSignal.aborted, true); assert.equal(timing.timers.size, 0);
  reconnect(); assert.equal(calls, 2);
  documentRef.hidden = false; documentRef.visibility(); reconnect(); await settle(); assert.equal(calls, 3);
  body.resolve({ configured: true, snapshots: [] }); await settle();
  assert.equal(controller.getState().manifest.lastAt, appended.at); assert.equal(controller.getState().loading, false); assert.equal(timing.timers.size, 1);
  controller.close(); reconnect(); await settle(); assert.equal(calls, 3); assert.equal(timing.timers.size, 0);
  controller.destroy(); assert.equal(windowRef.listeners.get('online').size, 0);
});

test('failed automatic coverage refresh retains the selected archive and waits a minute before retrying', async () => {
  const timing = scheduler(); let manifests = 0;
  const controller = createHistoryController({ ...timing, documentRef: documentFixture(), fetchImpl: async (url) => {
    if (url !== '/api/history') return Response.json({ configured: true, snapshots: [snapshots[0]], reports: [report] });
    if (++manifests > 1) throw new Error('Coverage connection interrupted');
    return Response.json({ configured: true, snapshots });
  } });
  await controller.open(); await controller.select(first); const selected = controller.getState().selection;
  timing.advance(60000); await settle();
  assert.equal(controller.getState().selection, selected); assert.equal(controller.getState().manifest.lastAt, last);
  assert.match(controller.getState().error, /Coverage connection interrupted/); assert.equal(controller.getState().loading, false);
  timing.advance(59000); await settle(); assert.equal(manifests, 2);
  timing.advance(1000); await settle(); assert.equal(manifests, 3); controller.destroy();
});

class Element {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { if (typeof node === 'object') { node.remove(); node.parentElement = this; } this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of [...this.children]) if (typeof node === 'object') node.remove(); this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
  replaceWith(node) { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); node.remove(); parent.children.splice(index, 1, node); node.parentElement = parent; this.parentElement = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  trigger(type) { for (const fn of this.listeners.get(type) || []) fn(); }
}
const elements = (root) => [root, ...root.children.filter((child) => typeof child === 'object').flatMap(elements)];

test('the visible UTC label subscribes independently of scene rendering and archive requests, with one shared Live timer', () => {
  const timing = scheduler(), documentRef = documentFixture(); documentRef.createElement = (tag) => new Element(tag, documentRef);
  const wallClock = createLiveClock({ ...timing, documentRef }); let requests = 0, frames = 0;
  const viewer = { earthTime: { getState: () => ({ ...wallClock.getState(), lighting: true }), subscribeClock: wallClock.subscribe,
    setTime: wallClock.setTime }, entities: { remove() {} }, scene: { requestRender() { frames++; } } };
  const container = documentRef.createElement('details');
  const timeline = createTimeline({ ...timing, container, viewer, documentRef, fetchImpl() { requests++; throw new Error('A clock cannot fetch'); } });
  const label = elements(container.parentElement).find((element) => element.className === 'timeline-clock');
  assert.equal(timing.timers.size, 1); assert.equal(label.dateTime, '1970-01-01T00:00:00.000Z');
  timing.advance(3000); assert.equal(label.dateTime, '1970-01-01T00:00:03.000Z'); assert.equal(requests, 0); assert.equal(frames, 0);
  documentRef.hidden = true; documentRef.visibility(); assert.equal(timing.timers.size, 0); timing.advance(65000);
  documentRef.hidden = false; documentRef.visibility(); assert.equal(label.dateTime, '1970-01-01T00:01:08.000Z');
  wallClock.setTime('2026-10-11T09:00:00.123Z'); assert.equal(label.dateTime, '2026-10-11T09:00:00.123Z'); assert.equal(timing.timers.size, 0);
  timing.advance(60000); assert.equal(label.dateTime, '2026-10-11T09:00:00.123Z');
  timeline.live(); assert.equal(label.dateTime, '1970-01-01T00:02:08.000Z'); assert.equal(timing.timers.size, 1);
  timeline.destroy(); wallClock.destroy(); assert.equal(timing.timers.size, 0); assert.equal(requests, 0); assert.equal(frames, 0);
});

test('UTC calendar seeks and playback cross midnight, preserve dates during full-range refresh, and keep evidence unchanged within capture windows', async () => {
  const timing = scheduler(), documentRef = documentFixture(); documentRef.createElement = (tag) => new Element(tag, documentRef);
  const container = documentRef.createElement('details'), entities = new Set(), changes = [], requests = []; let manifests = 0;
  const oldest = { at: '2026-10-09T23:55:00.000Z', id: 'oldest', source: 'usgs', recordCount: 1 };
  const middle = { at: '2026-10-10T00:15:00.000Z', id: 'middle', source: 'usgs', recordCount: 1 };
  const older = { at: '2026-10-08T23:00:00.000Z', id: 'older', source: 'usgs', recordCount: 1 };
  const newer = { at: '2026-10-12T09:30:00.000Z', id: 'newer', source: 'usgs', recordCount: 1 };
  const sceneClock = createSceneClock({ ...timing, documentRef, monotonicNow: timing.now, now: () => Date.parse(newer.at) + timing.now() });
  const viewer = { earthTime: { ...sceneClock, getState: () => ({ ...sceneClock.getState(), lighting: true }), subscribeClock: sceneClock.subscribe },
    entities: { add(value) { entities.add(value); return value; }, remove(value) { entities.delete(value); } }, scene: { requestRender() {} } };
  const timeline = createTimeline({ ...timing, container, viewer, documentRef, onTimeChange: (state) => changes.push(state), fetchImpl: async (url) => {
    requests.push(url);
    if (url === '/api/history') return Response.json({ configured: true, indexMode: 'd1-full-history',
      firstAt: ++manifests === 1 ? oldest.at : older.at, lastAt: manifests === 1 ? last : newer.at,
      snapshots: manifests === 1 ? snapshots : [...snapshots, newer] });
    const at = new URL(url, 'https://example.test').searchParams.get('at');
    const allCaptures = [older, oldest, middle, ...snapshots, newer], snapshot = allCaptures.filter((item) => item.at <= at).at(-1);
    return Response.json({ configured: true, indexMode: 'd1-full-history', selectedAt: at,
      firstAt: older.at, lastAt: newer.at, nextCaptureAt: allCaptures.find((item) => item.at > at)?.at || null,
      snapshots: [snapshot], reports: [{ ...report, id: 'usgs:fixture', magnitude: 3.4, observedAt: snapshot.at, retrievedAt: snapshot.at }] });
  } });
  assert.equal(manifests, 0); container.open = true; container.trigger('toggle'); await settle();
  const dock = container.parentElement, summary = elements(container).find((element) => element.tagName === 'summary');
  const slider = elements(container).find((element) => element.type === 'range'), records = elements(container).find((element) => element.className === 'timeline-records');
  const date = elements(container).find((element) => element.className === 'timeline-date');
  const play = elements(dock).find((element) => element.className?.includes('timeline-play'));
  const rate = elements(dock).find((element) => element.className === 'timeline-rate');
  assert.equal(summary.attributes['aria-label'], 'Calendar and recorded coverage');
  assert.equal(summary.attributes['aria-expanded'], 'true');
  assert.ok(!elements(summary).some((element) => ['button', 'select', 'input'].includes(element.tagName)), 'Disclosure has one action; transport controls are siblings');
  assert.equal(play.parentElement.parentElement, dock);
  const beforeMidnight = '2026-10-09T23:59:50.000Z';
  assert.equal(slider.min, String(Date.parse(oldest.at) / 1000), 'Stored coverage, not the newest bounded catalog, defines the calendar');
  slider.value = String(Date.parse(beforeMidnight) / 1000); slider.trigger('change'); await settle(); const card = records.children[0];
  assert.equal(sceneClock.getState().mode, 'history'); assert.equal(sceneClock.getState().at, beforeMidnight); assert.equal(entities.size, 1);
  assert.equal([...entities][0].properties.usgsId, 'fixture'); assert.equal([...entities][0].properties.mag, 3.4);
  assert.equal([...entities][0].properties.time, Date.parse(oldest.at), 'Historical pin source time is not retimed to the playback cursor');
  rate.value = '60'; rate.trigger('change'); play.trigger('click'); await settle(); const playbackRequests = requests.length;
  timing.advance(1000); await settle();
  assert.equal(sceneClock.getState().at, '2026-10-10T00:00:50.000Z'); assert.equal(requests.length, playbackRequests, 'Crossing midnight does not fetch unchanged evidence');
  assert.equal(date.value, '2026-10-10T00:00:50'); play.trigger('click');
  const chosen = '2026-10-10T00:05:20.000Z'; date.value = chosen.slice(0, 19); date.trigger('change'); await settle();
  assert.equal(sceneClock.getState().at, chosen); assert.equal(changes.at(-1).reports[0].retrievedAt, oldest.at);
  timing.advance(60000); await settle();
  assert.equal(slider.value, String(Date.parse(chosen) / 1000)); assert.equal(slider.min, String(Date.parse(older.at) / 1000));
  assert.equal(slider.max, String(Date.parse(newer.at) / 1000)); assert.equal(date.value, chosen.slice(0, 19));
  assert.equal(records.children[0], card); assert.equal(sceneClock.getState().at, chosen); assert.equal(entities.size, 1);
  const multiDay = '2026-10-11T18:11:02.000Z'; slider.value = String(Date.parse(multiDay) / 1000); slider.trigger('input'); timing.advance(60000); await settle();
  assert.equal(slider.value, String(Date.parse(multiDay) / 1000), 'A renewal cannot reset a thumb while the visitor drags');
  assert.equal(sceneClock.getState().at, chosen); slider.trigger('change'); await settle();
  assert.equal(sceneClock.getState().at, multiDay); assert.equal(date.value, multiDay.slice(0, 19)); assert.equal(changes.at(-1).snapshots[0].at, last);
  timeline.live(); assert.equal(sceneClock.getState().mode, 'live'); assert.equal(entities.size, 0);
  timeline.destroy(); sceneClock.destroy(); assert.equal(timing.timers.size, 0);
});

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

test('cartographic night appearance preserves real astronomical UTC, toggles without native darkening, and restores owned resources', (t) => {
  // Cesium's native Moon material performs browser-type checks during creation;
  // no texture or graphics context is acquired in this CPU-only lifecycle test.
  for (const key of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: class BrowserGraphicsType {} });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const documentRef = documentFixture(), timing = scheduler(); let frames = 0;
  const previousMaterial = {}, previousLight = {}, viewer = { clock: new Cesium.Clock(),
    scene: { light: previousLight, requestRenderMode: true, globe: { material: previousMaterial, enableLighting: true, showGroundAtmosphere: true }, requestRender() { frames++; } }, isDestroyed: () => false };
  const astronomy = installAstronomy(viewer, { ...timing, documentRef });
  const material = viewer.scene.globe.material;
  assert.ok(material instanceof Cesium.Material); assert.equal(material.uniforms.nightOpacity, CARTOGRAPHIC_NIGHT_OPACITY);
  assert.equal(astronomy.getState().lighting, true); assert.equal(viewer.scene.globe.enableLighting, false, 'Native ellipsoid darkening cannot multiply the cartographic tint again');
  assert.equal(viewer.scene.globe.showGroundAtmosphere, false);
  assert.ok(viewer.scene.sun instanceof Cesium.Sun); assert.ok(viewer.scene.moon instanceof Cesium.Moon); assert.equal(viewer.scene.sunBloom, false);
  assert.equal(viewer.clock.clockStep, Cesium.ClockStep.SYSTEM_CLOCK); assert.equal([...timing.timers.values()][0].at, ASTRONOMY_REFRESH_MS);
  const beforeTick = frames; timing.advance(1000); assert.equal(frames, beforeTick + 1); assert.equal(astronomy.getState().at, '1970-01-01T00:00:01.000Z');
  viewer.scene.requestRenderMode = false; timing.advance(1000); assert.equal(frames, beforeTick + 1, 'Continuous scenes already render native astronomy and receive no extra request');
  viewer.scene.requestRenderMode = true;
  const exact = '2026-10-11T09:00:00.123Z';
  astronomy.setTime(exact); assert.equal(timing.timers.size, 0); assert.equal(astronomy.getState().mode, 'history');
  assert.equal(Cesium.JulianDate.toIso8601(viewer.clock.tick(), 3), exact); assert.equal(astronomy.getState().at, exact); assert.equal(viewer.clock.shouldAnimate, false);
  astronomy.setTime(); assert.equal(viewer.clock.clockStep, Cesium.ClockStep.SYSTEM_CLOCK); assert.equal(viewer.clock.shouldAnimate, true);
  documentRef.hidden = true; documentRef.visibility(); assert.equal(timing.timers.size, 0); const hiddenFrames = frames;
  astronomy.setLighting(false); assert.equal(frames, hiddenFrames); assert.equal(material.uniforms.nightOpacity, 0); assert.equal(astronomy.getState().lighting, false);
  astronomy.setLighting(true); assert.equal(material.uniforms.nightOpacity, CARTOGRAPHIC_NIGHT_OPACITY); assert.equal(viewer.scene.globe.enableLighting, false);
  timing.advance(60000); documentRef.hidden = false; documentRef.visibility(); assert.equal(timing.timers.size, 1); assert.ok(frames > hiddenFrames);
  assert.equal(astronomy.getState().at, '1970-01-01T00:01:02.000Z');
  astronomy.destroy(); assert.equal(timing.timers.size, 0); assert.equal(viewer.scene.sun, undefined); assert.equal(viewer.scene.moon, undefined);
  assert.equal(viewer.scene.globe.material, previousMaterial); assert.equal(material.isDestroyed(), true);
  assert.equal(viewer.scene.globe.enableLighting, true); assert.equal(viewer.scene.globe.showGroundAtmosphere, true); assert.equal(viewer.scene.light, previousLight);
});
