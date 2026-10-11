import { readResponseBytesCapped } from '../providers/common/http.js';
import { pluginBytesDigest, pluginFactsDigest } from '../../src/core/plugin-evidence.js';
import { EUROSTAT_GAS_SCOPE_ID, EUROSTAT_GAS_URL, EUROSTAT_GAS_DATASET_URL, EUROSTAT_GAS_POLICY_ID,
  decodeEurostatGasOrigins, canonicalEurostatGasFacts, createEurostatGasDossier, eurostatGasItems } from '../../src/core/eurostat-gas-origins.js';

export { eurostatGasItems };
export const EUROSTAT_GAS_PLUGIN = Object.freeze({ schemaVersion: 1, pluginId: 'eurostat-gas-origins-v1', scopeId: EUROSTAT_GAS_SCOPE_ID,
  sourceId: 'eurostat', kind: 'dataset', name: 'Belgium natural-gas import origins', sourceUrl: EUROSTAT_GAS_URL,
  datasetUrl: EUROSTAT_GAS_DATASET_URL, cadenceMs: 21_600_000, maxResponseBytes: 512 * 1024,
  deadlineMs: 20_000, maxItems: 1, maxArtifactBytes: 65_536, artifactPolicyId: EUROSTAT_GAS_POLICY_ID,
  rights: Object.freeze({ policyUrl: 'https://ec.europa.eu/eurostat/about-us/communicating-disseminating-statistics',
    attribution: 'Source: Eurostat, nrg_ti_gas. Shares calculated by Earth Observer; source quantities and flags retained.',
    scope: 'Attributed public statistical quantities, codes, labels and observation flags; supported annual ratios calculated from reported TOTAL.' }),
  coverage: Object.freeze({ mode: 'fixed-annual-query', completeArchive: false, referenceYearsFrom: '2024', absenceMeaning: 'missing-observation-not-zero' }) });
const error = (code, retryAfterMs = 0) => Object.assign(new Error(code), { code, retryAfterMs });
const etag = value => typeof value === 'string' && /^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(value) ? value : null;
const modified = value => typeof value === 'string' && value.length <= 128 && !/[\r\n]/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function abortable(operation, signal) {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function updated(value, checkedMs) {
  if (value === undefined || value === null) return null;
  const fields = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-](\d\d):?(\d\d))$/.exec(value);
  if (!fields) throw error('source_invalid_dataset');
  const [year, month, day, hour, minute, second] = fields.slice(1, 7).map(Number);
  const offsetHour = Number(fields[7] || 0), offsetMinute = Number(fields[8] || 0);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(Date.parse(value)) || Date.parse(value) > checkedMs + 300000) throw error('source_invalid_dataset');
  return new Date(value).toISOString();
}

/** Fixed anonymous adapter. Shared server orchestration owns due times, leases and storage. */
export function createEurostatGasCollector({ timeoutMs = EUROSTAT_GAS_PLUGIN.deadlineMs } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EUROSTAT_GAS_PLUGIN.deadlineMs) throw new TypeError('Use a bounded Eurostat deadline');
  return async function collect({ now = Date.now, signal: external, previous = {}, fetchImpl = fetch } = {}) {
    external?.throwIfAborted();
    const controller = new AbortController(), signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(error('source_deadline')), timeoutMs);
    try {
      const validators = { etag: etag(previous.validators?.etag), lastModified: modified(previous.validators?.lastModified) };
      const headers = { Accept: 'application/json', 'User-Agent': 'earth-observer/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)',
        ...(validators.etag ? { 'If-None-Match': validators.etag } : validators.lastModified ? { 'If-Modified-Since': validators.lastModified } : {}) };
      const response = await abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return fetchImpl(EUROSTAT_GAS_URL,
        { headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }); }), signal);
      signal.throwIfAborted();
      if (!(response instanceof Response) || response.redirected || response.url && response.url !== EUROSTAT_GAS_URL) {
        void response?.body?.cancel().catch(() => {}); throw error('source_invalid_response');
      }
      const currentValidators = { etag: etag(response.headers.get('etag')),
        lastModified: modified(response.headers.get('last-modified')) };
      const checkedMs = now(), checkedAt = new Date(checkedMs).toISOString();
      const base = { schemaVersion: 1, pluginId: EUROSTAT_GAS_PLUGIN.pluginId, scopeId: EUROSTAT_GAS_SCOPE_ID,
        kind: 'dataset', checkedAt, validators: currentValidators, sourceUrl: EUROSTAT_GAS_URL };
      if (response.status === 304) {
        void response.body?.cancel().catch(() => {});
        if (!sha(previous.factsDigest) || !validators.etag && !validators.lastModified) throw error('source_not_modified_without_baseline');
        return { ...base, validators: { etag: currentValidators.etag || validators.etag,
          lastModified: currentValidators.lastModified || validators.lastModified }, outcome: 'not-modified', sourceUpdatedAt: null, sourceVersion: null,
          raw: null, canonicalFacts: null, factsDigest: previous.factsDigest, artifact: null };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const retry = response.headers.get('retry-after'), wait = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - checkedMs;
        throw error(response.status === 429 ? 'source_limit' : 'source_http_error', Number.isFinite(wait) ? Math.min(86_400_000, Math.max(0, wait)) : 0);
      }
      const mediaType = response.headers.get('content-type') || '';
      if (!/^application\/json(?:\s*;|$)/i.test(mediaType)) { void response.body?.cancel().catch(() => {}); throw error('source_invalid_response'); }
      const bytes = await abortable(readResponseBytesCapped(response, EUROSTAT_GAS_PLUGIN.maxResponseBytes, signal), signal);
      signal.throwIfAborted();
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw error('source_invalid_json'); }
      let decoded;
      try { decoded = decodeEurostatGasOrigins(payload); } catch { throw error('source_invalid_dataset'); }
      const rawSha256 = await abortable(pluginBytesDigest(bytes), signal);
      const canonicalFacts = await abortable(canonicalEurostatGasFacts(decoded.cube), signal);
      const factsDigest = await abortable(pluginFactsDigest(canonicalFacts), signal);
      const sourceUpdatedAt = updated(payload.updated, now());
      const artifact = createEurostatGasDossier(canonicalFacts, decoded.locators,
        { rawSha256, sourceUpdatedAt, sourceVersion: decoded.sourceVersion, factsDigest });
      signal.throwIfAborted();
      return { ...base, checkedAt: new Date(now()).toISOString(), outcome: 'validated', sourceUpdatedAt,
        sourceVersion: decoded.sourceVersion, raw: { bytes, mediaType: 'application/json', sha256: rawSha256 }, canonicalFacts, factsDigest, artifact };
    } catch (caught) {
      if (signal.aborted) throw error(external?.aborted ? 'source_cancelled' : 'source_deadline');
      if (caught?.code === 'RESPONSE_TOO_LARGE') throw error('source_response_limit');
      if (typeof caught?.code === 'string' && caught.code.startsWith('source_')) throw caught;
      throw error('source_unavailable');
    } finally { clearTimeout(timer); }
  };
}
export const collectEurostatGasOrigins = createEurostatGasCollector();
