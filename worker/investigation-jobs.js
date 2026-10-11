import { readWorldEvents } from './world-model.js';
import { worldHash, worldTime, isWorldDigest } from '../src/core/world-model.js';

export const USGS_DETAIL_POLICY = Object.freeze({ id: 'usgs-detail-v1', source: 'usgs',
  kind: 'official-scientific-enrichment', maxAttempts: 3, minimumStartGapMs: 60_000,
  documentation: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php' });
export const INVESTIGATION_LIMITS = Object.freeze({ detailBytes: 512 * 1024, artifactBytes: 16 * 1024,
  fetchTimeoutMs: 10_000, runDeadlineMs: 30_000, leaseMs: 60_000, storageTimeoutMs: 2500,
  readLimit: 20, retryMaximumMs: 86_400_000 });
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const JOB_ID = /^investigation:[a-f0-9]{64}$/, EVENT_ID = /^event:usgs:[a-f0-9]{64}$/;
const USGS_RECORD_ID = /^usgs:([a-z0-9]{4,32})$/, WORKER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
// Preserve the platform's canonical identity. Only the fixed official URL/raw Feature.id use the provider's bare ID.
const providerId = value => typeof value === 'string' ? USGS_RECORD_ID.exec(value)?.[1] || null : null;
const encoder = new TextEncoder(), ready = new WeakSet();
const errorCodes = new Set(['upstream_unavailable', 'upstream_limit', 'upstream_not_found', 'invalid_detail',
  'response_limit', 'deadline', 'input_changed', 'storage_unavailable', 'lease_expired']);
const configured = env => Boolean(env?.EARTH_DB?.prepare && env?.EARTH_DB?.batch && env?.EARTH_STORE?.get && env?.EARTH_STORE?.put);
const primary = env => env.EARTH_DB.withSession?.('first-primary') || env.EARTH_DB;
const bytes = value => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
const failure = (code, retryAfterMs = 0) => Object.assign(new Error(code), { code, retryAfterMs });
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
async function sha256(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(n => n.toString(16).padStart(2, '0')).join(''); }
function closed(value, keys) { return value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).every(key => keys.includes(key)); }

function abortable(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(failure('deadline')); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('deadline'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function io(task, signal) {
  signal?.throwIfAborted();
  let timer;
  try { return await abortable(Promise.race([Promise.resolve().then(() => { signal?.throwIfAborted(); return task(); }), new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure('storage_unavailable')), INVESTIGATION_LIMITS.storageTimeoutMs);
  })]), signal); } finally { clearTimeout(timer); }
}
async function rows(db, sql, values = [], signal) {
  const output = await io(() => db.prepare(sql).bind(...values).all(), signal);
  if (output?.success === false || !Array.isArray(output?.results)) throw failure('storage_unavailable');
  return output.results;
}
async function batch(db, statements, signal) {
  const output = await io(() => db.batch(statements), signal);
  if (!Array.isArray(output) || output.length !== statements.length || output.some(value => value?.success === false)) throw failure('storage_unavailable');
  return output;
}
async function schema(env) {
  if (!configured(env)) return false;
  if (ready.has(env.EARTH_DB)) return true;
  try {
    await batch(primary(env), [
      env.EARTH_DB.prepare('SELECT job_id, input_revision, fence, lease_token, lease_until, artifact_key FROM earth_investigation_jobs LIMIT 0'),
      env.EARTH_DB.prepare('SELECT event_id, policy_id, job_id, basis_recorded_at FROM earth_investigation_heads LIMIT 0'),
      env.EARTH_DB.prepare('SELECT job_id, fence, lease_token, state, raw_key, artifact_key FROM earth_investigation_attempts LIMIT 0'),
    ]); ready.add(env.EARTH_DB); return true;
  } catch { return false; }
}
function publicJob(row) {
  return { jobId: row.job_id, eventId: row.event_id, inputRevision: row.input_revision, policyId: row.policy_id,
    state: row.state, priority: row.priority, dueAt: row.due_at, attemptCount: row.attempt_count,
    basisCapturedAt: row.basis_captured_at, basisRecordedAt: row.basis_recorded_at,
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
    supersededBy: row.superseded_by, artifactSha256: row.artifact_sha256, errorCode: row.error_code };
}
function lease(row) { return { ...publicJob(row), itemId: row.item_id, sourceRecordId: row.source_record_id,
  snapshotId: row.snapshot_id, fence: row.fence, leaseToken: row.lease_token, leaseUntil: row.lease_until }; }

