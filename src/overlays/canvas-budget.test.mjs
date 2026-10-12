import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { worldOverlayCanvasBudget, WORLD_OVERLAY_MAX_BACKING_PIXELS } from './canvas-budget.js';
import {
  initWorldOverlay, destroyWorldOverlay, registerWorldOverlayPaintLane,
  setOverlayEntries, clearOverlaySource, getOverlayPaintRect, hitTestWorldOverlay,
} from './worldOverlay.js';
import { LABEL_ARBITER_TIMING } from '../data/labelArbiter.js';

test('high-DPR desktop, mobile and 4K backings obey a physical pixel cap without changing CSS dimensions', () => {
  for (const [width, height, requested] of [[390, 844, 4], [1280, 720, 3], [1920, 1080, 2], [3840, 2160, 3], [7680, 4320, 1], [3440, 1440, 2]]) {
    const budget = worldOverlayCanvasBudget(width, height, requested);
    assert.equal(budget.width, width); assert.equal(budget.height, height);
    assert(budget.dpr > 0 && budget.dpr <= 2);
    assert(budget.backingWidth * budget.backingHeight <= WORLD_OVERLAY_MAX_BACKING_PIXELS);
    assert(Math.abs(budget.backingWidth - width * budget.dpr) < 1);
    assert(Math.abs(budget.backingHeight - height * budget.dpr) < 1);
  }
  assert.equal(worldOverlayCanvasBudget(390, 844, 4).dpr, 2);
  assert(worldOverlayCanvasBudget(3840, 2160, 1).dpr < 1, '4K at DPR1 still needs the physical pixel cap');
  assert.equal(worldOverlayCanvasBudget(640, 480, Number.POSITIVE_INFINITY).dpr, 1);
  const hidden = worldOverlayCanvasBudget(0, 0, 4);
  assert.equal(hidden.backingWidth * hidden.backingHeight, 0);
  assert.equal(hidden.dpr, 1);
});

