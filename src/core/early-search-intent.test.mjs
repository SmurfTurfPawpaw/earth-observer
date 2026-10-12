import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createEarlySearchIntent, EARLY_SEARCH_INTENT_LIMITS } from './early-search-intent.js';
import { installNavigation, cameraView, setCameraView, HOME_VIEW } from './navigation.js';
import { createPlaceNavigation } from './workspace-focus.js';

class Element extends EventTarget {
  constructor(ownerDocument) { super(); this.ownerDocument = ownerDocument; this.value = ''; this.textContent = ''; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren() {}
}
const key = (input, value, extra = {}) => {
  const event = new Event('keydown', { cancelable: true });
  for (const [name, data] of Object.entries({ key: value, ...extra })) Object.defineProperty(event, name, { value: data });
  input.dispatchEvent(event); return event;
};
function fixture() {
  const document = new EventTarget(), window = new EventTarget(), elements = new Map(); document.hidden = false; document.defaultView = window;
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element(document)); return elements.get(id); };
  document.createElement = () => new Element(document);
  const input = document.getElementById('search'), form = document.getElementById('search-form'), status = document.getElementById('search-status');
  const button = { disabled: true }; let submits = 0;
  form.querySelector = () => button;
  form.requestSubmit = () => { submits++; form.dispatchEvent(new Event('submit', { cancelable: true })); };
  const intent = createEarlySearchIntent({ input, form, status, documentRef: document, windowRef: window });
  return { input, form, status, button, document, window, intent, submits: () => submits };
}

test('early Enter replays once through the actual navigation handler with explicit-empty layers, source time and consent untouched', t => {
  const previous = ['document', 'window', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let dispose;
  t.after(() => { dispose?.(); for (const [name, value] of previous) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } });
  const f = fixture(); Object.defineProperty(globalThis, 'document', { configurable: true, value: f.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: f.window });
  let permissionReads = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get geolocation() { permissionReads++; throw Error('Search must not request location'); } } });
  const canvas = { clientWidth: 1280, clientHeight: 720 }, scene = { canvas, drawingBufferWidth: 1280, drawingBufferHeight: 720,
    mapProjection: new Cesium.GeographicProjection(), mode: Cesium.SceneMode.SCENE3D, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 }, screenSpaceCameraController: {}, requestRender() {} };
  const camera = new Cesium.Camera(scene); scene.camera = camera; const viewer = { canvas, camera, scene };
  camera.flyTo = options => { camera.setView(options); camera.moveEnd.raiseEvent(); }; setCameraView(viewer, HOME_VIEW);
  const layers = [], history = { mode: 'history', at: '2025-11-15T12:00:00.000Z', playing: false };
  viewer.earthTime = { getState: () => history }; const before = cameraView(viewer);
  f.input.value = 'Brussels'; assert.equal(key(f.input, 'Enter').defaultPrevented, true); key(f.input, 'Enter');
  assert.deepEqual(cameraView(viewer), before); assert.equal(f.submits(), 0); assert.match(f.status.textContent, /queued/);
  dispose = installNavigation(viewer, { onPlace: createPlaceNavigation({ viewer }) }); f.button.disabled = false;
  assert.equal(f.intent.ready(), true); assert.equal(f.intent.ready(), false); assert.equal(f.submits(), 1);
  assert.ok(Math.abs(cameraView(viewer).lat - 50.8503) < .00001); assert.ok(Math.abs(cameraView(viewer).lon - 4.3517) < .00001);
  assert.ok(Math.abs(cameraView(viewer).alt - 90000) < 1); assert.deepEqual(layers, []); assert.equal(viewer.earthTime.getState(), history);
  assert.equal(permissionReads, 0); assert.equal(f.status.textContent, '');
  const unknown = fixture(); unknown.input.value = 'Unsupported village'; key(unknown.input, 'Enter');
  // Replace only the existing form/input nodes; install the real resolver again.
  dispose(); Object.defineProperty(globalThis, 'document', { configurable: true, value: unknown.document });
  dispose = installNavigation(viewer, { onPlace: createPlaceNavigation({ viewer }) }); unknown.button.disabled = false;
  const knownCamera = cameraView(viewer); assert.equal(unknown.intent.ready(), true);
  assert.deepEqual(cameraView(viewer), knownCamera); assert.match(unknown.status.textContent, /supported place/); assert.equal(permissionReads, 0);
});

test('edits, Escape, reset, hiding, page exit and terminal failure cancel a queued search; late readiness cannot navigate', () => {
  const cancellations = [
    f => { f.input.value = 'Berlin'; f.input.dispatchEvent(new Event('input')); },
    f => key(f.input, 'Escape'), f => f.form.dispatchEvent(new Event('reset')),
    f => { f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange')); f.document.hidden = false; },
    f => { f.document.hidden = true; }, f => f.window.dispatchEvent(new Event('pagehide')),
    f => f.intent.destroy(), f => { f.input.value = 'Berlin'; },
  ];
  for (const cancel of cancellations) {
    const f = fixture(); f.input.value = 'Brussels'; key(f.input, 'Enter'); cancel(f); f.button.disabled = false;
    assert.equal(f.intent.ready(), false); assert.equal(f.submits(), 0); assert.equal(f.status.textContent, '');
    f.intent.destroy(); key(f.input, 'Enter'); assert.equal(f.submits(), 0);
  }
});

test('only the latest bounded explicit query survives; composing or modified Enter never becomes a deferred action', () => {
  const f = fixture(); f.input.value = 'Brussels'; key(f.input, 'Enter');
  f.input.value = '51, 3'; f.input.dispatchEvent(new Event('input')); key(f.input, 'Enter');
  const delivered = []; f.form.addEventListener('submit', event => { event.preventDefault(); delivered.push(f.input.value); });
  f.button.disabled = false; assert.equal(f.intent.ready(), true); assert.deepEqual(delivered, ['51, 3']);
  for (const extra of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    const modified = fixture(); modified.input.value = 'Brussels'; assert.equal(key(modified.input, 'Enter', extra).defaultPrevented, false);
    modified.button.disabled = false; assert.equal(modified.intent.ready(), false); assert.equal(modified.submits(), 0);
  }
  for (const value of ['', ' ', 'x'.repeat(EARLY_SEARCH_INTENT_LIMITS.queryChars + 1)]) {
    const bounded = fixture(); bounded.input.value = value; key(bounded.input, 'Enter'); bounded.button.disabled = false;
    assert.equal(bounded.intent.ready(), false); assert.equal(bounded.submits(), 0);
  }
});

test('terminal cancellation preserves unrelated status and ready search forms retain their ordinary submit behavior', () => {
  const f = fixture(); f.input.value = 'Brussels'; key(f.input, 'Enter'); f.status.textContent = 'Renderer failed. Reload to retry.';
  f.intent.destroy(); assert.equal(f.status.textContent, 'Renderer failed. Reload to retry.'); f.button.disabled = false;
  assert.equal(f.intent.ready(), false); assert.equal(f.submits(), 0);
  const ready = fixture(); ready.button.disabled = false; ready.input.value = 'Brussels';
  assert.equal(key(ready.input, 'Enter').defaultPrevented, false); assert.equal(ready.intent.ready(), false);
  ready.form.requestSubmit(); assert.equal(ready.submits(), 1);
});
