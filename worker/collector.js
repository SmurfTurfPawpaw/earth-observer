import { intelligenceProxy } from '../server/hosted/intelligence.js';
import { EONET_QUERY_URL } from '../server/hosted/eonet-snapshot.js';
import { GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { createProviderStore } from './storage.js';
import { createWorkerFetch } from './fetch.js';
import { createWorkerMiddleware } from './middleware.js';
import { appendHistorySnapshot, readPreparedIntelligence, checkPreparedIntelligence, writePreparedIntelligence, PreparedBaselineConflict } from './history.js';
import { projectWorldCollection } from './world-model.js';
import { collectionFactsDigest } from '../src/core/collection-facts.js';
import { collectionSemantics, matchesCollectionBaseline, checkCollectionOperational, fitsCollectionOperationalSources } from './collection-check.js';
import { readCollectionCompletion } from './collection-completion.js';
import { publishCollectionRevision } from './collection-updates.js';

export const COLLECTOR_PLUGINS = Object.freeze([
  Object.freeze({ id: 'usgs', name: 'USGS earthquakes', endpoint: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
    checkIntervalMs: 60000, sourceCadence: 'Provider feed updates as events are reported or revised', maxRecords: 100, credentials: [],
    limitations: 'Magnitude 4.5+ summary for the last seven days; scientific source coordinates and origin times, no inferred country.' }),
  Object.freeze({ id: 'gdacs', name: 'GDACS disaster notices', endpoint: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH',
    checkIntervalMs: 60000, sourceCadence: 'Provider notices and episode revisions; no fixed publication guarantee', maxRecords: 100, credentials: [],
    limitations: 'Fixed reviewed EQ/TC/FL/VO/WF/DR query for seven days; approximate modeled impact and country metadata.' }),
  Object.freeze({ id: 'eonet', name: 'NASA EONET references', endpoint: EONET_QUERY_URL,
    checkIntervalMs: 60000, sourceCadence: 'Curated reference updates, not an exact real-time incident stream', maxRecords: 60, credentials: [],
    limitations: 'Reviewed wildfires, severe storms and volcanoes; source links and geometry dates only, no inferred coordinates or countries.' }),
  Object.freeze({ id: 'gdelt', name: 'GDELT topic discovery', endpoint: GDELT_SNAPSHOT_URL,
    checkIntervalMs: 60000, sourceCadenceMs: 900000, sourceCadence: 'GKG is published in 15-minute batches; scheduled acquisition may be delayed or skipped', maxRecords: 240, credentials: [],
    limitations: 'Project-owned bounded metadata release; reviewed topics, country mentions and original links, no archive processing or article crawling in the Worker.' }),
]);

const services = new WeakMap(), pending = new WeakMap();
const pluginIds = new Set(COLLECTOR_PLUGINS.map((plugin) => plugin.id));
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function service(env, now, fetchImpl, snapshotReader) {
  const owner = env.EARTH_STORE || env;
  const saved = services.get(owner);
  if (saved?.now === now && saved.fetchImpl === fetchImpl && saved.snapshotReader === snapshotReader) return saved.middleware;
  const middleware = createWorkerMiddleware([intelligenceProxy({ fetchImpl: createWorkerFetch(fetchImpl), now,
    env: { ...env, GDELT_LIVE_FALLBACK: '0' }, snapshotStore: createProviderStore(env), ...(snapshotReader ? { snapshotReader } : {}) })]);
  saved?.middleware.close(); services.set(owner, { middleware, now, fetchImpl, snapshotReader }); return middleware;
}

function collectionPacket(packet, now) {
  if (packet?.schemaVersion !== 1 || typeof packet.collectedAt !== 'string' ||
      !Number.isFinite(Date.parse(packet.collectedAt)) || new Date(packet.collectedAt).toISOString() !== packet.collectedAt ||
      Date.parse(packet.collectedAt) > now() + 300000 || !Array.isArray(packet.payload?.indexRecords) ||
      packet.payload.indexRecords.length > 500 || !Array.isArray(packet.payload?.sources) || packet.payload.sources.length > 20 || bytes(packet) > 1200000)
    throw new TypeError('Invalid bounded collection packet');
  const records = packet.payload.indexRecords.map(canonicalDiscoveryRecord);
  const declaredSources = new Set(packet.payload.sources.map((source) => source?.id));
  if (records.some((record) => !record || !pluginIds.has(record.sourceId)) ||
      records.some((record) => !declaredSources.has(record.sourceId)) ||
      packet.payload.sources.some((source) => !pluginIds.has(source?.id) || !['ready', 'stale', 'busy', 'unavailable', 'not-applicable'].includes(source.status)) ||
      new Set(packet.payload.sources.map((source) => source.id)).size !== packet.payload.sources.length)
    throw new TypeError('Unregistered collection source or invalid metadata');
  return { schemaVersion: 1, collectedAt: packet.collectedAt, payload: { ...packet.payload, indexRecords: records } };
}

/** Persist a packet only after the caller has authenticated its writer. No endpoint is exposed here. */
export async function persistEarthCollection(env, input, { now = Date.now, matchesBaseline } = {}) {
  const packet = collectionPacket(input, now);
  if (!env.EARTH_STORE?.get || !env.EARTH_STORE?.put) return { configured: false, stored: false, collectedAt: packet.collectedAt };
  const capturedNow = () => Date.parse(packet.collectedAt), snapshots = [], failures = [];
  let prepared;
  try { await checkPreparedIntelligence(env, packet.payload, { now: capturedNow, matchesBaseline }); }
  catch (error) {
    if (error instanceof PreparedBaselineConflict) throw error;
    return { configured: true, stored: false, collectedAt: packet.collectedAt, snapshots,
      failures: ['Prepared current intelligence publication was unavailable; the previous publication was retained'], status: 'partial' };
  }
  const recordSources = new Set(packet.payload.indexRecords.map((record) => record.sourceId));
  const work = packet.payload.sources.filter((source) => ['ready', 'stale'].includes(source.status) || recordSources.has(source.id)).map(async (source) => {
    const records = packet.payload.indexRecords.filter((record) => record.sourceId === source.id);
    const coordinates = source.id === 'usgs' ? records.filter((record) => Number.isFinite(record.lat) && Number.isFinite(record.lon))
      .map((record) => ({ id: record.id, lat: record.lat, lon: record.lon })) : [];
    return appendHistorySnapshot(env, { source: source.id, at: packet.collectedAt, records, coordinates }, { now });
  });
  const results = await Promise.allSettled(work);
  for (const result of results) {
    if (result.status === 'fulfilled') snapshots.push(result.value);
    else failures.push('A source history or durable observation index write was unavailable; existing history was retained');
  }
  let world = { configured: false, stored: false, reason: 'World evidence requires the durable database batch interface' };
  if (env.EARTH_DB?.batch && !failures.length) {
    world = await projectWorldCollection(env, { packet, snapshots: snapshots.filter((capture) => capture.stored && capture.indexed) }, { now });
    if (!world.stored) failures.push('The world evidence projection is incomplete; accepted source snapshots are retained for retry');
  }
  if (!failures.length) {
    try { prepared = await writePreparedIntelligence(env, packet.payload, { now: capturedNow, matchesBaseline }); }
    catch (error) {
      if (error instanceof PreparedBaselineConflict) throw error;
      failures.push('Prepared current intelligence promotion was unavailable; completed evidence was retained for retry');
    }
  }
  return { configured: true, stored: Boolean(prepared?.stored && !failures.length), collectedAt: packet.collectedAt, snapshots, failures,
    indexConfigured: Boolean(env.EARTH_DB?.prepare), world, prepared: prepared || null, status: failures.length ? 'partial' : 'stored' };
}

/** Hosted-only admission: completed unchanged facts become operational checks.
 * Explicit uploaded publication/retries retain their existing full-capture contract.
 */
export async function persistHostedCollection(env, input, { now = Date.now } = {}) {
  const packet = collectionPacket(input, now);
  const prepared = await readPreparedIntelligence(env, { now });
  const semantics = prepared ? collectionSemantics(prepared.payload) : null;
  if (!prepared || semantics === null || !env.EARTH_DB?.prepare || !env.EARTH_DB?.batch)
    return persistEarthCollection(env, packet, { now });
  const inputDigest = await collectionFactsDigest(prepared.payload.indexRecords);
  const matches = current => matchesCollectionBaseline(current, prepared, inputDigest, semantics);
  let completion = await readCollectionCompletion(env, prepared, inputDigest, { now });
  const partial = () => ({ configured: true, stored: false, collectedAt: prepared.collectedAt,
    checkedAt: packet.collectedAt, snapshots: [], failures: ['The original prepared capture could not prove complete publication; no newer capture was substituted'], status: 'partial' });
  if (!completion.available) return partial();
  let completionRepaired = false, notificationRepaired = false;
  if (!completion.complete) {
    if (!completion.receiptsComplete) {
      const retained = { schemaVersion: 1, collectedAt: prepared.collectedAt, payload: { ...prepared.payload,
        sources: prepared.payload.sources.map(source => completion.captures.some(capture => capture.source === source.id) &&
          !['ready', 'stale'].includes(source.status) ? { ...source, status: 'stale', stale: true } : source) } };
      const repaired = await persistEarthCollection(env, retained, { now,
        matchesBaseline: (_payload, current) => matches(current) });
      if (!repaired.stored || !repaired.prepared?.promoted || repaired.prepared.collectedAt !== prepared.collectedAt ||
          repaired.prepared.inputDigest !== inputDigest) return partial();
      completionRepaired = true;
    }
    // Re-read the prepared pointer before announcing the exact original capture.
    const current = await readPreparedIntelligence(env, { now });
    if (!current || !await matches({ schemaVersion: 1, ...current })) throw new PreparedBaselineConflict('Prepared capture changed during repair');
    if (!completion.notificationComplete) {
      const repaired = await publishCollectionRevision(env, { at: prepared.collectedAt, digest: inputDigest,
        recordCount: prepared.payload.indexRecords.length });
      if (!repaired.stored || repaired.superseded || repaired.collectedAt !== prepared.collectedAt || repaired.inputDigest !== inputDigest)
        return partial();
      notificationRepaired = true; completionRepaired = true;
    }
    completion = await readCollectionCompletion(env, prepared, inputDigest, { now });
    if (!completion.available || !completion.complete) return partial();
  }
  const candidateSemantics = collectionSemantics(packet.payload);
  // A valid maximum batch ledger can exceed the external compact source envelope.
  // Select full publication before attempting any operational mutation; other
  // validation errors retain their ordinary bounded failure behavior.
  if (!fitsCollectionOperationalSources(packet.payload.sources) || candidateSemantics !== semantics ||
      await collectionFactsDigest(packet.payload.indexRecords) !== inputDigest) {
    const result = await persistEarthCollection(env, packet, { now });
    return { ...result, ...(completionRepaired ? { completionRepaired, notificationRepaired } : {}) };
  }
  const checked = await checkCollectionOperational(env, { collectedAt: packet.collectedAt,
    inputDigest, sources: packet.payload.sources }, { now, prepared, matchesBaseline: matches });
  if (checked.conflict) throw new PreparedBaselineConflict('Prepared capture changed before its operational check');
  return { ...checked, ...(completionRepaired ? { completionRepaired, notificationRepaired } : {}) };
}

/** Fixed adapters run independently of all visitor map/layer toggles. Trigger provisioning belongs to the host. */
export function collectEarthSources(env = {}, _ctx = {}, { now = Date.now, fetchImpl = fetch, snapshotReader } = {}) {
  const owner = env.EARTH_STORE || env;
  if (pending.has(owner)) return pending.get(owner);
  const work = (async () => {
    const middleware = service(env, now, fetchImpl, snapshotReader);
    const response = await middleware.handle(new Request('https://earth-observer.internal/api/intelligence?category=all'));
    if (!response.ok) throw new Error('Fixed-source collection did not produce an accepted response');
    const payload = await response.json();
    const packet = collectionPacket({ schemaVersion: 1, collectedAt: new Date(now()).toISOString(), payload }, now);
    const publication = await persistHostedCollection(env, packet, { now });
    return { ...publication, ...(!publication.configured ? { packet } : {}), plugins: COLLECTOR_PLUGINS.map((plugin) => plugin.id) };
  })().finally(() => { if (pending.get(owner) === work) pending.delete(owner); });
  pending.set(owner, work); return work;
}

/** Configuration is observable; having a runtime export alone never proves unattended execution. */
export async function getCollectorStatus(env = {}, { now = Date.now } = {}) {
  const prepared = await readPreparedIntelligence(env, { now });
  return { configured: Boolean(env.EARTH_STORE?.get && env.EARTH_STORE?.put), indexConfigured: Boolean(env.EARTH_DB?.prepare),
    runtimeAvailable: true, declaredTrigger: typeof env.EARTH_COLLECTION_TRIGGER === 'string' ? env.EARTH_COLLECTION_TRIGGER.slice(0, 80) : null,
    unattendedVerified: false, collectedAt: prepared?.collectedAt || null, ageMs: prepared?.ageMs ?? null,
    checkedAt: prepared?.checkedAt || null, checkAgeMs: prepared?.checkAgeMs ?? null,
    stale: prepared?.stale ?? true, plugins: COLLECTOR_PLUGINS,
    sources: prepared?.payload.sources || [],
    note: 'Fixed reviewed adapters and durable storage are implemented. Actual authenticated scheduled invocation must be provisioned and verified separately; display toggles never control collection.' };
}
