import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { WORLD_MODEL_LIMITS, WORLD_MODEL_NOTE, WORLD_HISTORY_NOTE, WORLD_SOURCE_IDS, worldTime, isWorldDigest,
  worldHash, worldRevision, createWorldSourceItem, provisionalWorldEvent } from '../src/core/world-model.js';

const SOURCES = new Set(WORLD_SOURCE_IDS), IO_TIMEOUT_MS = 2500, ready = new WeakSet(), ROOT_DB = Symbol('world-schema-binding');
const PUBLICATION_FUTURE_MS = WORLD_MODEL_LIMITS.collectionFutureMs + WORLD_MODEL_LIMITS.publicationClockSkewMs;
const encodedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const configured = (env) => Boolean(env?.EARTH_STORE?.get && env?.EARTH_DB?.prepare && env?.EARTH_DB?.batch);
const unavailable = () => ({ configured: false, available: false, reason: 'The world evidence index or its migration is not available' });
const primaryEnv = (env) => env?.EARTH_DB?.withSession ? { ...env, [ROOT_DB]: env[ROOT_DB] || env.EARTH_DB,
  EARTH_DB: env.EARTH_DB.withSession('first-primary') } : env;
function retainedTime(value) { try { return worldTime(value); } catch { throw new Error('Invalid retained world timestamp'); } }

async function io(task) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('World evidence storage deadline exceeded')), IO_TIMEOUT_MS);
  })]); } finally { clearTimeout(timer); }
}
async function rows(db, sql, values = []) {
  const result = await io(() => db.prepare(sql).bind(...values).all());
  if (!Array.isArray(result?.results)) throw new Error('Invalid world evidence index response');
  return result.results;
}
async function ensureSchema(env) {
  if (!configured(env)) return false;
  const schemaBinding = env[ROOT_DB] || env.EARTH_DB;
  if (ready.has(schemaBinding)) return true;
  try {
    const results = await io(() => env.EARTH_DB.batch([
      env.EARTH_DB.prepare(`SELECT item_id, revision, source_id, source_record_id, snapshot_id, first_captured_at,
        first_recorded_at, event_id, event_at, projection_json FROM earth_world_revisions LIMIT 0`),
      env.EARTH_DB.prepare('SELECT item_id, captured_at, revision, recorded_at FROM earth_world_observations LIMIT 0'),
      env.EARTH_DB.prepare('SELECT source_id, snapshot_id, captured_at, recorded_at FROM earth_world_sources LIMIT 0'),
      env.EARTH_DB.prepare(`SELECT source_id, captured_at, snapshot_id, recorded_at FROM earth_world_captures
        INDEXED BY earth_world_captures_source_recorded_capture LIMIT 0`),
    ]));
    if (!Array.isArray(results) || results.length !== 4 || results.some((result) => result?.success === false || !Array.isArray(result?.results))) return false;
    ready.add(schemaBinding); return true;
  } catch { return false; }
}

