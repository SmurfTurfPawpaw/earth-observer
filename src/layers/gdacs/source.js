import { createBrowserStore } from '../../core/browser-store.js';
import { normalizeGdacsSourceItems, GDACS_SOURCE_ITEM_LIMITS } from '../../core/gdacs-source-items.js';

export const GDACS_CACHE_KEY = 'source:gdacs-notices:v1';
export const GDACS_BROWSER_LIMITS = Object.freeze({ cacheAgeMs: 3600000, cacheReadMs: 120 });
const clone = value => JSON.parse(JSON.stringify(value));

function bounded(work, signal, timeoutMs) {
  signal.throwIfAborted(); let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new Error('GDACS browser cache unavailable')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), stopped])
    .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
}

async function body(response, signal) {
  const sizeHeader = response.headers?.get?.('content-length');
  if (sizeHeader != null && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader) > GDACS_SOURCE_ITEM_LIMITS.bytes)) {
    void response.body?.cancel?.(); throw new Error('Stored GDACS cohort exceeds its size limit');
  }
  if (!response.body?.getReader) throw new Error('Stored GDACS cohort has no bounded body');
  const reader = response.body.getReader(), parts = []; let bytes = 0, chunks = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (++chunks > 4096 || !part.value.byteLength || bytes > GDACS_SOURCE_ITEM_LIMITS.bytes) throw new Error('Stored GDACS cohort exceeds its size limit');
      parts.push(part.value);
    }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  } finally { signal.removeEventListener('abort', abort); if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Device cache and stored metadata only. The global collection event is a wake,
 * not a GDACS source clock, receipt or proof of fresh acquisition. */
export function createGdacsNoticeSource({ fetchImpl = (...args) => globalThis.fetch(...args), store = createBrowserStore(), now = Date.now,
  baseUrl = import.meta.env?.BASE_URL || '/', deadlineMs = GDACS_SOURCE_ITEM_LIMITS.deadlineMs } = {}) {
  if (!['/', '/earth/'].includes(baseUrl) || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > GDACS_SOURCE_ITEM_LIMITS.deadlineMs)
    throw new TypeError('Use the reviewed bounded GDACS application route');
  const endpoint = `${baseUrl}api/world/source-items?source=gdacs`;
  let active, cacheDirty = false, memory;
  const validated = async (value, signal) => {
    signal.throwIfAborted(); const result = await normalizeGdacsSourceItems(value); signal.throwIfAborted();
    if (Date.parse(result.readAt) > now() + 305000) throw new Error('Stored GDACS response clock is outside its bound');
    return clone(result);
  };
  const decorate = (value, savedAt, cached) => ({ ...clone(value), browserReadAt: now(),
    browserCachedAt: cached ? savedAt : null, browserCache: cached ? 'STALE' : null });
  return {
    invalidate() {
      cacheDirty = true;
      if (active && !active.signal.aborted) active.abort(new DOMException('Stored GDACS cohort was invalidated', 'AbortError'));
      return true;
    },
    async getSnapshot({ signal: external, onCached } = {}) {
      active?.abort(); const owner = new AbortController(); active = owner;
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new DOMException('Stored GDACS deadline exceeded', 'TimeoutError')), deadlineMs);
      const signal = AbortSignal.any([owner.signal, deadline.signal, external].filter(Boolean));
      try {
        signal.throwIfAborted();
        if (!cacheDirty && typeof onCached === 'function') {
          try {
            const cached = memory || await bounded(() => store.get(GDACS_CACHE_KEY), signal, GDACS_BROWSER_LIMITS.cacheReadMs);
            signal.throwIfAborted();
            if (cached?.schemaVersion === 1 && Number.isFinite(cached.savedAt) && cached.savedAt <= now() && now() - cached.savedAt <= GDACS_BROWSER_LIMITS.cacheAgeMs) {
              const snapshot = await bounded(() => validated(cached.snapshot, signal), signal);
              signal.throwIfAborted(); if (!cacheDirty) { await onCached(decorate(snapshot, cached.savedAt, true)); signal.throwIfAborted(); }
            }
          } catch { signal.throwIfAborted(); /* Local cache failure never substitutes a partial cohort. */ }
        }
        const response = await bounded(async () => {
          const value = await fetchImpl(endpoint, { signal, credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } });
          if (signal.aborted) { void value.body?.cancel?.(); signal.throwIfAborted(); } return value;
        }, signal);
        signal.throwIfAborted();
        if (!response.ok) { void response.body?.cancel?.(); throw new Error(`Stored GDACS notices unavailable (HTTP ${response.status})`); }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.('content-type') || '')) {
          void response.body?.cancel?.(); throw new Error('Stored GDACS notices have an incompatible content type');
        }
        const snapshot = await bounded(async () => validated(await body(response, signal), signal), signal); signal.throwIfAborted();
        const savedAt = now(); memory = { schemaVersion: 1, savedAt, snapshot }; cacheDirty = false;
        try { void Promise.resolve(store.put(GDACS_CACHE_KEY, clone(memory))).catch(() => {}); } catch { /* Device cache is optional. */ }
        return decorate(snapshot, savedAt, false);
      } finally { clearTimeout(timer); if (active === owner) active = null; }
    },
  };
}
