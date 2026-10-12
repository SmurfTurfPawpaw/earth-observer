import { pluginJson } from '../src/core/plugin-evidence.js';
import { worldHash } from '../src/core/world-identity.js';
import { PREPARED_SCENE_POLICY, PREPARED_SCENE_SOURCES, PREPARED_SCENE_LIMITS, comparePreparedSceneSources } from '../src/core/prepared-scene-contract.js';
import { buildPreparedScene, validateStoredPreparedScene } from './prepared-scene-builder.js';
import { readPreparedUsgsScene } from './prepared-usgs-store.js';
import { readWorldSourceItems } from './world-model.js';

export const PREPARED_SCENES_STORE_LIMITS = Object.freeze({ deadlineMs: 20000, operationMs: 3000, chunks: 4096,
  objectBytes: PREPARED_SCENE_LIMITS.objectBytes, objects: 4, totalBytes: PREPARED_SCENE_LIMITS.objectBytes * 4 });
export const PREPARED_SCENES_KEYS = Object.freeze(Object.fromEntries(Object.keys(PREPARED_SCENE_SOURCES).map(key => [key,
  Object.freeze({ current: `prepared/${PREPARED_SCENE_POLICY}/${key}/current.json`, prior: `prepared/${PREPARED_SCENE_POLICY}/${key}/prior.json` })])));
const UTF8 = new TextEncoder(), DECODER = new TextDecoder('utf-8', { fatal: true }), caches = new WeakMap(), inFlight = new WeakMap();
const equal = (a, b) => a && b && pluginJson(a) === pluginJson(b), fail = code => Object.assign(new Error(code), { code });
const configured = env => Boolean(env?.EARTH_DB?.prepare && env?.EARTH_STORE?.get && env?.EARTH_STORE?.put);
async function io(operation, signal) {
  const stopped = signal ? AbortSignal.any([signal, AbortSignal.timeout(PREPARED_SCENES_STORE_LIMITS.operationMs)]) : AbortSignal.timeout(PREPARED_SCENES_STORE_LIMITS.operationMs);
  stopped.throwIfAborted(); let cancel;
  try { return await Promise.race([Promise.resolve().then(() => { stopped.throwIfAborted(); return operation(); }), new Promise((_, reject) => {
    cancel = () => reject(fail(signal?.aborted ? 'scene-cancelled' : 'scene-storage-timeout')); stopped.addEventListener('abort', cancel, { once: true }); if (stopped.aborted) cancel(); })]); }
  finally { stopped.removeEventListener('abort', cancel); }
}
async function rows(env, text, values, signal) { const result = await io(() => env.EARTH_DB.prepare(text).bind(...values).all(), signal);
  if (!Array.isArray(result?.results) || result.success === false) throw fail('scene-storage-unavailable'); return result.results; }
const sourceFromRow = row => ({ pluginId: PREPARED_SCENE_SOURCES.earthquakes.scopeId, scopeId: PREPARED_SCENE_SOURCES.earthquakes.scopeId,
  receiptId: row.receipt_id, fence: Number(row.fence), factsDigest: row.facts_digest, rawSha256: row.raw_sha256, artifactSha256: row.artifact_sha256,
  capturedAt: row.captured_at, recordedAt: row.recorded_at, sourceGeneratedAt: row.source_updated_at,
  knowledgeMeaning: 'Whole-cohort receipt; not each report\'s first-known time' });
