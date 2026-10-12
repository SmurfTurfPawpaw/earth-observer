import { runCoverageWake, enqueueCoveragePriority, readCoverageStatus, coverageSector } from './coverage-scheduler.js';
import { readPreparedUsgsScene } from './prepared-usgs-store.js';
import { readWorldSourceItems } from './world-model.js';

export const COVERAGE_STATUS_PATH = '/api/coverage/status';
export const COVERAGE_RUNTIME_LIMITS = Object.freeze({ deadlineMs: 20000, sourceReadMs: 5000, urgentSectors: 4, responseBytes: 256 * 1024 });
const pending = new WeakMap(), iso = value => new Date(value).toISOString();
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const inSector = (record, sector) => {
  if (!Number.isFinite(record?.lon) || !Number.isFinite(record.lat) || Math.abs(record.lon) > 180 || Math.abs(record.lat) > 90) return false;
  const lon = ((record.lon + 180) % 360 + 360) % 360 - 180, b = sector.bounds;
  return lon >= b.west && lon < b.east && record.lat >= b.south && (record.lat < b.north || b.north === 90);
};
const sectorAt = record => {
  for (let id = 1; id <= 120; ++id) if (inSector(record, coverageSector(id))) return id;
  return null;
};
async function boundedRead(operation, signal) {
  signal.throwIfAborted(); let stop;
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
    new Promise((_, reject) => { stop = () => reject(signal.reason || new DOMException('Stored source deadline', 'TimeoutError'));
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); })]); }
  finally { if (stop) signal.removeEventListener('abort', stop); }
}

/** Read each source once per admitted wake. None of these readers acquire providers. */
export function createStoredSectorProcessor(env, { now = Date.now, signal,
  readUsgs = readPreparedUsgsScene, readGdacs = readWorldSourceItems, sourceReadMs = COVERAGE_RUNTIME_LIMITS.sourceReadMs } = {}) {
  if (!Number.isInteger(sourceReadMs) || sourceReadMs < 1 || sourceReadMs > COVERAGE_RUNTIME_LIMITS.sourceReadMs) throw new TypeError('Use a bounded stored-source deadline');
  let acquired;
  const sources = () => acquired ||= (async () => {
    const stopped = signal ? AbortSignal.any([signal, AbortSignal.timeout(sourceReadMs)]) : AbortSignal.timeout(sourceReadMs);
    const results = await Promise.allSettled([
      boundedRead(() => readUsgs(env, { now, signal: stopped }), stopped),
      boundedRead(() => readGdacs(env, { source: 'gdacs' }, { now, signal: stopped, deadlineMs: sourceReadMs }), stopped),
    ]);
    signal?.throwIfAborted();
    const admitted = [], missingSources = [];
    const usgs = results[0].status === 'fulfilled' ? results[0].value : null;
    if (usgs?.available === true && usgs.prepared?.source?.receiptId === usgs.source?.receiptId && Array.isArray(usgs.prepared.content?.features)) {
      const s = usgs.source;
      admitted.push({ sourceId: 'usgs', scopeId: s.scopeId, version: usgs.prepared.version,
        receiptId: s.receiptId, fence: s.fence, capturedAt: s.capturedAt, recordedAt: s.recordedAt,
        sourceGeneratedAt: s.sourceGeneratedAt, completeRetainedCohort: true,
        coverageMeaning: 'Retained rolling-day USGS seismic response, M2.5+; no physical or historical completeness asserted',
        records: usgs.prepared.content.features.map(feature => feature.record), sourceReports: usgs.prepared.content.features.length,
        stale: usgs.stale !== false });
    } else missingSources.push('usgs');
    const gdacs = results[1].status === 'fulfilled' ? results[1].value : null;
    if (gdacs?.available === true && gdacs.coverage?.completeRetainedCohort === true && Array.isArray(gdacs.items)) {
      const c = gdacs.cohort;
      admitted.push({ sourceId: 'gdacs', scopeId: 'gdacs-retained-seven-day-notices', version: gdacs.version,
        capturedAt: c.capturedAt, recordedAt: c.publishedAt, collectionBasis: c.snapshotId,
        completeRetainedCohort: true, coverageMeaning: 'Retained seven-day GDACS notice sample; indicative locations, modeled source alerts, not a complete provider archive',
        records: gdacs.items.map(item => item.record), sourceReports: gdacs.items.length, stale: null });
    } else missingSources.push('gdacs');
    return { admitted, missingSources };
  })();
  return {
    async processSector({ sector, signal: workSignal }) {
      workSignal?.throwIfAborted(); const input = await sources(); workSignal?.throwIfAborted();
      if (!input.admitted.length) return { available: false };
      const basis = input.admitted.map(source => {
        const { records, sourceReports: _sourceReports, stale, ...retained } = source;
        const selected = records.filter(record => inSector(record, sector));
        return { ...retained, selectedCount: selected.length, scopeIssues: stale === true ? ['source-stale'] : stale === null ? ['source-freshness-unknown'] : [] };
      });
      return { available: true, basis, summary: { sourceReports: Object.fromEntries(input.admitted.map(source => [source.sourceId, source.sourceReports])),
        selectedReports: Object.fromEntries(basis.map(source => [source.sourceId, source.selectedCount])),
        missingSources: input.missingSources, meaning: 'Successful processing of these retained source scopes only; processing time is not new source acquisition' } };
    },
    async urgentSectors() {
      const { admitted } = await sources(), candidates = new Map();
      for (const source of admitted) for (const record of source.records) {
        signal?.throwIfAborted();
        const eventAt = source.sourceId === 'usgs' ? record.updatedAt ?? record.time : record.updatedAt ?? record.observedAt;
        const at = Number.isFinite(eventAt) ? eventAt : utc(eventAt) ? Date.parse(eventAt) : null;
        // A reported scientific threshold or modeled alert admits investigation.
        // It does not establish deaths, consequences, global reach or a new event.
        const warrantsInvestigation = source.sourceId === 'usgs' ? record.eventType === 'earthquake' && record.mag >= 6 : String(record.alertLevel).toLowerCase() === 'red';
        if (!warrantsInvestigation || at === null || at > now() || now() - at >= 3600000) continue;
        const sectorId = sectorAt(record); if (sectorId === null) continue;
        const expiresAt = iso(at + 3600000), previous = candidates.get(sectorId);
        if (!previous || expiresAt > previous.expiresAt) candidates.set(sectorId, { sectorId, reason: 'urgent', priority: 90, expiresAt });
      }
      return [...candidates.values()].sort((a, b) => b.expiresAt.localeCompare(a.expiresAt) || a.sectorId - b.sectorId).slice(0, COVERAGE_RUNTIME_LIMITS.urgentSectors);
    },
  };
}

