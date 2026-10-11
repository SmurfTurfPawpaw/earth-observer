import { pluginBytesDigest, pluginFactsDigest, pluginJson } from '../../src/core/plugin-evidence.js';
import { sourcePlugin, publicPlugin } from './registry.js';

export const PLUGIN_STORE_LIMITS = Object.freeze({ deadlineMs: 27000, storageMs: 2000,
  leaseMs: 60000, factsBytes: 768 * 1024, artifactBytes: 65536, projectionBytes: 65536,
  maximumItems: 32, maximumRetryMs: 86400000, historicalMemberships: 4096 });
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')", UTF8 = new TextEncoder();
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const configured = env => Boolean(env?.EARTH_DB?.prepare && env?.EARTH_DB?.batch && env?.EARTH_STORE?.get && env?.EARTH_STORE?.put);
const primary = env => env.EARTH_DB.withSession?.('first-primary') || env.EARTH_DB;
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
const fail = code => Object.assign(new Error(code), { code });
const path = (plugin, type, hash) => `plugins/${plugin.pluginId}/${type}/${hash}`;

async function io(operation, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), PLUGIN_STORE_LIMITS.storageMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let stop;
  try {
    return await Promise.race([Promise.resolve().then(() => { combined.throwIfAborted(); return operation(); }),
      new Promise((_, reject) => { stop = () => reject(fail('storage_unavailable')); combined.addEventListener('abort', stop, { once: true });
        if (combined.aborted) stop(); })]);
  } finally { clearTimeout(timer); combined.removeEventListener('abort', stop); }
}
async function rows(db, sql, values = [], signal) {
  const result = await io(() => db.prepare(sql).bind(...values).all(), signal);
  if (result?.success === false || !Array.isArray(result?.results)) throw fail('storage_unavailable');
  return result.results;
}
async function batch(db, statements, signal) {
  const result = await io(() => db.batch(statements), signal);
  if (!Array.isArray(result) || result.length !== statements.length || result.some(x => x?.success === false)) throw fail('storage_unavailable');
  return result;
}
async function objectBytes(object, max, signal) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(PLUGIN_STORE_LIMITS.storageMs)]) : AbortSignal.timeout(PLUGIN_STORE_LIMITS.storageMs);
  if (!object || Number.isFinite(object.size) && object.size > max) throw fail('storage_unavailable');
  if (!object.body?.getReader) {
    const value = object.arrayBuffer ? new Uint8Array(await io(() => object.arrayBuffer(), signal)) : UTF8.encode(await io(() => object.text(), signal));
    if (value.byteLength > max) throw fail('storage_unavailable'); return value;
  }
  const reader = object.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { value, done } = await io(() => reader.read(), signal); if (done) break;
      size += value.byteLength; if (size > max) throw fail('storage_unavailable'); chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
}
async function immutable(env, key, bytes, hash, mediaType, signal) {
  if (await pluginBytesDigest(bytes) !== hash) throw fail('evidence_digest_mismatch');
  const saved = await io(() => env.EARTH_STORE.put(key, bytes, { onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: { contentType: mediaType } }), signal);
  if (saved === null) {
    const retained = await objectBytes(await io(() => env.EARTH_STORE.get(key), signal), bytes.byteLength, signal);
    if (await pluginBytesDigest(retained) !== hash) throw fail('evidence_digest_mismatch');
  }
}
function descriptor(plugin) {
  if (!plugin || !/^[a-z][a-z0-9-]{1,79}$/.test(plugin.pluginId || '') || !/^[a-z][a-z0-9-]{1,79}$/.test(plugin.scopeId || '') ||
    !['dataset', 'publication-feed'].includes(plugin.kind) || typeof plugin.collect !== 'function' || typeof plugin.items !== 'function' ||
    !Number.isSafeInteger(plugin.cadenceMs) || plugin.cadenceMs < 60000 || plugin.cadenceMs > 86400000 ||
    !Number.isSafeInteger(plugin.maxItems) || plugin.maxItems < 1 || plugin.maxItems > PLUGIN_STORE_LIMITS.maximumItems ||
    !Number.isSafeInteger(plugin.maxResponseBytes) || plugin.maxResponseBytes < 1 || plugin.maxResponseBytes > 524288)
    throw new TypeError('Use a reviewed fixed source plugin with bounded admission');
  return plugin;
}
function projection(item, plugin) {
  if (!item || typeof item.itemId !== 'string' || item.itemId.length > 256 || !item.itemId || !digest(item.sourceRevision) ||
    typeof item.sourceRecordId !== 'string' || !item.sourceRecordId || item.sourceRecordId.length > 2048 ||
    typeof item.title !== 'string' || item.title.length > 1000 || typeof item.url !== 'string' || item.url.length > 2048 ||
    new URL(item.url).protocol !== 'https:' || item.publishedAt !== null && !utc(item.publishedAt) ||
    !['unknown', 'second', 'day', 'year'].includes(item.publishedPrecision) ||
    item.kind !== (plugin.kind === 'dataset' ? 'statistical-dataset' : 'original-publication')) throw fail('invalid_plugin_evidence');
  return { itemId: item.itemId, revision: item.sourceRevision, kind: item.kind, title: item.title, url: item.url,
    sourceRecordId: item.sourceRecordId, publishedAt: item.publishedAt, publishedPrecision: item.publishedPrecision,
    ...(typeof item.publishedRaw === 'string' ? { publishedRaw: item.publishedRaw } : {}) };
}
function validators(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['etag', 'lastModified'].includes(key))) throw fail('invalid_plugin_evidence');
  const { etag = null, lastModified = null } = value;
  if (etag !== null && (typeof etag !== 'string' || !/^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(etag)) ||
    lastModified !== null && (typeof lastModified !== 'string' || lastModified.length > 128 || /[\r\n]/.test(lastModified) || !Number.isFinite(Date.parse(lastModified))))
    throw fail('invalid_plugin_evidence');
  return { etag, lastModified };
}
function check(row) { return row ? { checkedAt: row.checked_at, nextCheckAt: row.next_check_at,
  lastSuccessfulAt: row.last_successful_at, status: row.status } : null; }
