const MIN_INTERVAL_MS = 60000, MAX_BACKOFF_MS = 3600000, MAX_RETRY_AFTER_MS = 86400000;
const STATUS_BODY_MAX_BYTES = 16384;
const OWNED_ORIGINS = new Set(['https://giovannicallebaut.com', 'https://giovanni-callebaut.giovanni-callebautt.chatgpt.site']);
const initialState = () => ({ schemaVersion: 1, lastAttemptAt: null, lastSuccessAt: null, failures: 0,
  retryAt: 0, leaseUntil: 0, lastHttpStatus: null, outcome: 'not-run' });

function targetOrigin(value) {
  if (typeof value !== 'string') throw new Error('Invalid collector configuration');
  const url = new URL(value);
  if (!OWNED_ORIGINS.has(url.origin) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Invalid collector configuration');
  return url.origin;
}
function tokenValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(value)) throw new Error('Invalid collector configuration');
  return value;
}
function normalizeState(value, at) {
  const empty = initialState();
  if (!value || Object.keys(value).sort().join(',') !== Object.keys(empty).sort().join(',') || value.schemaVersion !== 1 ||
      !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 7 ||
      !Number.isFinite(value.retryAt) || value.retryAt < 0 || value.retryAt > at + MAX_RETRY_AFTER_MS ||
      !Number.isFinite(value.leaseUntil) || value.leaseUntil < 0 || value.leaseUntil > at + MIN_INTERVAL_MS ||
      ![value.lastAttemptAt, value.lastSuccessAt].every((time) => time === null || Number.isFinite(time) && time >= 0 && time <= at) ||
      !(value.lastHttpStatus === null || Number.isInteger(value.lastHttpStatus) && value.lastHttpStatus >= 100 && value.lastHttpStatus <= 599) ||
      !['not-run', 'in-progress', 'accepted', 'http-error', 'timeout', 'invalid-response', 'request-failed', 'storage-unavailable'].includes(value.outcome)) return empty;
  return { ...value };
}
function bounded(work, milliseconds) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Collector storage unavailable'), { storageFailure: true })), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(work).then((value) => { signal.removeEventListener('abort', stop); resolve(value); },
      (error) => { signal.removeEventListener('abort', stop); reject(error); });
    if (signal.aborted) stop();
  });
}
async function readStatusBody(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid collector status');
  const chunks = []; let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > STATUS_BODY_MAX_BYTES) throw new Error('Invalid collector status');
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal); if (done) break;
      length += value.byteLength; if (length > STATUS_BODY_MAX_BYTES) throw new Error('Invalid collector status'); chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collector status');
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { try { reader.releaseLock(); } catch { /* The canceled pending read may release asynchronously. */ } }
}
function retryAfter(response, at) {
  const raw = response.headers.get('retry-after'), delay = /^\d+$/.test(raw || '') ? Number(raw) * 1000 : Date.parse(raw || '') - at;
  return Number.isFinite(delay) ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, delay)) : 0;
}
const stamp = (value) => value === null || value === 0 ? null : new Date(value).toISOString();
function publicStatus(state, at, storage, outcome = state.outcome) {
  return { schemaVersion: 1, checkedAt: new Date(at).toISOString(), outcome,
    lastAttemptAt: stamp(state.lastAttemptAt), lastSuccessAt: stamp(state.lastSuccessAt),
    lastHttpStatus: state.lastHttpStatus, retryAt: stamp(state.retryAt),
    nextAttemptAt: stamp(Math.max(state.retryAt, state.leaseUntil, state.lastAttemptAt === null ? 0 : state.lastAttemptAt + MIN_INTERVAL_MS)),
    stateStorage: storage, note: 'Success means the authenticated collection trigger was accepted. Individual provider/source dates remain on the Earth API.' };
}

