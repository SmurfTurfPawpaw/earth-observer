import { readResponseJsonCapped } from '../providers/common/http.js';
import { ECONOMICS_INDICATORS, economicsCountry } from '../../src/core/economics-catalog.js';

const DAY = 86400_000;
const SAVED_MAX_BYTES = 64 * 1024;
const SAVED_KEYS = new Set(['schemaVersion', 'country', 'retrievedAt', 'datasetUpdatedDate', 'observations']);
const OBSERVATION_KEYS = new Set(['indicator', 'year', 'value', 'footnote']);
const SOURCE = Object.freeze({ id: 'worldbank-wdi', name: 'The World Bank · World Development Indicators',
  sourceId: '2', url: 'https://data.worldbank.org/', license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  termsUrl: 'https://data.worldbank.org/summary-terms-of-use', rightsCheckedDate: '2026-10-11' });
const clean = (value, max = 600) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const unavailable = (country, source, reason) => ({ schemaVersion: 1, status: 'unavailable', country,
  frequency: 'annual', indicators: [], source, reason,
  coverage: 'Latest available observations within the last ten completed calendar years. Missing values are not zero.',
  nextRefreshMs: DAY });

export function economicsQuery(params) {
  for (const key of params.keys())
    if (key !== 'country' || params.getAll(key).length !== 1) throw new TypeError('Unknown or repeated economic filter');
  return economicsCountry(params.get('country') || 'WLD');
}

export function economicsQueryUrl(country, nowMs = Date.now()) {
  const selected = economicsCountry(country.id || country);
  const endYear = new Date(nowMs).getUTCFullYear() - 1;
  const url = new URL(`https://api.worldbank.org/v2/country/${selected.id}/indicator/${ECONOMICS_INDICATORS.map((item) => item.id).join(';')}`);
  url.search = new URLSearchParams({ format: 'json', source: '2', date: `${endYear - 9}:${endYear}`, per_page: '100', footnote: 'y' });
  return url.href;
}

/** Keep raw annual years, true zeroes and gaps; never interpolate or convert dates. */
export function normalizeEconomics(payload, country, retrievedAt, nowMs = Date.now()) {
  const meta = payload?.[0], rows = payload?.[1];
  const lastYear = new Date(nowMs).getUTCFullYear() - 1;
  // The documented source=2 multi-indicator API returns sourceid:null. The
  // fixed request and independently reviewed indicator metadata bind the source.
  if (!Array.isArray(payload) || !Array.isArray(rows) || rows.length > 100 ||
      (meta?.sourceid !== null && String(meta?.sourceid) !== '2') || Number(meta?.pages) > 1 || Number(meta?.page) !== 1 ||
      Number(meta?.total) !== rows.length) throw new Error('World Bank WDI response is invalid');
  const definitions = new Map(ECONOMICS_INDICATORS.map((item) => [item.id, item]));
  const histories = new Map(ECONOMICS_INDICATORS.map((item) => [item.id, new Map()]));
  for (const row of rows) {
    const history = histories.get(row?.indicator?.id);
    const year = Number(row?.date);
    if (!history || row.countryiso3code !== country.id || !/^\d{4}$/.test(String(row.date)) ||
        year > lastYear || year < lastYear - 9 ||
        (row.value !== null && !Number.isFinite(row.value)) || history.has(year))
      throw new Error('World Bank observation does not match the selected annual series');
    history.set(year, { year, value: row.value, ...(row.footnote ? { footnote: clean(row.footnote) } : {}) });
  }
  const indicators = ECONOMICS_INDICATORS.map((definition) => {
    const history = [...histories.get(definition.id).values()].sort((a, b) => b.year - a.year);
    const latest = history.find((entry) => entry.value !== null);
    return { ...definitions.get(definition.id), status: latest ? 'available' : 'missing',
      value: latest?.value ?? null, year: latest?.year ?? null,
      sourceUrl: `${definition.url}?locations=${country.iso2 || country.id}`,
      history, ...(latest?.footnote ? { footnote: latest.footnote } : {}) };
  });
  return { schemaVersion: 1, status: 'ready', country, frequency: 'annual', indicators, retrievedAt,
    datasetUpdatedDate: /^\d{4}-\d{2}-\d{2}$/.test(meta.lastupdated || '') ? meta.lastupdated : null,
    coverage: 'Latest available observations within the last ten completed calendar years. Series can have different reference years and may be revised. Missing values are not zero.',
    source: { ...SOURCE, status: 'ready', stale: false, retrievedAt }, nextRefreshMs: DAY };
}