function receipt(row) { return row ? { id: row.receipt_id, capturedAt: row.captured_at, recordedAt: row.recorded_at,
  factsDigest: row.facts_digest, rawSha256: row.raw_sha256, artifactSha256: row.artifact_sha256,
  sourceUpdatedAt: row.source_updated_at, sourceVersion: row.source_version } : null; }
async function latestReceipt(db, pluginId, scopeId, knownAt) {
  return (await rows(db, `SELECT receipt_id FROM earth_plugin_captures WHERE plugin_id=? AND scope_id=?${knownAt ? ' AND recorded_at<=?' : ''}
    ORDER BY recorded_at DESC,fence DESC LIMIT 1`, [pluginId, scopeId, ...(knownAt ? [knownAt] : [])]))[0]?.receipt_id || null;
}
const owned = `EXISTS(SELECT 1 FROM earth_plugin_state WHERE plugin_id=? AND scope_id=? AND fence=? AND lease_token=? AND lease_until>${DB_NOW})`;
const fenceValues = (plugin, lease) => [plugin.pluginId, plugin.scopeId, lease.fence, lease.lease_token];

/** One bounded due check. SQL owns due times and cross-isolate fencing; providers
 * own observations. Source checks never fabricate publication/knowledge dates. */
export async function runSourcePlugin(env, input, { now = Date.now, fetchImpl = fetch, signal: external } = {}) {
  const plugin = descriptor(input);
  if (!configured(env)) return { configured: false, pluginId: plugin.pluginId, status: 'unavailable', acquired: false };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), PLUGIN_STORE_LIMITS.deadlineMs);
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const db = primary(env); let lease;
  try {
    const state = (await rows(db, 'SELECT * FROM earth_plugin_state WHERE plugin_id=?', [plugin.pluginId], signal))[0];
    if (state && state.scope_id !== plugin.scopeId) throw fail('plugin_scope_conflict');
    if (state && Date.parse(state.next_check_at) > now() || state?.lease_until && Date.parse(state.lease_until) > now())
      return { configured: true, pluginId: plugin.pluginId, status: 'not-due', acquired: false };
    const token = nonce();
    const claim = await batch(db, [
      db.prepare(`INSERT INTO earth_plugin_state (plugin_id,scope_id,next_check_at,status,failure_count,fence)
        VALUES (?,?,${DB_NOW},'pending',0,0) ON CONFLICT(plugin_id) DO NOTHING`).bind(plugin.pluginId, plugin.scopeId),
      db.prepare(`UPDATE earth_plugin_state SET fence=fence+1,lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')
        WHERE plugin_id=? AND scope_id=? AND next_check_at<=${DB_NOW} AND (lease_until IS NULL OR lease_until<=${DB_NOW}) RETURNING *`)
        .bind(token, plugin.pluginId, plugin.scopeId),
    ], signal);
    lease = claim[1]?.results?.[0];
    if (!lease) return { configured: true, pluginId: plugin.pluginId, status: 'busy', acquired: false };
    const priorValidators = lease.validators_json ? validators(JSON.parse(lease.validators_json)) : { etag: null, lastModified: null };
    const result = await plugin.collect({ now, signal, fetchImpl, previous: { validators: priorValidators, factsDigest: lease.facts_digest } });
    signal.throwIfAborted();
    if (result?.schemaVersion !== 1 || result.pluginId !== plugin.pluginId || result.scopeId !== plugin.scopeId ||
      result.kind !== plugin.kind || result.sourceUrl !== plugin.sourceUrl || !['validated', 'not-modified'].includes(result.outcome) ||
      !utc(result.checkedAt) || Math.abs(Date.parse(result.checkedAt) - now()) > 300000 || !digest(result.factsDigest) ||
      result.sourceUpdatedAt != null && (!utc(result.sourceUpdatedAt) || Date.parse(result.sourceUpdatedAt) > now() + 300000) ||
      result.sourceVersion != null && (typeof result.sourceVersion !== 'string' || result.sourceVersion.length > 100)) throw fail('invalid_plugin_evidence');
    const currentValidators = validators(result.validators);
    const same = result.factsDigest === lease.facts_digest;
    if (result.outcome === 'not-modified') {
      if (!same || !lease.current_receipt || !priorValidators.etag && !priorValidators.lastModified || result.raw !== null || result.canonicalFacts !== null || result.artifact !== null)
        throw fail('invalid_plugin_evidence');
    } else {
      if (!(result.raw?.bytes instanceof Uint8Array) || !result.raw.bytes.byteLength || result.raw.bytes.byteLength > plugin.maxResponseBytes ||
        !digest(result.raw.sha256) || typeof result.raw.mediaType !== 'string' || result.raw.mediaType.length > 100 ||
        await pluginBytesDigest(result.raw.bytes) !== result.raw.sha256 || await pluginFactsDigest(result.canonicalFacts) !== result.factsDigest)
        throw fail('evidence_digest_mismatch');
    }
    const fields = [result.checkedAt, `+${Math.ceil(plugin.cadenceMs / 1000)} seconds`, pluginJson(currentValidators)];
    if (same) {
      const saved = await batch(db, [db.prepare(`UPDATE earth_plugin_state SET checked_at=?,next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
        last_successful_at=${DB_NOW},status='ready',failure_count=0,validators_json=?,source_updated_at=COALESCE(?,source_updated_at),
        source_version=COALESCE(?,source_version),lease_token=NULL,lease_until=NULL WHERE plugin_id=? AND scope_id=? AND fence=? AND lease_token=? AND lease_until>${DB_NOW}`)
        .bind(...fields, result.sourceUpdatedAt ?? null, result.sourceVersion ?? null, ...fenceValues(plugin, lease))], signal);
      return { configured: true, pluginId: plugin.pluginId, status: Number(saved[0]?.meta?.changes) === 1 ? 'checked' : 'superseded',
        acquired: true, changed: false, receiptId: lease.current_receipt };
    }
    const facts = UTF8.encode(pluginJson(result.canonicalFacts)), artifact = UTF8.encode(pluginJson(result.artifact));
    if (facts.byteLength > PLUGIN_STORE_LIMITS.factsBytes || artifact.byteLength > Math.min(PLUGIN_STORE_LIMITS.artifactBytes, plugin.maxArtifactBytes || PLUGIN_STORE_LIMITS.artifactBytes))
      throw fail('evidence_response_limit');
    const items = plugin.items(result.canonicalFacts);
    if (!Array.isArray(items) || items.length > plugin.maxItems || new Set(items.map(item => item.itemId)).size !== items.length) throw fail('invalid_plugin_evidence');
    const projections = items.map(item => projection(item, plugin)), projected = pluginJson(projections);
    if (UTF8.encode(projected).byteLength > PLUGIN_STORE_LIMITS.projectionBytes) throw fail('evidence_response_limit');
    const artifactHash = await pluginBytesDigest(artifact);
    const receiptId = `receipt:${await pluginFactsDigest([plugin.pluginId, plugin.scopeId, lease.fence, result.checkedAt, result.factsDigest, result.raw.sha256])}`;
    await Promise.all([
      immutable(env, path(plugin, 'raw', result.raw.sha256), result.raw.bytes, result.raw.sha256, result.raw.mediaType, signal),
      immutable(env, path(plugin, 'facts', result.factsDigest), facts, result.factsDigest, 'application/json', signal),
      immutable(env, path(plugin, 'artifacts', artifactHash), artifact, artifactHash, 'application/json', signal),
    ]);
    signal.throwIfAborted();
    const args = fenceValues(plugin, lease);
    // D1 batches are atomic. Admission checks the live lease once at the first
    // receipt insert; later statements depend on that inserted receipt. A lease
    // expiring between statements cannot expose a partial historical publication.
    const admitted = 'EXISTS(SELECT 1 FROM earth_plugin_captures WHERE receipt_id=?)';
    const committed = await batch(db, [
      db.prepare(`INSERT INTO earth_plugin_captures
        (receipt_id,plugin_id,scope_id,fence,captured_at,recorded_at,facts_digest,raw_sha256,artifact_sha256,raw_bytes,facts_bytes,artifact_bytes,source_updated_at,source_version,item_count)
        SELECT ?,?,?,?,?,${DB_NOW},?,?,?,?,?,?,?,?,? WHERE ${owned}`)
        .bind(receiptId, plugin.pluginId, plugin.scopeId, lease.fence, result.checkedAt, result.factsDigest, result.raw.sha256, artifactHash,
          result.raw.bytes.byteLength, facts.byteLength, artifact.byteLength, result.sourceUpdatedAt ?? null, result.sourceVersion ?? null, items.length, ...args),
      db.prepare(`INSERT INTO earth_plugin_revisions (plugin_id,item_id,revision,projection_json,published_at,first_captured_at,first_recorded_at)
        SELECT ?,json_extract(value,'$.itemId'),json_extract(value,'$.revision'),value,json_extract(value,'$.publishedAt'),?,
        (SELECT recorded_at FROM earth_plugin_captures WHERE receipt_id=?)
        FROM json_each(?) WHERE ${admitted} ON CONFLICT(plugin_id,item_id,revision) DO NOTHING`)
        .bind(plugin.pluginId, result.checkedAt, receiptId, projected, receiptId),
      db.prepare(`INSERT INTO earth_plugin_membership (receipt_id,item_id,revision)
        SELECT ?,json_extract(value,'$.itemId'),json_extract(value,'$.revision') FROM json_each(?) WHERE ${admitted}`)
        .bind(receiptId, projected, receiptId),
      db.prepare(`INSERT INTO earth_plugin_heads (plugin_id,item_id,revision,receipt_id,recorded_at,published_at)
        SELECT ?,json_extract(value,'$.itemId'),json_extract(value,'$.revision'),?,
        (SELECT recorded_at FROM earth_plugin_captures WHERE receipt_id=?),json_extract(value,'$.publishedAt')
        FROM json_each(?) WHERE ${admitted} ON CONFLICT(plugin_id,item_id) DO UPDATE SET
        revision=excluded.revision,receipt_id=excluded.receipt_id,recorded_at=excluded.recorded_at,published_at=excluded.published_at`)
        .bind(plugin.pluginId, receiptId, receiptId, projected, receiptId),
      db.prepare(`UPDATE earth_plugin_state SET checked_at=?,next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),last_successful_at=${DB_NOW},
        status='ready',failure_count=0,validators_json=?,current_receipt=?,facts_digest=?,source_updated_at=?,source_version=?,lease_token=NULL,lease_until=NULL
        WHERE plugin_id=? AND scope_id=? AND fence=? AND lease_token=? AND ${admitted}`)
        .bind(...fields, receiptId, result.factsDigest, result.sourceUpdatedAt ?? null, result.sourceVersion ?? null, ...args, receiptId),
    ], signal);
    return { configured: true, pluginId: plugin.pluginId, status: Number(committed[4]?.meta?.changes) === 1 ? 'stored' : 'superseded',
      acquired: true, changed: Number(committed[4]?.meta?.changes) === 1, receiptId };
  } catch (error) {
    if (!lease) return { configured: false, pluginId: plugin.pluginId, status: 'unavailable', acquired: false };
    const failures = Math.min(100, lease.failure_count + 1), retry = Math.min(PLUGIN_STORE_LIMITS.maximumRetryMs,
      Math.max(plugin.cadenceMs, Math.min(21600000, 60000 * 2 ** Math.min(8, failures - 1)), Number(error.retryAfterMs) || 0));
    try { await batch(db, [db.prepare(`UPDATE earth_plugin_state SET checked_at=${DB_NOW},next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
      status='retry',failure_count=?,lease_token=NULL,lease_until=NULL WHERE plugin_id=? AND scope_id=? AND fence=? AND lease_token=? AND lease_until>${DB_NOW}`)
      .bind(`+${Math.ceil(retry / 1000)} seconds`, failures, ...fenceValues(plugin, lease))]); } catch {}
    return { configured: true, pluginId: plugin.pluginId, status: 'retry', acquired: true,
      errorCode: ['evidence_digest_mismatch', 'evidence_response_limit', 'invalid_plugin_evidence', 'plugin_scope_conflict'].includes(error.code) ? error.code : 'source_or_storage_unavailable' };
  } finally { clearTimeout(timer); }
}

