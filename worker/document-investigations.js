import { EC_DOCUMENT_POLICY as POLICY, createEcDocumentEvidence, createEcDocumentArtifact } from '../src/core/document-evidence.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from '../src/core/plugin-evidence.js';
import { decodeEcPress, ecPressItems } from './plugins/ec-press.js';

export const DOCUMENT_POLICY = Object.freeze({ ...POLICY, checkMs: 6 * 3600000, leaseMs: 90000, maxAttempts: 3 });
export const DOCUMENT_LIMITS = Object.freeze({ rawBytes: POLICY.rawBytes, contentBytes: 96 * 1024,
  basisBytes: 8 * 1024, storageMs: 2000, deadlineMs: 15000 });
const UTF8 = new TextEncoder(), DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')", ready = new WeakSet();
const JOB = /^document:[a-f0-9]{64}$/, RAW = /^document-raw:[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/, WORKER = /^[A-Za-z0-9_.:-]{1,64}$/;
const errors = new Set(['source_unavailable', 'source_limit', 'invalid_pdf', 'extractor_failed', 'resource_limit',
  'deadline', 'input_changed', 'storage_unavailable']);
const fixedItem = pluginBytesDigest(UTF8.encode(POLICY.pageUrl)).then(value => `publication:ec:${value}`);
const fixedJob = fixedItem.then(itemId => pluginFactsDigest([POLICY.pluginId, POLICY.scopeId, itemId, POLICY.id])).then(value => `document:${value}`);
const configured = env => Boolean(env?.EARTH_DB?.prepare && env?.EARTH_DB?.batch && env?.EARTH_STORE?.get && env?.EARTH_STORE?.put);
const primary = env => env.EARTH_DB.withSession?.('first-primary') || env.EARTH_DB;
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = code => Object.assign(new Error(code), { code });
function closed(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw new TypeError('Use the fixed document contract');
}
function identity(input, extra = []) {
  closed(input, ['jobId', 'fence', 'leaseToken', ...extra]);
  if (!JOB.test(input.jobId) || !Number.isSafeInteger(input.fence) || input.fence < 1 || !ID.test(input.leaseToken))
    throw new TypeError('Use the exact admitted document lease');
}
async function io(task, signal) {
  signal?.throwIfAborted(); const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DOCUMENT_LIMITS.storageMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let stop;
  try { return await Promise.race([Promise.resolve().then(() => { combined.throwIfAborted(); return task(); }),
    new Promise((_, reject) => { stop = () => reject(fail('storage_unavailable')); combined.addEventListener('abort', stop, { once: true }); if (combined.aborted) stop(); })]); }
  finally { clearTimeout(timer); combined.removeEventListener('abort', stop); }
}
async function rows(db, sql, values = [], signal) {
  const result = await io(() => db.prepare(sql).bind(...values).all(), signal);
  if (result?.success === false || !Array.isArray(result?.results)) throw fail('storage_unavailable');
  return result.results;
}
async function batch(db, statements, signal) {
  const result = await io(() => db.batch(statements), signal);
  if (!Array.isArray(result) || result.length !== statements.length || result.some(row => row?.success === false)) throw fail('storage_unavailable');
  return result;
}
async function schema(env) {
  if (!configured(env)) return false;
  if (ready.has(env.EARTH_DB)) return true;
  try {
    await batch(primary(env), [
      env.EARTH_DB.prepare('SELECT job_id,input_revision,fence,current_publication_id,last_raw_receipt_id,last_raw_observed_at FROM earth_document_work LIMIT 0'),
      env.EARTH_DB.prepare('SELECT job_id,fence,raw_request_digest,admission_token FROM earth_document_attempts LIMIT 0'),
      env.EARTH_DB.prepare('SELECT receipt_id,recorded_at,basis_json FROM earth_document_raw_receipts LIMIT 0'),
      env.EARTH_DB.prepare('SELECT receipt_id,recorded_at,request_digest FROM earth_document_publications LIMIT 0'),
    ]); ready.add(env.EARTH_DB); return true;
  } catch { return false; }
}
async function objectBytes(env, key, maximum, hash, signal) {
  const object = await io(() => env.EARTH_STORE.get(key), signal);
  if (!object || Number.isFinite(object.size) && object.size > maximum) throw fail('storage_unavailable');
  let bytes;
  if (object.body?.getReader) {
    const reader = object.body.getReader(), chunks = []; let size = 0;
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(DOCUMENT_LIMITS.storageMs)]) : AbortSignal.timeout(DOCUMENT_LIMITS.storageMs);
    try {
      for (;;) { const { value, done } = await io(() => reader.read(), bounded); if (done) break;
        size += value.byteLength; if (size > maximum) throw fail('storage_unavailable'); chunks.push(value); }
      bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  } else bytes = object.arrayBuffer ? new Uint8Array(await io(() => object.arrayBuffer(), signal)) : UTF8.encode(await io(() => object.text(), signal));
  if (bytes.byteLength > maximum || await pluginBytesDigest(bytes) !== hash) throw fail('evidence_digest_mismatch');
  return bytes;
}
async function immutable(env, key, bytes, hash, mediaType, signal) {
  if (await pluginBytesDigest(bytes) !== hash) throw fail('evidence_digest_mismatch');
  await io(() => env.EARTH_STORE.put(key, bytes, { onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: mediaType } }), signal);
  // Verify even a successful put, not only a colliding content-addressed object.
  const retained = await objectBytes(env, key, bytes.byteLength, hash, signal);
  if (retained.byteLength !== bytes.byteLength) throw fail('evidence_digest_mismatch');
}
const sourceCurrent = `EXISTS(SELECT 1 FROM earth_plugin_heads h JOIN earth_plugin_captures c ON c.receipt_id=h.receipt_id
  WHERE h.plugin_id=earth_document_work.plugin_id AND h.item_id=earth_document_work.item_id
    AND h.revision=earth_document_work.input_revision AND c.scope_id=earth_document_work.scope_id AND c.plugin_id=h.plugin_id)`;
