import { mkdir, writeFile, rename, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { gdeltQueryUrl } from '../server/hosted/gdelt-query.js';
import { validateGdeltSnapshot, GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { parseGkgRow, createGkgSnapshot, gkgBatchTime, gkgCoverage, GKG_CATCHUP_BUDGET } from '../server/hosted/gdelt-gkg.js';
import { normalizeGdelt } from '../server/hosted/intelligence-sources.js';
import { readResponseJsonCapped, readResponseTextCapped, readResponseBytesCapped } from '../server/providers/common/http.js';
import { readDemandPriority, createPriorityReservoir, applyDemandPriority } from './intelligence-priority.mjs';

export const GDELT_SNAPSHOT_CATEGORIES = Object.freeze(['geopolitics', 'economy', 'disasters']);
export const GDELT_SNAPSHOT_ASSET = 'gdelt.snapshot.json';
export const MAX_GDELT_SNAPSHOT_BYTES = 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const GKG_UPDATE_MANIFEST = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
export const MAX_GKG_ZIP_BYTES = 16 * 1024 * 1024;
export const MAX_GKG_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_GKG_ROWS = 50000, MAX_ROW_BYTES = 524288, MAX_CANDIDATES = 10000;
const HEADERS = { 'User-Agent': 'earth-observer-snapshots/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' };
const strongEtag = (value) => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,126}"$/.test(value) ? value : null;
const archiveUrl = (batch) => `https://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip`;

// Bound even an injected transport that fails to settle when its signal aborts.
async function fetchBounded(fetchImpl, url, options) {
  const { signal } = options; signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; reject(signal.reason); } };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => fetchImpl(url, options)).then((response) => {
      signal?.removeEventListener('abort', abort);
      if (settled) { void response.body?.cancel().catch(() => {}); return; }
      settled = true; resolve(response);
    }, (error) => { signal?.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error); } });
  });
}

/** A historical fixed URL is verified by HEAD size/strong ETag, not an invented manifest MD5. */
export function historicalGkgDescriptor(response, batch, nowMs = Date.now()) {
  const stamp = gkgBatchTime(batch), age = nowMs - Date.parse(stamp), sizeText = response.headers.get('content-length');
  const size = /^\d{1,8}$/.test(sizeText || '') ? Number(sizeText) : NaN, etag = strongEtag(response.headers.get('etag'));
  const encoding = response.headers.get('content-encoding');
  if (!response.ok || !stamp || age < -300000 || age > 86400000 || !Number.isInteger(size) || size < 1 || size > MAX_GKG_ZIP_BYTES || !etag ||
      encoding && encoding.toLowerCase() !== 'identity') throw new Error('Historical GKG HEAD lacks bounded size, identity encoding or strong ETag');
  return { batch, size, md5: null, url: archiveUrl(batch), etag, integrityMode: 'https-head-size-and-zip-crc' };
}

/** Only the current official GKG archive; HTTP manifest links are upgraded to HTTPS. */
export function parseGkgUpdateManifest(text, nowMs = Date.now()) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw new Error('GKG manifest exceeds its limit');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length > 8) throw new Error('Unexpected GKG update manifest');
  const candidates = lines.filter((line) => /\.gkg\.csv\.zip(?:\s|$)/i.test(line));
  if (candidates.length !== 1) throw new Error('Missing or ambiguous GKG update');
  const match = /^([1-9]\d{0,8})\s+([a-fA-F0-9]{32})\s+https?:\/\/data\.gdeltproject\.org\/gdeltv2\/(\d{14})\.gkg\.csv\.zip$/.exec(candidates[0]);
  if (!match) throw new Error('GKG archive does not match the fixed official source');
  const size = Number(match[1]), stamp = gkgBatchTime(match[3]), age = nowMs - Date.parse(stamp);
  if (!stamp || size > MAX_GKG_ZIP_BYTES || age > 86400000 || age < -300000) throw new Error('GKG update is oversized, expired or future-dated');
  return { batch: match[3], size, md5: match[2].toLowerCase(), url: `https://data.gdeltproject.org/gdeltv2/${match[3]}.gkg.csv.zip` };
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; CRC_TABLE[i] = value >>> 0; }
function crcUpdate(crc, bytes) { for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255] ^ crc >>> 8; return crc >>> 0; }

