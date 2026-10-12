import { pluginJson } from './plugin-evidence.js';
import { validateUsgsLiveDayFacts, USGS_LIVE_DAY } from './usgs-live-day.js';
import { pluginRevision } from './live-updates.js';

export const REGIONAL_SCENE_POLICY = 'usgs-seismic-geographic-grid-v1';
export const REGIONAL_SCENE_LIMITS = Object.freeze({ bytes: 270 * 1024, entries: 16, cacheBytes: 2 * 1024 * 1024,
  cacheAgeMs: 3600000, deadlineMs: 15000, cells: 128, features: 500 });
const HASH = /^[a-f0-9]{64}$/, VIEW = /^view:[a-f0-9]{64}$/, RECEIPT = /^receipt:[a-f0-9]{64}$/;
const UTF8 = new TextEncoder(), GRIDS = [[8, 4], [32, 16], [128, 64]];
const abort = () => new DOMException('Regional scene superseded', 'AbortError');
const invalid = () => { throw new TypeError('Stored regional scene is incompatible or incomplete'); };
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = (a, b) => pluginJson(a) === pluginJson(b);
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export function regionalSelection(demand) {
  const { level, cells, mode } = demand || {};
  if (!Number.isInteger(level) || !GRIDS[level] || !['features', 'clusters'].includes(mode) || !Array.isArray(cells) || cells.length > 128) invalid();
  let previous;
  for (const cell of cells) {
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(nonnegative) || cell[0] >= GRIDS[level][0] || cell[1] >= GRIDS[level][1] ||
        previous && (cell[1] < previous[1] || cell[1] === previous[1] && cell[0] <= previous[0])) invalid();
    previous = cell;
  }
  return freeze({ level, cells: cells.map(cell => [...cell]), mode });
}
export const regionalSelectionKey = demand => pluginJson(regionalSelection(demand));

function sourceBasis(value, now) {
  if (!keys(value, ['pluginId', 'scopeId', 'receiptId', 'fence', 'factsDigest', 'rawSha256', 'artifactSha256', 'capturedAt', 'recordedAt',
    'sourceGeneratedAt', 'knowledgeMeaning']) || value.pluginId !== USGS_LIVE_DAY.pluginId || value.scopeId !== USGS_LIVE_DAY.scopeId ||
    !RECEIPT.test(value.receiptId) || !Number.isSafeInteger(value.fence) || value.fence < 1 ||
    ![value.factsDigest, value.rawSha256, value.artifactSha256].every(item => typeof item === 'string' && HASH.test(item)) ||
    ![value.capturedAt, value.recordedAt, value.sourceGeneratedAt].every(utc) || Date.parse(value.recordedAt) < Date.parse(value.capturedAt) ||
    [value.capturedAt, value.recordedAt, value.sourceGeneratedAt].some(item => Date.parse(item) > now() + 300000) ||
    typeof value.knowledgeMeaning !== 'string' || value.knowledgeMeaning.length > 256) invalid();
  return value;
}
const compatible = (source, expected) => !expected || source.fence > expected.fence || source.fence === expected.fence &&
  source.receiptId === expected.receiptId && source.factsDigest === expected.factsDigest;
