import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MAP_SYMBOL_KINDS } from './map-symbols.js';
import { BEACON_STYLE, beaconGeometry, beaconTipAt, beaconHeadOptions, beaconBaseOptions, beaconStemOptions, beaconAnimatorFor } from './map-beacons.js';

// Native Material checks browser image constructors even for constant colors.
for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) globalThis[name] ||= class {};
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
function projectedViewer(density = 1) {
  const frustum = new Cesium.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 2, near: 1, far: 1e8 });
  return { canvas: { clientWidth: 1000, clientHeight: 500, width: 1000 * density, height: 500 * density },
    scene: { drawingBufferWidth: 1000 * density, drawingBufferHeight: 500 * density },
    camera: { frustum, distanceToBoundingSphere: () => 10000, getPixelSize() { throw Error('CSS projection must not use physical density'); } } };
}
function animationFixture() {
  let time = 0, destroyed = false, mode = 'live', renderRequests = 0;
  const documentRef = new EventTarget(), windowRef = new EventTarget(), media = new EventTarget();
  documentRef.hidden = false; documentRef.defaultView = windowRef; media.matches = false; windowRef.matchMedia = () => media;
  const viewer = { scene: { preRender: new Cesium.Event(), requestRender: () => ++renderRequests },
    isDestroyed: () => destroyed, earthTime: { getState: () => ({ mode }) } };
  const animator = beaconAnimatorFor(viewer, { documentRef, now: () => time });
  return { viewer, documentRef, media, animator, advance(ms) { time += ms; viewer.scene.preRender.raiseEvent(viewer.scene); },
    hide(value) { documentRef.hidden = value; documentRef.dispatchEvent(new Event('visibilitychange')); },
    history() { mode = 'history'; windowRef.dispatchEvent(new Event('earth-observer:timechange')); },
    reduced() { media.matches = true; media.dispatchEvent(new Event('change')); },
    destroyViewer() { destroyed = true; }, requests: () => renderRequests };
}

test('beacon geometry keeps exact WGS84 anchors and raises along the surface normal at poles and dateline', () => {
  for (const coordinates of [[4.35, 50.85, 37], [180, 0], [-180, -90], [0, 90]]) {
    const source = Object.freeze(coordinates), geometry = beaconGeometry(projectedViewer(), source);
    const expected = Cesium.Cartesian3.fromDegrees(...coordinates);
    assert.equal(Cesium.Cartesian3.equals(geometry.base, expected), true);
    const rise = Cesium.Cartesian3.subtract(geometry.tip, geometry.base, new Cesium.Cartesian3());
    near(Cesium.Cartesian3.magnitude(rise), geometry.heightMetres);
    near(Cesium.Cartesian3.dot(Cesium.Cartesian3.normalize(rise, rise), geometry.normal), 1);
    assert.equal(Cesium.Cartesian3.equals(beaconTipAt(geometry, 0), expected), true);
    assert.equal(Cesium.Cartesian3.equalsEpsilon(beaconTipAt(geometry, 1), geometry.tip, 1e-12), true);
    assert.equal(Object.isFrozen(geometry.base), true);
    assert.match(geometry.heightMeaning, /Decorative.*not source altitude/);
    assert.throws(() => beaconTipAt(geometry, .5, geometry.base), TypeError);
  }
  for (const coordinates of [[181, 0], [0, 91], [0, NaN], [0, 0, Infinity], [0]]) assert.throws(() => beaconGeometry(projectedViewer(), coordinates), TypeError);
});

