import { readResponseJsonCapped } from '../src/sources/httpBody.js';

export const AIRCRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const AIRCRAFT_MAX_RECORDS = 2000;
export const AIRCRAFT_MAX_HISTORY = 4000;
export const AIRCRAFT_MAX_SCOPES = 8;
export const AIRCRAFT_HISTORY_MS = 90000;
const CATALOG = 'aircraft/scopes.json', FRESH_MS = 120000, RETAIN_MS = 86400000;
const encoder = new TextEncoder(), queues = new WeakMap();
const bytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const hash = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const nullableNumber = (value, min, max) => value === null || number(value, min, max);
const text = (value, limit) => typeof value === 'string' && value === value.trim() && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const configured = (env) => Boolean(env?.EARTH_STORE?.get && env?.EARTH_STORE?.put);
const primary = (db) => typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
const preparedKey = (scopeId) => `aircraft/prepared/${scopeId}.json`;
const captureKey = (id) => `aircraft/captures/${id}.json`;
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 503 ? { 'retry-after': '20' } : {}),
  ...headers,
} });

export function aircraftScope(value) {
  if (!exact(value, ['id', 'type', 'latitude', 'longitude', 'radiusKm']) ||
      typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) ||
      !['area', 'military'].includes(value.type)) throw new TypeError('Invalid aircraft collection scope');
  if (value.type === 'area' ? !number(value.latitude, -90, 90) || !number(value.longitude, -180, 180) || !number(value.radiusKm, 1, 250)
    : value.latitude !== null || value.longitude !== null || value.radiusKm !== null) throw new TypeError('Invalid aircraft collection coverage');
  return { id: value.id, type: value.type, latitude: value.latitude, longitude: value.longitude, radiusKm: value.radiusKm };
}

const RECORD_FIELDS = ['id', 'reference', 'latitude', 'longitude', 'callsign', 'originCountry', 'positionTimeMs',
  'positionTimeQuality', 'contactTimeMs', 'baroAltitudeM', 'ellipsoidAltitudeM', 'onGround', 'speedMps', 'courseDeg',
  'verticalRateMps', 'verticalRateAltitudeType', 'accuracy', 'category', 'typeCode', 'registration', 'operator'];
