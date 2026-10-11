import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { persistEarthCollection } from './collector.js';
import { readPreparedIntelligence, writePreparedOperationalCheck, PreparedBaselineConflict } from './history.js';

const encoder = new TextEncoder(), ANALYSIS_LIMIT = 64 * 1024;
const bytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 500;

/** Same portable digest as the laptop: canonical records, ordinal ID order, retrieval clock excluded only. */
export async function collectionFactsDigest(records) {
  if (!Array.isArray(records) || records.length > 500) throw new TypeError('Invalid metadata bounds');
  const normalized = records.map(canonicalDiscoveryRecord);
  if (normalized.some((record) => !record) || new Set(normalized.map((record) => record.id)).size !== normalized.length)
    throw new TypeError('Invalid canonical metadata');
  normalized.sort((a, b) => ordinal(a.id, b.id));
  return digest(normalized.map(({ retrievedAt: _retrievedAt, ...facts }) => facts));
}

function validateAnalysis(value, packet) {
  if (!keys(value, ['schemaVersion', 'method', 'createdAt', 'inputDigest', 'changes', 'topics', 'analysis']) ||
      value.schemaVersion !== 1 || !text(value.method, 120) || value.createdAt !== packet.collectedAt ||
      !/^[a-f0-9]{64}$/.test(value.inputDigest || '') || !keys(value.changes, ['added', 'revised', 'withdrawn']) ||
      !['added', 'revised', 'withdrawn'].every((key) => count(value.changes[key])) ||
      !Array.isArray(value.topics) || value.topics.length > 80 ||
      value.topics.some((row) => !keys(row, ['label', 'count']) || !text(row.label, 80) || !count(row.count)) ||
      !Array.isArray(value.analysis) || value.analysis.length > 500 || bytes(value) > ANALYSIS_LIMIT)
    throw new TypeError('Invalid bounded local analysis');
  const ids = new Set(packet.payload.indexRecords.map((record) => record.id)), seen = new Set();
  for (const row of value.analysis) {
    if (!keys(row, ['id', 'labels', 'summary']) || !ids.has(row.id) || seen.has(row.id) ||
        !Array.isArray(row.labels) || row.labels.length > 12 || row.labels.some((label) => !text(label, 80)) ||
        row.summary !== undefined && !text(row.summary, 500)) throw new TypeError('Derived analysis must reference current source metadata');
    seen.add(row.id);
  }
  return value;
}

async function object(bucket, key) {
  const saved = await bucket.get(key);
  if (!saved) return null;
  if (saved.size > ANALYSIS_LIMIT + 2048) throw new Error('Stored derived analysis exceeds its limit');
  return { value: await saved.json(), etag: saved.etag };
}

async function storeAnalysis(env, analysis) {
  const artifactId = await digest(analysis), key = `collection/analysis/${artifactId}.json`;
  if (!await env.EARTH_STORE.get(key)) await env.EARTH_STORE.put(key, JSON.stringify(analysis), {
    onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' },
  });
  const pointer = { schemaVersion: 1, artifactId, createdAt: analysis.createdAt, inputDigest: analysis.inputDigest };
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await object(env.EARTH_STORE, 'collection/current-analysis.json');
    if (previous?.value.createdAt > analysis.createdAt) return previous.value;
    const saved = await env.EARTH_STORE.put('collection/current-analysis.json', JSON.stringify(pointer), {
      onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ 'if-none-match': '*' }),
      httpMetadata: { contentType: 'application/json' },
    });
    if (saved) return pointer;
  }
  throw new Error('Derived analysis publication conflicted; retry the retained packet');
}

export async function publishLocalCollection(env, packet, inputAnalysis, { now = Date.now } = {}) {
  if (!packet?.payload || !Array.isArray(packet.payload.indexRecords) ||
      !Array.isArray(packet.payload.indexCoverage?.sources) || packet.payload.indexCoverage.schemaVersion !== 1)
    throw new TypeError('A prepared metadata index is required');
  const analysis = validateAnalysis(inputAnalysis, packet);
  if (await collectionFactsDigest(packet.payload.indexRecords) !== analysis.inputDigest) throw new TypeError('Local analysis digest does not match source facts');
  const publication = await persistEarthCollection(env, packet, { now });
  if (publication.stored && !publication.failures.length) await storeAnalysis(env, analysis);
  return { ...publication, stored: Boolean(publication.stored && !publication.failures.length),
    analysisStored: Boolean(publication.stored && !publication.failures.length), inputDigest: analysis.inputDigest };
}

