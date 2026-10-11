import { CCTV_SOURCE_CACHE_MS } from './constants.js';
import { allocateSourceCap, resolveCatalogCap } from './cap.js';
import { cameraRegion, normalizeSourceItem } from './normalize.js';
import {
  loadTflSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadNswSourcesFromOpenData,
  loadCalgarySourcesFromOpenData,
  loadVegvesenSourcesFromOpenData,
} from './sources.js';

const enabled = (name) => String(process.env[name] || '1').trim() !== '0';
const accepted = (name) => String(process.env[name] || '').trim() === '1';
const configured = (name) => Boolean(String(process.env[name] || '').trim());

/** Only reviewed providers can enter this catalog; env/file sources are absent. */
export const CCTV_PROVIDER_PACKS = Object.freeze([
  { name: 'fintraffic', enabled: () => enabled('CCTV_FINTRAFFIC_ENABLED'), load: loadFintrafficSourcesFromOpenData },
  { name: 'nsw', enabled: () => enabled('CCTV_NSW_ENABLED'), load: loadNswSourcesFromOpenData },
  { name: 'calgary', enabled: () => enabled('CCTV_CALGARY_ENABLED'), load: loadCalgarySourcesFromOpenData },
  { name: 'vegvesen', enabled: () => enabled('CCTV_VEGVESEN_ENABLED'), load: loadVegvesenSourcesFromOpenData },
  {
    name: 'drivebc',
    enabled: () => enabled('CCTV_DRIVEBC_ENABLED') && accepted('CCTV_DRIVEBC_TERMS_ACCEPTED') && configured('CCTV_DRIVEBC_APPROVED_IDS'),
    load: loadDriveBcSourcesFromOpenData,
  },
  {
    name: 'tfl',
    enabled: () => enabled('CCTV_TFL_ENABLED') && accepted('CCTV_TFL_TERMS_ACCEPTED') && configured('TFL_APP_KEY'),
    load: loadTflSourcesFromOpenData,
  },
  {
    name: 'ontario',
    enabled: () => enabled('CCTV_ONTARIO_ENABLED') && accepted('CCTV_ONTARIO_TERMS_ACCEPTED') && configured('ONTARIO_511_API_KEY'),
    load: loadOntarioSourcesFromOpenData,
  },
]);

export function enabledCctvProviderNames() {
  return CCTV_PROVIDER_PACKS.filter((pack) => pack.enabled()).map((pack) => pack.name);
}

/** Shared catalog with bounded refresh, failure isolation and revocation filtering. */
export function createCctvCatalog() {
  let sources = [];
  let refreshedAt = 0;
  let inflight = null;
  let trimmedPacks = [];

  function currentSources() {
    const names = new Set(enabledCctvProviderNames());
    const driveBcIds = new Set(String(process.env.CCTV_DRIVEBC_APPROVED_IDS || '')
      .split(',').map((id) => id.trim()));
    return sources.filter((source) => names.has(source.pack)
      && (source.pack !== 'drivebc' || driveBcIds.has(source.id.replace(/^drivebc-/, ''))));
  }

  async function refresh() {
    const activePacks = CCTV_PROVIDER_PACKS.filter((pack) => pack.enabled());
    const results = await Promise.allSettled(
      activePacks.map((pack) => Promise.resolve().then(() => pack.load())),
    );
    const packs = activePacks.map((pack, index) => {
      const items = results[index].status === 'fulfilled' && Array.isArray(results[index].value)
        ? results[index].value
        : [];
      return {
        name: pack.name,
        sources: items.filter((item) => item && typeof item === 'object')
          .map((item) => ({ ...normalizeSourceItem(item), pack: pack.name }))
          .filter((item) => item.id),
        available: Number.isFinite(items.available) ? items.available : items.length,
        region: items.region ?? null,
      };
    });
    const allocation = allocateSourceCap(packs, resolveCatalogCap(process.env.CCTV_MAX_SOURCES));
    // Google-derived ground-height sidecars and local file/env camera packs
    // cannot enter the hosted catalog. Camera placement uses licensed terrain.
    if (allocation.sources.length || !sources.length) {
      sources = allocation.sources;
      trimmedPacks = packs.map((pack, index) => ({
        pack: pack.name,
        available: Math.max(pack.available, allocation.packs[index].offered),
        served: allocation.packs[index].kept,
        region: pack.region ?? cameraRegion(pack.sources),
      })).filter((pack) => pack.served < pack.available);
    }
    refreshedAt = Date.now();
    return currentSources();
  }

  async function getCctvSources() {
    if (refreshedAt && Date.now() - refreshedAt <= CCTV_SOURCE_CACHE_MS) {
      return currentSources();
    }
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  getCctvSources.trimmedPacks = () => {
    const names = new Set(enabledCctvProviderNames());
    return trimmedPacks.filter((pack) => names.has(pack.pack));
  };
  return getCctvSources;
}