function accuracy(value) {
  if (value === null) return null;
  const fields = ['nic', 'rcM', 'nacP', 'nacV', 'sil', 'silType'];
  if (!exact(value, fields) || !nullableNumber(value.rcM, 0, 1000000) ||
      ![[value.nic, 11], [value.nacP, 11], [value.nacV, 4], [value.sil, 3]].every(([item, limit]) => item === null || number(item, 0, limit) && Number.isInteger(item)) ||
      ![null, 'unknown', 'perhour', 'persample'].includes(value.silType)) throw new TypeError('Invalid reported aircraft quality');
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function record(value, { observedAtMs, observedAtSource, collectedAtMs, wallTimeMs }) {
  if (!exact(value, RECORD_FIELDS) || typeof value.id !== 'string' || !/^~?[a-f0-9]{6}$/.test(value.id) || value.reference !== value.id ||
      !number(value.latitude, -90, 90) || !number(value.longitude, -180, 180) ||
      !text(value.callsign, 32) || !(value.originCountry === null || text(value.originCountry, 80)) ||
      !text(value.typeCode, 24) || !text(value.registration, 48) || !text(value.operator, 160) || typeof value.onGround !== 'boolean' ||
      !nullableNumber(value.baroAltitudeM, -1000, 60000) || !nullableNumber(value.ellipsoidAltitudeM, -1000, 60000) ||
      !nullableNumber(value.speedMps, 0, 1500) || !nullableNumber(value.courseDeg, 0, 360) || value.courseDeg === 360 ||
      !nullableNumber(value.verticalRateMps, -500, 500) || ![null, 'geometric', 'barometric'].includes(value.verticalRateAltitudeType) ||
      !['reported', 'unknown'].includes(value.positionTimeQuality) ||
      !(value.category === null || number(value.category, 0, 255) && Number.isInteger(value.category) ||
        typeof value.category === 'string' && /^[A-Z][A-Z0-9]{0,7}$/.test(value.category))) throw new TypeError('Invalid exact normalized aircraft observation');
  const timeLimit = Math.min(observedAtMs ?? 0, collectedAtMs + 5000, wallTimeMs + 5000);
  if (value.positionTimeQuality === 'reported' ? observedAtSource !== 'source' || !number(value.positionTimeMs, 1, timeLimit)
    : value.positionTimeMs !== null) throw new TypeError('Aircraft fix time is not source-qualified');
  if (value.contactTimeMs !== null && (observedAtSource !== 'source' || !number(value.contactTimeMs, 1, timeLimit)))
    throw new TypeError('Aircraft contact time is not source-qualified');
  const normalized = Object.fromEntries(RECORD_FIELDS.map((key) => [key, value[key]]));
  normalized.accuracy = accuracy(value.accuracy);
  return normalized;
}
function sourceState(value, observedAtSource) {
  const fields = ['freshness', 'cache', 'cacheAgeMs', 'ageMs', 'complete', 'rejectedCount'];
  if (!exact(value, fields) || !['current', 'stale', 'unknown'].includes(value.freshness) ||
      !['HIT', 'MISS', 'STALE', 'unknown'].includes(value.cache) ||
      !nullableNumber(value.cacheAgeMs, 0, Number.MAX_SAFE_INTEGER) || !nullableNumber(value.ageMs, 0, Number.MAX_SAFE_INTEGER) ||
      typeof value.complete !== 'boolean' || !number(value.rejectedCount, 0, 100000) || !Number.isInteger(value.rejectedCount) ||
      observedAtSource === 'unknown' && value.freshness === 'current') throw new TypeError('Invalid aircraft source state');
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}

/** Strict factual protocol: receipt clocks and estimated/model coordinates are never admitted as fixes. */
export function canonicalAircraftPacket(value, { now = Date.now } = {}) {
  if (!exact(value, ['schemaVersion', 'source', 'collectedAt', 'scope', 'observedAtMs', 'observedAtSource', 'sourceState', 'records']) ||
      value.schemaVersion !== 1 || value.source !== 'adsb.lol' || !iso(value.collectedAt) || Date.parse(value.collectedAt) > now() + 300000 ||
      !['source', 'unknown'].includes(value.observedAtSource) || !Array.isArray(value.records) || value.records.length > AIRCRAFT_MAX_RECORDS || bytes(value) > AIRCRAFT_MAX_BYTES)
    throw new TypeError('Invalid bounded aircraft collection packet');
  const collectedAtMs = Date.parse(value.collectedAt), wallTimeMs = now();
  if (value.observedAtSource === 'source' ? !number(value.observedAtMs, 1, Math.min(collectedAtMs + 5000, wallTimeMs + 5000))
    : value.observedAtMs !== null) throw new TypeError('Aircraft source epoch is unqualified');
  const records = value.records.map((row) => record(row, { ...value, collectedAtMs, wallTimeMs }));
  if (new Set(records.map((row) => row.id)).size !== records.length) throw new TypeError('Duplicate aircraft identity');
  records.sort((a, b) => ordinal(a.id, b.id));
  return { schemaVersion: 1, source: 'adsb.lol', collectedAt: value.collectedAt, scope: aircraftScope(value.scope),
    observedAtMs: value.observedAtMs, observedAtSource: value.observedAtSource,
    sourceState: sourceState(value.sourceState, value.observedAtSource), records };
}

async function io(task, signal) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(2500), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let abort;
  const rejected = new Promise((_resolve, reject) => { abort = () => reject(new Error('Aircraft storage unavailable')); combined.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => task(combined)), rejected]); }
  finally { combined.removeEventListener('abort', abort); }
}
async function object(bucket, key, limit = AIRCRAFT_MAX_BYTES, signal) {
  const saved = await io(() => bucket.get(key), signal);
  if (!saved) return null;
  if (saved.size > limit) { void saved.body?.cancel().catch(() => {}); throw new Error('Oversized stored aircraft data'); }
  const value = await io((boundedSignal) => saved.body
    ? readResponseJsonCapped(new Response(saved.body, { headers: Number.isFinite(saved.size) ? { 'content-length': String(saved.size) } : {} }), limit, boundedSignal)
    : saved.json(), signal);
  if (bytes(value) > limit) throw new Error('Oversized stored aircraft data');
  return { value, etag: saved.etag };
}
async function serialized(bucket, key, task) {
  let owners = queues.get(bucket); if (!owners) queues.set(bucket, owners = new Map());
  const work = (owners.get(key) || Promise.resolve()).catch(() => {}).then(task);
  owners.set(key, work);
  try { return await work; } finally { if (owners.get(key) === work) owners.delete(key); }
}
async function cas(bucket, key, build, limit = AIRCRAFT_MAX_BYTES) {
  return serialized(bucket, key, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await object(bucket, key, limit), value = await build(previous?.value ?? null);
      if (previous && value === previous.value) return value;
      if (bytes(value) > limit) throw new Error('Prepared aircraft byte limit exceeded');
      const saved = await io(() => bucket.put(key, JSON.stringify(value), {
        onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ 'if-none-match': '*' }),
        httpMetadata: { contentType: 'application/json' },
      }));
      if (saved) return value;
    }
    throw new Error('Prepared aircraft publication conflicted');
  });
}
function catalog(value) {
  if (value === null) return { schemaVersion: 1, scopes: [] };
  if (!exact(value, ['schemaVersion', 'scopes']) || value.schemaVersion !== 1 || !Array.isArray(value.scopes) || value.scopes.length > AIRCRAFT_MAX_SCOPES)
    throw new Error('Invalid aircraft scope index');
  const scopes = value.scopes.map(aircraftScope);
  if (new Set(scopes.map((scope) => scope.id)).size !== scopes.length) throw new Error('Duplicate aircraft scope');
  return { schemaVersion: 1, scopes };
}
export function aircraftDistanceKm(a, b) {
  const radians = Math.PI / 180, dLat = (b.latitude - a.latitude) * radians, dLon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
const inScope = (row, scope) => scope.type === 'military' || aircraftDistanceKm(row, scope) <= scope.radiusKm + 1e-7;
// A repeated acquisition/source clock is not a new factual fix. Its receipt and
// status are kept separately; the immutable capture retains every source epoch.
const facts = (value) => ({ scope: value.scope, records: value.records, history: value.history });
async function prepared(value, expectedScope, now) {
  if (!exact(value, ['schemaVersion', 'source', 'scope', 'snapshotId', 'collectedAt', 'observedAtMs', 'observedAtSource',
    'sourceState', 'sourceStateAt', 'lastCheckedAt', 'records', 'history', 'inputDigest', 'omittedHistoryCount']) ||
      !digest(value.snapshotId) || !digest(value.inputDigest) || !iso(value.lastCheckedAt) || value.sourceStateAt !== value.lastCheckedAt ||
      value.lastCheckedAt < value.collectedAt || Date.parse(value.lastCheckedAt) > now() + 300000 || !Array.isArray(value.history) || value.history.length > AIRCRAFT_MAX_HISTORY ||
      !number(value.omittedHistoryCount, 0, AIRCRAFT_MAX_HISTORY * 2) || !Number.isInteger(value.omittedHistoryCount)) throw new Error('Invalid prepared aircraft observations');
  const packet = canonicalAircraftPacket({ schemaVersion: value.schemaVersion, source: value.source, collectedAt: value.collectedAt, scope: value.scope,
    observedAtMs: value.observedAtMs, observedAtSource: value.observedAtSource, sourceState: value.sourceState, records: value.records }, { now });
  if (JSON.stringify(packet.scope) !== JSON.stringify(expectedScope) || packet.records.some((row) => !inScope(row, expectedScope))) throw new Error('Prepared aircraft coverage mismatch');
  const latest = new Map(packet.records.map((row) => [row.id, row])), perId = new Map(), seen = new Set();
  const history = value.history.map((row) => {
    const admitted = record(row, { ...packet, collectedAtMs: Date.parse(value.collectedAt), wallTimeMs: now() });
    const current = latest.get(row.id), count = (perId.get(row.id) || 0) + 1, key = `${row.id}:${row.positionTimeMs}`;
    if (!current || current.positionTimeQuality !== 'reported' || admitted.positionTimeQuality !== 'reported' ||
        admitted.positionTimeMs >= current.positionTimeMs || !inScope(row, expectedScope) || count > 2 || seen.has(key)) throw new Error('Invalid prepared aircraft history');
    perId.set(row.id, count); seen.add(key); return admitted;
  });
  const canonical = { ...value, ...packet, history };
  if (await hash(facts(canonical)) !== value.inputDigest) throw new Error('Prepared aircraft integrity mismatch');
  return canonical;
}
async function buildWarm(previous, packet, snapshotId, now) {
  const current = previous ? await prepared(previous, packet.scope, now) : null;
  if (current && packet.collectedAt <= current.lastCheckedAt) return previous;
  const nonadvancingSource = current && current.observedAtSource === 'source' &&
    (packet.observedAtSource !== 'source' || packet.observedAtMs <= current.observedAtMs);
  if (nonadvancingSource) return { ...current, sourceState: packet.sourceState,
    sourceStateAt: packet.collectedAt, lastCheckedAt: packet.collectedAt };
  const prior = new Map((current?.records || []).map((row) => [row.id, row]));
  const records = packet.records.filter((row) => inScope(row, packet.scope)).map((incoming) => {
    const old = prior.get(incoming.id);
    if (old?.positionTimeQuality === 'reported' &&
        (incoming.positionTimeQuality !== 'reported' || incoming.positionTimeMs <= old.positionTimeMs)) return old;
    return incoming;
  });
  if (current && JSON.stringify(records) === JSON.stringify(current.records)) return { ...current,
    sourceState: packet.sourceState, sourceStateAt: packet.collectedAt, lastCheckedAt: packet.collectedAt };
  const cutoff = now() - AIRCRAFT_HISTORY_MS, latest = new Map(records.map((row) => [row.id, row]));
  const candidates = [...(current?.history || []), ...(current?.records || []).filter((row) => {
    const next = latest.get(row.id); return row.positionTimeQuality === 'reported' && next?.positionTimeQuality === 'reported' && next.positionTimeMs > row.positionTimeMs;
  })];
  const perId = new Map(), seen = new Set();
  let history = candidates.filter((row) => {
    const next = latest.get(row.id), key = `${row.id}:${row.positionTimeMs}`;
    if (!next || row.positionTimeQuality !== 'reported' || row.positionTimeMs < cutoff || row.positionTimeMs >= next.positionTimeMs || !inScope(row, packet.scope) || seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.positionTimeMs - a.positionTimeMs || ordinal(a.id, b.id)).filter((row) => {
    const count = (perId.get(row.id) || 0) + 1; perId.set(row.id, count); return count <= 2;
  }).slice(0, AIRCRAFT_MAX_HISTORY);
  const candidateCount = history.length;
  let warm = { ...packet, snapshotId, sourceStateAt: packet.collectedAt, lastCheckedAt: packet.collectedAt,
    records, history: [], inputDigest: '0'.repeat(64), omittedHistoryCount: 0 };
  let budget = AIRCRAFT_MAX_BYTES - 8192 - bytes(warm);
  if (budget < 0) throw new TypeError('Aircraft observations leave no bounded response space');
  history = history.filter((row) => { const size = bytes(row) + 1; if (size > budget) return false; budget -= size; return true; });
  history.sort((a, b) => ordinal(a.id, b.id) || a.positionTimeMs - b.positionTimeMs);
  warm = { ...warm, history, omittedHistoryCount: candidateCount - history.length };
  warm.inputDigest = await hash(facts(warm));
  if (current && warm.inputDigest === current.inputDigest) return { ...current,
    sourceState: packet.sourceState, sourceStateAt: packet.collectedAt, lastCheckedAt: packet.collectedAt };
  return warm;
}

/** Caller authenticates the fixed collector action. Every admitted capture is immutable; warm selection is independent. */
export async function publishAircraftObservations(env, input, { now = Date.now } = {}) {
  const packet = canonicalAircraftPacket(input, { now }), scopeId = packet.scope.id;
  if (!configured(env) || !env.EARTH_DB?.prepare) return { configured: false, indexConfigured: Boolean(env.EARTH_DB?.prepare), stored: false, changed: false, scopeId, collectedAt: packet.collectedAt };
  const bucket = env.EARTH_STORE, snapshotId = await hash(packet);
  try {
    await cas(bucket, CATALOG, (previous) => {
      const value = catalog(previous), exists = value.scopes.find((scope) => scope.id === scopeId);
      if (exists && JSON.stringify(exists) !== JSON.stringify(packet.scope)) throw new TypeError('Aircraft scope identity cannot change its coverage');
      if (exists) return previous;
      if (value.scopes.length >= AIRCRAFT_MAX_SCOPES) throw new TypeError('Aircraft scope limit reached');
      return { schemaVersion: 1, scopes: [...value.scopes, packet.scope].sort((a, b) => ordinal(a.id, b.id)) };
    }, 8192);
    const original = await object(bucket, captureKey(snapshotId));
    if (original && await hash(canonicalAircraftPacket(original.value, { now })) !== snapshotId) throw new Error('Aircraft capture integrity mismatch');
    if (!original) {
      const saved = await io(() => bucket.put(captureKey(snapshotId), JSON.stringify(packet), {
        onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' },
      }));
      if (!saved) {
        const winner = await object(bucket, captureKey(snapshotId));
        if (!winner || await hash(canonicalAircraftPacket(winner.value, { now })) !== snapshotId) throw new Error('Aircraft capture was not retained');
      }
    }
    await io(() => env.EARTH_DB.prepare('INSERT INTO earth_aircraft_observations (scope_id, collected_at, snapshot_id, record_count, scope_type, scope_json, observed_at_ms, observed_at_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope_id, collected_at) DO NOTHING')
      .bind(scopeId, packet.collectedAt, snapshotId, packet.records.length, packet.scope.type, JSON.stringify(packet.scope), packet.observedAtMs, packet.observedAtSource).run());
    const indexed = await io(() => primary(env.EARTH_DB).prepare('SELECT snapshot_id FROM earth_aircraft_observations WHERE scope_id = ? AND collected_at = ?').bind(scopeId, packet.collectedAt).first());
    if (indexed?.snapshot_id !== snapshotId) return { configured: true, stored: false, changed: false, conflict: true, scopeId, collectedAt: packet.collectedAt };
    let beforeDigest;
    const warm = await cas(bucket, preparedKey(scopeId), async (previous) => {
      beforeDigest = previous?.inputDigest;
      return buildWarm(previous, packet, snapshotId, now);
    });
    return { configured: true, indexConfigured: true, stored: true, indexed: true, scopeId,
      collectedAt: warm.collectedAt, lastCheckedAt: warm.lastCheckedAt, inputDigest: warm.inputDigest, recordCount: warm.records.length,
      changed: beforeDigest !== warm.inputDigest, superseded: warm.snapshotId !== snapshotId,
      snapshotId, warmSnapshotId: warm.snapshotId, historyCount: warm.history.length };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return { configured: true, indexConfigured: true, stored: false, changed: false, scopeId, collectedAt: packet.collectedAt,
      status: 'partial', failures: ['Durable aircraft publication was unavailable; previous prepared facts remain dated'] };
  }
}

function query(params) {
  for (const key of params.keys()) if (!['lat', 'lon', 'radiusKm', 'military'].includes(key) || params.getAll(key).length !== 1) throw new TypeError('Unknown or repeated aircraft filter');
  if (params.has('military')) {
    if (params.get('military') !== '1' || params.size !== 1) throw new TypeError('Use military=1 without area filters');
    return { type: 'military' };
  }
  if (!['lat', 'lon', 'radiusKm'].every((key) => params.has(key) && params.get(key).trim() !== '') || params.size !== 3) throw new TypeError('An aircraft area and radius are required');
  const value = { type: 'area', latitude: Number(params.get('lat')), longitude: Number(params.get('lon')), radiusKm: Number(params.get('radiusKm')) };
  if (!number(value.latitude, -90, 90) || !number(value.longitude, -180, 180) || !number(value.radiusKm, 1, 250)) throw new TypeError('Invalid aircraft area');
  return value;
}
const failure = (code, coverageScopes = []) => json({ schemaVersion: 1, source: 'adsb.lol', prepared: false, available: false,
  code, records: [], history: [], coverageScopes, complete: false, stale: true, freshness: 'unknown',
  note: 'Only explicitly collected receiver scopes can supply prepared observations; no upstream request is triggered.' }, 503);

/** Prepared-only public startup read. Geographic coverage applies independently to latest and earlier factual fixes. */
export async function handleAircraftObservations(request, env, { now = Date.now } = {}) {
  const url = new URL(request.url); if (url.pathname !== '/api/aircraft/observations') return null;
  if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
  let requested; try { requested = query(url.searchParams); } catch (error) { return json({ error: error.message }, 400); }
  if (!configured(env)) return failure('not-configured');
  try {
    const saved = await object(env.EARTH_STORE, CATALOG, 8192, request.signal);
    if (!saved) return failure('unavailable');
    const scopes = catalog(saved.value).scopes, candidates = scopes.filter((scope) => scope.type === requested.type &&
      (scope.type === 'military' || aircraftDistanceKm(scope, requested) + requested.radiusKm <= scope.radiusKm + 1e-7))
      .sort((a, b) => (a.radiusKm || 0) - (b.radiusKm || 0) || ordinal(a.id, b.id));
    if (!candidates.length) return failure('not-covered');
    for (const scope of candidates) {
      const item = await object(env.EARTH_STORE, preparedKey(scope.id), AIRCRAFT_MAX_BYTES, request.signal);
      if (!item) continue;
      const warm = await prepared(item.value, scope, now), current = now(), captureAgeMs = Math.max(0, current - Date.parse(warm.collectedAt));
      if (captureAgeMs > RETAIN_MS) continue;
      const records = warm.records.filter((row) => inScope(row, requested)), ids = new Set(records.map((row) => row.id));
      const history = warm.history.filter((row) => ids.has(row.id) && row.positionTimeMs >= current - AIRCRAFT_HISTORY_MS && row.positionTimeMs <= current && inScope(row, requested));
      const checkAge = Math.max(0, current - Date.parse(warm.sourceStateAt));
      const reportedAge = warm.sourceState.ageMs === null ? null : warm.sourceState.ageMs + checkAge;
      const sourceAgeMs = warm.observedAtSource === 'source' ? Math.max(0, current - warm.observedAtMs, reportedAge || 0) : reportedAge;
      const qualified = records.filter((row) => row.positionTimeQuality === 'reported');
      const noRecentFix = qualified.length > 0 && qualified.every((row) => current - row.positionTimeMs > AIRCRAFT_HISTORY_MS);
      const stale = warm.sourceState.freshness === 'stale' || warm.sourceState.cache === 'STALE' || captureAgeMs > FRESH_MS || sourceAgeMs !== null && sourceAgeMs > FRESH_MS || noRecentFix;
      const freshness = stale ? 'stale' : warm.observedAtSource !== 'source' || warm.sourceState.freshness === 'unknown' || records.length > 0 && !qualified.length ? 'unknown' : 'current';
      const payload = { schemaVersion: 1, source: 'adsb.lol', prepared: true, available: true, delivery: 'prepared-aircraft-observations',
        records, history, collectedAt: warm.collectedAt, lastCheckedAt: warm.lastCheckedAt, observedAtMs: warm.observedAtMs,
        observedAtSource: warm.observedAtSource, sourceState: warm.sourceState, sourceAgeMs, ageMs: sourceAgeMs, captureAgeMs,
        cacheAgeMs: warm.sourceState.cacheAgeMs === null ? null : warm.sourceState.cacheAgeMs + checkAge, stale, freshness,
        coverageScopes: [scope], coverage: scope.type === 'military' ? 'Collected public military receiver subset; worldwide completeness is not asserted.'
          : `Collected receiver observations within ${scope.radiusKm} km of ${scope.latitude}, ${scope.longitude}; requested area is wholly inside this scope.`,
        complete: false, sourceComplete: warm.sourceState.complete, rejectedCount: warm.sourceState.rejectedCount,
        inputDigest: warm.inputDigest, omittedHistoryCount: warm.omittedHistoryCount,
        note: 'Exact reported observations and source times only. Acquisition freshness is separate from fix age; earlier history contains at most two qualified fixes per identity within 90 seconds. No historical positions or forecasts are synthesized.' };
      if (bytes(payload) > AIRCRAFT_MAX_BYTES) throw new Error('Aircraft response limit exceeded');
      return json(payload, 200, { 'cache-control': 'public, max-age=5', 'x-feed-cache': stale ? 'STALE' : 'HIT',
        ...(sourceAgeMs === null ? {} : { 'x-feed-age-ms': String(sourceAgeMs) }) });
    }
    return failure('unavailable');
  } catch { return failure('unavailable'); }
}
