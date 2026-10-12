import test from 'node:test';
import assert from 'node:assert/strict';
import { installPresentationBridge, PRESENTATION_BRIDGE_PIXEL_LIMIT } from './presentation-bridge.js';

function fixture({ width = 1600, height = 900, opacity = '', noContext = false } = {}) {
  const frames = new Set(), events = new Map(), surfaces = [], children = [], copies = [], errors = [];
  let requested = 0, measured = 0, throwCopy = false, at = '2025-06-01T12:00:00.123Z';
  const source = { width, height, style: { opacity }, addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type, fn) { if (events.get(type) === fn) events.delete(type); } };
  const container = { append(canvas) { children.push(canvas); } };
  const documentRef = { hidden: false, createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = { style: {}, dataset: {}, width: 300, height: 150, attributes: {}, hidden: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      getContext(type, options) { assert.equal(type, '2d'); assert.deepEqual(options, { alpha: false, willReadFrequently: true });
        return noContext ? null : { drawImage(...args) { if (throwCopy) throw new Error('TEST ONLY copy failed'); measured += 2; copies.push({ args, hiddenAtCopy: canvas.hidden, sourceOpacity: source.style.opacity }); } }; },
      remove() { const index = children.indexOf(this); if (index >= 0) children.splice(index, 1); } };
    surfaces.push(canvas); return canvas;
  } };
  const viewer = { canvas: source, container, scene: { requestRender() { requested++; }, postRender: { addEventListener(fn) { frames.add(fn); return () => frames.delete(fn); } } } };
  const bridge = installPresentationBridge(viewer, { container, documentRef, onError: error => errors.push(error),
    getSceneTime: () => at, performanceRef: { now: () => measured } });
  return { bridge, viewer, source, frames, events, surfaces, children, copies, errors, documentRef,
    get requested() { return requested; }, setTime(value) { at = value; }, failCopy() { throwCopy = true; },
    render() { for (const fn of [...frames]) fn(); } };
}

test('the bridge is opt-in, commits only after the first successful frame and copies every completed frame with exact UTC', () => {
  const f = fixture({ opacity: '.75' });
  assert.equal(f.bridge.getState().enabled, false); assert.equal(f.surfaces.length, 0); assert.equal(f.frames.size, 0);
  assert.equal(f.bridge.setEnabled(true), true); assert.equal(f.source.style.opacity, '.75'); assert.equal(f.children[0].hidden, true);
  assert.equal(f.requested, 1); f.render();
  assert.equal(f.copies[0].hiddenAtCopy, true); assert.equal(f.copies[0].sourceOpacity, '.75');
  assert.equal(f.source.style.opacity, '0'); assert.equal(f.children[0].hidden, false);
  assert.equal(f.children[0].style.pointerEvents, 'none'); assert.equal(f.children[0].attributes['aria-hidden'], 'true');
  assert.equal(f.bridge.getState().capturedSceneUtc, '2025-06-01T12:00:00.123Z'); assert.equal(f.bridge.getState().copyMs, 2);
  f.bridge.setEnabled(true); assert.equal(f.frames.size, 1); assert.equal(f.surfaces.length, 1);
  f.setTime('2025-06-01T12:00:01.456Z'); f.render(); f.render();
  assert.equal(f.copies.length, 3); assert.equal(f.bridge.getState().frameCount, 3);
  assert.equal(f.children[0].dataset.sceneUtc, '2025-06-01T12:00:01.456Z'); assert.equal(f.requested, 1, 'No copy schedules another frame');
  f.bridge.setEnabled(false); assert.equal(f.source.style.opacity, '.75'); assert.equal(f.children.length, 0); assert.equal(f.frames.size, 0);
  assert.equal(f.surfaces[0].width * f.surfaces[0].height, 0); f.bridge.destroy();
});

test('resizes keep source aspect and a bounded physical backing without changing input or source resolution', () => {
  const f = fixture({ width: 12000, height: 4000 }); f.bridge.setEnabled(true); f.render();
  let state = f.bridge.getState(); assert.ok(state.width * state.height <= PRESENTATION_BRIDGE_PIXEL_LIMIT);
  assert.ok(Math.abs(state.width / state.height - 3) < .01); assert.equal(f.source.width, 12000); assert.equal(f.source.height, 4000);
  assert.deepEqual(f.copies[0].args.slice(0, 5), [f.source, 0, 0, 12000, 4000]);
  f.source.width = 800; f.source.height = 1200; f.render(); state = f.bridge.getState();
  assert.equal(state.width, 800); assert.equal(state.height, 1200); assert.equal(f.children[0].style.width, '100%');
  f.source.width = 100000000; f.source.height = 1; f.render();
  state = f.bridge.getState(); assert.ok(state.width * state.height <= PRESENTATION_BRIDGE_PIXEL_LIMIT);
  f.bridge.destroy(); assert.equal(f.frames.size, 0);
});

test('initial and later copy failures restore WebGL, dispose the backing and never retry or take down the application', () => {
  for (const successfulFirst of [false, true]) {
    const f = fixture(); f.bridge.setEnabled(true); if (successfulFirst) f.render(); f.failCopy(); f.render();
    assert.equal(f.source.style.opacity, ''); assert.equal(f.bridge.getState().enabled, false); assert.equal(f.bridge.getState().status, 'failed');
    assert.equal(f.errors.length, 1); assert.equal(f.children.length, 0); assert.equal(f.frames.size, 0);
    assert.equal(f.surfaces[0].width * f.surfaces[0].height, 0); f.render(); assert.equal(f.errors.length, 1);
    f.bridge.destroy(); f.bridge.destroy(); assert.equal(f.bridge.setEnabled(true), false);
  }
  const unavailable = fixture({ noContext: true }); assert.equal(unavailable.bridge.setEnabled(true), false);
  assert.equal(unavailable.source.style.opacity, ''); assert.equal(unavailable.children.length, 0); assert.equal(unavailable.errors.length, 1);
  unavailable.bridge.destroy();
});

test('context loss disposes bridge ownership without swallowing the renderer event or automatically reactivating', () => {
  const f = fixture(); f.bridge.setEnabled(true); f.render(); const lost = f.events.get('webglcontextlost');
  lost({ preventDefault() { assert.fail('The optional bridge does not own context recovery'); } });
  assert.equal(f.bridge.getState().status, 'failed'); assert.equal(f.errors[0].code, 'EARTH_PRESENTATION_CONTEXT_LOST');
  assert.equal(f.source.style.opacity, ''); assert.equal(f.events.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.children.length, 0);
  f.bridge.destroy(); f.bridge.destroy(); assert.equal(f.bridge.getState().status, 'destroyed');
});

test('hidden enable requests no background frame, malformed time stays unknown and error observers cannot escape disposal', () => {
  const f = fixture(); f.documentRef.hidden = true; f.bridge.setEnabled(true); assert.equal(f.requested, 0);
  f.setTime('not a scene timestamp'); f.render(); assert.equal(f.bridge.getState().capturedSceneUtc, null);
  assert.equal(f.children[0].dataset.sceneUtc, undefined); f.bridge.destroy();
  const throwing = installPresentationBridge({}, { onError() { throw new Error('TEST ONLY observer error'); } });
  assert.equal(throwing.setEnabled(true), false); assert.equal(throwing.getState().status, 'failed'); throwing.destroy();
});