/** Stored-only read. Source publication/reference dates never replace the first
 * database receipt; historical knowledge selection excludes later acquisitions. */
export async function readPluginEnvelope(env, pluginId, { knownAt = null, now = Date.now } = {}) {
  const plugin = sourcePlugin(pluginId); if (!plugin) throw new TypeError('Unknown reviewed source plugin');
  if (knownAt !== null && (!utc(knownAt) || Date.parse(knownAt) > now() + 300000)) throw new TypeError('Use canonical UTC knowledge time');
  const base = { schemaVersion: 1, configured: configured(env), available: false, plugin: publicPlugin(plugin), receipt: null, check: null, artifact: null };
  if (!base.configured) return { ...base, explanation: 'Durable source-plugin storage is not configured.' };
  try {
    const db = primary(env), state = (await rows(db, 'SELECT * FROM earth_plugin_state WHERE plugin_id=? AND scope_id=?', [pluginId, plugin.scopeId]))[0];
    base.check = check(state);
    const capture = (await rows(db, `SELECT * FROM earth_plugin_captures WHERE plugin_id=? AND scope_id=?${knownAt ? ' AND recorded_at<=?' : ''}
      ORDER BY recorded_at DESC,fence DESC LIMIT 1`, [pluginId, plugin.scopeId, ...(knownAt ? [knownAt] : [])]))[0];
    if (!capture) return { ...base, explanation: knownAt ? 'No retained source receipt was available by the selected knowledge time.' : 'The source has not completed its first retained acquisition yet.' };
    const bytes = await objectBytes(await io(() => env.EARTH_STORE.get(path(plugin, 'artifacts', capture.artifact_sha256))), PLUGIN_STORE_LIMITS.artifactBytes);
    if (bytes.byteLength !== capture.artifact_bytes || await pluginBytesDigest(bytes) !== capture.artifact_sha256) throw fail('evidence_digest_mismatch');
    const artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { ...base, available: true, receipt: receipt(capture), artifact };
  } catch { return { ...base, configured: false, explanation: 'Retained source evidence is temporarily unavailable; no provider request was made.' }; }
}

