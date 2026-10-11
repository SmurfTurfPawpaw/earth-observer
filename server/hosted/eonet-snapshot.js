import { readResponseJsonCapped } from '../providers/common/http.js';

export const EONET_QUERY_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires,severeStorms,volcanoes&status=all&days=7&limit=60';
export const EONET_SNAPSHOT_URL = 'https://github.com/SmurfTurfPawpaw/earth-observer/releases/download/intelligence-data/eonet.snapshot.json';
export const EONET_SNAPSHOT_MAX_BYTES = 100 * 1024;
export const EONET_UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
export const EONET_REFRESH_MS = 1800000, EONET_MAX_AGE_MS = 86400000;
export const EONET_SOURCE = Object.freeze({ id: 'eonet', name: 'NASA EONET', url: 'https://eonet.gsfc.nasa.gov/' });
const CATEGORIES = Object.freeze({ wildfires: 'Wildfires', severeStorms: 'Severe Storms', volcanoes: 'Volcanoes' });
const FUTURE_MS = 300000;
const TIME_MEANING = 'EONET geometry and closed dates; not publication or verified incident times';
const VERIFICATION = 'Curated NASA EONET reference for visualization and general information; spatial and temporal extents may be approximate';
const NOTE = 'Bounded curated metadata sample, not a complete incident inventory. Geometry dates may precede the seven-day query window. No country or incident coordinates are inferred. Referenced publishers retain their rights; links are not independently verified reports.';
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value));
const text = (value, max) => {
  if (typeof value !== 'string') throw new Error('Invalid EONET text');
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  if (!clean) throw new Error('Empty EONET text');
  return clean;
};
function timestamp(value, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  const parts = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || value.length > 35 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid EONET timestamp');
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day); wall.setUTCHours(hour, minute, second, Number((parts[7] || '0').padEnd(3, '0')));
  if ([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()]
    .some((field, index) => field !== [year, month, day, hour, minute, second][index])) throw new Error('Invalid EONET calendar date');
  const canonical = new Date(value).toISOString();
  return canonical;
}
function sourceLink(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid EONET source URL');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe EONET source URL');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  if (url.href.length > 512) throw new Error('EONET source URL exceeds its limit');
  return url.href;
}

/** Selected metadata only. Never follow links or retain geometry coordinates/history. */
export function normalizeEonetEvent(event, retrievedAt, nowMs = Date.now()) {
  if (!event || !/^EONET_\d{1,16}$/.test(event.id || '') || !Array.isArray(event.categories) ||
      !event.categories.length || event.categories.length > 3 || !Array.isArray(event.sources) || !event.sources.length ||
      event.sources.length > 4 || !Array.isArray(event.geometry) || event.geometry.length > 10000) throw new Error('Invalid EONET event structure');
  const eonetCategories = event.categories.map((category) => {
    if (!Object.hasOwn(CATEGORIES, category?.id)) throw new Error('Unreviewed EONET category');
    return { id: category.id, title: CATEGORIES[category.id] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(eonetCategories.map((item) => item.id)).size !== eonetCategories.length) throw new Error('Duplicate EONET category');
  const referencedSources = event.sources.map((source) => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(source?.id || '')) throw new Error('Invalid EONET source identity');
    return { id: source.id, url: sourceLink(source.url) };
  }).sort((a, b) => a.id.localeCompare(b.id) || a.url.localeCompare(b.url));
  if (new Set(referencedSources.map((source) => source.id + ':' + source.url)).size !== referencedSources.length) throw new Error('Duplicate EONET source link');
  const closedAt = timestamp(event.closed, true);
  let sourceGeometryAt = null;
  for (const geometry of event.geometry) {
    if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) throw new Error('Invalid EONET geometry metadata');
    if (geometry.date === undefined || geometry.date === null) continue;
    const date = timestamp(geometry.date);
    if (Date.parse(date) > nowMs + FUTURE_MS) throw new Error('Future EONET geometry date');
    if (!sourceGeometryAt || date > sourceGeometryAt) sourceGeometryAt = date;
  }
  if (closedAt && Date.parse(closedAt) > nowMs + FUTURE_MS) throw new Error('Future EONET closed date');
  return { id: `eonet:${event.id}`, eventId: event.id, kind: 'curated-event', title: text(event.title, 160),
    url: `https://eonet.gsfc.nasa.gov/api/v3/events/${event.id}`, sourceId: 'eonet', source: EONET_SOURCE.name,
    aggregator: EONET_SOURCE.name, aggregatorUrl: EONET_SOURCE.url, category: 'disasters', eonetCategories, referencedSources,
    closedAt, sourceGeometryAt, publishedAt: null, observedAt: null, indexedAt: null,
    retrievedAt: timestamp(retrievedAt), publisherCountry: null, timeMeaning: TIME_MEANING, verification: VERIFICATION, relatedReports: [] };
}

