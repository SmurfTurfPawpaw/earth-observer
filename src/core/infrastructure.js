import * as Cesium from 'cesium';
import { createStagedPointEdition } from './point-editions.js';
import { inLocalArea, validateArea } from './local-area.js';

/** Static mapped locations; outline geometries become explicitly approximate points. */
export function createInfrastructureLayer({ id, source, documentRef = globalThis.document } = {}) {
  if (!['local-datacenters', 'local-dams'].includes(id) || !source?.getRecords) throw new TypeError('An infrastructure layer and record source are required');
  const dams = id === 'local-dams';
  const title = dams ? 'Dam' : 'Datacenter';
  const sourceName = dams ? 'Open Infrastructure Map / OpenStreetMap' : 'OpenStreetMap';
  const credit = `${dams ? 'Open Infrastructure Map · ' : ''}© OpenStreetMap contributors · ODbL`;
  const coverage = 'Bundled mapped locations; completeness varies. Outline features use an approximate representative point.';
  let viewer, edition, request, onChange;
  let localArea;
  let enabled = false, loaded = false, count = 0, approximateCount = 0, lastUpdate = null, error = null;
  return {
    id, updateInterval: 0,
    setLocalArea(value) {
      const next = validateArea(value);
      if (JSON.stringify(next) === JSON.stringify(localArea)) return;
      request?.abort(); request = null; localArea = next; loaded = false;
      edition?.clear(); count = 0; approximateCount = 0; lastUpdate = null; error = null;
    },
    init(nextViewer) {
      viewer = nextViewer;
      edition = createStagedPointEdition({ viewer, name: id });
    },
    enable() { enabled = true; edition.setVisible(true); },
    disable() {
      enabled = false; request?.abort(); request = null;
      edition?.setVisible(false);
    },
    async update(_viewer, { signal, work } = {}) {
      if (!enabled || documentRef?.hidden || signal?.aborted) return false;
      if (loaded) return false; // The bundled dataset and existing entity set are immutable.
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const area = localArea;
      try {
        const records = await source.getRecords(id, { signal: combined });
        combined.throwIfAborted();
        if (!Array.isArray(records)) throw new Error('Infrastructure records are invalid');
        const identities = new Map();
        let nextApproximateCount = 0;
        const published = await edition.stage(records, (record) => {
          if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon) || Math.abs(record.lat) > 90 || Math.abs(record.lon) > 180 || !inLocalArea(record.lat, record.lon, area)) return null;
          const key = String(record.id);
          const ordinal = identities.get(key) || 0; identities.set(key, ordinal + 1);
          if (record.approximate) ++nextApproximateCount;
          return {
            id: `${id}:${key}${ordinal ? `:part-${ordinal}` : ''}`,
            name: record.name || `${title} ${key}`,
            position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 0),
            point: { pixelSize: 6, color: Cesium.Color.fromCssColorString(dams ? '#82b5e6' : '#8ed3d4'),
              outlineColor: Cesium.Color.fromCssColorString('#162832'), outlineWidth: 1 },
            properties: {
              featureType: title, sourceRecordId: key,
              ...(record.operator ? { operator: record.operator } : {}),
              ...(record.capacity ? { reportedCapacity: record.capacity } : {}),
              ...(record.river ? { river: record.river } : {}),
              ...(record.output ? { reportedElectricityOutput: record.output } : {}),
              positionMeaning: record.approximate ? `Approximate representative point of the mapped ${record.geometryType || 'outline'}; not a surveyed point` : 'Mapped point location',
              displayHeight: 'At globe surface; source elevation is not provided',
              dataMode: 'Bundled location dataset; mapping date and completeness vary',
              source: sourceName, sourceUrl: 'https://www.openstreetmap.org/copyright', credit,
            },
          };
        }, { signal: combined, work,
          isCurrent: () => enabled && !documentRef?.hidden && request === controller && area === localArea,
          commit(next) {
            loaded = true; count = next.count; approximateCount = nextApproximateCount;
            lastUpdate = Date.now(); error = null;
          },
        });
        if (published) onChange?.(); return published;
      } catch (failure) {
        if (combined.aborted || !enabled || documentRef?.hidden || request !== controller || area !== localArea) return false;
        error = failure.message || 'Infrastructure locations unavailable'; onChange?.(); return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count, lastUpdate, mode: 'bundled', coverage, source: sourceName, error,
      editionMetrics: edition?.getMetrics() || null }),
    getRowControls: () => ({ info: `${coverage}${loaded ? ` ${approximateCount.toLocaleString()} approximate points.` : ''} Select a point for available source details.` }),
    setRowControlsListener(listener) { onChange = listener; },
    getParams: () => ({}),
    destroy() {
      enabled = false; request?.abort(); request = null; onChange = null;
      edition?.destroy(); edition = null;
      viewer = null; loaded = false; count = 0; approximateCount = 0;
    },
  };
}
