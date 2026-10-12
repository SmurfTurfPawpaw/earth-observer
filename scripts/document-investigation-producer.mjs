import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, lstat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EC_DOCUMENT_POLICY as P, createEcDocumentEvidence, createEcDocumentArtifact } from '../src/core/document-evidence.js';
import { pluginJson } from '../src/core/plugin-evidence.js';

export const DOCUMENT_PRODUCER_URL = 'https://giovannicallebaut.com/earth/api/document-investigations/producer';
const SIGNED_PATH = '/api/document-investigations/producer', MAX_BODY = 768 * 1024, MAX_RESPONSE = 256 * 1024, MAX_STATE = 2 * 1024 * 1024;
const KEY = /^[A-Za-z0-9_-]{43,128}$/, HEX = /^[a-f0-9]{64}$/, TOKEN = /^[a-f0-9]{32}$/;
const JOB = /^document:[a-f0-9]{64}$/, RAW = /^document-raw:[a-f0-9]{64}$/, PUBLICATION = /^document-analysis:[a-f0-9]{64}$/;
const ERRORS = new Set(['source_unavailable', 'source_limit', 'invalid_pdf', 'extractor_failed', 'resource_limit', 'deadline', 'input_changed', 'storage_unavailable']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FIXED_ITEM = `publication:ec:${sha(P.pageUrl)}`;
const FIXED_JOB = `document:${sha(pluginJson([P.pluginId, P.scopeId, FIXED_ITEM, P.id]))}`;
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

function active(work, signal) {
  if (signal.aborted) { void Promise.resolve(work).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((accept, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(accept, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readBytes(response, signal, limit, mediaType, errorCode) {
  const length = response.headers.get('content-length');
  if (!response.ok || response.redirected || !mediaType.test(response.headers.get('content-type') || '') || !response.body ||
      length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {}); fail(errorCode);
  }
  const reader = response.body.getReader(), parts = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await active(reader.read(), signal); signal.throwIfAborted();
      if (part.done) break; size += part.value.byteLength; if (size > limit) fail(errorCode); parts.push(part.value);
    }
    const bytes = Buffer.concat(parts, size); return bytes;
  } catch (error) { abort(); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function validateLease(job) {
  if (!object(job) || job.jobId !== FIXED_JOB || !HEX.test(job.inputRevision) || !Number.isSafeInteger(job.fence) || job.fence < 1 ||
      !TOKEN.test(job.leaseToken) || !utc(job.leaseUntil) || job.sourceUrl !== P.downloadUrl ||
      job.subject?.kind !== 'publication-item' || job.subject.pluginId !== P.pluginId || job.subject.scopeId !== P.scopeId ||
      job.basis?.pluginId !== P.pluginId || job.basis.scopeId !== P.scopeId || job.subject.itemId !== job.basis.item?.itemId ||
      job.basis.item?.itemId !== FIXED_ITEM || job.basis.item.documentReference !== P.documentReference || job.basis.item.title !== P.title ||
      job.basis.item.url !== P.pageUrl || job.basis.item.sourceRecordId !== P.pageUrl ||
      job.basis.item.kind !== 'original-publication' || !HEX.test(job.basis.item.revision)) fail('input_changed');
  return job;
}
function rawBytes(body) {
  if (typeof body.rawPdfBase64 !== 'string' || body.rawPdfBase64.length > 4 * Math.ceil(P.rawBytes / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.rawPdfBase64)) fail('invalid_pdf');
  const bytes = Buffer.from(body.rawPdfBase64, 'base64');
  if (bytes.length < 8 || bytes.length > P.rawBytes || bytes.toString('base64') !== body.rawPdfBase64 ||
      !/^%PDF-1\.[0-7]/.test(bytes.subarray(0, 8).toString('ascii')) || !utc(body.acquiredAt)) fail('invalid_pdf');
  return bytes;
}
function validRaw(receipt, bytes) {
  return object(receipt) && RAW.test(receipt.id) && receipt.rawSha256 === sha(bytes) && receipt.bytes === bytes.length && utc(receipt.acquiredAt) && utc(receipt.recordedAt);
}
function validPublication(receipt, lease, raw) {
  return object(receipt) && PUBLICATION.test(receipt.id) && utc(receipt.recordedAt) && receipt.rawReceiptId === raw.id &&
    receipt.rawSha256 === raw.rawSha256 && receipt.inputRevision === lease.inputRevision;
}
function validateJournal(value) {
  if (value === null) return null;
  if (!exact(value, ['schemaVersion', 'claimId', 'lease', 'pending', 'raw']) || value.schemaVersion !== 1 || !TOKEN.test(value.claimId)) fail('storage_unavailable');
  if (value.lease !== null) validateLease(value.lease);
  if (value.raw !== null) {
    if (!value.lease || !exact(value.raw, ['body', 'receipt'])) fail('storage_unavailable');
    const body = value.raw.body, bytes = rawBytes(body);
    if (!exact(body, ['schemaVersion', 'operation', 'jobId', 'fence', 'leaseToken', 'acquiredAt', 'rawPdfBase64']) || body.schemaVersion !== 1 || body.operation !== 'raw' ||
        body.jobId !== value.lease.jobId || body.fence !== value.lease.fence || body.leaseToken !== value.lease.leaseToken || !validRaw(value.raw.receipt, bytes)) fail('storage_unavailable');
  }
  if (value.pending !== null) {
    if (!exact(value.pending, ['operation', 'body', 'digest']) || typeof value.pending.body !== 'string' ||
        Buffer.byteLength(value.pending.body) > MAX_BODY || value.pending.digest !== sha(value.pending.body)) fail('storage_unavailable');
    let body; try { body = JSON.parse(value.pending.body); } catch { fail('storage_unavailable'); }
    const fields = { claim: ['schemaVersion', 'operation', 'workerId', 'claimId'], raw: ['schemaVersion', 'operation', 'jobId', 'fence', 'leaseToken', 'acquiredAt', 'rawPdfBase64'],
      complete: ['schemaVersion', 'operation', 'jobId', 'fence', 'leaseToken', 'rawReceiptId', 'extraction', 'citations', 'execution'],
      fail: ['schemaVersion', 'operation', 'jobId', 'fence', 'leaseToken', 'errorCode'] };
    if (!Object.hasOwn(fields, body.operation) || value.pending.operation !== body.operation || body.schemaVersion !== 1 || !exact(body, fields[body.operation]) ||
        body.operation === 'claim' && (body.workerId !== 'windows-document-producer' || body.claimId !== value.claimId || value.lease !== null) ||
        body.operation !== 'claim' && (!value.lease || body.jobId !== value.lease.jobId || body.fence !== value.lease.fence || body.leaseToken !== value.lease.leaseToken) ||
        body.operation === 'complete' && (!value.raw || body.rawReceiptId !== value.raw.receipt.id) ||
        body.operation === 'fail' && !ERRORS.has(body.errorCode)) fail('storage_unavailable');
    if (body.operation === 'raw') rawBytes(body);
  }
  return value;
}

/** Atomic local outbox. Short-lived lease capabilities are never printed or put in Git. */
export function createDocumentProducerFileStore({ directory = fileURLToPath(new URL('../.cache/document-investigations/', import.meta.url)) } = {}) {
  const folder = resolve(directory), filename = join(folder, 'outbox.json'), lock = join(folder, 'producer.lock');
  async function safeRead(file, max) {
    const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('storage_unavailable');
    const bytes = await readFile(file); if (bytes.length > max) fail('storage_unavailable'); return bytes.toString('utf8');
  }
  return {
    async load() { try { return validateJournal(JSON.parse(await safeRead(filename, MAX_STATE))); } catch (error) { if (error.code === 'ENOENT') return null; fail('storage_unavailable'); } },
    async save(value) {
      validateJournal(value); const body = pluginJson(value); if (Buffer.byteLength(body) > MAX_STATE) fail('storage_unavailable');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const temporary = join(folder, `outbox-${process.pid}-${randomBytes(16).toString('hex')}.tmp`); let handle;
      try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(body); await handle.sync(); await handle.close(); handle = null; await rename(temporary, filename); }
      finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
    async exclusive(work) {
      await mkdir(folder, { recursive: true, mode: 0o700 }); let handle;
      try { handle = await open(lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const original = await safeRead(lock, 512); let owner; try { owner = JSON.parse(original); } catch { fail('storage_unavailable'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !TOKEN.test(owner.nonce)) fail('storage_unavailable');
        try { process.kill(owner.pid, 0); return { status: 'busy', published: false }; }
        catch (check) { if (check.code !== 'ESRCH') return { status: 'busy', published: false }; }
        // Do not race another recovery by unlinking a dead owner's path. A hard
        // crash requires explicit local lock maintenance; its outbox is retained.
        fail('storage_unavailable');
      }
      try { await handle.writeFile(pluginJson({ pid: process.pid, nonce: randomBytes(16).toString('hex') })); await handle.sync(); return await work(); }
      finally { await handle.close(); await unlink(lock); }
    },
  };
}

/** Python receives binary evidence and a minimal environment, never the producer key. */
export function extractDocumentInSandbox(bytes, { signal } = {}) {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('resource_limit'), { code: 'resource_limit' }));
  return new Promise((accept, reject) => {
    const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
    const env = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.PYTHONNOUSERSITE = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
    const child = spawn(python, ['-I', '-B', fileURLToPath(new URL('./document-extractor-sandbox.py', import.meta.url))], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let size = 0, stderr = 0, rejected = false;
    const stop = code => { if (!rejected) { rejected = true; child.kill(); reject(Object.assign(new Error(code), { code })); } };
    const abort = () => stop('deadline'), timer = setTimeout(abort, 22500); signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop('extractor_failed')); child.stdin.on('error', () => {});
    child.stdout.on('data', data => { size += data.length; if (size > 1024 * 1024) stop('resource_limit'); else output.push(data); });
    child.stderr.on('data', data => { stderr += data.length; if (stderr > 65536) stop('resource_limit'); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); child.stdin.destroy();
      if (rejected) return;
      if (code !== 0) { stop('extractor_failed'); return; }
      try { accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)))); } catch { stop('extractor_failed'); }
    });
    if (signal?.aborted) abort(); else child.stdin.end(bytes);
  });
}
const SELECTORS = Object.freeze({
  'eu-icc-position': 'The European Union has been a constant supporter of the International Criminal Court (ICC).',
  'eu-icc-commitment': 'The EU will work closely with the ICC to ensure it continues to operate effectively.',
  'reported-us-sanctions-intent': 'It is deeply regrettable that the United States has announced intentions to impose sanctions.',
  'reported-relative-delay': 'As there is a six-month delay before the measures are applicable, there is room for dialogue.',
});
function citationsFor(extraction) {
  return Object.entries(SELECTORS).map(([selector, sentence]) => {
    const expression = new RegExp(sentence.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gu'), matches = [];
    for (const page of extraction.pages || []) for (const match of page.text.matchAll(expression)) {
      const start = [...page.text.slice(0, match.index)].length; matches.push({ selector, page: page.page, start, end: start + [...match[0]].length, exact: match[0] });
    }
    if (matches.length !== 1) fail('input_changed'); return matches[0];
  });
}
function resourceProof(execution) {
  if (!object(execution) || execution.mode !== 'windows-job-object' || execution.memoryMeaning !== 'committed-virtual-memory' ||
      execution.processMemoryLimitBytes !== 67108864 || execution.jobMemoryLimitBytes !== 100663296 || execution.processesLimit !== 2 || execution.wallSeconds !== 20 ||
      execution.inputBytesLimit !== P.rawBytes || execution.stdoutBytesLimit !== 1048576 || execution.stderrBytesLimit !== 65536 ||
      execution.activeProcessesAfterCleanup !== 0 || execution.jobListAppliedBeforeExecution !== true || execution.exitCode !== 0 ||
      execution.environment !== 'minimal-without-producer-credentials' || typeof execution.hostAlreadyInJob !== 'boolean' ||
      !['nativeReportedPeakProcessBytes', 'nativeReportedPeakJobBytes'].every(key => Number.isSafeInteger(execution[key]) && execution[key] >= 0 && execution[key] <= 134217728)) fail('resource_limit');
  return execution;
}

/** One explicit cycle, not a browser collector or an always-on scheduler. */
export function createDocumentInvestigationProducer({ key, fetchImpl = globalThis.fetch,
  extractorImpl = extractDocumentInSandbox, stateStore = createDocumentProducerFileStore(), now = Date.now } = {}) {
  let running = false;
  async function cycle({ signal: callerSignal } = {}) {
    if (!KEY.test(key || '')) return { status: 'unconfigured', published: false };
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
    signal.throwIfAborted(); let journal = validateJournal(await stateStore.load()), phase = 'storage';
    const resumedLease = journal?.lease && !journal.pending;
    const persist = async () => { await stateStore.save(journal); };
    const clear = async () => { journal = null; await persist(); };
    async function post(body) {
      const encoded = typeof body === 'string' ? body : pluginJson(body); if (Buffer.byteLength(encoded) > MAX_BODY) fail('source_limit');
      const timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(16).toString('hex'), bodyDigest = sha(encoded);
      const signature = createHmac('sha256', key).update(`earth-document-producer-v1\nPOST\n${SIGNED_PATH}\n${timestamp}\n${nonce}\n${bodyDigest}`).digest('hex');
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      const response = await active(fetchImpl(DOCUMENT_PRODUCER_URL, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: requestSignal,
        body: encoded, headers: { 'content-type': 'application/json', 'x-earth-document-timestamp': timestamp, 'x-earth-document-nonce': nonce,
          'x-earth-document-digest': bodyDigest, 'x-earth-document-signature': signature } }), requestSignal);
      const bytes = await readBytes(response, requestSignal, MAX_RESPONSE, /^application\/json(?:\s*;|$)/i, 'storage_unavailable');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value.schemaVersion !== 1 || value.configured !== true || typeof value.status !== 'string') fail('storage_unavailable'); return value;
    }
    async function prepare(body) { journal.pending = { operation: body.operation, body: pluginJson(body), digest: sha(pluginJson(body)) }; await persist(); }
    async function dispatch() { try { return await post(journal.pending.body); } catch { return null; } }
    const uncertain = () => ({ status: 'awaiting-readback', published: false, needsReadback: true });
    const attemptMatches = value => value.attemptFound === true && value.attempt?.fence === journal.lease.fence && value.attempt.inputRevision === journal.lease.inputRevision;
    async function finished(value) {
      const raw = value.rawReceipt || journal.raw?.receipt, publication = value.publication || value.receipt;
      if (value.stored !== true || !['published', 'checked'].includes(value.status) || typeof value.changed !== 'boolean' ||
          value.status === 'published' && value.changed !== true || value.status === 'checked' && value.changed !== false ||
          !journal.lease || !raw || !journal.raw || !validRaw(raw, rawBytes(journal.raw.body)) || !validPublication(publication, journal.lease, raw)) return null;
      await clear(); return { status: value.status === 'checked' || value.changed === false ? 'checked' : 'published', published: value.changed !== false, changed: value.changed !== false };
    }
    async function acceptRaw(value, body) {
      const bytes = rawBytes(body), receipt = value.rawReceipt || value.receipt;
      if (!validRaw(receipt, bytes) || value.stored !== true || !['retained', 'checked'].includes(value.status) || value.status === 'retained' && value.current !== true) return null;
      journal.raw = { body, receipt };
      if (value.status === 'checked') { await persist(); return await finished(value); }
      journal.pending = null; await persist(); return { status: 'retained' };
    }
    async function recover() {
      const pending = journal.pending, body = JSON.parse(pending.body), query = body.operation === 'claim' ? { claimId: journal.claimId } : { jobId: journal.lease.jobId, fence: journal.lease.fence };
      let value; try { value = await post({ schemaVersion: 1, operation: 'status', ...query }); } catch { return uncertain(); }
      if (body.operation === 'claim') {
        if (value.available === true && value.job?.leaseToken) { journal.lease = validateLease(value.job); journal.pending = null; await persist(); return null; }
        if (value.status === 'absent' && value.available === false && value.job === null && value.attemptFound === false) return await acceptClaim(await dispatch());
        if (value.attemptFound === true && value.attempt?.claimId === journal.claimId && value.attempt.jobId === FIXED_JOB &&
            Number.isSafeInteger(value.attempt.fence) && value.attempt.fence > 0 && HEX.test(value.attempt.inputRevision) &&
            value.status === value.attempt.state && ['lease-expired', 'superseded', 'failed', 'succeeded'].includes(value.attempt.state)) {
          await clear(); return { status: value.attempt.state, published: false };
        }
        return uncertain();
      }
      if (!attemptMatches(value)) return uncertain();
      if (value.attempt.state === 'succeeded') {
        if (body.operation === 'raw') {
          if (!validRaw(value.rawReceipt, rawBytes(body))) return uncertain();
          journal.raw = { body, receipt: value.rawReceipt }; await persist();
        }
        if (body.operation === 'fail') { await clear(); return { status: 'succeeded', published: false }; }
        const checked = body.operation === 'raw';
        return await finished({ ...value, status: checked ? 'checked' : 'published', stored: true, changed: !checked }) || uncertain();
      }
      if (['lease-expired', 'superseded', 'failed', 'retry'].includes(value.attempt.state)) { await clear(); return { status: value.attempt.state, published: false }; }
      if (body.operation === 'raw') {
        if (value.rawReceipt) { const result = await acceptRaw({ ...value, status: 'retained', stored: true, current: true }, body); return result?.status === 'retained' ? null : result || uncertain(); }
        if (value.rawReceipt === null && value.attempt.rawReceiptId === null) { const result = await acceptRaw(await dispatch() || {}, body); return result?.status === 'retained' ? null : result || uncertain(); }
      } else if (body.operation === 'complete') {
        if (value.publication === null && value.attempt.publicationId === null && value.rawReceipt?.id === journal.raw.receipt.id && validRaw(value.rawReceipt, rawBytes(journal.raw.body)))
          return await finished(await dispatch() || {}) || uncertain();
      } else if (body.operation === 'fail') {
        const result = await dispatch(); if (result && ['retry', 'failed'].includes(result.status)) { await clear(); return { status: result.status, published: false }; }
      }
      return uncertain();
    }
    async function acceptClaim(value) {
      if (!value) return uncertain();
      if (['not-due', 'busy'].includes(value.status) && value.job === null) { await clear(); return { status: value.status, published: false }; }
      if (value.status !== 'leased') return uncertain();
      journal.lease = validateLease(value.job); journal.pending = null; await persist(); return null;
    }
    try {
      if (journal?.pending) { const result = await recover(); if (result) return result; }
      if (resumedLease) {
        const value = await post({ schemaVersion: 1, operation: 'status', jobId: journal.lease.jobId, fence: journal.lease.fence });
        if (!attemptMatches(value)) return uncertain();
        if (['lease-expired', 'superseded', 'failed', 'retry'].includes(value.attempt.state)) { await clear(); return { status: value.attempt.state, published: false }; }
        if (value.attempt.state !== 'running' || journal.raw && (!validRaw(value.rawReceipt, rawBytes(journal.raw.body)) || value.rawReceipt.id !== journal.raw.receipt.id)) return uncertain();
      }
      if (!journal) { journal = { schemaVersion: 1, claimId: randomBytes(16).toString('hex'), lease: null, pending: null, raw: null };
        await prepare({ schemaVersion: 1, operation: 'claim', workerId: 'windows-document-producer', claimId: journal.claimId });
        const result = await acceptClaim(await dispatch()); if (result) return result;
      }
      validateLease(journal.lease); if (Date.parse(journal.lease.leaseUntil) <= now()) return uncertain();
      if (!journal.raw) {
        phase = 'source';
        const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const response = await active(fetchImpl(P.downloadUrl, { signal: sourceSignal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/pdf' } }), sourceSignal);
        if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); fail('source_unavailable'); }
        const bytes = await readBytes(response, sourceSignal, P.rawBytes, /^application\/pdf(?:\s*;|$)/i, 'source_limit');
        const body = { schemaVersion: 1, operation: 'raw', jobId: journal.lease.jobId, fence: journal.lease.fence, leaseToken: journal.lease.leaseToken,
          acquiredAt: new Date(now()).toISOString(), rawPdfBase64: bytes.toString('base64') }; rawBytes(body); await prepare(body);
        const result = await acceptRaw(await dispatch() || {}, body); if (!result) return uncertain(); if (result.status !== 'retained') return result;
      }
      phase = 'extraction';
      const bytes = rawBytes(journal.raw.body), envelope = await active(extractorImpl(bytes, { signal }), signal), execution = resourceProof(envelope.execution), extraction = envelope.result?.extraction;
      const evidence = await createEcDocumentEvidence(journal.lease.basis, bytes, extraction), citations = citationsFor(extraction);
      await createEcDocumentArtifact(evidence, citations);
      await prepare({ schemaVersion: 1, operation: 'complete', jobId: journal.lease.jobId, fence: journal.lease.fence, leaseToken: journal.lease.leaseToken,
        rawReceiptId: journal.raw.receipt.id, extraction, citations, execution });
      return await finished(await dispatch() || {}) || uncertain();
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', published: false, ...(journal?.pending ? { needsReadback: true } : {}) };
      if (!journal?.lease || journal.pending) return uncertain();
      const errorCode = ERRORS.has(error.code) ? error.code : error.code === 'document_evidence_invalid' ? 'input_changed' : phase === 'source' ? 'source_unavailable' : phase === 'storage' ? 'storage_unavailable' : 'extractor_failed';
      await prepare({ schemaVersion: 1, operation: 'fail', jobId: journal.lease.jobId, fence: journal.lease.fence, leaseToken: journal.lease.leaseToken, errorCode });
      const value = await dispatch(); if (value && ['retry', 'failed'].includes(value.status)) { await clear(); return { status: value.status, published: false }; }
      return uncertain();
    }
  }
  return { async oneCycle(options = {}) {
    if (typeof key !== 'string' || !KEY.test(key)) return { status: 'unconfigured', published: false };
    if (running) return { status: 'busy', published: false }; running = true;
    try { return await (typeof stateStore.exclusive === 'function' ? stateStore.exclusive(() => cycle(options)) : cycle(options)); }
    catch { return { status: 'storage-unavailable', published: false }; } finally { running = false; }
  } };
}