/** Inspect a single bounded archive in memory; no extraction or archive paths are written. */
export function inspectGkgZip(value, batch) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_GKG_ZIP_BYTES || !gkgBatchTime(batch)) throw new Error('Invalid GKG archive');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength), expectedName = `${batch}.gkg.csv`;
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== 1 || bytes.readUInt16LE(end + 10) !== 1) throw new Error('GKG ZIP requires one entry on one disk');
  const centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (centralSize < 46 || central + centralSize !== end || central + 46 > end || bytes.readUInt32LE(central) !== 0x02014b50) throw new Error('Invalid GKG ZIP central directory');
  const flags = bytes.readUInt16LE(central + 8), method = bytes.readUInt16LE(central + 10), crc = bytes.readUInt32LE(central + 16);
  const compressedSize = bytes.readUInt32LE(central + 20), uncompressedSize = bytes.readUInt32LE(central + 24);
  const nameLength = bytes.readUInt16LE(central + 28), extraLength = bytes.readUInt16LE(central + 30), commentLength = bytes.readUInt16LE(central + 32);
  const mode = bytes.readUInt32LE(central + 38) >>> 16 & 0xf000;
  if (flags & ~0x0808 || ![0, 8].includes(method) || mode && mode !== 0x8000 || bytes.readUInt16LE(central + 34) || bytes.readUInt32LE(central + 42) !== 0 ||
      compressedSize > MAX_GKG_ZIP_BYTES || uncompressedSize > MAX_GKG_UNCOMPRESSED_BYTES || centralSize !== 46 + nameLength + extraLength + commentLength ||
      bytes.subarray(central + 46, central + 46 + nameLength).toString('utf8') !== expectedName) throw new Error('GKG ZIP entry exceeds its fixed contract');
  const checkExtra = (start, length) => {
    const limit = start + length; let at = start;
    while (at < limit) { if (at + 4 > limit) throw new Error('Truncated GKG ZIP extra field'); const id = bytes.readUInt16LE(at), size = bytes.readUInt16LE(at + 2); if (id === 1 || at + 4 + size > limit) throw new Error('Invalid or ZIP64 GKG extra field'); at += 4 + size; }
  };
  checkExtra(central + 46 + nameLength, extraLength);
  if (central < 30 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(6) !== flags || bytes.readUInt16LE(8) !== method) throw new Error('GKG ZIP local header mismatch');
  const localNameLength = bytes.readUInt16LE(26), localExtraLength = bytes.readUInt16LE(28), dataStart = 30 + localNameLength + localExtraLength;
  if (dataStart > central || localNameLength !== nameLength || bytes.subarray(30, 30 + localNameLength).toString('utf8') !== expectedName) throw new Error('Unexpected GKG ZIP local name');
  checkExtra(30 + localNameLength, localExtraLength);
  const localCrc = bytes.readUInt32LE(14), localCompressed = bytes.readUInt32LE(18), localUncompressed = bytes.readUInt32LE(22);
  if (flags & 8 ? ![0, crc].includes(localCrc) || ![0, compressedSize].includes(localCompressed) || ![0, uncompressedSize].includes(localUncompressed) : localCrc !== crc || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) throw new Error('GKG ZIP sizes disagree');
  const dataEnd = dataStart + compressedSize, descriptorSize = central - dataEnd;
  if (flags & 8) {
    const offset = descriptorSize === 16 && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
    if (![12, 16].includes(descriptorSize) || descriptorSize === 16 && offset === dataEnd || bytes.readUInt32LE(offset) !== crc || bytes.readUInt32LE(offset + 4) !== compressedSize || bytes.readUInt32LE(offset + 8) !== uncompressedSize) throw new Error('Invalid GKG ZIP descriptor');
  } else if (descriptorSize !== 0) throw new Error('Unexpected GKG ZIP data');
  if (method === 0 && compressedSize !== uncompressedSize) throw new Error('Invalid stored GKG ZIP size');
  return { compressed: bytes.subarray(dataStart, dataEnd), method, crc, uncompressedSize };
}