/** The scheduled handler owns all writes. Public HTTP routes never trigger collection. */
export function createCollector({ fetchImpl = (...args) => fetch(...args), now = Date.now, timeoutMs = 25000, storageTimeoutMs = 1000 } = {}) {
  const entries = new Map(); // At most the two explicit owned origins; never visitor URLs.
  const requestDeadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(25000, timeoutMs)) : 25000;
  const storageDeadline = Number.isFinite(storageTimeoutMs) ? Math.max(1, Math.min(1000, storageTimeoutMs)) : 1000;
  function entry(origin) { if (!entries.has(origin)) entries.set(origin, { state: initialState(), pending: null }); return entries.get(origin); }
  const key = (origin) => `collector:state:v1:${new URL(origin).hostname}`;
  async function restore(env, origin, current) {
    if (!env.COLLECTOR_STATE?.get) return;
    const [raw, rawLease] = await Promise.all([
      bounded(() => env.COLLECTOR_STATE.get(key(origin)), storageDeadline),
      bounded(() => env.COLLECTOR_STATE.get(`${key(origin)}:lease`), storageDeadline),
    ]);
    if (typeof raw === 'string' && raw.length <= 4096) {
      let saved; try { saved = normalizeState(JSON.parse(raw), now()); } catch { return; }
      if ((saved.lastAttemptAt ?? -1) >= (current.state.lastAttemptAt ?? -1)) current.state = saved;
    }
    if (typeof rawLease === 'string' && rawLease.length <= 512) {
      let lease; try { lease = JSON.parse(rawLease); } catch { return; }
      if (lease && Object.keys(lease).sort().join(',') === 'lastAttemptAt,leaseUntil' &&
          Number.isFinite(lease.lastAttemptAt) && lease.lastAttemptAt >= 0 && lease.lastAttemptAt <= now() &&
          Number.isFinite(lease.leaseUntil) && lease.leaseUntil === lease.lastAttemptAt + MIN_INTERVAL_MS &&
          lease.lastAttemptAt > (current.state.lastAttemptAt ?? -1)) {
        current.state = { ...current.state, ...lease, outcome: 'in-progress' };
      }
    }
  }
  const persist = (env, origin, state) => env.COLLECTOR_STATE?.put ? bounded(() => env.COLLECTOR_STATE.put(key(origin), JSON.stringify(state)), storageDeadline) : Promise.resolve();
  async function collect(env, origin, token, current) {
    const storage = env.COLLECTOR_STATE?.get && env.COLLECTOR_STATE?.put ? 'kv-best-effort' : 'instance-memory';
    try { await restore(env, origin, current); }
    catch { return publicStatus(current.state, now(), 'unavailable', 'storage-unavailable'); }
    let state = current.state;
    if (Math.max(state.retryAt, state.leaseUntil, state.lastAttemptAt === null ? 0 : state.lastAttemptAt + MIN_INTERVAL_MS) > now())
      return publicStatus(state, now(), storage, 'waiting');
    state = current.state = { ...state, lastAttemptAt: now(), leaseUntil: now() + MIN_INTERVAL_MS, outcome: 'in-progress' };
    // KV is eventually consistent: this lease is a best-effort overlap guard,
    // while the hosted collector's atomic provider admission remains essential.
    // Separate keys avoid KV's one-write/second limit for a fast target response.
    try { if (env.COLLECTOR_STATE?.put) await bounded(() => env.COLLECTOR_STATE.put(`${key(origin)}:lease`,
      JSON.stringify({ lastAttemptAt: state.lastAttemptAt, leaseUntil: state.leaseUntil }), { expirationTtl: 120 }), storageDeadline); }
    catch { state.outcome = 'storage-unavailable'; return publicStatus(state, now(), 'unavailable'); }
    let retryMs = 0;
    try {
      const signal = AbortSignal.timeout(requestDeadline), address = `${origin}/earth/api/collector`;
      const response = await abortable(Promise.resolve().then(() => fetchImpl(address, { method: 'POST', signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action: 'collect' }) })), signal);
      state.lastHttpStatus = response.status;
      if (!response.ok) { retryMs = retryAfter(response, now()); void response.body?.cancel().catch(() => {}); throw Object.assign(new Error('Collector request rejected'), { httpFailure: true }); }
      if (response.redirected || response.url && response.url !== address || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json')
        { void response.body?.cancel().catch(() => {}); throw new Error('Invalid collector response'); }
      try { await readStatusBody(response, signal); }
      catch (error) { if (signal.aborted) throw signal.reason; throw Object.assign(new Error('Invalid collector response'), { invalidResponse: true }); }
      signal.throwIfAborted();
      state = current.state = { ...state, lastSuccessAt: now(), failures: 0, retryAt: 0, outcome: 'accepted' };
    } catch (error) {
      const failures = Math.min(7, state.failures + 1);
      state = current.state = { ...state, failures, retryAt: now() + Math.max(Math.min(MIN_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS), retryMs),
        outcome: error.httpFailure ? 'http-error' : error.name === 'TimeoutError' ? 'timeout' : error.invalidResponse || error.message === 'Invalid collector response' ? 'invalid-response' : 'request-failed' };
    }
    try { await persist(env, origin, state); }
    catch { return publicStatus(state, now(), 'unavailable'); }
    return publicStatus(state, now(), storage);
  }
  function run(env = {}) {
    let origin, token;
    try { origin = targetOrigin(env.EARTH_TARGET_ORIGIN); token = tokenValue(env.EARTH_COLLECTOR_TOKEN); }
    catch { return Promise.resolve(publicStatus(initialState(), now(), 'unavailable', 'invalid-configuration')); }
    const current = entry(origin);
    return current.pending ||= collect(env, origin, token, current).finally(() => { current.pending = null; });
  }
  async function status(env = {}) {
    let origin;
    try { origin = targetOrigin(env.EARTH_TARGET_ORIGIN); tokenValue(env.EARTH_COLLECTOR_TOKEN); }
    catch { return publicStatus(initialState(), now(), 'unavailable', 'invalid-configuration'); }
    const current = entry(origin);
    try { await restore(env, origin, current); }
    catch { return publicStatus(current.state, now(), 'unavailable', 'storage-unavailable'); }
    return publicStatus(current.state, now(), env.COLLECTOR_STATE?.get && env.COLLECTOR_STATE?.put ? 'kv-best-effort' : 'instance-memory');
  }
  async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/status' && url.pathname !== '/') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Read-only status', { status: 405, headers: { Allow: 'GET' } });
    return Response.json(await status(env), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  return { run, status, fetch: handle };
}

const collector = createCollector();
export default {
  async scheduled(_controller, env) {
    const result = await collector.run(env);
    // Body-free operational evidence; never log request headers or target JSON.
    console.info(JSON.stringify({ collector: 'earth', ...result }));
  },
  fetch(request, env) { return collector.fetch(request, env); },
};