function features(values) {
  if (!Array.isArray(values) || values.length > 500) invalid();
  const ids = new Set();
  for (const value of values) {
    if (!keys(value, ['id', 'revision', 'record']) || !HASH.test(value.revision) || value.id !== `earthquake:${value.record?.stableId}` || ids.has(value.id)) invalid();
    ids.add(value.id);
    validateUsgsLiveDayFacts({ schemaVersion: 1, kind: 'usgs-rolling-seismic-observations', scopeId: USGS_LIVE_DAY.scopeId,
      sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24, records: [value.record] });
  }
  return values;
}
function clusters(values, selection) {
  if (!Array.isArray(values) || values.length > 128) invalid();
  const ids = new Set(), [columns, rows] = GRIDS[selection.level], selected = new Set(selection.cells.map(cell => cell.join(':')));
  for (const value of values) {
    const match = /^seismic-cell:([012]):(\d+):(\d+)$/.exec(value?.id || '');
    if (!keys(value, ['id', 'lon', 'lat', 'bounds', 'count', 'maximumMagnitude', 'positionMeaning']) || !match || Number(match[1]) !== selection.level ||
        !selected.has(`${Number(match[2])}:${Number(match[3])}`) || ids.has(value.id) || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 500 ||
        !Number.isFinite(value.maximumMagnitude) || value.maximumMagnitude < 2.5 || value.maximumMagnitude > 10 ||
        value.positionMeaning !== 'Geographic-cell summary, not an event epicenter') invalid();
    const x = Number(match[2]), y = Number(match[3]), west = -180 + x * 360 / columns, east = west + 360 / columns,
      north = 90 - y * 180 / rows, south = north - 180 / rows;
    if (value.id !== `seismic-cell:${selection.level}:${x}:${y}` || !same(value.bounds, { west, south, east, north }) ||
        value.lon !== (west + east) / 2 || value.lat !== (south + north) / 2) invalid();
    ids.add(value.id);
  }
  return values;
}
function validateView(scene, selection, now, opaqueDigest = false) {
  if (!keys(scene, ['schemaVersion', 'kind', 'policyId', 'source', 'contentDigest', 'selection', 'selectionKey', 'version', 'features', 'clusters', 'counts', 'coverage']) ||
      scene.schemaVersion !== 1 || scene.kind !== 'prepared-usgs-regional-scene' || scene.policyId !== REGIONAL_SCENE_POLICY ||
      !(HASH.test(scene.contentDigest) || opaqueDigest && scene.contentDigest === null) ||
      !HASH.test(scene.selectionKey) || !VIEW.test(scene.version) || !same(regionalSelection(scene.selection), selection)) invalid();
  sourceBasis(scene.source, now); features(scene.features); clusters(scene.clusters, selection);
  const counts = scene.counts;
  if (!keys(counts, ['sourceReports', 'selectedReports', 'features', 'clusters']) || !Object.values(counts).every(nonnegative) ||
      counts.sourceReports > 500 || counts.selectedReports > counts.sourceReports || counts.features !== scene.features.length || counts.clusters !== scene.clusters.length ||
      selection.mode === 'features' && (scene.clusters.length || counts.selectedReports !== scene.features.length) ||
      selection.mode === 'clusters' && (scene.features.length || counts.selectedReports !== scene.clusters.reduce((sum, cell) => sum + cell.count, 0)) ||
      !keys(scene.coverage, ['selectedCellsComplete', 'sourceMembershipComplete', 'meaning']) || scene.coverage.selectedCellsComplete !== true ||
      scene.coverage.sourceMembershipComplete !== true || typeof scene.coverage.meaning !== 'string' || scene.coverage.meaning.length > 512) invalid();
  // A regional feature must really belong to one of the selected whole cells.
  const wanted = new Set(selection.cells.map(cell => cell.join(':'))), [columns, rows] = GRIDS[selection.level];
  for (const { record } of scene.features) {
    const x = Math.floor((((record.lon + 180) % 360 + 360) % 360) / 360 * columns),
      y = Math.min(rows - 1, Math.max(0, Math.floor((90 - record.lat) / 180 * rows)));
    if (!wanted.has(`${x}:${y}`)) invalid();
  }
  return scene;
}

