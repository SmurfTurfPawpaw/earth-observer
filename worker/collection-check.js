import { collectionFactsDigest } from '../src/core/collection-facts.js';
import { readPreparedIntelligence, writePreparedOperationalCheck, PreparedBaselineConflict } from './history.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sourceIds = new Set(['usgs', 'gdacs', 'eonet', 'gdelt']);
const statuses = new Set(['ready', 'stale', 'busy', 'unavailable', 'not-applicable']);
export const COLLECTION_OPERATIONAL_SOURCE_MAX_BYTES = 32768;
export const fitsCollectionOperationalSources = sources => Array.isArray(sources) && sources.length <= 20 &&
  bytes(sources) <= COLLECTION_OPERATIONAL_SOURCE_MAX_BYTES;
const payloadKeys = new Set(['reports', 'sources', 'indexRecords', 'indexVersion', 'indexCoverage', 'retrievedAt',
  'filters', 'nextRefreshMs', 'grouping', 'coverage']);
const sourceKeys = new Set(['id', 'name', 'url', 'status', 'stale', 'retrievedAt', 'snapshotRetrievedAt', 'snapshotCheckedAt',
  'generatedAt', 'ageMs', 'sourceAgeMs', 'refreshIntervalMs', 'sourceCadenceMs', 'retryAt', 'coverage', 'filtersAppliedLocally',
  'processedBatches', 'sampleGaps', 'windowStart', 'windowEnd', 'countryMeaning', 'reason', 'mode', 'kind', 'countriesAvailable',
  'atLimit', 'retainedEvents', 'lastAttemptAt', 'lastCheckedAt', 'lastSuccessfulCheckAt', 'checkAgeMs', 'catchup']);
const operationalKeys = new Set(['status', 'stale', 'retrievedAt', 'snapshotRetrievedAt', 'snapshotCheckedAt', 'ageMs',
  'sourceAgeMs', 'retryAt', 'reason', 'lastAttemptAt', 'lastCheckedAt', 'lastSuccessfulCheckAt', 'checkAgeMs', 'catchup']);
