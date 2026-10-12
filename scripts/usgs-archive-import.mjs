import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireUsgsCatalogInterval, splitUsgsCatalogInterval, restoreUsgsCatalogCandidate } from '../server/hosted/usgs-catalog-interval.js';

export const USGS_ARCHIVE_SCOPE = 'usgs-catalog-m4.5-v1';
export const USGS_ARCHIVE_IMPORT_URL = 'https://giovannicallebaut.com/earth/api/world/archive/import';
export const USGS_ARCHIVE_LIMITS = Object.freeze({ records: 500, pageTarget: 250, rawBytes: 1024 * 1024,
  responseBytes: 16 * 1024, upstreamTimeoutMs: 20_000, importTimeoutMs: 35_000,
  rangeDays: 32, totalDays: 735, intervalsPerRun: 8, requestsPerRun: 40, recordsPerRun: 2000, journalBytes: 1024 * 1024 });
const keyPattern = /^[A-Za-z0-9_-]{43,128}$/;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function interval(range, maxDays = USGS_ARCHIVE_LIMITS.rangeDays) {
  if (!range || Object.keys(range).sort().join(',') !== 'from,to' || !date(range.from) || !date(range.to) ||
      Date.parse(range.from) >= Date.parse(range.to) || Date.parse(range.to) - Date.parse(range.from) > maxDays * 86400000)
    throw new TypeError('Use a bounded UTC archive interval');
  return { from: range.from, to: range.to };
}
async function boundedText(response, maxBytes, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => {}); throw new Error('Response exceeds its acquisition budget');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Response exceeds its acquisition budget');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
export const splitUsgsInterval = splitUsgsCatalogInterval;
export async function acquireUsgsInterval(options = {}) {
  const { records: _records, rawBytes: _rawBytes, ...value } = await acquireUsgsCatalogInterval(options);
  return value; // Preserve the bounded existing CLI journal/transport surface.
}
export function signArchiveImport(key, body, { now = Date.now(), nonce = randomBytes(16).toString('hex') } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key) || typeof body !== 'string' || !Number.isFinite(now) || !/^[a-f0-9]{32}$/.test(nonce))
    throw new TypeError('Invalid archive capability configuration');
  const timestamp = String(Math.floor(now / 1000)), digest = createHash('sha256').update(body).digest('hex');
  const message = `earth-archive-import-v1\nPOST\n/api/world/archive/import\n${timestamp}\n${nonce}\n${digest}`;
  return { 'content-type': 'application/json', 'x-earth-archive-timestamp': timestamp, 'x-earth-archive-nonce': nonce,
    'x-earth-archive-digest': digest, 'x-earth-archive-signature': createHmac('sha256', key).update(message).digest('hex') };
}
export async function publishUsgsInterval(acquired, { key, fetchImpl = fetch, now = Date.now } = {}) {
  if (acquired?.status !== 'acquired') throw new TypeError('Publish only a complete acquired interval');
  const body = JSON.stringify(Object.fromEntries(['schemaVersion', 'scopeId', 'kind', 'range', 'expectedCount', 'capturedAt', 'body'].map((field) => [field, acquired[field]])));
  const signal = AbortSignal.timeout(USGS_ARCHIVE_LIMITS.importTimeoutMs);
  try {
    const response = await fetchImpl(USGS_ARCHIVE_IMPORT_URL, { method: 'POST', signal, credentials: 'omit', redirect: 'error',
      cache: 'no-store', headers: signArchiveImport(key, body, { now: now() }), body });
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Invalid archive publication response');
    const value = JSON.parse(await boundedText(response, USGS_ARCHIVE_LIMITS.responseBytes, signal));
    const safe = { httpStatus: response.status, stored: value.stored === true, complete: value.complete === true,
      reused: value.reused === true, scopeId: value.scopeId === USGS_ARCHIVE_SCOPE ? value.scopeId : null,
      chunkId: /^[a-f0-9]{64}$/.test(value.chunkId || '') ? value.chunkId : null,
      recordCount: Number.isInteger(value.recordCount) && value.recordCount >= 0 && value.recordCount <= USGS_ARCHIVE_LIMITS.records ? value.recordCount : null,
      publishedAt: date(value.publishedAt) ? value.publishedAt : null,
      readStatusBeforeRetry: value.readStatusBeforeRetry === true };
    return { status: response.ok && safe.stored && safe.complete && safe.chunkId === acquired.chunkId && safe.recordCount === acquired.expectedCount ? 'stored' : 'not-stored', ...safe };
  } catch { return { status: 'uncertain', stored: null, complete: false, chunkId: acquired.chunkId, readStatusBeforeRetry: true }; }
}
export async function bootstrapUsgsArchive({ key, fetchImpl = fetch, now = Date.now, limit = 16 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new TypeError('Use a bounded stored-receipt bootstrap');
  const body = JSON.stringify({ schemaVersion: 1, scopeId: USGS_ARCHIVE_SCOPE, operation: 'bootstrap', limit });
  const signal = AbortSignal.timeout(USGS_ARCHIVE_LIMITS.importTimeoutMs);
  const response = await fetchImpl(USGS_ARCHIVE_IMPORT_URL, { method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: signArchiveImport(key, body, { now: now() }), body });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Invalid archive bootstrap response');
  const result = JSON.parse(await boundedText(response, USGS_ARCHIVE_LIMITS.responseBytes, signal));
  return { httpStatus: response.status, configured: result.configured === true, stored: result.stored === true, complete: result.complete === true,
    status: ['ready', 'pending', 'busy', 'migration-required'].includes(result.status) ? result.status : 'unavailable',
    processed: Number.isInteger(result.processed) && result.processed >= 0 && result.processed <= limit ? result.processed : null,
    materializedOrder: Number.isSafeInteger(result.materializedOrder) && result.materializedOrder >= 0 ? result.materializedOrder : null,
    currentOrder: Number.isSafeInteger(result.currentOrder) && result.currentOrder >= 0 ? result.currentOrder : null,
    frontierSeeded: result.frontier?.seeded === true, frontierReady: result.frontier?.ready === true };
}
export async function readUsgsArchiveReceipt(chunkId, { fetchImpl = fetch } = {}) {
  if (!/^[a-f0-9]{64}$/.test(chunkId || '')) throw new TypeError('Use an exact archive receipt');
  const signal = AbortSignal.timeout(15000);
  const response = await fetchImpl(`https://giovannicallebaut.com/earth/api/world/archive/chunks/${chunkId}`, { signal,
    credentials: 'omit', redirect: 'error', cache: 'no-store' });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); return { available: false, status: response.status }; }
  const value = JSON.parse(await boundedText(response, USGS_ARCHIVE_LIMITS.responseBytes, signal));
  if (value.configured !== true || value.available !== true || typeof value.stored !== 'boolean' ||
      value.scopeId !== USGS_ARCHIVE_SCOPE || value.chunkId !== chunkId)
    throw new Error('Hosted receipt has no exact primary-storage state');
  if (!value.stored) return { configured: true, available: true, stored: false, scopeId: value.scopeId, chunkId };
  if (value.kind !== 'interval' || value.complete !== true || !date(value.capturedAt) || !date(value.publishedAt) ||
      !/^[a-f0-9]{64}$/.test(value.rawSha256 || '') || !/^[a-f0-9]{64}$/.test(value.snapshotId || '') ||
      !Number.isSafeInteger(value.publicationOrder) || value.publicationOrder < 1 ||
      !Number.isInteger(value.recordCount) || value.recordCount < 0 || value.recordCount > USGS_ARCHIVE_LIMITS.records ||
      value.expectedCount !== value.recordCount) throw new Error('Hosted completion receipt is invalid');
  return { configured: true, available: true, stored: true, scopeId: value.scopeId, chunkId,
    kind: value.kind, complete: true, capturedAt: value.capturedAt, publishedAt: value.publishedAt,
    rawSha256: value.rawSha256, snapshotId: value.snapshotId, publicationOrder: value.publicationOrder,
    recordCount: value.recordCount, expectedCount: value.expectedCount, range: interval(value.range) };
}
export function planUsgsIntervals(range) {
  range = interval(range, USGS_ARCHIVE_LIMITS.totalDays);
  const parts = [];
  for (let cursor = Date.parse(range.from), end = Date.parse(range.to); cursor < end;) {
    const next = Math.min(end, cursor + 7 * 86400000);
    parts.push({ from: new Date(cursor).toISOString(), to: new Date(next).toISOString() }); cursor = next;
  }
  return parts;
}
async function saveJournal(filename, journal) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(journal, null, 2) + '\n'); await rename(temporary, filename);
}

