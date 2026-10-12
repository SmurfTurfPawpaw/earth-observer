import { readPreparedUsgsScene } from './prepared-usgs-store.js';
import { selectPreparedUsgsCells, diffPreparedUsgsViews, PREPARED_USGS_POLICY } from './prepared-usgs-scene.js';
import { pluginJson } from '../src/core/plugin-evidence.js';

export const PREPARED_USGS_API_PATH = '/api/layers/earthquakes/scene';
export const PREPARED_USGS_API_LIMITS = Object.freeze({ queryBytes: 2048, responseBytes: 270 * 1024,
  deadlineMs: 10000, cacheEntries: 32, cacheBytes: 2 * 1024 * 1024 });
const UTF8 = new TextEncoder(), HASH = '[a-f0-9]{64}';
const VIEW = new RegExp(`^view:${HASH}$`), RECEIPT = new RegExp(`^receipt:${HASH}$`), REVISION = new RegExp(`^${HASH}$`);
const FEATURE = /^earthquake:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GRIDS = [{ columns: 8, rows: 4 }, { columns: 32, rows: 16 }, { columns: 128, rows: 64 }];
const invalid = () => { throw new TypeError('Invalid bounded prepared scene query'); };
const stopped = () => new DOMException('Prepared scene delivery canceled', 'AbortError');
function query(url) {
  if (UTF8.encode(url.search).byteLength > PREPARED_USGS_API_LIMITS.queryBytes) invalid();
  const params = url.searchParams;
  for (const key of params.keys()) if (params.getAll(key).length !== 1) invalid();
  if (params.has('feature')) {
    if ([...params.keys()].some(key => !['feature', 'revision', 'receipt'].includes(key)) ||
        !FEATURE.test(params.get('feature')) || !REVISION.test(params.get('revision') || '') || !RECEIPT.test(params.get('receipt') || '')) invalid();
    return { feature: params.get('feature'), revision: params.get('revision'), receipt: params.get('receipt') };
  }
  if ([...params.keys()].some(key => !['level', 'cells', 'mode', 'baseVersion', 'fence'].includes(key)) ||
      !/^[012]$/.test(params.get('level') || '') || !params.has('cells')) invalid();
  const level = Number(params.get('level')), mode = params.get('mode') ?? 'clusters', raw = params.get('cells');
  if (!['clusters', 'features'].includes(mode)) invalid();
  const cells = raw === '' ? [] : raw.split(',').map(value => {
    if (!/^(?:0|[1-9]\d{0,2}):(?:0|[1-9]\d?)$/.test(value)) invalid();
    return value.split(':').map(Number);
  });
  if (cells.length > 128 || cells.some(([x, y], index) => x >= GRIDS[level].columns || y >= GRIDS[level].rows ||
      index > 0 && (y < cells[index - 1][1] || y === cells[index - 1][1] && x <= cells[index - 1][0]))) invalid();
  const baseVersion = params.get('baseVersion');
  if (baseVersion !== null && !VIEW.test(baseVersion)) invalid();
  const rawFence = params.get('fence'), fence = rawFence === null ? null : Number(rawFence);
  if (rawFence !== null && (!/^[1-9]\d{0,15}$/.test(rawFence) || !Number.isSafeInteger(fence))) invalid();
  return { selection: { level, cells, mode }, baseVersion, fence };
}
function response(value, status = 200, extraHeaders = {}) {
  const body = pluginJson(value);
  if (UTF8.encode(body).byteLength > PREPARED_USGS_API_LIMITS.responseBytes) throw new Error('Prepared scene response exceeds its bound');
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...extraHeaders } });
}
const unavailable = (errorCode, configured = false, pending = false) => ({ schemaVersion: 1, configured, available: false,
  pending, policyId: PREPARED_USGS_POLICY, source: null, check: null, stale: null, sourceGenerationAgeMs: null,
  scene: null, delta: null, errorCode });
function basis(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.configured !== 'boolean' || typeof value.available !== 'boolean' ||
      typeof value.pending !== 'boolean' || value.policyId !== PREPARED_USGS_POLICY) throw new Error('Stored scene envelope is unavailable');
  return { schemaVersion: 1, configured: value.configured, available: value.available, pending: value.pending,
    policyId: PREPARED_USGS_POLICY, source: value.source ?? null, check: value.check ?? null,
    stale: value.stale ?? null, sourceGenerationAgeMs: value.sourceGenerationAgeMs ?? null };
}

