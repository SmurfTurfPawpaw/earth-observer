import * as Cesium from 'cesium';
import { isPickedWorldPosition } from '../data/scenePick.js';

/** Resolve a normalized screen point without loading the annotation/search subsystem. */
export function pickWorldFromScreen(viewer, nx, ny) {
  const scene = viewer?.scene;
  if (!scene || !Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (!width || !height) return null;
  const point = new Cesium.Cartesian2(Math.max(0, Math.min(1, nx)) * width, Math.max(0, Math.min(1, ny)) * height);
  let position;
  if (scene.pickPositionSupported) {
    try { position = scene.pickPosition(point); } catch {}
  }
  if (!isPickedWorldPosition(position)) {
    try { position = viewer.camera.pickEllipsoid(point, Cesium.Ellipsoid.WGS84); } catch {}
  }
  if (!isPickedWorldPosition(position)) {
    try {
      const ray = viewer.camera.getPickRay(point);
      position = ray ? scene.globe?.pick(ray, scene) : null;
    } catch {}
  }
  if (!isPickedWorldPosition(position)) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(position);
  return cartographic ? { lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude), height: cartographic.height || 0 } : null;
}