function validateJournal(journal, range) {
  if (journal.schemaVersion !== 1 || journal.scopeId !== USGS_ARCHIVE_SCOPE ||
      JSON.stringify(journal.range) !== JSON.stringify(range) || !Array.isArray(journal.pending) || !Array.isArray(journal.completed) ||
      journal.pending.length > 2048 || journal.completed.length > 2048 || !Array.isArray(journal.failures) || journal.failures.length > 32)
    throw new Error('Archive checkpoint does not match the requested fixed dataset');
  let cursor = range.from;
  for (const value of [...journal.completed.map(item => item.range), ...journal.pending]) {
    const part = interval(value);
    if (part.from !== cursor || part.to > range.to) throw new Error('Archive checkpoint has a gap or expanded interval');
    cursor = part.to;
  }
  if (cursor !== range.to || journal.candidate && !journal.pending.length) throw new Error('Archive checkpoint has incomplete interval accounting');
}

async function restoreCandidate(saved, current, directory, now) {
  if (saved.status !== 'acquired' || saved.schemaVersion !== 1 || saved.scopeId !== USGS_ARCHIVE_SCOPE || saved.kind !== 'interval' ||
      !date(saved.capturedAt) || !Number.isInteger(saved.expectedCount) || saved.expectedCount < 0 || saved.expectedCount > USGS_ARCHIVE_LIMITS.records ||
      !/^[a-f0-9]{64}$/.test(saved.rawSha256 || '') || !/^[a-f0-9]{64}$/.test(saved.chunkId || '') ||
      !/^[a-f0-9]{64}$/.test(saved.snapshotId || '') || JSON.stringify(saved.range) !== JSON.stringify(current))
    throw new Error('Cached candidate does not match this interval');
  const filename = path.join(directory, 'raw', `${saved.rawSha256}.json`);
  if ((await stat(filename)).size > USGS_ARCHIVE_LIMITS.rawBytes) throw new Error('Cached original evidence exceeds its bound');
  const body = await readFile(filename, 'utf8');
  if (Buffer.byteLength(body) !== saved.sourceBytes || Buffer.byteLength(body) > USGS_ARCHIVE_LIMITS.rawBytes ||
      createHash('sha256').update(body).digest('hex') !== saved.rawSha256) throw new Error('Cached original evidence is not intact');
  const { records: _records, rawBytes: _rawBytes, ...restored } = await restoreUsgsCatalogCandidate({ body, metadata: saved, now });
  return { ...restored, ...saved, body };
}

