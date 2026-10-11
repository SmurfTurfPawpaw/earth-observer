import snapshot from '../src/data/local_data/firms/snapshot.json' with { type: 'json' };
import { filterTrailing24h, parseFirmsCsv } from '../src/data/firmsCsv.js';
import { readResponseTextCapped } from '../src/sources/httpBody.js';

const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
const TTL = 1800000;
export function createFirmsHandler({ env = {}, fetchImpl = fetch, now = Date.now } = {}) {
  let cache, pending, attempted = -Infinity;
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== '/api/firms' && path !== '/api/firms/' && path !== '/api/firms/status') return null;
    const key = String(env.FIRMS_MAP_KEY || '').trim();
    let payload;
    if (!key) payload = { ...snapshot, snapshot: true, stale: true, ttlMs: null };
    else {
      if ((!cache || now() - cache.at >= TTL) && now() - attempted >= 300000) {
        pending ||= (async () => {
          attempted = now();
          const sources = [], fires = [];
          for (const source of SOURCES) {
            try {
              const response = await fetchImpl(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`, { signal: AbortSignal.timeout(25000), redirect: 'error' });
              if (!response.ok) throw new Error('Fire provider unavailable');
              const parsed = parseFirmsCsv(await readResponseTextCapped(response, 16 * 1024 * 1024));
              if (!parsed) throw new Error('Invalid fire observations');
              const records = filterTrailing24h(parsed, now());
              for (const record of records.slice(0, Math.max(0, 150000 - fires.length))) fires.push(record);
              sources.push({ source, ok: true, count: records.length });
            } catch { sources.push({ source, ok: false, count: 0 }); }
          }
          if (sources.some((source) => source.ok)) cache = { at: now(), sources, fires };
        })().finally(() => { pending = null; });
      }
      await pending;
      if (!cache) return new Response('{"error":"NASA FIRMS live observations unavailable"}', { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '300' } });
      const fires = filterTrailing24h(cache.fires, now());
      payload = { snapshot: false, mode: 'live', fetchedAt: cache.at, stale: now() - cache.at >= TTL, ttlMs: TTL, sources: cache.sources, count: fires.length, fires,
        coverage: 'NASA FIRMS active-fire observations; source gaps apply; bounded to 150,000 records' };
    }
    if (path.endsWith('/status')) payload = { ...payload, hasKey: Boolean(key), lastFetch: payload.fetchedAt, fires: undefined, transactions: null };
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  };
}
