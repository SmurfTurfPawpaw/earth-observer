import { enqueueCoveragePriority } from './coverage-store.js';
import { makeRateLimiter } from '../src/sources/rateLimit.js';

export const COVERAGE_DEMAND_PATH = '/api/coverage/demand';
export const COVERAGE_DEMAND_LIMITS = Object.freeze({ bodyBytes: 512, sectors: 4, deadlineMs: 8000, ttlMs: 120000 });
const CLIENT = 'interactive-viewport-v1';
function interestAdmission() {
  const known = makeRateLimiter({ windowMs: 60000, max: 6, globalMax: 300 });
  const aggregate = makeRateLimiter({ windowMs: 60000, max: 300, globalMax: 300 });
  // Some hosting gateways omit the trusted client-IP header. Apply aggregate
  // admission then, rather than accidentally limiting every visitor to six.
  return key => (key === 'unknown' || known(key)) && aggregate('all');
}
const reply = (value, status, headers = {}) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
async function boundedBody(request, signal) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > COVERAGE_DEMAND_LIMITS.bodyBytes)) throw new TypeError('body-limit');
  const reader = request.body?.getReader(); if (!reader) throw new TypeError('missing-body');
  let text = '', size = 0, chunks = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  let cancelRead;
  const cancelled = new Promise((_, reject) => { cancelRead = () => reject(signal.reason);
    signal.addEventListener('abort', cancelRead, { once: true }); if (signal.aborted) cancelRead(); });
  try { for (;;) { signal.throwIfAborted(); const { done, value } = await Promise.race([reader.read(), cancelled]); signal.throwIfAborted();
      if (done) break; size += value.byteLength;
      if (size > COVERAGE_DEMAND_LIMITS.bodyBytes || ++chunks > 64) throw new TypeError('body-limit');
      text += decoder.decode(value, { stream: true }); }
    text += decoder.decode(); return JSON.parse(text);
  } catch (error) { stop(); throw error; }
  finally { signal.removeEventListener('abort', stop); signal.removeEventListener('abort', cancelRead); reader.releaseLock(); }
}
/** Functional, ephemeral interest only. This never counts searches, stores an
 * identity or acquires a provider. The existing scheduler owns all actual work. */
export function createCoverageDemandHandler({ now = Date.now, enqueue = enqueueCoveragePriority,
  admit = interestAdmission() } = {}) {
  return async (request, env) => {
    const url = new URL(request.url); if (url.pathname !== COVERAGE_DEMAND_PATH) return null;
    if (request.method !== 'POST') return reply({ accepted: false, error: 'method-not-allowed' }, 405, { allow: 'POST' });
    if (url.search || request.headers.get('origin') !== url.origin || request.headers.get('x-earth-client') !== CLIENT ||
      !/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') || '') ||
      ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) return reply({ accepted: false, error: 'invalid-interest-request' }, 403);
    if (!admit(request.headers.get('cf-connecting-ip') || 'unknown')) return reply({ accepted: false, error: 'interest-budget' }, 429, { 'retry-after': '60' });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(COVERAGE_DEMAND_LIMITS.deadlineMs)]);
    let body;
    try { body = await boundedBody(request, signal);
      if (!body || Object.keys(body).sort().join(',') !== 'reason,schemaVersion,sectors' || body.schemaVersion !== 1 || body.reason !== 'viewport' ||
        !Array.isArray(body.sectors) || !body.sectors.length || body.sectors.length > COVERAGE_DEMAND_LIMITS.sectors ||
        body.sectors.some(id => !Number.isInteger(id) || id < 1 || id > 120) || new Set(body.sectors).size !== body.sectors.length) throw new TypeError('invalid-interest');
    } catch { return reply({ accepted: false, error: 'invalid-interest' }, 400); }
    if (!env?.EARTH_DB?.prepare || !env.EARTH_DB.batch) return reply({ accepted: false, error: 'interest-unavailable' }, 503);
    const expiresAt = new Date(now() + COVERAGE_DEMAND_LIMITS.ttlMs).toISOString();
    try { for (const sectorId of body.sectors) { signal.throwIfAborted();
        const result = await enqueue(env, { sectorId, reason: 'viewport', priority: 30, expiresAt }, { now, signal });
        if (result?.configured !== true) return reply({ accepted: false, error: 'interest-unavailable' }, 503); }
      return reply({ accepted: true, sectors: body.sectors, expiresAt, meaning: 'Priority interest is deduplicated and subject to the bounded queue; processing occurs on an authenticated wake' }, 202);
    } catch { return reply({ accepted: false, error: 'interest-unavailable' }, 503); }
  };
}
