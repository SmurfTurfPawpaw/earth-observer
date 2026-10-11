import { handleCollection } from './collection-api.js';

export const COLLECTOR_TRIGGER_PATH = '/api/collector/trigger';
export const COLLECTOR_TRIGGER_BODY = '{"action":"collect"}';
export const COLLECTOR_TRIGGER_LIMITS = Object.freeze({
  bodyBytes: 64, responseBytes: 256 * 1024, deadlineMs: 45_000,
  clockSkewMs: 30_000, collectionWindowMs: 60_000,
  requestWindowMs: 60_000, requestsPerIsolate: 120, nonceEntries: 128,
});

const keyPattern = /^[A-Za-z0-9_-]{43,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const encoder = new TextEncoder();
const json = (value, status = 200, headers = {}) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });

// The deployment's /earth prefix is normalized before this handler is mounted.
export function collectorTriggerMessage(timestamp, nonce, body = COLLECTOR_TRIGGER_BODY) {
  return `earth-collector-trigger-v1\nPOST\n${COLLECTOR_TRIGGER_PATH}\n${timestamp}\n${nonce}\n${body}`;
}

function abortable(operation, signal) {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedText(message, limit, signal) {
  const declared = message.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw Object.assign(new Error('Body limit'), { httpStatus: 413 });
  if (!message.body) return '';
  const reader = message.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw Object.assign(new Error('Body limit'), { httpStatus: 413 });
      text += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    return text + decoder.decode();
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

const boundedCount = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
function safeSummary(payload, ok) {
  return { schemaVersion: 1, status: ok ? 'stored' : 'failed', stored: ok,
    collectedAt: typeof payload?.collectedAt === 'string' && payload.collectedAt.length === 24 &&
      Number.isFinite(Date.parse(payload.collectedAt)) && new Date(payload.collectedAt).toISOString() === payload.collectedAt
      ? payload.collectedAt : null,
    sourceCount: boundedCount(payload?.plugins?.length, 4),
    snapshotCount: boundedCount(payload?.snapshots?.length, 4),
    failureCount: boundedCount(payload?.failures?.length, 20),
    recordCount: boundedCount(payload?.prepared?.recordCount, 500),
    worldStored: payload?.world?.stored === true, updatesPublished: payload?.updatesPublished === true };
}

/** A collect-only machine capability; separate from Site viewing and the broad publication credential.
 * Admission/replay state is isolate-local. It does not promise cross-isolate serialization.
 */
export function createCollectorTriggerHandler({ now = Date.now, fetchImpl = fetch,
  collectionHandler = handleCollection, deadlineMs = COLLECTOR_TRIGGER_LIMITS.deadlineMs } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > COLLECTOR_TRIGGER_LIMITS.deadlineMs)
    throw new TypeError('Use a bounded collector trigger deadline');
  const states = new WeakMap();
  let requestWindowAt = -Infinity, requests = 0;

  return async function collectorTrigger(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    if (url.pathname !== COLLECTOR_TRIGGER_PATH) return null;
    if (request.method !== 'POST') return json({ status: 'method_not_allowed', stored: false }, 405, { allow: 'POST' });
    if (url.search) return json({ status: 'invalid_request', stored: false }, 400);
    if (request.headers.has('origin')) return json({ status: 'denied', stored: false }, 401);

    const startedAt = now();
    if (startedAt < requestWindowAt || startedAt - requestWindowAt >= COLLECTOR_TRIGGER_LIMITS.requestWindowMs) {
      requestWindowAt = startedAt; requests = 0;
    }
    if (++requests > COLLECTOR_TRIGGER_LIMITS.requestsPerIsolate)
      return json({ status: 'busy', stored: false }, 429, { 'retry-after': '60' });

    const secret = env.EARTH_TRIGGER_HMAC_KEY, collectorToken = env.EARTH_COLLECTOR_TOKEN;
    if (typeof secret !== 'string' || !keyPattern.test(secret) || typeof collectorToken !== 'string' ||
      !tokenPattern.test(collectorToken) || secret === collectorToken)
      return json({ status: 'unavailable', stored: false }, 503);
    const timestamp = request.headers.get('x-earth-trigger-timestamp') || '';
    const nonce = request.headers.get('x-earth-trigger-nonce') || '';
    const signature = request.headers.get('x-earth-trigger-signature') || '';
    if (!/^\d{10}$/.test(timestamp) || Math.abs(startedAt - Number(timestamp) * 1000) > COLLECTOR_TRIGGER_LIMITS.clockSkewMs ||
      !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature))
      return json({ status: 'denied', stored: false }, 401);
    if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')
      return json({ status: 'invalid_request', stored: false }, 400);

    const controller = new AbortController();
    const aborted = () => controller.abort(new Error('Collection trigger canceled'));
    if (request.signal.aborted) aborted(); else request.signal.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Collection trigger deadline')), deadlineMs);
    let startedCollection = false;
    try {
      const text = await boundedText(request, COLLECTOR_TRIGGER_LIMITS.bodyBytes, controller.signal);
      if (text !== '' && (text !== COLLECTOR_TRIGGER_BODY || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')))
        return json({ status: 'invalid_request', stored: false }, 400);
      const key = await abortable(crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']), controller.signal);
      const signatureBytes = Uint8Array.from(signature.match(/../g), (pair) => parseInt(pair, 16));
      const verified = await abortable(crypto.subtle.verify('HMAC', key, signatureBytes,
        encoder.encode(collectorTriggerMessage(timestamp, nonce, text))), controller.signal);
      if (!verified) return json({ status: 'denied', stored: false }, 401);
      // Authentication/body reads also consume the deadline; recheck freshness before admission.
      const admittedAt = now();
      if (Math.abs(admittedAt - Number(timestamp) * 1000) > COLLECTOR_TRIGGER_LIMITS.clockSkewMs)
        return json({ status: 'denied', stored: false }, 401);
      const owner = env.EARTH_STORE || env;
      let state = states.get(owner);
      if (!state) { state = { pending: false, nextAllowedAt: 0, nonces: new Map() }; states.set(owner, state); }
      for (const [value, expiresAt] of state.nonces) if (admittedAt > expiresAt) state.nonces.delete(value);
      if (state.nonces.has(nonce)) return json({ status: 'replayed', stored: false }, 409);
      if (state.pending || admittedAt < state.nextAllowedAt || state.nonces.size >= COLLECTOR_TRIGGER_LIMITS.nonceEntries)
        return json({ status: 'busy', stored: false }, 429, { 'retry-after': '60' });
      state.nonces.set(nonce, Number(timestamp) * 1000 + COLLECTOR_TRIGGER_LIMITS.clockSkewMs);
      state.nextAllowedAt = admittedAt + COLLECTOR_TRIGGER_LIMITS.collectionWindowMs;
      state.pending = true;
      const internal = new Request('https://earth-observer.internal/api/collector', { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${collectorToken}` },
        body: COLLECTOR_TRIGGER_BODY, signal: controller.signal });
      const boundedFetch = (input, options = {}) => fetchImpl(input, { ...options,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      const operation = Promise.resolve().then(() => { controller.signal.throwIfAborted(); startedCollection = true;
        return collectionHandler(internal, env, ctx, { now, fetchImpl: boundedFetch }); });
      // A storage operation can finish after the HTTP deadline. Keep admission until actual settlement.
      void operation.then(() => { state.pending = false; }, () => { state.pending = false; });
      const result = await abortable(operation, controller.signal);
      if (!(result instanceof Response) || !/^application\/json(?:\s*;|$)/i.test(result.headers.get('content-type') || ''))
        return json({ status: 'failed', stored: false }, 503);
      const payload = JSON.parse(await boundedText(result, COLLECTOR_TRIGGER_LIMITS.responseBytes, controller.signal));
      const accepted = result.ok && payload?.stored === true;
      return json(safeSummary(payload, accepted), accepted ? 200 : 503, accepted ? {} : { 'retry-after': '60' });
    } catch (error) {
      if (controller.signal.aborted) return json({ status: startedCollection ? 'uncertain' : 'deadline', stored: startedCollection ? null : false,
        collectionMayHaveCommitted: startedCollection, readStatusBeforeRetry: startedCollection }, 504);
      return json({ status: error.httpStatus === 413 ? 'invalid_request' : 'failed', stored: false }, error.httpStatus === 413 ? 413 : 503);
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', aborted); }
  };
}
