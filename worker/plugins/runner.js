import { SOURCE_PLUGINS } from './registry.js';
import { runSourcePlugin } from './store.js';

const pending = new WeakMap();
export async function advanceSourcePlugins(env, options = {}) {
  const results = await Promise.all(SOURCE_PLUGINS.map(plugin => runSourcePlugin(env, plugin, options)));
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
