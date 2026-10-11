import { DEMAND_SUBJECTS, DEMAND_COUNTRIES, demandSubject, isDemandCountry, isDemandProductionOrigin } from '../src/core/demand-subjects.js';

const PREFIX = 'discovery/demand/days/';
const DAY = 86400000;
export const DEMAND_RETENTION_DAYS = 7;
export const MAX_DEMAND_BODY_BYTES = 512;
export const MAX_DEMAND_DAY_BYTES = 524288;
export const MAX_DEMAND_DAILY_GROUPS = DEMAND_SUBJECTS.length * (DEMAND_COUNTRIES.length + 1);
const MAX_COUNT = 1000000, MAX_ATTEMPTS = 5, MIN_PUBLIC_COUNT = 300, PUBLIC_BUCKET_SIZE = 100;
const configured = (env) => ['get', 'put', 'list', 'delete'].every((name) => typeof env?.EARTH_STORE?.[name] === 'function');
const json = (value, status = 200, extra = {}) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
class DemandError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const dayAt = (time) => new Date(time).toISOString().slice(0, 10);
const dayKey = (day) => `${PREFIX}${day}.json`;
const groupKey = (subjectId, country) => `${subjectId}|${country}`;
function validGroup(key) {
  const fields = key.split('|');
  if (fields.length !== 2 || !demandSubject(fields[0]) || !isDemandCountry(fields[1])) return false;
  return (fields[0] !== 'overview:country' || fields[1] !== '') && (fields[0] !== 'overview:all' || fields[1] === '');
}
function validateRecord(record, day) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some((key) => !['version', 'day', 'counts'].includes(key)) ||
      record.version !== 1 || record.day !== day || !record.counts || typeof record.counts !== 'object' || Array.isArray(record.counts)) throw new DemandError('Aggregate storage is unavailable.', 503);
  const entries = Object.entries(record.counts);
  if (entries.length > MAX_DEMAND_DAILY_GROUPS || entries.some(([key, count]) => !validGroup(key) || !Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT)) throw new DemandError('Aggregate storage is unavailable.', 503);
  return record;
}
async function readRecord(object, day) {
  if (!object) return null;
  if (Number(object.size) > MAX_DEMAND_DAY_BYTES) throw new DemandError('Aggregate storage is unavailable.', 503);
  const text = await object.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DEMAND_DAY_BYTES) throw new DemandError('Aggregate storage is unavailable.', 503);
  let record;
  try { record = JSON.parse(text); } catch { throw new DemandError('Aggregate storage is unavailable.', 503); }
  return validateRecord(record, day);
}
async function readPayload(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new DemandError('Use a JSON aggregate action.', 415);
  const size = request.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_DEMAND_BODY_BYTES)) throw new DemandError('Aggregate action exceeds its size limit.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new DemandError('A reviewed aggregate action is required.');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_DEMAND_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new DemandError('Aggregate action exceeds its size limit.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new DemandError('Use a reviewed aggregate action.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 3 ||
      Object.keys(payload).some((key) => !['subjectId', 'country', 'consent'].includes(key)) || payload.consent !== true ||
      typeof payload.subjectId !== 'string' || typeof payload.country !== 'string' || !validGroup(groupKey(payload.subjectId, payload.country))) throw new DemandError('Use a reviewed subject, country and explicit consent.');
  return payload;
}

/** Also call from a scheduler or configure an R2 lifecycle rule for this prefix.
 * Request-driven cleanup alone cannot promise physical deletion during an idle period. */
