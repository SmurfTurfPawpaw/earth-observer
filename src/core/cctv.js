import { createStagedPointEdition } from './point-editions.js';
import * as Cesium from 'cesium';
import { inLocalArea, validateArea } from './local-area.js';

/** Approved still-image cameras represented by selectable points, without video/projection machinery. */
export function createCamerasLayer({ fetchImpl = (...args) => fetch(...args), documentRef = globalThis.document } = {}) {
  let viewer, edition, request;
  let localArea;
  let enabled = false, count = 0, lastUpdate = null, error = null, attributions = [];
  let coverage = null, stale = false, degraded = false, retrievedAt = null, status = null;
  return {
    id: 'cctv',
    updateInterval: 300000,
    setLocalArea(value) {
      const next = validateArea(value);
      if (JSON.stringify(next) === JSON.stringify(localArea)) return;
      request?.abort(); request = null;
      localArea = next;
      // A last-good catalog belongs to its original scope. It cannot describe
      // the new area while a replacement is loading or unavailable.
      edition?.clear();
      count = 0; lastUpdate = null; error = null; attributions = [];
      coverage = null; stale = false; degraded = false; retrievedAt = null; status = null;
      viewer?.scene?.requestRender();
    },
    init(nextViewer) {
      viewer = nextViewer;
      edition = createStagedPointEdition({ viewer, name: 'public-cameras' });
    },
    enable() { enabled = true; edition.setVisible(true); },
    disable() {
      enabled = false; request?.abort(); request = null;
      edition?.setVisible(false);
    },
    async update(_viewer, { signal, work } = {}) {
      if (!enabled || documentRef?.hidden || signal?.aborted) return false;
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const area = localArea;
      const query = area ? '?' + new URLSearchParams({ lat: String(area.lat), lon: String(area.lon), radiusKm: String(area.radiusKm) }) : '';
      try {
        const response = await fetchImpl('/api/cctv/sources' + query, { signal: combined });
        if (!response.ok) throw new Error(`Camera catalog HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.sources)) throw new Error('Camera catalog is invalid');
        combined.throwIfAborted();
        if (!enabled || request !== controller) return false;
        const seen = new Set();
        const credits = new Set(), nextAttributions = [];
        const nextStatus = payload.coverage?.status || null;
        const nextCoverage = typeof payload.coverage?.note === 'string' ? payload.coverage.note : null;
        const times = (Array.isArray(payload.providers) ? payload.providers : []).map(provider => Date.parse(provider.retrievedAt)).filter(Number.isFinite);
        const nextRetrievedAt = times.length ? Math.min(...times) : null;
        return await edition.stage(payload.sources.slice(0, 4000), camera => {
          if (!camera.id || seen.has(camera.id) || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lon) || Math.abs(camera.lat) > 90 || Math.abs(camera.lon) > 180) return null;
          seen.add(camera.id);
          if (!inLocalArea(camera.lat, camera.lon, area)) return null;
          const credit = camera.credit || camera.license;
          if (credit && !credits.has(credit)) { credits.add(credit); nextAttributions.push(credit); }
          return {
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
          };
        }, { signal: combined, work,
          isCurrent: () => enabled && !documentRef?.hidden && request === controller && area === localArea,
          commit(next) {
            count = next.count; lastUpdate = Date.now(); status = nextStatus;
            error = status === 'unavailable' ? 'Camera catalogs are unavailable for this area' : null;
            coverage = nextCoverage; stale = payload.stale === true; degraded = payload.degraded === true;
            retrievedAt = nextRetrievedAt; attributions = nextAttributions;
          },
        });
      } catch (failure) {
        if (combined.aborted || !enabled || documentRef?.hidden || request !== controller || area !== localArea) return false;
        error = failure.message || 'Camera catalog unavailable';
        stale = count > 0; degraded = true;
        status = stale ? 'stale' : 'unavailable';
        coverage = stale
          ? 'Camera catalog refresh failed; showing earlier reviewed camera records.'
          : 'Camera catalog is temporarily unavailable.';
        // Keep the prior provider retrieval date when retaining this same
        // scope's records; failure is not a successful source refresh.
        return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count, lastUpdate, error, coverage, stale, degraded, status,
      sourceAgeMs: retrievedAt === null ? null : Math.max(0, Date.now() - retrievedAt), editionMetrics: edition?.getMetrics() || null }),
    getRowControls: () => ({ info: `${coverage ? coverage + ' ' : ''}Select a camera point to open its latest still image.${attributions.length ? ` Sources: ${attributions.join(' · ')}.` : ''}` }),
    destroy() {
      enabled = false; request?.abort(); request = null;
      edition?.destroy(); edition = null; viewer = null; count = 0;
    },
  };
}