// Canvas2D/DOM lifecycle fixture; deliberately no WebGL/GPU performance claim.
function overlayFixture(width = 1920, height = 1080, dpr = 4) {
  const saved = ['document', 'window', 'performance'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let timestamp = 1000, frame;
  const allocations = [];
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
      this.classList = { contains: () => false }; this.attributes = new Map();
      this._width = tag === 'canvas' ? 300 : 0; this._height = tag === 'canvas' ? 150 : 0;
      this.context = new Proxy({ setTransform: (...values) => { this.transform = values; }, measureText: text => ({ width: text.length * 8 }) }, {
        get: (target, key) => key in target ? target[key] : () => {},
      });
    }
    get width() { return this._width; }
    set width(value) { this._width = value; allocations.push(this._width * this._height); }
    get height() { return this._height; }
    set height(value) { this._height = value; allocations.push(this._width * this._height); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    addEventListener() {}
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); for (const child of children) this.appendChild(child); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === '#' + child.id ? [child] : []), ...child.querySelectorAll(selector)]); }
    getContext() { return this.context; }
    getBoundingClientRect() { return { left: 0, top: 0, width: Number.parseFloat(this.style.width) || 0, height: Number.parseFloat(this.style.height) || 0 }; }
  }
  const body = new Element('body'), container = new Element('div'); body.appendChild(container);
  const listeners = new Map();
  const document = { body, createElement: tag => new Element(tag), getElementById: id => body.querySelector('#' + id), querySelectorAll: selector => body.querySelectorAll(selector) };
  const window = { devicePixelRatio: dpr, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => timestamp } });
  const viewer = {
    container, canvas: { clientWidth: width, clientHeight: height },
    camera: { positionWC: new Cesium.Cartesian3(0, 0, 7000000), frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY }, viewMatrix: Cesium.Matrix4.IDENTITY },
    scene: { postRender: { addEventListener: callback => { frame = callback; return () => { frame = null; }; } }, requestRender() {} },
  };
  initWorldOverlay(viewer);
  return {
    viewer, allocations, main: document.getElementById('world-overlay-canvas'), detection: document.getElementById('world-overlay-detection-surface'),
    draw: (advance = 0) => { timestamp += advance; frame(); },
    resize: (nextWidth, nextHeight, nextDpr) => { viewer.canvas.clientWidth = nextWidth; viewer.canvas.clientHeight = nextHeight; window.devicePixelRatio = nextDpr; listeners.get('resize')(); },
    close() { destroyWorldOverlay(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

test('detection backing starts empty, allocates only on permitted painting and releases while ordinary overlays continue', () => {
  const fixture = overlayFixture();
  try {
    fixture.draw(); assert.equal(fixture.main.width * fixture.main.height, 0); assert.equal(fixture.detection.width * fixture.detection.height, 0);
    let detectionAllowed = false, painted = 0;
    const shared = registerWorldOverlayPaintLane('selected', () => {}, { id: 'shared-fixture', active: true });
    const detection = registerWorldOverlayPaintLane('detection', frame => {
      painted++; assert.equal(frame.width, 1920); assert.equal(frame.height, 1080);
      assert.equal(frame.surface, fixture.detection); assert.equal(frame.ctx, fixture.detection.context);
      assert.equal(frame.dpr, worldOverlayCanvasBudget(1920, 1080, 4).dpr);
    }, { id: 'detection-fixture', target: 'detection', active: true, shouldPaint: () => detectionAllowed });
    fixture.draw(); assert(fixture.main.width > 0); assert.equal(fixture.detection.width * fixture.detection.height, 0); assert.equal(painted, 0);
    detectionAllowed = true; fixture.draw(); assert.equal(painted, 1); assert(fixture.detection.width > 0);
    assert.equal(fixture.detection.style.width, '1920px'); assert.equal(fixture.detection.style.height, '1080px');
    detectionAllowed = false; fixture.draw(); assert.equal(painted, 1); assert(fixture.detection.width > 0, 'an active retained detection frame is not discarded when its repaint predicate defers');
    detection.setActive(false); fixture.draw(); assert.equal(fixture.detection.width * fixture.detection.height, 0); assert(fixture.main.width > 0);
    fixture.resize(1080, 1920, 4); fixture.draw(); assert.equal(fixture.main.style.width, '1080px'); assert.equal(fixture.main.style.height, '1920px');
    assert(fixture.allocations.every(pixels => pixels <= WORLD_OVERLAY_MAX_BACKING_PIXELS), 'resize must not transiently allocate old-height/new-width pixels beyond the cap');
    shared.setActive(false); fixture.draw(); assert.equal(fixture.main.width * fixture.main.height, 0);
    assert.equal(fixture.main.style.width, '1080px', 'release preserves CSS layout');
    shared.setActive(true); fixture.draw(); assert(fixture.main.width > 0, 'next work reallocates correctly after dormancy');
  } finally { fixture.close(); }
});

test('label picking stays in CSS space and its backing survives fade-out until work ends', () => {
  const fixture = overlayFixture(1280, 720, 4);
  try {
    setOverlayEntries('label-fixture', [{ id: 'one', position: new Cesium.Cartesian3(0, 0, 0), variant: 'label', title: 'Retained source', horizonCull: false, edgeFade: 'none', interactive: true }]);
    fixture.draw(); fixture.draw(LABEL_ARBITER_TIMING.fadeInMs + 1);
    const rect = getOverlayPaintRect('label-fixture', 'one'); assert(rect);
    assert.equal(rect.anchorX, 640); assert.equal(rect.anchorY, 360);
    assert.equal(hitTestWorldOverlay(rect.x + rect.w / 2, rect.y + rect.h / 2)?.entryId, 'one');
    assert.equal(fixture.main.style.width, '1280px'); assert.equal(fixture.main.style.height, '720px');
    assert.equal(fixture.detection.width * fixture.detection.height, 0, 'labels never allocate detection');
    clearOverlaySource('label-fixture'); fixture.draw(); fixture.draw(LABEL_ARBITER_TIMING.fadeOutMs - 1);
    assert(fixture.main.width > 0, 'active fade must retain its backing');
    fixture.draw(2); assert.equal(fixture.main.width * fixture.main.height, 0); assert.equal(hitTestWorldOverlay(rect.x, rect.y), null);
    assert.equal(getOverlayPaintRect('label-fixture', 'one'), null);
    assert.equal(fixture.main.style.width, '1280px');
  } finally { fixture.close(); }
});
