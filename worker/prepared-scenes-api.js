import { pluginJson } from '../src/core/plugin-evidence.js';
import { PREPARED_SCENE_POLICY, PREPARED_SCENE_SOURCES, PREPARED_SCENE_LIMITS, preparedSceneSelection } from '../src/core/prepared-scene-contract.js';
import { selectPreparedScene, diffPreparedScenes } from './prepared-scene-builder.js';
import { readPreparedScene } from './prepared-scenes-store.js';
export const PREPARED_SCENES_API_PATH = '/api/layers/scenes';
export const PREPARED_SCENES_API_LIMITS = Object.freeze({ queryBytes: 2048, responseBytes: 270 * 1024, cacheEntries: 32, cacheBytes: 2 * 1024 * 1024, deadlineMs: 10000 });
const UTF8 = new TextEncoder(), fail = () => { throw new TypeError('Invalid prepared scene query'); };
const viewId = /^view:[a-f0-9]{64}$/;
function query(url) {
  if (UTF8.encode(url.search).length > 2048) fail(); const p = url.searchParams;
  for (const key of p.keys()) if (p.getAll(key).length !== 1 || !['source', 'level', 'cells', 'mode', 'baseVersion', 'fence', 'feature', 'revision', 'sourceVersion'].includes(key)) fail();
  const sourceKey = p.get('source'); if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey)) fail();
  if (p.has('feature')) {
    if ([...p.keys()].some(key => !['source', 'feature', 'revision', 'sourceVersion'].includes(key)) || !/^[a-f0-9]{64}$/.test(p.get('revision') || '') ||
        !/^(?:earthquake:[A-Za-z0-9_.:-]{1,128}|item:[a-f0-9]{64})$/.test(p.get('feature')) || !/^(?:receipt:[a-f0-9]{64}|[a-f0-9]{64})$/.test(p.get('sourceVersion') || '')) fail();
    return { sourceKey, feature: p.get('feature'), revision: p.get('revision'), sourceVersion: p.get('sourceVersion') };
  }
  if ([...p.keys()].some(key => !['source', 'level', 'cells', 'mode', 'baseVersion', 'fence'].includes(key)) || !/^[012]$/.test(p.get('level') || '') || !p.has('cells')) fail();
  const cells = p.get('cells') === '' ? [] : p.get('cells').split(',').map(cell => { if (!/^(?:0|[1-9]\d{0,2}):(?:0|[1-9]\d?)$/.test(cell)) fail(); return cell.split(':').map(Number); });
  const selection = preparedSceneSelection({ level: Number(p.get('level')), cells, mode: p.get('mode') || 'clusters' }), baseVersion = p.get('baseVersion');
  if (baseVersion !== null && !viewId.test(baseVersion)) fail(); const raw = p.get('fence'), fence = raw === null ? null : Number(raw);
  if (raw !== null && (sourceKey !== 'earthquakes' || !/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(fence))) fail();
  return { sourceKey, selection, baseVersion, fence };
}
const empty = (sourceKey, errorCode, configured = false, pending = false) => ({ schemaVersion: 1, policyId: PREPARED_SCENE_POLICY,
  sourceKey, configured, available: false, pending, kind: 'prepared-scene-delivery', source: null, check: null, stale: null,
  sourceGenerationAgeMs: null, scene: null, delta: null, errorCode });