/** Separate from the collector's provider admission. Only the authenticated trigger calls this owner. */
export function startCoverageWake(env, ctx, { now = Date.now, processorFactory = createStoredSectorProcessor,
  run = runCoverageWake, enqueue = enqueueCoveragePriority } = {}) {
  if (!env?.EARTH_DB?.prepare || !env?.EARTH_DB?.batch || !env?.EARTH_STORE?.get) return { scheduled: false, status: 'unconfigured' };
  if (typeof ctx?.waitUntil !== 'function') return { scheduled: false, status: 'background-unavailable' };
  const owner = env.EARTH_DB;
  if (pending.has(owner)) { try { ctx.waitUntil(pending.get(owner)); return { scheduled: false, status: 'already-running' }; }
    catch { return { scheduled: false, status: 'background-unavailable' }; } }
  let registered = false;
  const operation = Promise.resolve().then(async () => {
    if (!registered) return null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Coverage wake deadline', 'TimeoutError')), COVERAGE_RUNTIME_LIMITS.deadlineMs);
    try {
      const processor = processorFactory(env, { now, signal: controller.signal });
      // The durable scheduler admits the wake before any retained source read.
      const result = await run(env, { now, signal: controller.signal, processSector: processor.processSector });
      if (result?.admitted !== true || result.status !== 'processed' || controller.signal.aborted) return result;
      const jobs = await boundedRead(() => processor.urgentSectors(), controller.signal);
      for (const job of jobs) { controller.signal.throwIfAborted(); await enqueue(env, job, { now, signal: controller.signal }); }
      return result;
    } catch { return { configured: true, status: 'unavailable' }; }
    finally { clearTimeout(timer); }
  }).finally(() => { if (pending.get(owner) === operation) pending.delete(owner); });
  try { ctx.waitUntil(operation); registered = true; pending.set(owner, operation); return { scheduled: true, status: 'scheduled' }; }
  catch { return { scheduled: false, status: 'background-unavailable' }; }
}

export function createCoverageStatusHandler({ now = Date.now, read = readCoverageStatus } = {}) {
  return async (request, env) => {
    const url = new URL(request.url); if (url.pathname !== COVERAGE_STATUS_PATH) return null;
    const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
    if (request.method !== 'GET') return reply({ available: false, error: 'method-not-allowed' }, 405, { allow: 'GET' });
    if (url.search) return reply({ available: false, error: 'invalid-coverage-query' }, 400);
    try { const value = await read(env, { now, signal: request.signal });
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > COVERAGE_RUNTIME_LIMITS.responseBytes) throw new Error('Coverage status budget');
      return reply(value, value.configured === true && value.available !== false ? 200 : 503);
    } catch { return reply({ available: false, error: 'coverage-status-unavailable' }, 503); }
  };
}
