import test from 'node:test';
import assert from 'node:assert/strict';
import { EllipsoidTerrainProvider, WebMercatorTilingScheme, PerspectiveFrustum, Math as CesiumMath } from 'cesium';
import { CSS_PIXEL_RENDERING, globeScreenSpaceError, installGlobeRenderingPolicy } from './rendering-policy.js';

function event() {
  const listeners = new Set();
  return {
    addEventListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    raise() { for (const listener of [...listeners]) listener(); },
    get size() { return listeners.size; },
  };
}
function fixture() {
  const viewer = { useBrowserRecommendedResolution: false, resolutionScale: 2,
    camera: { moveStart: event(), moveEnd: event() },
    scene: { globe: { maximumScreenSpaceError: 2 }, requests: 0, requestRender() { this.requests++; } },
  };
  return { viewer, policy: installGlobeRenderingPolicy(viewer) };
}

test('canvas resolution stays at CSS pixels instead of dropping below CSS resolution on high-DPI devices', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  try {
    for (const dpr of [1, 1.5, 2, 3, 4]) {
      Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: dpr });
      const { viewer, policy } = fixture();
      assert.equal(viewer.useBrowserRecommendedResolution, true, `browser resolution at DPR ${dpr}`);
      assert.equal(viewer.resolutionScale, 1, `CSS scale at DPR ${dpr}`);
      policy.destroy();
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'devicePixelRatio', descriptor);
    else delete globalThis.devicePixelRatio;
  }
  assert.equal(Object.isFrozen(CSS_PIXEL_RENDERING), true);
});

test('settled street maps refine, moving maps relax, and each quality change requests a render', () => {
  const { viewer, policy } = fixture();
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 3);
  assert.equal(viewer.scene.requests, 1);
  policy.setBasemapMode('map');
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 1.5);
  assert.equal(viewer.scene.requests, 2);
  viewer.camera.moveStart.raise();
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 3);
  assert.equal(viewer.scene.requests, 3);
  viewer.camera.moveEnd.raise();
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 1.5);
  assert.equal(viewer.scene.requests, 4);
  viewer.camera.moveEnd.raise();
  policy.setBasemapMode('map');
  assert.equal(viewer.scene.requests, 4, 'unchanged quality does not schedule extra frames');
  policy.destroy();
});

test('imagery and a failed map fallback keep coarse quality even when movement or mode changes overlap', () => {
  const { viewer, policy } = fixture();
  viewer.camera.moveStart.raise();
  policy.setBasemapMode('map');
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 3, 'map opened during movement');
  viewer.camera.moveEnd.raise();
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 1.5);
  policy.setBasemapMode('imagery');
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 3, 'visible imagery fallback');
  viewer.camera.moveStart.raise(); viewer.camera.moveEnd.raise();
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 3);
  assert.throws(() => policy.setBasemapMode('unapproved'), TypeError);
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 3);
  policy.destroy();
});

test('teardown removes both camera listeners and never schedules further quality work', () => {
  const { viewer, policy } = fixture();
  policy.setBasemapMode('map');
  assert.equal(viewer.camera.moveStart.size, 1);
  assert.equal(viewer.camera.moveEnd.size, 1);
  const requests = viewer.scene.requests;
  policy.destroy(); policy.destroy();
  assert.equal(viewer.camera.moveStart.size, 0);
  assert.equal(viewer.camera.moveEnd.size, 0);
  viewer.camera.moveStart.raise(); viewer.camera.moveEnd.raise(); policy.setBasemapMode('imagery');
  assert.equal(viewer.scene.requests, requests);
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 1.5);
});

// Estimate a nadir-view center tile using Cesium's terrain/imagery selection
// formulas. Actual edge tiles can differ with distance, fog and camera tilt.
function predictedTile(width, height, altitude, error) {
  const terrain = new EllipsoidTerrainProvider(), imagery = new WebMercatorTilingScheme();
  const frustum = new PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: width / height });
  const metersPerScreenPixel = altitude * frustum.sseDenominator / height;
  let level = 0;
  while (terrain.getLevelMaximumGeometricError(level) / metersPerScreenPixel >= error) level++;
  const position = { latitude: CesiumMath.toRadians(50.8503), longitude: CesiumMath.toRadians(4.3517) };
  const tile = terrain.tilingScheme.positionToTileXY(position, level);
  const rectangle = terrain.tilingScheme.tileXYToRectangle(tile.x, tile.y, level);
  const spacing0 = imagery.ellipsoid.maximumRadius * imagery.rectangle.width * Math.cos(rectangle.south) / 256;
  const imageryLevel = Math.min(18, Math.max(0, Math.round(Math.log2(spacing0 / terrain.getLevelMaximumGeometricError(level)))));
  return { imageryLevel, stretch: spacing0 / 2 ** imageryLevel / metersPerScreenPixel };
}

test('settled policy selects sharper center tiles at the reviewed Brussels desktop and mobile views', () => {
  for (const [width, height, coarse, refined] of [[1280, 720, 11, 12], [390, 844, 10, 11]]) {
    const moving = predictedTile(width, height, 27000, globeScreenSpaceError('map', true));
    const settled = predictedTile(width, height, 27000, globeScreenSpaceError('map', false));
    assert.equal(moving.imageryLevel, coarse);
    assert.equal(settled.imageryLevel, refined);
    assert.ok(settled.stretch < moving.stretch * .51);
    assert.ok(settled.stretch >= .9 && settled.stretch <= 1.4);
  }
  assert.equal(globeScreenSpaceError('imagery'), 3);
  assert.equal(globeScreenSpaceError('imagery', true), 3);
});