const owned = `job_id=? AND fence=? AND lease_token=? AND state='running' AND lease_until>${DB_NOW} AND ${sourceCurrent}`;
const leaseValues = input => [input.jobId, input.fence, input.leaseToken];
async function work(db, jobId, signal) { return (await rows(db, `SELECT *,lease_until>${DB_NOW} AS lease_live,due_at<=${DB_NOW} AS is_due FROM earth_document_work WHERE job_id=?`, [jobId], signal))[0] || null; }
async function sourceRow(db, signal) {
  return (await rows(db, `SELECT h.revision,h.receipt_id,h.recorded_at,r.projection_json,r.first_recorded_at,
    c.captured_at,c.facts_digest,c.raw_sha256,c.artifact_sha256,c.source_updated_at,c.source_version
    FROM earth_plugin_heads h JOIN earth_plugin_revisions r ON r.plugin_id=h.plugin_id AND r.item_id=h.item_id AND r.revision=h.revision
    JOIN earth_plugin_captures c ON c.receipt_id=h.receipt_id
    JOIN earth_plugin_membership m ON m.receipt_id=h.receipt_id AND m.item_id=h.item_id AND m.revision=h.revision
    WHERE h.plugin_id=? AND h.item_id=? AND c.plugin_id=h.plugin_id AND c.scope_id=?`,
    [POLICY.pluginId, await fixedItem, POLICY.scopeId], signal))[0] || null;
}
async function retainedBasis(env, row, now, signal) {
  if (!row || !DIGEST.test(row.revision) || !DIGEST.test(row.facts_digest) || !DIGEST.test(row.raw_sha256) || !DIGEST.test(row.artifact_sha256) ||
      !/^receipt:[a-f0-9]{64}$/.test(row.receipt_id) || ![row.recorded_at,row.captured_at,row.first_recorded_at].every(stamp)) throw fail('source_basis_unavailable');
  const [factBytes, rawBytes] = await Promise.all([
    objectBytes(env, `plugins/${POLICY.pluginId}/facts/${row.facts_digest}`, 768 * 1024, row.facts_digest, signal),
    objectBytes(env, `plugins/${POLICY.pluginId}/raw/${row.raw_sha256}`, 512 * 1024, row.raw_sha256, signal),
  ]);
  const facts = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(factBytes));
  const decoded = await decodeEcPress(rawBytes, { now, guard: () => signal?.throwIfAborted() });
  if (await pluginFactsDigest(decoded.canonicalFacts) !== row.facts_digest || await pluginFactsDigest(facts) !== row.facts_digest)
    throw fail('source_basis_unavailable');
  const itemId = await fixedItem, source = ecPressItems(facts).find(item => item.itemId === itemId);
  const projection = JSON.parse(row.projection_json);
  if (!source || source.itemId !== await fixedItem || source.sourceRevision !== row.revision || source.url !== POLICY.pageUrl || source.title !== POLICY.title ||
      projection.revision !== row.revision || ['itemId','kind','title','url','sourceRecordId','publishedAt','publishedRaw','publishedPrecision','documentReference','documentType','categories']
        .some(key => pluginJson(projection[key]) !== pluginJson(source[key]))) throw fail('source_basis_unavailable');
  const basis = { pluginId: POLICY.pluginId, scopeId: POLICY.scopeId, item: { ...projection, firstRecordedAt: row.first_recorded_at,
    lastRecordedAt: row.recorded_at, evidence: { id: row.receipt_id, capturedAt: row.captured_at, recordedAt: row.recorded_at,
      factsDigest: row.facts_digest, rawSha256: row.raw_sha256, artifactSha256: row.artifact_sha256,
      sourceUpdatedAt: row.source_updated_at, sourceVersion: row.source_version, locator: { kind: 'rss-guid', guid: projection.sourceRecordId } } } };
  if (UTF8.encode(pluginJson(basis)).byteLength > DOCUMENT_LIMITS.basisBytes) throw fail('source_basis_unavailable');
  return basis;
}
function jobView(row, includeLease = false) {
  if (!row) return null;
  return { jobId: row.job_id, inputRevision: row.input_revision, subject: { kind: 'publication-item', pluginId: row.plugin_id,
    scopeId: row.scope_id, itemId: row.item_id }, policyId: row.policy_id, state: row.state, dueAt: row.due_at,
    checkedAt: row.checked_at, fence: row.fence, attemptCount: row.attempt_count, errorCode: row.error_code, lastBodyObservedAt: row.last_raw_observed_at,
    ...(includeLease ? { basis: JSON.parse(row.basis_json), leaseToken: row.lease_token, leaseUntil: row.lease_until, sourceUrl: POLICY.downloadUrl } : {}) };
}
function rawView(row) { return row ? { id: row.receipt_id, rawSha256: row.raw_sha256, bytes: row.raw_bytes,
  acquiredAt: row.acquired_at, recordedAt: row.recorded_at, inputRevision: row.input_revision, basisReceiptId: row.basis_receipt_id } : null; }