test('native perspective projection targets CSS pixels identically on ordinary and high-density backings', () => {
  const a = beaconGeometry(projectedViewer(1), [4, 50]), b = beaconGeometry(projectedViewer(3), [4, 50]);
  near(a.heightMetres, b.heightMetres);
  const dimensions = projectedViewer().camera.frustum.getPixelDimensions(1000, 500, 10000, 1, new Cesium.Cartesian2());
  near(a.heightMetres, Math.max(dimensions.x, dimensions.y) * BEACON_STYLE.targetStemPx);
  const missingCss = projectedViewer(2); missingCss.canvas.clientWidth = 0;
  let used; missingCss.camera.getPixelSize = (_sphere, width, height) => { used = [width, height]; return 1e9; };
  assert.equal(beaconGeometry(missingCss, [0, 0]).heightMetres, BEACON_STYLE.maximumHeightMetres);
  assert.deepEqual(used, [2000, 1000]);
  missingCss.camera.getPixelSize = () => .001;
  assert.equal(beaconGeometry(missingCss, [0, 0]).heightMetres, BEACON_STYLE.minimumHeightMetres);
});

test('each native polyline owns its material so removing an old edition cannot destroy a current stem', () => {
  const geometry = beaconGeometry(projectedViewer(), [4, 50]);
  const old = new Cesium.PolylineCollection(), current = new Cesium.PolylineCollection();
  const first = old.add(beaconStemOptions(geometry, { id: 'old' }));
  const second = current.add(beaconStemOptions(geometry, { id: 'current' }));
  const firstMaterial = first.material, secondMaterial = second.material;
  assert.notEqual(firstMaterial, secondMaterial);
  old.destroy(); assert.equal(firstMaterial.isDestroyed(), true); assert.equal(secondMaterial.isDestroyed(), false);
  const fresh = current.add(beaconStemOptions(geometry, { id: 'next' }));
  const freshMaterial = fresh.material;
  assert.equal(freshMaterial.isDestroyed(), false); assert.equal(second.material.type, 'Color');
  current.remove(second); assert.equal(secondMaterial.isDestroyed(), true); assert.equal(freshMaterial.isDestroyed(), false);
  current.destroy(); assert.equal(freshMaterial.isDestroyed(), true);
});

test('category caps share fixed 64px vector textures and use normal native depth without numbers or offsets', () => {
  const canvases = [], paths = [];
  class Path { constructor(value) { paths.push(value); } }
  const context = { beginPath() {}, arc() {}, stroke() {}, fill() {}, translate() {}, scale() {} };
  const documentRef = { createElement() { const canvas = { getContext: () => context }; canvases.push(canvas); return canvas; } };
  const images = new Set();
  for (const kind of MAP_SYMBOL_KINDS) {
    const options = beaconHeadOptions(kind, { documentRef, Path2DRef: Path }); images.add(options.image);
    assert.equal(beaconHeadOptions(kind, { documentRef, Path2DRef: Path }).image, options.image);
    assert.equal(options.image.width, 64); assert.equal(options.image.height, 64);
    assert.equal(options.width, 24); assert.equal(options.disableDepthTestDistance, undefined); assert.equal(options.pixelOffset, undefined);
  }
  const base = beaconBaseOptions({ documentRef, Path2DRef: Path });
  assert.equal(base.image.width, 32); assert.equal(base.width, 8); assert.equal(canvases.length, 8); assert.equal(images.size, 7); assert.equal(paths.length, 7);
  assert.equal(beaconHeadOptions('constructor', { documentRef, Path2DRef: Path }).image, beaconHeadOptions('notice', { documentRef, Path2DRef: Path }).image);
  const native = new Cesium.BillboardCollection();
  native.add({ ...beaconHeadOptions('flood', { documentRef: null }), position: Cesium.Cartesian3.fromDegrees(4, 50) });
  assert.equal(native.get(0).disableDepthTestDistance, undefined); native.destroy();
  const svg = decodeURIComponent(beaconHeadOptions('flood', { documentRef: null }).image.split(',')[1]);
  assert.doesNotMatch(svg, /<text|<image|foreignObject|href=|<script/i);
});

