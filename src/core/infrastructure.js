import * as Cesium from 'cesium';
import { stageEntities, replaceEntities } from './entity-batches.js';

/** Static mapped locations; outline geometries become explicitly approximate points. */
export function createInfrastructureLayer({ id, source, documentRef = globalThis.document } = {}) {
  if (!['local-datacenters', 'local-dams'].includes(id) || !source?.getRecords) throw new TypeError('An infrastructure layer and record source are required');
  const dams = id === 'local-dams';
  const title = dams ? 'Dam' : 'Datacenter';
  const sourceName = dams ? 'Open Infrastructure Map / OpenStreetMap' : 'OpenStreetMap';
  const credit = `${dams ? 'Open Infrastructure Map · ' : ''}© OpenStreetMap contributors · ODbL`;
  const coverage = 'Bundled mapped locations; completeness varies. Outline features use an approximate representative point.';
  let viewer, dataSource, request, onChange;
  let enabled = false, loaded = false, count = 0, approximateCount = 0, lastUpdate = null, error = null;
  return {
    id, updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(id); dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },
    enable() { enabled = true; dataSource.show = true; },
    disable() {
      enabled = false; request?.abort(); request = null;
      if (dataSource) dataSource.show = false;
      if (String(viewer?.selectedEntity?.id || '').startsWith(`${id}:`)) viewer.selectedEntity = undefined;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || documentRef?.hidden || signal?.aborted) return false;
      if (loaded) return false; // The bundled dataset and existing entity set are immutable.
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const records = await source.getRecords(id, { signal: combined });
        combined.throwIfAborted();
        if (!Array.isArray(records)) throw new Error('Infrastructure records are invalid');
        const valid = records.filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lon) && Math.abs(record.lat) <= 90 && Math.abs(record.lon) <= 180);
        const identities = new Map();
        const entities = await stageEntities(valid, (record) => {
          const key = String(record.id);
          const ordinal = identities.get(key) || 0; identities.set(key, ordinal + 1);
          return new Cesium.Entity({
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
          });
        }, combined);
        combined.throwIfAborted();
        if (!enabled || documentRef?.hidden || request !== controller) return false;
        replaceEntities(dataSource.entities, entities);
        loaded = true; count = entities.length; approximateCount = valid.filter((record) => record.approximate).length;
        lastUpdate = Date.now(); error = null;
        viewer.scene.requestRender(); onChange?.(); return true;
      } catch (failure) {
        if (combined.aborted || !enabled || documentRef?.hidden) return false;
        error = failure.message || 'Infrastructure locations unavailable'; onChange?.(); return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count, lastUpdate, mode: 'bundled', coverage, source: sourceName, error }),
    getRowControls: () => ({ info: `${coverage}${loaded ? ` ${approximateCount.toLocaleString()} approximate points.` : ''} Select a point for available source details.` }),
    setRowControlsListener(listener) { onChange = listener; },
    getParams: () => ({}),
    destroy() {
      enabled = false; request?.abort(); request = null; onChange = null;
      if (dataSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(dataSource, true);
      viewer = null; dataSource = null; loaded = false; count = 0; approximateCount = 0;
    },
  };
}
