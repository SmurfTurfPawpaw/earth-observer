import { sanitizeOverpassBody } from '../server/providers/overpass/query.js';
import { fetchOverpassPayload, overpassPayloadIsData, overpassNotConfigured } from '../server/providers/overpass/transport.js';
import { resolveOverpassUpstreams, OVERPASS_MAX_BODY_BYTES } from '../server/providers/overpass/constants.js';
import { validMilitaryInstallationBox, quantizeMilitaryInstallationBox } from '../server/providers/military-installations/query.js';
import { MILITARY_INSTALLATION_ELEMENT_CAP } from '../server/providers/military-installations/constants.js';
import { parseTerrainPoints, fetchTerrainChunkWithRetry, resolveTerrainHeightRequest } from '../src/data/terrainHeightsProxy.js';
import { readResponseTextCapped } from '../src/sources/httpBody.js';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export function createContextHandler({ env = {}, fetchImpl = fetch, now = Date.now,
  maxResponseBytes = 4 * 1024 * 1024, maxCacheBytes = 8 * 1024 * 1024 } = {}) {
  const terrain = new Map(), cache = new Map(), pending = new Map();
  let cacheBytes = 0;
  const removeCached = (key) => {
    const old = cache.get(key);
    if (old) { cacheBytes -= old.bytes; cache.delete(key); }
  };
  async function overpass(body, installation = false) {
    const endpoints = resolveOverpassUpstreams(env);
    if (!endpoints.length) { const value = overpassNotConfigured(); return new Response(value.body, { status: value.status, headers: { 'content-type': value.contentType, 'cache-control': 'no-store' } }); }
    const old = cache.get(body);
    if (old && now() - old.at < 86400000) return json(old.value, 200, { 'cache-control': 'public, max-age=60', 'x-overpass-cache': 'HIT' });
    if (!pending.has(body)) {
      if (pending.size >= 2) return json({ error: 'Mapped context busy' }, 503, { 'retry-after': '5' });
      pending.set(body, (async () => {
        const result = await fetchOverpassPayload(body, maxResponseBytes, { endpoints, fetchImpl, now });
        if (!overpassPayloadIsData(result)) return { failure: result };
        let value = JSON.parse(result.body);
        if (installation) value = { elements: value.elements.slice(0, MILITARY_INSTALLATION_ELEMENT_CAP),
          saturated: value.elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP, elementCap: MILITARY_INSTALLATION_ELEMENT_CAP, retrievedAt: new Date(now()).toISOString(), status: 'ready' };
        const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
        removeCached(body);
        if (bytes <= maxCacheBytes) {
          cache.set(body, { value, at: now(), bytes }); cacheBytes += bytes;
          while (cache.size > 40 || cacheBytes > maxCacheBytes) removeCached(cache.keys().next().value);
        }
        return { value };
      })().finally(() => pending.delete(body)));
    }
    const result = await pending.get(body);
    if (result.value) return json(result.value, 200, { 'cache-control': 'public, max-age=60', 'x-overpass-cache': 'MISS' });
    if (old && now() - old.at < 7 * 86400000) return json(installation ? { ...old.value, status: 'stale' } : old.value, 200, { 'x-overpass-cache': 'STALE', 'x-gev-cache': 'STALE-ERROR' });
    return new Response(result.failure.body, { status: result.failure.status, headers: { 'content-type': result.failure.contentType, 'cache-control': 'no-store', 'retry-after': '30' } });
  }
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/overpass' || url.pathname === '/api/overpass/') {
      if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
      let body;
      try { body = await readResponseTextCapped(new Response(request.body, { headers: request.headers }), OVERPASS_MAX_BODY_BYTES, request.signal); }
      catch { return json({ error: 'Invalid or oversized query body' }, 413); }
      const checked = sanitizeOverpassBody(body);
      return checked.ok ? overpass(checked.body) : json({ error: checked.error }, 400);
    }
    if (url.pathname === '/api/military-installations' || url.pathname === '/api/military-installations/') {
      const requested = validMilitaryInstallationBox(url.searchParams);
      if (!requested) return json({ error: 'A non-dateline bbox no larger than 10 degrees is required' }, 400);
      const box = url.searchParams.get('exact') === '1' ? requested : quantizeMilitaryInstallationBox(requested);
      const bounds = `${box.south},${box.west},${box.north},${box.east}`;
      return overpass(`data=${encodeURIComponent(`[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${bounds});nwr["landuse"="military"](${bounds}););out center tags geom ${MILITARY_INSTALLATION_ELEMENT_CAP};`)}`, true);
    }
    if (url.pathname === '/api/terrain/heights' || url.pathname === '/api/terrain/heights/') {
      const points = parseTerrainPoints(url.searchParams.get('points'));
      if (!points || points.length > 256 || points.some(([lon, lat]) => Math.abs(lon) > 180 || Math.abs(lat) > 90)) return json({ error: 'Between 1 and 256 valid lon/lat points are required' }, 400);
      const result = await resolveTerrainHeightRequest({ points, cache: terrain, ttlMs: 30 * 86400000, now,
        fetchMissing: async (missing) => {
          const values = [];
          for (let index = 0; index < missing.length; index += 64) {
            const chunk = missing.slice(index, index + 64);
            try { values.push(...await fetchTerrainChunkWithRetry(chunk, { fetchImpl, maxAttempts: 1, makeSignal: (ms) => AbortSignal.any([request.signal, AbortSignal.timeout(ms)]) })); }
            catch { for (const _point of chunk) values.push(null); }
          }
          return values;
        } });
      while (terrain.size > 20000) terrain.delete(terrain.keys().next().value);
      return json(result.body, result.status);
    }
    return null;
  };
}
