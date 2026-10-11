import { readResponseJsonCapped } from '../providers/common/http.js';

const MAX_ENTRIES = 96;
const TTL_MS = 30_000;
const COOLDOWN_MS = 60_000;

/** Shared, bounded adsb.lol snapshots; no OpenSky or aircraft enrichment. */
export function aircraftProxy({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  let cacheBytes = 0;
  const pending = new Map();
  const failures = new Map();
  const install = ({ middlewares }) => {
    async function handle(req, res, military) {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      let upstream;
      if (military) upstream = 'https://api.adsb.lol/v2/mil';
      else {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!url.searchParams.has('lat') || !url.searchParams.has('lon') ||
            !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Valid lat and lon are required' })); return;
        }
        if (url.searchParams.has('radiusKm')) {
          const radiusKm = Number(url.searchParams.get('radiusKm'));
          if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 250) {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'radiusKm must be between 1 and 250' })); return;
          }
          // Share nearby requests on a ~5 km grid; padding keeps the requested circle covered.
          const roundedLat = Math.round(lat * 20) / 20, roundedLon = Math.round(lon * 20) / 20;
          const miles = Math.ceil((radiusKm + 4) / 1.852);
          upstream = `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${miles}`;
        } else upstream = `https://api.adsb.lol/v2/lat/${Math.round(lat * 2) / 2}/lon/${Math.round(lon * 2) / 2}/dist/250`;
      }
      let entry = cache.get(upstream);
      let state = 'HIT';
      if (!entry || now() - entry.at >= TTL_MS) {
        if ((failures.get(upstream) || 0) <= now()) {
          if (!pending.has(upstream)) {
            if (pending.size >= 8) {
              res.writeHead(503, { 'Retry-After': '5', 'Cache-Control': 'no-store' });
              res.end('Aircraft feed busy'); return;
            }
            const request = (async () => {
              const response = await fetchImpl(upstream, {
                signal: AbortSignal.timeout(12_000), redirect: 'error',
                headers: { 'User-Agent': 'earth-observer/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' },
              });
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Upstream HTTP ${response.status}`);
              }
              const payload = await readResponseJsonCapped(response, 8 * 1024 * 1024);
              if (!Array.isArray(payload.ac)) throw new Error('Invalid aircraft snapshot');
              const body = JSON.stringify(payload);
              const fresh = { at: now(), body, bytes: new TextEncoder().encode(body).byteLength };
              cacheBytes -= cache.get(upstream)?.bytes || 0;
              cache.delete(upstream); cache.set(upstream, fresh);
              cacheBytes += fresh.bytes;
              failures.delete(upstream);
              while (cache.size > MAX_ENTRIES || cacheBytes > 32 * 1024 * 1024) {
                const oldest = cache.keys().next().value;
                cacheBytes -= cache.get(oldest).bytes;
                cache.delete(oldest);
              }
              return fresh;
            })().catch(() => {
              failures.set(upstream, now() + COOLDOWN_MS);
              while (failures.size > MAX_ENTRIES) failures.delete(failures.keys().next().value);
              return null;
            }).finally(() => pending.delete(upstream));
            pending.set(upstream, request);
          }
          const fresh = await pending.get(upstream);
          if (fresh) { entry = fresh; state = 'MISS'; }
          else state = 'STALE';
        } else state = 'STALE';
      }
      if (!entry) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '60', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Aircraft feed temporarily unavailable' })); return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15',
        'X-Feed-Source': 'adsb.lol', 'X-Feed-Cache': state,
        'X-Feed-Age-Ms': String(Math.max(0, now() - entry.at)),
      });
      res.end(entry.body);
    }
    middlewares.use('/api/flights', (req, res) => handle(req, res, false));
    middlewares.use('/api/military', (req, res) => handle(req, res, true));
  };
  return { name: 'hosted-aircraft', configureServer: install, configurePreviewServer: install };
}
