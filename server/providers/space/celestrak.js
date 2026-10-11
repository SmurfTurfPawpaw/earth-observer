import path from 'node:path';
import { promises as fs } from 'node:fs';
import { celestrakTleUrl } from '../../../src/data/spaceProviderRequests.js';
import { readResponseTextCapped } from '../common/http.js';

export const SATELLITE_GROUPS = Object.freeze(['stations', 'visual', 'gps-ops', 'glo-ops', 'galileo', 'geo', 'starlink']);

/** Cache follows CelesTrak's refresh interval and stops on upstream non-200. */
export function celestrakProxy({ fetchImpl = fetch, now = Date.now, cacheDir = path.join(process.cwd(), '.cache') } = {}) {
  const ttl = 6 * 3600_000;
  const retryInterval = 2 * 3600_000;
  const memory = new Map();
  const pending = new Map();
  const loads = new Map();
  let circuitLoad;
  let stopped = false;
  const circuitPath = path.join(cacheDir, 'celestrak-stopped.json');
  const file = (group) => path.join(cacheDir, `celestrak-${group}.json`);
  async function persist(target, data) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(target, JSON.stringify(data));
  }
  async function entryFor(group) {
    circuitLoad ||= fs.readFile(circuitPath, 'utf8')
      .then((body) => { stopped = Boolean(JSON.parse(body).stopped); })
      .catch(() => {});
    await circuitLoad;
    if (memory.has(group)) return memory.get(group);
    if (!loads.has(group)) loads.set(group, (async () => {
      let entry = { at: 0, attemptedAt: 0, body: '' };
      try {
        const disk = JSON.parse(await fs.readFile(file(group), 'utf8'));
        if (typeof disk.body === 'string' && disk.body.length <= 6 * 1024 * 1024 && Number.isFinite(disk.at)) entry = disk;
      } catch {}
      memory.set(group, entry);
      return entry;
    })().finally(() => loads.delete(group)));
    return loads.get(group);
  }
  async function refresh(group, entry) {
    entry.attemptedAt = now();
    try {
      await persist(file(group), entry).catch(() => {});
      const response = await fetchImpl(celestrakTleUrl(group), {
        signal: AbortSignal.timeout(20_000), redirect: 'manual',
        headers: { 'User-Agent': 'earth-observer/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' },
      });
      if (response.status !== 200) {
        stopped = true;
        await response.body?.cancel();
        await persist(circuitPath, { stopped: true, status: response.status, at: now() });
        throw new Error('CelesTrak requests stopped after upstream non-200');
      }
      const body = await readResponseTextCapped(response, 6 * 1024 * 1024);
      if (!/^1 /m.test(body)) throw new Error('Invalid TLE response');
      const fresh = { at: now(), attemptedAt: entry.attemptedAt, body };
      memory.set(group, fresh);
      await persist(file(group), fresh).catch(() => {});
      return fresh;
    } catch {
      console.warn('[celestrak] refresh unavailable; retaining cached orbital elements');
      return null;
    }
  }
  const install = ({ middlewares }) => middlewares.use('/api/celestrak', async (req, res) => {
    const group = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!SATELLITE_GROUPS.includes(group)) { res.writeHead(400); res.end('Unsupported satellite group'); return; }
    let entry = await entryFor(group);
    let state = 'HIT';
    if (!entry.body || now() - entry.at >= ttl) {
      state = 'STALE';
      if (!stopped && (!entry.attemptedAt || now() - entry.attemptedAt >= retryInterval)) {
        if (!pending.has(group)) pending.set(group, refresh(group, entry).finally(() => pending.delete(group)));
        const fresh = await pending.get(group);
        if (fresh) { entry = fresh; state = 'MISS'; }
      } else if (pending.has(group)) {
        const fresh = await pending.get(group);
        if (fresh) { entry = fresh; state = 'MISS'; }
      }
    }
    if (stopped && entry.body) state = 'STALE-ERROR';
    res.writeHead(entry.body ? 200 : 503, {
      'Content-Type': 'text/plain; charset=utf-8', 'X-TLE-Cache': state,
      'Cache-Control': entry.body ? 'public, max-age=3600' : 'no-store',
      ...(entry.body ? { 'X-Feed-Age-Ms': String(Math.max(0, now() - entry.at)),
        'X-Feed-Retrieved-At': new Date(entry.at).toISOString() } : {}),
      ...(!entry.body ? { 'Retry-After': String(retryInterval / 1000) } : {}),
    });
    res.end(entry.body || 'Satellite data unavailable; provider requests paused');
  });
  return { name: 'celestrak-proxy', configureServer: install, configurePreviewServer: install };
}
