import { pluginJson, pluginFactsDigest } from '../src/core/plugin-evidence.js';
import { PREPARED_SCENE_SOURCES } from '../src/core/prepared-scene-contract.js';
import { FOCUS_SCENE_POLICY, FOCUS_SCENE_LIMITS, focusSceneSelection } from '../src/core/focus-scene-contract.js';
import { selectFocusScene, diffFocusScenes, focusClusterMembers } from './focus-scene-builder.js';
import { readPreparedScene } from './prepared-scenes-store.js';
export const FOCUS_SCENES_API_PATH = '/api/layers/focus-scenes';
export const FOCUS_SCENES_API_LIMITS = Object.freeze({ queryBytes: 4096, responseBytes: 128 * 1024, cacheEntries: 32, cacheBytes: 2 * 1024 * 1024, deadlineMs: 10000 });
const UTF8 = new TextEncoder(), invalid = () => { throw new TypeError('Invalid bounded focus selection'); };
const leaf = value => { if (!/^(?:[0-9]|1[0-8]):(?:0|[1-9]\d{0,6}):(?:0|[1-9]\d{0,6})$/.test(value)) invalid(); return value.split(':').map(Number); };
function query(url) {
  if (UTF8.encode(url.search).length > 4096) invalid(); const p = url.searchParams;
  const member = p.has('cluster');
  const allowed = member ? ['source', 'cells', 'focus', 'featureBudget', 'sourceVersion', 'viewVersion', 'asOf', 'cluster', 'limit', 'cursor'] :
    ['source', 'cells', 'focus', 'featureBudget', 'baseVersion', 'fence'];
  for (const key of p.keys()) if (p.getAll(key).length !== 1 || !allowed.includes(key)) invalid();
  const sourceKey = p.get('source'); if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) || !p.get('cells') || !p.get('focus') || !/^[0-6]$/.test(p.get('featureBudget') || '')) invalid();
  const selection = focusSceneSelection({ schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves: p.get('cells').split(',').map(leaf),
    focus: leaf(p.get('focus')), featureBudget: Number(p.get('featureBudget')) }), baseVersion = p.get('baseVersion'), rawFence = p.get('fence');
  if (member) {
    const sourceVersion = p.get('sourceVersion'), viewVersion = p.get('viewVersion'), asOf = p.get('asOf'), cluster = p.get('cluster'), cursor = p.get('cursor');
    if (!(sourceKey === 'earthquakes' ? /^receipt:[a-f0-9]{64}$/.test(sourceVersion || '') : /^[a-f0-9]{64}$/.test(sourceVersion || '')) ||
        !/^view:[a-f0-9]{64}$/.test(viewVersion || '') || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/.test(asOf || '') ||
        !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf ||
        !new RegExp(`^focus-cell:${sourceKey}:(?:[0-9]|1[0-8]):\\d{1,7}:\\d{1,7}:(?:seismic|flood|cyclone|volcano|wildfire|drought|notice)$`).test(cluster || '') ||
        cursor !== null && !/^members:[a-f0-9]{64}:(?:0|[1-9]\d{0,2})$/.test(cursor) ||
        p.has('limit') && !/^(?:[1-9]|[1-4]\d|50)$/.test(p.get('limit'))) invalid();
    return { sourceKey, selection, sourceVersion, viewVersion, asOf, cluster, limit: p.has('limit') ? Number(p.get('limit')) : 50, cursor };
  }
  if (baseVersion !== null && !/^view:[a-f0-9]{64}$/.test(baseVersion) || rawFence !== null &&
    (sourceKey !== 'earthquakes' || !/^[1-9]\d{0,15}$/.test(rawFence) || !Number.isSafeInteger(Number(rawFence)))) invalid();
  return { sourceKey, selection, baseVersion, fence: rawFence === null ? null : Number(rawFence) };
}
function empty(sourceKey, errorCode, configured = false, pending = false) { return { schemaVersion: 2, kind: 'focus-scene-delivery', policyId: FOCUS_SCENE_POLICY,
  sourceKey, configured, available: false, pending, source: null, check: null, stale: null, sourceGenerationAgeMs: null, scene: null, delta: null, errorCode }; }
