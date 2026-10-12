import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { runHostedCollectionTrigger } from './trigger-hosted-collector.mjs';

export const COLLECTOR_ACCEPTANCE_LIMITS = Object.freeze({
  durations: [10, 20, 30], intervalMs: 61_000, requestMs: 55_000,
  maxAttempts: 30, maxConsecutiveFailures: 6, maximumBackoffMs: 900_000,
});

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});

/** Finite deployment acceptance, not an application runtime or self-renewing job.
 * The invoked capability owns its fixed target, body, secret and transport bounds. */
export async function runCollectorAcceptance({ key, durationMinutes = 20,
  monotonicNow = () => performance.now(), now = Date.now, sleepImpl = sleep,
  invoke = runHostedCollectionTrigger, onAttempt = () => {}, cancelled = () => false, signal } = {}) {
  if (!COLLECTOR_ACCEPTANCE_LIMITS.durations.includes(durationMinutes)) throw new TypeError('Use a reviewed acceptance duration');
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(key)) return { status: 'unconfigured', attempts: 0 };
  const started = monotonicNow(), deadline = started + durationMinutes * 60_000;
  let attempts = 0, successes = 0, failures = 0, consecutiveFailures = 0, factualPublications = 0, unchangedChecks = 0;
  let stopReason = 'duration';
  while (attempts < COLLECTOR_ACCEPTANCE_LIMITS.maxAttempts) {
    if (cancelled() || signal?.aborted) { stopReason = 'cancelled'; break; }
    const attemptAt = monotonicNow();
    if (attemptAt + COLLECTOR_ACCEPTANCE_LIMITS.requestMs > deadline) break;
    let result;
    try { result = await invoke({ key, now, timeoutMs: COLLECTOR_ACCEPTANCE_LIMITS.requestMs }); }
    catch { result = { ok: false, summary: { status: 'request_failed', stored: null } }; }
    attempts++;
    if (result?.ok === true) {
      successes++; consecutiveFailures = 0;
      if (result.summary?.factualPublication === true) factualPublications++;
      if (result.summary?.heartbeat === true) unchangedChecks++;
    } else { failures++; consecutiveFailures++; }
    // Only the already-redacted capability acknowledgment reaches logs.
    onAttempt({ purpose: 'deployment-acceptance', attempt: attempts, at: new Date(now()).toISOString(),
      acknowledgment: result?.summary || { status: 'invalid_response', stored: false } });
    if (consecutiveFailures >= COLLECTOR_ACCEPTANCE_LIMITS.maxConsecutiveFailures) { stopReason = 'consecutive-failures'; break; }
    if (cancelled() || signal?.aborted) { stopReason = 'cancelled'; break; }
    const interval = consecutiveFailures ? Math.min(COLLECTOR_ACCEPTANCE_LIMITS.maximumBackoffMs,
      COLLECTOR_ACCEPTANCE_LIMITS.intervalMs * 2 ** (consecutiveFailures - 1)) : COLLECTOR_ACCEPTANCE_LIMITS.intervalMs;
    const remaining = deadline - monotonicNow();
    const delay = Math.max(0, attemptAt + interval - monotonicNow());
    if (delay + COLLECTOR_ACCEPTANCE_LIMITS.requestMs > remaining) break;
    await sleepImpl(delay, signal);
  }
  if (attempts === COLLECTOR_ACCEPTANCE_LIMITS.maxAttempts) stopReason = 'attempt-budget';
  return { purpose: 'deployment-acceptance', status: successes > 0 && failures === 0 ? 'passed' : 'incomplete',
    durationMinutes, attempts, successes, failures, factualPublications, unchangedChecks, stopReason,
    elapsedMs: Math.round(monotonicNow() - started), endedAt: new Date(now()).toISOString() };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (process.argv.length !== 2) throw new TypeError('No command-line arguments are admitted');
    const result = await runCollectorAcceptance({ key: process.env.EARTH_TRIGGER_HMAC_KEY,
      durationMinutes: Number(process.env.EARTH_ACCEPTANCE_MINUTES || 20), signal: controller.signal,
      onAttempt: value => process.stdout.write(JSON.stringify(value) + '\n') });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch { process.stderr.write('Invalid collection acceptance configuration.\n'); process.exitCode = 1; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