function publicationView(row) { return row ? { id: row.receipt_id, recordedAt: row.recorded_at, acquiredAt: row.acquired_at,
  rawReceiptId: row.raw_receipt_id, rawSha256: row.raw_sha256, inputRevision: row.input_revision, contentSha256: row.content_sha256 } : null; }
const base = fields => ({ schemaVersion: 1, configured: true, ...fields });

/** Fixed subject admission and one durable lease; no provider acquisition. Body
 * checks are independently due every six hours even when RSS metadata is quiet. */
export async function claimDocumentInvestigation(env, input, { now = Date.now, signal } = {}) {
  closed(input, ['workerId', 'claimId']);
  if (!WORKER.test(input.workerId) || !ID.test(input.claimId)) throw new TypeError('Use a bounded producer claim identity');
  if (!await schema(env)) return { schemaVersion: 1, configured: false, status: 'unavailable', job: null };
  const db = primary(env), jobId = await fixedJob, existing = await work(db, jobId, signal), source = await sourceRow(db, signal);
  if (!source) return base({ status: 'source-unavailable', job: null });
  if (!existing || existing.input_revision !== source.revision) {
    const basis = await retainedBasis(env, source, now, signal), serialized = pluginJson(basis);
    await batch(db, [
      db.prepare(`INSERT INTO earth_document_work
        (job_id,subject_kind,plugin_id,scope_id,item_id,policy_id,input_revision,basis_receipt_id,basis_json,state,due_at,attempt_count,fence,created_at,updated_at)
        SELECT ?,'publication-item',?,?,?,?,?,?,?,'pending',${DB_NOW},0,0,${DB_NOW},${DB_NOW}
        WHERE EXISTS(SELECT 1 FROM earth_plugin_heads h WHERE h.plugin_id=? AND h.item_id=? AND h.revision=?)
        ON CONFLICT(job_id) DO UPDATE SET input_revision=excluded.input_revision,basis_receipt_id=excluded.basis_receipt_id,
        basis_json=excluded.basis_json,state='pending',due_at=${DB_NOW},attempt_count=0,fence=earth_document_work.fence+1,
        worker_id=NULL,claim_id=NULL,lease_token=NULL,lease_until=NULL,current_raw_receipt_id=NULL,current_acquired_at=NULL,error_code=NULL,updated_at=${DB_NOW}
        WHERE earth_document_work.input_revision<>excluded.input_revision`)
        .bind(jobId,POLICY.pluginId,POLICY.scopeId,await fixedItem,POLICY.id,source.revision,source.receipt_id,serialized,POLICY.pluginId,await fixedItem,source.revision),
      db.prepare(`UPDATE earth_document_attempts SET state='superseded',finished_at=COALESCE(finished_at,${DB_NOW}),error_code='input_changed'
        WHERE job_id=? AND state='running' AND input_revision<>(SELECT input_revision FROM earth_document_work WHERE job_id=?)`).bind(jobId,jobId),
    ], signal);
  }
  const before = await work(db, jobId, signal);
  if (!before || before.input_revision !== source.revision) return base({ status: 'input-changed', job: null });
  if (before.state === 'running' && before.lease_live) return base({ status: before.claim_id === input.claimId && before.worker_id === input.workerId ? 'leased' : 'busy',
    job: before.claim_id === input.claimId && before.worker_id === input.workerId ? jobView(before,true) : null });
  if (!before.is_due) return base({ status: 'not-due', job: null, dueAt: before.due_at });
  const token = nonce();
  await batch(db, [
    db.prepare(`UPDATE earth_document_attempts SET state='lease-expired',finished_at=COALESCE(finished_at,${DB_NOW}),error_code='deadline'
      WHERE job_id=? AND state='running' AND EXISTS(SELECT 1 FROM earth_document_work w WHERE w.job_id=? AND w.fence=earth_document_attempts.fence AND w.lease_until<=${DB_NOW})`).bind(jobId,jobId),
    db.prepare(`UPDATE earth_document_work SET state='failed',error_code='deadline',lease_token=NULL,lease_until=NULL,due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+6 hours'),updated_at=${DB_NOW}
      WHERE job_id=? AND state='running' AND lease_until<=${DB_NOW} AND attempt_count>=?`).bind(jobId,DOCUMENT_POLICY.maxAttempts),
    db.prepare(`UPDATE earth_document_work SET state='running',attempt_count=CASE WHEN state IN ('succeeded','failed') THEN 1 ELSE attempt_count+1 END,
      fence=fence+1,worker_id=?,claim_id=?,lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 seconds'),
      current_raw_receipt_id=NULL,current_acquired_at=NULL,error_code=NULL,updated_at=${DB_NOW}
      WHERE job_id=? AND due_at<=${DB_NOW} AND (state IN ('pending','retry','succeeded','failed') OR state='running' AND lease_until<=${DB_NOW})
      AND (state IN ('succeeded','failed') OR attempt_count<?) AND ${sourceCurrent}`)
      .bind(input.workerId,input.claimId,token,jobId,DOCUMENT_POLICY.maxAttempts),
    db.prepare(`INSERT INTO earth_document_attempts (job_id,fence,claim_id,worker_id,input_revision,basis_receipt_id,state,started_at)
      SELECT job_id,fence,claim_id,worker_id,input_revision,basis_receipt_id,'running',${DB_NOW} FROM earth_document_work
      WHERE job_id=? AND lease_token=? AND state='running' ON CONFLICT(job_id,fence) DO NOTHING`).bind(jobId,token),
  ], signal);
  const saved = await work(db, jobId, signal);
  return base({ status: saved?.lease_token === token ? 'leased' : 'busy', job: saved?.lease_token === token ? jobView(saved,true) : null });
}

