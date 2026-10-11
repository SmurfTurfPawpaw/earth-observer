import { collectEarthSources, getCollectorStatus } from './collector.js';
import { readPreparedIntelligence, PreparedBaselineConflict } from './history.js';
import { intelligenceQuery } from '../server/hosted/intelligence.js';
import { createDiscoveryIndex } from '../src/core/discovery-index.js';
import { groupReports } from '../src/core/intelligence-grouping.js';
import { publishLocalCollection, heartbeatCollection, readLocalAnalysis, collectionFactsDigest } from './collection-publication.js';
import { publishCollectionRevision } from './collection-updates.js';

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
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1500000)) return false;
  const reader = request.body?.getReader(); if (!reader) return false;
  let bytes = 0, chunks = '';
  const decoder = new TextDecoder();
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 1500000) { await reader.cancel(); return false; }
      chunks += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(chunks + decoder.decode());
    const fields = { collect: ['action'], publish: ['action', 'packet', 'analysis'], heartbeat: ['action', 'collectedAt', 'sources', 'inputDigest'] };
    return value && !Array.isArray(value) && Object.hasOwn(fields, value.action) && Object.keys(value).length === fields[value.action].length &&
      Object.keys(value).every((key) => fields[value.action].includes(key)) ? value : false;
  } catch { await reader.cancel().catch(() => {}); return false; }
}

/** Only a private machine credential can trigger ingestion. No visitor or URL inputs. */
export async function handleCollection(request, env, ctx, { now = Date.now, fetchImpl = fetch } = {}) {
  const path = new URL(request.url).pathname;
  if (path === '/api/analysis') {
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    if (!env.EARTH_STORE?.get) return json({ available: false }, 503);
    const analysis = await readLocalAnalysis(env, { now });
    return json(analysis || { available: false, note: 'Local processing has not published derived metadata yet.' });
  }
  if (path === '/api/collector/status') {
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    return json(await getCollectorStatus(env, { now }));
  }
  if (path !== '/api/collector') return null;
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  if (request.headers.has('origin') || !await authorized(request, env)) return json({ error: 'Collector authorization required' }, 401);
  if (!env.EARTH_STORE?.get || !env.EARTH_STORE?.put) return json({ error: 'Durable storage is not configured' }, 503);
  const body = await actionBody(request);
  if (!body) return json({ error: 'Use a bounded collection, publication or heartbeat action' }, 400);
  try {
    const result = body.action === 'publish' ? await publishLocalCollection(env, body.packet, body.analysis, { now }) :
      body.action === 'heartbeat' ? await heartbeatCollection(env, body, { now }) : await collectEarthSources(env, ctx, { now, fetchImpl });
    if (result.conflict) return json({ error: 'Prepared baseline changed; publish the retained full packet' }, 409);
    const accepted = Boolean(result.stored && !result.failures?.length);
    let revision;
    if (accepted && env.EARTH_DB?.prepare) {
      // Announce the actual retained current pointer, including when an older
      // writer was superseded. Durable facts/history precede notification.
      const current = await readPreparedIntelligence(env, { now });
      if (!current) throw new Error('Prepared collection is unavailable');
      revision = await publishCollectionRevision(env, { at: current.collectedAt,
        digest: await collectionFactsDigest(current.payload.indexRecords), recordCount: current.payload.indexRecords.length });
    }
    return json({ ...result, stored: accepted, updatesConfigured: Boolean(env.EARTH_DB?.prepare), updatesPublished: Boolean(revision?.stored) },
      accepted ? 200 : 503, accepted ? {} : { 'retry-after': '60' });
  } catch (error) {
    if (error instanceof PreparedBaselineConflict) return json({ error: 'Prepared baseline changed; publish the retained full packet' }, 409);
    if (error instanceof TypeError) return json({ error: 'Invalid bounded collection metadata or analysis' }, 400);
    return json({ error: 'Collection could not complete; retained source dates remain unchanged' }, 503, { 'retry-after': '60' });
  }
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
