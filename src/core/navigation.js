import * as Cesium from 'cesium';
import { HOME_VIEW, PLACES, resolvePlace } from './navigation-state.js';
export { HOME_VIEW, PLACES, resolvePlace, parseViewHash, serializeViewHash } from './navigation-state.js';

export function cameraView(viewer) {
  const camera = viewer.camera;
  const position = camera.positionCartographic;
  return {
    lat: Cesium.Math.toDegrees(position.latitude), lon: Cesium.Math.toDegrees(position.longitude), alt: position.height,
    heading: Cesium.Math.toDegrees(camera.heading), pitch: Cesium.Math.toDegrees(camera.pitch), roll: Cesium.Math.toDegrees(camera.roll),
  };
}

export function setCameraView(viewer, view, animate = false) {
  viewer.trackedEntity = undefined;
  viewer.camera.cancelFlight();
  const options = {
    destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.alt),
    orientation: { heading: Cesium.Math.toRadians(view.heading || 0), pitch: Cesium.Math.toRadians(view.pitch ?? -90), roll: Cesium.Math.toRadians(view.roll || 0) },
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
  bind('home', () => setCameraView(viewer, HOME_VIEW, true));
  bind('north', () => setCameraView(viewer, { ...cameraView(viewer), heading: 0, roll: 0 }, true));
  for (const [id, direction] of [['zoom-in', 1], ['zoom-out', -1]]) bind(id, () => {
    viewer.trackedEntity = undefined;
    const view = cameraView(viewer);
    const distance = Math.max(100, view.alt * .35);
    if (direction === 1) viewer.camera.zoomIn(distance);
    else viewer.camera.zoomOut(distance);
    viewer.scene.requestRender();
    updateReadout();
  });
  bind('tilt', () => {
    const view = cameraView(viewer);
    setCameraView(viewer, { ...view, pitch: view.pitch < -65 ? -45 : -90 }, true);
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
    if (!place) { status.textContent = 'Choose a saved place from the suggestions, or enter latitude, longitude.'; return; }
    status.textContent = '';
    if (onPlace(place) !== true) setCameraView(viewer, { ...HOME_VIEW, lat: place.lat, lon: place.lon, alt: 90000 }, true);
  };
  form.addEventListener('submit', submit);
  cleanup.push(() => form.removeEventListener('submit', submit));
  const updateReadout = () => {
    const view = cameraView(viewer);
    document.getElementById('view-position').textContent = `${Math.abs(view.lat).toFixed(3)}° ${view.lat >= 0 ? 'N' : 'S'}  ·  ${Math.abs(view.lon).toFixed(3)}° ${view.lon >= 0 ? 'E' : 'W'}  ·  ${view.alt >= 1000 ? `${(view.alt / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` : `${Math.round(view.alt)} m`} altitude`;
    document.getElementById('tilt').setAttribute('aria-pressed', String(view.pitch > -65));
    onViewChange(view);
  };
  cleanup.push(viewer.camera.moveEnd.addEventListener(updateReadout));
  updateReadout();
  return () => cleanup.splice(0).reverse().forEach((dispose) => dispose());
}
