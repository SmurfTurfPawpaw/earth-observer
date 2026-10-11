import { CCTV_SOURCE_CACHE_MS, CCTV_MAX_SOURCES_CEILING } from './constants.js';
import { allocateSourceCap, resolveCatalogCap } from './cap.js';
import { cameraRegion, normalizeSourceItem } from './normalize.js';
import { cctvDistance, cctvPackForId, cctvRegionIntersects } from './regions.js';
import {
  loadTflSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadNswSourcesFromOpenData,
  loadCalgarySourcesFromOpenData,
  loadVegvesenSourcesFromOpenData,
} from './sources.js';

const enabled = (name, env = globalThis.process?.env || {}) => String(env[name] || '1').trim() !== '0';
const accepted = (name, env = globalThis.process?.env || {}) => String(env[name] || '').trim() === '1';
const configured = (name, env = globalThis.process?.env || {}) => Boolean(String(env[name] || '').trim());

/** Only reviewed providers can enter this catalog; env/file sources are absent. */
export const CCTV_PROVIDER_PACKS = Object.freeze([
  { name: 'fintraffic', enabled: (env) => enabled('CCTV_FINTRAFFIC_ENABLED', env), load: loadFintrafficSourcesFromOpenData },
  { name: 'nsw', enabled: (env) => enabled('CCTV_NSW_ENABLED', env), load: loadNswSourcesFromOpenData },
  { name: 'calgary', enabled: (env) => enabled('CCTV_CALGARY_ENABLED', env), load: loadCalgarySourcesFromOpenData },
  { name: 'vegvesen', enabled: (env) => enabled('CCTV_VEGVESEN_ENABLED', env), load: loadVegvesenSourcesFromOpenData },
  {
    name: 'drivebc',
    enabled: (env) => enabled('CCTV_DRIVEBC_ENABLED', env) && accepted('CCTV_DRIVEBC_TERMS_ACCEPTED', env) && configured('CCTV_DRIVEBC_APPROVED_IDS', env),
    load: loadDriveBcSourcesFromOpenData,
  },
  {
    name: 'tfl',
    enabled: (env) => enabled('CCTV_TFL_ENABLED', env) && accepted('CCTV_TFL_TERMS_ACCEPTED', env) && configured('TFL_APP_KEY', env),
    load: loadTflSourcesFromOpenData,
  },
  {
    name: 'ontario',
    enabled: (env) => enabled('CCTV_ONTARIO_ENABLED', env) && accepted('CCTV_ONTARIO_TERMS_ACCEPTED', env) && configured('ONTARIO_511_API_KEY', env),
    load: loadOntarioSourcesFromOpenData,
  },
]);

export function enabledCctvProviderNames(env = globalThis.process?.env || {}) {
  return CCTV_PROVIDER_PACKS.filter((pack) => pack.enabled(env)).map((pack) => pack.name);
}