export async function retainDocumentRaw(env, input, { now = Date.now, signal } = {}) {
  identity(input,['acquiredAt','rawBytes']);
  if(input.jobId!==await fixedJob)throw new TypeError('Use the fixed document subject');
  if (!stamp(input.acquiredAt) || Date.parse(input.acquiredAt)>now()+300000 || !(input.rawBytes instanceof Uint8Array) ||
      input.rawBytes.byteLength<8 || input.rawBytes.byteLength>POLICY.rawBytes || !/^%PDF-1\.[0-7]/.test(new TextDecoder().decode(input.rawBytes.subarray(0,8))))
    throw new TypeError('Use bounded original PDF bytes and acquisition date');
  if (!await schema(env)) return { schemaVersion:1,configured:false,status:'unavailable',stored:false };
  const db=primary(env), rawSha=await pluginBytesDigest(input.rawBytes);
  const current=(await rows(db,`SELECT * FROM earth_document_work WHERE ${owned}`,leaseValues(input),signal))[0];
  if (!current) return base({status:'superseded',stored:false});
  const rawId=`document-raw:${await pluginFactsDigest([input.jobId,rawSha])}`;
  const attempt=(await rows(db,'SELECT * FROM earth_document_attempts WHERE job_id=? AND fence=?',[input.jobId,input.fence],signal))[0];
  const requestDigest=await pluginFactsDigest([input.jobId,input.fence,rawSha,input.acquiredAt]);
  if (attempt?.raw_request_digest && attempt.raw_request_digest!==requestDigest) return base({status:'conflict',stored:false});
  const previous=current.current_publication_id ? (await rows(db,'SELECT * FROM earth_document_publications WHERE receipt_id=?',[current.current_publication_id],signal))[0] : null;
  const unchanged=Boolean(previous?.input_revision===current.input_revision && previous.raw_sha256===rawSha);
  if (unchanged) await objectBytes(env,previous.content_key,DOCUMENT_LIMITS.contentBytes,previous.content_sha256,signal);
  const key=`documents/${POLICY.id}/raw/${rawSha}`;
  await immutable(env,key,input.rawBytes,rawSha,'application/pdf',signal);
  const admission=nonce(), admitted=`EXISTS(SELECT 1 FROM earth_document_attempts a WHERE a.job_id=earth_document_work.job_id AND a.fence=? AND a.admission_token=?)`;
  const committed=await batch(db,[
    db.prepare(`UPDATE earth_document_attempts SET raw_receipt_id=?,raw_request_digest=?,raw_acquired_at=?,admission_token=?
      WHERE job_id=? AND fence=? AND state='running' AND (raw_request_digest IS NULL OR raw_request_digest=?)
      AND EXISTS(SELECT 1 FROM earth_document_work WHERE ${owned} AND (current_raw_receipt_id IS NULL OR current_raw_receipt_id=?))
      AND ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+305 seconds')`)
      .bind(rawId,requestDigest,input.acquiredAt,admission,input.jobId,input.fence,requestDigest,...leaseValues(input),rawId,input.acquiredAt),
    db.prepare(`INSERT INTO earth_document_raw_receipts
      (receipt_id,job_id,input_revision,basis_receipt_id,basis_json,raw_sha256,raw_bytes,raw_key,acquired_at,recorded_at)
      SELECT ?,job_id,input_revision,basis_receipt_id,basis_json,?,?,?,?,${DB_NOW} FROM earth_document_work WHERE job_id=? AND ${admitted}
      ON CONFLICT(receipt_id) DO NOTHING`)
      .bind(rawId,rawSha,input.rawBytes.byteLength,key,input.acquiredAt,input.jobId,input.fence,admission),
    db.prepare(`UPDATE earth_document_work SET current_raw_receipt_id=?,current_acquired_at=?,last_raw_receipt_id=?,last_raw_observed_at=?,updated_at=${DB_NOW},
      state=CASE WHEN ? THEN 'succeeded' ELSE state END,checked_at=CASE WHEN ? THEN ${DB_NOW} ELSE checked_at END,
      due_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+6 hours') ELSE due_at END,
      lease_token=CASE WHEN ? THEN NULL ELSE lease_token END,lease_until=CASE WHEN ? THEN NULL ELSE lease_until END
      WHERE job_id=? AND fence=? AND lease_token=? AND state='running' AND ${admitted}
      AND EXISTS(SELECT 1 FROM earth_document_raw_receipts WHERE receipt_id=?)`)
      .bind(rawId,input.acquiredAt,rawId,input.acquiredAt,Number(unchanged),Number(unchanged),Number(unchanged),Number(unchanged),Number(unchanged),...leaseValues(input),input.fence,admission,rawId),
    db.prepare(`UPDATE earth_document_attempts SET state='succeeded',finished_at=${DB_NOW},publication_id=? WHERE job_id=? AND fence=? AND admission_token=?
      AND EXISTS(SELECT 1 FROM earth_document_work w WHERE w.job_id=? AND w.fence=? AND w.state='succeeded' AND w.current_raw_receipt_id=?)`)
      .bind(previous?.receipt_id||null,input.jobId,input.fence,admission,input.jobId,input.fence,rawId),
  ],signal);
  const saved=await work(db,input.jobId,signal), raw=(await rows(db,'SELECT * FROM earth_document_raw_receipts WHERE receipt_id=?',[rawId],signal))[0];
  const accepted=Number(committed[0]?.meta?.changes)===1&&saved?.fence===input.fence && saved.current_raw_receipt_id===rawId && raw;
  return base({status:!accepted?'superseded':unchanged?'checked':'retained',stored:Boolean(accepted),changed:accepted?!unchanged:null,
    receipt:accepted?rawView(raw):null,rawReceipt:accepted?rawView(raw):null,publication:accepted&&unchanged?publicationView(previous):null,
    job:jobView(saved),current:Boolean(accepted)});
}

