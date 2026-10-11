import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const HOSTED_COLLECTOR_TRIGGER_URL = 'https://giovannicallebaut.com/earth/api/collector/trigger';
const BODY = '{"action":"collect"}', SIGNED_PATH = '/api/collector/trigger';
const MAX_RESPONSE_BYTES = 4096, TIMEOUT_MS = 55_000;
const keyPattern = /^[A-Za-z0-9_-]{43,128}$/;
const statuses = new Set(['stored', 'failed', 'busy', 'denied', 'unavailable', 'invalid_request', 'replayed', 'uncertain', 'deadline']);
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

function abortable(operation, signal) {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function signHostedCollectionTrigger(key, { now = Date.now(), nonce = randomBytes(16).toString('hex') } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key) || !Number.isFinite(now) || !/^[a-f0-9]{32}$/.test(nonce))
    throw new TypeError('Invalid collection trigger configuration');
  const timestamp = String(Math.floor(now / 1000));
  const message = `earth-collector-trigger-v1\nPOST\n${SIGNED_PATH}\n${timestamp}\n${nonce}\n${BODY}`;
  return { 'content-type': 'application/json', 'x-earth-trigger-timestamp': timestamp,
    'x-earth-trigger-nonce': nonce, 'x-earth-trigger-signature': createHmac('sha256', key).update(message).digest('hex') };
}

async function responseJson(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body)
    throw new Error('Invalid collector response');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error('Response limit');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Response limit');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); signal.removeEventListener('abort', aborted); }
}

/** Built-ins only; no target URL, body, source or action is accepted from CLI/environment inputs. */
export async function runHostedCollectionTrigger({ key, now = Date.now, nonce, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key)) return { ok: false, summary: { status: 'unconfigured', stored: false } };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new TypeError('Use a bounded trigger timeout');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = signHostedCollectionTrigger(key, { now: now(), ...(nonce ? { nonce } : {}) });
    const response = await abortable(fetchImpl(HOSTED_COLLECTOR_TRIGGER_URL, { method: 'POST', headers, body: BODY,
      signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' }), controller.signal);
    const payload = await responseJson(response, controller.signal);
    const status = statuses.has(payload?.status) ? payload.status : 'invalid_response';
    const summary = { status, httpStatus: response.status,
      stored: payload?.stored === true ? true : payload?.stored === null ? null : false,
      sourceCount: count(payload?.sourceCount, 4), snapshotCount: count(payload?.snapshotCount, 4),
      failureCount: count(payload?.failureCount, 20), recordCount: count(payload?.recordCount, 500),
      worldStored: payload?.worldStored === true, updatesPublished: payload?.updatesPublished === true,
      ...(payload?.readStatusBeforeRetry === true ? { readStatusBeforeRetry: true } : {}) };
    return { ok: response.ok && status === 'stored' && summary.stored === true, summary };
  } catch { return { ok: false, summary: { status: controller.signal.aborted ? 'uncertain' : 'request_failed',
    stored: null, readStatusBeforeRetry: true } }; }
  finally { clearTimeout(timer); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = process.argv.length === 2
    ? await runHostedCollectionTrigger({ key: process.env.EARTH_TRIGGER_HMAC_KEY })
    : { ok: false, summary: { status: 'invalid_arguments', stored: false } };
  // Do not print raw responses, signatures, environment, URLs or error stacks.
  process.stdout.write(JSON.stringify(result.summary) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}
