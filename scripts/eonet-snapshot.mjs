import { mkdir, open, rename, unlink, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readResponseJsonCapped } from '../server/providers/common/http.js';
import { createEonetSnapshot, EONET_QUERY_URL, EONET_UPSTREAM_MAX_BYTES, EONET_SNAPSHOT_MAX_BYTES } from '../server/hosted/eonet-snapshot.js';

export const EONET_SNAPSHOT_ASSET = 'eonet.snapshot.json';
const HEADERS = Object.freeze({ Accept: 'application/json', 'User-Agent': 'earth-observer-eonet/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' });
const initialState = () => ({ failures: 0, retryAt: 0, lastAttemptAt: null, lastSuccessAt: null });
function retryState(value, nowMs) {
  if (!value || Object.keys(value).sort().join(',') !== 'failures,lastAttemptAt,lastSuccessAt,retryAt' ||
      !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 6 || !Number.isFinite(value.retryAt) || value.retryAt < 0 || value.retryAt > 8640000000000000 ||
      ['lastAttemptAt', 'lastSuccessAt'].some((key) => value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 32 ||
        !Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString() !== value[key] || Date.parse(value[key]) > nowMs + 300000))) return initialState();
  return { ...value };
}
function retryAfter(response, at) {
  const raw = response.headers.get('retry-after');
  if (!raw) return 0;
  const value = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - at;
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 8640000000000000 - at) : 0;
}

/** Exactly one fixed upstream request; skipped runs leave the last-good asset untouched. */
export async function generateEonetSnapshot({ fetchImpl = fetch, now = Date.now, timeoutMs = 15000, previousRetryState } = {}) {
  const previous = retryState(previousRetryState, now());
  if (previous.retryAt > now()) return { status: 'skipped', reason: 'EONET acquisition paused by persisted provider backoff; previous snapshot preserved', retryState: previous };
  const lastAttemptAt = new Date(now()).toISOString(), signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(EONET_QUERY_URL, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: HEADERS });
    if (!response.ok) {
      const retryAfterMs = retryAfter(response, now()); await response.body?.cancel();
      throw Object.assign(new Error(`EONET HTTP ${response.status}`), { httpStatus: response.status, retryAfterMs });
    }
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) { await response.body?.cancel(); throw new Error('EONET response is not JSON metadata'); }
    const payload = await readResponseJsonCapped(response, EONET_UPSTREAM_MAX_BYTES, signal);
    signal.throwIfAborted();
    const retrievedAt = new Date(now()).toISOString();
    const snapshot = await createEonetSnapshot(payload, { retrievedAt, generatedAt: new Date(now()).toISOString(), nowMs: now() });
    signal.throwIfAborted();
    const bytes = new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`);
    if (bytes.byteLength > EONET_SNAPSHOT_MAX_BYTES) throw new Error('Normalized EONET snapshot exceeds 100 KiB');
    return { status: 'generated', snapshot, bytes,
      retryState: { failures: 0, retryAt: 0, lastAttemptAt, lastSuccessAt: retrievedAt } };
  } catch (error) {
    const failures = Math.min(6, previous.failures + 1);
    return { status: 'skipped', reason: `${error.name === 'TimeoutError' ? 'EONET request timed out' : error.message}; previous snapshot preserved`,
      retryState: { failures, retryAt: now() + Math.max(Math.min(300000 * 2 ** (failures - 1), 3600000), error.retryAfterMs || 0),
        lastAttemptAt, lastSuccessAt: previous.lastSuccessAt } };
  }
}

export async function writeEonetSnapshot(outputDir, result) {
  if (result.status !== 'generated') return false;
  const directory = path.resolve(outputDir), destination = path.join(directory, EONET_SNAPSHOT_ASSET);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  try { await writeFile(temporary, result.bytes); await rename(temporary, destination); }
  finally { await unlink(temporary).catch(() => {}); }
  return destination;
}

export async function loadEonetRetryState(filename) {
  let file;
  try {
    file = await open(filename, 'r'); const bytes = new Uint8Array(8193);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) return null;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } catch { return null; }
  finally { await file?.close(); }
}

async function main() {
  const stateFile = path.resolve(process.env.EONET_RETRY_STATE || '.cache/eonet-state/acquisition.json');
  const previousRetryState = await loadEonetRetryState(stateFile);
  const result = await generateEonetSnapshot({ previousRetryState });
  const destination = await writeEonetSnapshot(process.argv[2] || '.cache/intelligence-snapshots', result);
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(result.retryState)}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  console.log(JSON.stringify({ status: result.status, ...(result.reason ? { reason: result.reason } : {}), retryAt: result.retryState.retryAt || null,
    ...(destination ? { destination, bytes: result.bytes.byteLength, generation: result.snapshot.generation,
      retrievedAt: result.snapshot.retrievedAt, generatedAt: result.snapshot.generatedAt, coverage: result.snapshot.coverage } : {}) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
