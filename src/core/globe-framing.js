import { BoundingSphere, Camera, Cartesian3, Intersect, Math as CesiumMath, Matrix4, Ray, IntersectionTests } from 'cesium';

const RADIUS = 6378137;
/** Perspective sphere fit, expressed as a fraction of the shorter viewport axis. */
export function globeFrameAltitude({ width = 1280, height = 800, fov = Math.PI / 3, radius = RADIUS, fill = .8 } = {}) {
  if (![width, height, fov, radius, fill].every(Number.isFinite) || width <= 0 || height <= 0 || fov <= 0 || fov >= Math.PI || radius <= 0 || fill <= 0 || fill >= 1) throw new TypeError('A finite globe framing geometry is required');
  const aspect = width / height;
  const verticalHalf = aspect > 1 ? Math.atan(Math.tan(fov / 2) / aspect) : fov / 2;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
  const angle = Math.atan(fill * Math.tan(Math.min(verticalHalf, horizontalHalf)));
  return Math.min(50000000, Math.max(250, radius / Math.sin(angle) - radius));
}
export function viewerGlobeAltitude(viewer, fill = .8) {
  return globeFrameAltitude({ width: viewer.canvas.clientWidth || viewer.canvas.width || 1280,
    height: viewer.canvas.clientHeight || viewer.canvas.height || 800,
    fov: viewer.camera.frustum.fov || Math.PI / 3,
    radius: viewer.scene.globe.ellipsoid?.maximumRadius || RADIUS, fill });
}

function restoredCamera(viewer, view) {
  const bounded = { ...view, alt: Math.min(view.alt, viewerGlobeAltitude(viewer, .65)) };
  // This is a CPU-only camera: validation never moves the live camera or starts a flight.
  const camera = new Camera(viewer.scene);
  camera.frustum = viewer.camera.frustum.clone();
  camera.frustum.aspectRatio = (viewer.canvas.clientWidth || viewer.canvas.width || 1280) /
    (viewer.canvas.clientHeight || viewer.canvas.height || 800);
  const ellipsoid = viewer.scene.globe.ellipsoid;
  const setPitch = (pitch) => camera.setView({
    destination: Cartesian3.fromDegrees(bounded.lon, bounded.lat, bounded.alt, ellipsoid),
    orientation: { heading: CesiumMath.toRadians(bounded.heading || 0), pitch: CesiumMath.toRadians(pitch), roll: CesiumMath.toRadians(bounded.roll || 0) },
    endTransform: Matrix4.IDENTITY,
  });
  setPitch(bounded.pitch ?? -90);
  return { view: bounded, camera, ellipsoid, setPitch };
}

/** Recover only a restored view whose entire Earth is outside the actual viewport. */
export function recoverInitialCameraView(viewer, view) {
  if (!viewer || viewer.isDestroyed?.()) return { view, recovered: false };
  const candidate = restoredCamera(viewer, view);
  const { camera, ellipsoid } = candidate;
  // An enclosing sphere is conservative: a partial/tilted view stays untouched.
  const visibility = camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC)
    .computeVisibility(new BoundingSphere(Cartesian3.ZERO, ellipsoid.maximumRadius));
  const recovered = visibility === Intersect.OUTSIDE;
  return { view: recovered ? { ...candidate.view, pitch: -90, roll: 0 } : candidate.view, recovered };
}

/** Keep the tilt button aimed at Earth at global heights; dragging stays unrestricted. */
export function visibleTiltCameraView(viewer, view) {
  if (!viewer || viewer.isDestroyed?.()) return view;
  const candidate = restoredCamera(viewer, view);
  const { camera, ellipsoid, setPitch } = candidate;
  const hitsEarth = () => {
    const interval = IntersectionTests.rayEllipsoid(new Ray(camera.positionWC, camera.directionWC), ellipsoid);
    return Boolean(interval && interval.stop > 0);
  };
  if (hitsEarth()) return candidate.view;
  let visible = -90, invisible = candidate.view.pitch ?? -90;
  for (let step = 0; step < 20; step++) {
    const pitch = (visible + invisible) / 2;
    setPitch(pitch);
    if (hitsEarth()) visible = pitch;
    else invisible = pitch;
  }
  // Aim inside the visible horizon rather than leaving the center ray tangent to it.
  return { ...candidate.view, pitch: Math.max(-90, visible - 4) };
}