export async function readPreparedSceneHead(env, sourceKey, { now = Date.now, signal } = {}) {
  if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey)) throw new TypeError('Use the fixed prepared source'); signal?.throwIfAborted();
  if (sourceKey === 'earthquakes') {
    const row = (await rows(env, `SELECT c.*,s.checked_at,s.next_check_at,s.last_successful_at,s.status,
      s.source_updated_at AS operational_source_generated_at FROM earth_plugin_state s JOIN earth_plugin_captures c
      ON c.receipt_id=s.current_receipt AND c.plugin_id=s.plugin_id AND c.scope_id=s.scope_id WHERE s.plugin_id=? AND s.scope_id=?`,
      [PREPARED_SCENE_SOURCES.earthquakes.scopeId, PREPARED_SCENE_SOURCES.earthquakes.scopeId], signal))[0];
    if (!row) return null; const source = sourceFromRow(row), generationAge = Math.max(0, now() - Date.parse(row.operational_source_generated_at));
    return { source, check: { checkedAt: row.checked_at, nextCheckAt: row.next_check_at, lastSuccessfulAt: row.last_successful_at,
      status: row.status, sourceGeneratedAt: row.operational_source_generated_at }, stale: row.status !== 'ready' || generationAge > 120000, sourceGenerationAgeMs: generationAge };
  }
  const row = (await rows(env, `SELECT c.*,h.snapshot_id AS history_snapshot_id,h.record_count FROM earth_world_sources s
    JOIN earth_world_captures c ON c.source_id=s.source_id AND c.snapshot_id=s.snapshot_id AND c.captured_at=s.captured_at AND c.recorded_at=s.recorded_at
    JOIN earth_observations h ON h.source=s.source_id AND h.at=s.captured_at WHERE s.source_id=?`, ['gdacs'], signal))[0];
  if (!row) return null; if (row.history_snapshot_id !== row.snapshot_id || !Number.isInteger(row.record_count) || row.record_count < 0 || row.record_count > 100) throw fail('scene-source-head-incomplete');
  return { source: { sourceId: 'gdacs', scopeId: PREPARED_SCENE_SOURCES.gdacs.scopeId,
    version: await worldHash({ sourceId: 'gdacs', snapshotId: row.snapshot_id, capturedAt: row.captured_at, publishedAt: row.recorded_at }),
    snapshotId: row.snapshot_id, bodySha256: null, capturedAt: row.captured_at, publishedAt: row.recorded_at,
    knowledgeMeaning: 'Completed normalized source cohort; not independently observed impacts or each notice first-known time' },
    check: null, stale: null, sourceGenerationAgeMs: null };
}
const headBasis = (key, source) => key === 'gdacs' && source ? (({ bodySha256: _body, ...value }) => value)(source) : source;
const matchesHead = (key, source, head) => equal(headBasis(key, source), headBasis(key, head?.source));
const cacheFor = bucket => { let result = caches.get(bucket); if (!result) { result = new Map(); caches.set(bucket, result); } return result; };
async function bytes(object, signal) {
  if (!Number.isSafeInteger(object?.size) || object.size < 1 || object.size > PREPARED_SCENES_STORE_LIMITS.objectBytes) throw fail('scene-object-invalid');
  if (!object.body?.getReader) { const value = new Uint8Array(await io(() => object.arrayBuffer(), signal)); if (value.length !== object.size) throw fail('scene-object-invalid'); return value; }
  const reader = object.body.getReader(), parts = []; let size = 0, chunks = 0;
  try { for (;;) { const part = await io(() => reader.read(), signal); if (part.done) break;
    if (!(part.value instanceof Uint8Array) || !part.value.length || ++chunks > 4096 || (size += part.value.length) > object.size) throw fail('scene-object-invalid'); parts.push(part.value); }
    if (size !== object.size) throw fail('scene-object-invalid'); const result = new Uint8Array(size); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
}
async function readSlot(env, sourceKey, name, { now, signal, refresh = false, allowInvalid = false }) {
  const cache = cacheFor(env.EARTH_STORE), key = PREPARED_SCENES_KEYS[sourceKey][name], hit = cache.get(key); if (hit && !refresh) return hit;
  const object = await io(() => env.EARTH_STORE.get(key), signal); if (!object) { cache.delete(key); return { prepared: null, etag: null }; }
  if (typeof object.etag !== 'string' || !object.etag) throw fail('scene-conditional-storage-required');
  if (hit?.etag === object.etag) { void object.body?.cancel?.().catch(() => {}); return hit; }
  let prepared;
  try { prepared = await validateStoredPreparedScene(JSON.parse(DECODER.decode(await bytes(object, signal))), { now, signal });
    if (prepared.sourceKey !== sourceKey) throw new TypeError('Foreign scene slot'); }
  catch (error) {
    signal.throwIfAborted(); cache.delete(key);
    if (allowInvalid && (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError || error?.code === 'scene-object-invalid')) return { prepared: null, etag: object.etag, invalid: true };
    throw error;
  }
  const saved = { prepared, etag: object.etag }; cache.set(key, saved); return saved;
}
async function slot(env, sourceKey, name, options) {
  const hit = cacheFor(env.EARTH_STORE).get(PREPARED_SCENES_KEYS[sourceKey][name]); if (hit && !options.refresh) return hit;
  let tasks = inFlight.get(env.EARTH_STORE); if (!tasks) { tasks = new Map(); inFlight.set(env.EARTH_STORE, tasks); }
  // Two fixed sources ×two slots ×owner/reader=at most8 physical decodes.
  // An owner corruption descriptor never enters a public reader's admission.
  const key = `${sourceKey}:${name}:${options.allowInvalid ? 'owner' : 'reader'}`;
  const pending = tasks.get(key); if (pending) return io(() => pending, options.signal);
  const operation = readSlot(env, sourceKey, name, options); tasks.set(key, operation);
  try { return await operation; } finally { if (tasks.get(key) === operation) tasks.delete(key); }
}
async function write(env, sourceKey, name, prepared, expected, options) {
  const key = PREPARED_SCENES_KEYS[sourceKey][name], body = UTF8.encode(pluginJson(prepared)); if (body.length > PREPARED_SCENES_STORE_LIMITS.objectBytes) throw fail('scene-object-invalid');
  let result;
  try { result = await io(() => env.EARTH_STORE.put(key, body, { onlyIf: expected === null ? new Headers({ 'if-none-match': '*' }) : { etagMatches: expected },
    httpMetadata: { contentType: 'application/json' } }), options.signal); }
  catch { const actual = await slot(env, sourceKey, name, { ...options, refresh: true, allowInvalid: true }); return { committed: actual.prepared?.version === prepared.version, uncertain: true }; }
  if (!result || typeof result.etag !== 'string') { const actual = await slot(env, sourceKey, name, { ...options, refresh: true, allowInvalid: true }); return { committed: actual.prepared?.version === prepared.version, uncertain: result !== null }; }
  cacheFor(env.EARTH_STORE).set(key, { prepared, etag: result.etag }); return { committed: true, uncertain: false };
}
async function retainedBasis(env, sourceKey, prepared, signal) {
  if (!prepared) return false;
  if (sourceKey === 'earthquakes') {
    const row = (await rows(env, 'SELECT * FROM earth_plugin_captures WHERE receipt_id=? AND plugin_id=? AND scope_id=?',
      [prepared.source.receiptId, PREPARED_SCENE_SOURCES.earthquakes.scopeId, PREPARED_SCENE_SOURCES.earthquakes.scopeId], signal))[0];
    return row && equal(sourceFromRow(row), prepared.source);
  }
  return Boolean((await rows(env, `SELECT c.source_id FROM earth_world_captures c JOIN earth_observations h ON h.source=c.source_id AND h.at=c.captured_at AND h.snapshot_id=c.snapshot_id
    WHERE c.source_id=? AND c.snapshot_id=? AND c.captured_at=? AND c.recorded_at=?`, ['gdacs', prepared.source.snapshotId, prepared.source.capturedAt, prepared.source.publishedAt], signal))[0]);
}
const defaultInput = (env, key, options) => key === 'earthquakes' ? readPreparedUsgsScene(env, options) : readWorldSourceItems(env, { source: 'gdacs' }, options);
export async function ensurePreparedScene(env, sourceKey, { now = Date.now, signal: external, readHead = readPreparedSceneHead, readInput = defaultInput } = {}) {
  if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey)) throw new TypeError('Use the fixed prepared source'); if (!configured(env)) return { configured: false, status: 'unavailable' };
  const signal = external ? AbortSignal.any([external, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), options = { now, signal };
  try {
    const head = await io(() => readHead(env, sourceKey, options), signal); if (!head) return { configured: true, status: 'unavailable' };
    const current = await slot(env, sourceKey, 'current', { ...options, refresh: true, allowInvalid: true });
    if (matchesHead(sourceKey, current.prepared?.source, head)) return { configured: true, status: 'ready', version: current.prepared.version };
    if (current.prepared) { const order = comparePreparedSceneSources(sourceKey, head.source, current.prepared.source);
      if (order === null && !matchesHead(sourceKey, current.prepared.source, head) || order < 0) return { configured: true, status: 'superseded' }; }
    const input = await io(() => readInput(env, sourceKey, options), signal), candidate = await buildPreparedScene(sourceKey, input, options);
    if (!matchesHead(sourceKey, candidate.source, head)) return { configured: true, status: 'superseded' };
    const previous = current.prepared && await retainedBasis(env, sourceKey, current.prepared, signal) ? current.prepared : null;
    const latest = await io(() => readHead(env, sourceKey, options), signal); if (!matchesHead(sourceKey, candidate.source, latest)) return { configured: true, status: 'superseded' };
    if (previous) {
      const prior = await slot(env, sourceKey, 'prior', { ...options, refresh: true, allowInvalid: true });
      if (prior.prepared && comparePreparedSceneSources(sourceKey, prior.prepared.source, previous.source) > 0) return { configured: true, status: 'superseded' };
      const promotedPrior = await write(env, sourceKey, 'prior', previous, prior.etag, options);
      if (!promotedPrior.committed) return { configured: true, status: 'pending', uncertain: promotedPrior.uncertain };
    }
    if (!matchesHead(sourceKey, candidate.source, await io(() => readHead(env, sourceKey, options), signal))) return { configured: true, status: 'superseded' };
    const saved = await write(env, sourceKey, 'current', candidate, current.etag, options);
    if (!matchesHead(sourceKey, candidate.source, await io(() => readHead(env, sourceKey, options), signal))) return { configured: true, status: 'superseded' };
    return { configured: true, status: saved.committed ? 'prepared' : 'pending', uncertain: saved.uncertain, version: saved.committed ? candidate.version : null };
  } catch (error) { return { configured: true, status: signal.aborted ? 'cancelled' : 'pending', errorCode: error?.code || 'scene-preparation-unavailable' }; }
}
export async function readPreparedScene(env, sourceKey, { now = Date.now, signal: external, includePrior = false, readHead = readPreparedSceneHead } = {}) {
  if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey)) throw new TypeError('Use the fixed prepared source');
  const base = { schemaVersion: 1, policyId: PREPARED_SCENE_POLICY, sourceKey, configured: configured(env), available: false, pending: false,
    source: null, check: null, stale: null, sourceGenerationAgeMs: null, prepared: null, prior: null };
  if (!base.configured) return base;
  const signal = external ? AbortSignal.any([external, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), options = { now, signal };
  try { for (let attempt = 0; attempt < 2; ++attempt) {
    signal.throwIfAborted(); const head = await io(() => readHead(env, sourceKey, options), signal); if (!head) return base;
    let current = await slot(env, sourceKey, 'current', options); if (!matchesHead(sourceKey, current.prepared?.source, head)) current = await slot(env, sourceKey, 'current', { ...options, refresh: true });
    let prior = null; if (includePrior) { try { const found = await slot(env, sourceKey, 'prior', { ...options, refresh: true });
      if (found.prepared && await retainedBasis(env, sourceKey, found.prepared, signal)) {
        const order = comparePreparedSceneSources(sourceKey, found.prepared.source, current.prepared?.source || head.source);
        if (order === -1 || order === 0 || sourceKey === 'gdacs' && matchesHead(sourceKey, found.prepared.source, head)) prior = found.prepared;
      }
    } catch { signal.throwIfAborted(); } }
    const latest = await io(() => readHead(env, sourceKey, options), signal);
    if (!equal(headBasis(sourceKey, head.source), headBasis(sourceKey, latest?.source))) { if (!attempt) continue; return { ...base, pending: true, errorCode: 'scene-head-changed' }; }
    if (!matchesHead(sourceKey, current.prepared?.source, head)) return { ...base, pending: true, errorCode: 'scene-preparation-pending' };
    return { ...base, available: true, source: current.prepared.source, check: head.check, stale: head.stale,
      sourceGenerationAgeMs: head.sourceGenerationAgeMs, prepared: current.prepared, prior };
  } } catch (error) { return { ...base, errorCode: signal.aborted ? 'scene-read-cancelled' : error?.code || 'stored-scene-unavailable' }; }
}
