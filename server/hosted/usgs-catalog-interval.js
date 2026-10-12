import { normalizeUsgs } from './intelligence-sources.js';
import { canonicalDiscoveryRecord } from '../../src/core/discovery-index.js';
import { worldTime, isWorldDigest } from '../../src/core/world-model.js';
import { ARCHIVE_SCOPE, createWorldArchiveCandidate } from '../../worker/world-archive.js';

export const USGS_CATALOG_LIMITS = Object.freeze({ records: 500, pageTarget: 250, rawBytes: 1024 * 1024,
  countBytes: 1024, requestMs: 10000, intervalMs: 32 * 86400000 });
const encoder = new TextEncoder(), catalog = 'https://earthquake.usgs.gov/fdsnws/event/1/';

/** Source/publisher ranges are CLOSED UTC millisecond intervals [from,to].
 * Adjacent split queries deliberately share the midpoint; stable source IDs dedupe it.
 * Scene membership is (at-window,at]; buffered point acquisition includes its
 * upper origin end. Cache reuse is [bufferFrom,bufferTo), a separate contract. */
export function usgsCatalogRange(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'from,to') throw new TypeError('Use exact catalog interval bounds');
  const from = worldTime(value.from), to = worldTime(value.to);
  if (from !== value.from || to !== value.to || from > to || Date.parse(to) - Date.parse(from) > USGS_CATALOG_LIMITS.intervalMs)
    throw new TypeError('Use a bounded canonical UTC catalog interval');
  return { from, to };
}
export function usgsCatalogUrl(method, value) {
  if (!['count', 'query'].includes(method)) throw new TypeError('Use a reviewed catalog operation');
  const range = usgsCatalogRange(value), url = new URL(method, catalog);
  for (const [key, item] of Object.entries({ starttime: range.from, endtime: range.to, minmagnitude: '4.5', eventtype: 'earthquake' }))
    url.searchParams.set(key, item);
  if (method === 'query') for (const [key, item] of Object.entries({ format: 'geojson', orderby: 'time-asc', limit: '501' })) url.searchParams.set(key, item);
  return url;
}
export function splitUsgsCatalogInterval(value) {
  const range = usgsCatalogRange(value), from = Date.parse(range.from), to = Date.parse(range.to);
  if (to - from <= 2000) throw new Error('Dense interval cannot be split further within the time bound');
  const middle = new Date(Math.floor((from + to) / 2)).toISOString();
  return [{ from: range.from, to: middle }, { from: middle, to: range.to }];
}
async function bytesDigest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function responseBytes(response, limit, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {}); throw new RangeError('Catalog response exceeds its byte budget');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new RangeError('Catalog response exceeds its byte budget');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    return bytes;
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
async function upstream(fetchImpl, url, limit, parentSignal) {
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(USGS_CATALOG_LIMITS.requestMs)]) : AbortSignal.timeout(USGS_CATALOG_LIMITS.requestMs);
  signal.throwIfAborted();
  const response = await fetchImpl(url.href, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: {
    accept: url.pathname.endsWith('/count') ? 'text/plain' : 'application/geo+json, application/json',
    'user-agent': 'earth-observer-archive/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' } });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw Object.assign(new Error('USGS acquisition unavailable'), { httpStatus: response.status }); }
  return { response, bytes: await responseBytes(response, limit, signal) };
}
function originalBody(bytes) {
  // Preserve every admitted UTF-8 byte. Do not strip a BOM or reserialize source JSON.
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const encoded = encoder.encode(body);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) throw new TypeError('Original UTF-8 bytes did not round trip');
  return body;
}
function validateOriginal(body, range, expectedCount) {
  const raw = JSON.parse(body);
  if (raw?.type !== 'FeatureCollection' || !Array.isArray(raw.features) || !raw.metadata || raw.features.length > USGS_CATALOG_LIMITS.records ||
      raw.metadata.count != null && raw.metadata.count !== raw.features.length || raw.metadata.status != null && raw.metadata.status !== 200)
    throw new TypeError('Invalid original catalog counts or format');
  if (raw.features.length !== expectedCount) return { changed: true, actualCount: raw.features.length };
  const url = new URL(raw.metadata.url), allowed = new Set(['format', 'starttime', 'endtime', 'minmagnitude', 'eventtype', 'orderby', 'limit', 'offset']);
  if (url.origin !== new URL(catalog).origin || url.pathname !== '/fdsnws/event/1/query' || url.username || url.password || url.hash)
    throw new TypeError('Original catalog URL is outside the fixed scope');
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError('Original catalog query narrows the fixed scope');
  const queryTime = (value) => worldTime(/^\d{4}-\d\d-\d\d$/.test(value || '') ? `${value}T00:00:00Z` : value?.endsWith('Z') ? value : `${value}Z`);
  if (url.searchParams.get('format') !== 'geojson' || url.searchParams.get('eventtype') !== 'earthquake' || Number(url.searchParams.get('minmagnitude')) !== 4.5 ||
      queryTime(url.searchParams.get('starttime')) !== range.from || queryTime(url.searchParams.get('endtime')) !== range.to ||
      url.searchParams.has('offset') && url.searchParams.get('offset') !== '1' ||
      url.searchParams.has('orderby') && !['time', 'time-asc', 'magnitude', 'magnitude-asc'].includes(url.searchParams.get('orderby')) ||
      url.searchParams.has('limit') && (!/^[1-9]\d{0,4}$/.test(url.searchParams.get('limit')) || Number(url.searchParams.get('limit')) < raw.features.length || Number(url.searchParams.get('limit')) > 20000))
    throw new TypeError('Original catalog query differs from its declared complete interval');
  const ids = new Set();
  for (const feature of raw.features) {
    const props = feature?.properties, coordinates = feature?.geometry?.coordinates;
    if (feature?.type !== 'Feature' || typeof feature.id !== 'string' || !feature.id || feature.id.length > 128 || ids.has(feature.id) ||
        props?.type !== 'earthquake' || !Number.isFinite(props.mag) || props.mag < 4.5 || !Number.isFinite(props.time) ||
        props.time < Date.parse(range.from) || props.time > Date.parse(range.to) || props.updated != null && !Number.isFinite(props.updated) ||
        feature.geometry?.type !== 'Point' || !Array.isArray(coordinates) || !Number.isFinite(coordinates[0]) || Math.abs(coordinates[0]) > 180 ||
        !Number.isFinite(coordinates[1]) || Math.abs(coordinates[1]) > 90) throw new TypeError('Catalog feature falls outside the reviewed interval');
    ids.add(feature.id);
  }
  return { raw };
}
export async function restoreUsgsCatalogCandidate({ body, metadata, now = Date.now } = {}) {
  const range = usgsCatalogRange(metadata?.range), capturedAt = worldTime(metadata?.capturedAt);
  if (metadata?.schemaVersion !== 1 || metadata.scopeId !== ARCHIVE_SCOPE.id || metadata.kind !== 'interval' || capturedAt !== metadata.capturedAt ||
      !Number.isInteger(metadata.expectedCount) || metadata.expectedCount < 0 || metadata.expectedCount > USGS_CATALOG_LIMITS.records ||
      typeof body !== 'string' || encoder.encode(body).byteLength > USGS_CATALOG_LIMITS.rawBytes || !isWorldDigest(metadata.rawSha256))
    throw new TypeError('Invalid frozen catalog candidate');
  const rawBytes = encoder.encode(body), digest = await bytesDigest(rawBytes);
  if (digest !== metadata.rawSha256 || metadata.sourceBytes !== rawBytes.length) throw new Error('Frozen original catalog bytes failed integrity validation');
  const parsed = validateOriginal(body, range, metadata.expectedCount);
  if (parsed.changed) throw new Error('Frozen catalog counts changed');
  const records = parsed.raw.features.flatMap((feature) => normalizeUsgs({ features: [feature] }, capturedAt)).map(canonicalDiscoveryRecord);
  const value = { schemaVersion: 1, scopeId: ARCHIVE_SCOPE.id, kind: 'interval', range, expectedCount: metadata.expectedCount, capturedAt,
    rawSha256: digest, sourceBytes: rawBytes.length, body, rawBytes, records };
  const candidate = await createWorldArchiveCandidate(value, { now });
  if (metadata.chunkId && metadata.chunkId !== candidate.chunkId || metadata.snapshotId && metadata.snapshotId !== candidate.snapshotId)
    throw new Error('Frozen catalog candidate identity changed');
  return { status: 'acquired', ...value, chunkId: candidate.chunkId, snapshotId: candidate.snapshotId };
}
/** One portable interval adapter for the eventual CLI and hosted runner. It never
 * publishes, certifies an empty HTTP body, or changes Live source membership. */
