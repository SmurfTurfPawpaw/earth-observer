import { celestrakTleUrl, launchLibraryRecentUrl } from '../src/data/spaceProviderRequests.js';
import { readResponseTextCapped, readResponseJsonCapped } from '../src/sources/httpBody.js';

const GROUPS = ['stations', 'visual', 'gps-ops', 'glo-ops', 'galileo', 'geo', 'starlink'];
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** Persistent provider policy survives Worker restarts; no browser makes TLE requests. */
export function createSpaceHandler({ fetchImpl = fetch, store, env = {}, now = Date.now } = {}) {
  const memory = new Map(), pending = new Map();
  let stopped = false, launches, launchPromise, launchAttempt = -Infinity;
  async function tle(group) {
    if (!GROUPS.includes(group)) return new Response('Unsupported satellite group', { status: 400 });
    if (!store) return new Response('Satellite provider persistence is not configured', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '7200' } });
    try {
      stopped ||= Boolean((await store.get('celestrak:stopped'))?.stopped);
      let entry = memory.get(group) || await store.get(`celestrak:${group}`);
      if (entry && (typeof entry.body !== 'string' || entry.body.length > 6 * 1024 * 1024 || !Number.isFinite(entry.at))) entry = null;
      let state = 'HIT';
      if (!entry?.body || now() - entry.at >= 21600000) {
        state = 'STALE';
        if (!stopped && !pending.has(group)) {
          const refresh = (async () => {
            if (!await store.claim(`celestrak:${group}`, now(), 7200000)) return null;
            const response = await fetchImpl(celestrakTleUrl(group), { redirect: 'manual', signal: AbortSignal.timeout(20000) });
            if (response.status !== 200) {
              stopped = true;
              await store.put('celestrak:stopped', { stopped: true, at: now(), status: response.status });
              void response.body?.cancel().catch(() => {}); return null;
            }
            const body = await readResponseTextCapped(response, 6 * 1024 * 1024);
            if (!/^1 /m.test(body)) throw new Error('Invalid orbital elements');
            const fresh = { at: now(), body };
            await store.put(`celestrak:${group}`, fresh); memory.set(group, fresh); return fresh;
          })().catch(() => null).finally(() => pending.delete(group));
          pending.set(group, refresh);
        }
        const fresh = await pending.get(group);
        if (fresh) { entry = fresh; state = 'MISS'; }
      }
      return new Response(entry?.body || 'Satellite data unavailable; provider requests paused', { status: entry?.body ? 200 : 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': entry?.body ? 'public, max-age=3600' : 'no-store',
          'x-tle-cache': state, 'x-feed-age-ms': String(entry ? Math.max(0, now() - entry.at) : 0), ...(!entry?.body ? { 'retry-after': '7200' } : {}) } });
    } catch { return new Response('Satellite persistent cache unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '7200' } }); }
  }
  async function recentLaunches() {
    if ((!launches || now() - launches.at >= 900000) && now() - launchAttempt >= 60000) {
      if (!launchPromise) {
        launchAttempt = now();
        launchPromise = (async () => {
          const token = String(env.LL2_API_TOKEN || '').trim();
          const response = await fetchImpl(launchLibraryRecentUrl(new Date(now())), { signal: AbortSignal.timeout(20000), redirect: 'error',
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) } });
          if (!response.ok) throw new Error('Launch provider unavailable');
          const payload = await readResponseJsonCapped(response, 12 * 1024 * 1024);
          if (!Array.isArray(payload.results)) throw new Error('Invalid launch snapshot');
          launches = { at: now(), payload };
        })().catch(() => {}).finally(() => { launchPromise = null; });
      }
      await launchPromise;
    } else if (launchPromise) await launchPromise;
    const stale = !launches || now() - launches.at >= 900000;
    return launches ? json(launches.payload, 200, { 'cache-control': stale ? 'no-store' : 'public, max-age=900',
      'x-gev-cache': stale ? 'STALE-ERROR' : 'HIT', 'x-feed-age-ms': String(Math.max(0, now() - launches.at)) }) : json({ error: 'Launch Library 2 unavailable' }, 503, { 'retry-after': '60' });
  }
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/celestrak/')) return tle(path.slice('/api/celestrak/'.length));
    if (path === '/api/launches' || path === '/api/launches/') return recentLaunches();
    return null;
  };
}
