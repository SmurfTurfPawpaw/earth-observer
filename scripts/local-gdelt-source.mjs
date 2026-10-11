import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { generateGkgSnapshot, readGkgArchive, writeGdeltSnapshot, GDELT_SNAPSHOT_ASSET,
  MAX_GDELT_SNAPSHOT_BYTES, retainedGkgSnapshot } from './gdelt-snapshot.mjs';
import { createGdeltSnapshotReader, GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';

export const LOCAL_GDELT_CHECK_INTERVAL_MS = 60000;
export const LOCAL_GDELT_TIMEOUT_MS = 45000;
const RETRY_FLOOR_MS = 300000, MAX_RETRY_MS = 3600000, DAY_MS = 86400000;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const timestamp = (value) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** CRC, inflation and TSV parsing run in a bounded local thread, never a hosted Worker or browser. */
export function parseLocalGkgArchive(archive, descriptor, { retrievedAt, signal, priority } = {}) {
  signal?.throwIfAborted();
  const bytes = !Buffer.isBuffer(archive) && archive.byteOffset === 0 && archive.byteLength === archive.buffer.byteLength ? archive : new Uint8Array(archive);
  const worker = new Worker(new URL(import.meta.url), { workerData: {
    kind: 'local-gkg-parser', archive: bytes.buffer, descriptor, retrievedAt, priority,
  }, transferList: [bytes.buffer], execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
  return new Promise((resolve, reject) => {
    let finishing = false;
    const finish = async (error, value) => {
      if (finishing) return;
      finishing = true; signal?.removeEventListener('abort', abort);
      worker.removeAllListeners('message'); worker.removeAllListeners('error'); worker.removeAllListeners('exit');
      try { await worker.terminate(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { void finish(signal.reason || new DOMException('Local GKG parsing cancelled', 'AbortError')); };
    worker.on('message', (message) => { void finish(message?.ok ? null : new Error('Bounded local GKG parser rejected the archive'), message?.parsed); });
    worker.on('error', () => { void finish(new Error('Bounded local GKG parser unavailable')); });
    worker.on('exit', () => { void finish(new Error('Bounded local GKG parser exited before completion')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Fixed official latest-batch acquisition with persistent deduplication and failure backoff. No GitHub bootstrap. */
export function createLocalGdeltSource({ fetchImpl = fetch, now = Date.now, stateDirectory = '.cache/collector/gdelt',
  timeoutMs = LOCAL_GDELT_TIMEOUT_MS, archiveParser = parseLocalGkgArchive, demandPriority = false } = {}) {
  const directory = path.resolve(stateDirectory);
  const deadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(LOCAL_GDELT_TIMEOUT_MS, timeoutMs)) : LOCAL_GDELT_TIMEOUT_MS;
  let snapshot = null, reader, initialized, pending, controller, serial = Promise.resolve(), temporary = 0;
  let state = { schemaVersion: 1, lastAttemptAt: null, lastCheckedAt: null, lastSuccessfulAt: null,
    nextCheckAt: 0, retryAt: 0, failures: 0, lastCode: null, lastHttpStatus: null };
  const file = (name) => path.join(directory, name);
  async function readFileBounded(name, limit) {
    try {
      const target = file(name), info = await stat(target);
      if (!info.isFile() || info.size > limit) throw new Error('Owned local GDELT state exceeds its limit');
      return JSON.parse(await readFile(target, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Owned local GDELT state is unavailable or invalid'); }
  }
  async function saveState() {
    if (jsonBytes(state) > 8192) throw new Error('Local GDELT status exceeds its bound');
    await mkdir(directory, { recursive: true });
    const destination = file('state.json'), temporaryFile = `${destination}.${process.pid}.${++temporary}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await rename(temporaryFile, destination);
  }
  function resetReader() {
    reader = createGdeltSnapshotReader({ now, fetchImpl: async (input, options = {}) => {
      // This fixed release URL is an internal compatibility seam only; it never reaches the network.
      if (String(input) !== GDELT_SNAPSHOT_URL) throw new Error('Unexpected local snapshot read');
      options.signal?.throwIfAborted();
      if (!snapshot) return new Response(null, { status: 503 });
      const etag = `"${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}"`;
      if (options.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      return Response.json(snapshot, { headers: { etag } });
    } });
  }
  const initialize = () => initialized ||= (async () => {
    await mkdir(directory, { recursive: true });
    const saved = await readFileBounded('state.json', 8192), savedSnapshot = await readFileBounded(GDELT_SNAPSHOT_ASSET, MAX_GDELT_SNAPSHOT_BYTES);
    if (saved) {
      if (saved.schemaVersion !== 1 || !['lastAttemptAt', 'lastCheckedAt', 'lastSuccessfulAt'].every((key) => timestamp(saved[key])) ||
          !Number.isFinite(saved.nextCheckAt) || !Number.isFinite(saved.retryAt) || saved.retryAt < 0 || saved.nextCheckAt < 0 ||
          !Number.isInteger(saved.failures) || saved.failures < 0 || saved.failures > 6 ||
          saved.nextCheckAt > now() + DAY_MS || saved.retryAt > now() + DAY_MS)
        throw new Error('Local GDELT retry state failed validation');
      state = { ...state, ...saved };
    }
    if (savedSnapshot) {
      try { snapshot = retainedGkgSnapshot(savedSnapshot, now()); }
      catch { /* An expired last-good file cannot be served or retimed. The next fixed manifest check may replace it. */ }
    }
    resetReader();
  })();
  const runSerial = (task) => {
    const work = serial.catch(() => {}).then(async () => { await initialize(); return task(); }); serial = work; return work;
  };
  async function acquire(signal) {
    if (pending) return pending;
    if (Math.max(state.nextCheckAt, state.retryAt) > now()) return;
    controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const work = (async () => {
      state.lastAttemptAt = new Date(now()).toISOString();
      // Persist admission first: an abrupt restart cannot immediately repeat a admitted acquisition.
      state.nextCheckAt = now() + LOCAL_GDELT_CHECK_INTERVAL_MS; await saveState();
      const result = await generateGkgSnapshot({ fetchImpl, now, timeoutMs: deadline, signal: combined,
        previousSnapshot: snapshot, archiveParser, demandPriority });
      if (result.checkedAt) state.lastCheckedAt = result.checkedAt;
      state.lastCode = result.code || 'invalid-response'; state.lastHttpStatus = result.httpStatus || null;
      if (result.status === 'generated') {
        // Generated bytes and consumer validation both enforce the 1 MiB bound; a skipped result never overwrites this file.
        await writeGdeltSnapshot(directory, result); snapshot = result.snapshot; resetReader();
        state.lastSuccessfulAt = result.snapshot.coverage.processedBatches.at(-1).retrievedAt;
        state.failures = 0; state.retryAt = 0;
      } else if (result.code === 'unchanged') {
        state.failures = 0; state.retryAt = 0;
      } else if (result.code === 'aborted') {
        state.retryAt = 0; // Owner shutdown/cancellation does not masquerade as an upstream failure.
      } else {
        state.failures = Math.min(6, state.failures + 1);
        state.retryAt = now() + Math.max(Math.min(RETRY_FLOOR_MS * 2 ** (state.failures - 1), MAX_RETRY_MS), result.retryAfterMs || 0);
      }
      state.nextCheckAt = now() + LOCAL_GDELT_CHECK_INTERVAL_MS; await saveState();
    })();
    pending = work;
    try { await work; } finally { if (pending === work) { pending = null; controller = null; } }
  }
  return {
    read: (filters, { signal } = {}) => runSerial(async () => {
      await acquire(signal); signal?.throwIfAborted();
      const result = await reader(filters), failed = state.failures > 0;
      const status = result.state.status === 'unavailable' ? 'unavailable' : failed ? 'stale' : result.state.status;
      const coverage = result.state.coverage?.replaceAll('Scheduled GDELT', 'Locally acquired GDELT') || '';
      return { ...result, indexSource: { ...result.indexSource, status, coverage }, state: { ...result.state, status,
        stale: status === 'stale', mode: 'local-gkg', acquisition: 'official-latest-batch', coverage,
        lastAttemptAt: state.lastAttemptAt, lastCheckedAt: state.lastCheckedAt,
        snapshotRetrievedAt: snapshot?.coverage.processedBatches.at(-1)?.retrievedAt || null,
        snapshotCheckedAt: state.lastCheckedAt, refreshIntervalMs: LOCAL_GDELT_CHECK_INTERVAL_MS, sourceCadenceMs: 900000,
        retryAt: state.retryAt || null,
        reason: failed ? 'Local official GDELT acquisition is paused by backoff; original last-good sample dates are retained' :
          result.state.reason?.replaceAll('Scheduled', 'Locally acquired').replaceAll('scheduled', 'locally acquired'),
      } };
    }),
    status: () => runSerial(async () => ({ ...state, mode: 'local-gkg', configured: true,
      snapshotGeneratedAt: snapshot?.generatedAt || null, batchCount: snapshot?.coverage.processedBatches.length || 0,
      sourceCadenceMs: 900000, checkIntervalMs: LOCAL_GDELT_CHECK_INTERVAL_MS, timeoutMs: deadline })),
    close: () => { controller?.abort(new DOMException('Local GDELT acquisition stopped', 'AbortError')); },
  };
}

if (!isMainThread && workerData?.kind === 'local-gkg-parser') {
  readGkgArchive(new Uint8Array(workerData.archive), workerData.descriptor, {
    retrievedAt: workerData.retrievedAt, priority: workerData.priority,
  }).then((parsed) => parentPort.postMessage({ ok: true, parsed }))
    .catch(() => parentPort.postMessage({ ok: false }))
    .finally(() => parentPort.close());
}
