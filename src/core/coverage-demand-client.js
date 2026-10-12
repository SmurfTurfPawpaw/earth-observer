import { coverageDemandSectors } from './coverage-grid.js';

/** Single browser owner for coarse functional demand, independent of layer
 * count and optional analytics. Hidden/history/QA sessions never submit it. */
export function createCoverageDemandClient({ fetchImpl = globalThis.fetch, now = Date.now,
  documentRef = globalThis.document, enabled = true, getDemand, isLive = () => true,
  schedule = setTimeout, cancel = clearTimeout, baseUrl = import.meta.env?.BASE_URL || '/' } = {}) {
  if (!['/', '/earth/'].includes(baseUrl)) throw new TypeError('Unsupported Earth base path');
  let destroyed = false, timer = null, controller = null, nextAllowedAt = 0;
  const current = () => enabled && !destroyed && !documentRef?.hidden && isLive();
  const arm = delay => { if (timer !== null) cancel(timer); timer = null;
    if (current()) timer = schedule(() => { timer = null; void submit(); }, delay); };
  async function submit() {
    if (!current()) return;
    if (now() < nextAllowedAt || controller) { arm(Math.max(1000, nextAllowedAt - now())); return; }
    let sectors; try { sectors = coverageDemandSectors(getDemand?.()); } catch { sectors = []; }
    if (!sectors.length) return;
    const owner = new AbortController(); controller = owner; nextAllowedAt = now() + 60000;
    const timeout = schedule(() => owner.abort(), 8000);
    try { const response = await fetchImpl(`${baseUrl}api/coverage/demand`, { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-earth-client': 'interactive-viewport-v1' },
        body: JSON.stringify({ schemaVersion: 1, reason: 'viewport', sectors }), signal: owner.signal });
      // No response body is needed; no user profile or count is returned.
      void response.body?.cancel?.().catch(() => {});
      if (!response.ok) nextAllowedAt = Math.max(nextAllowedAt, now() + 120000);
    } catch { nextAllowedAt = Math.max(nextAllowedAt, now() + 120000); }
    finally { cancel(timeout); if (controller === owner) controller = null; arm(Math.max(1000, nextAllowedAt - now())); }
  }
  const visibility = () => { if (!current()) { controller?.abort(); if (timer !== null) cancel(timer); timer = null; }
    else arm(400); };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  return { changed() { if (!current()) { visibility(); return; } arm(Math.max(400, nextAllowedAt - now())); },
    suspend: visibility,
    destroy() { destroyed = true; controller?.abort(); if (timer !== null) cancel(timer); timer = null;
      documentRef?.removeEventListener?.('visibilitychange', visibility); } };
}
