import { collectionFactsDigest } from '../src/core/collection-facts.js';
export { collectionFactsDigest } from '../src/core/collection-facts.js';
import { checkCollectionOperational } from './collection-check.js';
import { persistEarthCollection } from './collector.js';
import { readPreparedIntelligence } from './history.js';

const encoder = new TextEncoder(), ANALYSIS_LIMIT = 64 * 1024;
const bytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 500;

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

/** Compact checks share the hosted validator without importing its collector. */
export const heartbeatCollection = (env, input, options) => checkCollectionOperational(env, input, options);

export async function readLocalAnalysis(env, { now = Date.now } = {}) {
  const pointer = (await object(env.EARTH_STORE, 'collection/current-analysis.json'))?.value;
  if (!pointer || !/^[a-f0-9]{64}$/.test(pointer.artifactId || '')) return null;
  const artifact = (await object(env.EARTH_STORE, `collection/analysis/${pointer.artifactId}.json`))?.value;
  if (!artifact || await digest(artifact) !== pointer.artifactId) throw new Error('Derived analysis integrity check failed');
  const prepared = await readPreparedIntelligence(env, { now });
  return { ...artifact, derived: true, currentFactsMatch: Boolean(prepared && await collectionFactsDigest(prepared.payload.indexRecords) === artifact.inputDigest),
    note: 'Local processing labels are derived metadata, separate from source facts. They do not establish verification, confidence or causation.' };
}
