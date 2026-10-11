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