function reply(value, status = 200, headers = {}) { const body = pluginJson(value); if (UTF8.encode(body).length > PREPARED_SCENES_API_LIMITS.responseBytes) throw new RangeError('Prepared delivery budget');
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } }); }
export function createPreparedScenesApiHandler({ now = Date.now, read = readPreparedScene, deadlineMs = 10000 } = {}) {
  if (typeof now !== 'function' || typeof read !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) throw new TypeError('Bounded prepared reader required');
  const caches = new WeakMap();
  const cacheFor = env => { const owner = env.EARTH_DB || env; let cache = caches.get(owner); if (!cache) { cache = { entries: new Map(), bytes: 0 }; caches.set(owner, cache); } return cache; };
  async function view(prepared, selection, cache, signal) {
    const key = `${prepared.version}:${Math.floor(now() / 60000)}:${pluginJson(selection)}`, hit = cache.entries.get(key);
    if (hit) { cache.entries.delete(key); cache.entries.set(key, hit); return hit.view; }
    const result = await selectPreparedScene(prepared, selection, { now, signal }), bytes = UTF8.encode(pluginJson(result)).length;
    const found = cache.entries.get(key); if (found) return found.view;
    cache.entries.set(key, { view: result, bytes }); cache.bytes += bytes;
    while (cache.entries.size > 32 || cache.bytes > 2 * 1024 * 1024) { const [old, value] = cache.entries.entries().next().value; cache.entries.delete(old); cache.bytes -= value.bytes; }
    return result;
  }
  return async (request, env = {}) => {
    const url = new URL(request.url); if (url.pathname !== PREPARED_SCENES_API_PATH) return null;
    if (request.method !== 'GET') return reply(empty(null, 'method-not-allowed'), 405, { allow: 'GET' });
    let p; try { p = query(url); } catch { return reply(empty(null, 'invalid-scene-query'), 400); }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal]), timer = setTimeout(() => controller.abort(new DOMException('Scene deadline', 'TimeoutError')), deadlineMs); let cancel;
    try {
      const operation = (async () => { signal.throwIfAborted(); const stored = await read(env, p.sourceKey, { now, signal, includePrior: Boolean(p.feature || p.baseVersion) }); signal.throwIfAborted();
        if (!stored?.available || !stored.prepared) return reply(empty(p.sourceKey, stored?.pending ? 'scene-preparation-pending' : 'stored-scene-unavailable', stored?.configured === true, stored?.pending === true), 503, { 'retry-after': '2' });
        const wrapper = { schemaVersion: 1, policyId: PREPARED_SCENE_POLICY, sourceKey: p.sourceKey, configured: true, available: true, pending: false,
          source: stored.source, check: stored.check, stale: stored.stale, sourceGenerationAgeMs: stored.sourceGenerationAgeMs };
        if (pluginJson(stored.source) !== pluginJson(stored.prepared.source)) throw new TypeError('Source mismatch');
        if (p.feature) {
          const prepared = [stored.prepared, stored.prior].filter(Boolean).find(value => (value.source.receiptId ?? value.source.version) === p.sourceVersion);
          const feature = prepared?.content.features.find(value => value.id === p.feature && value.revision === p.revision);
          if (!feature) return reply(empty(p.sourceKey, 'feature-edition-not-retained', true), 409);
          const current = prepared === stored.prepared;
          return reply({ ...wrapper, kind: 'prepared-scene-feature-delivery', current, source: prepared.source, check: current ? wrapper.check : null,
            stale: current ? wrapper.stale : null, sourceGenerationAgeMs: current ? wrapper.sourceGenerationAgeMs : null, feature });
        }
        if (p.fence !== null && stored.source.fence < p.fence) return reply(empty(p.sourceKey, 'source-fence-not-ready', true, true), 409, { 'retry-after': '2' });
        const cache = cacheFor(env), selected = await view(stored.prepared, p.selection, cache, signal);
        let previous = p.baseVersion === selected.version ? selected : null;
        // An exact prior response in this bounded LRU can include an earlier
        // interest minute. Reuse only the same selected cells/source policy.
        if (p.baseVersion && !previous) for (const item of cache.entries.values()) if (item.view.version === p.baseVersion && item.view.sourceKey === p.sourceKey &&
          [stored.prepared, stored.prior].filter(Boolean).some(candidate => pluginJson(candidate.source) === pluginJson(item.view.source)) &&
          pluginJson(item.view.selection) === pluginJson(p.selection)) { previous = item.view; break; }
        if (p.baseVersion && !previous && stored.prior) { const candidate = await view(stored.prior, p.selection, cache, signal); if (candidate.version === p.baseVersion) previous = candidate; }
        let delta = null; if (previous) { try { delta = diffPreparedScenes(previous, selected); } catch { delta = null; } }
        const isDelta = delta?.snapshotRequired === false; signal.throwIfAborted();
        return reply({ ...wrapper, kind: 'prepared-scene-delivery', transport: isDelta ? 'delta' : 'snapshot', snapshotRequired: Boolean(p.baseVersion) && !isDelta,
          ...(p.baseVersion && !isDelta ? { recoveryReason: delta?.reason || 'base-not-retained' } : {}), scene: isDelta ? null : selected, delta: isDelta ? delta : null });
      })();
      const stopped = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); });
      return await Promise.race([operation, stopped]);
    } catch (error) { return reply(empty(p.sourceKey, signal.aborted ? 'scene-read-cancelled' : error?.code === 'scene-byte-budget' ?
      'scene-byte-budget' : 'stored-scene-unavailable', error?.code === 'scene-byte-budget'), request.signal.aborted ? 408 : 503); }
    finally { clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); }
  };
}