/** Unchanged data travels as clocks/status only. A changed server baseline requests a full packet with HTTP 409. */
export async function heartbeatCollection(env, input, { now = Date.now } = {}) {
  if (!iso(input.collectedAt) || Date.parse(input.collectedAt) > now() + 300000 || !/^[a-f0-9]{64}$/.test(input.inputDigest || '') ||
      !Array.isArray(input.sources) || input.sources.length > 20 || bytes(input.sources) > 32768)
    throw new TypeError('Invalid bounded collector heartbeat');
  const prepared = await readPreparedIntelligence(env, { now });
  if (!prepared || await collectionFactsDigest(prepared.payload.indexRecords) !== input.inputDigest) return { conflict: true };
  const existing = new Map(prepared.payload.sources.map((source) => [source.id, source]));
  if (new Set(input.sources.map((source) => source.id)).size !== input.sources.length || input.sources.length !== existing.size ||
      input.sources.some((source) => !existing.has(source.id) || !['ready', 'stale', 'busy', 'unavailable', 'not-applicable'].includes(source.status)))
    throw new TypeError('Heartbeat source identities do not match the prepared collection');
  for (const incoming of input.sources) {
    for (const key of ['retrievedAt', 'snapshotRetrievedAt', 'lastAttemptAt', 'lastCheckedAt']) {
      if (incoming[key] == null) continue;
      if (!iso(incoming[key]) || Date.parse(incoming[key]) > Date.parse(input.collectedAt) + 300000) throw new TypeError('Invalid source check date');
    }
  }
  const publication = await writePreparedOperationalCheck(env, { checkedAt: input.collectedAt, inputDigest: input.inputDigest }, async (current) => {
    const currentSources = new Map(current.sources.map((source) => [source.id, source]));
    if (currentSources.size !== input.sources.length || input.sources.some((source) => !currentSources.has(source.id)))
      throw new PreparedBaselineConflict('Prepared source scope changed');
    const sources = input.sources.map((incoming) => {
      const previous = currentSources.get(incoming.id), source = { ...previous, status: incoming.status, stale: incoming.stale === true };
      for (const key of ['lastAttemptAt', 'lastCheckedAt']) if (incoming[key] && (!source[key] || incoming[key] >= source[key])) source[key] = incoming[key];
      // Incoming successful retrieval/check dates describe a new operational
      // check, not another retained source body or a factual capture.
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
    const states = new Map(sources.map((source) => [source.id, source]));
    return { ...current, sources, indexCoverage: { ...current.indexCoverage, sources: current.indexCoverage.sources.map((scope) => {
      const source = states.get(scope.id), checked = source?.status === 'ready' && source.id !== 'gdelt' && source.lastSuccessfulCheckAt;
      return { ...scope, status: source?.status || scope.status,
        ...(checked ? { expiresAt: new Date(Date.parse(source.lastSuccessfulCheckAt) + 86400000).toISOString() } : {}) };
    }) } };
  });
  return { ...publication, heartbeat: true, snapshots: [], failures: [], status: publication.stored ? 'stored' : 'unavailable' };
}

export async function readLocalAnalysis(env, { now = Date.now } = {}) {
  const pointer = (await object(env.EARTH_STORE, 'collection/current-analysis.json'))?.value;
  if (!pointer || !/^[a-f0-9]{64}$/.test(pointer.artifactId || '')) return null;
  const artifact = (await object(env.EARTH_STORE, `collection/analysis/${pointer.artifactId}.json`))?.value;
  if (!artifact || await digest(artifact) !== pointer.artifactId) throw new Error('Derived analysis integrity check failed');
  const prepared = await readPreparedIntelligence(env, { now });
  return { ...artifact, derived: true, currentFactsMatch: Boolean(prepared && await collectionFactsDigest(prepared.payload.indexRecords) === artifact.inputDigest),
    note: 'Local processing labels are derived metadata, separate from source facts. They do not establish verification, confidence or causation.' };
}