/** Apply only a server-derived exact-base delta. The browser never invents observations or coordinates. */
export function applyRegionalSceneDelta(previous, delta, { now = Date.now } = {}) {
  if (!previous || !keys(delta, ['schemaVersion', 'kind', 'snapshotRequired', 'baseVersion', 'version', 'source', 'selectionKey', 'counts', 'coverage',
    'upsertFeatures', 'removeFeatureIds', 'upsertClusters', 'removeClusterIds', 'removalMeaning']) || delta.schemaVersion !== 1 ||
    delta.kind !== 'prepared-usgs-scene-delta' || delta.snapshotRequired !== false || delta.baseVersion !== previous.version || !VIEW.test(delta.version) ||
    delta.selectionKey !== previous.selectionKey || typeof delta.removalMeaning !== 'string' || delta.removalMeaning.length > 512) invalid();
  sourceBasis(delta.source, now);
  if (delta.source.fence < previous.source.fence || delta.source.fence === previous.source.fence && !same(delta.source, previous.source)) invalid();
  if (delta.version === previous.version && !same(delta.source, previous.source)) invalid();
  features(delta.upsertFeatures); clusters(delta.upsertClusters, previous.selection);
  if (delta.version === previous.version && (delta.upsertFeatures.length || delta.upsertClusters.length ||
      !Array.isArray(delta.removeFeatureIds) || delta.removeFeatureIds.length || !Array.isArray(delta.removeClusterIds) || delta.removeClusterIds.length ||
      !same(delta.counts, previous.counts) || !same(delta.coverage, previous.coverage))) invalid();
  const apply = (old, changed, removed) => {
    if (!Array.isArray(removed) || removed.length > 500 || removed.some(id => typeof id !== 'string') || new Set(removed).size !== removed.length) invalid();
    const values = new Map(old.map(value => [value.id, value]));
    for (const id of removed) { if (!values.has(id) || changed.some(value => value.id === id)) invalid(); values.delete(id); }
    for (const value of changed) values.set(value.id, value);
    return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  const next = { ...previous, contentDigest: delta.version === previous.version ? previous.contentDigest : null,
    version: delta.version, source: delta.source, counts: delta.counts, coverage: delta.coverage,
    features: apply(previous.features, delta.upsertFeatures, delta.removeFeatureIds), clusters: apply(previous.clusters, delta.upsertClusters, delta.removeClusterIds) };
  // Delta's source version identifies new content; contentDigest is not supplied by this transport.
  // Explicitly clear it rather than borrowing an old edition's content proof.
  return freeze(validateView(next, previous.selection, now, true));
}

export function normalizeRegionalSceneDelivery(value, demand, { base = null, now = Date.now } = {}) {
  const selection = regionalSelection(demand);
  if (!value || value.schemaVersion !== 1 || value.configured !== true || value.available !== true || value.pending !== false ||
      value.policyId !== REGIONAL_SCENE_POLICY || value.kind !== 'prepared-usgs-scene-delivery' || !['snapshot', 'delta'].includes(value.transport) ||
      typeof value.snapshotRequired !== 'boolean') invalid();
  const source = sourceBasis(value.source, now), check = value.check;
  if (check !== null && (!keys(check, ['checkedAt', 'nextCheckAt', 'lastSuccessfulAt', 'status', 'sourceGeneratedAt']) ||
      ![check.checkedAt, check.nextCheckAt, check.lastSuccessfulAt, check.sourceGeneratedAt].every(utc) ||
      [check.checkedAt, check.lastSuccessfulAt, check.sourceGeneratedAt].some(item => Date.parse(item) > now() + 300000) ||
      typeof check.status !== 'string' || !check.status || check.status.length > 80) ||
      value.stale !== null && typeof value.stale !== 'boolean' || value.sourceGenerationAgeMs !== null && (!Number.isFinite(value.sourceGenerationAgeMs) || value.sourceGenerationAgeMs < 0) ||
      check === null && (value.stale !== null || value.sourceGenerationAgeMs !== null) || check !== null &&
        (typeof value.stale !== 'boolean' || value.sourceGenerationAgeMs === null)) invalid();
  const scene = value.transport === 'snapshot' ? (value.delta === null ? validateView(value.scene, selection, now) : invalid()) :
    value.scene === null && base && !value.snapshotRequired ? applyRegionalSceneDelta(base, value.delta, { now }) : invalid();
  if (!same(scene.source, source)) invalid();
  if (base && scene.version === base.version) {
    const facts = view => ({ ...view, contentDigest: null,
      features: [...view.features].sort((a, b) => a.id.localeCompare(b.id)), clusters: [...view.clusters].sort((a, b) => a.id.localeCompare(b.id)) });
    if (!same(facts(scene), facts(base))) invalid();
  }
  return freeze({ scene, source, check, stale: value.stale, sourceGenerationAgeMs: value.sourceGenerationAgeMs, browserReadAt: now(),
    browserCache: false, pending: false });
}

async function readJson(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > REGIONAL_SCENE_LIMITS.bytes) ||
      !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body?.getReader) {
    void response.body?.cancel?.(); invalid();
  }
  const reader = response.body.getReader(), parts = []; let size = 0, count = 0, complete = false;
  const stop = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) { complete = true; break; }
      size += part.value.byteLength; if (++count > 4096 || !part.value.byteLength || size > REGIONAL_SCENE_LIMITS.bytes) invalid(); parts.push(part.value); }
    const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', stop); if (!complete) stop(); reader.releaseLock(); }
}