/** Local checkpoints complement hosted completion receipts; the browser never performs imports. */
export async function runUsgsArchiveImport({ range, key, journalFile, fetchImpl = fetch, now = Date.now,
  maxIntervals = USGS_ARCHIVE_LIMITS.intervalsPerRun } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key) || !path.isAbsolute(journalFile || '') ||
      !Number.isInteger(maxIntervals) || maxIntervals < 1 || maxIntervals > USGS_ARCHIVE_LIMITS.intervalsPerRun)
    throw new TypeError('Use a scoped capability and bounded import journal');
  range = interval(range, USGS_ARCHIVE_LIMITS.totalDays);
  await mkdir(path.dirname(journalFile), { recursive: true });
  const lockFile = `${journalFile}.lock`;
  let lock;
  try { lock = await open(lockFile, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() })); }
  catch {
    if (lock) { await lock.close().catch(() => {}); await unlink(lockFile).catch(() => {}); }
    throw new Error('Another importer or a stale import lock needs inspection before resuming');
  }
  try {
  let journal;
  try {
    if ((await stat(journalFile)).size > USGS_ARCHIVE_LIMITS.journalBytes) throw new Error('Archive checkpoint exceeds its bound');
    journal = JSON.parse(await readFile(journalFile, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (journal) validateJournal(journal, range);
  journal ||= { schemaVersion: 1, scopeId: USGS_ARCHIVE_SCOPE, range, pending: planUsgsIntervals(range), completed: [], failures: [] };
  let intervals = 0, requests = 0, records = 0, failedThisRun = false;
  const budgetedFetch = (url, options) => {
    if (new URL(url).origin === 'https://earthquake.usgs.gov') {
      if (++requests > USGS_ARCHIVE_LIMITS.requestsPerRun) throw new Error('Acquisition request budget exhausted');
    }
    return fetchImpl(url, options);
  };
  while (journal.pending.length && intervals < maxIntervals && requests + 2 <= USGS_ARCHIVE_LIMITS.requestsPerRun && records < USGS_ARCHIVE_LIMITS.recordsPerRun) {
    const current = journal.pending[0];
    try {
      let acquired;
      if (journal.candidate) acquired = await restoreCandidate(journal.candidate, current, path.dirname(journalFile), now);
      else acquired = await acquireUsgsInterval({ range: current, fetchImpl: budgetedFetch, now });
      if (acquired.status === 'split-required') { journal.pending.splice(0, 1, ...acquired.parts); await saveJournal(journalFile, journal); continue; }
      if (acquired.status !== 'acquired') throw new Error(acquired.reason || 'Interval is not complete');
      if (records + acquired.expectedCount > USGS_ARCHIVE_LIMITS.recordsPerRun) break;
      if (!journal.candidate) {
        const { body, ...metadata } = acquired;
        const rawFile = path.join(path.dirname(journalFile), 'raw', `${acquired.rawSha256}.json`);
        await mkdir(path.dirname(rawFile), { recursive: true }); await writeFile(rawFile, body);
        journal.candidate = metadata; await saveJournal(journalFile, journal);
      }
      // A restart or uncertain response always checks the exact durable receipt before retrying.
      let receipt = await readUsgsArchiveReceipt(acquired.chunkId, { fetchImpl });
      if (receipt.stored !== true) {
        if (receipt.available !== true || receipt.stored !== false) throw new Error('Hosted receipt state unavailable; retry not authorized by absence');
        const result = await publishUsgsInterval(acquired, { key, fetchImpl, now });
        if (result.status !== 'stored') throw new Error(result.status === 'uncertain' ? 'Publication uncertain; saved exact candidate requires readback before retry' : 'Hosted interval not admitted');
        receipt = await readUsgsArchiveReceipt(acquired.chunkId, { fetchImpl });
      }
      if (receipt.available !== true || receipt.stored !== true || receipt.complete !== true || receipt.chunkId !== acquired.chunkId ||
          receipt.rawSha256 !== acquired.rawSha256 || receipt.snapshotId !== acquired.snapshotId || receipt.recordCount !== acquired.expectedCount ||
          JSON.stringify(receipt.range) !== JSON.stringify(current))
        throw new Error('Hosted completion readback failed');
      journal.completed.push({ range: current, acquiredAt: acquired.capturedAt, capturedAt: receipt.capturedAt, sourceBytes: acquired.sourceBytes,
        rawSha256: acquired.rawSha256, chunkId: acquired.chunkId, publishedAt: receipt.publishedAt, recordCount: acquired.expectedCount });
      journal.pending.shift(); delete journal.candidate; intervals++; records += acquired.expectedCount;
      await saveJournal(journalFile, journal);
    } catch {
      failedThisRun = true;
      journal.failures.push({ range: current, attemptedAt: new Date(now()).toISOString(), reason: 'Acquisition/publication did not pass its completion gate; inspect before retry' });
      journal.failures = journal.failures.slice(-32); await saveJournal(journalFile, journal); break;
    }
  }
  return { scopeId: USGS_ARCHIVE_SCOPE, completedThisRun: intervals, sourceRequests: requests, recordsThisRun: records,
    completedIntervals: journal.completed.length, remainingIntervals: journal.pending.length, failed: failedThisRun };
  } finally { await lock.close(); await unlink(lockFile); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [mode, from, to] = process.argv.slice(2), range = { from, to };
  if (mode === '--bootstrap' && process.argv.length === 3) {
    console.log(JSON.stringify(await bootstrapUsgsArchive({ key: process.env.EARTH_ARCHIVE_IMPORT_KEY })));
  } else if (process.argv.length !== 5 || !['--prepare', '--import'].includes(mode)) {
    console.error('Use --prepare|--import <from UTC ISO> <to UTC ISO>, or --bootstrap'); process.exitCode = 2;
  } else if (mode === '--prepare') {
    const result = await acquireUsgsInterval({ range });
    const { body, ...metadata } = result;
    if (body) {
      const file = path.resolve('.cache/usgs-archive', `${result.rawSha256}.json`);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, body);
      await writeFile(`${file}.metadata.json`, JSON.stringify(metadata, null, 2) + '\n');
      console.log(JSON.stringify({ ...metadata, rawFile: file }));
    } else console.log(JSON.stringify(metadata));
  } else console.log(JSON.stringify(await runUsgsArchiveImport({ range, key: process.env.EARTH_ARCHIVE_IMPORT_KEY,
    journalFile: path.resolve('.cache/usgs-archive/import-journal.json') })));
}
