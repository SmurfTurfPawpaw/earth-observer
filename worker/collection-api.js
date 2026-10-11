import { collectEarthSources, getCollectorStatus } from './collector.js';
import { readPreparedIntelligence, PreparedBaselineConflict } from './history.js';
import { intelligenceQuery } from '../server/hosted/intelligence.js';
import { createDiscoveryIndex } from '../src/core/discovery-index.js';
import { groupReports } from '../src/core/intelligence-grouping.js';
import { publishLocalCollection, heartbeatCollection, readLocalAnalysis, collectionFactsDigest } from './collection-publication.js';
import { publishCollectionRevision, publishAircraftRevision } from './collection-updates.js';
import { publishAircraftObservations } from './aircraft-observations.js';
import { startInvestigationPipeline } from './investigation-pipeline.js';
import { startSourcePlugins } from './plugins/runner.js';

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
    const fields = { collect: ['action'], publish: ['action', 'packet', 'analysis'], heartbeat: ['action', 'collectedAt', 'sources', 'inputDigest'], aircraft: ['action', 'packet'] };
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
  // Independently reviewed source scopes keep their own cadence, evidence and
  // leases. A failure in the original four-source packet cannot starve this work.
  const sourcePlugins = body.action === 'collect' ? startSourcePlugins(env, ctx, { now, fetchImpl, signal: request.signal }) : null;
  try {
    const result = body.action === 'aircraft' ? await publishAircraftObservations(env, body.packet, { now }) :
      body.action === 'publish' ? await publishLocalCollection(env, body.packet, body.analysis, { now }) :
      body.action === 'heartbeat' ? await heartbeatCollection(env, body, { now }) : await collectEarthSources(env, ctx, { now, fetchImpl });
    if (result.conflict) return json({ error: 'Prepared baseline changed; publish the retained full packet' }, 409);
    const accepted = Boolean(result.stored && !result.failures?.length);
    let revision;
    if (accepted && env.EARTH_DB?.prepare && body.action === 'aircraft') {
      if (!result.indexed) throw new Error('Aircraft durable history index is unavailable');
      // Repeating a durable packet also repairs a failed prior notification.
      // The retained factual capture/date and monotonic row keep retries quiet.
      revision = await publishAircraftRevision(env, result);
    } else if (accepted && env.EARTH_DB?.prepare && result.prepared?.promoted) {
      // Announce only the exact completed packet while it still matches current
      // prepared data. A superseded writer cannot announce an unrelated pointer.
      const current = await readPreparedIntelligence(env, { now });
      if (!current) throw new Error('Prepared collection is unavailable');
      const inputDigest = await collectionFactsDigest(current.payload.indexRecords);
      if (current.collectedAt === result.prepared.collectedAt && inputDigest === result.prepared.inputDigest)
        revision = await publishCollectionRevision(env, { at: result.prepared.collectedAt,
          digest: result.prepared.inputDigest, recordCount: result.prepared.recordCount });
    }
    // Research is separately budgeted retained work. Its availability never changes
    // the factual publication outcome or blocks the collector's HTTP response.
    let research;
    const advanceDueResearch = accepted && body.action === 'collect' && result.heartbeat === true;
    if (advanceDueResearch || accepted && result.world?.stored && ['collect', 'publish'].includes(body.action)) {
      try { research = startInvestigationPipeline(env, ctx, { workerId: 'hosted-collector',
        ...(advanceDueResearch ? { enqueueCandidates: false } : {}) }, { now, fetchImpl, signal: request.signal }); }
      catch { research = { scheduled: false, status: 'unavailable' }; }
    }
    return json({ ...result, ...(research ? { research } : {}), ...(sourcePlugins ? { sourcePlugins } : {}), stored: accepted, updatesConfigured: Boolean(env.EARTH_DB?.prepare), updatesPublished: Boolean(revision?.stored) },
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
    ...(prepared.stale && source.status === 'ready' ? { status: 'stale', stale: true, reason: 'Collector operational check is older than one minute; original source dates are retained' } : {}),
    ageMs: source.retrievedAt ? Math.max(0, now() - Date.parse(source.retrievedAt)) : source.ageMs,
    checkAgeMs: source.lastCheckedAt ? Math.max(0, now() - Date.parse(source.lastCheckedAt)) : source.checkAgeMs,
  }));
  return json({ ...payload, reports, sources, filters, collectedAt: prepared.collectedAt,
    checkedAt: prepared.checkedAt, checkAgeMs: prepared.checkAgeMs,
    collectionAgeMs: prepared.ageMs, delivery: 'prepared-hosted-data', nextRefreshMs: 60000 }, 200,
    { 'cache-control': 'public, max-age=15', 'x-earth-collection-at': prepared.collectedAt });
}
