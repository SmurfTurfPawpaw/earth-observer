/** Lazy adapters reuse the independent engines, never the old application/UI. */
const CODE_LOADERS = {
  aircraft: () => Promise.all([import('./aircraft.js'), import('../sources/live/aircraft.js')]),
  weather: () => Promise.all([import('../layers/weather/index.js'), import('../layers/weather/source.js')]),
  wind: () => Promise.all([import('../layers/wind/index.js'), import('../layers/wind/source.js')]),
  cyclones: () => Promise.all([import('../layers/cyclones/index.js'), import('../layers/cyclones/source.js')]),
  earthquakes: () => Promise.all([import('../layers/earthquakes/index.js'), import('../layers/earthquakes/source.js')]),
  gdacs: () => Promise.all([import('../layers/gdacs/index.js'), import('../layers/gdacs/source.js')]),
  perimeters: () => Promise.all([import('../app/layers/perimeters.js'), import('../layers/perimeters/source.js')]),
  imagery: () => Promise.all([import('../app/layers/recentImagery.js'), import('../layers/recentImagery/source.js')]),
  satellites: () => Promise.all([import('../app/layers/satellites.js'), import('../layers/satellites/source.js')]),
  launches: () => Promise.all([import('./launches.js'), import('../layers/launches/source.js')]),
  bikeshare: () => Promise.all([import('../app/layers/bikeshare.js'), import('../layers/bikeshare/source.js')]),
  transit: () => Promise.all([import('./transit.js')]),
  cctv: () => Promise.all([import('./cctv.js')]),
  installations: () => Promise.all([import('../app/layers/militaryInstallations.js'), import('../layers/installations/source.js'), import('../sources/openFreeMap.js')]),
  alpr: () => Promise.all([import('../app/layers/alprCameras.js'), import('../layers/alpr/source.js')]),
  firms: () => Promise.all([import('./firms.js'), import('../layers/firms/source.js')]),
  infrastructure: () => Promise.all([import('./infrastructure.js'), import('../sources/infrastructureData.js')]),
};
const GROUPS = {
  flights: 'aircraft', military: 'aircraft', 'weather-radar': 'weather', 'weather-satellite': 'weather',
  'weather-lightning': 'weather', wind: 'wind', 'weather-cyclones': 'cyclones', earthquakes: 'earthquakes',
  'gdacs-notices': 'gdacs',
  'fire-perimeters': 'perimeters', 'recent-imagery': 'imagery', satellites: 'satellites',
  'rocket-launches': 'launches', bikeshare: 'bikeshare', transit: 'transit', cctv: 'cctv',
  'military-installations': 'installations', 'alpr-cameras': 'alpr', 'local-firms': 'firms',
  'local-datacenters': 'infrastructure', 'local-dams': 'infrastructure',
};
const SERVICE_REQUIREMENTS = {
  aircraft: ['render'], weather: ['weatherClock'], wind: ['weatherClock'], cyclones: ['overlayHost'], earthquakes: ['overlayHost'],
  perimeters: ['overlayHost'], imagery: ['render'], satellites: ['overlayHost', 'render'],
  bikeshare: ['overlayHost', 'render'], installations: ['surface', 'overlayHost', 'render'],
  alpr: ['surface', 'overlayHost', 'render'],
};
const codeCache = new Map();
export const layerServiceRequirements = (id) => SERVICE_REQUIREMENTS[GROUPS[id]] || [];

/** Code-only warm-up: imports neither construct a layer nor request its dataset. */
export function preloadLayer(id) {
  const group = GROUPS[id];
  if (!group) return Promise.reject(new Error(`Unknown layer: ${id}`));
  if (!codeCache.has(group)) codeCache.set(group, CODE_LOADERS[group]().catch((error) => {
    codeCache.delete(group); throw error;
  }));
  return codeCache.get(group);
}

