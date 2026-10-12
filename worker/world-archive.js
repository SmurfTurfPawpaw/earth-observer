import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { normalizeUsgs } from '../server/hosted/intelligence-sources.js';
import { WORLD_MODEL_LIMITS, worldTime, worldHash, isWorldDigest, worldRevision, createWorldSourceItem,
  provisionalWorldEvent } from '../src/core/world-model.js';
import { ensureArchiveDaySchema, prepareArchiveDayCoverage, archiveDayGenerationGate, archiveDayCompletionStatements,
  archiveDayAdvanceStatement, prepareManualArchiveDayAdmission, ArchiveDayCoverageConflict } from './archive-day-coverage.js';

export const ARCHIVE_SCOPE = Object.freeze({ id: 'usgs-catalog-m4.5-v1', sourceId: 'usgs', minimumMagnitude: 4.5,
  normalization: 'canonical-usgs-v1', selectionPolicy: 'greatest-provider-update; equal-date conflicts retain first publication' });
export const ARCHIVE_LIMITS = Object.freeze({ records: 500, bytes: 1024 * 1024, sqlBytes: 256 * 1024,
  groups: 8, sceneCandidates: 5000, coverageSegments: 2048, horizonMs: 86400000 });
const ready = new WeakSet(), ROOT_DB = Symbol('archive-schema-binding'), encoder = new TextEncoder();
const unavailable = () => ({ configured: false, available: false, stored: false, reason: 'The archive evidence index or its migration is unavailable' });
export const archivePrimary = (env) => env?.EARTH_DB?.withSession ? { ...env, [ROOT_DB]: env[ROOT_DB] || env.EARTH_DB,
  EARTH_DB: env.EARTH_DB.withSession('first-primary') } : env;
