import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { groupReports } from '../src/core/intelligence-grouping.js';

export const HISTORY_MAX_SOURCES = 20;
export const HISTORY_MAX_OBSERVATIONS = 1200;
export const HISTORY_MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const PREPARED_INTELLIGENCE_KEY = 'collection/current-intelligence.json';
const CATALOG_KEY = 'history/sources.json', IO_TIMEOUT_MS = 2500, MAX_AGE_MS = 86400000;
const queues = new WeakMap();
const encoded = (value) => new TextEncoder().encode(JSON.stringify(value));
const sourceId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const digestId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const configured = (env) => Boolean(env?.EARTH_STORE?.get && env?.EARTH_STORE?.put);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} });

function iso(value) {
  const parts = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) throw new TypeError('Use an ISO timestamp');
  const fields = parts.slice(1, 7).map(Number), wall = new Date(0);
  wall.setUTCFullYear(fields[0], fields[1] - 1, fields[2]); wall.setUTCHours(fields[3], fields[4], fields[5], 0);
  if ([wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()]
    .some((value, i) => value !== fields[i])) throw new TypeError('Use a valid ISO calendar date');
  return new Date(value).toISOString();
}

async function io(task) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('History storage deadline exceeded')), IO_TIMEOUT_MS);
  })]); } finally { clearTimeout(timer); }
}

async function objectJson(bucket, key, maximum = HISTORY_MAX_SNAPSHOT_BYTES) {
  const object = await io(() => bucket.get(key));
  if (!object) return null;
  if (Number.isFinite(object.size) && object.size > maximum) { await object.body?.cancel(); throw new Error('Oversized history object'); }
  const value = await io(() => object.json());
  if (encoded(value).byteLength > maximum) throw new Error('Oversized history object');
  return { value, etag: object.etag };
}

async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const factsHash = (snapshot) => hash({ ...snapshot,
  records: snapshot.records.map(({ retrievedAt: _retrievedAt, ...facts }) => facts),
});

async function serialized(bucket, key, task) {
  let queue = queues.get(bucket); if (!queue) queues.set(bucket, queue = new Map());
  const work = (queue.get(key) || Promise.resolve()).catch(() => {}).then(task);
  queue.set(key, work);
  try { return await work; } finally { if (queue.get(key) === work) queue.delete(key); }
}

async function conditionalUpdate(bucket, key, update) {
  return serialized(bucket, key, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await objectJson(bucket, key);
      const value = await update(previous?.value ?? null);
      if (previous && value === previous.value) return value;
      if (encoded(value).byteLength > HISTORY_MAX_SNAPSHOT_BYTES) throw new Error('History manifest exceeded its bound');
      const saved = await io(() => bucket.put(key, JSON.stringify(value), {
        onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ 'if-none-match': '*' }),
        httpMetadata: { contentType: 'application/json' },
      }));
      if (saved !== null) return value;
    }
    throw new Error('History manifest contention; retry the same observation');
  });
}

