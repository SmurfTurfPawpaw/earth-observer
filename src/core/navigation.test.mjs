import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_VIEW, parseViewHash, resolvePlace, serializeViewHash } from './navigation-state.js';
import * as Cesium from 'cesium';
import { cameraView, installNavigation, setCameraView } from './navigation.js';

test('camera links survive migration while unsupported layers and effects disappear', () => {
  const state = parseViewHash('#v=2&lat=50.7572&lon=4.3502&alt=91675&heading=360&pitch=-90&style=ir&l=s.t', ['earthquakes']);
  assert.equal(state.view.lat, 50.7572);
  assert.equal(state.view.lon, 4.3502);
  assert.equal(state.view.alt, 91675);
  assert.equal(state.view.heading, 360);
  assert.equal(state.layers, undefined);
  assert.equal(state.view.style, undefined);
});

test('malformed camera coordinates never reach Cesium', () => {
  const state = parseViewHash('#lat=999&lon=NaN&alt=-7&heading=Infinity&pitch=20&roll=');
  assert.deepEqual(state.view, HOME_VIEW);
});

test('share links round-trip enabled layers and filter unknown parameters', () => {
  const hash = serializeViewHash({ ...HOME_VIEW, lat: -33.86881, lon: 151.20929 }, ['wind', 'wind', 'earthquakes'], { wind: { model: 'gfs', height: 10 }, private: { apiKey: 'none' } });
  const state = parseViewHash(hash, ['wind', 'earthquakes']);
  assert.equal(state.view.lat, -33.86881);
  assert.equal(state.view.lon, 151.20929);
  assert.deepEqual(state.layers, ['wind', 'earthquakes']);
  assert.deepEqual(state.layerParams, { wind: { model: 'gfs', height: 10 } });
  assert.deepEqual(parseViewHash('#layers=', ['wind']).layers, []);
});

test('coordinate search checks both ranges and keeps latitude-longitude order', () => {
  assert.deepEqual(resolvePlace('50.85, 4.35'), { name: '50.8500, 4.3500', lat: 50.85, lon: 4.35 });
  assert.equal(resolvePlace('91, 4.35'), null);
  assert.equal(resolvePlace('50.85, -181'), null);
  assert.equal(resolvePlace('50.85, Infinity'), null);
});

test('offline search supports accents and rejects ambiguous or empty queries', () => {
  assert.equal(resolvePlace('sao paulo').name, 'São Paulo');
  assert.equal(resolvePlace('Brussels').lat, 50.8503);
  assert.equal(resolvePlace(''), null);
  assert.equal(resolvePlace('new'), null);
  assert.equal(resolvePlace('somewhere unknown'), null);
});

test('the actual global tilt button keeps Earth visible, reports pressed state, and toggles back', () => {
  const savedDocument = globalThis.document, savedWindow = globalThis.window;
  const elements = new Map();
  function element() {
    const listeners = new Map(), attributes = new Map();
    return { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name),
      setAttribute: (name, value) => attributes.set(name, value), replaceChildren() {}, click() { listeners.get('click')?.(); }, attributes };
  }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  globalThis.document = document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const canvas = { clientWidth: 1384, clientHeight: 884 };
  const scene = { canvas, drawingBufferWidth: 1384, drawingBufferHeight: 884,
    mapProjection: new Cesium.GeographicProjection(), mode: Cesium.SceneMode.SCENE3D,
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 }, screenSpaceCameraController: {}, requestRender() {} };
  const camera = new Cesium.Camera(scene); scene.camera = camera;
  const viewer = { canvas, scene, camera, isDestroyed: () => false };
  // The handler's final flight pose uses the real Cesium camera; no animation timer is needed.
  camera.flyTo = (options) => { camera.setView(options); camera.moveEnd.raiseEvent(); };
  let dispose;
  try {
    setCameraView(viewer, HOME_VIEW);
    dispose = installNavigation(viewer);
    const tilt = document.getElementById('tilt');
    assert.equal(tilt.attributes.get('aria-pressed'), 'false');
    tilt.click();
    assert.ok(cameraView(viewer).pitch > -89.5 && cameraView(viewer).pitch < -45);
    assert.equal(tilt.attributes.get('aria-pressed'), 'true');
    assert.ok(Cesium.IntersectionTests.rayEllipsoid(new Cesium.Ray(camera.positionWC, camera.directionWC), Cesium.Ellipsoid.WGS84));
    tilt.click();
    assert.ok(Math.abs(cameraView(viewer).pitch + 90) < 1e-7);
    assert.equal(tilt.attributes.get('aria-pressed'), 'false');
    // Direct camera exploration is still permitted to aim into the sky.
    setCameraView(viewer, { ...HOME_VIEW, pitch: 0 });
    assert.ok(Math.abs(cameraView(viewer).pitch) < 1e-7);
  } finally {
    dispose?.();
    globalThis.document = savedDocument; globalThis.window = savedWindow;
  }
});
