import { stageEntities, replaceEntities } from './entity-batches.js';
import * as Cesium from 'cesium';
import { inLocalArea, validateArea } from './local-area.js';

/** Approved still-image cameras represented by selectable points, without video/projection machinery. */
export function createCamerasLayer({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let viewer, dataSource, request;
  let localArea;
  let enabled = false, count = 0, lastUpdate = null, error = null, attributions = [];
  return {
    id: 'cctv',
    updateInterval: 300000,
    setLocalArea(value) { localArea = validateArea(value); },
    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('public-cameras');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },
    enable() { enabled = true; dataSource.show = true; },
    disable() {
      enabled = false; request?.abort(); request = null;
      if (dataSource) dataSource.show = false;
      if (viewer?.selectedEntity?.properties?.cameraId) viewer.selectedEntity = undefined;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const response = await fetchImpl('/api/cctv/sources', { signal: combined });
        if (!response.ok) throw new Error(`Camera catalog HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.sources)) throw new Error('Camera catalog is invalid');
        combined.throwIfAborted();
        if (!enabled || request !== controller) return false;
        const seen = new Set();
        const valid = [];
        for (const camera of payload.sources.slice(0, 4000)) {
          if (!camera.id || seen.has(camera.id) || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lon) || Math.abs(camera.lat) > 90 || Math.abs(camera.lon) > 180) continue;
          seen.add(camera.id);
          if (!inLocalArea(camera.lat, camera.lon, localArea)) continue;
          valid.push(camera);
        }
        const entities = await stageEntities(valid, (camera) => new Cesium.Entity({
            id: `camera:${camera.id}`,
            name: String(camera.name || camera.id),
            position: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, 10),
            point: {
              pixelSize: 7,
              color: Cesium.Color.fromCssColorString('#93dfc5'),
              outlineColor: Cesium.Color.fromCssColorString('#102c25'),
              outlineWidth: 2,
            },
            properties: {
              cameraId: String(camera.id),
              frameUrl: `/api/cctv/frame/${encodeURIComponent(camera.id)}`,
              provider: String(camera.provider || ''),
              location: String(camera.city || ''),
              attribution: String(camera.license || ''),
              credit: String(camera.credit || ''),
              media: 'Latest available still image',
            },
          }), combined);
        if (!enabled || request !== controller) return false;
        replaceEntities(dataSource.entities, entities);
        count = entities.length; lastUpdate = Date.now(); error = null;
        attributions = [...new Set(payload.sources.map((camera) => camera.credit || camera.license).filter(Boolean))];
        viewer.scene.requestRender();
        return true;
      } catch (failure) {
        if (combined.aborted) return false;
        error = failure.message || 'Camera catalog unavailable';
        return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count, lastUpdate, error }),
    getRowControls: () => ({ info: `Select a camera point to open its latest still image.${attributions.length ? ` Sources: ${attributions.join(' · ')}.` : ''}` }),
    destroy() {
      enabled = false; request?.abort(); request = null;
      if (dataSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(dataSource, true);
      dataSource = null; viewer = null; count = 0;
    },
  };
}