export async function readPluginPublications(env, pluginId, { at = null, knownAt = null, limit = 20, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40 || at !== null && (!utc(at) || Date.parse(at) > now() + 300000)) throw new TypeError('Use a bounded publication query and canonical UTC');
  let base;
  const unavailable = (explanation, errorCode) => ({ ...base, available: false, artifact: null, receipt: null,
    items: [], counts: { returned: 0, more: false }, explanation, ...(errorCode ? { errorCode } : {}) });
  for (let attempt = 0; attempt < 2; attempt++) {
    base = await readPluginEnvelope(env, pluginId, { knownAt, now });
    if (!base.available) return { ...base, items: [], counts: { returned: 0, more: false } };
    if (base.plugin.kind !== 'publication-feed') throw new TypeError('This plugin does not contain institutional publications');
    const db = primary(env);
    try {
      if (knownAt) {
        // Do not disguise an unbounded historical scan behind the final LIMIT.
        // This pilot has an explicit work gate until interval indexing replaces
        // membership reconstruction for larger institutional archives.
        const candidates = await rows(db, `SELECT COUNT(*) AS count FROM (SELECT 1 FROM earth_plugin_captures c
          JOIN earth_plugin_membership m ON m.receipt_id=c.receipt_id WHERE c.plugin_id=? AND c.scope_id=? AND c.recorded_at<=?
          AND c.fence<=(SELECT fence FROM earth_plugin_captures WHERE receipt_id=?) LIMIT ?)`,
          [pluginId, base.plugin.scopeId, knownAt, base.receipt.id, PLUGIN_STORE_LIMITS.historicalMemberships + 1]);
        if (Number(candidates[0]?.count) > PLUGIN_STORE_LIMITS.historicalMemberships)
          return unavailable('This knowledge-time query exceeds the retained pilot delivery budget; no incomplete history was substituted.', 'historical-delivery-budget');
      }
      const evidenceFields = 'c.receipt_id,c.captured_at,c.facts_digest,c.raw_sha256,c.artifact_sha256,c.source_updated_at,c.source_version';
      const records = await rows(db, knownAt ? `WITH candidates AS (
        SELECT r.projection_json,r.first_recorded_at,r.published_at,c.recorded_at,m.item_id,${evidenceFields},
          ROW_NUMBER() OVER(PARTITION BY m.item_id ORDER BY c.recorded_at DESC,c.fence DESC) AS rank
        FROM earth_plugin_captures c JOIN earth_plugin_membership m ON m.receipt_id=c.receipt_id
        JOIN earth_plugin_revisions r ON r.plugin_id=c.plugin_id AND r.item_id=m.item_id AND r.revision=m.revision
        WHERE c.plugin_id=? AND c.scope_id=? AND c.recorded_at<=? AND c.fence<=(SELECT fence FROM earth_plugin_captures WHERE receipt_id=?))
        SELECT * FROM candidates WHERE rank=1${at ? ' AND published_at<=?' : ''}
        ORDER BY published_at DESC,item_id LIMIT ?` : `SELECT r.projection_json,r.first_recorded_at,h.recorded_at,h.item_id,h.published_at,${evidenceFields}
        FROM earth_plugin_heads h JOIN earth_plugin_revisions r ON r.plugin_id=h.plugin_id AND r.item_id=h.item_id AND r.revision=h.revision
        JOIN earth_plugin_captures c ON c.receipt_id=h.receipt_id
        WHERE h.plugin_id=?${at ? ' AND h.published_at<=?' : ''} ORDER BY h.published_at DESC,h.item_id LIMIT ?`,
        [pluginId, ...(knownAt ? [base.plugin.scopeId, knownAt, base.receipt.id] : []), ...(at ? [at] : []), limit + 1]);
      if (await latestReceipt(db, pluginId, base.plugin.scopeId, knownAt) !== base.receipt.id) continue;
      const items = records.slice(0, limit).map(row => ({ ...JSON.parse(row.projection_json), firstRecordedAt: row.first_recorded_at,
        lastRecordedAt: row.recorded_at, evidence: { ...receipt(row), locator: { kind: 'rss-guid', guid: JSON.parse(row.projection_json).sourceRecordId } } }));
      return { ...base, version: base.receipt.id, items, counts: { returned: items.length, more: records.length > limit } };
    } catch { return unavailable('Retained publication delivery is temporarily unavailable.'); }
  }
  return unavailable('Source evidence changed during delivery; retry the stored view.', 'publication-edition-changed');
}
