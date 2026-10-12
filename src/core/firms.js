import { createStagedPointEdition } from './point-editions.js';
import * as Cesium from 'cesium';

const MAX_RENDERED_DETECTIONS = 20000;
function acquisitionTime(record) {
  const day = typeof record.acqDate === 'string' ? record.acqDate : '';
  const time = String(record.acqTime ?? '').padStart(4, '0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}$/.test(time)) return null;
  const epoch = Date.parse(`${day}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
  return Number.isFinite(epoch) ? epoch : null;
}

/** Archived detections retain their acquisition dates; they are never promoted to live data. */
export function normalizeFireDetections(payload) {
  if (!Array.isArray(payload?.fires)) throw new Error('Fire detections are invalid');
  const seen = new Set();
  const records = [];
  for (const record of payload.fires) {
    if (!record || !Number.isFinite(record.lat) || !Number.isFinite(record.lon) || Math.abs(record.lat) > 90 || Math.abs(record.lon) > 180) continue;
    const observedAt = acquisitionTime(record);
    const id = [record.lat, record.lon, record.acqDate, record.acqTime, record.satellite, record.instrument].join(':');
    if (seen.has(id)) continue;
    seen.add(id); records.push({ ...record, id, observedAt });
  }
  const totalCount = records.length;
  if (records.length > MAX_RENDERED_DETECTIONS) records.sort((a, b) => (Number(b.frp) || 0) - (Number(a.frp) || 0));
  return { records: records.slice(0, MAX_RENDERED_DETECTIONS), totalCount };
}

export function createFireDetectionsLayer({ source, documentRef = globalThis.document } = {}) {
  let viewer, edition, request, onChange;
  let enabled = false, lastUpdate = null, observedAtMs = null, error = null, warning = null;
  let records = [], totalCount = 0, snapshot = false, stale = false, observationDate = null, coverage = null, mode = null;
  return {
    id: 'local-firms', updateInterval: 1800000,
    init(nextViewer) {
      viewer = nextViewer;
      edition = createStagedPointEdition({ viewer, name: 'NASA-FIRMS-detections' });
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
      try {
        const payload = await source.getSnapshot({ signal: combined });
        combined.throwIfAborted();
        if (!enabled || documentRef?.hidden || request !== controller) return false;
        if (payload.keyRequired) throw new Error('FIRMS source is not configured');
        const normalized = normalizeFireDetections(payload);
        combined.throwIfAborted();
        if (!enabled || request !== controller) return false;
        const nextSnapshot = payload.snapshot === true;
        let nextCoverage = payload.coverage || (nextSnapshot ? 'Archived sample only; not current or comprehensive global fire coverage' : 'NASA FIRMS detections from the trailing 24 hours');
        if (normalized.records.length < normalized.totalCount) nextCoverage += ` · showing the ${normalized.records.length.toLocaleString()} detections with greatest reported radiative power out of ${normalized.totalCount.toLocaleString()}`;
        const nextObservationDate = nextSnapshot ? String(payload.observationDate || normalized.records.find(record => record.acqDate)?.acqDate || '') : null;
        let latestObservation = null;
        const published = await edition.stage(normalized.records, (record) => {
          if (record.observedAt !== null) latestObservation = Math.max(latestObservation || 0, record.observedAt);
          return {
            id: `firms:${record.id}`,
            name: `NASA FIRMS · ${record.acqDate || 'Date unspecified'}`,
            position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 10),
            point: { pixelSize: 7, color: Cesium.Color.fromCssColorString('#dfae73'),
              outlineColor: Cesium.Color.fromCssColorString('#382b1d'), outlineWidth: 1 },
            properties: {
              observationType: 'Satellite active-fire / thermal-anomaly detection',
              dataMode: nextSnapshot ? 'Archived sample; not current conditions' : 'NASA FIRMS near real-time detections',
              acquiredAt: record.observedAt === null ? 'Unspecified' : new Date(record.observedAt).toISOString(),
              satellite: String(record.satellite || ''), instrument: String(record.instrument || ''),
              confidence: String(record.confidence ?? ''),
              ...(Number.isFinite(record.frp) ? { fireRadiativePowerMW: record.frp } : {}),
              ...(Number.isFinite(record.brightness) ? { brightnessTemperatureK: record.brightness } : {}),
              dayOrNight: record.daynight === 'D' ? 'Day' : record.daynight === 'N' ? 'Night' : 'Unspecified',
              source: 'NASA FIRMS', sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/',
            },
          };
        }, { signal: combined, work,
          isCurrent: () => enabled && !documentRef?.hidden && request === controller,
          commit() {
            records = normalized.records; totalCount = normalized.totalCount;
            snapshot = nextSnapshot; stale = snapshot || payload.stale === true;
            observationDate = nextObservationDate;
            mode = payload.mode || (snapshot ? 'archived-sample' : 'live');
            observedAtMs = Number.isFinite(payload.lastObservationAt) ? payload.lastObservationAt : latestObservation;
            coverage = nextCoverage;
            lastUpdate = Date.now(); error = null; warning = null;
          },
        });
        if (published) onChange?.(); return published;
      } catch (failure) {
        if (combined.aborted || !enabled || documentRef?.hidden || request !== controller) return false;
        if (snapshot && records.length) warning = 'Refresh unavailable; the dated archive remains displayed.';
        else error = failure.message || 'Fire detections unavailable';
        if (!snapshot && records.length) stale = true;
        onChange?.(); return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count: records.length, totalCount, lastUpdate, refreshedAt: lastUpdate,
      observedAtMs, ageMs: observedAtMs === null ? null : Math.max(0, Date.now() - observedAtMs),
      snapshot, stale, observationDate, coverage, mode, source: 'NASA FIRMS', error, warning,
      editionMetrics: edition?.getMetrics() || null }),
    getRowControls: () => ({
      info: [coverage, warning].filter(Boolean).join(' · '),
      chips: [{ label: 'View detections', disabled: records.length === 0, params: { focusDetections: true } }],
    }),
    setRowControlsListener(listener) { onChange = listener; },
    setParams({ focusDetections } = {}) {
      if (!focusDetections || !enabled || !records.length) return;
      const extent = Cesium.Rectangle.fromCartographicArray(records.map((record) => Cesium.Cartographic.fromDegrees(record.lon, record.lat)));
      viewer.camera.flyTo({ destination: extent, duration: 1 });
    },
    getParams: () => ({}),
    destroy() {
      enabled = false; request?.abort(); request = null; onChange = null;
      edition?.destroy();
      records = []; totalCount = 0; viewer = null; edition = null;
    },
  };
}