export async function archiveIO(task) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Archive storage deadline exceeded')), 2500);
  })]); } finally { clearTimeout(timer); }
}
export async function archiveRows(db, sql, values = []) {
  const value = await archiveIO(() => db.prepare(sql).bind(...values).all());
  if (!Array.isArray(value?.results)) throw new Error('Invalid archive index response');
  return value.results;
}
export async function ensureArchiveSchema(env) {
  if (!env?.EARTH_STORE?.get || !env?.EARTH_STORE?.put || !env?.EARTH_DB?.prepare || !env?.EARTH_DB?.batch) return false;
  const binding = env[ROOT_DB] || env.EARTH_DB;
  if (ready.has(binding)) return true;
  try {
    const results = await archiveIO(() => env.EARTH_DB.batch([
      env.EARTH_DB.prepare('SELECT id, scope_id, chunk_id, snapshot_id, raw_sha256, captured_at, published_at, kind, record_count, policy_json FROM earth_archive_chunks INDEXED BY earth_archive_chunks_scope_publication LIMIT 0'),
      env.EARTH_DB.prepare('SELECT scope_id, chunk_id, item_id, revision, event_id, event_at, source_updated_at, lat, lon, magnitude FROM earth_archive_membership INDEXED BY earth_archive_membership_scope_event LIMIT 0'),
      env.EARTH_DB.prepare('SELECT scope_id, chunk_id, range_from, range_to, expected_count FROM earth_archive_coverage INDEXED BY earth_archive_coverage_scope_range LIMIT 0'),
      env.EARTH_DB.prepare('SELECT scope_id, item_id, revision, event_id, event_at, source_updated_at, lat, lon, magnitude, chunk_id, publication_order FROM earth_archive_heads INDEXED BY earth_archive_heads_scope_event LIMIT 0'),
      env.EARTH_DB.prepare('SELECT item_id, revision, snapshot_id, first_recorded_at, projection_json FROM earth_world_revisions LIMIT 0'),
    ]));
    if (!Array.isArray(results) || results.length !== 5 || results.some((value) => value?.success === false || !Array.isArray(value?.results))) return false;
    ready.add(binding); return true;
  } catch { return false; }
}
export const archiveJson = (value) => {
  const text = JSON.stringify(value);
  if (encoder.encode(text).byteLength > ARCHIVE_LIMITS.sqlBytes) throw new TypeError('Archive SQL payload exceeds its bound');
  return text;
};
function groups(values) {
  const parts = []; let part = [], bytes = 2;
  for (const value of values) {
    const size = encoder.encode(JSON.stringify(value)).byteLength;
    if (size + 2 > ARCHIVE_LIMITS.sqlBytes) throw new TypeError('An archive item exceeds its SQL bound');
    if (bytes + size + (part.length ? 1 : 0) > ARCHIVE_LIMITS.sqlBytes) { parts.push(part); part = []; bytes = 2; }
    bytes += size + (part.length ? 1 : 0); part.push(value);
  }
  if (part.length) parts.push(part);
  if (parts.length > ARCHIVE_LIMITS.groups) throw new TypeError('Archive publication exceeds its work bound');
  return parts;
}
async function rawHash(body) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function rawValue(body) {
  if (typeof body !== 'string' || encoder.encode(body).byteLength > ARCHIVE_LIMITS.bytes) throw new TypeError('Use a bounded original GeoJSON body');
  let value; try { value = JSON.parse(body); } catch { throw new TypeError('Invalid original GeoJSON'); }
  if (value?.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > ARCHIVE_LIMITS.records ||
      !value.metadata || typeof value.metadata !== 'object' ||
      Object.hasOwn(value.metadata,'count') && (!Number.isInteger(value.metadata.count) || value.metadata.count !== value.features.length) ||
      Object.hasOwn(value.metadata,'status') && value.metadata.status !== 200)
    throw new TypeError('GeoJSON counts or record bounds disagree');
  const ids = new Set();
  for (const feature of value.features) {
    if (feature?.type !== 'Feature' || typeof feature.id !== 'string' || !feature.id || feature.id.length > 128 || ids.has(feature.id) ||
        feature.properties?.type !== 'earthquake' || feature.geometry?.type !== 'Point' ||
        !Number.isFinite(feature.properties?.time) || !Number.isFinite(feature.properties?.mag) ||
        feature.properties.updated != null && !Number.isFinite(feature.properties.updated)) throw new TypeError('Invalid or unsupported catalog feature');
    ids.add(feature.id);
  }
  return value;
}
/** Called by authenticated importer transport, never by public scene requests. */
export async function retainWorldArchiveRaw(env, { body } = {}) {
  rawValue(body);
  if (!env?.EARTH_STORE?.get || !env?.EARTH_STORE?.put) return unavailable();
  const rawSha256 = await rawHash(body), key = `archive/raw/usgs/${rawSha256}.json`;
  await archiveIO(() => env.EARTH_STORE.put(key, body, { onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: { contentType: 'application/geo+json' } }));
  await loadArchiveRaw(env, rawSha256);
  return { configured: true, stored: true, rawSha256, bytes: encoder.encode(body).byteLength };
}
export async function loadArchiveRaw(env, digest) {
  if (!isWorldDigest(digest)) throw new TypeError('Invalid raw archive reference');
  const object = await archiveIO(() => env.EARTH_STORE.get(`archive/raw/usgs/${digest}.json`));
  if (!object || Number.isFinite(object.size) && object.size > ARCHIVE_LIMITS.bytes) throw new Error('Original archive evidence is missing or oversized');
  const body = await archiveIO(() => object.text());
  if (await rawHash(body) !== digest) throw new Error('Original archive evidence failed integrity validation');
  return rawValue(body);
}
export async function loadArchiveSnapshot(env, id) {
  if (!isWorldDigest(id)) throw new TypeError('Invalid archive snapshot reference');
  const object = await archiveIO(() => env.EARTH_STORE.get(`history/snapshots/usgs/${id}.json`));
  if (!object || Number.isFinite(object.size) && object.size > ARCHIVE_LIMITS.bytes) throw new Error('Canonical archive evidence is missing or oversized');
  const value = await archiveIO(() => object.json());
  if (value?.schemaVersion !== 1 || value.source !== 'usgs' || !Array.isArray(value.records) || value.records.length > ARCHIVE_LIMITS.records ||
      !Array.isArray(value.coordinates) || value.coordinates.length > 100 || encoder.encode(JSON.stringify(value)).byteLength > ARCHIVE_LIMITS.bytes)
    throw new Error('Invalid canonical archive evidence');
  const records = value.records.map(canonicalDiscoveryRecord);
  if (records.some((record) => !record || record.sourceId !== 'usgs') || new Set(records.map((record) => record.id)).size !== records.length)
    throw new Error('Invalid canonical archive identity');
  records.sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set(), ids = new Set(records.map((record) => record.id));
  const coordinates = value.coordinates.map((point) => {
    if (!ids.has(point?.id) || seen.has(point.id) || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180)
      throw new Error('Invalid canonical archive geometry');
    seen.add(point.id); return { id: point.id, lat: point.lat, lon: point.lon };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const body = { schemaVersion: 1, source: 'usgs', records, coordinates };
  if (await worldHash({ ...body, records: records.map(({ retrievedAt: _retrievedAt, ...record }) => record) }) !== id ||
      await worldHash(body) !== value.bodySha256) throw new Error('Canonical archive evidence failed integrity validation');
  return body;
}
function inputValue(value, now) {
  if (value?.schemaVersion !== 1 || value.scopeId !== ARCHIVE_SCOPE.id || !['interval', 'correction'].includes(value.kind) ||
      !Array.isArray(value.records) || value.records.length > ARCHIVE_LIMITS.records || !isWorldDigest(value.rawSha256))
    throw new TypeError('Invalid bounded archive input');
  const capturedAt = worldTime(value.capturedAt);
  if (Date.parse(capturedAt) > now() + 300000) throw new TypeError('Archive capture is future dated');
  const range = value.kind === 'interval' ? { from: worldTime(value.range?.from), to: worldTime(value.range?.to) } : null;
  if (range && (range.from > range.to || !Number.isInteger(value.expectedCount) || value.expectedCount < 0 || value.expectedCount !== value.records.length))
    throw new TypeError('Complete interval requires matching counts and ordered bounds');
  if(range&&(range.to>capturedAt||Date.parse(range.to)>now()))throw new TypeError('Future intervals cannot establish completed catalog coverage');
  const records = value.records.map(canonicalDiscoveryRecord);
  if (records.some((record) => !record || record.sourceId !== 'usgs' || record.eventType !== 'EQ' || !record.observedAt || record.retrievedAt !== capturedAt ||
      !Number.isFinite(record.lat) || !Number.isFinite(record.lon) || !Number.isFinite(record.magnitude) ||
      range && (record.observedAt < range.from || record.observedAt > range.to || record.magnitude < ARCHIVE_SCOPE.minimumMagnitude)) ||
      new Set(records.map((record) => record.id)).size !== records.length) throw new TypeError('Archive facts do not match declared scientific scope');
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { capturedAt, range, records, expectedCount: range ? value.expectedCount : null, kind: value.kind, rawSha256: value.rawSha256 };
}
async function verifyRawRecords(raw, input) {
  // Normalize fact by fact; the live summary adapter's 100-record cap is never used
  // on a larger response. Exact body retains depth, aliases and provider products.
  const normalized = raw.features.flatMap((feature) => normalizeUsgs({ features: [feature] }, input.capturedAt)).map(canonicalDiscoveryRecord);
  if (normalized.length !== input.records.length || normalized.some((record) => !record)) throw new TypeError('Raw archive records were omitted or differ');
  const expected = new Map(await Promise.all(normalized.map(async (record) => [record.id, (await worldRevision(record)).revision])));
  for (const record of input.records) if (expected.get(record.id) !== (await worldRevision(record)).revision)
    throw new TypeError('Normalized archive facts disagree with original evidence');
  if (input.range && (raw.features.length !== input.expectedCount || Object.hasOwn(raw.metadata,'count') && raw.metadata.count !== input.expectedCount))
    throw new TypeError('Source and independently counted interval disagree');
  if(input.range) {
    let url;try{url=new URL(raw.metadata.url);}catch{throw new TypeError('Interval evidence requires the original catalog query URL');}
    if(url.origin!=='https://earthquake.usgs.gov'||url.pathname!=='/fdsnws/event/1/query'||url.username||url.password||url.hash)
      throw new TypeError('Invalid original catalog query URL');
    const allowed=new Set(['format','starttime','endtime','minmagnitude','eventtype','orderby','limit','offset']);
    for(const key of url.searchParams.keys())if(!allowed.has(key)||url.searchParams.getAll(key).length!==1)throw new TypeError('Catalog query narrows or duplicates the declared scope');
    const queryTime=(value)=>{
      if(typeof value!=='string')throw new TypeError('Catalog interval bounds are missing');
      if(/^\d{4}-\d\d-\d\d$/.test(value))value+= 'T00:00:00Z';
      else if(!value.endsWith('Z'))value+='Z';
      return worldTime(value);
    };
    if(url.searchParams.get('format')!=='geojson'||url.searchParams.get('eventtype')!=='earthquake'||
      Number(url.searchParams.get('minmagnitude'))!==ARCHIVE_SCOPE.minimumMagnitude||
      queryTime(url.searchParams.get('starttime'))!==input.range.from||queryTime(url.searchParams.get('endtime'))!==input.range.to||
      url.searchParams.has('offset')&&url.searchParams.get('offset')!=='1'||
      url.searchParams.has('orderby')&&!['time','time-asc','magnitude','magnitude-asc'].includes(url.searchParams.get('orderby'))||
      url.searchParams.has('limit')&&(!/^[1-9]\d{0,4}$/.test(url.searchParams.get('limit'))||Number(url.searchParams.get('limit'))<raw.features.length||Number(url.searchParams.get('limit'))>20000))
      throw new TypeError('Catalog query bounds or filters differ from complete interval scope');
  }
}
async function retainCanonical(env, input) {
  const body = { schemaVersion: 1, source: 'usgs', records: input.records, coordinates: [] };
  const snapshotId = await worldHash({ ...body, records: body.records.map(({ retrievedAt: _retrievedAt, ...record }) => record) });
  const stored = { ...body, bodySha256: await worldHash(body) }, text = JSON.stringify(stored);
  if (encoder.encode(text).byteLength > ARCHIVE_LIMITS.bytes) throw new TypeError('Canonical archive body exceeds its byte bound');
  await archiveIO(() => env.EARTH_STORE.put(`history/snapshots/usgs/${snapshotId}.json`, text,
    { onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' } }));
  const saved = await loadArchiveSnapshot(env, snapshotId);
  if (saved.records.length !== body.records.length) throw new Error('Canonical archive publication failed');
  return {snapshotId,body:saved};
}

/** Client/server checkpoint identity uses source facts and original response bytes,
 * not the clock of a retried HTTP attempt. The first committed capture stays saved. */
export async function createWorldArchiveCandidate(value, { now = Date.now } = {}) {
  const input=inputValue(value,now),body={schemaVersion:1,source:'usgs',records:input.records,coordinates:[]};
  const snapshotId=await worldHash({...body,records:body.records.map(({retrievedAt:_retrievedAt,...record})=>record)});
  const policy={scope:ARCHIVE_SCOPE,range:input.range,expectedCount:input.expectedCount,kind:input.kind,rawSha256:input.rawSha256,snapshotId};
  return {scopeId:ARCHIVE_SCOPE.id,chunkId:await worldHash(policy),snapshotId,capturedAt:input.capturedAt,policyJson:JSON.stringify(policy)};
}

/** A complete small catalog response; does not fetch providers or modify live state. */
async function publishArchiveAttempt(env, value, { now = Date.now, maintenanceCommit = null } = {}) {
  const input = inputValue(value, now); env = archivePrimary(env);
  if (!await ensureArchiveSchema(env)) return unavailable();
  await verifyRawRecords(await loadArchiveRaw(env, input.rawSha256), input);
  const candidate=await createWorldArchiveCandidate(value,{now}),retainedCanonical = await retainCanonical(env, input),snapshotId=retainedCanonical.snapshotId;
  if(snapshotId!==candidate.snapshotId) throw new Error('Archive candidate facts changed during retention');
  const {chunkId,policyJson}=candidate,db = env.EARTH_DB;
  if (maintenanceCommit && (maintenanceCommit.scopeId !== ARCHIVE_SCOPE.id || maintenanceCommit.chunkId !== chunkId ||
      input.kind !== 'interval' || !maintenanceCommit.admissionStatement || !maintenanceCommit.completionStatement))
    throw new TypeError('Maintenance admission must match the exact archive candidate');
  const daily = await ensureArchiveDaySchema(env);
  if (maintenanceCommit && !daily) return unavailable();
  const existing = (await archiveRows(db, 'SELECT * FROM earth_archive_chunks WHERE scope_id = ? AND chunk_id = ?', [ARCHIVE_SCOPE.id, chunkId]))[0];
  const dayUpdates = maintenanceCommit?.dayUpdates || (daily && input.range ? await prepareArchiveDayCoverage(env, {
    scopeId: ARCHIVE_SCOPE.id, kind: 'interval', chunkId, range: input.range, expectedCount: input.expectedCount,
    recordCount: input.records.length, publishedAt: existing?.published_at ?? null }) : []);
  const dayGate = archiveDayGenerationGate(dayUpdates);
  const admission = maintenanceCommit || (daily ? prepareManualArchiveDayAdmission(db, dayUpdates, chunkId) : null);
  const admissionSql = admission?.admittedSql, admissionValues = admission?.admittedValues;
  if (existing) {
    if (existing.snapshot_id !== snapshotId || existing.raw_sha256 !== input.rawSha256 || existing.policy_json !== policyJson) throw new Error('Conflicting archive receipt');
    if (daily) {
      const statements = [admission.admissionStatement,
        ...archiveDayCompletionStatements(db, dayUpdates, { chunkId, admittedSql: admissionSql, admittedValues: admissionValues }),
        archiveDayAdvanceStatement(db, { chunkId, admittedSql: admissionSql, admittedValues: admissionValues }), admission.completionStatement];
      const completed = await archiveIO(() => db.batch(statements));
      if (completed.at(-1)?.meta?.changes !== 1) await requireDayAdmission(db, dayGate, maintenanceCommit);
    }
    return { configured: true, available: true, stored: true, reused: true, scopeId: ARCHIVE_SCOPE.id, chunkId, snapshotId,
      publicationOrder: existing.id, publishedAt: existing.published_at, recordCount: existing.record_count, complete: input.kind === 'interval' };
  }
  // Content identity excludes retrieval-only clocks. A racing attempt can win R2
  // retention before another wins D1; project the body that actually won retention.
  const items = await Promise.all(retainedCanonical.body.records.map(async (record) => {
    const item = await createWorldSourceItem(record, { snapshotId, capturedAt: input.capturedAt, recordedAt: new Date(now()).toISOString() });
    const event = provisionalWorldEvent(item);
    return { itemId: item.itemId, revision: item.revision, sourceId: 'usgs', sourceRecordId: record.id, snapshotId,
      capturedAt: input.capturedAt, projection: event, eventId: event.id, eventAt: worldTime(record.observedAt),
      sourceUpdatedAt: record.updatedAt === null ? null : worldTime(record.updatedAt), lat: record.lat, lon: record.lon, magnitude: record.magnitude };
  }));
  if (input.kind === 'correction' && items.some((item) => item.magnitude < ARCHIVE_SCOPE.minimumMagnitude)) {
    const known = await archiveRows(db, `SELECT item_id FROM earth_archive_heads WHERE scope_id = ? AND item_id IN
      (SELECT json_extract(value, '$.itemId') FROM json_each(?))`, [ARCHIVE_SCOPE.id, archiveJson(items.map(({ itemId }) => ({ itemId })))]);
    const ids = new Set(known.map((item) => item.item_id));
    if (items.some((item) => item.magnitude < ARCHIVE_SCOPE.minimumMagnitude && !ids.has(item.itemId))) throw new TypeError('Below-threshold corrections require an already retained scoped event');
  }
  for (const part of groups(items)) {
    const encoded = archiveJson(part);
    const result = await archiveIO(() => db.batch([
      db.prepare(`INSERT INTO earth_world_revisions
        (item_id, revision, source_id, source_record_id, snapshot_id, first_captured_at, first_recorded_at, event_id, event_at, projection_json)
        SELECT json_extract(value,'$.itemId'), json_extract(value,'$.revision'), 'usgs', json_extract(value,'$.sourceRecordId'),
          json_extract(value,'$.snapshotId'), json_extract(value,'$.capturedAt'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          json_extract(value,'$.eventId'), json_extract(value,'$.eventAt'),
          json_set(json_extract(value,'$.projection'),'$.knowledge.firstRecordedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        FROM json_each(?) WHERE 1 ON CONFLICT(item_id,revision) DO NOTHING`).bind(encoded),
      db.prepare(`INSERT INTO earth_archive_membership
        (scope_id,chunk_id,item_id,revision,event_id,event_at,source_updated_at,lat,lon,magnitude)
        SELECT ?,?,json_extract(value,'$.itemId'),json_extract(value,'$.revision'),json_extract(value,'$.eventId'),
          json_extract(value,'$.eventAt'),json_extract(value,'$.sourceUpdatedAt'),json_extract(value,'$.lat'),json_extract(value,'$.lon'),json_extract(value,'$.magnitude')
        FROM json_each(?) WHERE 1 ON CONFLICT(scope_id,chunk_id,item_id) DO NOTHING`).bind(ARCHIVE_SCOPE.id, chunkId, encoded),
    ]));
    if (result.some((value) => value?.success === false)) throw new Error('Archive retention failed');
    const verified = await archiveRows(db, `SELECT m.item_id, m.revision FROM json_each(?) i
      JOIN earth_archive_membership m ON m.scope_id=? AND m.chunk_id=? AND m.item_id=json_extract(i.value,'$.itemId')
      JOIN earth_world_revisions r ON r.item_id=m.item_id AND r.revision=m.revision
      WHERE m.revision=json_extract(i.value,'$.revision') AND m.event_id=r.event_id AND m.event_at=r.event_at AND r.source_id='usgs'`,
    [archiveJson(part.map(({ itemId, revision }) => ({ itemId, revision }))), ARCHIVE_SCOPE.id, chunkId]);
    if (verified.length !== part.length) throw new Error('Archive references are incomplete or conflicting');
  }
  // A new receipt's real SQL clock must not precede already retained scope
  // publication knowledge. Defer on regression rather than resolve $receipt
  // as an invented earlier/later proof. Exact committed receipt reuse is exempt.
  const receipt = db.prepare(`INSERT INTO earth_archive_chunks
    (scope_id,chunk_id,snapshot_id,raw_sha256,captured_at,published_at,kind,record_count,policy_json)
    SELECT ?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?
    WHERE ? <= strftime('%Y-%m-%dT%H:%M:%fZ','now','+305 seconds')
      AND (EXISTS(SELECT 1 FROM earth_archive_chunks WHERE scope_id=? AND chunk_id=?) OR
        COALESCE((SELECT published_at FROM earth_archive_chunks INDEXED BY earth_archive_chunks_scope_publication
          WHERE scope_id=? ORDER BY published_at DESC LIMIT 1),strftime('%Y-%m-%dT%H:%M:%fZ','now'))<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ${daily ? `AND ${admissionSql}` : ''}
    ON CONFLICT(scope_id,chunk_id) DO NOTHING`).bind(ARCHIVE_SCOPE.id,chunkId,snapshotId,input.rawSha256,input.capturedAt,input.kind,items.length,policyJson,input.capturedAt,ARCHIVE_SCOPE.id,chunkId,ARCHIVE_SCOPE.id,
    ...(daily ? admissionValues : []));
  const statements = [...(admission ? [admission.admissionStatement] : []), receipt];
  if (input.range) statements.push(db.prepare(`INSERT INTO earth_archive_coverage(scope_id,chunk_id,range_from,range_to,expected_count)
    SELECT scope_id,chunk_id,?,?,? FROM earth_archive_chunks WHERE scope_id=? AND chunk_id=? ${daily ? `AND ${admissionSql}` : ''}
    ON CONFLICT(scope_id,chunk_id) DO NOTHING`).bind(input.range.from,input.range.to,input.expectedCount,ARCHIVE_SCOPE.id,chunkId,
    ...(daily ? admissionValues : [])));
  statements.push(db.prepare(`INSERT INTO earth_archive_heads
    (scope_id,item_id,revision,event_id,event_at,source_updated_at,lat,lon,magnitude,chunk_id,publication_order)
    SELECT m.scope_id,m.item_id,m.revision,m.event_id,m.event_at,m.source_updated_at,m.lat,m.lon,m.magnitude,m.chunk_id,c.id
    FROM earth_archive_membership m JOIN earth_archive_chunks c ON c.scope_id=m.scope_id AND c.chunk_id=m.chunk_id
    WHERE m.scope_id=? AND m.chunk_id=? ${daily ? `AND ${admissionSql}` : ''}
    ON CONFLICT(scope_id,item_id) DO UPDATE SET revision=excluded.revision,event_id=excluded.event_id,event_at=excluded.event_at,
      source_updated_at=excluded.source_updated_at,lat=excluded.lat,lon=excluded.lon,magnitude=excluded.magnitude,
      chunk_id=excluded.chunk_id,publication_order=excluded.publication_order
    WHERE (excluded.source_updated_at IS NOT NULL AND (earth_archive_heads.source_updated_at IS NULL OR excluded.source_updated_at>earth_archive_heads.source_updated_at))
      OR (excluded.source_updated_at IS earth_archive_heads.source_updated_at AND excluded.publication_order<earth_archive_heads.publication_order)`)
    .bind(ARCHIVE_SCOPE.id,chunkId,...(daily ? admissionValues : [])));
  if (daily) statements.push(...(maintenanceCommit?.dayStatements || archiveDayCompletionStatements(db, dayUpdates, {
    chunkId, admittedSql: admissionSql, admittedValues: admissionValues })), archiveDayAdvanceStatement(db, { chunkId,
    admittedSql: admissionSql, admittedValues: admissionValues }), admission.completionStatement);
  const completed = await archiveIO(() => db.batch(statements));
  if (completed.some((value) => value?.success === false)) throw new Error('Archive publication failed');
  const saved = (await archiveRows(db,'SELECT * FROM earth_archive_chunks WHERE scope_id=? AND chunk_id=?',[ARCHIVE_SCOPE.id,chunkId]))[0];
  if (daily && (!saved || completed.at(-1)?.meta?.changes !== 1)) await requireDayAdmission(db, dayGate, maintenanceCommit);
  if (!saved || saved.snapshot_id !== snapshotId || saved.record_count !== items.length) throw new Error('Archive publication has no complete receipt');
  return { configured:true,available:true,stored:true,reused:completed[daily ? 1 : 0]?.meta?.changes===0,scopeId:ARCHIVE_SCOPE.id,chunkId,snapshotId,
    publicationOrder:saved.id,publishedAt:saved.published_at,recordCount:items.length,complete:input.kind==='interval' };
}

async function requireDayAdmission(db, gate, maintenance) {
  if (maintenance) {
    const active = (await archiveRows(db, `SELECT ${maintenance.ownedSql} AS active`, maintenance.ownedValues))[0];
    if (!active?.active) throw new Error('Archive maintenance ownership is no longer active');
  }
  const unchanged = (await archiveRows(db, `SELECT ${gate.sql} AS unchanged`, gate.values))[0];
  if (!unchanged?.unchanged) throw new ArchiveDayCoverageConflict();
  throw new Error('Archive atomic admission did not complete');
}

/** One bounded fresh materialization read after an ordinary writer generation
 * conflict. Maintenance owns its own one-retry loop and frozen original body. */
export async function publishWorldArchiveChunk(env, value, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await publishArchiveAttempt(env, value, options); }
    catch (error) { if (!(error instanceof ArchiveDayCoverageConflict) || options.maintenanceCommit || attempt) throw error; }
  }
}

/** Exact completed receipt only. Does not expose private evidence bodies. */
export async function readWorldArchiveChunk(env, { chunkId } = {}) {
  if (!isWorldDigest(chunkId)) throw new TypeError('Invalid archive chunk identity');
  env = archivePrimary(env);
  if (!await ensureArchiveSchema(env)) return unavailable();
  const row = (await archiveRows(env.EARTH_DB, `SELECT c.*,v.range_from,v.range_to,v.expected_count
    FROM earth_archive_chunks c LEFT JOIN earth_archive_coverage v ON v.scope_id=c.scope_id AND v.chunk_id=c.chunk_id
    WHERE c.scope_id=? AND c.chunk_id=?`, [ARCHIVE_SCOPE.id,chunkId]))[0];
  if (!row) return { configured:true,available:true,stored:false,scopeId:ARCHIVE_SCOPE.id,chunkId };
  return { configured:true,available:true,stored:true,scopeId:ARCHIVE_SCOPE.id,chunkId,snapshotId:row.snapshot_id,
    rawSha256:row.raw_sha256,capturedAt:row.captured_at,publishedAt:row.published_at,publicationOrder:row.id,
    recordCount:row.record_count,kind:row.kind,complete:row.kind==='interval' && row.range_from !== null,
    range:row.range_from === null ? null : {from:row.range_from,to:row.range_to},expectedCount:row.expected_count };
}