export async function acquireUsgsCatalogInterval({ range: value, fetchImpl = fetch, signal, now = Date.now, pageTarget = USGS_CATALOG_LIMITS.pageTarget } = {}) {
  const range = usgsCatalogRange(value);
  if (Date.parse(range.to) > now() || !Number.isInteger(pageTarget) || pageTarget < 1 || pageTarget > USGS_CATALOG_LIMITS.records)
    throw new TypeError('Use a completed interval and bounded page target');
  const counted = await upstream(fetchImpl, usgsCatalogUrl('count', range), USGS_CATALOG_LIMITS.countBytes, signal);
  const countBody = originalBody(counted.bytes);
  if (!/^\d+\s*$/.test(countBody) || !Number.isSafeInteger(Number(countBody))) throw new TypeError('Invalid independent catalog count');
  const expectedCount = Number(countBody);
  if (expectedCount > pageTarget) return { status: 'split-required', range, expectedCount, requests: 1, parts: splitUsgsCatalogInterval(range) };
  let queried;
  try { queried = await upstream(fetchImpl, usgsCatalogUrl('query', range), USGS_CATALOG_LIMITS.rawBytes, signal); }
  catch (error) {
    if (error instanceof RangeError) return { status: 'split-required', range, expectedCount, requests: 2, parts: splitUsgsCatalogInterval(range) };
    throw error;
  }
  if (!queried.bytes.length) return { status: 'gap', range, expectedCount, requests: 2, reason: 'No original GeoJSON response supplied' };
  if (!/^application\/(?:json|geo\+json)(?:\s*;|$)/i.test(queried.response.headers.get('content-type') || '')) throw new TypeError('Catalog response format changed');
  const body = originalBody(queried.bytes), parsed = validateOriginal(body, range, expectedCount);
  if (parsed.changed) return { status: 'changed-catalog', range, expectedCount, actualCount: parsed.actualCount, requests: 2, reason: 'Catalog count changed before acquisition' };
  const metadata = { schemaVersion: 1, scopeId: ARCHIVE_SCOPE.id, kind: 'interval', range, expectedCount,
    capturedAt: new Date(now()).toISOString(), rawSha256: await bytesDigest(queried.bytes), sourceBytes: queried.bytes.length };
  return { ...await restoreUsgsCatalogCandidate({ body, metadata, now }), requests: 2 };
}
