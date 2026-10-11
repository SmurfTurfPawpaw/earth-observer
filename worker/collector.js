import { intelligenceProxy } from '../server/hosted/intelligence.js';
import { EONET_QUERY_URL } from '../server/hosted/eonet-snapshot.js';
import { GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { createProviderStore } from './storage.js';
import { createWorkerFetch } from './fetch.js';
import { createWorkerMiddleware } from './middleware.js';
import { appendHistorySnapshot, readPreparedIntelligence, writePreparedIntelligence, PreparedBaselineConflict } from './history.js';

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

function service(env, now, fetchImpl) {
  const owner = env.EARTH_STORE || env;
  const saved = services.get(owner);
  if (saved?.now === now && saved.fetchImpl === fetchImpl) return saved.middleware;
  const middleware = createWorkerMiddleware([intelligenceProxy({ fetchImpl: createWorkerFetch(fetchImpl), now,
    env: { ...env, GDELT_LIVE_FALLBACK: '0' }, snapshotStore: createProviderStore(env) })]);
  saved?.middleware.close(); services.set(owner, { middleware, now, fetchImpl }); return middleware;
}

function collectionPacket(packet, now) {
  if (packet?.schemaVersion !== 1 || typeof packet.collectedAt !== 'string' ||
      !Number.isFinite(Date.parse(packet.collectedAt)) || new Date(packet.collectedAt).toISOString() !== packet.collectedAt ||
      Date.parse(packet.collectedAt) > now() + 300000 || !Array.isArray(packet.payload?.indexRecords) ||
      packet.payload.indexRecords.length > 500 || !Array.isArray(packet.payload?.sources) || packet.payload.sources.length > 20 || bytes(packet) > 1200000)
    throw new TypeError('Invalid bounded collection packet');
  const records = packet.payload.indexRecords.map(canonicalDiscoveryRecord);
  if (records.some((record) => !record || !pluginIds.has(record.sourceId)) ||
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
  try { prepared = await writePreparedIntelligence(env, packet.payload, { now: capturedNow, matchesBaseline }); }
  catch (error) {
    if (error instanceof PreparedBaselineConflict) throw error;
    return { configured: true, stored: false, collectedAt: packet.collectedAt, snapshots,
      failures: ['Prepared current intelligence publication was unavailable; the previous publication was retained'], status: 'partial' };
  }
  const work = packet.payload.sources.filter((source) => ['ready', 'stale'].includes(source.status)).map(async (source) => {
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
  return { configured: true, stored: Boolean(prepared?.stored), collectedAt: packet.collectedAt, snapshots, failures,
    indexConfigured: Boolean(env.EARTH_DB?.prepare), prepared: prepared || null, status: failures.length ? 'partial' : 'stored' };
}

/** Fixed adapters run independently of all visitor map/layer toggles. Trigger provisioning belongs to the host. */
export function collectEarthSources(env = {}, _ctx = {}, { now = Date.now, fetchImpl = fetch } = {}) {
  const owner = env.EARTH_STORE || env;
  if (pending.has(owner)) return pending.get(owner);
  const work = (async () => {
    const middleware = service(env, now, fetchImpl);
    const response = await middleware.handle(new Request('https://earth-observer.internal/api/intelligence?category=all'));
    if (!response.ok) throw new Error('Fixed-source collection did not produce an accepted response');
    const payload = await response.json();
    const packet = collectionPacket({ schemaVersion: 1, collectedAt: new Date(now()).toISOString(), payload }, now);
    const publication = await persistEarthCollection(env, packet, { now });
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
    stale: prepared?.stale ?? true, plugins: COLLECTOR_PLUGINS,
    sources: prepared?.payload.sources || [],
    note: 'Fixed reviewed adapters and durable storage are implemented. Actual authenticated scheduled invocation must be provisioned and verified separately; display toggles never control collection.' };
}