/** Validates current retained event/revision and creates no provider traffic. Corrections supersede unfinished input. */
export async function enqueueInvestigation(env, input, { now = Date.now } = {}) {
  if (!closed(input, ['eventId', 'inputRevision', 'policyId', 'priority']) || !EVENT_ID.test(input.eventId || '') ||
    !isWorldDigest(input.inputRevision) || input.policyId !== undefined && input.policyId !== USGS_DETAIL_POLICY.id ||
    input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10))
    throw new TypeError('Use one retained USGS event, input revision and fixed policy');
  if (!await schema(env)) return { configured: false, enqueued: false };
  const current = await readWorldEvents(env, { id: input.eventId, limit: 1 }, { now });
  const event = current.events?.[0];
  if (!current.available || !event || event.evidence?.revision !== input.inputRevision ||
    event.evidence.sourceId !== 'usgs' || !providerId(event.evidence.sourceRecordId) || !isWorldDigest(event.evidence.snapshotId))
    throw new TypeError('The requested input must match a current retained USGS event');
  const capturedAt = worldTime(event.capture.capturedAt), recordedAt = worldTime(event.capture.publishedAt);
  const jobId = `investigation:${await worldHash([input.eventId, input.inputRevision, USGS_DETAIL_POLICY.id])}`;
  const db = primary(env), priority = input.priority ?? 0;
  await batch(db, [
    db.prepare(`INSERT INTO earth_investigation_jobs
      (job_id,event_id,item_id,input_revision,policy_id,source_record_id,snapshot_id,basis_captured_at,basis_recorded_at,
       state,priority,due_at,attempt_count,fence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,${DB_NOW},0,0,${DB_NOW},${DB_NOW})
      ON CONFLICT(event_id,input_revision,policy_id) DO UPDATE SET priority=MAX(earth_investigation_jobs.priority,excluded.priority)`)
      .bind(jobId, input.eventId, event.evidence.itemId, input.inputRevision, USGS_DETAIL_POLICY.id,
        event.evidence.sourceRecordId, event.evidence.snapshotId, capturedAt, recordedAt, priority),
    db.prepare(`INSERT INTO earth_investigation_heads (event_id,policy_id,job_id,basis_recorded_at,updated_at)
      VALUES (?,?,?,?,${DB_NOW}) ON CONFLICT(event_id,policy_id) DO UPDATE
      SET job_id=excluded.job_id,basis_recorded_at=excluded.basis_recorded_at,updated_at=${DB_NOW}
      WHERE excluded.basis_recorded_at > earth_investigation_heads.basis_recorded_at OR
        (excluded.basis_recorded_at = earth_investigation_heads.basis_recorded_at AND
          ((SELECT basis_captured_at FROM earth_investigation_jobs WHERE job_id=excluded.job_id) >
            (SELECT basis_captured_at FROM earth_investigation_jobs WHERE job_id=earth_investigation_heads.job_id)
            OR excluded.job_id = earth_investigation_heads.job_id))`)
      .bind(input.eventId, USGS_DETAIL_POLICY.id, jobId, recordedAt),
    db.prepare(`UPDATE earth_investigation_jobs SET state='superseded',
      superseded_by=(SELECT job_id FROM earth_investigation_heads h WHERE h.event_id=earth_investigation_jobs.event_id AND h.policy_id=earth_investigation_jobs.policy_id),
      lease_token=NULL,lease_until=NULL,updated_at=${DB_NOW},finished_at=${DB_NOW}
      WHERE event_id=? AND policy_id=? AND state IN ('pending','running','retry') AND
        job_id <> (SELECT job_id FROM earth_investigation_heads WHERE event_id=? AND policy_id=?)`)
      .bind(input.eventId, USGS_DETAIL_POLICY.id, input.eventId, USGS_DETAIL_POLICY.id),
    db.prepare(`UPDATE earth_investigation_attempts SET state='superseded',finished_at=COALESCE(finished_at,${DB_NOW})
      WHERE state='running' AND job_id IN (SELECT job_id FROM earth_investigation_jobs WHERE event_id=? AND policy_id=? AND state='superseded')`)
      .bind(input.eventId, USGS_DETAIL_POLICY.id),
    db.prepare(`UPDATE earth_investigation_jobs SET state='pending',superseded_by=NULL,lease_token=NULL,lease_until=NULL,
      due_at=${DB_NOW},updated_at=${DB_NOW},finished_at=NULL WHERE job_id=? AND state='superseded' AND artifact_key IS NULL AND attempt_count<?
      AND EXISTS(SELECT 1 FROM earth_investigation_heads h WHERE h.job_id=earth_investigation_jobs.job_id)`)
      .bind(jobId, USGS_DETAIL_POLICY.maxAttempts),
  ]);
  const saved = (await rows(db, 'SELECT * FROM earth_investigation_jobs WHERE job_id=?', [jobId]))[0];
  if (!saved) throw failure('storage_unavailable');
  return { configured: true, enqueued: saved.state !== 'superseded', job: publicJob(saved) };
}