// A deterministic, bounded reservoir avoids favoring only the first TSV rows.
function candidateReservoir(limit) {
  const heap = [];
  const priority = (text) => { let value = 2166136261; for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return value >>> 0; };
  return { get size() { return heap.length; }, resize(nextLimit) {
    if (!Number.isSafeInteger(nextLimit) || nextLimit < 0 || nextLimit > limit) throw new Error('Invalid candidate reservoir resize');
    limit = nextLimit;
    while (heap.length > limit) {
      const last = heap.pop(); if (!heap.length) continue;
      heap[0] = last; let parent = 0;
      for (;;) { let child = parent * 2 + 1; if (child >= heap.length) break; if (child + 1 < heap.length && heap[child + 1].rank > heap[child].rank) child++; if (heap[parent].rank >= heap[child].rank) break; [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child; }
    }
  }, add(report) {
    if (!limit) return;
    const entry = { report, rank: priority(`${report.category}|${report.url}`) };
    if (heap.length < limit) {
      heap.push(entry); let child = heap.length - 1;
      while (child) { const parent = child - 1 >>> 1; if (heap[parent].rank >= heap[child].rank) break; [heap[parent], heap[child]] = [heap[child], heap[parent]]; child = parent; }
    } else if (entry.rank < heap[0].rank) {
      heap[0] = entry; let parent = 0;
      for (;;) { let child = parent * 2 + 1; if (child >= heap.length) break; if (child + 1 < heap.length && heap[child + 1].rank > heap[child].rank) child++; if (heap[parent].rank >= heap[child].rank) break; [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child; }
    }
  }, values: () => heap.map((entry) => entry.report) };
}

/** Stream decompression, CRC and TSV parsing; retain at most 10,000 candidate metadata records. */
export async function readGkgArchive(archive, descriptor, { retrievedAt, signal, priority, expiresAt } = {}) {
  const checkDeadline = () => { signal?.throwIfAborted(); if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) throw new DOMException('GKG parse deadline exceeded', 'TimeoutError'); };
  checkDeadline();
  const historical = descriptor.integrityMode === 'https-head-size-and-zip-crc';
  if (archive.byteLength !== descriptor.size || (historical ? descriptor.md5 !== null || !strongEtag(descriptor.etag) || descriptor.url !== archiveUrl(descriptor.batch) :
      !/^[a-f0-9]{32}$/.test(descriptor.md5 || '') || createHash('md5').update(archive).digest('hex') !== descriptor.md5)) throw new Error('GKG verified archive size, manifest MD5 or integrity descriptor mismatch');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const entry = inspectGkgZip(archive, descriptor.batch), candidates = createPriorityReservoir(priority, candidateReservoir, MAX_CANDIDATES) || candidateReservoir(MAX_CANDIDATES);
  function* compressedChunks() { for (let at = 0; at < entry.compressed.byteLength; at += 65536) yield entry.compressed.subarray(at, at + 65536); }
  const source = Readable.from(compressedChunks()), stream = entry.method === 8 ? source.pipe(createInflateRaw({ chunkSize: 65536 })) : source;
  const cancel = () => stream.destroy(signal.reason); signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
  let total = 0, rows = 0, matchedRecords = 0, crc = 0xffffffff, pending = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const row = (line) => {
    checkDeadline();
    if (!line) throw new Error('Empty GKG TSV row');
    if (++rows > MAX_GKG_ROWS || Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) throw new Error('GKG row count or byte length exceeds its limit');
    const reports = parseGkgRow(line, { batch: descriptor.batch, retrievedAt }); matchedRecords += reports.length;
    for (const report of reports) candidates.add(report);
  };
  try {
    for await (const chunk of stream) {
      checkDeadline(); total += chunk.byteLength;
      if (total > entry.uncompressedSize || total > MAX_GKG_UNCOMPRESSED_BYTES) throw new Error('GKG inflation exceeds its declared size');
      crc = crcUpdate(crc, chunk); pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) { row(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (Buffer.byteLength(pending, 'utf8') > MAX_ROW_BYTES) throw new Error('GKG row exceeds its byte limit');
    }
    checkDeadline(); pending += decoder.decode(); if (pending) row(pending);
    if (total !== entry.uncompressedSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc || entry.method === 8 && stream.bytesWritten !== entry.compressed.byteLength) throw new Error('GKG ZIP CRC or uncompressed/compressed size mismatch');
    return { reports: candidates.values(), rows, matchedRecords, integrity: { mode: historical ? 'https-head-size-and-zip-crc' : 'manifest-md5-and-zip-crc',
      sha256, archiveBytes: descriptor.size, expandedBytes: total, providerMd5: historical ? null : descriptor.md5,
      ...(historical ? { providerEtag: descriptor.etag } : {}) } };
  } finally { signal?.removeEventListener('abort', cancel); stream.destroy(); source.destroy(); }
}

/** Prune expired batches from a validated prior sample without advancing its actual generation or retrieval dates. */
export function retainedGkgSnapshot(value, nowMs = Date.now()) {
  if (value?.schemaVersion !== 2 || !Number.isFinite(Date.parse(value.generatedAt)) ||
      nowMs - Date.parse(value.generatedAt) > 86400000) return null;
  const original = validateGdeltSnapshot(value, nowMs);
  const processedBatches = original.coverage.processedBatches.filter((batch) =>
    nowMs - Date.parse(gkgBatchTime(batch.id)) <= 86400000 && nowMs - Date.parse(batch.retrievedAt) <= 86400000);
  if (!processedBatches.length) return null;
  return validateGdeltSnapshot(createGkgSnapshot({ generatedAt: original.generatedAt, processedBatches,
    reports: Object.values(original.categories).flatMap((category) => category.reports), catchup: original.coverage.catchup }), nowMs);
}

/** One public latest GKG batch; a failure cannot replace the published last-good sample. */
export async function generateGkgSnapshot({ fetchImpl = fetch, now = Date.now, timeoutMs = 45000, previousSnapshot,
  demandPriority = false, repairEnabled = false, signal: callerSignal, archiveParser = readGkgArchive } = {}) {
  const duration = Math.max(1, Math.min(45000, timeoutMs)), expiresAt = Date.now() + duration;
  const deadline = AbortSignal.timeout(duration);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  let checkedAt = null;
  const httpError = async (response, source) => {
    const retry = response.headers.get('retry-after');
    const delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
    await response.body?.cancel();
    return Object.assign(new Error(`GKG ${source} HTTP ${response.status}`), { httpStatus: response.status,
      retryAfterMs: Number.isFinite(delay) ? Math.max(0, Math.min(86400000, delay)) : 0 });
  };
  try {
    signal.throwIfAborted();
    let previous;
    if (previousSnapshot === undefined) {
      try {
        const priorSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const response = await fetchBounded(fetchImpl, GDELT_SNAPSHOT_URL, { signal: priorSignal, redirect: 'follow', headers: { ...HEADERS, Accept: 'application/json' } });
        if (response.ok) previousSnapshot = await readResponseJsonCapped(response, MAX_GDELT_SNAPSHOT_BYTES, priorSignal);
        else await response.body?.cancel();
      } catch {} // No prior asset is valid on a first deployment.
    }
    if (previousSnapshot?.schemaVersion === 2) { try { previous = retainedGkgSnapshot(previousSnapshot, now()); } catch {} }
    const hostRetryAt = repairEnabled ? Math.max(0, ...(previous?.coverage.catchup?.attempts || []).filter((entry) => entry.httpStatus === 429).map((entry) => Date.parse(entry.retryAt))) : 0;
    if (hostRetryAt > now()) return { status: 'skipped', code: 'unchanged', checkedAt: null, retryAfterMs: hostRetryAt - now(),
      reason: 'GDELT provider backoff retained; no manifest or archive request issued, original source dates preserved' };
    const manifestResponse = await fetchBounded(fetchImpl, GKG_UPDATE_MANIFEST, { signal, redirect: 'error', headers: { ...HEADERS, Accept: 'text/plain' } });
    if (!manifestResponse.ok) throw await httpError(manifestResponse, 'manifest');
    const descriptor = parseGkgUpdateManifest(await readResponseTextCapped(manifestResponse, 16384, signal), now());
    checkedAt = new Date(now()).toISOString();
    const latestRetained = previous?.coverage.processedBatches.some((batch) => batch.id === descriptor.batch);
    if (latestRetained && !repairEnabled) return { status: 'skipped', code: 'unchanged',
      batch: descriptor.batch, checkedAt, reason: 'Latest GKG batch already processed; previous snapshot preserved' };
    const priority = await readDemandPriority({ enabled: demandPriority, fetchImpl: (url, options) => fetchBounded(fetchImpl, url, options), now, signal });
    const processedBatches = [...(previous?.coverage.processedBatches || [])];
    const reports = previous ? Object.values(previous.categories).flatMap((category) => category.reports) : [];
    let compressedBytes = 0, expandedBytes = 0, acquired = 0, latestParsed = null, factualChanged = false, generatedAt = previous?.generatedAt;
    const ingest = async (candidate) => {
      signal.throwIfAborted();
      if (acquired >= GKG_CATCHUP_BUDGET.maxArchives || compressedBytes + candidate.size > GKG_CATCHUP_BUDGET.maxCompressedBytes) throw new Error('GKG aggregate archive budget exceeded');
      const archiveResponse = await fetchBounded(fetchImpl, candidate.url, { signal, redirect: 'error', headers: { ...HEADERS, Accept: 'application/zip', 'Accept-Encoding': 'identity',
        ...(candidate.etag ? { 'If-Match': candidate.etag } : {}) } });
      if (!archiveResponse.ok) throw await httpError(archiveResponse, 'archive');
      if (candidate.etag && (archiveResponse.headers.get('etag') !== candidate.etag || archiveResponse.headers.get('content-length') !== String(candidate.size) ||
          archiveResponse.headers.get('content-encoding') && archiveResponse.headers.get('content-encoding').toLowerCase() !== 'identity')) {
        await archiveResponse.body?.cancel(); throw new Error('Historical GKG GET does not match verified HEAD');
      }
      const archive = await readResponseBytesCapped(archiveResponse, MAX_GKG_ZIP_BYTES, signal);
      const entry = inspectGkgZip(archive, candidate.batch); // Reject inflation before allocating parser work.
      if (expandedBytes + entry.uncompressedSize > GKG_CATCHUP_BUDGET.maxExpandedBytes) throw new Error('GKG aggregate expansion budget exceeded');
      compressedBytes += archive.byteLength; expandedBytes += entry.uncompressedSize; acquired++;
      const retrievedAt = new Date(now()).toISOString(), parsed = await archiveParser(archive, candidate, { retrievedAt, signal, priority, expiresAt });
      signal.throwIfAborted();
      if (repairEnabled && (!parsed.integrity || parsed.integrity.archiveBytes !== candidate.size || parsed.integrity.expandedBytes !== entry.uncompressedSize)) throw new Error('GKG parser did not retain verified integrity provenance');
      processedBatches.push({ id: candidate.batch, retrievedAt, rows: parsed.rows, matchedRecords: parsed.matchedRecords,
        ...(repairEnabled ? { integrity: parsed.integrity } : {}) });
      reports.push(...parsed.reports); factualChanged = true; generatedAt = new Date(now()).toISOString();
      return parsed;
    };
    // Failure of the newest batch never publishes a partial catch-up or discards last-good source facts.
    if (!latestRetained) latestParsed = await ingest(descriptor);
    const attemptedBatches = [], attempts = new Map((previous?.coverage.catchup?.attempts || []).map((attempt) => [attempt.id, attempt]));
    if (repairEnabled) {
      const gaps = gkgCoverage(processedBatches).sampleGaps.filter((id) => now() - Date.parse(gkgBatchTime(id)) <= 86400000);
      for (const batch of gaps) {
        if (attemptedBatches.length >= GKG_CATCHUP_BUDGET.maxRepairs || signal.aborted) break;
        if (Date.parse(attempts.get(batch)?.retryAt) > now()) continue;
        attemptedBatches.push(batch);
        try {
          const head = await fetchBounded(fetchImpl, archiveUrl(batch), { method: 'HEAD', signal, redirect: 'error', headers: { ...HEADERS, 'Accept-Encoding': 'identity' } });
          if (!head.ok) throw await httpError(head, 'historical HEAD');
          let candidate;
          try { candidate = historicalGkgDescriptor(head, batch, now()); } finally { await head.body?.cancel(); }
          await ingest(candidate); attempts.delete(batch);
        } catch (error) {
          const failedAt = now(), code = signal.aborted ? deadline.aborted ? 'timeout' : 'aborted' : error.name === 'TimeoutError' ? 'timeout' : error.httpStatus ? 'http-error' : 'invalid-response';
          attempts.set(batch, { id: batch, checkedAt: new Date(failedAt).toISOString(), retryAt: new Date(failedAt + Math.max(300000, error.retryAfterMs || 0)).toISOString(), code,
            ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
          // A deadline/cancellation prevents more requests; an upstream Retry-After prevents a burst against the same host.
          if (signal.aborted || error.retryAfterMs > 0) break;
        }
      }
    }
    checkedAt = new Date(now()).toISOString();
    const catchup = repairEnabled ? { checkedAt, attemptedBatches, attempts: [...attempts.values()] } : undefined;
    const base = createGkgSnapshot({ reports, processedBatches, generatedAt, catchup });
    const proposed = factualChanged ? applyDemandPriority(base, reports, priority) : { ...base, categories: previous.categories };
    const snapshot = validateGdeltSnapshot(proposed, now()), bytes = new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`);
    if (bytes.byteLength > MAX_GDELT_SNAPSHOT_BYTES) throw new Error('GKG snapshot exceeds 1 MiB');
    return { status: 'generated', code: factualChanged ? 'generated' : 'checked', checkedAt, factualChanged, snapshot, bytes, batch: descriptor.batch,
      archiveBytes: compressedBytes, expandedBytes, archives: acquired, rows: latestParsed?.rows || 0, matchedRecords: latestParsed?.matchedRecords || 0,
      sampling: { mode: priority.mode, reason: priority.reason, publishedInterests: priority.interests.length, maximumDemandShare: 0.25 } };
  } catch (error) {
    const timedOut = deadline.aborted || error.name === 'TimeoutError';
    return { status: 'skipped', code: signal.aborted ? timedOut ? 'timeout' : 'aborted' : error.httpStatus ? 'http-error' : 'invalid-response',
      checkedAt, ...(error.httpStatus ? { httpStatus: error.httpStatus, retryAfterMs: error.retryAfterMs } : {}),
      reason: `${timedOut ? 'GKG timed out' : error.message}; previous snapshot preserved` };
  }
}

/** One bounded metadata batch; any failure preserves the previously published data. */
export async function generateGdeltSnapshot({ fetchImpl = fetch, now = Date.now, sleepImpl = wait,
  timeoutMs = 15000, minGapMs = 6100 } = {}) {
  const categories = {};
  let previousStart = null;
  for (const category of GDELT_SNAPSHOT_CATEGORIES) {
    if (previousStart !== null) {
      const delay = Math.max(0, Math.max(6000, minGapMs) - (now() - previousStart));
      if (delay) await sleepImpl(delay);
    }
    previousStart = now();
    const queryUrl = gdeltQueryUrl({ category, country: '', countryName: '', q: '' });
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(queryUrl, { signal, redirect: 'error', headers: {
        Accept: 'application/json', 'User-Agent': 'earth-observer-snapshots/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)',
      } });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: 'skipped', category, reason: response.status === 429 ? 'GDELT rate limit (HTTP 429); previous snapshot preserved' : `GDELT HTTP ${response.status}; previous snapshot preserved` };
      }
      const metadata = await readResponseJsonCapped(response, 2 * 1024 * 1024, signal);
      signal.throwIfAborted();
      if (!Array.isArray(metadata?.articles) || metadata.articles.length > 80) throw new Error('Unexpected GDELT article count');
      const retrievedAt = new Date(now()).toISOString();
      const unique = new Map();
      for (const report of normalizeGdelt(metadata, retrievedAt, category)) if (!unique.has(report.url)) unique.set(report.url, report);
      categories[category] = { queryUrl, retrievedAt, reports: [...unique.values()] };
    } catch (error) {
      return { status: 'skipped', category, reason: error.name === 'TimeoutError' ? 'GDELT timeout; previous snapshot preserved' : 'GDELT metadata unavailable or invalid; previous snapshot preserved' };
    }
  }
  const proposed = { schemaVersion: 1, generatedAt: new Date(now()).toISOString(),
    source: { id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' },
    coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: [...GDELT_SNAPSHOT_CATEGORIES],
      note: 'Bounded discovery sample; GDELT indexing time is not publication time.' }, categories };
  let snapshot;
  try { snapshot = validateGdeltSnapshot(proposed, now()); }
  catch { return { status: 'skipped', reason: 'GDELT snapshot metadata failed consumer validation; previous snapshot preserved' }; }
  const bytes = new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`);
  if (bytes.byteLength > MAX_GDELT_SNAPSHOT_BYTES) return { status: 'skipped', reason: 'GDELT snapshot exceeded 1 MiB; previous snapshot preserved' };
  return { status: 'generated', snapshot, bytes };
}

/** Never overwrite a local or release asset with a skipped/partial batch. */
export async function writeGdeltSnapshot(outputDir, result) {
  if (result.status !== 'generated') return false;
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, GDELT_SNAPSHOT_ASSET);
  const temporary = path.join(directory, `${GDELT_SNAPSHOT_ASSET}.${process.pid}.tmp`);
  await writeFile(temporary, result.bytes);
  await rename(temporary, destination);
  return destination;
}

async function main() {
  const result = await generateGkgSnapshot({ demandPriority: process.env.INTELLIGENCE_DEMAND_PRIORITY !== '0', repairEnabled: process.env.INTELLIGENCE_GKG_REPAIR_ENABLED === '1' });
  const destination = await writeGdeltSnapshot(process.argv[2] || '.cache/intelligence-snapshots', result);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  console.log(JSON.stringify({ status: result.status, ...(result.reason ? { reason: result.reason, category: result.category } : {}),
    ...(destination ? { destination, bytes: result.bytes.byteLength, generatedAt: result.snapshot.generatedAt,
      kind: result.snapshot.kind, batch: result.batch, archiveBytes: result.archiveBytes, rows: result.rows, matchedRecords: result.matchedRecords,
      sampling: result.sampling,
      ...(result.snapshot.coverage.catchup ? { catchup: { pending: result.snapshot.coverage.catchup.pendingBatches.length,
        deferred: result.snapshot.coverage.catchup.deferredBatches.length, capped: result.snapshot.coverage.catchup.cappedBatches.length,
        attempted: result.snapshot.coverage.catchup.attemptedBatches.length }, factualChanged: result.factualChanged, expandedBytes: result.expandedBytes, archives: result.archives } : {}),
      counts: Object.fromEntries(GDELT_SNAPSHOT_CATEGORIES.map((category) => [category, result.snapshot.categories[category].reports.length])) } : {}) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
