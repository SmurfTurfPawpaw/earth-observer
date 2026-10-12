import { SOURCE_PLUGINS } from './registry.js';
import { runSourcePlugin, PLUGIN_STORE_LIMITS } from './store.js';

const pending = new WeakMap();
export const PLUGIN_RUNNER_LIMITS = Object.freeze({ concurrentSources: 2, deadlineMs: PLUGIN_STORE_LIMITS.deadlineMs });
export async function advanceSourcePlugins(env, options = {}) {
  const { deadlineMs = PLUGIN_RUNNER_LIMITS.deadlineMs, ...sourceOptions } = options;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PLUGIN_RUNNER_LIMITS.deadlineMs)
    throw new TypeError('Use the bounded source-plugin wake deadline');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Source-plugin wake budget exceeded', 'TimeoutError')), deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const results = new Array(SOURCE_PLUGINS.length); let next = 0;
  async function worker() {
    while (next < SOURCE_PLUGINS.length) {
      const index = next++, plugin = SOURCE_PLUGINS[index];
      if (signal.aborted) { results[index] = { pluginId: plugin.pluginId, status: 'deferred', acquired: false, changed: false }; continue; }
      results[index] = await runSourcePlugin(env, plugin, { ...sourceOptions, signal });
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(PLUGIN_RUNNER_LIMITS.concurrentSources, SOURCE_PLUGINS.length) }, worker)); }
  finally { clearTimeout(timer); }
  return { schemaVersion: 1, results };
}

/** Called only after collector authorization and fixed collect-action admission.
 * No detached execution when the host cannot retain a bounded background task. */
export function startSourcePlugins(env, ctx, options = {}) {
  if (typeof ctx?.waitUntil !== 'function') return { scheduled: false, status: 'background_unavailable' };
  if (options.signal?.aborted) return { scheduled: false, status: 'cancelled' };
  const owner = env.EARTH_DB || env;
  if (pending.has(owner)) {
    try { ctx.waitUntil(pending.get(owner)); return { scheduled: false, status: 'already_running' }; }
    catch { return { scheduled: false, status: 'background_unavailable' }; }
  }
  let registered = false;
  const operation = Promise.resolve().then(() => registered ? advanceSourcePlugins(env, options) : null)
    .catch(() => ({ schemaVersion: 1, status: 'unavailable' })).finally(() => { if (pending.get(owner) === operation) pending.delete(owner); });
  try { ctx.waitUntil(operation); registered = true; pending.set(owner, operation);
    return { scheduled: true, status: 'scheduled', pluginCount: SOURCE_PLUGINS.length }; }
  catch { return { scheduled: false, status: 'background_unavailable' }; }
}