function executionProof(value) {
  const keys=['mode','memoryMeaning','processMemoryLimitBytes','jobMemoryLimitBytes','processesLimit','wallSeconds','inputBytesLimit',
    'stdoutBytesLimit','stderrBytesLimit','nativeReportedPeakProcessBytes','nativeReportedPeakJobBytes','activeProcessesAfterCleanup',
    'jobListAppliedBeforeExecution','hostAlreadyInJob','exitCode','environment'];
  closed(value,keys);
  if (value.mode!=='windows-job-object'||value.memoryMeaning!=='committed-virtual-memory'||value.processMemoryLimitBytes!==64*1024*1024||
      value.jobMemoryLimitBytes!==96*1024*1024||value.processesLimit!==2||value.wallSeconds!==20||value.inputBytesLimit!==512*1024||
      value.stdoutBytesLimit!==1024*1024||value.stderrBytesLimit!==64*1024||value.activeProcessesAfterCleanup!==0||value.exitCode!==0||
      value.jobListAppliedBeforeExecution!==true||typeof value.hostAlreadyInJob!=='boolean'||value.environment!=='minimal-without-producer-credentials'||
      ['nativeReportedPeakProcessBytes','nativeReportedPeakJobBytes'].some(key=>!Number.isSafeInteger(value[key])||value[key]<0||value[key]>512*1024*1024))
    throw new TypeError('Use the reviewed Windows execution proof');
}
export async function completeDocumentInvestigation(env,input,{now=Date.now,signal}={}) {
  identity(input,['rawReceiptId','extraction','citations','execution']);
  if(input.jobId!==await fixedJob)throw new TypeError('Use the fixed document subject');
  if (!RAW.test(input.rawReceiptId)) throw new TypeError('Use one retained PDF receipt');
  executionProof(input.execution);
  if (!await schema(env)) return {schemaVersion:1,configured:false,status:'unavailable',stored:false};
  const db=primary(env), requestDigest=await pluginFactsDigest(input), publicationId=`document-analysis:${await pluginFactsDigest([input.jobId,input.fence])}`;
  const existing=(await rows(db,'SELECT * FROM earth_document_publications WHERE job_id=? AND fence=?',[input.jobId,input.fence],signal))[0];
  if (existing) return base({status:existing.request_digest===requestDigest?'published':'conflict',stored:existing.request_digest===requestDigest,
    changed:true,receipt:existing.request_digest===requestDigest?publicationView(existing):null});
  const current=(await rows(db,`SELECT * FROM earth_document_work WHERE ${owned} AND current_raw_receipt_id=?`,[...leaseValues(input),input.rawReceiptId],signal))[0];
  const raw=(await rows(db,'SELECT * FROM earth_document_raw_receipts WHERE receipt_id=? AND job_id=?',[input.rawReceiptId,input.jobId],signal))[0];
  if (!current||!raw) return base({status:'superseded',stored:false});
  const bytes=await objectBytes(env,raw.raw_key,POLICY.rawBytes,raw.raw_sha256,signal);
  if (bytes.byteLength!==raw.raw_bytes) throw fail('evidence_digest_mismatch');
  // Body identity/first retention is independent of corrected RSS metadata. The
  // analysis uses its current admitted work basis; the raw receipt keeps its own
  // original basis unchanged and remains linked explicitly in the content.
  const evidence=await createEcDocumentEvidence(JSON.parse(current.basis_json),bytes,input.extraction),artifact=await createEcDocumentArtifact(evidence,input.citations);
  const content={schemaVersion:1,kind:'retained-attributed-document-analysis',policyId:POLICY.id,subject:jobView(current).subject,
    inputRevision:current.input_revision,basis:evidence.basis,source:evidence.source,rawReceipt:rawView(raw),extraction:evidence.extraction,
    statements:artifact.statements,codec:{evidenceRevision:evidence.revision,artifactRevision:artifact.revision},
    execution:input.execution,executionMeaning:'Authenticated producer-reported native execution accounting; not remote hardware attestation.',
    attribution:artifact.attribution,limitations:artifact.limitations,
    knowledge:{metadataRecordedAt:evidence.knowledge.metadataRecordedAt,documentRecordedAt:raw.recorded_at}};
  const contentBytes=UTF8.encode(pluginJson(content));
  if (contentBytes.byteLength>DOCUMENT_LIMITS.contentBytes) throw new TypeError('Document content exceeds its bound');
  const contentHash=await pluginBytesDigest(contentBytes),key=`documents/${POLICY.id}/analysis/${contentHash}`;
  await immutable(env,key,contentBytes,contentHash,'application/json',signal);
  const admitted='EXISTS(SELECT 1 FROM earth_document_publications p WHERE p.receipt_id=? AND p.request_digest=?)';
  await batch(db,[
    db.prepare(`INSERT INTO earth_document_publications
      (receipt_id,job_id,fence,input_revision,raw_receipt_id,raw_sha256,content_sha256,content_key,content_bytes,acquired_at,recorded_at,request_digest)
      SELECT ?,job_id,fence,input_revision,?,?,?,?,?,current_acquired_at,${DB_NOW},? FROM earth_document_work
      WHERE ${owned} AND current_raw_receipt_id=? AND EXISTS(SELECT 1 FROM earth_document_attempts a WHERE a.job_id=earth_document_work.job_id
        AND a.fence=earth_document_work.fence AND a.state='running' AND a.raw_receipt_id=?)
      ON CONFLICT(job_id,fence) DO NOTHING`)
      .bind(publicationId,input.rawReceiptId,raw.raw_sha256,contentHash,key,contentBytes.byteLength,requestDigest,...leaseValues(input),input.rawReceiptId,input.rawReceiptId),
    db.prepare(`UPDATE earth_document_work SET state='succeeded',checked_at=${DB_NOW},due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+6 hours'),
      current_publication_id=?,lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=${DB_NOW}
      WHERE job_id=? AND fence=? AND lease_token=? AND state='running' AND ${admitted}`)
      .bind(publicationId,...leaseValues(input),publicationId,requestDigest),
    db.prepare(`UPDATE earth_document_attempts SET state='succeeded',finished_at=(SELECT recorded_at FROM earth_document_publications WHERE receipt_id=?),
      publication_id=?,error_code=NULL WHERE job_id=? AND fence=? AND state='running' AND ${admitted}`)
      .bind(publicationId,publicationId,input.jobId,input.fence,publicationId,requestDigest),
  ],signal);
  const retained=(await rows(db,'SELECT * FROM earth_document_publications WHERE receipt_id=? AND request_digest=?',[publicationId,requestDigest],signal))[0];
  return base({status:retained?'published':'superseded',stored:Boolean(retained),changed:true,receipt:publicationView(retained),job:jobView(await work(db,input.jobId,signal))});
}

