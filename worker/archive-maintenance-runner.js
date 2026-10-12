import { runArchiveMaintenance } from './archive-maintenance.js';
import { publishWorldArchiveChunk } from './world-archive.js';

const pending = new WeakMap();
/** Only the existing authorized fixed collect action calls this. Host background
 * task retention is required; a visitor read or unsupported host acquires nothing. */
export function startArchiveMaintenance(env, ctx, { now = Date.now, fetchImpl = fetch } = {}) {
  if (typeof ctx?.waitUntil !== 'function') return { scheduled: false, status: 'background-unavailable' };
  const owner = env.EARTH_DB || env;
  if (pending.has(owner)) { try { ctx.waitUntil(pending.get(owner)); return { scheduled: false, status: 'already-running' }; }
    catch { return { scheduled: false, status: 'background-unavailable' }; } }
  let registered = false;
  const operation = Promise.resolve().then(() => registered ? runArchiveMaintenance(env, { now, fetchImpl,
    publishPrepared: ({ env: scoped, acquired, plan }) => {
      const settlement = publishWorldArchiveChunk(scoped, acquired, { now, maintenanceCommit: plan });
      // The bounded caller may return uncertain while SQL/R2 is settling. Retain
      // the real operation too; its initial fence cannot admit after release.
      ctx.waitUntil(settlement.catch(() => null)); return settlement;
    } }) : null)
    .catch(() => ({ status: 'unavailable' })).finally(() => { if (pending.get(owner) === operation) pending.delete(owner); });
  try { ctx.waitUntil(operation); registered = true; pending.set(owner, operation); return { scheduled: true, status: 'scheduled' }; }
  catch { return { scheduled: false, status: 'background-unavailable' }; }
}
