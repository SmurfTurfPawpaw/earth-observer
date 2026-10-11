import { readResponseJsonCapped } from '../providers/common/http.js';
import { normalizeGdelt, safeReportUrl } from './intelligence-sources.js';
import { gdeltQueryUrl } from './gdelt-query.js';
import { validateGkgSnapshot, gkgCoverage, gkgBatchTime } from './gdelt-gkg.js';
import { createDiscoveryIndex } from '../../src/core/discovery-index.js';

export const GDELT_SNAPSHOT_URL = 'https://github.com/SmurfTurfPawpaw/earth-observer/releases/download/intelligence-data/gdelt.snapshot.json';
export const GDELT_SNAPSHOT_CATEGORIES = Object.freeze(['geopolitics', 'economy', 'disasters']);
export const GDELT_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const GDELT_RELEASE_CHECK_INTERVAL_MS = 60000;
const RETRIEVAL_WINDOW_MS = 1800000, STALE_AGE_MS = 1800000, MAX_AGE_MS = 86400000, FUTURE_MS = 300000;
const safeEtag = (value) => typeof value === 'string' && value.length <= 256 && /^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(value) ? value : null;
const SOURCE = Object.freeze({ id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' });
const REPORT_KEYS = new Set(['id', 'title', 'url', 'sourceId', 'source', 'aggregator', 'aggregatorUrl', 'category',
  'publishedAt', 'observedAt', 'indexedAt', 'retrievedAt', 'timeMeaning', 'publisherCountry', 'language', 'verification', 'relatedReports']);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const stamp = (value) => {
  if (typeof value !== 'string' || value.length > 32 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Invalid GDELT snapshot timestamp');
  return Date.parse(value);
};
const boundedText = (value, max, nullable = false) => nullable && value === null || typeof value === 'string' &&
  value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Accept only the fixed queries and normalized metadata; no article bodies, images or invented locations. */
export function validateGdeltSnapshot(payload, nowMs = Date.now()) {
  if (payload?.schemaVersion === 2) return validateGkgSnapshot(payload, nowMs);
  if (!object(payload) || payload.schemaVersion !== 1 || !object(payload.source) ||
      Object.entries(SOURCE).some(([key, value]) => payload.source[key] !== value) ||
      !object(payload.coverage) || payload.coverage.timespan !== '24h' || payload.coverage.maxRecordsPerCategory !== 80 ||
      !Array.isArray(payload.coverage.categories) || payload.coverage.categories.length !== 3 ||
      new Set(payload.coverage.categories).size !== 3 || GDELT_SNAPSHOT_CATEGORIES.some((key) => !payload.coverage.categories.includes(key)) ||
      !object(payload.categories) || Object.keys(payload.categories).length !== 3) throw new Error('Invalid GDELT snapshot schema');
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > GDELT_SNAPSHOT_MAX_BYTES) throw new Error('GDELT snapshot exceeds its byte limit');
  const generated = stamp(payload.generatedAt);
  if (generated > nowMs + FUTURE_MS || nowMs - generated > MAX_AGE_MS) throw new Error('GDELT snapshot is expired or future-dated');
  const categories = {};
  for (const category of GDELT_SNAPSHOT_CATEGORIES) {
    const entry = payload.categories[category];
    if (!object(entry) || entry.queryUrl !== gdeltQueryUrl({ category }) || !Array.isArray(entry.reports) || entry.reports.length > 80) throw new Error('Invalid GDELT snapshot category');
    const retrieved = stamp(entry.retrievedAt);
    if (retrieved > generated || generated - retrieved > RETRIEVAL_WINDOW_MS || retrieved > nowMs + FUTURE_MS) throw new Error('Invalid GDELT snapshot retrieval window');
    const seen = new Set();
    const reports = entry.reports.map((report) => {
      if (!object(report) || Object.keys(report).some((key) => !REPORT_KEYS.has(key)) ||
          report.sourceId !== 'gdelt' || report.category !== category || report.publishedAt !== null || report.observedAt !== null ||
          !Array.isArray(report.relatedReports) || report.relatedReports.length || report.retrievedAt !== entry.retrievedAt ||
          !boundedText(report.title, 300) || !report.title || !boundedText(report.publisherCountry, 80, true) ||
          !boundedText(report.language, 40, true) || safeReportUrl(report.url) !== report.url ||
          seen.has(report.url)) throw new Error('Invalid GDELT snapshot report metadata');
      if (report.indexedAt !== null) {
        const indexed = stamp(report.indexedAt);
        if (indexed > retrieved + FUTURE_MS || retrieved - indexed > MAX_AGE_MS + FUTURE_MS) throw new Error('Invalid GDELT indexing timestamp');
      }
      const canonical = normalizeGdelt({ articles: [{ url: report.url, title: report.title, seendate: report.indexedAt,
        sourcecountry: report.publisherCountry, language: report.language }] }, entry.retrievedAt, category)[0];
      if (!canonical || ['id', 'source', 'aggregator', 'aggregatorUrl', 'timeMeaning', 'verification'].some((key) => canonical[key] !== report[key])) throw new Error('Invalid GDELT report provenance');
      seen.add(report.url); return canonical;
    });
    categories[category] = { queryUrl: entry.queryUrl, retrievedAt: entry.retrievedAt, reports };
  }
  return { schemaVersion: 1, generatedAt: payload.generatedAt, source: { ...SOURCE }, categories,
    coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: [...GDELT_SNAPSHOT_CATEGORIES],
      note: 'Bounded discovery sample; GDELT indexing time is not publication time. Original publishers retain their rights; no article text or images are copied.' } };
}

/** One shared release acquisition for every visitor filter, with optional persistent last-good state. */
export function createGdeltSnapshotReader({ fetchImpl = fetch, now = Date.now, store, timeoutMs = 12000, storageTimeoutMs = 1000 } = {}) {
  let cached, pending, restoreWork, retryAt = 0, failures = 0, lastFailure = null;
  const index = createDiscoveryIndex({ now, maxRecords: 240, maxBytes: GDELT_SNAPSHOT_MAX_BYTES });
  const storageDeadlineMs = Number.isFinite(storageTimeoutMs) ? Math.max(1, Math.min(5000, storageTimeoutMs)) : 1000;
  const optionalStorage = async (task) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(task).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), storageDeadlineMs); })]);
    } finally { clearTimeout(timer); }
  };
  const readSaved = () => optionalStorage(async () => {
    const saved = await store?.get('gdelt:snapshot');
    if (!saved || !Number.isFinite(saved.acquiredAt) || saved.acquiredAt > now() + FUTURE_MS) return;
    const checkedAt = saved.checkedAt ?? saved.acquiredAt;
    if (!Number.isFinite(checkedAt) || checkedAt < saved.acquiredAt || checkedAt > now() + FUTURE_MS) return;
    return { acquiredAt: saved.acquiredAt, checkedAt, etag: safeEtag(saved.etag), snapshot: validateGdeltSnapshot(saved.snapshot, now()) };
  });
  const restore = () => restoreWork ||= (async () => {
    const restored = await readSaved();
    // Timed-out persistence has no side effects if it eventually settles.
    if (restored && !cached) cached = restored;
  })();
  async function acquire() {
    try {
      const claimed = await optionalStorage(() => store?.claim?.('gdelt:release-check', now(), GDELT_RELEASE_CHECK_INTERVAL_MS));
      if (claimed === false) {
        // Another instance owns the bounded check. Reuse its completed publication when available.
        const saved = await readSaved();
        const previousGenerated = cached ? Date.parse(cached.snapshot.generatedAt) : -Infinity;
        if (saved && (Date.parse(saved.snapshot.generatedAt) > previousGenerated ||
            Date.parse(saved.snapshot.generatedAt) === previousGenerated && saved.checkedAt >= (cached.checkedAt ?? cached.acquiredAt))) {
          cached = saved; failures = 0; lastFailure = null;
        }
        // Retry a shared-state read soon if the owner has not finished, without another network acquisition.
        retryAt = cached && now() - (cached.checkedAt ?? cached.acquiredAt) < GDELT_RELEASE_CHECK_INTERVAL_MS ? 0 : now() + 1000;
        return;
      }
      const signal = AbortSignal.timeout(timeoutMs);
      const etag = safeEtag(cached?.etag);
      const response = await fetchImpl(GDELT_SNAPSHOT_URL, { signal, redirect: 'follow', headers: {
        Accept: 'application/json', 'Cache-Control': 'no-cache', ...(etag ? { 'If-None-Match': etag } : {}),
      } });
      if (response.status === 304) {
        await response.body?.cancel(); signal.throwIfAborted();
        if (!cached || !etag) throw new Error('Unexpected unchanged release response');
        validateGdeltSnapshot(cached.snapshot, now());
        // Revalidation changes the check clock, never generation or retrieval provenance.
        cached = { ...cached, checkedAt: now() };
      } else {
        if (!response.ok) { await response.body?.cancel(); throw new Error('Scheduled release unavailable'); }
        const payload = await readResponseJsonCapped(response, GDELT_SNAPSHOT_MAX_BYTES, signal);
        signal.throwIfAborted();
        const snapshot = validateGdeltSnapshot(payload, now()), acquiredAt = now();
        cached = { acquiredAt, checkedAt: acquiredAt, etag: safeEtag(response.headers.get('etag')), snapshot };
      }
      failures = 0; retryAt = 0; lastFailure = null;
      const saved = cached;
      await optionalStorage(() => store?.put('gdelt:snapshot', saved));
    } catch (error) {
      failures = Math.min(6, failures + 1);
      retryAt = now() + Math.min(300000 * 2 ** (failures - 1), 3600000);
      lastFailure = error.name === 'TimeoutError' ? 'Scheduled release timed out' : 'Scheduled release unavailable or invalid';
    }
  }
  return async (filters) => {
    await restore();
    if ((!cached || now() - (cached.checkedAt ?? cached.acquiredAt) >= GDELT_RELEASE_CHECK_INTERVAL_MS) && retryAt <= now()) {
      pending ||= acquire().finally(() => { pending = null; });
    }
    if (pending) await pending;
    const generated = cached ? Date.parse(cached.snapshot.generatedAt) : null;
    const ageMs = generated === null ? null : Math.max(0, now() - generated);
    const gkg = cached?.snapshot.schemaVersion === 2;
    const batchCoverage = gkg ? gkgCoverage(cached.snapshot.coverage.processedBatches.filter((entry) => now() - Date.parse(gkgBatchTime(entry.id)) <= MAX_AGE_MS), cached.snapshot.coverage.catchup) : null;
    const expired = ageMs !== null && ageMs > MAX_AGE_MS || gkg && !batchCoverage.processedBatches.length;
    const available = Boolean(cached && !expired);
    const sourceAgeMs = gkg && batchCoverage.processedBatches.length ? Math.max(0, now() - Date.parse(batchCoverage.windowEnd)) : ageMs;
    const stale = available && (ageMs > STALE_AGE_MS || sourceAgeMs > STALE_AGE_MS || Boolean(lastFailure));
    const local = Boolean(filters.country || filters.q);
    const coverage = gkg ? `Scheduled GDELT topic-mention sample: at most 80 links per topic from ${batchCoverage.processedBatches.length} processed 15-minute batches in a rolling 24-hour window; ${batchCoverage.sampleGaps.length} intervals missing between the sampled endpoints. Country filters match countries mentioned in the source article, not publisher country or incident location. Topic searches match reviewed theme labels and publisher domains, not article text or headlines. This is a bounded sample; no match does not establish absence.` :
      'Scheduled GDELT discovery sample: at most 80 title/link records per topic from a 24-hour query. Country and topic filters match only titles in this sample; an empty result does not establish absence or complete coverage. Publisher country is not an event location.';
    const categories = filters.category === 'all' ? GDELT_SNAPSHOT_CATEGORIES : [filters.category];
    const status = available ? stale ? 'stale' : 'ready' : 'unavailable';
    const indexSource = { id: 'gdelt', generation: cached?.snapshot.generatedAt || 'unavailable', status, coverage,
      expiresAt: generated === null ? null : new Date(generated + MAX_AGE_MS).toISOString() };
    index.replaceSource({ ...indexSource, records: available ? GDELT_SNAPSHOT_CATEGORIES.flatMap((key) => cached.snapshot.categories[key]?.reports || []) : [] });
    const indexed = index.getState(), records = index.search({ ...filters, limit: 240 }).reports;
    return { records, indexRecords: indexed.records, indexSource, indexVersion: indexed.indexVersion, state: { ...SOURCE, status, stale,
      mode: gkg ? 'scheduled-gkg' : 'scheduled-snapshot', kind: gkg ? 'topic-mention' : 'article-link', generatedAt: cached?.snapshot.generatedAt || null,
      retrievedAt: cached ? gkg ? cached.snapshot.coverage.processedBatches.at(-1).retrievedAt : new Date(Math.min(...categories.map((key) => Date.parse(cached.snapshot.categories[key].retrievedAt)))).toISOString() : null,
      snapshotRetrievedAt: cached ? new Date(cached.acquiredAt).toISOString() : null,
      snapshotCheckedAt: cached ? new Date(cached.checkedAt ?? cached.acquiredAt).toISOString() : null,
      ageMs, sourceAgeMs, refreshIntervalMs: GDELT_RELEASE_CHECK_INTERVAL_MS, sourceCadenceMs: 900000, retryAt: retryAt || null, coverage, filtersAppliedLocally: local,
      ...(batchCoverage ? { processedBatches: batchCoverage.processedBatches, sampleGaps: batchCoverage.sampleGaps, windowStart: batchCoverage.windowStart, windowEnd: batchCoverage.windowEnd, countryMeaning: 'country-mentioned' } : {}),
      ...(batchCoverage?.catchup ? { catchup: batchCoverage.catchup } : {}),
      reason: expired ? 'Scheduled GDELT snapshot exceeded the 24-hour age limit' : !available ? lastFailure || 'Scheduled GDELT snapshot unavailable' :
        [stale ? lastFailure || 'Older scheduled discovery sample' : gkg ? 'Scheduled machine-extracted topic sample' : 'Scheduled discovery sample', local ? gkg ? 'Local filters apply only to reviewed topics, domains and country mentions' : 'Local filters apply only to this bounded title sample' : 'At most 80 records per topic'].join('; ') } };
  };
}