/** The public CLI receives its only credential through hidden bounded stdin.
 * This control is never forwarded to Python, persisted or included in diagnostics. */
export function readDocumentProducerControl({ input = process.stdin, timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return Promise.reject(new Error('invalid-control'));
  return new Promise((accept, reject) => {
    const chunks = []; let size = 0, ended = false;
    const cleanup = () => { clearTimeout(timer); input.removeListener('data', data); input.removeListener('end', end); input.removeListener('error', error); };
    const error = () => { if (ended) return; ended = true; cleanup(); input.pause(); reject(new Error('invalid-control')); };
    const data = chunk => { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > 1024) error(); else chunks.push(bytes); };
    const end = () => {
      if (ended) return; ended = true; cleanup();
      try {
        const control = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!exact(control, ['schemaVersion', 'producerKey']) || control.schemaVersion !== 1 || typeof control.producerKey !== 'string' || !KEY.test(control.producerKey)) throw new Error();
        accept(control);
      } catch { reject(new Error('invalid-control')); }
    };
    const timer = setTimeout(error, timeoutMs);
    input.on('data', data); input.once('end', end); input.once('error', error); input.resume();
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let result = { status: 'invalid-arguments', published: false };
  if (process.argv.length === 2) {
    try { const control = await readDocumentProducerControl(); result = await createDocumentInvestigationProducer({ key: control.producerKey }).oneCycle(); }
    catch { result = { status: 'invalid-control', published: false }; }
    finally { process.stdin.destroy(); }
  }
  process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = ['published', 'checked', 'not-due', 'busy'].includes(result.status) ? 0 : 1;
}