/** Each admitted pack has one bounded cache and refresh, shared by all areas. */
export function createCctvCatalog({ env = globalThis.process?.env || {}, fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const states = new Map();
  const activePacks = (area) => CCTV_PROVIDER_PACKS.filter((pack) => pack.enabled(env) && cctvRegionIntersects(pack.name, area));
  function admitted(source) {
    const pack = CCTV_PROVIDER_PACKS.find((item) => item.name === source?.pack);
    if (!pack?.enabled(env)) return false;
    return source.pack !== 'drivebc' || String(env.CCTV_DRIVEBC_APPROVED_IDS || '').split(',').map((id) => id.trim()).includes(source.id.replace(/^drivebc-/, ''));
  }
  const normalize = (items, name) => [...new Map(items.slice(0, CCTV_MAX_SOURCES_CEILING)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ ...normalizeSourceItem(item), pack: name }))
    .filter((item) => item.id && Number.isFinite(item.lat) && Number.isFinite(item.lon) && Math.abs(item.lat) <= 90 && Math.abs(item.lon) <= 180)
    .map((item) => [item.id, item])).values()];

  async function refreshPack(pack) {
    let state = states.get(pack.name);
    if (!state) { state = { sources: [], allSources: [], byId: new Map(), attemptedAt: null, refreshedAt: null, failed: false }; states.set(pack.name, state); }
    if (state.inflight) return state.inflight;
    if (state.attemptedAt !== null && now() - state.attemptedAt <= CCTV_SOURCE_CACHE_MS) return state;
    state.inflight = (async () => {
      try {
        const items = await pack.load({ env, fetchImpl, retainAll: true });
        // Successful empty catalogs carry `available: 0`; loader failures return
        // a bare empty array. Retain this pack's last good data on failure only.
        if (!Array.isArray(items) || (!items.length && !Number.isFinite(items.available))) throw new Error('Camera catalog unavailable');
        state.sources = normalize(items, pack.name);
        state.allSources = normalize(Array.isArray(items.allSources) ? items.allSources : items, pack.name);
        state.byId = new Map(state.allSources.map((source) => [source.id, source]));
        state.available = Number.isFinite(items.available) ? items.available : state.allSources.length;
        state.cap = Number.isFinite(items.catalogCap) ? items.catalogCap : state.sources.length;
        state.region = items.region ?? cameraRegion(state.allSources);
        state.refreshedAt = now(); state.failed = false;
      } catch {
        state.failed = true;
      } finally {
        state.attemptedAt = now();
      }
      return state;
    })().finally(() => { state.inflight = null; });
    return state.inflight;
  }

  function snapshot(area = null) {
    const active = activePacks(area);
    const packs = active.map((pack) => {
      const state = states.get(pack.name);
      const candidates = (area ? state?.allSources : state?.sources) || [];
      const matching = candidates.filter(admitted).filter((source) => !area || cctvDistance(source, area) <= area.radiusKm);
      if (area) matching.sort((a, b) => cctvDistance(a, area) - cctvDistance(b, area));
      return { name: pack.name, sources: area ? matching.slice(0, state?.cap || 0) : matching,
        available: area ? matching.length : Math.max(state?.available || 0, matching.length), region: state?.region ?? null,
        incomplete: Boolean(state && state.available > state.allSources.length), state };
    });
    const allocation = allocateSourceCap(packs, resolveCatalogCap(env.CCTV_MAX_SOURCES));
    const providers = packs.map((pack, index) => ({
      id: pack.name, status: pack.state?.failed ? (pack.state.refreshedAt !== null ? 'stale' : 'unavailable') : pack.state?.refreshedAt != null ? 'ready' : 'not-loaded',
      retrievedAt: pack.state?.refreshedAt != null ? new Date(pack.state.refreshedAt).toISOString() : null,
      ageMs: pack.state?.refreshedAt != null ? Math.max(0, now() - pack.state.refreshedAt) : null,
      matched: pack.available, returned: allocation.packs[index].kept, incomplete: pack.incomplete,
    }));
    const stale = providers.some((provider) => provider.status === 'stale');
    const unavailable = providers.length > 0 && providers.every((provider) => provider.status === 'unavailable');
    const degraded = providers.some((provider) => ['stale', 'unavailable'].includes(provider.status)) || packs.some((pack) => pack.incomplete);
    let note = area && !active.length ? 'No reviewed camera provider covers this area.'
      : unavailable ? `Camera catalogs are unavailable${area ? ' for this area' : ''}.`
      : area && !allocation.sources.length ? `No reviewed camera records within ${area.radiusKm} km.`
      : area ? `Reviewed camera records within ${area.radiusKm} km; coverage is limited to supported providers.`
      : 'Reviewed camera catalogs; coverage is limited to supported providers.';
    if (degraded && !unavailable) note += ' Some provider data is stale, unavailable or capped.';
    return {
      sources: allocation.sources,
      trimmedPacks: packs.map((pack, index) => ({ pack: pack.name, available: pack.available, served: allocation.packs[index].kept, region: pack.region }))
        .filter((pack) => pack.served < pack.available),
      providers, stale, degraded, ageMs: Math.max(0, ...providers.map((provider) => provider.ageMs || 0)),
      coverage: { mode: area ? 'local' : 'catalog', area, status: area && !active.length ? 'unsupported' : unavailable ? 'unavailable' : stale ? 'stale' : allocation.sources.length ? 'ready' : 'empty',
        note, providers: active.map((pack) => pack.name), returned: allocation.sources.length, incomplete: degraded },
    };
  }
  async function getCatalog(area = null) {
    await Promise.all(activePacks(area).map(refreshPack));
    return snapshot(area);
  }
  async function getCctvSources(area = null) { return (await getCatalog(area)).sources; }
  getCctvSources.getCatalog = getCatalog;
  getCctvSources.trimmedPacks = (area = null) => snapshot(area).trimmedPacks;
  getCctvSources.currentSources = () => [...states.values()].flatMap((state) => state.allSources).filter(admitted);
  getCctvSources.isRegistered = (id) => admitted(states.get(cctvPackForId(id))?.byId.get(id));
  getCctvSources.getById = async (id) => {
    const name = cctvPackForId(id), pack = CCTV_PROVIDER_PACKS.find((item) => item.name === name && item.enabled(env));
    if (!pack || (name === 'drivebc' && !String(env.CCTV_DRIVEBC_APPROVED_IDS || '').split(',').map((value) => value.trim()).includes(id.replace(/^drivebc-/, '')))) return null;
    await refreshPack(pack);
    const source = states.get(name)?.byId.get(id);
    return admitted(source) ? source : null;
  };
  return getCctvSources;
}
