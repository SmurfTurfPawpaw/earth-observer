import { collectEarthSources, getCollectorStatus } from './collector.js';
import { readPreparedIntelligence } from './history.js';
import { intelligenceQuery } from '../server/hosted/intelligence.js';
import { createDiscoveryIndex } from '../src/core/discovery-index.js';
import { groupReports } from '../src/core/intelligence-grouping.js';

const json = (payload, status = 200, headers = {}) => Response.json(payload, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
} });
async function authorized(request, env) {
  const expected = env.EARTH_COLLECTOR_TOKEN;
  const candidate = /^Bearer ([a-zA-Z0-9_-]{32,256})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (typeof expected !== 'string' || expected.length < 32 || expected.length > 256 || !candidate) return false;
  const hash = (value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = (await Promise.all([hash(expected), hash(candidate)])).map((value) => new Uint8Array(value));
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
async function actionBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return false;
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 64)) return false;
  const reader = request.body?.getReader(); if (!reader) return false;
  let bytes = 0, chunks = '';
  const decoder = new TextDecoder();
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 64) { await reader.cancel(); return false; }
      chunks += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(chunks + decoder.decode());
    return value && !Array.isArray(value) && value.action === 'collect' && Object.keys(value).length === 1;
  } catch { await reader.cancel().catch(() => {}); return false; }
}

/** Only a private machine credential can trigger ingestion. No visitor or URL inputs. */
export async function handleCollection(request, env, ctx, { now = Date.now, fetchImpl = fetch } = {}) {
  const path = new URL(request.url).pathname;
  if (path === '/api/collector/status') {
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    return json(await getCollectorStatus(env, { now }));
  }
  if (path !== '/api/collector') return null;
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  if (request.headers.has('origin') || !await authorized(request, env)) return json({ error: 'Collector authorization required' }, 401);
  if (!env.EARTH_STORE?.get || !env.EARTH_STORE?.put) return json({ error: 'Durable storage is not configured' }, 503);
  if (!await actionBody(request)) return json({ error: 'Use the fixed collection action' }, 400);
  try {
    const result = await collectEarthSources(env, ctx, { now, fetchImpl });
    return json(result, 200);
  } catch { return json({ error: 'Collection could not complete; retained source dates remain unchanged' }, 503, { 'retry-after': '60' }); }
}

/** Production readers consume prepared snapshots and never perform source acquisition. */
export async function preparedIntelligenceResponse(request, env, { now = Date.now } = {}) {
  if (new URL(request.url).pathname !== '/api/intelligence' || !env.EARTH_STORE?.get || !env.EARTH_STORE?.put) return null;
  if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
  let filters; try { filters = intelligenceQuery(new URL(request.url).searchParams); }
  catch (error) { return json({ error: error.message }, 400); }
  const prepared = await readPreparedIntelligence(env, { now });
  if (!prepared) return json({ reports: [], sources: [], indexRecords: [], filters, nextRefreshMs: 60000,
    coverage: 'Prepared collection is not yet available. The collector must supply recorded source data.',
    error: 'No prepared data is available' }, 503, { 'retry-after': '60' });
  const payload = prepared.payload, index = createDiscoveryIndex({ now }); index.replacePayload(payload);
  const reports = groupReports(index.search({ ...filters, limit: 500 }).reports, 80, { preserveOrder: Boolean(filters.q) });
  const sources = payload.sources.map((source) => ({ ...source,
    ...(prepared.stale && source.status === 'ready' ? { status: 'stale', stale: true, reason: 'Collector heartbeat is older than one minute; original source dates are retained' } : {}),
    ageMs: source.retrievedAt ? Math.max(0, now() - Date.parse(source.retrievedAt)) : source.ageMs,
  }));
  return json({ ...payload, reports, sources, filters, collectedAt: prepared.collectedAt,
    collectionAgeMs: prepared.ageMs, delivery: 'prepared-hosted-data', nextRefreshMs: 60000 }, 200,
    { 'cache-control': 'public, max-age=15', 'x-earth-collection-at': prepared.collectedAt });
}
