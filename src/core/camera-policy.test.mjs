import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CAMERA_POLICY, applyNativeCameraLimits, boundCameraPose, captureCameraOrbit, frameCameraOrbit, resizedCameraView, zoomCameraView } from './camera-policy.js';
import { cameraView, setCameraView } from './navigation.js';
import { HOME_VIEW, parseViewHash, serializeViewHash } from './navigation-state.js';

function viewerAt(width = 1384, height = 884) {
  const canvas = { clientWidth: width, clientHeight: height };
  const scene = { canvas, drawingBufferWidth: width, drawingBufferHeight: height, mode: Cesium.SceneMode.SCENE3D,
    mapProjection: new Cesium.GeographicProjection(), globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    screenSpaceCameraController: {}, requestRender() {} };
  const camera = new Cesium.Camera(scene); camera.frustum.aspectRatio = width / height; scene.camera = camera;
  const viewer = { scene, canvas, camera, isDestroyed: () => false };
  setCameraView(viewer, HOME_VIEW); return viewer;
}
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
function sameTarget(viewer, target, tolerance = .1) {
  const after = captureCameraOrbit(viewer);
  const distance = Cesium.Cartesian3.distance(target, after.target);
  assert.ok(distance < tolerance, `Surface pivot must remain at the view center; displaced ${distance}m at ${JSON.stringify(cameraView(viewer))}`);
  return after;
}
function wholeGlobeVisible(viewer) {
  const camera = viewer.camera;
  return camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC)
    .computeVisibility(new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, Cesium.Ellipsoid.WGS84.maximumRadius * CAMERA_POLICY.globePadding)) === Cesium.Intersect.INSIDE;
}

test('global orbit keeps its geographic target and full Earth inside the actual desktop and portrait frustum', () => {
  for (const [width, height] of [[1384, 884], [390, 844], [844, 390]]) {
    for (const [lat, lon] of [[30, 12], [-33, 151], [90, 180]]) {
      const viewer = viewerAt(width, height);
      // Use the shared maximum range: even the narrow portrait axis must fit.
      setCameraView(viewer, { ...HOME_VIEW, lat, lon, alt: applyNativeCameraLimits(viewer).maximumAltitude });
      const before = captureCameraOrbit(viewer), oldPosition = Cesium.Cartesian3.clone(viewer.camera.positionWC);
      const result = frameCameraOrbit(viewer, { pitch: -45, heading: 25, roll: 0 });
      assert.equal(Cesium.Cartesian3.equals(oldPosition, viewer.camera.positionWC), true, 'Preparing a pose does not move the live camera');
      assert.equal(result.globeFramed, true); assert.ok(result.appliedPitch <= -45 && result.appliedPitch > -90);
      setCameraView(viewer, result.view); sameTarget(viewer, before.target); assert.equal(wholeGlobeVisible(viewer), true);
      setCameraView(viewer, frameCameraOrbit(viewer, { pitch: -90 }).view); sameTarget(viewer, before.target);
      near(captureCameraOrbit(viewer).pitch, -90, 1e-5);
    }
  }
});

test('local tilt stays exactly requested while north and zoom orbit the same reported place instead of translating past it', () => {
  const viewer = viewerAt(); setCameraView(viewer, { ...HOME_VIEW, lat: 50.8503, lon: 4.3517, alt: 25000, heading: 83 });
  const target = captureCameraOrbit(viewer).target, tilt = frameCameraOrbit(viewer, { pitch: -45 });
  near(tilt.appliedPitch, -45); assert.equal(tilt.globeFramed, false);
  setCameraView(viewer, tilt.view); const first = sameTarget(viewer, target); near(first.pitch, -45);
  setCameraView(viewer, frameCameraOrbit(viewer, { heading: 0, roll: 0 }).view);
  const north = Cesium.Math.toRadians(sameTarget(viewer, target).heading);
  near(Math.sin(north), 0); near(Math.cos(north), 1);
  const range = captureCameraOrbit(viewer).range;
  setCameraView(viewer, zoomCameraView(viewer, 1)); const closer = sameTarget(viewer, target); near(closer.range, range * .65, .001); near(closer.pitch, -45);
  setCameraView(viewer, zoomCameraView(viewer, -1)); near(sameTarget(viewer, target).range, closer.range * 1.35, .001);
});

test('a missing center ground ray recovers only the current pose nadir at dateline and poles', () => {
  for (const [lat, lon] of [[-21, -179.99], [90, 12]]) {
    const viewer = viewerAt(); setCameraView(viewer, { ...HOME_VIEW, lat, lon, pitch: 0 });
    const orbit = captureCameraOrbit(viewer), nadir = Cesium.Cartographic.fromCartesian(orbit.target);
    assert.equal(orbit.anchorKind, 'pose-nadir'); near(Cesium.Math.toDegrees(nadir.latitude), lat);
    if (Math.abs(lat) < 90) near(Cesium.Math.toDegrees(nadir.longitude), lon);
    setCameraView(viewer, frameCameraOrbit(viewer, { pitch: -90 }).view); sameTarget(viewer, orbit.target);
  }
});