const coverageKeys = new Set(['schemaVersion', 'recordCount', 'byteLength', 'maxRecords', 'maxBytes', 'omittedRecords', 'sources', 'note']);
const scopeKeys = new Set(['id', 'generation', 'status', 'coverage', 'expiresAt', 'recordCount', 'categories']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => object(value) && Object.keys(value).every(key => keys.has(key));
function hazardGeneration(id, generation) {
  const prefix = `${id}:global:`;
  if (typeof generation !== 'string' || !generation.startsWith(prefix)) return null;
  const suffix = generation.slice(prefix.length);
  return suffix === 'unavailable' ? `${prefix}unavailable` : iso(suffix) ? `${prefix}acquired` : null;
}
export function collectionCaptureSources(payload) {
  if (!Array.isArray(payload?.sources) || !Array.isArray(payload?.indexCoverage?.sources) || !Array.isArray(payload?.indexRecords)) return null;
  const scopes = new Map(payload.indexCoverage.sources.map(scope => [scope?.id, scope]));
  const ids = [];
  for (const source of payload.sources) {
    const generation = scopes.get(source.id)?.generation;
    const retained = payload.indexRecords.some(record => record.sourceId === source.id);
    const acquired = ['usgs', 'gdacs'].includes(source.id) ? hazardGeneration(source.id, generation) === `${source.id}:global:acquired` :
      source.id === 'eonet' ? /^[a-f0-9]{64}$/.test(generation || '') : source.id === 'gdelt' ? iso(generation) : false;
    if (retained || acquired) ids.push(source.id);
    else if (!sourceIds.has(source.id)) return null;
  }
  return ids.sort();
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/** Versioned reviewed adapter semantics, distinct from the factual-record digest.
 * Unknown fields/modes force the full path. Retrieval-derived hazard generations
 * and EONET generatedAt are operational; GDELT generation/batches/gaps are evidence.
 */
export function collectionSemantics(payload) {
  if (!known(payload, payloadKeys) || !Array.isArray(payload.sources) || !payload.sources.length || payload.sources.length > 4 ||
      !known(payload.indexCoverage, coverageKeys) || payload.indexCoverage.schemaVersion !== 1 ||
      !Array.isArray(payload.indexCoverage.sources) || payload.indexCoverage.sources.length !== payload.sources.length) return null;
  const sources = payload.sources, scopes = new Map(payload.indexCoverage.sources.map(scope => [scope?.id, scope]));
  if (scopes.size !== sources.length || new Set(sources.map(source => source?.id)).size !== sources.length) return null;
  const projected = [];
  for (const source of sources) {
    const scope = scopes.get(source?.id);
    if (!known(source, sourceKeys) || !sourceIds.has(source.id) || !statuses.has(source.status) ||
        !known(scope, scopeKeys) || !statuses.has(scope.status) || typeof scope.generation !== 'string') return null;
    if (source.id === 'gdelt' && !['scheduled-gkg', 'scheduled-snapshot'].includes(source.mode) ||
        source.id === 'eonet' && !['live-eonet', 'scheduled-eonet-fallback'].includes(source.mode) ||
        ['usgs', 'gdacs'].includes(source.id) && source.mode !== undefined) return null;
    if (source.catchup !== undefined && (source.id !== 'gdelt' || !object(source.catchup) || source.catchup.schemaVersion !== 1 ||
        !Object.keys(source.catchup).every(key => ['schemaVersion', 'checkedAt', 'latestBatch', 'attemptedBatches', 'attempts',
          'pendingBatches', 'deferredBatches', 'cappedBatches', 'budget'].includes(key)))) return null;
    const semanticSource = Object.fromEntries(Object.entries(source).filter(([key]) => !operationalKeys.has(key) &&
      !(key === 'generatedAt' && source.id !== 'gdelt')));
    const semanticScope = Object.fromEntries(Object.entries(scope).filter(([key]) => !['status', 'expiresAt', 'recordCount'].includes(key) &&
      !(key === 'generation' && ['usgs', 'gdacs'].includes(source.id))));
    if (['usgs', 'gdacs'].includes(source.id)) {
      const generation = hazardGeneration(source.id, scope.generation);
      if (!generation) return null;
      semanticScope.generation = generation;
    }
    projected.push({ source: semanticSource, scope: semanticScope });
  }
  projected.sort((a, b) => a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0);
  const coverage = Object.fromEntries(Object.entries(payload.indexCoverage).filter(([key]) =>
    !['sources', 'recordCount', 'byteLength'].includes(key)));
  return JSON.stringify(stable({ version: 1, sources: projected, captures: collectionCaptureSources(payload), indexCoverage: coverage,
    grouping: payload.grouping ?? null, coverage: payload.coverage ?? null }));
}

export async function matchesCollectionBaseline(current, expected, inputDigest, semantics) {
  return Boolean(current?.schemaVersion === 1 && current.collectedAt === expected.collectedAt && semantics !== null &&
    collectionSemantics(current.payload) === semantics && await collectionFactsDigest(current.payload.indexRecords) === inputDigest);
}

/** External and hosted operational checks share validation and exact record preservation. */
export async function checkCollectionOperational(env, input, { now = Date.now, prepared, matchesBaseline } = {}) {
  if (!iso(input.collectedAt) || Date.parse(input.collectedAt) > now() + 300000 || !/^[a-f0-9]{64}$/.test(input.inputDigest || '') ||
      !fitsCollectionOperationalSources(input.sources))
    throw new TypeError('Invalid bounded collector heartbeat');
  prepared ||= await readPreparedIntelligence(env, { now });
  if (!prepared || await collectionFactsDigest(prepared.payload.indexRecords) !== input.inputDigest) return { conflict: true };
  const existing = new Map(prepared.payload.sources.map(source => [source.id, source]));
  if (new Set(input.sources.map(source => source.id)).size !== input.sources.length || input.sources.length !== existing.size ||
      input.sources.some(source => !existing.has(source.id) || !statuses.has(source.status)))
    throw new TypeError('Heartbeat source identities do not match the prepared collection');
  for (const incoming of input.sources) {
    for (const key of ['retrievedAt', 'snapshotRetrievedAt', 'snapshotCheckedAt', 'lastAttemptAt', 'lastCheckedAt']) {
      if (incoming[key] == null) continue;
      if (!iso(incoming[key]) || Date.parse(incoming[key]) > Date.parse(input.collectedAt) + 300000) throw new TypeError('Invalid source check date');
    }
    if (incoming.catchup !== undefined && (incoming.id !== 'gdelt' || incoming.catchup?.schemaVersion !== 1 ||
        !iso(incoming.catchup.checkedAt) || Date.parse(incoming.catchup.checkedAt) > Date.parse(input.collectedAt) + 300000))
      throw new TypeError('Invalid operational source retry date');
  }
  const publication = await writePreparedOperationalCheck(env, { checkedAt: input.collectedAt, inputDigest: input.inputDigest }, async current => {
    const currentSources = new Map(current.sources.map(source => [source.id, source]));
    if (currentSources.size !== input.sources.length || input.sources.some(source => !currentSources.has(source.id)))
      throw new PreparedBaselineConflict('Prepared source scope changed');
    const sources = input.sources.map(incoming => {
      const previous = currentSources.get(incoming.id), source = { ...previous, status: incoming.status, stale: incoming.stale === true };
      for (const key of ['lastAttemptAt', 'lastCheckedAt', 'snapshotCheckedAt'])
        if (incoming[key] && (!source[key] || incoming[key] >= source[key])) source[key] = incoming[key];
      if (incoming.snapshotCheckedAt && (!source.lastCheckedAt || incoming.snapshotCheckedAt >= source.lastCheckedAt))
        source.lastCheckedAt = incoming.snapshotCheckedAt;
      if (incoming.id === 'gdelt' && incoming.catchup?.schemaVersion === 1 &&
          (!source.catchup?.checkedAt || incoming.catchup.checkedAt >= source.catchup.checkedAt)) source.catchup = incoming.catchup;
      if (incoming.status === 'ready' && incoming.retrievedAt) {
        if (!source.lastSuccessfulCheckAt || incoming.retrievedAt >= source.lastSuccessfulCheckAt) source.lastSuccessfulCheckAt = incoming.retrievedAt;
        if (!source.lastCheckedAt || incoming.retrievedAt >= source.lastCheckedAt) source.lastCheckedAt = incoming.retrievedAt;
      }
      if (typeof incoming.reason === 'string') source.reason = incoming.reason.slice(0, 2000);
      else if (incoming.status === 'ready') delete source.reason;
      source.retryAt = Number.isFinite(incoming.retryAt) ? incoming.retryAt : null;
      source.ageMs = source.retrievedAt ? Math.max(0, Date.parse(input.collectedAt) - Date.parse(source.retrievedAt)) : null;
      source.checkAgeMs = source.lastCheckedAt ? Math.max(0, Date.parse(input.collectedAt) - Date.parse(source.lastCheckedAt)) : null;
      return source;
    });
    const states = new Map(sources.map(source => [source.id, source]));
    return { ...current, sources, indexCoverage: { ...current.indexCoverage, sources: current.indexCoverage.sources.map(scope => {
      const source = states.get(scope.id), checked = source?.status === 'ready' && source.id !== 'gdelt' && source.lastSuccessfulCheckAt;
      return { ...scope, status: source?.status || scope.status,
        ...(checked ? { expiresAt: new Date(Date.parse(source.lastSuccessfulCheckAt) + 86400000).toISOString() } : {}) };
    }) } };
  }, { matchesBaseline });
  return { ...publication, heartbeat: true, snapshots: [], failures: [], status: publication.stored ? 'stored' : 'unavailable' };
}