export async function pruneDemand(env, { now = Date.now } = {}) {
  if (!configured(env)) return { enabled: false, complete: false, deleted: 0, retentionDays: DEMAND_RETENTION_DAYS };
  const cutoff = dayAt(now() - (DEMAND_RETENTION_DAYS - 1) * DAY), bucket = env.EARTH_STORE;
  let deleted = 0;
  // Seven valid current keys can never fill a page. Repeat from the beginning
  // after deleting old pages, without relying on cursors across mutations.
  for (let pass = 0; pass < 4; pass++) {
    const page = await bucket.list({ prefix: PREFIX, limit: 64 });
    const expired = page.objects.filter(({ key }) => {
      const match = /^discovery\/demand\/days\/(\d{4}-\d\d-\d\d)\.json$/.exec(key);
      return match && match[1] < cutoff;
    }).map(({ key }) => key);
    if (expired.length) { await bucket.delete(expired); deleted += expired.length; }
    if (!page.truncated) return { enabled: true, complete: true, deleted, retentionDays: DEMAND_RETENTION_DAYS };
    if (!expired.length) break;
  }
  return { enabled: true, complete: false, deleted, retentionDays: DEMAND_RETENTION_DAYS };
}
async function increment(bucket, payload, time) {
  const day = dayAt(time), key = dayKey(day), group = groupKey(payload.subjectId, payload.country);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const previous = await bucket.get(key);
    if (previous && (typeof previous.etag !== 'string' || !previous.etag)) throw new DemandError('Aggregate storage is unavailable.', 503);
    const record = await readRecord(previous, day) || { version: 1, day, counts: {} };
    const count = record.counts[group] || 0;
    if (count >= MAX_COUNT) throw new DemandError('Aggregate action limit reached.', 429);
    record.counts[group] = count + 1;
    const text = JSON.stringify(record);
    if (new TextEncoder().encode(text).byteLength > MAX_DEMAND_DAY_BYTES) throw new DemandError('Aggregate action limit reached.', 429);
    const written = await bucket.put(key, text, {
      onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
      customMetadata: { expiresAt: new Date(Date.parse(`${day}T00:00:00Z`) + DEMAND_RETENTION_DAYS * DAY).toISOString() },
    });
    if (written !== null && written !== undefined && typeof written.etag === 'string' && written.etag) return;
  }
  throw new DemandError('Aggregate storage is busy. This action was not confirmed.', 503);
}
async function summary(bucket, time) {
  const days = Array.from({ length: DEMAND_RETENTION_DAYS }, (_, index) => dayAt(time - index * DAY));
  const records = await Promise.all(days.map(async (day) => readRecord(await bucket.get(dayKey(day)), day)));
  const totals = new Map();
  for (const record of records) for (const [key, count] of Object.entries(record?.counts || {})) totals.set(key, (totals.get(key) || 0) + count);
  // Ranking also uses public buckets, so it does not reveal the ordering of
  // exact counts within one 100-action bucket.
  const groups = [...totals].filter(([, count]) => count >= MIN_PUBLIC_COUNT).sort((a, b) =>
    Math.floor(b[1] / PUBLIC_BUCKET_SIZE) - Math.floor(a[1] / PUBLIC_BUCKET_SIZE) || a[0].localeCompare(b[0])).slice(0, 100).map(([key, count]) => {
    const [subjectId, country] = key.split('|');
    return { subjectId, label: demandSubject(subjectId).label, country, actions: Math.floor(count / PUBLIC_BUCKET_SIZE) * PUBLIC_BUCKET_SIZE };
  });
  return { enabled: true, groups, window: { firstDay: days.at(-1), lastDay: days[0], days: DEMAND_RETENTION_DAYS },
    minimumActions: MIN_PUBLIC_COUNT, bucketSize: PUBLIC_BUCKET_SIZE, maximumGroups: 100,
    unit: 'Accepted search actions, not unique people', rounding: 'Rounded down to multiples of 100',
    countryMeaning: 'Explicit country filter, never a visitor or map location' };
}

/** Public anonymous aggregation. Never read identity/IP/location headers or keep individual events. */
export async function handleDemand(request, env = {}, { now = Date.now } = {}) {
  const url = new URL(request.url);
  if (!['/api/discovery/demand', '/api/discovery/demand/summary'].includes(url.pathname)) return null;
  try {
    if (!isDemandProductionOrigin(url.origin) || request.headers.has('x-earth-test')) throw new DemandError('Aggregate demand is disabled on preview and test traffic.', 403);
    if (url.search || url.hash) throw new DemandError('Aggregate endpoints do not accept query parameters.');
    if (url.pathname === '/api/discovery/demand' && request.method === 'GET') return json({ enabled: configured(env),
      mode: 'explicit-reviewed-searches', retentionDays: DEMAND_RETENTION_DAYS, minimumPublicActions: MIN_PUBLIC_COUNT,
      unit: 'Accepted search actions, not unique people', physicalRetention: 'Cleanup runs on requests; configure a daily scheduler or R2 lifecycle for deletion during idle periods' });
    if (url.pathname === '/api/discovery/demand/summary' && request.method !== 'GET' || url.pathname === '/api/discovery/demand' && request.method !== 'POST') return json({ enabled: false, error: 'Method not allowed.' }, 405, { allow: url.pathname.endsWith('/summary') ? 'GET' : 'GET, POST' });
    if (request.method === 'POST' && (request.headers.get('origin') !== url.origin || request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) throw new DemandError('Aggregate actions must originate from this site.', 403);
    if (!configured(env)) throw new DemandError('Aggregate demand is not configured on this host.', 503);
    const payload = request.method === 'POST' ? await readPayload(request) : null;
    const time = now(); if (!Number.isFinite(time)) throw new DemandError('Aggregate storage is unavailable.', 503);
    const cleanup = await pruneDemand(env, { now: () => time });
    if (!cleanup.complete) throw new DemandError('Aggregate storage cleanup is incomplete.', 503);
    if (payload) {
      await increment(env.EARTH_STORE, payload, time);
      return json({ enabled: true, accepted: true, unit: 'Accepted search actions, not unique people' }, 202);
    }
    return json(await summary(env.EARTH_STORE, time));
  } catch (error) {
    return json({ enabled: false, accepted: false, error: error instanceof DemandError ? error.message : 'Aggregate storage is unavailable. This action was not confirmed.' }, error instanceof DemandError ? error.status : 503);
  }
}