function canonicalSnapshot(source, records, coordinates = []) {
  if (!sourceId(source) || !Array.isArray(records) || records.length > 500 || !Array.isArray(coordinates) || coordinates.length > 100)
    throw new TypeError('Invalid history snapshot bounds');
  const canonical = records.map(canonicalDiscoveryRecord);
  if (canonical.some((record) => !record || record.sourceId !== source) || new Set(canonical.map((record) => record.id)).size !== canonical.length)
    throw new TypeError('Invalid history report provenance');
  if (canonical.some((record) => source === 'usgs' && !/^https:\/\/earthquake\.usgs\.gov\//.test(record.url) ||
      source === 'gdacs' && !/^https:\/\/(?:www\.)?gdacs\.org\//.test(record.url))) throw new TypeError('Invalid official hazard source URL');
  canonical.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(canonical.map((record) => record.id)), seen = new Set();
  const points = coordinates.map((point) => {
    if (source !== 'usgs' || !ids.has(point?.id) || seen.has(point.id) || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) ||
        Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) throw new TypeError('Only identified USGS source coordinates are permitted');
    seen.add(point.id); return { id: point.id, lat: point.lat, lon: point.lon };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const value = { schemaVersion: 1, source, records: canonical, coordinates: points };
  if (encoded(value).byteLength > HISTORY_MAX_SNAPSHOT_BYTES) throw new TypeError('History snapshot exceeded its byte limit');
  return value;
}

function observation(value, expectedSource) {
  if (!value || !sourceId(value.source) || expectedSource && value.source !== expectedSource || !digestId(value.id) ||
      !Number.isSafeInteger(value.recordCount) || value.recordCount < 0 || value.recordCount > 500) throw new Error('Invalid history observation');
  const at = iso(value.at);
  return { at, id: value.id, source: value.source, recordCount: value.recordCount };
}

function manifest(value, source) {
  if (!value) return { schemaVersion: 1, source, firstAt: null, lastAt: null, snapshots: [] };
  if (value.schemaVersion !== 1 || value.source !== source || !Array.isArray(value.snapshots) || value.snapshots.length > HISTORY_MAX_OBSERVATIONS)
    throw new Error('Invalid source history manifest');
  const snapshots = value.snapshots.map((entry) => observation(entry, source));
  if (snapshots.some((entry, i) => i && entry.at <= snapshots[i - 1].at)) throw new Error('History observations must be chronological');
  const firstAt = value.firstAt === null ? null : iso(value.firstAt), lastAt = value.lastAt === null ? null : iso(value.lastAt);
  if (snapshots.length && (firstAt > snapshots[0].at || lastAt !== snapshots.at(-1).at)) throw new Error('Invalid history coverage');
  return { schemaVersion: 1, source, firstAt, lastAt, snapshots };
}

function catalog(value) {
  if (!value) return { schemaVersion: 1, sources: [] };
  if (value.schemaVersion !== 1 || !Array.isArray(value.sources) || value.sources.length > HISTORY_MAX_SOURCES) throw new Error('Invalid history source catalog');
  const sources = value.sources.map((entry) => {
    if (!sourceId(entry?.id)) throw new Error('Invalid history source identity');
    const firstAt = iso(entry.firstAt), lastAt = iso(entry.lastAt);
    if (firstAt > lastAt) throw new Error('Invalid history source coverage');
    return { id: entry.id, firstAt, lastAt };
  });
  if (new Set(sources.map((entry) => entry.id)).size !== sources.length) throw new Error('Duplicate history source');
  return { schemaVersion: 1, sources };
}

/** Immutable content and check journals, atomic recent manifests, and an optional full D1 time index. */
export async function appendHistorySnapshot(env, { source, at, records, coordinates = [] }, { now = Date.now } = {}) {
  if (!configured(env)) return { configured: false, stored: false };
  at = iso(at);
  if (Date.parse(at) > now() + 300000) throw new TypeError('History check is future-dated');
  const bucket = env.EARTH_STORE, snapshot = canonicalSnapshot(source, records, coordinates), id = await factsHash(snapshot);
  const sources = catalog((await objectJson(bucket, CATALOG_KEY))?.value);
  if (!sources.sources.some((entry) => entry.id === source) && sources.sources.length >= HISTORY_MAX_SOURCES) throw new Error('History source limit reached');
  const entry = { at, id, source, recordCount: snapshot.records.length };
  // Unchanged facts reuse the first retained source retrieval dates. Observation checks remain separately indexed.
  const snapshotKey = `history/snapshots/${source}/${id}.json`;
  const existing = await io(() => bucket.head ? bucket.head(snapshotKey) : bucket.get(snapshotKey));
  await existing?.body?.cancel();
  const snapshotBody = existing ? null : JSON.stringify({ ...snapshot, bodySha256: await hash(snapshot) });
  const content = existing ? null : await io(() => bucket.put(snapshotKey, snapshotBody, {
    onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' },
  }));
  await io(() => bucket.put(`history/observations/${source}/${at.replace(/[:.]/g, '-')}_${id}.json`, JSON.stringify(entry), {
    onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' },
  }));
  const updated = await conditionalUpdate(bucket, `history/manifests/${source}.json`, (previous) => {
    const value = manifest(previous, source), collision = value.snapshots.find((row) => row.at === at);
    if (collision && collision.id !== id) throw new Error('Observation time already references different content');
    const snapshots = [...value.snapshots.filter((row) => row.at !== at), entry].sort((a, b) => a.at.localeCompare(b.at));
    return { schemaVersion: 1, source, firstAt: value.firstAt && value.firstAt < at ? value.firstAt : at,
      lastAt: snapshots.at(-1).at, snapshots: snapshots.slice(-HISTORY_MAX_OBSERVATIONS) };
  });
  await conditionalUpdate(bucket, CATALOG_KEY, (previous) => {
    const value = catalog(previous), present = value.sources.find((entry) => entry.id === source);
    // Current last-check dates already live in the source manifest and D1. The catalog only discovers sources.
    if (present && present.firstAt <= updated.firstAt) return previous;
    const entries = value.sources.filter((entry) => entry.id !== source);
    if (entries.length >= HISTORY_MAX_SOURCES) throw new Error('History source limit reached');
    entries.push({ id: source, firstAt: updated.firstAt, lastAt: updated.lastAt });
    return { schemaVersion: 1, sources: entries.sort((a, b) => a.id.localeCompare(b.id)) };
  });
  let indexed = false;
  if (env.EARTH_DB?.prepare) {
    await io(() => env.EARTH_DB.prepare('INSERT INTO earth_observations (source, at, snapshot_id, record_count) VALUES (?, ?, ?, ?) ON CONFLICT(source, at) DO NOTHING')
      .bind(source, at, id, entry.recordCount).run());
    const row = await io(() => env.EARTH_DB.prepare('SELECT snapshot_id FROM earth_observations WHERE source = ? AND at = ?').bind(source, at).first());
    if (row?.snapshot_id !== id) throw new Error('Observation database collision or incomplete index write');
    indexed = true;
  }
  return { configured: true, stored: true, indexed, ...entry, existingSnapshot: content === null };
}

async function databaseRows(db, sql, values = []) {
  const result = await io(() => db.prepare(sql).bind(...values).all());
  if (!Array.isArray(result?.results)) throw new Error('Invalid observation database response');
  return result.results;
}

async function historyRows(env, { at, from, to, limit }) {
  if (env.EARTH_DB?.prepare) {
    try {
      const summary = await databaseRows(env.EARTH_DB, 'SELECT source, MIN(at) AS first_at, MAX(at) AS last_at, COUNT(*) AS observations FROM earth_observations GROUP BY source ORDER BY source LIMIT 21');
      if (summary.length > HISTORY_MAX_SOURCES) throw new Error('History source limit exceeded');
      const sources = summary.map((row) => {
        if (!sourceId(row.source) || !Number.isSafeInteger(row.observations) || row.observations < 1) throw new Error('Invalid database source summary');
        return { id: row.source, firstAt: iso(row.first_at), lastAt: iso(row.last_at), observations: row.observations };
      });
      const rows = at ? await databaseRows(env.EARTH_DB,
        'SELECT o.source, o.at, o.snapshot_id, o.record_count FROM earth_observations o JOIN (SELECT source, MAX(at) AS at FROM earth_observations WHERE at <= ? GROUP BY source) latest ON o.source = latest.source AND o.at = latest.at ORDER BY o.source LIMIT 21', [at]) :
        await databaseRows(env.EARTH_DB, 'SELECT source, at, snapshot_id, record_count FROM earth_observations WHERE at >= ? AND at <= ? ORDER BY at DESC, source ASC LIMIT ?', [from || '0000-01-01T00:00:00.000Z', to || '9999-12-31T23:59:59.999Z', limit]);
      if (rows.length > (at ? HISTORY_MAX_SOURCES : limit)) throw new Error('History query exceeds its bound');
      return { sources, snapshots: rows.map((row) => observation({ source: row.source, at: row.at, id: row.snapshot_id, recordCount: row.record_count })), indexMode: 'd1-full-history' };
    } catch { /* The durable recent R2 index remains explicitly limited during a database outage. */ }
  }
  const sources = catalog((await objectJson(env.EARTH_STORE, CATALOG_KEY))?.value).sources;
  const manifests = await Promise.all(sources.map(async (source) => manifest((await objectJson(env.EARTH_STORE, `history/manifests/${source.id}.json`))?.value, source.id)));
  const snapshots = at ? manifests.flatMap((value) => value.snapshots.filter((entry) => entry.at <= at).slice(-1)) :
    manifests.flatMap((value) => value.snapshots).filter((entry) => (!from || entry.at >= from) && (!to || entry.at <= to))
      .sort((a, b) => b.at.localeCompare(a.at) || a.source.localeCompare(b.source)).slice(0, limit);
  return { sources: sources.map((entry, i) => ({ ...entry, firstAt: manifests[i].firstAt || entry.firstAt, lastAt: manifests[i].lastAt || entry.lastAt,
    availableFrom: manifests[i].snapshots[0]?.at || null, retainedObservations: manifests[i].snapshots.length })),
    snapshots, indexMode: 'r2-recent-history', indexWarning: 'Recent index retains at most 1200 observations per source; full historical range queries require the durable database index.' };
}

/** Read-only endpoint. A selected time means what had actually been collected by then. */
export function createHistoryHandler({ env = {}, now = Date.now } = {}) {
  return async (request) => {
    const url = new URL(request.url); if (url.pathname !== '/api/history') return null;
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    let at, from, to, limit = HISTORY_MAX_OBSERVATIONS;
    try {
      for (const key of url.searchParams.keys()) if (!['at', 'from', 'to', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError('Unknown or repeated history filter');
      at = url.searchParams.has('at') ? iso(url.searchParams.get('at')) : null;
      from = url.searchParams.has('from') ? iso(url.searchParams.get('from')) : null;
      to = url.searchParams.has('to') ? iso(url.searchParams.get('to')) : null;
      if (at && (from || to) || from && to && from > to) throw new TypeError('Use a single selected time or an ordered range');
      if (at && Date.parse(at) > now() + 300000) throw new TypeError('Selected time is in the future');
      if (url.searchParams.has('limit')) {
        if (!/^[1-9]\d{0,3}$/.test(url.searchParams.get('limit'))) throw new TypeError('Invalid history limit');
        limit = Number(url.searchParams.get('limit')); if (limit > HISTORY_MAX_OBSERVATIONS) throw new TypeError('History limit exceeds 1200');
      }
    } catch (error) { return json({ error: error.message }, 400); }
    if (!configured(env)) return json({ configured: false, firstAt: null, lastAt: null, snapshots: [], sources: [], reports: [], coordinates: [], reason: 'Durable history storage is not configured' });
    try {
      const rows = await historyRows(env, { at, from, to, limit }), firstAt = rows.sources.map((entry) => entry.firstAt).sort()[0] || null,
        lastAt = rows.sources.map((entry) => entry.lastAt).sort().at(-1) || null;
      const payload = { configured: true, firstAt, lastAt, ...rows, selectedAt: at,
        note: 'Collection check times describe retained evidence availability. Content snapshots retain their first captured retrieval dates; later unchanged checks do not create or retime facts. Source observation and indexing dates remain unchanged. No history before collection is reconstructed.' };
      if (at) {
        const selected = await Promise.all(rows.snapshots.map(async (entry) => {
          const object = await objectJson(env.EARTH_STORE, `history/snapshots/${entry.source}/${entry.id}.json`);
          if (!object) throw new Error('Selected snapshot is missing');
          const snapshot = canonicalSnapshot(entry.source, object.value.records, object.value.coordinates);
          if (await factsHash(snapshot) !== entry.id || !digestId(object.value.bodySha256) || await hash(snapshot) !== object.value.bodySha256 ||
              snapshot.records.length !== entry.recordCount) throw new Error('Selected snapshot failed integrity validation');
          return snapshot;
        }));
        const reports = selected.flatMap((entry) => entry.records), coordinates = selected.flatMap((entry) => entry.coordinates);
        payload.reports = reports.slice(0, 2000); payload.omittedRecords = Math.max(0, reports.length - 2000); payload.coordinates = coordinates;
      }
      return json(payload);
    } catch { return json({ error: 'Durable history is temporarily unavailable; no synthetic history is substituted' }, 503); }
  };
}

function preparedPayload(payload) {
  if (!payload || !Array.isArray(payload.indexRecords) || payload.indexRecords.length > 500 || !Array.isArray(payload.sources) || payload.sources.length > HISTORY_MAX_SOURCES)
    throw new Error('Invalid prepared intelligence bounds');
  const records = payload.indexRecords.map(canonicalDiscoveryRecord);
  if (records.some((record) => !record) || payload.sources.some((source) => !sourceId(source?.id)) || new Set(payload.sources.map((source) => source.id)).size !== payload.sources.length)
    throw new Error('Invalid prepared intelligence provenance');
  const value = { ...payload, indexRecords: records, reports: groupReports(records, 80), filters: { category: 'all', country: '', countryName: '', q: '' } };
  if (encoded(value).byteLength > HISTORY_MAX_SNAPSHOT_BYTES) throw new Error('Prepared intelligence exceeds its byte limit');
  return value;
}

export class PreparedBaselineConflict extends Error {}

export async function writePreparedIntelligence(env, payload, { now = Date.now, matchesBaseline } = {}) {
  if (!configured(env)) return { configured: false, stored: false };
  const value = { schemaVersion: 1, collectedAt: new Date(now()).toISOString(), payload: preparedPayload(payload) };
  const stored = await conditionalUpdate(env.EARTH_STORE, PREPARED_INTELLIGENCE_KEY, async (previous) => {
    if (matchesBaseline && !await matchesBaseline(previous?.payload)) throw new PreparedBaselineConflict('Prepared baseline changed');
    return previous?.schemaVersion === 1 && iso(previous.collectedAt) > value.collectedAt ? previous : value;
  });
  return { configured: true, stored: true, collectedAt: stored.collectedAt };
}

export async function readPreparedIntelligence(env, { now = Date.now } = {}) {
  if (!configured(env)) return null;
  try {
    const saved = (await objectJson(env.EARTH_STORE, PREPARED_INTELLIGENCE_KEY))?.value;
    if (saved?.schemaVersion !== 1) return null;
    const collectedAt = iso(saved.collectedAt), ageMs = now() - Date.parse(collectedAt);
    if (ageMs < -300000 || ageMs > MAX_AGE_MS) return null;
    return { payload: preparedPayload(saved.payload), collectedAt, ageMs: Math.max(0, ageMs), stale: ageMs >= 60000,
      expiresAt: new Date(Date.parse(collectedAt) + MAX_AGE_MS).toISOString() };
  } catch { return null; }
}