function economicsSnapshot(data) {
  return { schemaVersion: 1, country: data.country.id, retrievedAt: data.retrievedAt,
    datasetUpdatedDate: data.datasetUpdatedDate,
    observations: data.indicators.flatMap((item) => item.history.map((row) => ({
      indicator: item.id, year: row.year, value: row.value, ...(row.footnote ? { footnote: row.footnote } : {}),
    }))) };
}

/** Persistent records contain only dated observations; reviewed metadata is rebuilt locally. */
export function validateEconomicsSnapshot(saved, country, nowMs = Date.now()) {
  const at = Date.parse(saved?.retrievedAt);
  const selected = economicsCountry(country.id || country);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.schemaVersion !== 1 ||
      Object.keys(saved).some((key) => !SAVED_KEYS.has(key)) || saved.country !== selected.id ||
      typeof saved.retrievedAt !== 'string' || !Number.isFinite(at) || new Date(at).toISOString() !== saved.retrievedAt ||
      at > nowMs || nowMs - at > 7 * DAY || !Array.isArray(saved.observations) || saved.observations.length > 50 ||
      new TextEncoder().encode(JSON.stringify(saved)).byteLength > SAVED_MAX_BYTES)
    throw new Error('Invalid or expired annual snapshot');
  if (saved.datasetUpdatedDate !== null && (typeof saved.datasetUpdatedDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(saved.datasetUpdatedDate) ||
      !Number.isFinite(Date.parse(`${saved.datasetUpdatedDate}T00:00:00.000Z`)) ||
      new Date(`${saved.datasetUpdatedDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== saved.datasetUpdatedDate ||
      saved.datasetUpdatedDate > saved.retrievedAt.slice(0, 10))) throw new Error('Invalid annual dataset date');
  const rows = saved.observations.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((key) => !OBSERVATION_KEYS.has(key)) ||
        typeof row.indicator !== 'string' || !Number.isInteger(row.year) ||
        row.value !== null && !Number.isFinite(row.value) ||
        Object.hasOwn(row, 'footnote') && (typeof row.footnote !== 'string' || !row.footnote || clean(row.footnote) !== row.footnote))
      throw new Error('Invalid saved annual observation');
    return { indicator: { id: row.indicator }, countryiso3code: selected.id, date: String(row.year), value: row.value,
      ...(row.footnote ? { footnote: row.footnote } : {}) };
  });
  // A seven-day-old December retrieval keeps its original ten-year window in January.
  const data = normalizeEconomics([{ page: 1, pages: 1, total: rows.length, sourceid: '2', lastupdated: saved.datasetUpdatedDate }, rows],
    selected, saved.retrievedAt, at);
  return { at, data };
}

/** A fixed WDI series allowlist, bounded cache and shared refresh; no constructor fetch. */
export function economicsProxy({ fetchImpl = fetch, now = Date.now, ttlMs = DAY, maxKeys = 40,
  timeoutMs = 15000, maxPending = 4, cooldownMs = 300000, snapshotStore, storageTimeoutMs = 1000,
  onProviderError = (details) => console.warn('[economics] acquisition unavailable', JSON.stringify(details)) } = {}) {
  const cache = new Map(), pending = new Map(), restoreAttempts = new Map();
  let retryAt = 0, failures = 0;
  const touch = (key, entry) => { cache.delete(key); cache.set(key, entry); while (cache.size > maxKeys) cache.delete(cache.keys().next().value); };
  const optionalStorage = async (task) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(task).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), storageTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  const restore = async (key, country) => {
    if (!snapshotStore?.get || now() - (restoreAttempts.get(key) ?? -Infinity) < 60000) return;
    restoreAttempts.delete(key); restoreAttempts.set(key, now());
    while (restoreAttempts.size > maxKeys) restoreAttempts.delete(restoreAttempts.keys().next().value);
    try {
      const saved = await optionalStorage(() => snapshotStore.get(`economics:annual:${key}`));
      if (!saved) return;
      const restored = validateEconomicsSnapshot(saved, country, now());
      if (!cache.has(key) || restored.at > cache.get(key).at) touch(key, restored);
    } catch {} // Storage is optional and cannot change upstream availability or backoff.
  };
  async function getSnapshot(value = 'WLD') {
    const country = economicsCountry(value);
    const key = country.id;
    let entry = cache.get(key);
    let reason;
    if (!entry || now() - entry.at >= ttlMs) {
      if (pending.has(key)) await pending.get(key);
      else if (pending.size >= maxPending) reason = 'Economic source requests are busy; try again shortly';
      else {
        const work = (async () => {
          await restore(key, country);
          if (cache.has(key) && now() - cache.get(key).at < ttlMs) return;
          if (retryAt > now()) { reason = 'World Bank provider retry is paused after an upstream failure'; return; }
          const signal = AbortSignal.timeout(timeoutMs);
          let stage = 'request', httpStatus = null, responseType = null;
          try {
            const response = await fetchImpl(economicsQueryUrl(country, now()), { signal, redirect: 'error',
              headers: { Accept: 'application/json', 'User-Agent': 'earth-observer/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' } });
            httpStatus = response.status;
            const type = response.headers.get('content-type') || '';
            responseType = /json/i.test(type) ? 'json' : /html/i.test(type) ? 'html' : 'other';
            stage = 'http-status';
            if (!response.ok) {
              const retry = response.headers.get('retry-after');
              const retryMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
              await response.body?.cancel();
              throw Object.assign(new Error(`World Bank HTTP ${response.status}`), { retryMs });
            }
            stage = 'read';
            const payload = await readResponseJsonCapped(response, 256 * 1024, signal);
            signal.throwIfAborted();
            const at = now();
            stage = 'validate';
            const data = normalizeEconomics(payload, country, new Date(at).toISOString(), at);
            touch(key, { at, data }); failures = 0; retryAt = 0;
            if (snapshotStore?.put) await optionalStorage(() => snapshotStore.put(`economics:annual:${key}`, economicsSnapshot(data)));
          } catch (error) {
            const errorName = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'RangeError'].includes(error.name) ? error.name : 'UnknownError';
            const kind = errorName === 'TimeoutError' || errorName === 'AbortError' ? 'timeout' :
              error.code === 'RESPONSE_TOO_LARGE' ? 'body-limit' : stage === 'validate' ? 'invalid-observations' :
              stage === 'http-status' ? 'upstream-status' : errorName === 'SyntaxError' ? 'invalid-json' :
              /Illegal invocation|global scope|current request|Cannot perform I\/O/i.test(error.message || '') ? 'runtime-invocation' : 'transport-or-runtime';
            // Only bounded classifications enter logs; never the upstream body,
            // request identity, URLs, credentials or exception text.
            try { onProviderError?.({ provider: 'worldbank-wdi', stage, kind, errorName, httpStatus, responseType }); } catch {}
            failures = Math.min(failures + 1, 6);
            retryAt = now() + Math.max(Math.min(cooldownMs * 2 ** (failures - 1), 3600000),
              Number.isFinite(error.retryMs) ? Math.max(0, Math.min(DAY, error.retryMs)) : 0);
            reason = error.name === 'TimeoutError' ? 'World Bank request timed out' : 'World Bank annual data is temporarily unavailable';
          }
        })().finally(() => pending.delete(key));
        pending.set(key, work); await work;
      }
      entry = cache.get(key);
    }
    const ageMs = entry ? Math.max(0, now() - entry.at) : null;
    const stale = Boolean(entry && ageMs >= ttlMs);
    if (entry && ageMs <= 7 * DAY) {
      touch(key, entry);
      return { ...entry.data, status: stale ? 'stale' : 'ready', source: { ...entry.data.source,
        status: stale ? 'stale' : 'ready', stale, ageMs, ageCalculatedAt: new Date(now()).toISOString(), retryAt: retryAt || null,
        ...(stale ? { reason: reason || 'Cached annual data; upstream refresh is pending' } : {}) } };
    }
    return unavailable(country, { ...SOURCE, status: 'unavailable', stale: false, ageMs, retryAt: retryAt || null },
      entry ? 'Cached annual data exceeded the seven-day retrieval-age limit' : reason || 'World Bank annual data is temporarily unavailable');
  }
  const install = ({ middlewares }) => middlewares.use('/api/economics', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
    if (req.method && req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    let country;
    try { country = economicsQuery(url.searchParams); }
    catch (error) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: error.message })); return; }
    const data = await getSnapshot(country.id);
    const maxAge = Math.max(0, Math.min(3600, Math.floor((ttlMs - (data.source.ageMs || 0)) / 1000)));
    res.writeHead(200, { 'Content-Type': 'application/json',
      'Cache-Control': data.status === 'ready' && maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
      ...(Number.isFinite(data.source.ageMs) ? { 'X-Feed-Age-Ms': String(data.source.ageMs) } : {}) });
    res.end(JSON.stringify(data));
  });
  return { name: 'hosted-economics', getSnapshot, configureServer: install, configurePreviewServer: install };
}
