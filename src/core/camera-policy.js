import * as Cesium from 'cesium';
import { viewerGlobeAltitude } from './globe-framing.js';

// Temporary close-navigation floor. Codec/terrain clearance acceptance must
// change with this value before the original one-metre capability is restored.
export const CAMERA_POLICY = Object.freeze({ minimumClearance: 250, maximumFill: .65, globePadding: 1.03, zoomIn: .65, zoomOut: 1.35 });
const finitePoint = point => point && ['x', 'y', 'z'].every(key => Number.isFinite(point[key]));
const viewport = viewer => ({ width: viewer.canvas.clientWidth || viewer.canvas.width || 1280,
  height: viewer.canvas.clientHeight || viewer.canvas.height || 800 });
const ellipsoidFor = viewer => viewer.scene.globe.ellipsoid || Cesium.Ellipsoid.WGS84;
const normalizeHeading = degrees => (degrees % 360 + 360) % 360;

export function cameraLimits(viewer) {
  return Object.freeze({ minimumClearance: CAMERA_POLICY.minimumClearance, maximumAltitude: viewerGlobeAltitude(viewer, CAMERA_POLICY.maximumFill) });
}
export function applyNativeCameraLimits(viewer) {
  const limits = cameraLimits(viewer), controller = viewer.scene.screenSpaceCameraController;
  if (controller) { controller.minimumZoomDistance = limits.minimumClearance; controller.maximumZoomDistance = limits.maximumAltitude; }
  return limits;
}
export function readCameraPose(viewer) {
  const camera = viewer.camera, position = camera.positionCartographic;
  const ellipsoid = viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC, ellipsoid);
  const { direction, up, right } = orientationInFrame(camera, frame);
  const horizontal = Math.hypot(direction.x, direction.y);
  // Cesium's convenience getters deliberately treat ~2.5 degrees as vertical.
  // Serialized poses need the real basis, or near-nadir restore can shift its hit.
  const heading = horizontal > 1e-10 ? Math.atan2(direction.x, direction.y) : Math.atan2(up.x, up.y);
  const roll = horizontal > 1e-10 ? Math.atan2(-right.z, up.z) : 0;
  return { lat: Cesium.Math.toDegrees(position.latitude), lon: Cesium.Math.toDegrees(position.longitude), alt: position.height,
    heading: normalizeHeading(Cesium.Math.toDegrees(heading)), pitch: Cesium.Math.toDegrees(Math.asin(Cesium.Math.clamp(direction.z, -1, 1))),
    roll: Cesium.Math.toDegrees(roll) };
}
function orientationInFrame(camera, frame) {
  const inverse = Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4());
  const transform = value => Cesium.Matrix4.multiplyByPointAsVector(inverse, value, new Cesium.Cartesian3());
  return { direction: transform(camera.directionWC), up: transform(camera.upWC), right: transform(camera.rightWC) };
}
function minimumHeight(viewer, position) {
  // Read already available terrain only: this policy never starts sampling or IO.
  const ground = viewer.scene.globe.getHeight?.(position);
  return Math.max(CAMERA_POLICY.minimumClearance, Number.isFinite(ground) ? ground + CAMERA_POLICY.minimumClearance : CAMERA_POLICY.minimumClearance);
}
export function boundCameraPose(viewer, view) {
  const pose = { ...view, heading: view.heading ?? 0, pitch: view.pitch ?? -90, roll: view.roll ?? 0 };
  if (!['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'].every(key => Number.isFinite(pose[key])) || Math.abs(pose.lat) > 90 || Math.abs(pose.lon) > 180)
    throw new TypeError('Use a finite geographic camera pose');
  const position = Cesium.Cartographic.fromDegrees(pose.lon, pose.lat, pose.alt);
  return { ...pose, alt: Math.min(cameraLimits(viewer).maximumAltitude, Math.max(pose.alt, minimumHeight(viewer, position))) };
}

/** The center hit is a derived display anchor; reported source coordinates and
 * serialized camera positions remain independent. No hit falls back to the
 * current pose's own nadir, never a default city or an unrelated previous view. */
export function captureCameraOrbit(viewer) {
  const camera = viewer.camera, ellipsoid = ellipsoidFor(viewer), { width, height } = viewport(viewer);
  let target, anchorKind = 'ellipsoid';
  try {
    const ray = camera.getPickRay(new Cesium.Cartesian2(width / 2, height / 2));
    const ground = ray && viewer.scene.globe.pick?.(ray, viewer.scene, new Cesium.Cartesian3());
    if (finitePoint(ground)) { target = Cesium.Cartesian3.clone(ground); anchorKind = 'available-ground'; }
    else if (ray) {
      const interval = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid);
      if (interval && interval.stop > 0) target = Cesium.Ray.getPoint(ray, Math.max(0, interval.start), new Cesium.Cartesian3());
    }
  } catch { /* Before surface resources exist, use the same pose's nadir. */ }
  if (!finitePoint(target) || Cesium.Cartesian3.magnitudeSquared(target) === 0) {
    const position = camera.positionCartographic;
    const ground = viewer.scene.globe.getHeight?.(position);
    target = ellipsoid.cartographicToCartesian(new Cesium.Cartographic(position.longitude, position.latitude, Number.isFinite(ground) ? ground : 0));
    anchorKind = 'pose-nadir';
  }
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(target, ellipsoid);
  const local = Cesium.Matrix4.multiplyByPoint(Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4()), camera.positionWC, new Cesium.Cartesian3());
  const range = Cesium.Cartesian3.magnitude(local);
  if (!Number.isFinite(range) || range <= 0) throw new TypeError('Camera must remain above its surface target');
  const { up, right } = orientationInFrame(camera, frame), vertical = Math.hypot(local.x, local.y) < range * 1e-10;
  const heading = Cesium.Math.toDegrees(vertical ? Math.atan2(up.x, up.y) : Math.atan2(-local.x, -local.y));
  return Object.freeze({ target: Object.freeze(target), anchorKind, range, heading: normalizeHeading(heading),
    pitch: Cesium.Math.toDegrees(-Math.asin(Cesium.Math.clamp(local.z / range, -1, 1))), roll: vertical ? 0 : Cesium.Math.toDegrees(Math.atan2(-right.z, up.z)) });
}

