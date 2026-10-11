import { createWindSource } from '../src/layers/wind/source.js';
import { readResponseBytesCapped, readResponseJsonCapped } from '../src/sources/httpBody.js';

const RELEASE = 'https://github.com/SmurfTurfPawpaw/earth-observer/releases/download/wind-data/';
const MAX_GRID = 3 * 1024 * 1024;
const queryFor = (model, overlay) => `model=${model}${overlay === 'none' ? '' : `&overlay=${overlay}`}`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Serve only validated scheduled NOAA/ECMWF artifacts from this project's fixed release. */
export function createWindArtifactHandler({ fetchImpl = fetch, now = Date.now, env = {} } = {}) {
  const cache = new Map(), grids = new Map(), pending = new Map(), attempts = new Map();
  const bucket = env.EARTH_STORE;
  const gridKey = (key, id) => `wind/${key}/${id}.grid.bin`;
  async function validatePair(manifest, model, overlay, key, readGrid) {
    let body;
    const published = Date.parse(manifest.publishedAt), fetchedAt = Number(manifest.fetchedAt);
    if (!/^[a-f0-9]{64}$/.test(manifest.gridSha256 || '') || !Number.isFinite(published) || published > now() + 300000 ||
        !Number.isFinite(fetchedAt) || fetchedAt > now() + 300000 || now() - fetchedAt > 72 * 3600000 ||
        !Number.isFinite(Date.parse(manifest.cycle?.runIso)) || !Number.isFinite(Date.parse(manifest.cycle?.validIso))) throw new Error('Invalid wind artifact provenance');
    const source = createWindSource({ fetchImpl: async (url) => {
      if (url.startsWith('/api/wind/manifest?')) return json(manifest);
      if (url !== manifest.gridUrl) throw new Error('Invalid wind artifact path');
      const response = await readGrid();
      if (!response.ok) throw new Error('Wind grid release unavailable');
      body = await readResponseBytesCapped(response, MAX_GRID);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((value) => value.toString(16).padStart(2, '0')).join('');
      if (digest !== manifest.gridSha256) throw new Error('Wind artifact checksum mismatch');
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
    } });
    const checked = await source.getSnapshot({ model, overlay });
    if (checked.unavailable || !body) throw new Error('Wind artifact unavailable');
    const id = /^\/api\/wind\/grid\/([\w.-]+)\.bin\?/.exec(manifest.gridUrl)?.[1];
    if (!id || id.length > 100) throw new Error('Invalid wind artifact identifier');
    const value = { at: now(), manifest, id, body };
    cache.set(key, value);
    const history = grids.get(key) || new Map();
    history.set(id, value);
    while (history.size > 2) history.delete(history.keys().next().value);
    grids.set(key, history);
    return value;
  }
  async function load(model, overlay, key) {
    attempts.set(key, now());
    try {
      const response = await fetchImpl(`${RELEASE}${key}.manifest.json`, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Wind release unavailable');
      const manifest = await readResponseJsonCapped(response, 16384);
      const value = await validatePair(manifest, model, overlay, key, () => fetchImpl(`${RELEASE}${key}.grid.bin`, { redirect: 'follow', signal: AbortSignal.timeout(20000) }));
      if (bucket) {
        try {
          await bucket.put(gridKey(key, value.id), value.body, { httpMetadata: { contentType: 'application/octet-stream' },
            customMetadata: { model, overlay, fetchedAt: String(manifest.fetchedAt), sha256: manifest.gridSha256 } });
          await bucket.put(`wind/${key}/manifest.json`, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
        } catch {} // A valid release remains usable if the optional cache is unavailable.
      }
      return value;
    } catch (failure) {
      if (!bucket) throw failure;
      const saved = await bucket.get(`wind/${key}/manifest.json`);
      if (!saved) throw failure;
      const manifest = await readResponseJsonCapped(new Response(saved.body), 16384);
      const id = /^\/api\/wind\/grid\/([\w.-]+)\.bin\?/.exec(manifest.gridUrl)?.[1];
      if (!id || !/^[\w.-]{1,100}$/.test(id)) throw failure;
      const value = await validatePair(manifest, model, overlay, key, async () => {
        const object = await bucket.get(gridKey(key, id));
        return object ? new Response(object.body) : new Response(null, { status: 404 });
      });
      value.upstreamUnavailable = true;
      return value;
    }
  }
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/wind/')) return null;
    const model = url.searchParams.get('model') || 'gfs', overlay = url.searchParams.get('overlay') || 'none';
    if (!['gfs', 'ifs'].includes(model) || !['none', 'temperature', 'pressure'].includes(overlay) ||
        [...url.searchParams.keys()].some((key) => !['model', 'overlay'].includes(key) || url.searchParams.getAll(key).length !== 1)) return json({ error: 'Invalid wind model or overlay' }, 400);
    const key = `${model}-${overlay}`;
    if (url.pathname.startsWith('/api/wind/grid/')) {
      const id = url.pathname.slice('/api/wind/grid/'.length).replace(/\.bin$/, '');
      if (url.pathname !== `/api/wind/grid/${id}.bin` || !/^[\w.-]{1,100}$/.test(id) || !id.startsWith(`${model}-`)) return json({ error: 'Wind grid unavailable' }, 404);
      let value = grids.get(key)?.get(id);
      if (!value && bucket) {
        try {
          const object = await bucket.get(gridKey(key, id));
          const stamp = Number(object?.customMetadata?.fetchedAt);
          if (object && object.customMetadata.model === model && object.customMetadata.overlay === overlay && Number.isFinite(stamp) && stamp <= now() + 300000 && now() - stamp <= 72 * 3600000) {
            const body = await readResponseBytesCapped(new Response(object.body), MAX_GRID);
            return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600, immutable', 'etag': `"${object.customMetadata.sha256}"` } });
          }
        } catch {}
      }
      if (!value) {
        if (!pending.has(key) && now() - (attempts.get(key) ?? -Infinity) >= 300000) pending.set(key, load(model, overlay, key).catch(() => null).finally(() => pending.delete(key)));
        if (pending.has(key)) await pending.get(key);
        value = grids.get(key)?.get(id);
      }
      if (!value || now() - value.manifest.fetchedAt > 72 * 3600000) return json({ error: 'Wind grid unavailable' }, 404);
      return new Response(value.body.slice(), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600, immutable', 'etag': `"${value.manifest.gridSha256}"` } });
    }
    if (!['/api/wind/manifest', '/api/wind/status'].includes(url.pathname)) return json({ error: 'Not Found' }, 404);
    let value = cache.get(key);
    if ((!value || now() - value.at >= 900000) && now() - (attempts.get(key) ?? -Infinity) >= 300000) {
      if (!pending.has(key)) pending.set(key, load(model, overlay, key).catch(() => null).finally(() => pending.delete(key)));
    }
    if (pending.has(key)) value = await pending.get(key) || value;
    if (!value || now() - value.manifest.fetchedAt > 72 * 3600000) return json({ model, schemaVersion: 1, ...(overlay !== 'none' ? { overlay } : {}), unavailable: true, stale: true,
      reason: 'Scheduled NOAA/ECMWF snapshot unavailable; the next successful publication will restore this layer' });
    const ageMs = Math.max(0, now() - value.manifest.fetchedAt);
    const manifest = { ...value.manifest, gridUrl: `/api/wind/grid/${value.id}.bin?${queryFor(model, overlay)}`,
      dataMode: 'Scheduled forecast snapshot', ageMs, retrievedAt: new Date(value.at).toISOString(),
      stale: value.upstreamUnavailable === true || ageMs > 8 * 3600000 || now() - value.at >= 900000,
      reason: value.upstreamUnavailable || now() - value.at >= 900000 ? 'Cached scheduled snapshot; release update unavailable' : ageMs > 8 * 3600000 ? 'Older scheduled forecast snapshot' : null };
    if (url.pathname.endsWith('/status')) delete manifest.gridUrl;
    return json(manifest);
  };
}