export async function failDocumentInvestigation(env,input,{signal}={}) {
  identity(input,['errorCode']); if(!errors.has(input.errorCode)) throw new TypeError('Use a reviewed failure code');
  if(input.jobId!==await fixedJob)throw new TypeError('Use the fixed document subject');
  if(!await schema(env)) return {schemaVersion:1,configured:false,status:'unavailable',stored:false};
  const db=primary(env), current=await work(db,input.jobId,signal);
  const terminal=['invalid_pdf','input_changed'].includes(input.errorCode)||current?.attempt_count>=DOCUMENT_POLICY.maxAttempts;
  const admission=nonce(),due=terminal?'+6 hours':`+${60*2**Math.max(0,(current?.attempt_count||1)-1)} seconds`;
  await batch(db,[
    db.prepare(`UPDATE earth_document_attempts SET admission_token=?,error_code=? WHERE job_id=? AND fence=? AND state='running'
      AND EXISTS(SELECT 1 FROM earth_document_work WHERE ${owned})`).bind(admission,input.errorCode,input.jobId,input.fence,...leaseValues(input)),
    db.prepare(`UPDATE earth_document_work SET state=?,due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),error_code=?,lease_token=NULL,lease_until=NULL,updated_at=${DB_NOW}
      WHERE job_id=? AND fence=? AND state='running' AND EXISTS(SELECT 1 FROM earth_document_attempts a WHERE a.job_id=earth_document_work.job_id
        AND a.fence=? AND a.admission_token=?)`).bind(terminal?'failed':'retry',due,input.errorCode,input.jobId,input.fence,input.fence,admission),
    db.prepare(`UPDATE earth_document_attempts SET state='failed',finished_at=${DB_NOW} WHERE job_id=? AND fence=? AND admission_token=?`)
      .bind(input.jobId,input.fence,admission),
  ],signal);
  const saved=await work(db,input.jobId,signal);
  return base({status:saved?.fence===input.fence&&!saved.lease_token?saved.state:'superseded',stored:false,job:jobView(saved)});
}

