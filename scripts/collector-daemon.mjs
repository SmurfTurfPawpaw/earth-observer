import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollector } from '../collector-worker/index.js';

export const COLLECTOR_PUBLISH_URL = 'https://giovannicallebaut.com/earth/api/collector';
const INTERVAL_MS = 60000, DEADLINE_MS = 90000;
const DEFAULT_STATE_DIRECTORY = fileURLToPath(new URL('../.cache/collector/', import.meta.url));
const OUTCOMES = new Set(['accepted', 'waiting', 'published', 'changed', 'unchanged', 'outbox-pending', 'backoff',
  'pending', 'ready', 'ready-local', 'queued', 'idle', 'partial', 'unavailable', 'http-error', 'timeout', 'invalid-response', 'request-failed',
  'storage-unavailable', 'invalid-configuration']);
const safeTime = (value) => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 && at <= 8640000000000000 ? new Date(at).toISOString() : null;
};
const safeCount = (value) => Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : undefined;

/** Logs only allowlisted summary fields; credentials, raw records and error bodies never enter output. */
export function summarizeCycle(value, { mode, now = Date.now } = {}) {
  const summary = { event: 'collector-cycle', checkedAt: new Date(now()).toISOString(), mode,
    outcome: OUTCOMES.has(value?.outcome) ? value.outcome : OUTCOMES.has(value?.status) ? value.status : 'cycle-completed' };
  for (const key of ['recordCount', 'changedRecords', 'revisedRecords', 'analysisCount', 'sourceCount', 'readySources', 'staleSources', 'unavailableSources'])
    if (safeCount(value?.[key]) !== undefined) summary[key] = value[key];
  for (const key of ['lastAttemptAt', 'lastSuccessAt', 'retryAt', 'nextAttemptAt']) if (safeTime(value?.[key])) summary[key] = safeTime(value[key]);
  if (typeof value?.published === 'boolean') summary.published = value.published;
  if (Number.isInteger(value?.lastHttpStatus) && value.lastHttpStatus >= 100 && value.lastHttpStatus <= 599) summary.lastHttpStatus = value.lastHttpStatus;
  return summary;
}

/** One serialized local acquisition/inference/publication cycle per minute. No automatic execution when imported. */
export function createCollectorDaemon({ credential, stateDirectory = DEFAULT_STATE_DIRECTORY,
  triggerOnly = false, once = false, fetchImpl = (...args) => fetch(...args), now = Date.now,
  logger = (value) => console.log(JSON.stringify(value)), pipelineFactory,
} = {}) {
  if (typeof credential !== 'string' || !/^[a-fA-F0-9]{32,256}$/.test(credential))
    throw new Error('Collector requires a hexadecimal server credential of at least 32 characters');
  let stopped = false, running = false, cycleController, timer, wake, pipeline, pipelineWork;
  const shutdown = new AbortController(), mode = triggerOnly ? 'hosted-trigger-fallback' : 'local-pipeline';
  const emit = (value) => logger(value);
  const trackedFetch = (url, options = {}) => {
    const signals = [shutdown.signal, cycleController?.signal, options.signal].filter(Boolean);
    const signal = AbortSignal.any(signals); signal.throwIfAborted();
    return fetchImpl(url, { ...options, signal });
  };
  async function initialize() {
    if (pipeline) return;
    if (triggerOnly) {
      const client = createCollector({ now, fetchImpl: trackedFetch, timeoutMs: DEADLINE_MS });
      const env = { EARTH_TARGET_ORIGIN: 'https://giovannicallebaut.com', EARTH_COLLECTOR_TOKEN: credential };
      pipeline = { cycle: () => client.run(env), status: () => client.status(env) };
    } else {
      const factory = pipelineFactory || (await import('./local-intelligence-pipeline.mjs')).createLocalPipeline;
      if (typeof factory !== 'function') throw new Error('Local collector pipeline unavailable');
      pipeline = await factory({ stateDirectory: path.resolve(stateDirectory), fetchImpl: trackedFetch, now,
        publishUrl: COLLECTOR_PUBLISH_URL, publishCredential: credential, gdeltMode: 'local-gkg',
        getSignal: () => AbortSignal.any([shutdown.signal, cycleController?.signal].filter(Boolean)) });
      if (!pipeline || typeof pipeline.cycle !== 'function') throw new Error('Local collector pipeline unavailable');
    }
  }
  const wait = (milliseconds) => new Promise((resolve) => {
    if (stopped || milliseconds <= 0) { resolve(); return; }
    wake = resolve; timer = setTimeout(() => { timer = null; wake = null; resolve(); }, milliseconds);
  });
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); timer = null; wake?.(); wake = null;
    const reason = new DOMException('Collector stopping', 'AbortError');
    shutdown.abort(reason); cycleController?.abort(reason);
    pipeline?.close?.();
  }
  async function cycle() {
    if (stopped) return null;
    if (pipelineWork) return pipelineWork;
    const controller = new AbortController(); cycleController = controller;
    const deadline = setTimeout(() => {
      controller.abort(new DOMException('Collector cycle deadline reached', 'TimeoutError'));
      emit({ event: 'collector-deadline', checkedAt: new Date(now()).toISOString(), mode });
    }, DEADLINE_MS);
    const work = (async () => {
      try {
        const result = await pipeline.cycle();
        const summary = summarizeCycle(result, { mode, now });
        if (controller.signal.aborted) summary.outcome = stopped ? 'stopped' : 'timeout';
        emit(summary); return summary;
      } catch {
        const summary = { event: 'collector-cycle', checkedAt: new Date(now()).toISOString(), mode,
          outcome: stopped ? 'stopped' : controller.signal.aborted ? 'timeout' : 'cycle-failed' };
        emit(summary); return summary;
      } finally { clearTimeout(deadline); if (cycleController === controller) cycleController = null; }
    })();
    pipelineWork = work;
    try { return await work; } finally { if (pipelineWork === work) pipelineWork = null; }
  }
  async function start() {
    if (running) throw new Error('Collector daemon already running');
    running = true;
    try {
      await initialize();
      emit({ event: 'collector-start', checkedAt: new Date(now()).toISOString(), mode,
        intervalMs: INTERVAL_MS, requestDeadlineMs: DEADLINE_MS, localBridge: true });
      while (!stopped) {
        const startedAt = now(); await cycle();
        if (once) break;
        await wait(Math.max(0, startedAt + INTERVAL_MS - now()));
      }
    } finally { running = false; }
  }
  return { start, stop, status() { return { running, stopped, mode, cycleRunning: Boolean(pipelineWork) }; } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/collector-daemon.mjs [--once] [--trigger-only]\nDefault: local acquisition and derived inference before authenticated publication. EARTH_COLLECTION_SECRET (or EARTH_COLLECTOR_TOKEN) must be a 32+ character hexadecimal server secret. This temporary computer process must remain running with Internet access; it is not a deployed cloud service. No URL argument is accepted.');
    return;
  }
  if (args.some((value) => !['--once', '--trigger-only'].includes(value))) throw new Error('Invalid collector arguments');
  const daemon = createCollectorDaemon({ credential: process.env.EARTH_COLLECTION_SECRET || process.env.EARTH_COLLECTOR_TOKEN,
    once: args.includes('--once'), triggerOnly: args.includes('--trigger-only') });
  const stop = () => daemon.stop(); process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await daemon.start(); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error(JSON.stringify({ event: 'collector-stopped', outcome: 'configuration-or-pipeline-unavailable' })); process.exitCode = 1; });