/** Public stored delivery only. Preparation and provider acquisition remain owner-wake operations. */
export function createPreparedUsgsApiHandler({ now = Date.now, read = readPreparedUsgsScene,
  deadlineMs = PREPARED_USGS_API_LIMITS.deadlineMs } = {}) {
  if (typeof now !== 'function' || typeof read !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PREPARED_USGS_API_LIMITS.deadlineMs)
    throw new TypeError('Use a bounded prepared scene reader');
  const caches = new WeakMap();
  const cacheFor = env => {
    const owner = env?.EARTH_DB || env;
    if (!owner || typeof owner !== 'object') return null;
    let cache = caches.get(owner);
    if (!cache) { cache = { entries: new Map(), bytes: 0 }; caches.set(owner, cache); }
    return cache;
  };
  async function selectedView(prepared, selection, cache, signal) {
    signal.throwIfAborted();
    const key = `${prepared.version}:${pluginJson(selection)}`, hit = cache?.entries.get(key);
    if (hit) { cache.entries.delete(key); cache.entries.set(key, hit); return { view: hit.view, hit: true }; }
    const view = await selectPreparedUsgsCells(prepared, selection); signal.throwIfAborted();
    const completed = cache?.entries.get(key);
    if (completed) { cache.entries.delete(key); cache.entries.set(key, completed); return { view: completed.view, hit: true }; }
    const bytes = UTF8.encode(pluginJson(view)).byteLength;
    if (cache && bytes <= PREPARED_USGS_API_LIMITS.cacheBytes) {
      cache.entries.set(key, { view, bytes }); cache.bytes += bytes;
      while (cache.entries.size > PREPARED_USGS_API_LIMITS.cacheEntries || cache.bytes > PREPARED_USGS_API_LIMITS.cacheBytes) {
        const [oldest, entry] = cache.entries.entries().next().value; cache.entries.delete(oldest); cache.bytes -= entry.bytes;
      }
    }
    return { view, hit: false };
  }
  return async (request, env = {}) => {
    const url = new URL(request.url);
    if (url.pathname !== PREPARED_USGS_API_PATH) return null;
    if (request.method !== 'GET') return response(unavailable('method-not-allowed'), 405, { allow: 'GET' });
    let parsed;
    try { parsed = query(url); } catch { return response(unavailable('invalid-scene-query'), 400); }
    const controller = new AbortController(), abortRequest = () => controller.abort(stopped());
    if (request.signal.aborted) abortRequest(); else request.signal.addEventListener('abort', abortRequest, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Prepared scene deadline', 'TimeoutError')), deadlineMs);
    let stop;
    const signal = controller.signal;
    try {
      const operation = (async () => {
        signal.throwIfAborted();
        const stored = await read(env, { now, signal, includePrior: Boolean(parsed.feature || parsed.baseVersion) });
        signal.throwIfAborted(); const wrapper = basis(stored);
        if (!wrapper.configured || !wrapper.available) return response({ ...wrapper, scene: null, delta: null,
          errorCode: wrapper.pending ? 'scene-preparation-pending' : 'stored-scene-unavailable' }, 503, { 'retry-after': '2' });
        if (!stored.prepared || pluginJson(stored.prepared.source) !== pluginJson(wrapper.source)) throw new Error('Stored scene basis mismatch');
        if (parsed.feature) {
          const candidates = [stored.prepared, stored.prior].filter(Boolean);
          const prepared = candidates.find(value => value.source.receiptId === parsed.receipt);
          const feature = prepared?.content.features.find(value => value.id === parsed.feature && value.revision === parsed.revision);
          if (!feature) return response({ ...unavailable('feature-edition-not-retained', true), snapshotRequired: true }, 409);
          const current = prepared === stored.prepared;
          return response({ ...wrapper, kind: 'prepared-usgs-feature-delivery', current, source: prepared.source,
            check: current ? wrapper.check : null, stale: current ? wrapper.stale : null,
            sourceGenerationAgeMs: current ? wrapper.sourceGenerationAgeMs : null, feature });
        }
        if (parsed.fence !== null && wrapper.source.fence < parsed.fence)
          return response({ ...wrapper, available: false, pending: true, scene: null, delta: null, errorCode: 'source-fence-not-ready' }, 409, { 'retry-after': '2' });
        const cache = cacheFor(env), selected = await selectedView(stored.prepared, parsed.selection, cache, signal);
        let previous = selected.view.version === parsed.baseVersion ? selected.view : null;
        if (parsed.baseVersion && !previous && stored.prior) {
          const prior = await selectedView(stored.prior, parsed.selection, cache, signal);
          if (prior.view.version === parsed.baseVersion) previous = prior.view;
        }
        signal.throwIfAborted();
        const delta = previous ? diffPreparedUsgsViews(previous, selected.view) : null;
        const isDelta = delta?.snapshotRequired === false;
        return response({ ...wrapper, kind: 'prepared-usgs-scene-delivery', transport: isDelta ? 'delta' : 'snapshot',
          snapshotRequired: Boolean(parsed.baseVersion) && !isDelta,
          ...(parsed.baseVersion && !isDelta ? { recoveryReason: delta?.reason || 'base-not-retained' } : {}),
          scene: isDelta ? null : selected.view, delta: isDelta ? delta : null }, 200, { 'x-earth-view-cache': selected.hit ? 'HIT' : 'MISS' });
      })();
      const canceled = new Promise((_, reject) => { stop = () => reject(signal.reason || stopped());
        signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
      return await Promise.race([operation, canceled]);
    } catch {
      return response(unavailable(request.signal.aborted ? 'scene-request-canceled' : signal.aborted ? 'scene-deadline' : 'stored-scene-unavailable'),
        request.signal.aborted ? 408 : 503);
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abortRequest); if (stop) signal.removeEventListener('abort', stop); }
  };
}
