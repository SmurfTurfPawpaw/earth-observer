import { createCctvCatalog } from './cctv/catalog.js';
import { cctvAreaQuery, cctvDistance } from './cctv/regions.js';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS, CCTV_FRAME_MAX_BODY_BYTES, CCTV_MAX_SOURCES_CEILING,
  FINTRAFFIC_IMAGE_ORIGIN, NSW_IMAGE_ORIGIN, NSW_IMAGE_USER_AGENT,
  CALGARY_IMAGE_ORIGIN, VEGVESEN_IMAGE_ORIGIN, TFL_IMAGE_ORIGIN,
  ONTARIO_511_IMAGE_ORIGIN,
} from './cctv/constants.js';
import { readResponseBytesCapped, coalesceProxyRequest } from './common/http.js';
export { CCTV_FRAME_FETCH_TIMEOUT_MS };

const SNAPSHOT_BASES = Object.freeze({
  fintraffic: FINTRAFFIC_IMAGE_ORIGIN,
  nsw: NSW_IMAGE_ORIGIN,
  calgary: CALGARY_IMAGE_ORIGIN,
  vegvesen: VEGVESEN_IMAGE_ORIGIN,
  drivebc: 'https://www.drivebc.ca/images/',
  tfl: TFL_IMAGE_ORIGIN,
  ontario: ONTARIO_511_IMAGE_ORIGIN,
});
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const FRAME_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;

/** Registered pack, exact origin, permitted path, HTTPS and no URL credentials. */
export function isAllowedCctvSnapshotUrl(value, pack) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    const bases = pack ? [SNAPSHOT_BASES[pack]].filter(Boolean) : Object.values(SNAPSHOT_BASES);
    return bases.some((base) => {
      const allowed = new URL(base);
      return url.origin === allowed.origin && url.pathname.startsWith(allowed.pathname);
    });
  } catch {
    return false;
  }
}

/** Fetch a bounded raster still. Redirects and unsupported content are refused. */
export async function fetchCctvImageFromUpstream(url, {
  provider,
  fetchImpl = fetch,
  timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
  maxBytes = CCTV_FRAME_MAX_BODY_BYTES,
} = {}) {
  if (!isAllowedCctvSnapshotUrl(url, provider)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: {
        Accept: 'image/jpeg,image/png,image/webp,image/gif',
        'User-Agent': provider === 'nsw' ? NSW_IMAGE_USER_AGENT : 'earth-observer-cctv/1.0',
        ...(provider === 'fintraffic' ? { 'Digitraffic-User': 'earth-observer' } : {}),
      },
    });
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !IMAGE_TYPES.has(contentType)) return null;
    const body = await readResponseBytesCapped(response, maxBytes, controller.signal);
    return body.byteLength ? { ok: true, body, contentType } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

/**
 * Snapshots-only CCTV API. Catalog admission is checked before cache access.
 * Frames share a bounded LRU cache and coalesced fetches; failures never trigger
 * another provider, video tooling, generated image or Street View fallback.
 */
