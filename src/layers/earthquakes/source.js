import { createBrowserStore } from '../../core/browser-store.js';
import { pluginFactsDigest, pluginJson } from '../../core/plugin-evidence.js';
import { USGS_LIVE_DAY, validateUsgsLiveDayFacts, usgsLiveDayOverview } from '../../core/usgs-live-day.js';
import { pluginRevision } from '../../core/live-updates.js';

export const EARTHQUAKE_CACHE_KEY = 'source:usgs-live-day-m2-5:v1';
export const EARTHQUAKE_SOURCE_LIMITS = Object.freeze({ bytes: 160 * 1024, deadlineMs: 15000, cacheReadMs: 120, cacheAgeMs: 3600000 });
const DIGEST = /^[a-f0-9]{64}$/, RECEIPT = /^receipt:[a-f0-9]{64}$/, FUTURE_MS = 300000;
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = () => { throw new TypeError('Stored seismic evidence is incompatible or incomplete'); };
const clone = value => JSON.parse(JSON.stringify(value));
const revisionOf = value => ({ receiptId: value.receipt.id, fence: value.receipt.fence, factsDigest: value.receipt.factsDigest });
const compatible = (value, expected) => !expected || value.receipt.fence > expected.fence ||
  value.receipt.fence === expected.fence && value.receipt.id === expected.receiptId && value.receipt.factsDigest === expected.factsDigest;

/** Validate the current, complete stored cohort. No provider request is possible here. */
export async function validateStoredEarthquakeSnapshot(value, { now = Date.now, signal } = {}) {
  signal?.throwIfAborted();
  if (!value || value.schemaVersion !== 1 || value.configured !== true || value.available !== true || value.knownAt !== null ||
    value.plugin?.id !== USGS_LIVE_DAY.pluginId || value.plugin.scopeId !== USGS_LIVE_DAY.scopeId || value.plugin.kind !== USGS_LIVE_DAY.kind ||
    value.plugin.sourceUrl !== USGS_LIVE_DAY.sourceUrl || value.scope?.id !== USGS_LIVE_DAY.scopeId || value.scope.sourceId !== 'usgs' ||
    value.scope.minimumMagnitude !== 2.5 || value.scope.windowHours !== 24 || value.coverage?.complete !== true ||
    !Array.isArray(value.records) || value.coverage.recordCount !== value.records.length) invalid();
  if (new TextEncoder().encode(pluginJson(value)).byteLength > EARTHQUAKE_SOURCE_LIMITS.bytes) invalid();
  const receipt = value.receipt, check = value.check, current = now();
  if (!receipt || !RECEIPT.test(receipt.id) || value.version !== receipt.id || !Number.isSafeInteger(receipt.fence) || receipt.fence < 1 ||
    ![receipt.factsDigest, receipt.rawSha256, receipt.artifactSha256].every(item => typeof item === 'string' && DIGEST.test(item)) ||
    ![receipt.capturedAt, receipt.recordedAt, receipt.sourceUpdatedAt].every(utc) ||
    Date.parse(receipt.recordedAt) < Date.parse(receipt.capturedAt) ||
    [receipt.capturedAt, receipt.recordedAt, receipt.sourceUpdatedAt].some(item => Date.parse(item) > current + FUTURE_MS) ||
    receipt.sourceVersion !== null && (typeof receipt.sourceVersion !== 'string' || receipt.sourceVersion.length > 2048) ||
    !check || ![check.checkedAt, check.nextCheckAt, check.lastSuccessfulAt, check.sourceGeneratedAt].every(utc) ||
    [check.checkedAt, check.lastSuccessfulAt, check.sourceGeneratedAt].some(item => Date.parse(item) > current + FUTURE_MS) ||
    typeof check.status !== 'string' || !check.status || check.status.length > 80 || typeof value.stale !== 'boolean' ||
    ![value.factualEditionAgeMs, value.retainedSourceGenerationAgeMs, value.sourceGenerationAgeMs].every(item => Number.isFinite(item) && item >= 0)) invalid();
  const facts = validateUsgsLiveDayFacts({ schemaVersion: 1, kind: 'usgs-rolling-seismic-observations', scopeId: USGS_LIVE_DAY.scopeId,
    sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24, records: value.records });
  const byType = new Map(); for (const record of facts.records) byType.set(record.eventType, (byType.get(record.eventType) || 0) + 1);
  const featureCount = value.overview?.sourceFeatureCount;
  if (!Number.isSafeInteger(featureCount) || featureCount < facts.records.length || featureCount > USGS_LIVE_DAY.features) invalid();
  const overview = usgsLiveDayOverview({ canonicalFacts: facts, sourceGeneratedAt: receipt.sourceUpdatedAt, sourceFeatureCount: featureCount,
    countsBySourceType: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => String(a.type).localeCompare(String(b.type))) });
  if (pluginJson(overview) !== pluginJson(value.overview) || await pluginFactsDigest(facts) !== receipt.factsDigest) invalid();
  signal?.throwIfAborted();
  return clone({ ...value, records: facts.records, overview });
}

