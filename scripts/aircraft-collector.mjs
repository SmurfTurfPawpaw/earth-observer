import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readsbSnapshot } from '../src/sources/live/aircraft.js';
import { readResponseJsonCapped } from '../src/sources/httpBody.js';

export const AIRCRAFT_PUBLISH_URL = 'https://giovannicallebaut.com/earth/api/collector';
export const AIRCRAFT_SOURCE_URL = 'https://giovannicallebaut.com/earth/api/flights?lat=50.8500&lon=4.3500&radiusKm=250';
export const AIRCRAFT_SCOPE = Object.freeze({ id: 'brussels-250km', type: 'area', latitude: 50.85, longitude: 4.35, radiusKm: 250 });
export const AIRCRAFT_COLLECTOR_LIMITS = Object.freeze({ intervalMs: 30000, requestDeadlineMs: 15000,
  upstreamBytes: 8 * 1024 * 1024, publishBytes: 1500000, stateBytes: 2 * 1024 * 1024,
  acknowledgementBytes: 65536, records: 2000, retryAfterMs: 86400000 });
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../.cache/aircraft-collector/', import.meta.url));
const iso = value => new Date(value).toISOString();
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => typeof value === 'number' && Number.isFinite(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;
const nullableTime = value => value === null || time(value);
const RECORD_KEYS = ['id', 'reference', 'latitude', 'longitude', 'callsign', 'originCountry', 'positionTimeMs',
  'positionTimeQuality', 'contactTimeMs', 'baroAltitudeM', 'ellipsoidAltitudeM', 'onGround', 'speedMps', 'courseDeg',
  'verticalRateMps', 'verticalRateAltitudeType', 'accuracy', 'category', 'typeCode', 'registration', 'operator'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nullableNumber = (value, min, max) => value === null || number(value) && value >= min && value <= max;
const boundedText = (value, max) => typeof value === 'string' && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const OUTCOMES = new Set(['idle', 'queued', 'published', 'cancelled', 'timeout', 'invalid-response', 'publish-failed', 'source-unavailable']);
function validAccuracy(value) {
  if (value === null) return true;
  if (!exactKeys(value, ['nic', 'rcM', 'nacP', 'nacV', 'sil', 'silType'])) return false;
  return [['nic', 11], ['nacP', 11], ['nacV', 4], ['sil', 3]].every(([key, max]) =>
    value[key] === null || Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= max) &&
    nullableNumber(value.rcM, 0, 1000000) && [null, 'unknown', 'perhour', 'persample'].includes(value.silType);
}

function validatePacket(packet) {
  if (!exactKeys(packet, ['schemaVersion', 'source', 'collectedAt', 'scope', 'observedAtMs', 'observedAtSource', 'sourceState', 'records']) ||
      packet.schemaVersion !== 1 || packet.source !== 'adsb.lol' || !time(packet.collectedAt) ||
      JSON.stringify(packet.scope) !== JSON.stringify(AIRCRAFT_SCOPE) || !Array.isArray(packet.records) || packet.records.length > AIRCRAFT_COLLECTOR_LIMITS.records)
    throw new Error('Invalid bounded aircraft packet');
  const known = packet.observedAtSource === 'source';
  if (!['source', 'unknown'].includes(packet.observedAtSource) ||
      (known ? !number(packet.observedAtMs) || packet.observedAtMs <= 0 || packet.observedAtMs > Date.parse(packet.collectedAt) + 5000 : packet.observedAtMs !== null))
    throw new Error('Invalid aircraft observation epoch');
  const source = packet.sourceState;
  if (!exactKeys(source, ['freshness', 'cache', 'cacheAgeMs', 'ageMs', 'complete', 'rejectedCount']) ||
      !['current', 'stale', 'unknown'].includes(source.freshness) || !['HIT', 'MISS', 'STALE', 'unknown'].includes(source.cache) ||
      ![source.cacheAgeMs, source.ageMs].every(value => value === null || number(value) && value >= 0) ||
      typeof source.complete !== 'boolean' || !Number.isInteger(source.rejectedCount) || source.rejectedCount < 0 || source.rejectedCount > 100000)
    throw new Error('Invalid aircraft source status');
  const ids = new Set();
  for (const record of packet.records) {
    if (!exactKeys(record, RECORD_KEYS) || !/^~?[0-9a-f]{6}$/.test(record.id) || record.reference !== record.id || ids.has(record.id) ||
        !number(record.latitude) || Math.abs(record.latitude) > 90 || !number(record.longitude) || Math.abs(record.longitude) > 180 ||
        !['reported', 'unknown'].includes(record.positionTimeQuality) ||
        (record.positionTimeQuality === 'reported' ? !known || !number(record.positionTimeMs) || record.positionTimeMs <= 0 ||
          record.positionTimeMs > packet.observedAtMs : record.positionTimeMs !== null) ||
        ![record.contactTimeMs].every(value => value === null || known && number(value) && value > 0 && value <= packet.observedAtMs) ||
        !nullableNumber(record.baroAltitudeM, -1000, 60000) || !nullableNumber(record.ellipsoidAltitudeM, -1000, 60000) ||
        !nullableNumber(record.speedMps, 0, 1500) || !nullableNumber(record.courseDeg, 0, 360) || record.courseDeg === 360 ||
        !nullableNumber(record.verticalRateMps, -500, 500) || ![null, 'barometric', 'geometric'].includes(record.verticalRateAltitudeType) ||
        typeof record.onGround !== 'boolean' || !boundedText(record.callsign, 32) || !boundedText(record.typeCode, 24) ||
        !boundedText(record.registration, 48) || !boundedText(record.operator, 160) ||
        !(record.originCountry === null || boundedText(record.originCountry, 80)) || !validAccuracy(record.accuracy) ||
        !(record.category === null || Number.isInteger(record.category) && record.category >= 0 && record.category <= 255 ||
          typeof record.category === 'string' && /^[A-Z][A-Z0-9]{0,7}$/.test(record.category)))
      throw new Error('Invalid normalized aircraft observation');
    ids.add(record.id);
  }
  if (bytes({ action: 'aircraft', packet }) > AIRCRAFT_COLLECTOR_LIMITS.publishBytes) throw new Error('Aircraft publish packet exceeds 1500000 bytes');
  return packet;
}

function retryAfter(response, at) {
  const header = response.headers.get('retry-after');
  const ms = /^\d+$/.test(header || '') ? Number(header) * 1000 : Date.parse(header || '') - at;
  return Number.isFinite(ms) ? Math.max(0, Math.min(AIRCRAFT_COLLECTOR_LIMITS.retryAfterMs, ms)) : 0;
}
function retryDelay(failures, status, requested) {
  return Math.max(Math.min(3600000, 30000 * 2 ** Math.min(failures, 7)), status === 401 || status === 403 ? 300000 : 0, requested);
}
function packetFrom(payload, response, capturedAt) {
  if (!Array.isArray(payload?.ac) || payload.ac.length > AIRCRAFT_COLLECTOR_LIMITS.records) throw new Error('Aircraft source exceeds its bounded record count');
  const upstream = payload.now;
  const epochMs = number(upstream) && upstream > 0 ? upstream * (upstream < 100000000000 ? 1000 : 1) : null;
  const known = epochMs !== null && epochMs <= capturedAt + 5000 && epochMs <= 8640000000000000;
  const observedAtMs = known ? epochMs : null;
  const rawCacheAge = response.headers.get('x-feed-age-ms'), parsedAge = rawCacheAge === null || rawCacheAge.trim() === '' ? null : Number(rawCacheAge);
  const cacheAgeMs = number(parsedAge) && parsedAge >= 0 ? parsedAge : null;
  const rawCache = response.headers.get('x-feed-cache'), cache = ['HIT', 'MISS', 'STALE'].includes(rawCache) ? rawCache : 'unknown';
  const snapshot = readsbSnapshot(payload, { now: capturedAt, source: 'adsb.lol', observedAtMs,
    observedAtSource: known ? 'source' : 'unknown', coverage: 'Reviewed Brussels region, 250km radius; not worldwide coverage',
    stale: cache === 'STALE' || cacheAgeMs > 120000 || known && capturedAt - observedAtMs > 120000 });
  return validatePacket({ schemaVersion: 1, source: 'adsb.lol', collectedAt: iso(capturedAt), scope: { ...AIRCRAFT_SCOPE },
    observedAtMs, observedAtSource: known ? 'source' : 'unknown',
    sourceState: { freshness: snapshot.freshness, cache, cacheAgeMs, ageMs: snapshot.ageMs,
      complete: snapshot.complete, rejectedCount: snapshot.rejectedCount }, records: snapshot.records });
}

/** A fixed owned source and one private writer. Importing this module performs no acquisition. */
export function createAircraftCollector({ credential, stateDirectory = DEFAULT_DIRECTORY, fetchImpl = fetch, now = Date.now,
  requestDeadlineMs = AIRCRAFT_COLLECTOR_LIMITS.requestDeadlineMs, logger = value => console.log(JSON.stringify(value)), once = false } = {}) {
  if (typeof credential !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(credential)) throw new Error('Aircraft collector requires the existing server credential');
  const directory = path.resolve(stateDirectory), stateFile = path.join(directory, 'state.json');
  const deadlineMs = number(requestDeadlineMs) ? Math.max(1, Math.min(AIRCRAFT_COLLECTOR_LIMITS.requestDeadlineMs, requestDeadlineMs)) : AIRCRAFT_COLLECTOR_LIMITS.requestDeadlineMs;
  let state = { schemaVersion: 1, lastAttemptAt: null, lastAcquiredAt: null, lastPublishedAt: null,
    lastSourceFreshness: 'unknown', recordCount: 0, nextAcquisitionAt: 0, acquisitionRetryAt: 0,
    acquisitionFailures: 0, lastHttpStatus: null, lastOutcome: 'idle', outbox: null };
  let initialized, serial = Promise.resolve(), temporary = 0, stopped = false, running = false, timer, wake;
  const shutdown = new AbortController();
  async function save() {
    if (bytes(state) > AIRCRAFT_COLLECTOR_LIMITS.stateBytes) throw new Error('Aircraft state exceeds its byte limit');
    await mkdir(directory, { recursive: true });
    const temporaryFile = `${stateFile}.${process.pid}.${++temporary}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await rename(temporaryFile, stateFile);
  }
  const initialize = () => initialized ||= (async () => {
    await mkdir(directory, { recursive: true });
    let file;
    try {
      file = await open(stateFile, 'r'); const info = await file.stat();
      if (!info.isFile() || info.size > AIRCRAFT_COLLECTOR_LIMITS.stateBytes) throw new Error('Aircraft state exceeds its byte limit');
      const buffer = Buffer.alloc(info.size + 1); let length = 0;
      while (length < buffer.length) { const chunk = await file.read(buffer, length, buffer.length - length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      if (length > info.size) throw new Error('Aircraft state changed during bounded reading');
      const saved = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (!exactKeys(saved, Object.keys(state)) || saved.schemaVersion !== 1 ||
          !['lastAttemptAt', 'lastAcquiredAt', 'lastPublishedAt'].every(key => nullableTime(saved[key])) ||
          !['nextAcquisitionAt', 'acquisitionRetryAt'].every(key => number(saved[key]) && saved[key] >= 0 && saved[key] <= 8640000000000000) ||
          !Number.isInteger(saved.acquisitionFailures) || saved.acquisitionFailures < 0 || saved.acquisitionFailures > 10 ||
          !Number.isInteger(saved.recordCount) || saved.recordCount < 0 || saved.recordCount > AIRCRAFT_COLLECTOR_LIMITS.records ||
          !['current', 'stale', 'unknown'].includes(saved.lastSourceFreshness) || !OUTCOMES.has(saved.lastOutcome) ||
          !(saved.lastHttpStatus === null || Number.isInteger(saved.lastHttpStatus) && saved.lastHttpStatus >= 100 && saved.lastHttpStatus <= 599)) throw new Error('Aircraft state failed validation');
      if (saved.outbox) {
        const queued = saved.outbox;
        if (!exactKeys(queued, ['body', 'digest', 'failures', 'nextRetryAt']) || !exactKeys(queued.body, ['action', 'packet']) ||
            queued.body.action !== 'aircraft' || digest(queued.body) !== queued.digest || !Number.isInteger(queued.failures) || queued.failures < 0 || queued.failures > 10 ||
            !number(queued.nextRetryAt) || queued.nextRetryAt < 0 || queued.nextRetryAt > 8640000000000000) throw new Error('Aircraft outbox failed validation');
        validatePacket(queued.body.packet);
      }
      state = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Aircraft local state is unavailable or invalid'); }
    finally { await file?.close(); }
  })();
  const runSerial = task => { const work = serial.catch(() => {}).then(async () => { await initialize(); return task(); }); serial = work; return work; };
  const summary = (outcome, extra = {}) => ({ outcome, published: false, scopeId: AIRCRAFT_SCOPE.id, recordCount: state.recordCount,
    queued: Boolean(state.outbox), lastAttemptAt: state.lastAttemptAt, lastAcquiredAt: state.lastAcquiredAt,
    lastPublishedAt: state.lastPublishedAt, sourceFreshness: state.lastSourceFreshness, lastHttpStatus: state.lastHttpStatus,
    retryAt: Math.max(state.outbox?.nextRetryAt || 0, state.acquisitionRetryAt) > now() ? iso(Math.max(state.outbox?.nextRetryAt || 0, state.acquisitionRetryAt)) : null, ...extra });
  async function request(url, init, signal) {
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new DOMException('Aircraft request deadline', 'TimeoutError')), deadlineMs);
    const combined = AbortSignal.any([shutdown.signal, controller.signal, signal].filter(Boolean));
    try {
      combined.throwIfAborted();
      const response = await fetchImpl(url, { ...init, signal: combined, redirect: 'error' }); combined.throwIfAborted();
      const requestedRetryMs = retryAfter(response, now());
      if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, requestedRetryMs }; }
      const value = await readResponseJsonCapped(response, url === AIRCRAFT_SOURCE_URL ? AIRCRAFT_COLLECTOR_LIMITS.upstreamBytes : AIRCRAFT_COLLECTOR_LIMITS.acknowledgementBytes, combined);
      combined.throwIfAborted(); return { ok: true, status: response.status, requestedRetryMs, value, response };
    } catch {
      return { ok: false, status: null, requestedRetryMs: 0, outcome: shutdown.signal.aborted || signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'invalid-response' };
    } finally { clearTimeout(deadline); }
  }
  async function flush(signal) {
    if (state.outbox.nextRetryAt > now()) return summary('backoff');
    const result = await request(AIRCRAFT_PUBLISH_URL, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(state.outbox.body) }, signal);
    state.lastHttpStatus = result.status;
    if (result.ok && result.value?.stored === true) {
      state.lastPublishedAt = state.outbox.body.packet.collectedAt; state.outbox = null; state.lastOutcome = 'published';
      await save(); return summary('published', { published: true });
    }
    if (result.outcome === 'cancelled') { state.lastOutcome = 'cancelled'; await save(); return summary('cancelled'); }
    state.outbox.failures = Math.min(10, state.outbox.failures + 1);
    state.outbox.nextRetryAt = now() + retryDelay(state.outbox.failures, result.status, result.requestedRetryMs);
    state.lastOutcome = result.outcome || 'publish-failed'; await save(); return summary(state.lastOutcome);
  }
  async function acquire(signal) {
    if (Math.max(state.nextAcquisitionAt, state.acquisitionRetryAt) > now()) return summary(state.acquisitionRetryAt > now() ? 'backoff' : 'waiting');
    state.lastAttemptAt = iso(now()); state.nextAcquisitionAt = now() + AIRCRAFT_COLLECTOR_LIMITS.intervalMs; await save();
    const result = await request(AIRCRAFT_SOURCE_URL, { method: 'GET', headers: { accept: 'application/json' } }, signal);
    state.lastHttpStatus = result.status;
    let packet;
    if (result.ok) { try { packet = packetFrom(result.value, result.response, now()); } catch { result.outcome = 'invalid-response'; } }
    if (!packet) {
      if (result.outcome === 'cancelled') { state.lastOutcome = 'cancelled'; await save(); return summary('cancelled'); }
      state.acquisitionFailures = Math.min(10, state.acquisitionFailures + 1);
      state.acquisitionRetryAt = now() + retryDelay(state.acquisitionFailures, result.status, result.requestedRetryMs);
      state.lastOutcome = result.outcome || 'source-unavailable'; await save(); return summary(state.lastOutcome);
    }
    state.lastAcquiredAt = packet.collectedAt; state.recordCount = packet.records.length; state.lastSourceFreshness = packet.sourceState.freshness;
    state.acquisitionFailures = 0; state.acquisitionRetryAt = 0;
    const body = { action: 'aircraft', packet }; state.outbox = { body, digest: digest(body), failures: 0, nextRetryAt: 0 };
    state.lastOutcome = 'queued'; await save(); return flush(signal);
  }
  const cycle = ({ signal } = {}) => runSerial(async () => {
    if (stopped || signal?.aborted) return summary('cancelled');
    return state.outbox ? flush(signal) : acquire(signal);
  });
  const wait = milliseconds => new Promise(resolve => {
    if (stopped || milliseconds <= 0) { resolve(); return; }
    wake = resolve; timer = setTimeout(() => { timer = null; wake = null; resolve(); }, milliseconds);
  });
  function stop() { if (stopped) return; stopped = true; clearTimeout(timer); timer = null; wake?.(); wake = null; shutdown.abort(new DOMException('Aircraft collector stopping', 'AbortError')); }
  async function start() {
    if (running) throw new Error('Aircraft collector already running'); running = true;
    try {
      await initialize();
      logger({ event: 'aircraft-collector-start', intervalMs: AIRCRAFT_COLLECTOR_LIMITS.intervalMs, scopeId: AIRCRAFT_SCOPE.id, coverage: 'Brussels 250km; military unconfigured' });
      while (!stopped) {
        const began = now(), result = await cycle(); logger({ event: 'aircraft-collector-cycle', ...result });
        if (once) break; await wait(Math.max(0, began + AIRCRAFT_COLLECTOR_LIMITS.intervalMs - now()));
      }
    } finally { running = false; }
  }
  return { cycle, start, stop, status: () => runSerial(async () => ({ ...summary(state.lastOutcome), running, stopped,
    intervalMs: AIRCRAFT_COLLECTOR_LIMITS.intervalMs, requestDeadlineMs: deadlineMs, coverage: 'Brussels 250km; military unconfigured' })) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/aircraft-collector.mjs [--once]\nFixed Brussels 250km scope via the owned flights API, every30 seconds. Existing EARTH_COLLECTION_SECRET (or EARTH_COLLECTOR_TOKEN) required. No URL, region or military argument. This local process needs the laptop and Internet running; it is not worldwide uninterrupted collection.'); return;
  }
  if (args.some(value => value !== '--once') || args.length > 1) throw new Error('Invalid aircraft collector arguments');
  const collector = createAircraftCollector({ credential: process.env.EARTH_COLLECTION_SECRET || process.env.EARTH_COLLECTOR_TOKEN, once: args.includes('--once') });
  const stop = () => collector.stop(); process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await collector.start(); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error(JSON.stringify({ event: 'aircraft-collector-stopped', outcome: 'configuration-or-local-state-unavailable' })); process.exitCode = 1; });