/** Atomic SQL claim/fence. One detail attempt starts per minute; expired leases may be reclaimed within the attempt cap. */
export async function claimInvestigation(env, { workerId } = {}, { signal } = {}) {
  signal?.throwIfAborted();
  if (!WORKER_ID.test(workerId || '')) throw new TypeError('Use a bounded server worker identity');
  if (!await schema(env)) return { configured: false, job: null };
  signal?.throwIfAborted();
  const db = primary(env), token = nonce();
  const output = await batch(db, [
    db.prepare(`UPDATE earth_investigation_attempts SET state='lease_expired',error_code='lease_expired',finished_at=COALESCE(finished_at,${DB_NOW})
      WHERE state='running' AND EXISTS(SELECT 1 FROM earth_investigation_jobs j WHERE j.job_id=earth_investigation_attempts.job_id
        AND j.fence=earth_investigation_attempts.fence AND j.lease_until<=${DB_NOW})`),
    db.prepare(`UPDATE earth_investigation_jobs SET state='failed',error_code='lease_expired',finished_at=${DB_NOW},updated_at=${DB_NOW},lease_token=NULL,lease_until=NULL
      WHERE state='running' AND lease_until<=${DB_NOW} AND attempt_count>=?`).bind(USGS_DETAIL_POLICY.maxAttempts),
    db.prepare(`UPDATE earth_investigation_jobs SET state='running',attempt_count=attempt_count+1,fence=fence+1,
      lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),updated_at=${DB_NOW},finished_at=NULL
      WHERE job_id=(SELECT j.job_id FROM earth_investigation_jobs j JOIN earth_investigation_heads h ON h.job_id=j.job_id
        WHERE j.policy_id=? AND j.attempt_count<? AND
          ((j.state IN ('pending','retry') AND j.due_at<=${DB_NOW}) OR (j.state='running' AND j.lease_until<=${DB_NOW}))
          AND NOT EXISTS(SELECT 1 FROM earth_investigation_jobs active WHERE active.state='running' AND active.lease_until>${DB_NOW})
          AND NOT EXISTS(SELECT 1 FROM earth_investigation_attempts a WHERE a.started_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds'))
        ORDER BY j.priority DESC,j.due_at,j.job_id LIMIT 1) RETURNING *`)
      .bind(token, USGS_DETAIL_POLICY.id, USGS_DETAIL_POLICY.maxAttempts),
    db.prepare(`INSERT INTO earth_investigation_attempts (job_id,fence,worker_id,lease_token,state,started_at)
      SELECT job_id,fence,?,lease_token,'running',${DB_NOW} FROM earth_investigation_jobs
      WHERE state='running' AND lease_token=? AND lease_until>${DB_NOW} ON CONFLICT(job_id,fence) DO NOTHING`).bind(workerId, token),
  ], signal);
  const row = output[2]?.results?.[0];
  if (!row) return { configured: true, job: null };
  if (Number(output[3]?.meta?.changes) !== 1) throw failure('storage_unavailable');
  return { configured: true, job: lease(row) };
}