function reply(value, status = 200, extra = {}) { const body = pluginJson(value); if (UTF8.encode(body).length > FOCUS_SCENE_LIMITS.deliveryBytes) throw Object.assign(new RangeError('Focus delivery budget'), { code: 'scene-byte-budget' });
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } }); }
export function createFocusScenesApiHandler({ now = Date.now, read = readPreparedScene, deadlineMs = 10000 } = {}) {
  if (typeof now !== 'function' || typeof read !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) throw new TypeError('Use bounded stored scene delivery');
  const caches = new WeakMap();
  const cacheFor = env => { const owner = env.EARTH_DB || env; let cache = caches.get(owner); if (!cache) { cache = { entries: new Map(), bytes: 0 }; caches.set(owner, cache); } return cache; };
  async function view(prepared, selection, cache, signal) {
    const key = `${prepared.version}:${Math.floor(now() / 60000)}:${pluginJson(selection)}`, hit = cache.entries.get(key);
    if (hit) { cache.entries.delete(key); cache.entries.set(key, hit); return hit.view; }
    const result = await selectFocusScene(prepared, selection, { now, signal }), bytes = UTF8.encode(pluginJson(result)).length;
    const found = cache.entries.get(key); if (found) return found.view; cache.entries.set(key, { view: result, bytes }); cache.bytes += bytes;
    while (cache.entries.size > 32 || cache.bytes > 2 * 1024 * 1024) { const [old, entry] = cache.entries.entries().next().value; cache.entries.delete(old); cache.bytes -= entry.bytes; }
    return result;
  }
  return async (request, env = {}) => {
    const url = new URL(request.url); if (url.pathname !== FOCUS_SCENES_API_PATH) return null;
    if (request.method !== 'GET') return reply(empty(null, 'method-not-allowed'), 405, { allow: 'GET' });
    let p; try { p = query(url); } catch { return reply(empty(null, 'invalid-focus-query'), 400); }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal]);
    const timer = setTimeout(() => controller.abort(new DOMException('Focus scene deadline', 'TimeoutError')), deadlineMs); let cancel;
    try {
      const operation = (async () => { signal.throwIfAborted();
        if (p.cluster && (Date.parse(p.asOf) > Math.floor(now() / 60000) * 60000 || now() - Date.parse(p.asOf) > 3600000))
          return reply({ ...empty(p.sourceKey, 'focus-view-expired', true), refreshRequired: true }, 409);
        const stored = await read(env, p.sourceKey, { now, signal, includePrior: Boolean(p.baseVersion || p.cluster) }); signal.throwIfAborted();
        if (!stored?.available || !stored.prepared) return reply(empty(p.sourceKey, stored?.pending ? 'scene-preparation-pending' : 'stored-scene-unavailable', stored?.configured === true, stored?.pending === true), 503, { 'retry-after': '2' });
        if (stored.prepared.sourceKey !== p.sourceKey || pluginJson(stored.source) !== pluginJson(stored.prepared.source)) throw new TypeError('Focus source mismatch');
        const wrapper = { schemaVersion: 2, kind: 'focus-scene-delivery', policyId: FOCUS_SCENE_POLICY, sourceKey: p.sourceKey,
          configured: true, available: true, pending: false, source: stored.source, check: stored.check, stale: stored.stale, sourceGenerationAgeMs: stored.sourceGenerationAgeMs };
        if (p.cluster) {
          const prepared = [stored.prepared, stored.prior].filter(Boolean).find(candidate => (candidate.source.receiptId ?? candidate.source.version) === p.sourceVersion);
          if (!prepared) return reply({ ...empty(p.sourceKey, 'focus-source-edition-not-retained', true), refreshRequired: true }, 409);
          const pinned = await selectFocusScene(prepared, p.selection, { now: () => Date.parse(p.asOf), signal });
          if (pinned.version !== p.viewVersion) return reply({ ...empty(p.sourceKey, 'focus-view-mismatch', true), refreshRequired: true }, 409);
          const members = focusClusterMembers(prepared, pinned, p.cluster);
          if (!members) return reply({ ...empty(p.sourceKey, 'focus-cluster-not-retained', true), refreshRequired: true }, 409);
          const scope = await pluginFactsDigest([p.sourceKey, p.sourceVersion, pinned.version, p.cluster]), prefix = `members:${scope}:`;
          if (p.cursor && !p.cursor.startsWith(prefix)) return reply({ ...empty(p.sourceKey, 'focus-member-cursor-mismatch', true), refreshRequired: true }, 409);
          const offset = p.cursor ? Number(p.cursor.slice(prefix.length)) : 0;
          if (offset > members.length) return reply({ ...empty(p.sourceKey, 'focus-member-cursor-mismatch', true), refreshRequired: true }, 409);
          const page = members.slice(offset, offset + p.limit); signal.throwIfAborted();
          return reply({ schemaVersion: 2, kind: 'focus-members-delivery', policyId: FOCUS_SCENE_POLICY, sourceKey: p.sourceKey,
            configured: true, available: true, pending: false, source: prepared.source, sourceVersion: p.sourceVersion,
            viewVersion: pinned.version, clusterId: p.cluster, count: members.length, returned: page.length, members: page,
            nextCursor: offset + page.length < members.length ? `${prefix}${offset + page.length}` : null,
            asOf: p.asOf, meaning: 'Exact residual members of this retained source/display edition; asOf is display-priority evaluation, not historical world knowledge' });
        }
        if (p.fence !== null && stored.source.fence < p.fence) return reply(empty(p.sourceKey, 'source-fence-not-ready', true, true), 409, { 'retry-after': '2' });
        const cache = cacheFor(env), selected = await view(stored.prepared, p.selection, cache, signal); let previous = p.baseVersion === selected.version ? selected : null;
        if (p.baseVersion && !previous) for (const item of cache.entries.values()) if (item.view.version === p.baseVersion && item.view.sourceKey === p.sourceKey &&
          pluginJson(item.view.selection) === pluginJson(p.selection) && [stored.prepared, stored.prior].filter(Boolean).some(candidate => pluginJson(candidate.source) === pluginJson(item.view.source))) { previous = item.view; break; }
        if (p.baseVersion && !previous && stored.prior) { const prior = await view(stored.prior, p.selection, cache, signal); if (prior.version === p.baseVersion) previous = prior; }
        let delta = null; if (previous) { try { delta = diffFocusScenes(previous, selected); } catch { /* Full bounded snapshot is the recovery. */ } }
        const isDelta = delta?.snapshotRequired === false; signal.throwIfAborted();
        return reply({ ...wrapper, transport: isDelta ? 'delta' : 'snapshot', snapshotRequired: Boolean(p.baseVersion) && !isDelta,
          ...(p.baseVersion && !isDelta ? { recoveryReason: delta?.reason || 'base-not-retained' } : {}), scene: isDelta ? null : selected, delta: isDelta ? delta : null });
      })();
      const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); });
      return await Promise.race([operation, aborted]);
    } catch (error) { return reply(empty(p.sourceKey, signal.aborted ? 'scene-read-cancelled' : error?.code === 'scene-byte-budget' ? 'scene-byte-budget' :
      'stored-scene-unavailable', error?.code === 'scene-byte-budget'), request.signal.aborted ? 408 : 503); }
    finally { clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); }
  };
}