async function generationOf(records) {
  const metadata = records.map(({ retrievedAt, ...record }) => record);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(metadata)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createEonetSnapshot(payload, { retrievedAt, generatedAt = retrievedAt, nowMs = Date.now() } = {}) {
  if (!payload || !Array.isArray(payload.events) || payload.events.length > 60) throw new Error('Invalid EONET event count');
  const records = payload.events.map((event) => normalizeEonetEvent(event, retrievedAt, nowMs)).sort((a, b) => a.eventId.localeCompare(b.eventId));
  if (new Set(records.map((record) => record.eventId)).size !== records.length) throw new Error('Duplicate EONET event identity');
  const snapshot = { schemaVersion: 1, kind: 'curated-event-sample', source: { ...EONET_SOURCE }, queryUrl: EONET_QUERY_URL,
    generatedAt: timestamp(generatedAt), retrievedAt: timestamp(retrievedAt), generation: await generationOf(records),
    coverage: { days: 7, eventLimit: 60, returnedEvents: payload.events.length, retainedEvents: records.length,
      atLimit: payload.events.length === 60, note: NOTE }, records };
  return validateEonetSnapshot(snapshot, nowMs);
}

/** Strict portable validation includes the content generation; no omitted fields regain inferred dates/location. */
export async function validateEonetSnapshot(payload, nowMs = Date.now()) {
  if (!keysAre(payload, ['schemaVersion', 'kind', 'source', 'queryUrl', 'generatedAt', 'retrievedAt', 'generation', 'coverage', 'records']) ||
      payload.schemaVersion !== 1 || payload.kind !== 'curated-event-sample' || !keysAre(payload.source, ['id', 'name', 'url']) ||
      Object.entries(EONET_SOURCE).some(([key, value]) => payload.source[key] !== value) || payload.queryUrl !== EONET_QUERY_URL ||
      !Array.isArray(payload.records) || payload.records.length > 60 || !/^[a-f0-9]{64}$/.test(payload.generation || '') ||
      !keysAre(payload.coverage, ['days', 'eventLimit', 'returnedEvents', 'retainedEvents', 'atLimit', 'note']) ||
      payload.coverage.days !== 7 || payload.coverage.eventLimit !== 60 || payload.coverage.returnedEvents !== payload.records.length ||
      payload.coverage.retainedEvents !== payload.records.length || payload.coverage.atLimit !== (payload.records.length === 60) || payload.coverage.note !== NOTE ||
      bytesOf(payload).byteLength > EONET_SNAPSHOT_MAX_BYTES) throw new Error('Invalid or oversized EONET snapshot');
  const generatedAt = timestamp(payload.generatedAt), retrievedAt = timestamp(payload.retrievedAt);
  if (generatedAt !== payload.generatedAt || retrievedAt !== payload.retrievedAt || Date.parse(generatedAt) > nowMs + FUTURE_MS ||
      Date.parse(retrievedAt) > Date.parse(generatedAt) || Date.parse(generatedAt) - Date.parse(retrievedAt) > EONET_REFRESH_MS ||
      nowMs - Date.parse(retrievedAt) >= EONET_MAX_AGE_MS) throw new Error('EONET snapshot expired or outside its retrieval window');
  const records = payload.records.map((record) => {
    if (!record || !Array.isArray(record.eonetCategories) || !Array.isArray(record.referencedSources) || record.retrievedAt !== retrievedAt) throw new Error('Invalid EONET snapshot record');
    const canonical = normalizeEonetEvent({ id: record.eventId, title: record.title, categories: record.eonetCategories,
      sources: record.referencedSources, closed: record.closedAt, geometry: record.sourceGeometryAt === null ? [] : [{ date: record.sourceGeometryAt }] }, retrievedAt, nowMs);
    if (!keysAre(record, Object.keys(canonical)) || Object.keys(canonical).some((key) => JSON.stringify(record[key]) !== JSON.stringify(canonical[key]))) throw new Error('Invalid EONET record provenance');
    return canonical;
  });
  if (new Set(records.map((record) => record.eventId)).size !== records.length || records.some((record, index) => index && records[index - 1].eventId.localeCompare(record.eventId) >= 0) ||
      await generationOf(records) !== payload.generation) throw new Error('Invalid EONET content generation');
  return { ...payload, source: { ...EONET_SOURCE }, records, coverage: { ...payload.coverage } };
}

/** Shared fixed release acquisition. Visitor filters never reach EONET or linked publishers. */
export function createEonetSnapshotReader({ fetchImpl = fetch, now = Date.now, store, timeoutMs = 12000, storageTimeoutMs = 1000 } = {}) {
  let cached, pending, restoreWork, retryAt = 0, failures = 0, lastFailure = null;
  const storageDeadlineMs = Number.isFinite(storageTimeoutMs) ? Math.max(1, Math.min(5000, storageTimeoutMs)) : 1000;
  const optionalStorage = async (task) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(task).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), storageDeadlineMs); })]);
    } finally { clearTimeout(timer); }
  };
  const restore = () => restoreWork ||= (async () => {
    const restored = await optionalStorage(async () => {
      const saved = await store?.get('eonet:snapshot');
      if (!saved || !Number.isFinite(saved.acquiredAt) || saved.acquiredAt > now() + FUTURE_MS) return;
      return { acquiredAt: saved.acquiredAt, snapshot: await validateEonetSnapshot(saved.snapshot, now()) };
    });
    // Timed-out work has no cache side effects, even when the store settles later.
    if (restored && !cached) cached = restored;
  })();
  async function acquire() {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(EONET_SNAPSHOT_URL, { signal, redirect: 'follow', headers: { Accept: 'application/json' } });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const retryMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
        await response.body?.cancel();
        throw Object.assign(new Error('Scheduled EONET release unavailable'), { httpStatus: response.status,
          retryAfterMs: Number.isFinite(retryMs) ? Math.max(0, Math.min(EONET_MAX_AGE_MS, retryMs)) : 0 });
      }
      const payload = await readResponseJsonCapped(response, EONET_SNAPSHOT_MAX_BYTES, signal);
      signal.throwIfAborted();
      const snapshot = await validateEonetSnapshot(payload, now()); signal.throwIfAborted();
      cached = { acquiredAt: now(), snapshot }; failures = 0; retryAt = 0; lastFailure = null;
      const saved = cached;
      await optionalStorage(() => store?.put('eonet:snapshot', saved));
    } catch (error) {
      failures = Math.min(6, failures + 1);
      retryAt = now() + Math.max(Math.min(300000 * 2 ** (failures - 1), 3600000), error.retryAfterMs || 0);
      lastFailure = error.httpStatus === 429 ? 'Scheduled EONET release rate limit (HTTP 429)' : error.name === 'TimeoutError' ? 'Scheduled EONET release timed out' : 'Scheduled EONET release unavailable or invalid';
    }
  }
  return async (filters = {}) => {
    const applicable = !filters.country && (!filters.category || ['all', 'disasters'].includes(filters.category));
    if (applicable) {
      await restore();
      if ((!cached || now() - cached.acquiredAt >= EONET_REFRESH_MS) && retryAt <= now()) pending ||= acquire().finally(() => { pending = null; });
      if (pending) await pending;
    }
    const snapshot = cached?.snapshot, retrieved = snapshot ? Date.parse(snapshot.retrievedAt) : null;
    const ageMs = retrieved === null ? null : Math.max(0, now() - retrieved);
    const expired = ageMs !== null && ageMs >= EONET_MAX_AGE_MS;
    const available = Boolean(applicable && snapshot && !expired);
    const stale = available && (ageMs >= EONET_REFRESH_MS || Boolean(lastFailure));
    const status = !applicable ? 'not-applicable' : available ? stale ? 'stale' : 'ready' : 'unavailable';
    const coverage = `Scheduled NASA EONET reference: at most 60 selected wildfire, severe-storm and volcano events matching a seven-day query. ${NOTE}`;
    const records = available ? snapshot.records : [];
    return { records, indexRecords: records, indexSource: { id: 'eonet', generation: applicable ? snapshot?.generation || 'unavailable' : 'not-applicable', status,
      expiresAt: retrieved === null ? null : new Date(retrieved + EONET_MAX_AGE_MS).toISOString(), coverage },
      state: { ...EONET_SOURCE, status, stale, mode: 'scheduled-eonet', kind: 'curated-event', generatedAt: snapshot?.generatedAt || null,
        retrievedAt: snapshot?.retrievedAt || null, snapshotRetrievedAt: cached ? new Date(cached.acquiredAt).toISOString() : null,
        ageMs, refreshIntervalMs: EONET_REFRESH_MS, retryAt: retryAt || null, coverage, countriesAvailable: false,
        atLimit: available ? snapshot.coverage.atLimit : null, retainedEvents: records.length,
        reason: !applicable ? filters.country ? 'EONET supplies no authoritative country tags; country-filtered discovery excludes this source' : 'EONET natural-event references apply only to disasters' :
          expired ? 'Scheduled EONET retrieval exceeded the 24-hour age limit' : !available ? lastFailure || 'Scheduled EONET snapshot unavailable' : stale ? lastFailure || 'Older scheduled EONET sample' : 'Bounded curated natural-event reference; linked sources are not independent confirmation' } };
  };
}