async function bodyText(message, limit, signal) {
  const size = message.headers?.get('content-length');
  if (size !== null && size !== undefined && (!/^\d+$/.test(size) || Number(size) > limit)) throw failure('response_limit');
  const reader = message.body?.getReader();
  if (!reader) throw failure('invalid_detail');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let count = 0, text = '';
  try {
    while (true) { const { value, done } = await abortable(reader.read(), signal); if (done) break;
      count += value.byteLength; if (count > limit) throw failure('response_limit'); text += decoder.decode(value, { stream: true }); }
    signal?.throwIfAborted(); return text + decoder.decode();
  } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
}
async function objectText(object, limit, signal) {
  if (!object || Number.isFinite(object.size) && object.size > limit) throw failure('storage_unavailable');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), INVESTIGATION_LIMITS.storageTimeoutMs);
  const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const text = object.body?.getReader ? await bodyText(new Response(object.body), limit, boundedSignal) : await io(() => object.text(), boundedSignal);
    if (typeof text !== 'string' || bytes(text) > limit) throw failure('storage_unavailable'); return text;
  } finally { clearTimeout(timer); }
}
async function immutable(env, key, text, expectedHash, limit, signal) {
  if (bytes(text) > limit || await sha256(text) !== expectedHash) throw failure('storage_unavailable');
  const saved = await io(() => env.EARTH_STORE.put(key, text, { onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: { contentType: 'application/json' } }), signal);
  if (saved === null) {
    const previous = await io(() => env.EARTH_STORE.get(key), signal);
    if (await sha256(await objectText(previous, limit, signal)) !== expectedHash) throw failure('storage_unavailable');
  }
}
const numberOrNull = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const shortText = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
function detailFacts(value, sourceRecordId, now) {
  const properties = value?.properties, geometry = value?.geometry, coordinates = geometry?.coordinates;
  if (value?.type !== 'Feature' || value.id !== sourceRecordId || !properties || Array.isArray(properties) ||
    geometry?.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 3 ||
    numberOrNull(coordinates[0], -180, 180) === null || numberOrNull(coordinates[1], -90, 90) === null ||
    numberOrNull(coordinates[2], -100, 1000) === null || !Number.isSafeInteger(properties.time) || properties.time < 0 ||
    properties.time > now + 300_000 || !Number.isSafeInteger(properties.updated) || properties.updated < 0 || properties.updated > now + 300_000)
    throw failure('invalid_detail');
  return { magnitude: numberOrNull(properties.mag, -5, 15), magnitudeType: shortText(properties.magType, 32),
    place: shortText(properties.place, 256), sourceEventTime: new Date(properties.time).toISOString(),
    sourceUpdatedAt: new Date(properties.updated).toISOString(), longitude: coordinates[0], latitude: coordinates[1], depthKm: coordinates[2],
    reviewStatus: shortText(properties.status, 32), reportedType: shortText(properties.type, 64),
    feltReports: numberOrNull(properties.felt, 0, 1_000_000_000), reportedIntensity: numberOrNull(properties.cdi, 0, 12),
    modeledIntensity: numberOrNull(properties.mmi, 0, 12), tsunamiFlag: properties.tsunami === 0 || properties.tsunami === 1 ? properties.tsunami : null };
}