/** One current camera demand and bounded complete-view LRU. GETs only the fixed stored endpoint. */
export function createRegionalSceneClient({ fetchImpl = (...args) => fetch(...args), now = Date.now,
  baseUrl = import.meta.env?.BASE_URL || '/', deadlineMs = REGIONAL_SCENE_LIMITS.deadlineMs } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !['/', '/earth/'].includes(baseUrl) ||
      !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > REGIONAL_SCENE_LIMITS.deadlineMs) invalid();
  const cache = new Map(); let cacheBytes = 0, active, expected, knownSource, destroyed = false, owner = 0, selectedKey = null;
  const current = (request, signal, key) => !destroyed && active === request && !signal.aborted && selectedKey === key;
  const cached = key => {
    const entry = cache.get(key); if (!entry) return null;
    if (now() - entry.savedAt > REGIONAL_SCENE_LIMITS.cacheAgeMs || !compatible(entry.view.source, expected)) { cache.delete(key); cacheBytes -= entry.bytes; return null; }
    cache.delete(key); cache.set(key, entry); return entry;
  };
  const decorate = (entry, fromCache) => freeze({ ...entry.view, browserCache: fromCache,
    stale: fromCache || entry.view.stale || entry.view.check?.status !== 'ready' || entry.view.sourceGenerationAgeMs !== null &&
      entry.view.sourceGenerationAgeMs + Math.max(0, now() - entry.savedAt) > 120000,
    sourceGenerationAgeMs: entry.view.sourceGenerationAgeMs === null ? null : entry.view.sourceGenerationAgeMs + Math.max(0, now() - entry.savedAt),
    browserReadAt: now() });
  const put = (key, view) => {
    const bytes = UTF8.encode(pluginJson(view)).byteLength, old = cache.get(key);
    if (old) { cache.delete(key); cacheBytes -= old.bytes; }
    if (bytes > REGIONAL_SCENE_LIMITS.cacheBytes) return;
    cache.set(key, { view, bytes, savedAt: now() }); cacheBytes += bytes;
    while (cache.size > REGIONAL_SCENE_LIMITS.entries || cacheBytes > REGIONAL_SCENE_LIMITS.cacheBytes) {
      const [id, entry] = cache.entries().next().value; cache.delete(id); cacheBytes -= entry.bytes;
    }
  };
  const cancel = () => { ++owner; active?.abort(abort()); active = null; };
  return {
    select(demand) { const key = regionalSelectionKey(demand); if (key === selectedKey) return false; cancel(); selectedKey = key; return true; },
    invalidate(revision) {
      if (revision !== undefined) {
        const value = pluginRevision(revision);
        if (value?.pluginId !== USGS_LIVE_DAY.pluginId || expected && value.fence <= expected.fence) return false;
        expected = { fence: value.fence, receiptId: value.receiptId, factsDigest: value.factsDigest };
      }
      cancel(); return true;
    },
    cancel,
    async load(demand, { signal: external, onCached = () => {} } = {}) {
      if (destroyed) throw abort();
      const selection = regionalSelection(demand), key = pluginJson(selection); cancel(); selectedKey = key;
      const request = new AbortController(); active = request; const revision = owner;
      const signal = external ? AbortSignal.any([request.signal, external]) : request.signal;
      const timer = setTimeout(() => request.abort(new DOMException('Stored regional scene deadline', 'TimeoutError')), deadlineMs);
      let stop;
      const assertCurrent = () => { signal.throwIfAborted(); if (revision !== owner || !current(request, signal, key)) throw abort(); };
      try {
        const operation = (async () => {
          assertCurrent(); const prior = cached(key); if (prior) { await onCached(decorate(prior, true)); assertCurrent(); }
          for (let attempt = 0; attempt < 2; attempt++) {
            const params = new URLSearchParams({ level: String(selection.level), cells: selection.cells.map(cell => cell.join(':')).join(','), mode: selection.mode });
            if (expected) params.set('fence', String(expected.fence));
            if (prior && attempt === 0) params.set('baseVersion', prior.view.scene.version);
            assertCurrent(); const response = await fetchImpl(`${baseUrl}api/layers/earthquakes/scene?${params}`, { method: 'GET', credentials: 'omit',
              cache: 'no-store', redirect: 'error', signal }); assertCurrent();
            if (response.status === 409 || response.status === 503) {
              const value = await readJson(response, signal); assertCurrent();
              if (value?.schemaVersion !== 1 || value.available !== false || value.scene !== null || value.delta !== null) invalid();
              return freeze({ pending: true, scene: null, source: null, check: null, errorCode: value.pending === true ?
                response.status === 409 ? 'source-fence-not-ready' : 'scene-preparation-pending' : 'stored-scene-unavailable' });
            }
            if (!response.ok) { void response.body?.cancel?.(); throw new Error('Stored regional scene unavailable'); }
            const value = await readJson(response, signal); assertCurrent();
            let view;
            try { view = normalizeRegionalSceneDelivery(value, selection, { base: attempt === 0 ? prior?.view.scene : null, now }); }
            catch (error) { if (prior && attempt === 0 && value?.transport === 'delta') continue; throw error; }
            if (!compatible(view.source, expected) || knownSource && (view.source.fence < knownSource.fence ||
              view.source.fence === knownSource.fence && !same(view.source, knownSource))) invalid();
            assertCurrent(); knownSource = view.source;
            if (!expected || view.source.fence > expected.fence) expected = { fence: view.source.fence,
              receiptId: view.source.receiptId, factsDigest: view.source.factsDigest };
            put(key, view); return view;
          }
          invalid();
        })();
        const aborted = new Promise((_, reject) => { stop = () => reject(signal.reason || abort()); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
        return await Promise.race([operation, aborted]);
      } finally { clearTimeout(timer); if (stop) signal.removeEventListener('abort', stop); if (active === request) active = null; }
    },
    getState: () => ({ demandKey: selectedKey, expected: expected && { ...expected }, cacheEntries: cache.size, cacheBytes, pending: Boolean(active) }),
    destroy() { destroyed = true; cancel(); cache.clear(); cacheBytes = 0; },
  };
}
