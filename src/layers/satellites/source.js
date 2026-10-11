const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

// Display bounds chosen by this application, not guarantees of orbital accuracy.
export const MAX_ELEMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ELEMENT_FUTURE_MS = 24 * 60 * 60 * 1000;
export const SOURCE_CACHE_WINDOW_MS = 6 * 60 * 60 * 1000;

export function satelliteElementEpochMs(satellite) {
  const jd = satellite?.satrec?.jdsatepoch;
  const epoch = Number.isFinite(jd) ? (jd - 2440587.5) * 86400000 : NaN;
  return Number.isFinite(epoch) && epoch > 0 && epoch < 8640000000000000 - MAX_ELEMENT_AGE_MS
    ? Math.round(epoch)
    : null;
}

/** Only admits elements to the present-day display; SGP4 itself stays a pure API. */
export function isSatelliteElementSupported(satellite, at = Date.now()) {
  const epoch = satelliteElementEpochMs(satellite);
  return epoch !== null && Number.isFinite(at) &&
    at - epoch < MAX_ELEMENT_AGE_MS && epoch - at <= MAX_ELEMENT_FUTURE_MS;
}

export function satelliteProvenance(satellite, at = Date.now(), sourceAt = at) {
  const epoch = satelliteElementEpochMs(satellite);
  const source = satellite?.source || {};
  const parsedRetrieval = typeof source.retrievedAt === 'string'
    ? Date.parse(source.retrievedAt) : NaN;
  const retrieval = Number.isFinite(parsedRetrieval) && parsedRetrieval <= sourceAt + 300000
    ? parsedRetrieval : null;
  const checked = source.checkedAt ? Date.parse(source.checkedAt) : NaN;
  const reportedAge = Number.isFinite(source.reportedAgeMs) && source.reportedAgeMs >= 0
    ? source.reportedAgeMs + (Number.isFinite(checked) ? Math.max(0, sourceAt - checked) : 0) : null;
  const sourceAgeMs = retrieval === null ? reportedAge
    : Math.max(0, sourceAt - retrieval, reportedAge || 0);
  const elementStatus = epoch === null ? 'missing-epoch'
    : epoch - at > MAX_ELEMENT_FUTURE_MS ? 'future-epoch'
      : at - epoch >= MAX_ELEMENT_AGE_MS ? 'expired' : 'supported';
  const sourceStatus = retrieval === null ? 'unknown'
    : source.available === false || source.stale === true || ['STALE', 'STALE-ERROR'].includes(source.cacheStatus) || sourceAgeMs >= SOURCE_CACHE_WINDOW_MS
      ? 'stale' : 'cached';
  return {
    positionKind: 'SGP4 prediction',
    sourceGroup: source.group || null,
    sourceCacheStatus: source.cacheStatus || 'UNKNOWN',
    browserCacheStatus: source.browserCacheStatus || null,
    sourceStatus,
    sourceRetrievedAt: retrieval === null ? null : new Date(retrieval).toISOString(),
    sourceAgeMs,
    elementEpoch: epoch === null ? null : new Date(epoch).toISOString(),
    elementAgeMs: epoch === null ? null : at - epoch,
    elementStatus,
    elementExpiresAt: epoch === null ? null : new Date(epoch + MAX_ELEMENT_AGE_MS).toISOString(),
    maxElementAgeMs: MAX_ELEMENT_AGE_MS,
  };
}

export function satelliteSourceMetadata(result, group) {
  return {
    group,
    available: result.ok === true,
    cacheStatus: result.cacheStatus || 'UNKNOWN',
    retrievedAt: result.retrievedAt || null,
    reportedAgeMs: Number.isFinite(result.ageMs) ? result.ageMs : null,
    checkedAt: result.checkedAt || null,
    browserCacheStatus: result.browserCacheStatus || null,
    stale: result.stale === true || !result.retrievedAt,
  };
}

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak/${group}`, { signal });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      const checkedAtMs = now();
      const header = (name) => response.headers?.get?.(name);
      const cacheStatus = String(header('x-tle-cache') || 'UNKNOWN').toUpperCase();
      const browserCacheStatus = header('x-browser-cache') || null;
      const retrievalHeader = header('x-feed-retrieved-at');
      const retrieval = retrievalHeader ? Date.parse(retrievalHeader) : NaN;
      const retrievedAt = Number.isFinite(retrieval) && retrieval <= checkedAtMs + 300000
        ? new Date(retrieval).toISOString() : null;
      const reportedAge = header('x-feed-age-ms');
      const httpAge = Number(header('age') || 0) * 1000;
      const reportedAgeMs = reportedAge !== null && reportedAge !== undefined && Number.isFinite(Number(reportedAge)) && Number(reportedAge) >= 0
        ? Number(reportedAge) + (Number.isFinite(httpAge) && httpAge >= 0 ? httpAge : 0) : null;
      const ageMs = retrievedAt ? Math.max(0, checkedAtMs - retrieval, reportedAgeMs || 0) : reportedAgeMs;
      const stale = ['STALE', 'STALE-ERROR'].includes(cacheStatus) || ['STALE', 'OFFLINE'].includes(browserCacheStatus)
        || header('x-gev-cache') === 'STALE-ERROR' || !retrievedAt || ageMs >= SOURCE_CACHE_WINDOW_MS;
      return { ok: response.ok, status: response.status, text, stale, cacheStatus,
        retrievedAt, ageMs, browserCacheStatus, checkedAt: new Date(checkedAtMs).toISOString() };
    },
  };
}