test('one finite native frame listener rises new factual revisions and never repeats a cluster on view refresh', () => {
  const f = animationFixture(), owner = f.animator.acquire('earthquakes'), values = [];
  owner.play({ key: 'earthquakes:source-id', revision: 'revision-one', apply: p => values.push(p) });
  assert.deepEqual(values, [0]); assert.equal(f.viewer.scene.preRender.numberOfListeners, 1);
  f.advance(160); near(values.at(-1), .875); f.advance(160); assert.equal(values.at(-1), 1);
  assert.equal(f.animator.getState().active, 0); assert.equal(f.viewer.scene.preRender.numberOfListeners, 0);
  owner.play({ key: 'earthquakes:source-id', revision: 'revision-one', apply: p => values.push(p) }); assert.equal(values.at(-1), 1);
  assert.equal(f.animator.getState().active, 0);
  owner.play({ key: 'earthquakes:source-id', revision: 'revision-two', apply: p => values.push(p) }); assert.equal(values.at(-1), 0);
  owner.settle(); const cluster = [];
  owner.play({ key: 'earthquakes:cell-summary', revision: null, apply: p => cluster.push(p) }); f.advance(320);
  owner.play({ key: 'earthquakes:cell-summary', revision: null, apply: p => cluster.push(p) }); assert.equal(cluster.at(-1), 1);
  assert.equal(f.animator.getState().active, 0); owner.destroy(); assert.equal(f.viewer.scene.preRender.numberOfListeners, 0);
});

test('motion caps only animation and bounded identity memory, never the displayed markers', () => {
  const f = animationFixture(), owner = f.animator.acquire('gdacs'), painted = new Map();
  for (let i = 0; i < 100; i++) owner.play({ key: `gdacs:${i}`, apply: p => painted.set(i, p) });
  assert.equal(painted.size, 100); assert.equal(f.animator.getState().active, 64);
  assert.equal([...painted.values()].filter(p => p === 1).length, 36);
  assert.equal(f.viewer.scene.preRender.numberOfListeners, 1); owner.settle(); assert.ok([...painted.values()].every(p => p === 1));
  f.hide(true);
  for (let i = 0; i < 1300; i++) owner.play({ key: `gdacs:bounded-${i}`, apply() {} });
  assert.equal(f.animator.getState().remembered, 1200); assert.equal(f.animator.getState().active, 0); owner.destroy();
});

test('hidden, reduced-motion and historical scenes settle without render holds or recurring timers', () => {
  for (const reason of ['hide', 'reduced', 'history']) {
    const f = animationFixture(), owner = f.animator.acquire(reason), values = [];
    owner.play({ key: reason, apply: p => values.push(p) });
    if (reason === 'hide') f.hide(true); else f[reason]();
    assert.equal(values.at(-1), 1); assert.equal(f.viewer.scene.preRender.numberOfListeners, 0);
    const requests = f.requests(); owner.play({ key: `${reason}:next`, apply: p => values.push(p) });
    assert.equal(values.at(-1), 1); assert.equal(f.requests(), requests); owner.destroy();
  }
});

test('owner teardown, stale preparation and callback failures cannot cancel a newer owner or poison first appearance', () => {
  const f = animationFixture(), a = f.animator.acquire('a'), b = f.animator.acquire('b'), values = [];
  const cancelOld = a.play({ key: 'shared:key', apply: p => values.push(['a', p]) });
  b.play({ key: 'shared:key', revision: 'new', apply: p => values.push(['b', p]) }); cancelOld(); a.destroy();
  assert.equal(f.animator.getState().active, 1); f.advance(320); assert.deepEqual(values.at(-1), ['b', 1]);
  b.play({ key: 'stale:key', isCurrent: () => false, apply() { throw Error('Must not paint stale preparation'); } });
  b.play({ key: 'stale:key', apply: p => values.push(['fresh', p]) }); assert.deepEqual(values.at(-1), ['fresh', 0]);
  b.settle(); b.play({ key: 'bad:callback', apply() { throw Error('Discard failed decoration only'); } });
  assert.equal(f.animator.getState().errors, 1); assert.equal(f.animator.getState().active, 0); assert.equal(f.viewer.scene.preRender.numberOfListeners, 0);
  b.destroy(); b.destroy(); assert.equal(f.animator.getState().owners, 0); assert.equal(f.animator.getState().remembered, 0);
  assert.throws(() => b.play({ key: 'after-destroy', apply() {} }), TypeError);
});