const PREPARED_AIRCRAFT_BYTES = 2 * 1024 * 1024;
async function aircraftJson(response, signal) {
  signal?.throwIfAborted();
  if (Number(response.headers.get('content-length')) > PREPARED_AIRCRAFT_BYTES) throw new Error('Aircraft response exceeds its bounded payload');
  const reader = response.body?.getReader();
  if (!reader) { const payload = await response.json(); signal?.throwIfAborted(); return payload; }
  const chunks = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted(); const { done, value } = await reader.read(); signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > PREPARED_AIRCRAFT_BYTES) { abort(); throw new Error('Aircraft response exceeds its bounded payload'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
const aircraftRequest = (signal, revalidate) => ({ signal, ...(revalidate ? { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } } : {}) });

/** Shared live aircraft adapter; receipt clocks never qualify a position fix. */
export function createAircraftSource(fetchImpl, military, { readsbSnapshot, readsbIdentities, preparedAircraftSnapshot }) {
  const endpoint = military ? '/api/military' : '/api/flights';
  const read = async (query = {}, { signal, revalidate = false } = {}) => {
    const params = new URLSearchParams();
    if (!military && Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
      params.set('lat', query.latitude.toFixed(4));
      params.set('lon', query.longitude.toFixed(4));
      params.set('radiusKm', String(query.radiusKm ?? 50));
    }
    signal?.throwIfAborted();
    const response = await fetchImpl(`${endpoint}${params.size ? '?' + params : ''}`, aircraftRequest(signal, revalidate));
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
    const payload = await response.json(); signal?.throwIfAborted(); return { response, payload };
  };
  const readPrepared = async (query = {}, { signal, revalidate = false } = {}) => {
    const params = new URLSearchParams();
    if (military) params.set('military', '1');
    else {
      if (!Number.isFinite(query.latitude) || !Number.isFinite(query.longitude)) return null;
      params.set('lat', query.latitude.toFixed(4)); params.set('lon', query.longitude.toFixed(4));
      params.set('radiusKm', String(query.radiusKm ?? 50));
    }
    signal?.throwIfAborted();
    const response = await fetchImpl('/api/aircraft/observations?' + params, aircraftRequest(signal, revalidate));
    signal?.throwIfAborted();
    // An absent route is an explicit unsupported host; other failures remain
    // errors unless the prepared service specifically declares fallback safe.
    if (response.status === 404) return null;
    const payload = await aircraftJson(response, signal);
    if (response.status === 503 && payload?.prepared === false && payload.available === false &&
      ['not-configured', 'unavailable', 'not-covered'].includes(payload.code)) return null;
    if (!response.ok) throw new Error(`Prepared aircraft HTTP ${response.status}`);
    const ageHeader = response.headers.get('x-feed-age-ms'), headerAgeMs = ageHeader == null ? null : Number(ageHeader);
    const cacheAgeMs = Number.isFinite(headerAgeMs) && headerAgeMs >= 0 ? headerAgeMs : null;
    const snapshot = preparedAircraftSnapshot(payload, { now: Date.now(), cacheAgeMs, stale: response.headers.get('x-feed-cache') === 'STALE' });
    return { ...snapshot, coverage: military ? snapshot.coverage : snapshot.coverage + ' · requested radius ' + (query.radiusKm ?? 50) + 'km',
      status: response.status, browserCache: response.headers.get('x-browser-cache') || null };
  };
  return {
    label: 'adsb.lol',
    async getSnapshot(query, options) {
      const prepared = await readPrepared(query, options);
      if (prepared) return prepared;
      const { response, payload } = await read(query, options);
      const now = Date.now();
      const upstreamTime = payload?.now;
      const upstreamMs = typeof upstreamTime === 'number' && Number.isFinite(upstreamTime) && upstreamTime > 0
        ? upstreamTime * (upstreamTime < 100000000000 ? 1000 : 1) : null;
      const cacheAge = Number(response.headers.get('x-feed-age-ms'));
      const cacheAgeMs = Number.isFinite(cacheAge) && cacheAge >= 0 ? cacheAge : 0;
      const receivedAt = now - cacheAgeMs;
      const hasSourceTime = upstreamMs !== null && upstreamMs <= now + 10000 && upstreamMs <= 8640000000000000;
      const observedAtMs = hasSourceTime ? upstreamMs : receivedAt > 0 ? receivedAt : null;
      const observedAtSource = hasSourceTime ? 'source' : observedAtMs == null ? 'unknown' : 'receipt';
      return { ...readsbSnapshot(payload, {
        source: 'adsb.lol', now,
        coverage: military ? 'military receiver snapshot' : Number.isFinite(query?.latitude) && Number.isFinite(query?.longitude)
          ? 'Receiver observations within ' + (query.radiusKm ?? 50) + 'km of the requested view center' : 'legacy receiver snapshot',
        observedAtMs,
        observedAtSource,
        stale: response.headers.get('x-feed-cache') === 'STALE' || cacheAgeMs > 120000 || (observedAtMs != null && now - observedAtMs > 120000),
      }), status: response.status };
    },
    async getIdentities(query, options) { return readsbIdentities((await read(query, options)).payload); },
    async getTrack() { return { records: [], complete: false }; },
    async getEnrichment() { return null; },
  };
}

export async function createLayer(id, { services = {}, fetchImpl, getLocalArea, documentRef = globalThis.document, aircraftMotion = {} }) {
  const { surface, weatherClock, overlayHost } = services;
  const modules = await preloadLayer(id);
  if (id === 'flights' || id === 'military') {
    const military = id === 'military';
    const [engine, normalizers] = modules;
    return engine.createObservedAircraftLayer({
      id, source: createAircraftSource(fetchImpl, military, normalizers), render: services.render, documentRef,
      predictionEnabled: aircraftMotion.predictionEnabled ?? true,
      horizonMs: aircraftMotion.horizonMs,
      correctionMs: aircraftMotion.correctionMs,
      presentationDelayMs: aircraftMotion.presentationDelayMs,
      maxInterpolationGapMs: aircraftMotion.maxInterpolationGapMs,
      interpolationMethod: aircraftMotion.interpolationMethod,
    });
  }
  if (id.startsWith('weather-') && id !== 'weather-cyclones') {
    const [engine, source] = modules;
    return engine.createWeatherLayer({ id, clock: weatherClock, feed: source.createWeatherSource({ fetchImpl }) });
  }
  if (id === 'wind') {
    const [engine, source] = modules;
    return engine.createWindLayer({ clock: weatherClock, feed: source.createWindSource({ fetchImpl }) });
  }
  if (id === 'weather-cyclones') {
    const [engine, source] = modules;
    return engine.createCyclonesLayer({ overlayHost, feed: source.createCycloneSource({ fetchImpl }) });
  }
  if (id === 'earthquakes') {
    const [engine, source] = modules;
    return engine.createEarthquakesLayer({ overlayHost, source: source.createUsgsEarthquakeSource({ fetchImpl }) });
  }
  if (id === 'gdacs-notices') {
    const [engine, source] = modules;
    return engine.createGdacsNoticesLayer({ source: source.createGdacsNoticeSource({ fetchImpl }) });
  }
  if (id === 'fire-perimeters') {
    const [adapter, source] = modules;
    return adapter.createApplicationFirePerimeters({ overlayHost, source: source.createWfigsPerimeterSource({ fetchImpl }) });
  }
  if (id === 'recent-imagery') {
    const [adapter, source] = modules;
    return adapter.createApplicationRecentImagery({ source: source.createRecentImagerySource({ fetchImpl }) });
  }
  if (id === 'satellites') {
    const [adapter, source] = modules;
    return adapter.createApplicationSatellites({ source: source.createSatelliteSource({ fetchImpl }) });
  }
  if (id === 'rocket-launches') {
    const [engine, source] = modules;
    return engine.createLaunchSitesLayer({ source: source.createLaunchSource({ fetchImpl }) });
  }
  if (id === 'bikeshare') {
    const [adapter, source] = modules;
    return adapter.createApplicationBikeshare({ source: source.createBikeshareSource({ fetchImpl, getLocalArea }) });
  }
  if (id === 'transit') {
    const [{ createObservedTransitLayer }] = modules;
    return createObservedTransitLayer({ fetchImpl });
  }
  if (id === 'cctv') {
    const [{ createCamerasLayer }] = modules;
    return createCamerasLayer({ fetchImpl });
  }
  if (id === 'military-installations') {
    const [adapter, source, tiles] = modules;
    const feed = source.createInstallationSource({ fetchImpl, mapTiles: tiles.createOpenFreeMapSource({ fetchImpl }) });
    feed.searchNearby = async () => ({ records: [], status: 'unavailable', reason: 'Places search is not configured' });
    return adapter.createApplicationInstallations({ surface, source: feed });
  }
  if (id === 'alpr-cameras') {
    const [adapter, source] = modules;
    return adapter.createApplicationAlpr({ surface, source: source.createAlprTileSource({ tileFetchImpl: fetchImpl }) });
  }
  if (id === 'local-firms') {
    const [engine, source] = modules;
    return engine.createFireDetectionsLayer({ source: source.createFirmsSource({ fetchImpl }) });
  }
  if (id === 'local-datacenters' || id === 'local-dams') {
    const [engine, source] = modules;
    return engine.createInfrastructureLayer({ id, source: source.createInfrastructureSource({ fetchImpl }) });
  }
  throw new Error(`Unknown layer: ${id}`);
}