/** Private authenticated status can recover an exact active claim, never enqueue.
 * Attempts remain addressable after later checks/corrections advance the work row. */
export async function readDocumentStatus(env,input={}, {signal}={}) {
  closed(input,[],['claimId','jobId','fence']);
  if(input.claimId!==undefined&&(!ID.test(input.claimId)||input.jobId!==undefined||input.fence!==undefined)||
      input.jobId!==undefined&&(!JOB.test(input.jobId)||!Number.isSafeInteger(input.fence)||input.fence<1)||
      input.fence!==undefined&&input.jobId===undefined) throw new TypeError('Use one exact claim or attempt identity');
  if(input.jobId!==undefined&&input.jobId!==await fixedJob)throw new TypeError('Use the fixed document subject');
  if(!await schema(env)) return {schemaVersion:1,configured:false,status:'unavailable',available:false,job:null,attemptFound:false};
  const db=primary(env), current=await work(db,input.jobId||await fixedJob,signal);
  const attempt=input.claimId?(await rows(db,'SELECT * FROM earth_document_attempts WHERE claim_id=? AND job_id=? ORDER BY fence DESC LIMIT 1',[input.claimId,await fixedJob],signal))[0]:
    input.fence?(await rows(db,'SELECT * FROM earth_document_attempts WHERE job_id=? AND fence=?',[input.jobId,input.fence],signal))[0]:null;
  const raw=attempt?.raw_receipt_id?(await rows(db,'SELECT * FROM earth_document_raw_receipts WHERE receipt_id=?',[attempt.raw_receipt_id],signal))[0]:null;
  const published=attempt?.publication_id?(await rows(db,'SELECT * FROM earth_document_publications WHERE receipt_id=?',[attempt.publication_id],signal))[0]:null;
  if((input.claimId||input.fence)&&!attempt)return base({status:'absent',available:false,job:null,attemptFound:false,attempt:null,rawReceipt:null,publication:null});
  const source=attempt?.state==='running'?await sourceRow(db,signal):null;
  const effective=attempt?.state==='running'?(attempt.fence!==current?.fence||attempt.input_revision!==source?.revision?'superseded':
    !current.lease_live?'lease-expired':'running'):attempt?.state;
  const recover=Boolean(input.claimId&&current?.claim_id===input.claimId&&effective==='running'&&attempt?.fence===current.fence);
  return base({status:recover?'leased':effective||current?.state||'absent',available:Boolean(current),job:jobView(current,recover),attemptFound:Boolean(attempt),
    attempt:attempt?{jobId:attempt.job_id,claimId:attempt.claim_id,fence:attempt.fence,state:effective,retainedState:attempt.state,inputRevision:attempt.input_revision,rawReceiptId:attempt.raw_receipt_id,
      publicationId:attempt.publication_id,finishedAt:attempt.finished_at,errorCode:attempt.error_code}:null,
    rawReceipt:rawView(raw),publication:publicationView(published)});
}