async function readBody(response, signal) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > EARTHQUAKE_SOURCE_LIMITS.bytes)) {
    void response.body?.cancel?.(); throw new Error('Stored seismic response exceeds its size limit');
  }
  if (!response.body?.getReader) throw new Error('Stored seismic response has no bounded body');
  const reader = response.body.getReader(), parts = []; let size = 0, chunks = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) { complete = true; break; }
      size += value.byteLength;
      if (++chunks > 4096 || !value.byteLength || size > EARTHQUAKE_SOURCE_LIMITS.bytes) throw new Error('Stored seismic response exceeds its size limit'); parts.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', abort); if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function bounded(work, signal, timeoutMs) {
  signal.throwIfAborted(); let timer, onAbort;
  const stop = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new Error('Browser source cache unavailable')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), stop])
    .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
}

/** One validated device cache, one stored GET, and one current layer-owned callback. */
export function createUsgsEarthquakeSource({ fetchImpl = (...args) => globalThis.fetch(...args), store = createBrowserStore(), now = Date.now,
  baseUrl = import.meta.env?.BASE_URL || '/', deadlineMs = EARTHQUAKE_SOURCE_LIMITS.deadlineMs } = {}) {
  if (!['/', '/earth/'].includes(baseUrl)) throw new TypeError('Use the reviewed Earth application base');
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > EARTHQUAKE_SOURCE_LIMITS.deadlineMs) throw new TypeError('Use a bounded source deadline');
  const endpoint = `${baseUrl}api/layers/earthquakes`; let active, expected, memory;
  const decorate = (snapshot, savedAt, cached) => {
    const elapsed = Math.max(0, now() - savedAt);
    return { ...clone(snapshot), factualEditionAgeMs: snapshot.factualEditionAgeMs + elapsed,
      retainedSourceGenerationAgeMs: snapshot.retainedSourceGenerationAgeMs + elapsed, sourceGenerationAgeMs: snapshot.sourceGenerationAgeMs + elapsed,
      stale: snapshot.stale || snapshot.check.status !== 'ready' || snapshot.sourceGenerationAgeMs + elapsed > 120000,
      browserCachedAt: cached ? savedAt : null, browserCache: cached ? 'STALE' : null, browserReadAt: now() };
  };
  return {
    invalidate(revision) {
      if (revision !== undefined) {
        const reviewed = pluginRevision(revision);
        if (reviewed?.pluginId !== USGS_LIVE_DAY.pluginId || expected && reviewed.fence <= expected.fence) return false;
        expected = { receiptId: reviewed.receiptId, fence: reviewed.fence, factsDigest: reviewed.factsDigest };
      }
      active?.abort(new DOMException('A newer source edition is available', 'AbortError')); return true;
    },
    async getSnapshot({ signal: external, onCached } = {}) {
      active?.abort(); const owner = new AbortController(); active = owner;
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new DOMException('Stored source deadline exceeded', 'TimeoutError')), deadlineMs);
      const signal = AbortSignal.any([owner.signal, deadline.signal, external].filter(Boolean));
      try {
        signal.throwIfAborted();
        if (typeof onCached === 'function') {
          try {
            const cached = memory || await bounded(() => store.get(EARTHQUAKE_CACHE_KEY), signal, EARTHQUAKE_SOURCE_LIMITS.cacheReadMs);
            signal.throwIfAborted();
            if (cached?.schemaVersion === 1 && Number.isFinite(cached.savedAt) && cached.savedAt <= now() && now() - cached.savedAt <= EARTHQUAKE_SOURCE_LIMITS.cacheAgeMs) {
              const snapshot = await bounded(() => validateStoredEarthquakeSnapshot(cached.snapshot, { now, signal }), signal);
              if (compatible(snapshot, expected)) {
                expected = revisionOf(snapshot); signal.throwIfAborted(); await onCached(decorate(snapshot, cached.savedAt, true)); signal.throwIfAborted();
              }
            }
          } catch (error) { signal.throwIfAborted(); /* Restricted, expired or corrupt local cache never blocks the stored read. */ }
        }
        const response = await bounded(async () => {
          const received = await fetchImpl(endpoint, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } });
          if (signal.aborted) { void received.body?.cancel?.(); signal.throwIfAborted(); } return received;
        }, signal);
        signal.throwIfAborted();
        if (!response.ok) { void response.body?.cancel?.(); throw new Error(`Stored seismic source unavailable (HTTP ${response.status})`); }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.('content-type') || '')) { void response.body?.cancel?.(); throw new Error('Stored seismic source has an incompatible content type'); }
        const snapshot = await bounded(async () => validateStoredEarthquakeSnapshot(await readBody(response, signal), { now, signal }), signal);
        signal.throwIfAborted(); if (!compatible(snapshot, expected)) throw new Error('Stored seismic edition is older than its published update');
        expected = revisionOf(snapshot); const savedAt = now(); memory = { schemaVersion: 1, savedAt, snapshot };
        signal.throwIfAborted(); try { void Promise.resolve(store.put(EARTHQUAKE_CACHE_KEY, clone(memory))).catch(() => {}); } catch { /* Device storage is optional. */ }
        return decorate(snapshot, savedAt, false);
      } finally { clearTimeout(timer); if (active === owner) active = null; }
    },
  };
}
