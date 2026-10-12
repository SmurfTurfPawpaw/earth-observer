import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTimeline } from './timeline.js';
import { installAstronomy, ASTRONOMY_REFRESH_MS, CARTOGRAPHIC_NIGHT_OPACITY } from './astronomy.js';
import { createSceneClock } from './scene-clock.js';

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
  const wallClock = createSceneClock({ ...timing, monotonicNow: timing.now, documentRef }); let requests = 0, frames = 0;
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