test('available ground is a separate display anchor and shared clearance protects both direct poses and orbit zoom', () => {
  const viewer = viewerAt(); setCameraView(viewer, { ...HOME_VIEW, lat: 50, lon: 4, alt: 20000 });
  const originalTarget = captureCameraOrbit(viewer).target, geographic = Cesium.Cartographic.fromCartesian(originalTarget);
  const terrainTarget = Cesium.Cartesian3.fromRadians(geographic.longitude, geographic.latitude, 1500);
  let picks = 0, heightReads = 0;
  viewer.scene.globe.pick = () => { ++picks; return terrainTarget; };
  viewer.scene.globe.getHeight = () => { ++heightReads; return 1500; };
  const before = Cesium.Cartesian3.clone(terrainTarget), orbit = captureCameraOrbit(viewer);
  assert.equal(orbit.anchorKind, 'available-ground'); assert.equal(Cesium.Cartesian3.equals(orbit.target, terrainTarget), true);
  const result = frameCameraOrbit(viewer, { pitch: -45, range: 250 });
  assert.ok(result.view.alt >= 1750 - .001); assert.ok(result.range > 250);
  assert.equal(boundCameraPose(viewer, { ...HOME_VIEW, alt: 100 }).alt, 1750);
  assert.equal(Cesium.Cartesian3.equals(before, terrainTarget), true); assert.ok(picks > 0 && heightReads > 0);
  assert.equal(applyNativeCameraLimits(viewer).minimumClearance, 250); assert.equal(viewer.scene.screenSpaceCameraController.minimumZoomDistance, CAMERA_POLICY.minimumClearance);
});

test('portrait resizing reframes a wide globe while local resizing retains its exact pivot and range', () => {
  const globe = viewerAt(); setCameraView(globe, frameCameraOrbit(globe, { pitch: -45 }).view);
  const target = captureCameraOrbit(globe).target;
  globe.canvas.clientWidth = 390; globe.canvas.clientHeight = 844; globe.camera.frustum.aspectRatio = 390 / 844;
  setCameraView(globe, resizedCameraView(globe)); sameTarget(globe, target); assert.equal(wholeGlobeVisible(globe), true);
  const local = viewerAt(); setCameraView(local, { ...HOME_VIEW, lat: -33.86, lon: 151.2, alt: 90000 });
  setCameraView(local, frameCameraOrbit(local, { pitch: -45 }).view); const before = captureCameraOrbit(local);
  local.canvas.clientWidth = 390; local.canvas.clientHeight = 844; local.camera.frustum.aspectRatio = 390 / 844;
  setCameraView(local, resizedCameraView(local)); const after = sameTarget(local, before.target);
  near(after.range, before.range, .001); near(after.pitch, -45);
});

test('actual camera links retain their pose and historical clock semantics after a target-centered control', () => {
  const viewer = viewerAt(); setCameraView(viewer, { ...HOME_VIEW, lat: 50.85, lon: 4.35, alt: 30000 });
  setCameraView(viewer, frameCameraOrbit(viewer, { pitch: -45, heading: 120 }).view);
  const before = cameraView(viewer), temporal = { mode: 'history', at: '2025-11-15T12:00:00.123Z', lens: 'known-then', rate: 60 };
  const parsed = parseViewHash(serializeViewHash(before, [], {}, temporal), []);
  assert.deepEqual(parsed.temporal, temporal); assert.deepEqual(parsed.layers, []);
  setCameraView(viewer, parsed.view); const restored = cameraView(viewer);
  near(restored.lat, before.lat, .00002); near(restored.lon, before.lon, .00002); near(restored.alt, before.alt, 1);
  near(restored.pitch, before.pitch, .02); near(restored.heading, before.heading, .02);
  assert.throws(() => boundCameraPose(viewer, { ...HOME_VIEW, lon: NaN }), TypeError);
  assert.throws(() => zoomCameraView(viewer, 0), TypeError);
});

test('near-nadir camera pose extraction preserves the native direction and ground hit despite coarse Cesium convenience getters', () => {
  const viewer = viewerAt(); setCameraView(viewer, { ...HOME_VIEW, lat: -21, lon: -179.99, pitch: 0 });
  setCameraView(viewer, frameCameraOrbit(viewer, { pitch: -90 }).view);
  const before = captureCameraOrbit(viewer).target, direction = Cesium.Cartesian3.clone(viewer.camera.directionWC), up = Cesium.Cartesian3.clone(viewer.camera.upWC);
  const pose = cameraView(viewer);
  assert.ok(pose.pitch < -89 && pose.pitch > -90, 'WGS84 surface-normal orbit and camera-position ENU differ slightly at global range');
  setCameraView(viewer, pose); sameTarget(viewer, before);
  assert.equal(Cesium.Cartesian3.equalsEpsilon(viewer.camera.directionWC, direction, 1e-10), true);
  assert.equal(Cesium.Cartesian3.equalsEpsilon(viewer.camera.upWC, up, 1e-10), true);
});