export function cctvProxy(options = {}) {
  const getSources = createCctvCatalog(options);
  const health = new Map();
  const cache = new Map();
  const inFlight = new Map();
  let cacheBytes = 0;

  function deleteCached(id) {
    const previous = cache.get(id);
    cacheBytes -= previous?.frame?.body.byteLength || 0;
    cache.delete(id);
  }
  function remember(id, entry) {
    deleteCached(id);
    cache.set(id, entry);
    cacheBytes += entry.frame?.body.byteLength || 0;
    while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
      deleteCached(cache.keys().next().value);
    }
  }
  function setHealth(source, status) {
    health.delete(source.id);
    health.set(source.id, {
      id: source.id, status, sourceKind: source.sourceKind,
      label: source.name, message: status === 'ok' ? '' : 'Camera snapshot unavailable',
      updatedAt: Date.now(),
    });
    while (health.size > CCTV_MAX_SOURCES_CEILING) health.delete(health.keys().next().value);
  }
  async function getFrame(source) {
    const url = source.snapshotUrl || source.url;
    if (!isAllowedCctvSnapshotUrl(url, source.pack)) return null;
    const previous = cache.get(source.id);
    if (previous?.url === url && previous.expiresAt > Date.now()) {
      cache.delete(source.id);
      cache.set(source.id, previous);
      return previous.frame;
    }
    deleteCached(source.id);
    if (!inFlight.has(source.id) && inFlight.size >= MAX_IN_FLIGHT) {
      throw Object.assign(new Error('Camera service busy'), { status: 503 });
    }
    return coalesceProxyRequest(inFlight, source.id, async () => {
      const frame = await fetchCctvImageFromUpstream(url, { provider: source.pack, fetchImpl: options.fetchImpl });
      const ttl = frame ? (source.pack === 'tfl' ? 300_000 : FRAME_CACHE_MS) : FAILURE_CACHE_MS;
      remember(source.id, { url, frame, expiresAt: Date.now() + ttl });
      setHealth(source, frame ? 'ok' : 'offline');
      return frame;
    }).promise;
  }

  const json = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  function publicSource(source) {
    const { url, snapshotUrl, ...camera } = source;
    return { ...camera, feedType: 'image', frameUrl: `/api/cctv/frame/${encodeURIComponent(source.id)}` };
  }

  const install = (server) => {
    server.httpServer?.on('close', () => { cache.clear(); cacheBytes = 0; health.clear(); });
    server.middlewares.use('/api/cctv', async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
        const url = new URL(req.url || '/', 'http://localhost'), path = url.pathname;
        const match = /^\/(stream|frame|media)\/([^/]+)$/.exec(path);
        if (path !== '/sources' && path !== '/health' && !match) return json(res, 404, { error: 'Camera endpoint not found' });
        // Revoked providers cannot remain visible in health or frame caches.
        for (const id of cache.keys()) if (!getSources.isRegistered(id)) deleteCached(id);
        for (const id of health.keys()) if (!getSources.isRegistered(id)) health.delete(id);
        if (path === '/sources') {
          const query = cctvAreaQuery(url.searchParams);
          if (query.error) return json(res, 400, { error: query.error });
          const catalog = await getSources.getCatalog(query.area);
          return json(res, 200, { ...catalog, sources: catalog.sources.map(publicSource) });
        }
        if (path === '/health') {
          const query = cctvAreaQuery(url.searchParams);
          if (query.error) return json(res, 400, { error: query.error });
          // Health reports only cameras already requested. It never loads a pack.
          const ids = new Set(getSources.currentSources().filter((source) => !query.area || cctvDistance(source, query.area) <= query.area.radiusKm).map((source) => source.id));
          return json(res, 200, { cameras: [...health.values()].filter((camera) => ids.has(camera.id)) });
        }
        let id;
        try { id = decodeURIComponent(match[2]); } catch { return json(res, 400, { error: 'Invalid camera ID encoding' }); }
        // Camera prefixes resolve exactly one admitted provider, before any fetch.
        const source = await getSources.getById(id);
        if (!source) return json(res, 404, { error: 'Camera is not registered for this deployment' });
        if (match[1] === 'stream') {
          return json(res, 200, {
            id, feedType: 'image', mediaUrl: null,
            frameUrl: `/api/cctv/frame/${encodeURIComponent(id)}`,
            provider: source.provider, sourceKind: source.sourceKind,
          });
        }
        const frame = await getFrame(source);
        if (res.destroyed || res.writableEnded) return;
        if (!frame) return json(res, 502, { error: 'Camera snapshot unavailable' });
        res.writeHead(200, {
          'Content-Type': frame.contentType, 'Content-Length': frame.body.byteLength,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'X-CCTV-Source': 'upstream',
        });
        res.end(frame.body);
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) json(res, error?.status || 502, { error: error?.status === 503 ? 'Camera service busy' : 'Camera service unavailable' });
      }
    });
  };
  return { name: 'cctv-proxy', configureServer: install, configurePreviewServer: install };
}
