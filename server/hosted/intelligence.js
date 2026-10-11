import { readResponseJsonCapped } from '../providers/common/http.js';
import { GROUPING_NOTE, normalizeGdelt, normalizeGdacs, normalizeUsgs, groupReports } from './intelligence-sources.js';
import { gdeltQueryUrl } from './gdelt-query.js';
import { createGdeltSnapshotReader } from './gdelt-snapshot.js';
import { createEonetSnapshotReader, EONET_SOURCE } from './eonet-snapshot.js';
import { createDiscoveryIndex, discoveryQueryText, DISCOVERY_INDEX_MAX_BYTES } from '../../src/core/discovery-index.js';
export { gdeltQueryUrl } from './gdelt-query.js';

const CATEGORIES = ['all', 'disasters', 'geopolitics', 'economy'];
const COUNTRIES = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const MAX_KEYS = 40, MAX_PENDING = 4;
const HEADER = { 'User-Agent': 'earth-observer/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)', Accept: 'application/json' };
export function intelligenceQuery(params) {
  for (const key of params.keys()) if (!['category', 'country', 'q'].includes(key) || params.getAll(key).length !== 1) throw new TypeError('Unknown or repeated filter');
  const category = params.get('category') || 'all';
  const country = String(params.get('country') || '').toUpperCase();
  const q = discoveryQueryText(String(params.get('q') || '').normalize('NFKC').trim().replace(/\s+/g, ' '));
  if (!CATEGORIES.includes(category)) throw new TypeError('Unknown category');
  if (country && (!/^[A-Z]{2}$/.test(country) || ['ZZ', 'EU', 'UN', 'QO', 'XA', 'XB'].includes(country) || !COUNTRIES.of(country))) throw new TypeError('Use a valid two-letter country code');
  if (q.length > 64 || (q && (!/^[\p{L}\p{N}\s'.’\-]+$/u.test(q) || (q.match(/[\p{L}\p{N}]/gu)?.length || 0) < 2))) throw new TypeError('Topic must contain 2–64 letters, digits, spaces, apostrophes, dots or hyphens');
  return { category, country, countryName: country ? COUNTRIES.of(country) : '', q };
}

/** Fixed reviewed integrations, shared bounded acquisition and provider backoff; no startup polling. */
export function intelligenceProxy({ fetchImpl = fetch, now = Date.now, env = globalThis.process?.env || {},
  snapshotStore, snapshotReader = createGdeltSnapshotReader({ fetchImpl, now, store: snapshotStore }),
  eonetReader = createEonetSnapshotReader({ fetchImpl, now, store: snapshotStore }),
  allowLiveGdeltFallback = env.GDELT_LIVE_FALLBACK === '1' } = {}) {
  const cache = new Map(), pending = new Map(), failures = new Map(), attempts = new Map();
  const index = createDiscoveryIndex({ now, maxRecords: 500 });
  const providerFailures = new Map();
  const policies = {
    gdelt: { name: 'The GDELT Project', url: 'https://www.gdeltproject.org/', ttl: 300000, timeout: 15000, cooldown: 300000, minGap: 6000 },
    usgs: { name: 'U.S. Geological Survey', url: 'https://earthquake.usgs.gov/', ttl: 300000, timeout: 10000, cooldown: 60000, minGap: 1000 },
    gdacs: { name: 'Global Disaster Alert and Coordination System, GDACS', url: 'https://www.gdacs.org/', ttl: 600000, timeout: 12000, cooldown: 120000, minGap: 1000 },
  };
  function trim(map) { while (map.size > MAX_KEYS) map.delete(map.keys().next().value); }
  async function readNews(filters) {
    const scheduled = snapshotReader ? await snapshotReader(filters) : null;
    if ((scheduled && scheduled.state.status !== 'unavailable') || !allowLiveGdeltFallback) return scheduled || { records: [], state: {
      id: 'gdelt', name: policies.gdelt.name, url: policies.gdelt.url, status: 'unavailable', stale: false, reason: 'Scheduled GDELT snapshot unavailable' } };
    // Search terms stay in the metadata index, including controlled fallback.
    const coarse = { ...filters, q: '' };
    const fallback = await read('gdelt', `gdelt:${filters.category}:${filters.country}`, gdeltQueryUrl(coarse), (payload, stamp) => normalizeGdelt(payload, stamp, filters.category));
    fallback.state = { ...fallback.state, mode: 'live-fallback',
      coverage: 'Controlled live GDELT discovery query: at most 80 title/link records from the last 24 hours. Country filters search text mentions; results are a bounded sample and do not establish comprehensive coverage or event locations.',
      reason: [fallback.state.reason, 'Controlled live fallback; scheduled discovery snapshot unavailable'].filter(Boolean).join('; ') };
    fallback.indexSource.coverage = fallback.state.coverage;
    return fallback;
  }
  async function read(id, key, url, normalize) {
    const policy = policies[id], at = now();
    let entry = cache.get(key), reason = null;
    if (!entry || at - entry.at >= policy.ttl) {
      if (pending.has(key)) await pending.get(key);
      else if (pending.size >= MAX_PENDING || [...pending.keys()].some((item) => item.startsWith(`${id}:`))) reason = 'Provider request already in progress; try again shortly';
      else if ((failures.get(key)?.retryAt || 0) > at || (providerFailures.get(id)?.retryAt || 0) > at) reason = `${(failures.get(key) || providerFailures.get(id)).reason}; retry paused by backoff`;
      else if (at - (attempts.get(id) ?? -Infinity) < policy.minGap) reason = 'Provider refresh rate is limited; try again shortly';
      else {
        attempts.set(id, at);
        const work = (async () => {
          const signal = AbortSignal.timeout(policy.timeout);
          try {
            const response = await fetchImpl(url, { signal, redirect: 'error', headers: HEADER });
            if (!response.ok) {
              const retry = response.headers.get('retry-after');
              const retryMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
              await response.body?.cancel();
              throw Object.assign(new Error(`Provider HTTP ${response.status}`), { httpStatus: response.status, retryAfterMs: Number.isFinite(retryMs) ? Math.max(0, Math.min(86400000, retryMs)) : 0 });
            }
            const payload = await readResponseJsonCapped(response, 2 * 1024 * 1024, signal);
            signal.throwIfAborted();
            const retrievedAt = new Date(now()).toISOString();
            const records = normalize(payload, retrievedAt);
            cache.delete(key); cache.set(key, { at: now(), records }); trim(cache);
            failures.delete(key); providerFailures.delete(id);
          } catch (error) {
            const previous = providerFailures.get(id)?.count || 0;
            const count = Math.min(previous + 1, 6);
            const reason = error.httpStatus === 429 ? 'Provider rate limit (HTTP 429)' : error.httpStatus ? `Provider HTTP ${error.httpStatus}` : error.name === 'TimeoutError' ? 'Provider request timed out' : 'Provider response temporarily unavailable';
            const failure = { count, retryAt: now() + Math.max(Math.min(policy.cooldown * 2 ** (count - 1), 3600000), error.retryAfterMs || 0), reason };
            failures.set(key, failure); trim(failures); providerFailures.set(id, failure);
          }
        })().finally(() => pending.delete(key));
        pending.set(key, work); await work;
      }
      entry = cache.get(key);
    }
    const stale = Boolean(entry && (now() - entry.at >= policy.ttl || failures.has(key)));
    const expired = Boolean(entry && now() - entry.at > 86400000);
    if (expired) reason = 'Cached results exceeded the 24-hour staleness limit';
    const status = entry && !expired ? stale ? 'stale' : 'ready' : reason?.includes('in progress') || reason?.includes('limited') ? 'busy' : 'unavailable';
    return { records: expired ? [] : entry?.records || [], indexSource: {
      id, generation: entry ? `${key}:${new Date(entry.at).toISOString()}` : `${key}:unavailable`, status,
      expiresAt: entry ? new Date(entry.at + 86400000).toISOString() : null,
      coverage: id === 'gdelt' ? 'Controlled coarse GDELT discovery sample; local topic search does not query article text.' :
        'Official hazard metadata from the last seven days; GDACS reports countries and USGS supplies no authoritative country codes.',
    }, state: {
      id, name: policy.name, url: policy.url,
      status,
      stale, retrievedAt: entry ? new Date(entry.at).toISOString() : null,
      ageMs: entry ? Math.max(0, now() - entry.at) : null,
      refreshIntervalMs: policy.ttl,
      retryAt: failures.get(key)?.retryAt || providerFailures.get(id)?.retryAt || null,
      ...(reason || failures.get(key)?.reason ? { reason: reason || failures.get(key).reason } : {}),
    } };
  }
  const install = ({ middlewares }) => {
    middlewares.use('/api/intelligence', async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      if (req.method && req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
      let filters;
      try { filters = intelligenceQuery(url.searchParams); }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: error.message })); return; }
      const jobs = [readNews(filters)];
      if (eonetReader) jobs.push(eonetReader(filters));
      if (filters.category === 'all' || filters.category === 'disasters') {
        if (!filters.country) jobs.push(read('usgs', 'usgs:global', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', normalizeUsgs));
        const gdacs = new URL('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH');
        const end = new Date(now()), start = new Date(now() - 7 * 86400000);
        gdacs.search = new URLSearchParams({ eventlist: 'EQ;TC;FL;VO;WF;DR', fromdate: start.toISOString().slice(0, 10), todate: end.toISOString().slice(0, 10) });
        jobs.push(read('gdacs', 'gdacs:global', gdacs.href, normalizeGdacs));
      }
      const results = await Promise.all(jobs);
      for (const result of results) {
        // An inapplicable country/topic filter does not withdraw a previously
        // acquired global generation or give its metadata a newer date.
        if (result.state.status === 'not-applicable') continue;
        const source = result.indexSource || { id: result.state.id, generation: result.state.retrievedAt || 'unavailable',
          expiresAt: result.state.retrievedAt ? new Date(Date.parse(result.state.retrievedAt) + 86400000).toISOString() : null,
          status: result.state.status, coverage: result.state.coverage || '' };
        index.replaceSource({ ...source, records: result.indexRecords || result.records });
      }
      const indexState = index.getState();
      const reports = filters.q ? index.search({ ...filters, limit: 500 }).reports : results.flatMap((result) => result.records).filter((report) => {
        if (filters.country && report.sourceId !== 'gdelt' && !report.countries?.includes(filters.country)) return false;
        return true;
      });
      const grouped = groupReports(reports, 80, { preserveOrder: Boolean(filters.q) });
      const sources = results.map((result) => result.state);
      if (filters.country && ['all', 'disasters'].includes(filters.category)) sources.push({ id: 'usgs', name: policies.usgs.name, url: policies.usgs.url, status: 'not-applicable', stale: false, reason: 'USGS summary has no authoritative country codes; country-filtered hazards use GDACS' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
      res.end(JSON.stringify({ reports: grouped, sources, filters, retrievedAt: new Date(now()).toISOString(),
        indexRecords: indexState.records, indexVersion: indexState.indexVersion,
        indexCoverage: { schemaVersion: indexState.schemaVersion, recordCount: indexState.recordCount, byteLength: indexState.byteLength,
          maxRecords: 500, maxBytes: DISCOVERY_INDEX_MAX_BYTES, omittedRecords: indexState.omittedRecords,
          sources: indexState.sources, note: indexState.note },
        grouping: GROUPING_NOTE, coverage: `${results[0].state.coverage || 'GDELT discovery sample unavailable.'} Official hazard reports cover the last seven days. GDACS filters use reported countries. ${eonetReader ? `${EONET_SOURCE.name} supplies a bounded curated event sample; geometry dates can precede the seven-day query window and are not verified incident times. ` : ''}These are not geographic proof.`,
        nextRefreshMs: 300000 }));
    });
  };
  return { name: 'hosted-intelligence', configureServer: install, configurePreviewServer: install };
}