function orbitCamera(viewer) {
  const camera = new Cesium.Camera(viewer.scene), { width, height } = viewport(viewer);
  camera.frustum = viewer.camera.frustum.clone(); camera.frustum.aspectRatio = width / height;
  return camera;
}
function aim(camera, target, heading, pitch, range, roll) {
  camera.lookAt(target, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), range));
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  // Roll is about the completed look direction and cannot move the surface pivot.
  if (roll) {
    const rotation = Cesium.Matrix3.fromQuaternion(Cesium.Quaternion.fromAxisAngle(camera.directionWC, Cesium.Math.toRadians(roll)));
    Cesium.Matrix3.multiplyByVector(rotation, camera.up, camera.up);
    Cesium.Cartesian3.cross(camera.direction, camera.up, camera.right);
  }
}
function containsGlobe(camera, ellipsoid) {
  return camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC)
    .computeVisibility(new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, ellipsoid.maximumRadius * CAMERA_POLICY.globePadding)) === Cesium.Intersect.INSIDE;
}

/** Calculate a target-centered orbit using a CPU-only native camera. At a range
 * where the full globe fits top-down, keep it within the real viewport planes.
 * Local requested angles are left intact. This does not mutate the live camera. */
export function frameCameraOrbit(viewer, change = {}) {
  const captured = captureCameraOrbit(viewer), camera = orbitCamera(viewer), ellipsoid = ellipsoidFor(viewer), limits = cameraLimits(viewer);
  const heading = change.heading ?? captured.heading, requestedPitch = change.pitch ?? captured.pitch, roll = change.roll ?? captured.roll;
  if (![heading, requestedPitch, roll, change.range ?? captured.range].every(Number.isFinite) || requestedPitch < -90 || requestedPitch > 0)
    throw new TypeError('Use a finite downward camera orbit');
  let range = Cesium.Math.clamp(change.range ?? captured.range, limits.minimumClearance, limits.maximumAltitude), pitch = requestedPitch;
  const assign = () => aim(camera, captured.target, heading, pitch, range, roll);
  assign();
  if (camera.positionCartographic.height < minimumHeight(viewer, camera.positionCartographic)) {
    let low = range, high = limits.maximumAltitude;
    for (let index = 0; index < 28; index++) {
      range = (low + high) / 2; assign();
      if (camera.positionCartographic.height < minimumHeight(viewer, camera.positionCartographic)) low = range; else high = range;
    }
    range = high; assign();
  }
  const wantedFits = containsGlobe(camera, ellipsoid);
  if (!wantedFits) {
    pitch = -90; assign();
    if (containsGlobe(camera, ellipsoid)) {
      let visible = -90, clipped = requestedPitch;
      for (let index = 0; index < 24; index++) {
        pitch = (visible + clipped) / 2; assign();
        if (containsGlobe(camera, ellipsoid)) visible = pitch; else clipped = pitch;
      }
      // Stay just inside the accepted plane after the public pose is converted
      // back through Cesium Euler angles and serialized decimal camera fields.
      pitch = Math.max(-90, visible - .05); assign();
    } else { pitch = requestedPitch; assign(); }
  }
  return Object.freeze({ view: Object.freeze(readCameraPose({ camera, scene: viewer.scene })), target: captured.target, anchorKind: captured.anchorKind,
    requestedPitch, appliedPitch: pitch, range, globeFramed: containsGlobe(camera, ellipsoid) });
}
export const orbitCameraView = (viewer, change) => frameCameraOrbit(viewer, change).view;
export function zoomCameraView(viewer, direction) {
  if (![1, -1].includes(direction)) throw new TypeError('Choose a camera zoom direction');
  const orbit = captureCameraOrbit(viewer);
  return orbitCameraView(viewer, { range: orbit.range * (direction === 1 ? CAMERA_POLICY.zoomIn : CAMERA_POLICY.zoomOut) });
}

/** Resizing a wide globe may need a longer range on portrait screens. Narrow
 * regional views keep their pivot/range and are subject only to common bounds. */
export function resizedCameraView(viewer) {
  const orbit = captureCameraOrbit(viewer), ellipsoid = ellipsoidFor(viewer);
  const wide = orbit.range >= ellipsoid.maximumRadius * 2;
  return orbitCameraView(viewer, { range: wide ? Math.max(orbit.range, viewerGlobeAltitude(viewer)) : orbit.range });
}
