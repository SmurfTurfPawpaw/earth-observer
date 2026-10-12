import * as Cesium from 'cesium';
import { HOME_VIEW, PLACES, resolvePlace } from './navigation-state.js';
import { viewerGlobeAltitude } from './globe-framing.js';
import { applyNativeCameraLimits, boundCameraPose, captureCameraOrbit, orbitCameraView, readCameraPose, resizedCameraView, zoomCameraView } from './camera-policy.js';
export { HOME_VIEW, PLACES, resolvePlace, parseViewHash, serializeViewHash } from './navigation-state.js';

export function cameraView(viewer) {
  return readCameraPose(viewer);
}

export function setCameraView(viewer, view, animate = false) {
  const pose = boundCameraPose(viewer, view);
  viewer.trackedEntity = undefined;
  viewer.camera.cancelFlight();
  const options = {
    destination: Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.alt, viewer.scene.globe.ellipsoid),
    orientation: { heading: Cesium.Math.toRadians(pose.heading), pitch: Cesium.Math.toRadians(pose.pitch), roll: Cesium.Math.toRadians(pose.roll) },
    endTransform: Cesium.Matrix4.IDENTITY,
    duration: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 1.3,
  };
  if (animate) viewer.camera.flyTo(options);
  else viewer.camera.setView(options);
  viewer.scene.requestRender();
}

/** Own DOM handlers and camera listeners, with one disposer for reloads. */
export function installNavigation(viewer, { onPlace = () => {}, onViewChange = () => {} } = {}) {
  const cleanup = [];
  const bind = (id, handler) => {
    const button = document.getElementById(id);
    button.addEventListener('click', handler);
    cleanup.push(() => button.removeEventListener('click', handler));
  };
  const showGlobe = () => setCameraView(viewer, { ...HOME_VIEW, alt: viewerGlobeAltitude(viewer) }, true);
  bind('home', showGlobe);
  bind('north', () => setCameraView(viewer, orbitCameraView(viewer, { heading: 0, roll: 0 }), true));
  for (const [id, direction] of [['zoom-in', 1], ['zoom-out', -1]]) bind(id, () => {
    setCameraView(viewer, zoomCameraView(viewer, direction));
    updateReadout();
  });
  bind('tilt', () => {
    const orbit = captureCameraOrbit(viewer);
    setCameraView(viewer, orbitCameraView(viewer, { pitch: orbit.pitch <= -89.5 ? -45 : -90 }), true);
  });
  const search = document.getElementById('search');
  const form = document.getElementById('search-form');
  const suggestions = document.getElementById('place-suggestions');
  suggestions.replaceChildren(...PLACES.map((place) => {
    const option = document.createElement('option'); option.value = place.name; return option;
  }));
  const submit = (event) => {
    event.preventDefault();
    const place = resolvePlace(search.value);
    const status = document.getElementById('search-status');
    if (!place) { status.textContent = 'Choose a supported place from the suggestions, or enter latitude, longitude.'; return; }
    status.textContent = '';
    if (onPlace(place) !== true) setCameraView(viewer, { ...HOME_VIEW, lat: place.lat, lon: place.lon, alt: 90000 }, true);
  };
  form.addEventListener('submit', submit);
  cleanup.push(() => form.removeEventListener('submit', submit));
  const updateReadout = () => {
    const view = cameraView(viewer);
    document.getElementById('view-position').textContent = `${Math.abs(view.lat).toFixed(3)}° ${view.lat >= 0 ? 'N' : 'S'}  ·  ${Math.abs(view.lon).toFixed(3)}° ${view.lon >= 0 ? 'E' : 'W'}  ·  ${view.alt >= 1000 ? `${(view.alt / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` : `${Math.round(view.alt)} m`} altitude`;
    document.getElementById('tilt').setAttribute('aria-pressed', String(captureCameraOrbit(viewer).pitch > -89.5));
    onViewChange(view);
  };
  cleanup.push(viewer.camera.moveEnd.addEventListener(updateReadout));
  const resize = () => {
    applyNativeCameraLimits(viewer);
    setCameraView(viewer, resizedCameraView(viewer));
  };
  window.addEventListener('resize', resize);
  cleanup.push(() => window.removeEventListener('resize', resize));
  updateReadout();
  return () => cleanup.splice(0).reverse().forEach((dispose) => dispose());
}
