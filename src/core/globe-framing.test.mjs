import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { globeFrameAltitude, recoverInitialCameraView, visibleTiltCameraView, viewerGlobeAltitude } from './globe-framing.js';
import { setCameraView } from './navigation.js';
import { initialWorkspace, loadSession, saveSession } from './session.js';

function cameraViewer(width = 1384, height = 884) {
  const canvas = { clientWidth: width, clientHeight: height };
  const scene = { drawingBufferWidth: width, drawingBufferHeight: height, canvas,
    mapProjection: new Cesium.GeographicProjection(), mode: Cesium.SceneMode.SCENE3D,
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 }, requestRender() {} };
  const camera = new Cesium.Camera(scene); scene.camera = camera;
  return { canvas, scene, camera, isDestroyed: () => false };
}
function earthVisibility(viewer, view) {
  setCameraView(viewer, view);
  const camera = viewer.camera;
  return camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC)
    .computeVisibility(new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, Cesium.Ellipsoid.WGS84.maximumRadius));
}
function centerHitsEarth(viewer, view) {
  setCameraView(viewer, view);
  return Boolean(Cesium.IntersectionTests.rayEllipsoid(new Cesium.Ray(viewer.camera.positionWC, viewer.camera.directionWC), Cesium.Ellipsoid.WGS84));
}
test('global framing fills the same short-axis fraction on desktop and portrait without clipping', () => {
  for (const [width, height] of [[1384, 884], [390, 844], [844, 390], [800, 800]]) {
    const fov = Math.PI / 3, radius = 6378137, fill = .8;
    const alt = globeFrameAltitude({ width, height, fov, radius, fill });
    const smallerHalf = Math.atan(Math.tan(fov / 2) * Math.min(width, height) / Math.max(width, height));
    const projectedFraction = Math.tan(Math.asin(radius / (radius + alt))) / Math.tan(smallerHalf);
    assert.ok(Math.abs(projectedFraction - fill) < 1e-10);
    assert.ok(alt > 250 && alt < 50000000);
    assert.ok(globeFrameAltitude({ width, height, fill: .65 }) > alt);
  }
});
test('invalid framing cannot become a NaN camera destination', () => {
  for (const geometry of [{ width: 0 }, { height: NaN }, { fov: Math.PI }, { fill: 1 }, { radius: -1 }]) assert.throws(() => globeFrameAltitude(geometry), TypeError);
});

test('saved and shared sky-only global views recover with actual Cesium frustum geometry', () => {
  for (const [width, height] of [[1384, 884], [390, 844], [844, 390]]) {
    const viewer = cameraViewer(width, height);
    for (const pitch of width > height ? [0, -45] : [0, -30]) {
      const shared = initialWorkspace(`#lat=30&lon=12&alt=18000000&heading=123&pitch=${pitch}&roll=0`, null, []);
      const data = new Map(), storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
      saveSession(shared.view, null, storage);
      const saved = initialWorkspace('', loadSession(storage), []);
      for (const { view } of [shared, saved]) {
        assert.equal(earthVisibility(viewer, view), Cesium.Intersect.OUTSIDE);
        const before = { position: Cesium.Cartesian3.clone(viewer.camera.positionWC), direction: Cesium.Cartesian3.clone(viewer.camera.directionWC) };
        const result = recoverInitialCameraView(viewer, view);
        assert.equal(result.recovered, true); assert.equal(result.view.pitch, -90); assert.equal(result.view.roll, 0);
        assert.equal(result.view.lat, view.lat); assert.equal(result.view.lon, view.lon); assert.equal(result.view.heading, view.heading);
        assert.deepEqual(viewer.camera.positionWC, before.position); assert.deepEqual(viewer.camera.directionWC, before.direction);
        assert.notEqual(earthVisibility(viewer, result.view), Cesium.Intersect.OUTSIDE);
      }
    }
  }
});

test('visible local and partial global tilts survive restoration, using the actual altitude clamp', () => {
  const viewer = cameraViewer();
  for (const view of [
    { lat: 50.85, lon: 4.35, alt: 25000, heading: 83, pitch: -45, roll: 30 },
    { lat: -33.86, lon: 151.2, alt: 90000, heading: 220, pitch: -30, roll: 0 },
    { lat: 30, lon: 12, alt: 50000000, heading: 0, pitch: -65, roll: 0 },
  ]) {
    const result = recoverInitialCameraView(viewer, view);
    assert.equal(result.recovered, false);
    assert.deepEqual(result.view, { ...view, alt: Math.min(view.alt, viewerGlobeAltitude(viewer, .65)) });
    assert.notEqual(earthVisibility(viewer, result.view), Cesium.Intersect.OUTSIDE);
  }
  // The wider vertical field in portrait still sees an edge of Earth at -45°.
  const portrait = cameraViewer(390, 844);
  const partial = { lat: 30, lon: 12, alt: 18000000, heading: 0, pitch: -45, roll: 0 };
  assert.notEqual(earthVisibility(portrait, partial), Cesium.Intersect.OUTSIDE);
  assert.equal(recoverInitialCameraView(portrait, partial).recovered, false);
});

test('tilt remains functional globally and preserves the requested local angle', () => {
  for (const [width, height] of [[1384, 884], [390, 844], [844, 390]]) {
    const viewer = cameraViewer(width, height);
    for (const lat of [30, -33, 90]) {
      const view = { lat, lon: 12, alt: 18000000, heading: 30, pitch: -45, roll: 0 };
      const global = visibleTiltCameraView(viewer, view);
      assert.ok(global.pitch > -90 && global.pitch < -45);
      assert.equal(centerHitsEarth(viewer, global), true);
      assert.notEqual(earthVisibility(viewer, global), Cesium.Intersect.OUTSIDE);
      const local = { ...view, lat: 50.85, alt: 25000 };
      assert.deepEqual(visibleTiltCameraView(viewer, local), local);
    }
  }
});

test('initial and tilt recovery never access a destroyed viewer', () => {
  const view = { lat: 30, lon: 12, alt: 18000000, heading: 0, pitch: 0, roll: 0 };
  const viewer = { isDestroyed: () => true, get canvas() { assert.fail('Destroyed viewer dereferenced'); } };
  assert.deepEqual(recoverInitialCameraView(viewer, view), { view, recovered: false });
  assert.equal(visibleTiltCameraView(viewer, view), view);
});
