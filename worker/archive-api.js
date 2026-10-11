import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { ARCHIVE_SCOPE, ARCHIVE_LIMITS, retainWorldArchiveRaw, publishWorldArchiveChunk,
  readWorldArchiveChunk, createWorldArchiveCandidate } from './world-archive.js';

export const ARCHIVE_IMPORT_PATH = '/api/world/archive/import';
export const ARCHIVE_API_LIMITS = Object.freeze({ bodyBytes: 2 * 1024 * 1024, deadlineMs: 25_000,
  clockSkewMs: 30_000, nonceEntries: 128, requestWindowMs: 60_000, requests: 120 });
const encoder = new TextEncoder(), keyPattern = /^[A-Za-z0-9_-]{43,128}$/;
const json = (value, status = 200, extra = {}) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
const digest = async (text) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
export const archiveImportMessage = (timestamp, nonce, bodyDigest) =>
  `earth-archive-import-v1\nPOST\n${ARCHIVE_IMPORT_PATH}\n${timestamp}\n${nonce}\n${bodyDigest}`;

function abortable(operation, signal) {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedText(request, signal) {
  const size = request.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > ARCHIVE_API_LIMITS.bodyBytes))
    throw Object.assign(new Error('Archive input exceeds its bound'), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Missing archive input'), { status: 400 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ARCHIVE_API_LIMITS.bodyBytes) throw Object.assign(new Error('Archive input exceeds its bound'), { status: 413 });
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
function importInput(text, nowMs) {
  let value; try { value = JSON.parse(text); } catch { throw new TypeError('Invalid archive input'); }
  const keys = ['body', 'capturedAt', 'expectedCount', 'kind', 'range', 'schemaVersion', 'scopeId'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.schemaVersion !== 1 ||
      value.scopeId !== ARCHIVE_SCOPE.id || value.kind !== 'interval' || typeof value.body !== 'string' ||
      encoder.encode(value.body).byteLength > ARCHIVE_LIMITS.bytes ||
      !Number.isInteger(value.expectedCount) || value.expectedCount < 0 || value.expectedCount > ARCHIVE_LIMITS.records ||
      !value.range || Object.keys(value.range).sort().join(',') !== 'from,to') throw new TypeError('Unsupported archive input');
  const dates = [value.range.from, value.range.to, value.capturedAt];
  if (dates.some((date) => typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) ||
      Date.parse(value.range.from) >= Date.parse(value.range.to) ||
      Date.parse(value.range.to) - Date.parse(value.range.from) > 32 * 86400000 ||
      Date.parse(value.range.to) > nowMs + 300000 || Date.parse(value.capturedAt) > nowMs + 300000)
    throw new TypeError('Unsupported archive dates');
  const raw = JSON.parse(value.body);
  if (!Array.isArray(raw?.features) || raw.features.length > ARCHIVE_LIMITS.records) throw new TypeError('Unsupported archive body');
  const records = [];
  for (let start = 0; start < raw.features.length; start += 100)
    records.push(...normalizeUsgs({ features: raw.features.slice(start, start + 100) }, value.capturedAt).map(canonicalDiscoveryRecord));
  if (records.some((record) => !record) || records.length !== raw.features.length) throw new TypeError('Archive normalization lost a source feature');
  return { ...value, records };
}

/** Narrow archive import capability: authenticated acquisition stays outside visitor reads. */
export function createArchiveApiHandler({ now = Date.now, retain = retainWorldArchiveRaw,
  publish = publishWorldArchiveChunk, read = readWorldArchiveChunk,
  deadlineMs = ARCHIVE_API_LIMITS.deadlineMs } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > ARCHIVE_API_LIMITS.deadlineMs)
    throw new TypeError('Use a bounded archive deadline');
  const states = new WeakMap();
  let windowAt = -Infinity, requests = 0;
  return async function archiveApi(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const receipt = /^\/api\/world\/archive\/chunks\/([a-f0-9]{64})$/.exec(url.pathname);
    if (receipt) {
      if (request.method !== 'GET' || url.search) return json({ status: 'invalid_request' }, 400);
      const result = await read(env, { chunkId: receipt[1] });
      return json(result, result.configured === false ? 503 : result.available === false ? 404 : 200);
    }
    if (url.pathname !== ARCHIVE_IMPORT_PATH) return null;
    if (request.method !== 'POST') return json({ status: 'method_not_allowed', stored: false }, 405, { allow: 'POST' });
    if (url.search || request.headers.has('origin')) return json({ status: 'denied', stored: false }, 401);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') ||
        request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')
      return json({ status: 'invalid_request', stored: false }, 400);
    const startedAt = now();
    if (startedAt < windowAt || startedAt - windowAt >= ARCHIVE_API_LIMITS.requestWindowMs) { windowAt = startedAt; requests = 0; }
    if (++requests > ARCHIVE_API_LIMITS.requests) return json({ status: 'busy', stored: false }, 429, { 'retry-after': '60' });
    const secret = env.EARTH_ARCHIVE_IMPORT_KEY;
    if (typeof secret !== 'string' || !keyPattern.test(secret) || secret === env.EARTH_COLLECTOR_TOKEN || secret === env.EARTH_TRIGGER_HMAC_KEY)
      return json({ status: 'unavailable', stored: false }, 503);
    const timestamp = request.headers.get('x-earth-archive-timestamp') || '', nonce = request.headers.get('x-earth-archive-nonce') || '';
    const bodyDigest = request.headers.get('x-earth-archive-digest') || '', signature = request.headers.get('x-earth-archive-signature') || '';
    if (!/^\d{10}$/.test(timestamp) || Math.abs(startedAt - Number(timestamp) * 1000) > ARCHIVE_API_LIMITS.clockSkewMs ||
        !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(bodyDigest) || !/^[a-f0-9]{64}$/.test(signature))
      return json({ status: 'denied', stored: false }, 401);
    // Authenticate the declared digest before accepting an expensive streamed body.
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g), (pair) => parseInt(pair, 16)),
      encoder.encode(archiveImportMessage(timestamp, nonce, bodyDigest)))) return json({ status: 'denied', stored: false }, 401);
    const owner = env.EARTH_STORE || env;
    let state = states.get(owner);
    if (!state) { state = { pending: false, nonces: new Map() }; states.set(owner, state); }
    for (const [id, expiresAt] of state.nonces) if (startedAt > expiresAt) state.nonces.delete(id);
    if (state.nonces.has(nonce)) return json({ status: 'replayed', stored: false }, 409);
    if (state.pending || state.nonces.size >= ARCHIVE_API_LIMITS.nonceEntries) return json({ status: 'busy', stored: false }, 429);
    state.nonces.set(nonce, Number(timestamp) * 1000 + ARCHIVE_API_LIMITS.clockSkewMs);
    state.pending = true;
    const controller = new AbortController(), cancel = () => controller.abort(new Error('Archive request canceled'));
    if (request.signal.aborted) cancel(); else request.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Archive deadline')), deadlineMs);
    let operation, candidate, startedStorage = false;
    try {
      const text = await boundedText(request, controller.signal);
      if (await digest(text) !== bodyDigest || Math.abs(now() - Number(timestamp) * 1000) > ARCHIVE_API_LIMITS.clockSkewMs)
        return json({ status: 'denied', stored: false }, 401);
      const value = importInput(text, now());
      candidate = await createWorldArchiveCandidate({ ...value, rawSha256: await digest(value.body) }, { now });
      controller.signal.throwIfAborted();
      startedStorage = true;
      operation = (async () => {
        const raw = await retain(env, { body: value.body });
        if (raw.stored !== true) return raw;
        return publish(env, { schemaVersion: 1, scopeId: value.scopeId, capturedAt: value.capturedAt, kind: value.kind,
          range: value.range, expectedCount: value.expectedCount, rawSha256: raw.rawSha256, records: value.records }, { now });
      })();
      // SQL/R2 work can commit after an HTTP timeout. Keep its actual settlement alive.
      const settlement = operation.then(() => { state.pending = false; }, () => { state.pending = false; });
      if (ctx.waitUntil) ctx.waitUntil(settlement);
      const result = await abortable(operation, controller.signal);
      return json({ status: result.stored === true ? 'stored' : 'unavailable', ...result }, result.stored === true ? 200 : 503);
    } catch (error) {
      if (controller.signal.aborted) return json({ status: startedStorage ? 'uncertain' : 'deadline', stored: startedStorage ? null : false,
        ...(candidate ? { chunkId: candidate.chunkId } : {}), readStatusBeforeRetry: startedStorage }, 504);
      return json({ status: error instanceof TypeError || error instanceof SyntaxError ? 'invalid_request' : 'failed', stored: false },
        error.status || (error instanceof TypeError || error instanceof SyntaxError ? 400 : 503));
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', cancel);
      if (!operation) state.pending = false;
    }
  };
}
