import { readResponseJsonCapped } from '../providers/common/http.js';
import { normalizeGdelt, safeReportUrl } from './intelligence-sources.js';
import { gdeltQueryUrl } from './gdelt-query.js';
import { validateGkgSnapshot, GKG_THEMES, gkgCoverage, gkgBatchTime } from './gdelt-gkg.js';

export const GDELT_SNAPSHOT_URL = 'https://github.com/SmurfTurfPawpaw/earth-observer/releases/download/intelligence-data/gdelt.snapshot.json';
export const GDELT_SNAPSHOT_CATEGORIES = Object.freeze(['geopolitics', 'economy', 'disasters']);
export const GDELT_SNAPSHOT_MAX_BYTES = 1024 * 1024;
const REFRESH_MS = 1800000, MAX_AGE_MS = 86400000, FUTURE_MS = 300000;
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
    if (retrieved > generated || generated - retrieved > REFRESH_MS || retrieved > nowMs + FUTURE_MS) throw new Error('Invalid GDELT snapshot retrieval window');
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
export function createGdeltSnapshotReader({ fetchImpl = fetch, now = Date.now, store, timeoutMs = 12000 } = {}) {
  let cached, pending, restoreWork, retryAt = 0, failures = 0, lastFailure = null;
  const restore = () => restoreWork ||= (async () => {
    try {
      const saved = await store?.get('gdelt:snapshot');
      if (!saved || !Number.isFinite(saved.acquiredAt) || saved.acquiredAt > now() + FUTURE_MS) return;
      cached = { acquiredAt: saved.acquiredAt, snapshot: validateGdeltSnapshot(saved.snapshot, now()) };
    } catch {} // Persistence is optional; a cache failure cannot prevent network recovery.
  })();
  async function acquire() {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(GDELT_SNAPSHOT_URL, { signal, redirect: 'follow', headers: { Accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Scheduled release unavailable'); }
      const payload = await readResponseJsonCapped(response, GDELT_SNAPSHOT_MAX_BYTES, signal);
      signal.throwIfAborted();
      const snapshot = validateGdeltSnapshot(payload, now());
      cached = { acquiredAt: now(), snapshot }; failures = 0; retryAt = 0; lastFailure = null;
      try { await store?.put('gdelt:snapshot', cached); } catch {}
    } catch (error) {
      failures = Math.min(6, failures + 1);
      retryAt = now() + Math.min(300000 * 2 ** (failures - 1), 3600000);
      lastFailure = error.name === 'TimeoutError' ? 'Scheduled release timed out' : 'Scheduled release unavailable or invalid';
    }
  }
  return async (filters) => {
    await restore();
    if ((!cached || now() - cached.acquiredAt >= REFRESH_MS) && retryAt <= now()) {
      pending ||= acquire().finally(() => { pending = null; });
    }
    if (pending) await pending;
    const generated = cached ? Date.parse(cached.snapshot.generatedAt) : null;
    const ageMs = generated === null ? null : Math.max(0, now() - generated);
    const gkg = cached?.snapshot.schemaVersion === 2;
    const batchCoverage = gkg ? gkgCoverage(cached.snapshot.coverage.processedBatches.filter((entry) => now() - Date.parse(gkgBatchTime(entry.id)) <= MAX_AGE_MS)) : null;
    const expired = ageMs !== null && ageMs > MAX_AGE_MS || gkg && !batchCoverage.processedBatches.length;
    const available = Boolean(cached && !expired);
    const sourceAgeMs = gkg && batchCoverage.processedBatches.length ? Math.max(0, now() - Date.parse(batchCoverage.windowEnd)) : ageMs;
    const stale = available && (ageMs > REFRESH_MS || sourceAgeMs > REFRESH_MS || Boolean(lastFailure));
    const local = Boolean(filters.country || filters.q);
    const coverage = gkg ? `Scheduled GDELT topic-mention sample: at most 80 links per topic from ${batchCoverage.processedBatches.length} processed 15-minute batches in a rolling 24-hour window; ${batchCoverage.sampleGaps.length} intervals missing between the sampled endpoints. Country filters match countries mentioned in the source article, not publisher country or incident location. Topic searches match reviewed theme labels and publisher domains, not article text or headlines. This is a bounded sample; no match does not establish absence.` :
      'Scheduled GDELT discovery sample: at most 80 title/link records per topic from a 24-hour query. Country and topic filters match only titles in this sample; an empty result does not establish absence or complete coverage. Publisher country is not an event location.';
    const categories = filters.category === 'all' ? GDELT_SNAPSHOT_CATEGORIES : [filters.category];
    const topic = String(filters.q || '').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    const country = String(filters.countryName || '').normalize('NFKC').toLowerCase();
    const records = available ? categories.flatMap((key) => cached.snapshot.categories[key]?.reports || []).filter((report) => {
      if (gkg && now() - Date.parse(report.indexedAt) > MAX_AGE_MS) return false;
      const text = `${report.title}${gkg ? ` ${report.source} ${report.themes.map((theme) => GKG_THEMES[theme][1]).join(' ')}` : ''}`.normalize('NFKC').toLowerCase();
      return (gkg ? !filters.country || report.mentionedCountries.includes(filters.country) : !country || text.includes(country)) && topic.every((word) => text.includes(word));
    }) : [];
    return { records, state: { ...SOURCE, status: available ? stale ? 'stale' : 'ready' : 'unavailable', stale,
      mode: gkg ? 'scheduled-gkg' : 'scheduled-snapshot', kind: gkg ? 'topic-mention' : 'article-link', generatedAt: cached?.snapshot.generatedAt || null,
      retrievedAt: cached ? gkg ? cached.snapshot.coverage.processedBatches.at(-1).retrievedAt : new Date(Math.min(...categories.map((key) => Date.parse(cached.snapshot.categories[key].retrievedAt)))).toISOString() : null,
      snapshotRetrievedAt: cached ? new Date(cached.acquiredAt).toISOString() : null,
      ageMs, sourceAgeMs, refreshIntervalMs: REFRESH_MS, retryAt: retryAt || null, coverage, filtersAppliedLocally: local,
      ...(batchCoverage ? { processedBatches: batchCoverage.processedBatches, sampleGaps: batchCoverage.sampleGaps, windowStart: batchCoverage.windowStart, windowEnd: batchCoverage.windowEnd, countryMeaning: 'country-mentioned' } : {}),
      reason: expired ? 'Scheduled GDELT snapshot exceeded the 24-hour age limit' : !available ? lastFailure || 'Scheduled GDELT snapshot unavailable' :
        [stale ? lastFailure || 'Older scheduled discovery sample' : gkg ? 'Scheduled machine-extracted topic sample' : 'Scheduled discovery sample', local ? gkg ? 'Local filters apply only to reviewed topics, domains and country mentions' : 'Local filters apply only to this bounded title sample' : 'At most 80 records per topic'].join('; ') } };
  };
}