/** Existing R2 source snapshots are the body authority. No world-model R2 writes. */
async function snapshot(env, source, id) {
  if (!SOURCES.has(source) || !isWorldDigest(id)) throw new TypeError('Invalid immutable evidence reference');
  const object = await io(() => env.EARTH_STORE.get(`history/snapshots/${source}/${id}.json`));
  if (!object) throw new Error('Retained source evidence is missing');
  if (Number.isFinite(object.size) && object.size > WORLD_MODEL_LIMITS.snapshotBytes) { await object.body?.cancel?.(); throw new Error('Source evidence exceeds its byte limit'); }
  const value = await io(() => object.json());
  if (encodedBytes(value) > WORLD_MODEL_LIMITS.snapshotBytes || value?.schemaVersion !== 1 || value.source !== source ||
      !Array.isArray(value.records) || value.records.length > WORLD_MODEL_LIMITS.records || !Array.isArray(value.coordinates) || value.coordinates.length > 100)
    throw new Error('Invalid retained source evidence');
  const records = value.records.map(canonicalDiscoveryRecord);
  if (records.some((record) => !record || record.sourceId !== source) || new Set(records.map((record) => record.id)).size !== records.length)
    throw new Error('Invalid retained source identity');
  records.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(records.map((record) => record.id)), seen = new Set();
  const coordinates = value.coordinates.map((point) => {
    if (source !== 'usgs' || !ids.has(point?.id) || seen.has(point.id) || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 ||
        !Number.isFinite(point.lon) || Math.abs(point.lon) > 180) throw new Error('Invalid retained source geometry');
    seen.add(point.id); return { id: point.id, lat: point.lat, lon: point.lon };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const body = { schemaVersion: 1, source, records, coordinates };
  const facts = { ...body, records: records.map(({ retrievedAt: _retrievedAt, ...record }) => record) };
  if (await worldHash(facts) !== id || !isWorldDigest(value.bodySha256) || await worldHash(body) !== value.bodySha256)
    throw new Error('Retained source evidence failed integrity validation');
  return body;
}

function captureInput(packet, snapshots, now) {
  if (packet?.schemaVersion !== 1 || !Array.isArray(packet.payload?.indexRecords) || packet.payload.indexRecords.length > WORLD_MODEL_LIMITS.records ||
      !Array.isArray(snapshots) || snapshots.length > WORLD_MODEL_LIMITS.sources) throw new TypeError('Use a bounded accepted collection');
  const capturedAt = worldTime(packet.collectedAt);
  if (Date.parse(capturedAt) > now() + WORLD_MODEL_LIMITS.collectionFutureMs) throw new TypeError('Collection capture is future-dated');
  const seen = new Set();
  const captures = snapshots.map((capture) => {
    if (!SOURCES.has(capture?.source) || seen.has(capture.source) || !isWorldDigest(capture.id) || worldTime(capture.at) !== capturedAt ||
        capture.stored !== true || capture.indexed !== true || !Number.isInteger(capture.recordCount) || capture.recordCount < 0 || capture.recordCount > WORLD_MODEL_LIMITS.records)
      throw new TypeError('A durable source-history observation is required');
    seen.add(capture.source); return capture;
  });
  if (captures.reduce((sum, capture) => sum + capture.recordCount, 0) > WORLD_MODEL_LIMITS.records)
    throw new TypeError('Retained source captures exceed the collection item budget');
  return { capturedAt, captures };
}

const eventCountFor = (body) => body.records.filter((record) => record.sourceId === 'usgs' && record.eventType === 'EQ' &&
  Number.isFinite(record.lat) && Number.isFinite(record.lon)).length;

function jsonGroups(values) {
  const groups = []; let group = [], bytes = 2;
  for (const value of values) {
    const size = encodedBytes(value);
    if (size + 2 > WORLD_MODEL_LIMITS.sqlJsonBytes) throw new Error('A world index item exceeds its bounded SQL payload');
    if (bytes + size + (group.length ? 1 : 0) > WORLD_MODEL_LIMITS.sqlJsonBytes) {
      groups.push(group); group = []; bytes = 2;
    }
    bytes += size + (group.length ? 1 : 0); group.push(value);
  }
  if (group.length) groups.push(group);
  return groups;
}
function boundedJson(values) {
  const value = JSON.stringify(values);
  if (new TextEncoder().encode(value).byteLength > WORLD_MODEL_LIMITS.sqlJsonBytes) throw new Error('SQL input exceeds its byte budget');
  return value;
}
const references = (items) => boundedJson(items.map(({ itemId, revision, capturedAt }) => ({ itemId, revision, capturedAt })));

async function sourceStates(db, inputs) {
  return rows(db, `SELECT json_extract(i.value, '$.sourceId') AS source_id,
    h.snapshot_id AS history_id, h.record_count AS history_count, s.snapshot_id AS previous_id, s.captured_at AS previous_at,
    c.snapshot_id AS receipt_id, c.recorded_at AS receipt_at FROM json_each(?) i
    LEFT JOIN earth_observations h ON h.source = json_extract(i.value, '$.sourceId') AND h.at = json_extract(i.value, '$.capturedAt')
    LEFT JOIN earth_world_sources s ON s.source_id = json_extract(i.value, '$.sourceId')
    LEFT JOIN earth_world_captures c ON c.source_id = json_extract(i.value, '$.sourceId') AND c.captured_at = json_extract(i.value, '$.capturedAt')`,
  [boundedJson(inputs)]);
}

async function retainItemGroup(db, part) {
  const input = references(part);
  const retained = await rows(db, `SELECT r.item_id, r.revision, (SELECT o.revision FROM earth_world_observations o
    WHERE o.item_id = r.item_id AND o.captured_at <= json_extract(i.value, '$.capturedAt')
    ORDER BY o.captured_at DESC LIMIT 1) AS latest_revision FROM json_each(?) i
    JOIN earth_world_revisions r ON r.item_id = json_extract(i.value, '$.itemId') AND r.revision = json_extract(i.value, '$.revision')`, [input]);
  const existing = new Map(retained.map((row) => [`${row.item_id}/${row.revision}`, row]));
  const additions = part.filter((item) => !existing.has(`${item.itemId}/${item.revision}`));
  const observations = part.filter((item) => existing.get(`${item.itemId}/${item.revision}`)?.latest_revision !== item.revision);
  const statements = [];
  if (additions.length) statements.push(db.prepare(`INSERT INTO earth_world_revisions
    (item_id, revision, source_id, source_record_id, snapshot_id, first_captured_at, first_recorded_at, event_id, event_at, projection_json)
    SELECT json_extract(i.value, '$.itemId'), json_extract(i.value, '$.revision'), json_extract(i.value, '$.sourceId'),
      json_extract(i.value, '$.sourceRecordId'), json_extract(i.value, '$.snapshotId'), json_extract(i.value, '$.capturedAt'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_extract(i.value, '$.eventId'), json_extract(i.value, '$.eventAt'),
      json_set(json_extract(i.value, '$.projection'), '$.knowledge.firstRecordedAt', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      FROM json_each(?) i WHERE 1 ON CONFLICT(item_id, revision) DO NOTHING`).bind(boundedJson(additions)));
  if (observations.length) statements.push(db.prepare(`INSERT INTO earth_world_observations (item_id, captured_at, revision, recorded_at)
    SELECT json_extract(i.value, '$.itemId'), json_extract(i.value, '$.capturedAt'), json_extract(i.value, '$.revision'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM json_each(?) i WHERE 1 ON CONFLICT(item_id, captured_at) DO NOTHING`).bind(references(observations)));
  let revisionCount = 0;
  if (statements.length) {
    const results = await io(() => db.batch(statements));
    if (!Array.isArray(results) || results.length !== statements.length || results.some((result) => result?.success === false))
      throw new Error('A bounded world revision batch failed');
    revisionCount = additions.length ? Number(results[0].meta?.changes) || 0 : 0;
  }
  const verified = await rows(db, `SELECT r.source_id, r.source_record_id, r.item_id, r.revision, o.revision AS captured_revision
    FROM json_each(?) i JOIN earth_world_revisions r ON r.item_id = json_extract(i.value, '$.itemId') AND r.revision = json_extract(i.value, '$.revision')
    LEFT JOIN earth_world_observations o ON o.item_id = r.item_id AND o.captured_at = json_extract(i.value, '$.capturedAt')`, [input]);
  const verifiedItems = new Map(verified.map((row) => [`${row.item_id}/${row.revision}`, row]));
  const changed = new Set(observations.map((item) => item.itemId));
  for (const item of part) {
    const saved = verifiedItems.get(`${item.itemId}/${item.revision}`);
    if (!saved || saved.source_id !== item.sourceId || saved.source_record_id !== item.sourceRecordId ||
        changed.has(item.itemId) && saved.captured_revision !== item.revision) throw new Error('An item revision conflicts or was not retained');
  }
  return revisionCount;
}

async function publishCaptures(db, inputs) {
  const input = boundedJson(inputs);
  const results = await io(() => db.batch([
    db.prepare(`INSERT INTO earth_world_captures (source_id, captured_at, snapshot_id, recorded_at)
      SELECT json_extract(i.value, '$.sourceId'), json_extract(i.value, '$.capturedAt'), json_extract(i.value, '$.snapshotId'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM json_each(?) i
      WHERE json_extract(i.value, '$.capturedAt') <= strftime('%Y-%m-%dT%H:%M:%fZ','now','+${PUBLICATION_FUTURE_MS / 1000} seconds')
      ON CONFLICT(source_id, captured_at) DO NOTHING`).bind(input),
    db.prepare(`INSERT INTO earth_world_sources (source_id, snapshot_id, captured_at, recorded_at)
      SELECT c.source_id, c.snapshot_id, c.captured_at, c.recorded_at FROM json_each(?) i JOIN earth_world_captures c
        ON c.source_id = json_extract(i.value, '$.sourceId') AND c.captured_at = json_extract(i.value, '$.capturedAt')
          AND c.snapshot_id = json_extract(i.value, '$.snapshotId') WHERE 1
      ON CONFLICT(source_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, captured_at = excluded.captured_at, recorded_at = excluded.recorded_at
      WHERE excluded.captured_at > earth_world_sources.captured_at`).bind(input),
  ]));
  if (!Array.isArray(results) || results.length !== 2 || results.some((result) => result?.success === false)) throw new Error('World projection publication failed');
  const saved = new Map((await sourceStates(db, inputs)).map((row) => [row.source_id, row]));
  for (const capture of inputs) {
    const state = saved.get(capture.sourceId);
    if (state?.receipt_id !== capture.snapshotId || !state.previous_at || state.previous_at < capture.capturedAt ||
        state.previous_at === capture.capturedAt && state.previous_id !== capture.snapshotId) throw new Error('World publication was incomplete or conflicting');
  }
}

/** Call only after authenticated collection and successful source-history publication. */
export async function projectWorldCollection(env, { packet, snapshots } = {}, { now = Date.now } = {}) {
  const { capturedAt, captures } = captureInput(packet, snapshots, now);
  env = primaryEnv(env);
  const initial = { capturedAt, itemCount: 0, revisionCount: 0, eventCount: 0, jobCount: 0, sourceCount: captures.length };
  if (!await ensureSchema(env)) return { ...unavailable(), ...initial, stored: false };
  if (!captures.length) return { configured: true, stored: false, available: false, ...initial, reason: 'No durable source-history capture was supplied' };
  try {
    const db = env.EARTH_DB, retainedAt = new Date(now()).toISOString();
    const inputs = captures.map((capture) => ({ sourceId: capture.source, snapshotId: capture.id, capturedAt }));
    const states = new Map((await sourceStates(db, inputs)).map((row) => [row.source_id, row]));
    const bodies = await Promise.all(captures.map((capture) => snapshot(env, capture.source, capture.id)));
    const projected = [], pending = [];
    for (let i = 0; i < captures.length; i++) {
      const capture = captures[i], body = bodies[i], state = states.get(capture.source);
      if (state?.history_id !== capture.id || state.history_count !== capture.recordCount || body.records.length !== capture.recordCount)
        throw new Error('Source history is not durably indexed or record counts disagree');
      if (state.previous_at === capturedAt && state.previous_id !== capture.id || state.receipt_id && state.receipt_id !== capture.id)
        throw new Error('A source capture already cites different evidence');
      if (state.receipt_id && Date.parse(capturedAt) > Date.parse(retainedTime(state.receipt_at)) + PUBLICATION_FUTURE_MS)
        throw new Error('A retained receipt violates its enforced publication clock bound');
      initial.itemCount += body.records.length; initial.eventCount += eventCountFor(body);
      if (state.receipt_id) continue;
      pending.push(inputs[i]);
      if (state.previous_id === capture.id) continue;
      const items = await Promise.all(body.records.map((record) => createWorldSourceItem(record, { snapshotId: capture.id, capturedAt, recordedAt: retainedAt })));
      for (const item of items) {
        const event = provisionalWorldEvent(item);
        projected.push({ itemId: item.itemId, revision: item.revision, sourceId: item.sourceId, sourceRecordId: item.sourceRecordId,
          snapshotId: capture.id, capturedAt, eventId: event?.id || null, eventAt: event?.eventTime.at || null, projection: event });
      }
    }
    const groups = jsonGroups(projected);
    if (groups.length > WORLD_MODEL_LIMITS.publicationChunks) throw new Error('World projection exceeds its bounded publication work budget');
    for (const group of groups) initial.revisionCount += await retainItemGroup(db, group);
    // Every item group verifies before the atomic whole-source receipt/watermark
    // batch. SQL clocks describe actual database execution, including queued work.
    if (pending.length) await publishCaptures(db, pending);
    return { configured: true, stored: true, available: true, ...initial };
  } catch {
    return { configured: true, stored: false, available: false, ...initial,
      reason: 'World evidence publication was incomplete; retained evidence is preserved for retry' };
  }
}

async function selectedCapture(env, knownAt) {
  const current = await rows(env.EARTH_DB, `SELECT c.source_id, c.captured_at, c.snapshot_id, c.recorded_at,
    (SELECT MIN(recorded_at) FROM earth_world_captures INDEXED BY earth_world_captures_source_recorded_capture
      WHERE recorded_at > ? AND source_id = ?) AS next_publication_at,
    (SELECT MIN(recorded_at) FROM earth_world_captures INDEXED BY earth_world_captures_source_recorded_capture
      WHERE source_id = ?) AS first_publication_at
    FROM earth_world_sources s JOIN earth_world_captures c ON c.source_id = s.source_id AND c.captured_at = s.captured_at
      AND c.snapshot_id = s.snapshot_id AND c.recorded_at = s.recorded_at WHERE s.source_id = ?`, [knownAt, 'usgs', 'usgs', 'usgs']);
  const latest = current[0] || null, nextPublicationAt = latest?.next_publication_at || null;
  if (latest && Date.parse(retainedTime(latest.captured_at)) > Date.parse(retainedTime(latest.recorded_at)) + PUBLICATION_FUTURE_MS)
    throw new Error('Published world receipt violates its enforced clock bound');
  if (!latest || knownAt < latest.first_publication_at) return { capture: null, latest, nextPublicationAt };
  if (latest && latest.recorded_at <= knownAt) return { capture: latest, latest, nextPublicationAt };
  const values = await rows(env.EARTH_DB, `SELECT source_id, captured_at, snapshot_id, recorded_at FROM earth_world_captures
    WHERE source_id = ? AND captured_at <= ? AND recorded_at <= ? ORDER BY captured_at DESC LIMIT 1`,
  ['usgs', new Date(Date.parse(knownAt) + PUBLICATION_FUTURE_MS).toISOString(), knownAt]);
  return { capture: values[0] || null, latest, nextPublicationAt };
}
const publicationRevision = (capture) => capture ? { sourceId: capture.source_id, capturedAt: capture.captured_at,
  publishedAt: capture.recorded_at, snapshotId: capture.snapshot_id, scope: 'Complete retained USGS source snapshot membership' } : null;

export async function readWorldEvents(env, { knownAt, limit = 50, id } = {}, { now = Date.now } = {}) {
  knownAt = knownAt === undefined ? new Date(now()).toISOString() : worldTime(knownAt);
  if (Date.parse(knownAt) > now() + 300000 || !Number.isInteger(limit) || limit < 1 || limit > WORLD_MODEL_LIMITS.events ||
      id !== undefined && !/^event:usgs:[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid bounded world query');
  try {
  env = primaryEnv(env);
  if (!await ensureSchema(env)) return { ...unavailable(), schemaVersion: 1, events: [], knownAt };
  const { capture, latest, nextPublicationAt } = await selectedCapture(env, knownAt);
  const window = { nextPublicationAt, publicationWindowStartAt: capture?.recorded_at || null,
    publicationRevision: publicationRevision(capture), currentPublishedRevision: publicationRevision(latest) };
  if (!capture) return { configured: true, available: true, schemaVersion: 1, events: [], knownAt, ...window, coverage: { source: 'usgs', capturedAt: null,
    publishedAt: null, recordCount: 0, returnedCount: 0, omittedCount: 0, scope: 'No retained projection at this knowledge cutoff' }, note: WORLD_HISTORY_NOTE };
  const body = await snapshot(env, 'usgs', capture.snapshot_id), events = [];
  const candidates = (await Promise.all(body.records.filter((record) => record.eventType === 'EQ' &&
    Number.isFinite(record.lat) && Number.isFinite(record.lon)).map(worldRevision)))
    .sort((a, b) => (b.record.observedAt || '').localeCompare(a.record.observedAt || '') || a.itemId.localeCompare(b.itemId));
  const total = candidates.length;
  const selected = (id ? candidates.filter((item) => `event:usgs:${item.itemId.slice(5)}` === id) : candidates).slice(0, limit);
  if (selected.length) {
    const found = await rows(env.EARTH_DB, `SELECT r.* FROM json_each(?) i JOIN earth_world_revisions r
      ON r.item_id = json_extract(i.value, '$.itemId') AND r.revision = json_extract(i.value, '$.revision')`, [references(selected)]);
    const retainedItems = new Map(found.map((row) => [`${row.item_id}/${row.revision}`, row]));
    for (const revision of selected) {
      const retained = retainedItems.get(`${revision.itemId}/${revision.revision}`), record = revision.record;
      if (!retained || retained.source_id !== 'usgs' || retained.source_record_id !== record.id ||
          retainedTime(retained.first_recorded_at) > retainedTime(capture.recorded_at)) throw new Error('Published source membership lacks retained evidence');
      const item = await createWorldSourceItem(record, { snapshotId: retained.snapshot_id,
        capturedAt: retainedTime(retained.first_captured_at), recordedAt: retainedTime(retained.first_recorded_at) });
      const expected = provisionalWorldEvent(item);
      let event;
      try { event = JSON.parse(retained.projection_json); } catch { throw new Error('Invalid retained event projection'); }
      // Factual revisions exclude retrieval-only heartbeats. The saved projection
      // preserves the exact first evidence body's retrieval date rather than borrowing
      // a later capture's clock. All other displayed facts must match selected membership.
      if (!event?.sourceTimes || !Object.hasOwn(event.sourceTimes, 'retrievedAt')) throw new Error('Missing retained event source time');
      if (event.sourceTimes.retrievedAt !== null) retainedTime(event.sourceTimes.retrievedAt);
      expected.sourceTimes.retrievedAt = event.sourceTimes.retrievedAt;
      if (await worldHash(expected) !== await worldHash(event)) throw new Error('Retained event projection disagrees with source membership');
      if (id) {
        const origin = retained.snapshot_id === capture.snapshot_id ? body : await snapshot(env, 'usgs', retained.snapshot_id);
        const originalRecord = origin.records.find((value) => value.id === retained.source_record_id);
        if (!originalRecord) throw new Error('Referenced source evidence does not contain the item');
        const original = await createWorldSourceItem(originalRecord, { snapshotId: retained.snapshot_id,
          capturedAt: retained.first_captured_at, recordedAt: retained.first_recorded_at });
        if (original.itemId !== revision.itemId || original.revision !== revision.revision ||
            await worldHash(provisionalWorldEvent(original)) !== await worldHash(event)) throw new Error('Referenced source evidence disagrees with event detail');
      }
      event.capture = { capturedAt: capture.captured_at, publishedAt: capture.recorded_at,
        snapshotId: capture.snapshot_id, meaning: 'Collector capture time and complete world-projection availability time' };
      events.push(event);
    }
  }
  return { configured: true, available: true, schemaVersion: 1, knownAt, events, ...window,
    coverage: { source: 'usgs', capturedAt: capture.captured_at, publishedAt: capture.recorded_at, recordCount: body.records.length,
      returnedCount: events.length, omittedCount: Math.max(0, total - events.length), scope: 'Exact membership of one retained USGS M4.5+ seven-day source snapshot; not all world events' },
    note: `${WORLD_MODEL_NOTE} ${WORLD_HISTORY_NOTE}` };
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Invalid retained world evidence');
    throw error;
  }
}

/** Stored-data-only public reader. Input cannot choose upstream URLs or object keys. */
export function createWorldModelHandler({ env = {}, now = Date.now } = {}) {
  return async (request) => {
    const url = new URL(request.url), detail = /^\/api\/world\/events\/(event:usgs:[a-f0-9]{64})$/.exec(url.pathname);
    if (url.pathname !== '/api/world/events' && !detail) return url.pathname.startsWith('/api/world/') ? json({ error: 'World route not found' }, 404) : null;
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    try {
      for (const key of url.searchParams.keys()) if (!['knownAt', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError('Unknown or repeated world query');
      const rawLimit = url.searchParams.get('limit');
      if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || detail)) throw new TypeError('Invalid world query limit');
      const payload = await readWorldEvents(env, { knownAt: url.searchParams.has('knownAt') ? url.searchParams.get('knownAt') : undefined,
        limit: detail ? 1 : rawLimit === null ? 50 : Number(rawLimit), ...(detail ? { id: detail[1] } : {}) }, { now });
      if (!payload.available) return json(payload, 503);
      if (detail && !payload.events.length) return json({ ...payload, error: 'Event not present in the selected retained source snapshot; this does not establish it ended' }, 404);
      return json(detail ? { ...payload, event: payload.events[0] } : payload);
    } catch (error) {
      return error instanceof TypeError ? json({ error: 'Invalid bounded world query' }, 400) :
        json({ configured: true, available: false, error: 'Retained world evidence is unavailable or failed integrity validation' }, 503);
    }
  };
}
