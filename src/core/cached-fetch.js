import { createBrowserStore } from './browser-store.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function whileActive(work, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason || new DOMException('Request cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

// Cancelling one branch of a cloned response must not await the other branch,
// which belongs to the feed caller and has not started reading yet.
async function snapshotBody(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) return null;
  const copy = response.clone(), reader = copy.body?.getReader();
  if (!reader) return null;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { cancel(); return null; }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body.buffer;
  } catch {
    cancel();
    return null;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function responseCachePolicy(url) {
  const path = url.pathname;
  if (url.username || url.password || /\/(?:frame|track|history)\//.test(path)) return null;
  if (path === '/api/flights' || path === '/api/military' || path.startsWith('/api/transit/vehicles/')) return { fresh: 10_000, expire: 300_000 };
  if (path.startsWith('/api/gbfs/')) return { fresh: 30_000, expire: 300_000 };
  if (path === '/api/cctv/sources') return { fresh: 300_000, expire: 3_600_000 };
  if (path === '/api/intelligence') return { fresh: 60_000, expire: 3_600_000 };
  if (path === '/api/economics') return { fresh: 86_400_000, expire: 604_800_000 };
  if (url.origin === 'https://earthquake.usgs.gov' && path.startsWith('/earthquakes/feed/')) return { fresh: 30_000, expire: 3_600_000 };
  if (/^\/api\/(?:weather|wind|cyclones|firms|rocket-launches|celestrak)(?:\/|$)/.test(path)) return { fresh: 60_000, expire: 3_600_000 };
  return null;
}

/** Immediate bounded snapshots followed by one shared network update; never cache credentials/images. */
export function createCachedFetch({ fetchImpl = (...args) => fetch(...args), store = createBrowserStore(),
  origin = globalThis.location?.origin || 'http://localhost', now = Date.now,
  online = () => globalThis.navigator?.onLine !== false, visible = () => !globalThis.document?.hidden,
} = {}) {
  const pending = new Map(), subscribers = new Set();
  const lifetime = new AbortController();
  let trimming = Promise.resolve();
  const emit = (url) => { for (const listener of subscribers) { try { listener(url); } catch {} } };
  function cachedResponse(record, mode) {
    const headers = new Headers(record.headers);
    const age = Math.max(0, now() - record.at);
    headers.set('x-browser-cache', mode); headers.set('x-browser-cached-at', String(record.at));
    headers.set('x-browser-cache-age-ms', String(age));
    headers.set('x-feed-age-ms', String(age + Math.max(0, Number(headers.get('x-feed-age-ms')) || 0)));
    if (mode !== 'HIT') { headers.set('x-feed-cache', 'STALE'); headers.set('x-gev-cache', 'STALE-ERROR'); }
    return new Response(record.body.slice(0), { status: record.status, headers });
  }
  const usable = (record) => record && Number.isFinite(record.at) && record.at >= 0 && record.at <= now() + 5000 &&
    record.status >= 200 && record.status < 300 && record.status !== 204 && record.status !== 205 &&
    (record.body instanceof ArrayBuffer || ArrayBuffer.isView(record.body)) &&
    typeof record.body.slice === 'function' && record.body.byteLength <= MAX_RESPONSE_BYTES;
  function trim() {
    trimming = trimming.then(async () => {
      const records = (await store.all()).filter((item) => item?.key?.startsWith('response:')).sort((a, b) => b.at - a.at);
      let bytes = 0;
      for (const [index, record] of records.entries()) {
        bytes += Number(record.body?.byteLength) || 0;
        if (!usable(record) || index >= 60 || bytes > 24 * 1024 * 1024 || now() - record.at > record.expire) await store.delete(record.key);
      }
    }).catch(() => {});
  }
  function network(url, init, policy, notify = false) {
    const callerSignal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal;
    callerSignal.throwIfAborted();
    let entry = pending.get(url);
    if (!entry || entry.controller.signal.aborted) {
      entry = { controller: new AbortController(), consumers: new Set(), settled: false, notify };
      pending.set(url, entry);
      const current = entry;
      current.work = Promise.resolve().then(async () => {
        const signal = AbortSignal.any([lifetime.signal, current.controller.signal, AbortSignal.timeout(15_000)]);
        signal.throwIfAborted();
        const response = await fetchImpl(url, { ...init, signal });
        const receivedAt = now();
        // A cache failure is independent of the successful HTTP response.
        try {
          if (response.ok && response.status !== 204 && response.status !== 205 &&
              /(?:json|ndjson)/i.test(response.headers.get('content-type') || '') &&
              !/no-store|private/i.test(response.headers.get('cache-control') || '')) {
            const body = await snapshotBody(response, signal);
            if (body && !signal.aborted) {
              await store.put(`response:${url}`, { at: receivedAt, body, status: response.status, headers: [...response.headers], expire: policy.expire });
              trim();
              if (current.notify) emit(url);
            }
          }
        } catch {}
        return response;
      }).finally(() => {
        current.settled = true;
        if (pending.get(url) === current) pending.delete(url);
      });
    }
    entry.notify ||= notify;
    const current = entry;
    // Each caller owns its cancellation. Only the last departing caller can
    // stop a shared transport, so disabling one layer cannot interrupt another.
    return new Promise((resolve, reject) => {
      const consumer = {};
      let finished = false;
      current.consumers.add(consumer);
      const finish = () => {
        if (finished) return false;
        finished = true;
        callerSignal.removeEventListener('abort', abort);
        current.consumers.delete(consumer);
        if (!current.settled && !current.consumers.size) current.controller.abort();
        return true;
      };
      const abort = () => {
        if (finish()) reject(callerSignal.reason || new DOMException('Request cancelled', 'AbortError'));
      };
      callerSignal.addEventListener('abort', abort, { once: true });
      current.work.then((response) => {
        if (finish()) {
          try { resolve(response.clone()); } catch (error) { reject(error); }
        }
      }, (error) => {
        if (finish()) reject(error);
      });
      if (callerSignal.aborted) abort();
    });
  }
  const cachedFetch = async (input, init = {}) => {
    if (lifetime.signal.aborted) throw new DOMException('Workspace closed', 'AbortError');
    init.signal?.throwIfAborted();
    // Preserve Request objects and authenticated/explicitly uncached fetch semantics.
    if (typeof Request !== 'undefined' && input instanceof Request) return fetchImpl(input, init);
    const url = new URL(String(input), origin);
    const headers = new Headers(init.headers);
    const policy = (!init.method || init.method.toUpperCase() === 'GET') && init.credentials !== 'include' && init.cache !== 'no-store' &&
      !headers.has('authorization') && !headers.has('cookie') && !headers.has('range') ? responseCachePolicy(url) : null;
    if (!policy || (url.origin !== origin && url.origin !== 'https://earthquake.usgs.gov')) return fetchImpl(input, init);
    let record;
    const signal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal;
    try { record = await whileActive(Promise.resolve().then(() => store.get(`response:${url.href}`)), signal); } catch {}
    if (lifetime.signal.aborted) throw new DOMException('Workspace closed', 'AbortError');
    init.signal?.throwIfAborted();
    const age = usable(record) ? Math.max(0, now() - record.at) : Infinity;
    if (age <= policy.expire) {
      const mode = !online() ? 'OFFLINE' : age <= policy.fresh ? 'HIT' : 'STALE';
      try {
        const response = cachedResponse(record, mode);
        if (mode === 'STALE' && visible()) void network(url.href, init, policy, true).catch(() => {});
        return response;
      } catch {} // Corrupt local records are replaceable and must not block a feed.
    }
    return network(url.href, init, policy);
  };
  cachedFetch.subscribe = (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); };
  cachedFetch.destroy = () => { lifetime.abort(); subscribers.clear(); };
  return cachedFetch;
}
