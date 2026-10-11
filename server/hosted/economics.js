import { readResponseJsonCapped } from '../providers/common/http.js';
import { ECONOMICS_INDICATORS, economicsCountry } from '../../src/core/economics-catalog.js';

const DAY = 86400_000;
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

/** A fixed WDI series allowlist, bounded cache and shared refresh; no constructor fetch. */
export function economicsProxy({ fetchImpl = fetch, now = Date.now, ttlMs = DAY, maxKeys = 40,
  timeoutMs = 15000, maxPending = 4, cooldownMs = 300000 } = {}) {
  const cache = new Map(), pending = new Map();
  let retryAt = 0, failures = 0;
  const touch = (key, entry) => { cache.delete(key); cache.set(key, entry); while (cache.size > maxKeys) cache.delete(cache.keys().next().value); };
  async function getSnapshot(value = 'WLD') {
    const country = economicsCountry(value);
    const key = country.id;
    let entry = cache.get(key);
    let reason;
    if (!entry || now() - entry.at >= ttlMs) {
      if (pending.has(key)) await pending.get(key);
      else if (retryAt > now()) reason = 'World Bank provider retry is paused after an upstream failure';
      else if (pending.size >= maxPending) reason = 'Economic source requests are busy; try again shortly';
      else {
        const work = (async () => {
          const signal = AbortSignal.timeout(timeoutMs);
          try {
            const response = await fetchImpl(economicsQueryUrl(country, now()), { signal, redirect: 'error',
              headers: { Accept: 'application/json', 'User-Agent': 'earth-observer/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' } });
            if (!response.ok) {
              const retry = response.headers.get('retry-after');
              const retryMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
              await response.body?.cancel();
              throw Object.assign(new Error(`World Bank HTTP ${response.status}`), { retryMs });
            }
            const payload = await readResponseJsonCapped(response, 256 * 1024, signal);
            signal.throwIfAborted();
            const at = now();
            const data = normalizeEconomics(payload, country, new Date(at).toISOString(), at);
            touch(key, { at, data }); failures = 0; retryAt = 0;
          } catch (error) {
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
        status: stale ? 'stale' : 'ready', stale, ageMs, retryAt: retryAt || null,
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
    res.writeHead(200, { 'Content-Type': 'application/json',
      'Cache-Control': data.status === 'ready' ? 'public, max-age=3600' : 'no-store' });
    res.end(JSON.stringify(data));
  });
  return { name: 'hosted-economics', getSnapshot, configureServer: install, configurePreviewServer: install };
}
