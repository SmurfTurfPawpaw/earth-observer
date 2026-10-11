import * as Cesium from 'cesium';

const text = (value) => typeof value === 'string' ? value.trim().slice(0, 1200) : '';
const coordinate = (value, limit) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
};

/** A launch pad is an observed place; its scheduled mission is not a vehicle track. */
export function normalizeLaunchRecords(payload) {
  const records = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(records)) throw new Error('Launch records are invalid');
  const seen = new Set();
  return records.slice(0, 500).flatMap((record) => {
    const id = text(record?.id);
    const pad = record?.pad;
    const longitude = coordinate(pad?.longitude, 180);
    const latitude = coordinate(pad?.latitude, 90);
    if (!id || seen.has(id) || longitude === null || latitude === null) return [];
    seen.add(id);
    const scheduledAt = Date.parse(record.net || record.window_start || '');
    return [{
      id, longitude, latitude,
      name: text(record.name) || 'Published launch',
      scheduledAt: Number.isFinite(scheduledAt) ? scheduledAt : null,
      status: text(record.status?.name) || 'Unspecified',
      provider: text(record.launch_service_provider?.name),
      launchSite: [text(pad.name), text(pad.location?.name)].filter(Boolean).join(' · '),
      vehicle: text(record.rocket?.configuration?.name),
      mission: text(record.mission?.name),
      description: text(record.mission?.description),
    }];
  });
}

export function createLaunchSitesLayer({ source } = {}) {
  let viewer, dataSource, request, onChange;
  let enabled = false, lastUpdate = null, error = null, stale = false;
  let records = [];
  return {
    id: 'rocket-launches', updateInterval: 900000,
    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('published-launch-sites');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },
    enable() { enabled = true; dataSource.show = true; },
    disable() {
      enabled = false; request?.abort(); request = null;
      if (dataSource) dataSource.show = false;
      if (viewer?.selectedEntity?.properties?.launchId) viewer.selectedEntity = undefined;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController(); request = controller;
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const snapshot = await source.getLaunchSnapshot({ signal: combined });
        const next = normalizeLaunchRecords(snapshot.payload);
        combined.throwIfAborted();
        if (!enabled || request !== controller) return false;
        const entities = next.map((record) => new Cesium.Entity({
          id: `launch:${record.id}`, name: record.name,
          position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 25),
          point: {
            pixelSize: 9, color: Cesium.Color.fromCssColorString('#c3b7ff'),
            outlineColor: Cesium.Color.fromCssColorString('#242038'), outlineWidth: 2,
          },
          properties: {
            launchId: record.id,
            launchDate: record.scheduledAt === null ? 'Unspecified' : new Date(record.scheduledAt).toISOString(),
            status: record.status, provider: record.provider, launchSite: record.launchSite,
            vehicle: record.vehicle, mission: record.mission, description: record.description,
            positionMeaning: 'Fixed launch site; no rocket location is represented',
            source: 'The Space Devs', sourceUrl: 'https://thespacedevs.com/',
          },
        }));
        dataSource.entities.removeAll();
        for (const entity of entities) dataSource.entities.add(entity);
        records = next; stale = snapshot.stale === true;
        lastUpdate = Date.now(); error = null;
        viewer.scene.requestRender(); onChange?.(); return true;
      } catch (failure) {
        if (combined.aborted) return false;
        error = failure.message || 'Launch records unavailable'; stale = records.length > 0;
        onChange?.(); return false;
      } finally { if (request === controller) request = null; }
    },
    getStats: () => ({ count: records.length, lastUpdate, error, stale,
      source: 'The Space Devs', coverage: 'Published launch records at fixed launch sites' }),
    getRowControls: () => ({
      info: 'Published mission dates. Select a record to inspect its launch site.',
      items: records.slice(0, 12).map((record) => ({
        label: record.name,
        detail: [record.scheduledAt === null ? 'Date unspecified' : new Date(record.scheduledAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', record.status].join(' · '),
        params: { focusLaunch: record.id },
      })),
    }),
    setRowControlsListener(listener) { onChange = listener; },
    setParams({ focusLaunch } = {}) {
      const record = records.find((entry) => entry.id === focusLaunch);
      if (!record || !enabled) return;
      viewer.selectedEntity = dataSource.entities.getById(`launch:${record.id}`);
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 300000), duration: 1 });
    },
    getParams: () => ({}),
    destroy() {
      enabled = false; request?.abort(); request = null; onChange = null;
      if (dataSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(dataSource, true);
      dataSource = null; viewer = null; records = [];
    },
  };
}