async function acquireDetail(env, job, { now, fetchImpl, signal }) {
  signal.throwIfAborted();
  const bareId = providerId(job.sourceRecordId);
  if (!bareId || job.policyId !== USGS_DETAIL_POLICY.id) throw failure('invalid_detail');
  const current = await readWorldEvents(env, { id: job.eventId, limit: 1 }, { now });
  if (current.events?.[0]?.evidence?.revision !== job.inputRevision || current.events[0].evidence.sourceRecordId !== job.sourceRecordId)
    throw failure('input_changed');
  const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${bareId}.geojson`;
  const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(INVESTIGATION_LIMITS.fetchTimeoutMs)]);
  fetchSignal.throwIfAborted();
  let response;
  try { response = await abortable(fetchImpl(url, { signal: fetchSignal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } }), fetchSignal); }
  catch { throw failure(signal.aborted ? 'deadline' : 'upstream_unavailable'); }
  if (!response.ok) {
    const raw = response.headers.get('retry-after'), ms = /^\d+$/.test(raw || '') ? Number(raw) * 1000 : Date.parse(raw || '') - now();
    void response.body?.cancel();
    throw failure(response.status === 429 ? 'upstream_limit' : response.status === 404 ? 'upstream_not_found' : 'upstream_unavailable',
      Number.isFinite(ms) ? Math.max(0, Math.min(INVESTIGATION_LIMITS.retryMaximumMs, ms)) : 0);
  }
  if (!/^application\/(?:json|geo\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    void response.body?.cancel(); throw failure('invalid_detail');
  }
  const text = await bodyText(response, INVESTIGATION_LIMITS.detailBytes, fetchSignal);
  let value; try { value = JSON.parse(text); } catch { throw failure('invalid_detail'); }
  const facts = detailFacts(value, bareId, now()), acquiredAt = new Date(now()).toISOString();
  const rawSha256 = await sha256(text), rawKey = `investigations/usgs-detail/raw/${rawSha256}.json`;
  const refs = { rawKey, rawSha256 };
  try { await immutable(env, rawKey, text, rawSha256, INVESTIGATION_LIMITS.detailBytes, signal); }
  catch (error) { throw Object.assign(error, { partialRefs: refs }); }
  const artifact = { schemaVersion: 1, kind: USGS_DETAIL_POLICY.kind, policyId: job.policyId, jobId: job.jobId,
    eventId: job.eventId, inputRevision: job.inputRevision, acquiredAt,
    basis: { itemId: job.itemId, sourceRecordId: job.sourceRecordId, snapshotId: job.snapshotId, capturedAt: job.basisCapturedAt, recordedAt: job.basisRecordedAt },
    source: { id: 'usgs', sourceRecordId: job.sourceRecordId, providerEventId: bareId, url, rawKey, rawSha256, bytes: bytes(text) },
    reportedFacts: facts,
    citations: [ { sourceRecordId: job.sourceRecordId, sourceUrl: url, rawSha256, fields: ['/properties/mag', '/properties/magType', '/properties/place', '/properties/time',
      '/properties/updated', '/properties/status', '/properties/type', '/properties/felt', '/properties/cdi', '/properties/mmi', '/properties/tsunami', '/geometry/coordinates'] } ],
    meaning: 'Official USGS scientific metadata acquired at the stated time. It may contain source revisions later than the input summary; it is not knowledge available before acquisition.',
    limitations: 'No independent corroboration, causal inference, product downloads or AI-generated claims. USGS tsunami flag is not confirmation of an observed tsunami.' };
  const artifactText = JSON.stringify(artifact), artifactSha256 = await sha256(artifactText);
  const artifactKey = `investigations/usgs-detail/artifacts/${artifactSha256}.json`;
  Object.assign(refs, { artifactKey, artifactSha256 });
  try { await immutable(env, artifactKey, artifactText, artifactSha256, INVESTIGATION_LIMITS.artifactBytes, signal); }
  catch (error) { throw Object.assign(error, { partialRefs: refs }); }
  return refs;
}

async function finish(env, job, { refs, error }, signal) {
  const db = primary(env), success = Boolean(refs?.artifactKey && !error), code = errorCodes.has(error?.code) ? error.code : 'storage_unavailable';
  const terminal = ['upstream_not_found', 'invalid_detail', 'input_changed'].includes(code) || job.attemptCount >= USGS_DETAIL_POLICY.maxAttempts;
  const wait = Math.max(Math.min(60_000 * 2 ** (job.attemptCount - 1), 3_600_000), error?.retryAfterMs || 0);
  const output = await batch(db, [
    db.prepare(`UPDATE earth_investigation_jobs SET state=?,due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
      finished_at=CASE WHEN ? THEN ${DB_NOW} ELSE NULL END,updated_at=${DB_NOW},lease_token=NULL,lease_until=NULL,
      artifact_key=?,artifact_sha256=?,error_code=? WHERE job_id=? AND state='running' AND fence=? AND lease_token=? AND lease_until>${DB_NOW}
      AND EXISTS(SELECT 1 FROM earth_investigation_heads h WHERE h.job_id=earth_investigation_jobs.job_id)`)
      .bind(success ? 'succeeded' : terminal ? 'failed' : 'retry', `+${Math.ceil(wait / 1000)} seconds`, success || terminal ? 1 : 0,
        refs?.artifactKey || null, refs?.artifactSha256 || null, success ? null : code, job.jobId, job.fence, job.leaseToken),
    db.prepare(`UPDATE earth_investigation_attempts SET state=CASE
      WHEN EXISTS(SELECT 1 FROM earth_investigation_jobs j WHERE j.job_id=? AND j.fence=? AND j.state IN ('succeeded','retry','failed') AND j.lease_token IS NULL)
        THEN ? WHEN EXISTS(SELECT 1 FROM earth_investigation_jobs j WHERE j.job_id=? AND j.state='superseded') THEN 'superseded' ELSE 'lease_lost' END,
      finished_at=COALESCE(finished_at,${DB_NOW}),error_code=?,raw_key=COALESCE(?,raw_key),raw_sha256=COALESCE(?,raw_sha256),
      artifact_key=COALESCE(?,artifact_key),artifact_sha256=COALESCE(?,artifact_sha256)
      WHERE job_id=? AND fence=? AND lease_token=? AND state IN ('running','lease_expired','superseded')`)
      .bind(job.jobId, job.fence, success ? 'succeeded' : 'failed', job.jobId, success ? null : code,
        refs?.rawKey || null, refs?.rawSha256 || null, refs?.artifactKey || null, refs?.artifactSha256 || null,
        job.jobId, job.fence, job.leaseToken),
  ], signal);
  const row = (await rows(db, 'SELECT * FROM earth_investigation_jobs WHERE job_id=?', [job.jobId], signal))[0];
  if (!row) throw failure('storage_unavailable');
  return { configured: true, started: true, accepted: Number(output[0]?.meta?.changes) === 1, job: publicJob(row) };
}

/** One server-owned due job, one fixed official fetch. Caller must authorize the surrounding runner; no public route is added. */
export async function runInvestigationJob(env, { workerId } = {}, { now = Date.now, fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted();
  const claimed = await claimInvestigation(env, { workerId }, { signal });
  if (!claimed.job) return { configured: claimed.configured, started: false, accepted: false, job: null };
  const controller = new AbortController(), aborted = () => controller.abort();
  if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
  const timer = setTimeout(aborted, INVESTIGATION_LIMITS.runDeadlineMs);
  let refs;
  try {
    refs = await acquireDetail(env, claimed.job, { now, fetchImpl, signal: controller.signal });
    return await finish(env, claimed.job, { refs }, controller.signal);
  } catch (error) {
    try { return await finish(env, claimed.job, { refs: refs || error.partialRefs, error: controller.signal.aborted ? failure('deadline') : error }); }
    catch { return { configured: true, started: true, accepted: false, uncertain: true, readStatusBeforeRetry: true, jobId: claimed.job.jobId }; }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}

export async function readInvestigationJobs(env, input = {}) {
  if (!closed(input, ['eventId', 'limit']) || input.eventId !== undefined && !EVENT_ID.test(input.eventId) ||
    input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > INVESTIGATION_LIMITS.readLimit))
    throw new TypeError('Use a bounded investigation query');
  if (!await schema(env)) return { configured: false, jobs: [] };
  const jobs = await rows(primary(env), `SELECT * FROM earth_investigation_jobs ${input.eventId ? 'WHERE event_id=?' : ''}
    ORDER BY created_at DESC,job_id LIMIT ?`, [...(input.eventId ? [input.eventId] : []), input.limit ?? 20]);
  return { configured: true, jobs: jobs.map(publicJob) };
}

export async function readInvestigationArtifact(env, input = {}, { now = Date.now } = {}) {
  if (!closed(input, ['jobId', 'knownAt']) || !JOB_ID.test(input.jobId || '')) throw new TypeError('Use a retained investigation identity');
  const { jobId } = input, knownAt = input.knownAt === undefined ? new Date(now()).toISOString() : worldTime(input.knownAt);
  if (Date.parse(knownAt) > now() + 5000) throw new TypeError('Investigation knowledge cutoff is in the future');
  if (!await schema(env)) return { configured: false, available: false };
  const row = (await rows(primary(env), 'SELECT * FROM earth_investigation_jobs WHERE job_id=? AND state=\'succeeded\' AND finished_at<=?', [jobId, knownAt]))[0];
  if (!row || !isWorldDigest(row.artifact_sha256) || row.artifact_key !== `investigations/usgs-detail/artifacts/${row.artifact_sha256}.json`)
    return { configured: true, available: false };
  const text = await objectText(await io(() => env.EARTH_STORE.get(row.artifact_key)), INVESTIGATION_LIMITS.artifactBytes);
  if (await sha256(text) !== row.artifact_sha256) throw failure('storage_unavailable');
  const artifact = JSON.parse(text);
  if (artifact.jobId !== jobId || artifact.inputRevision !== row.input_revision || artifact.policyId !== USGS_DETAIL_POLICY.id) throw failure('storage_unavailable');
  if (Date.parse(worldTime(artifact.acquiredAt)) > Date.parse(knownAt)) return { configured: true, available: false };
  return { configured: true, available: true, knownAt, publishedAt: row.finished_at, job: publicJob(row), artifact };
}