/** Stored-only knowledge read: only actually admitted complete analysis receipts.
 * Later checks are not leaked into a historical view and never acquire work. */
export async function readDocumentAnalysis(env,{knownAt=null}={}, {now=Date.now,signal}={}) {
  if(knownAt!==null&&(!stamp(knownAt)||Date.parse(knownAt)>now()+5000)) throw new TypeError('Use a canonical, bounded knowledge cutoff');
  if(!await schema(env)) return {schemaVersion:1,configured:false,status:'unavailable',available:false};
  const db=primary(env),jobId=await fixedJob;
  const select=`SELECT p.* FROM earth_document_publications p JOIN earth_document_raw_receipts r ON r.receipt_id=p.raw_receipt_id
    WHERE p.job_id=?${knownAt?' AND p.recorded_at<=? AND r.recorded_at<=?':''} ORDER BY p.recorded_at DESC,p.fence DESC LIMIT 1`;
  const values=[jobId,...(knownAt?[knownAt,knownAt]:[])];
  for(let attempt=0;attempt<2;attempt++) {
  const row=(await rows(db,select,values,signal))[0];
  if(!row) return base({status:'unavailable',available:false,knownAt,explanation:'No complete document analysis was admitted by this knowledge cutoff.'});
  if(row.content_key!==`documents/${POLICY.id}/analysis/${row.content_sha256}`||!DIGEST.test(row.content_sha256)||row.content_bytes>DOCUMENT_LIMITS.contentBytes)
    throw fail('evidence_digest_mismatch');
  const bytes=await objectBytes(env,row.content_key,DOCUMENT_LIMITS.contentBytes,row.content_sha256,signal);
  if(bytes.byteLength!==row.content_bytes) throw fail('evidence_digest_mismatch');
  const content=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(content.policyId!==POLICY.id||content.inputRevision!==row.input_revision||content.rawReceipt?.id!==row.raw_receipt_id||content.rawReceipt.rawSha256!==row.raw_sha256)
    throw fail('evidence_digest_mismatch');
  const current=knownAt?null:await work(db,jobId,signal),source=knownAt?null:await sourceRow(db,signal);
  const latestRaw=current?.last_raw_receipt_id?(await rows(db,'SELECT raw_sha256 FROM earth_document_raw_receipts WHERE receipt_id=?',[current.last_raw_receipt_id],signal))[0]:null;
  if((await rows(db,select,values,signal))[0]?.receipt_id!==row.receipt_id)continue;
  return base({status:'available',available:true,knownAt,receipt:publicationView(row),content,
    knowledge:{metadataRecordedAt:content.knowledge.metadataRecordedAt,documentRecordedAt:content.knowledge.documentRecordedAt,analysisPublishedAt:row.recorded_at},
    ...(knownAt?{currentInputMatches:null,bodyCheck:null}:{currentInputMatches:source?.revision===row.input_revision,
      latestBodyMatches:latestRaw?latestRaw.raw_sha256===row.raw_sha256:null,bodyCheck:jobView(current)}),
    scope:'Completed retained analysis at database knowledge time; source statements remain attributed, not independently verified.'});
  }
  return base({status:'unavailable',available:false,knownAt,errorCode:'document-edition-changed',explanation:'Complete analysis changed during delivery; retry the stored view.'});
}
