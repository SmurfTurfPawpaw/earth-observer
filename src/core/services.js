let overlayOwner, renderOwner;
const DEFAULT_LOADERS = {
  surface: () => Promise.all([import('../services/terrainHeights.js'), import('../services/groundFloor.js')]),
  weatherClock: () => import('../layers/weather/clock.js'),
  overlayHost: () => import('../overlays/worldOverlay.js'),
  render: () => import('../renderGovernor.js'),
};

/** Construct no scene owners until a layer requests the specific service it uses. */
export function createCoreServices(viewer, {
  documentRef = globalThis.document,
  fetchImpl = (...args) => fetch(...args),
  loaders = DEFAULT_LOADERS,
} = {}) {
  const lifetime = new AbortController(), pending = new Map();
  const owner = {};
  let destroyed = false, surfaceActive = true, terrainRequests = new AbortController();
  let overlayModule, renderModule;
  const unavailable = () => new DOMException('Scene services are inactive', 'AbortError');
  const active = () => !destroyed && !documentRef?.hidden;
  const api = { viewer };

  async function initialize(name) {
    if (!active()) throw unavailable();
    const modules = await loaders[name]();
    if (!active()) throw unavailable();
    if (name === 'weatherClock') return modules.createWeatherClock();
    if (name === 'render') {
      modules.installRenderGovernor(viewer); renderModule = modules; renderOwner = owner;
      return modules;
    }
    if (name === 'overlayHost') {
      modules.initWorldOverlay(viewer); overlayModule = modules; overlayOwner = owner;
      return {
        setEntries: modules.setOverlayEntries, setVisible: modules.setOverlaySourceVisible,
        clearSource: modules.clearOverlaySource, hitTest: modules.hitTestWorldOverlay,
      };
    }
    const [terrainModule, groundModule] = modules;
    const terrain = terrainModule.createTerrainHeights({ signal: lifetime.signal, source: {
      async getHeights(points, { signal } = {}) {
        if (!active() || !surfaceActive) throw unavailable();
        const combined = AbortSignal.any([lifetime.signal, terrainRequests.signal, signal].filter(Boolean));
        combined.throwIfAborted();
        const query = points.map((point) => `${point.lon.toFixed(5)},${point.lat.toFixed(5)}`).join(';');
        const response = await fetchImpl(`/api/terrain/heights?${new URLSearchParams({ points: query })}`, { signal: combined });
        if (!response.ok) throw new Error(`Terrain HTTP ${response.status}`);
        const body = await response.json(); combined.throwIfAborted();
        return body.results;
      },
    } });
    const groundFloor = groundModule.createGroundFloor({ terrain, signal: lifetime.signal });
    let warmTail = Promise.resolve(false);
    const anchors = {
      // The installation engine still uses this compatibility method name.
      // No fire renderer, mesh sampler or moving-contact surface service is loaded.
      warmFireAnchorFloors(points) {
        const candidates = Array.isArray(points) ? points.slice(0, 512) : [];
        const work = async () => {
          if (!active() || !surfaceActive) return false;
          const cold = candidates.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon) && groundFloor.cachedGroundFloor(point.lat, point.lon) == null);
          if (!cold.length) return false;
          await groundFloor.resolveGroundFloorCells(cold, { signal: terrainRequests.signal });
          return active() && surfaceActive && cold.some((point) => groundFloor.cachedGroundFloor(point.lat, point.lon) != null);
        };
        warmTail = warmTail.then(work, work).catch(() => false);
        return warmTail;
      },
    };
    return { terrain, groundFloor, anchors };
  }
  api.ensure = async (names) => {
    if (destroyed) throw unavailable();
    await Promise.all([...new Set(names)].map((name) => {
      if (api[name]) return api[name];
      if (!loaders[name]) throw new Error(`Unknown scene service: ${name}`);
      if (!pending.has(name)) pending.set(name, initialize(name).then((value) => {
        if (destroyed) { value.destroy?.(); throw unavailable(); }
        api[name] = value; return value;
      }).finally(() => pending.delete(name)));
      return pending.get(name);
    }));
    return api;
  };
  api.setActiveServices = (names) => {
    surfaceActive = names.includes('surface');
    if (!active() || !surfaceActive) terrainRequests.abort();
    else if (terrainRequests.signal.aborted) terrainRequests = new AbortController();
  };
  api.destroy = async () => {
    if (destroyed) return;
    destroyed = true; lifetime.abort(); terrainRequests.abort();
    await Promise.allSettled([...pending.values()]);
    api.weatherClock?.destroy();
    if (overlayOwner === owner) { overlayModule?.destroyWorldOverlay(); overlayOwner = null; }
    if (renderOwner === owner) { renderModule?.uninstallRenderGovernor(viewer); renderOwner = null; }
  };
  return api;
}
