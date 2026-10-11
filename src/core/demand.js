import { isDemandProductionOrigin, reviewedDemandSearch } from './demand-subjects.js';

/** No mount/open/refresh listener: the caller must invoke noteSearch only on explicit form submit. */
export function createDemandTracker({ container, fetchImpl = (...args) => fetch(...args),
  documentRef = container?.ownerDocument || globalThis.document, locationRef = globalThis.location,
  testTraffic = false, headers = {}, timeoutMs = 5000 } = {}) {
  if (!container || !documentRef) throw new TypeError('A demand preference container is required');
  const requestHeaders = new Headers(headers);
  const allowed = isDemandProductionOrigin(locationRef?.origin) && !testTraffic && !requestHeaders.has('x-earth-test');
  const wrapper = documentRef.createElement('div'); wrapper.className = 'intelligence-demand';
  const label = documentRef.createElement('label');
  const checkbox = documentRef.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = false; checkbox.disabled = !allowed;
  label.append(checkbox, ' Help improve topic coverage');
  const explanation = documentRef.createElement('p'); explanation.className = 'intelligence-meta';
  explanation.textContent = 'Optional: count explicit searches for reviewed topics or category/country overviews. No raw searches, location or identity are stored. Daily totals expire from summaries after 7 days; public groups need 300 actions. Your choice stays on this page.';
  const status = documentRef.createElement('p'); status.className = 'intelligence-meta'; status.setAttribute('role', 'status');
  status.textContent = allowed ? 'Off. Enable to contribute aggregate search actions.' : 'Disabled on preview and test hosts.';
  wrapper.append(label, explanation, status); container.append(wrapper);
  let destroyed = false, generation = 0;
  const pending = new Set();
  function changed() {
    ++generation;
    if (!checkbox.checked) for (const controller of pending) controller.abort();
    status.textContent = checkbox.checked ? 'On for this page. Only explicit reviewed searches can count.' : 'Off. No further search actions will be sent.';
  }
  checkbox.addEventListener('change', changed);
  return {
    async noteSearch(filters) {
      if (destroyed || !allowed || !checkbox.checked) return false;
      const payload = reviewedDemandSearch(filters);
      if (!payload) { status.textContent = 'This search is excluded from aggregate counts.'; return false; }
      const controller = new AbortController(), owner = generation;
      const timer = setTimeout(() => controller.abort(), Math.min(10000, Math.max(1000, timeoutMs)));
      pending.add(controller);
      try {
        const response = await fetchImpl('/api/discovery/demand', { method: 'POST',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        const accepted = response.ok && result?.enabled === true && result?.accepted === true;
        if (!destroyed && owner === generation && checkbox.checked) status.textContent = accepted ?
          'Aggregate action counted. Counts are actions, not unique people.' : 'Aggregate counts are unavailable; this action was not confirmed.';
        return accepted;
      } catch {
        if (!destroyed && owner === generation && checkbox.checked) status.textContent = 'Aggregate counts are unavailable; this action was not confirmed.';
        return false;
      } finally { clearTimeout(timer); pending.delete(controller); }
    },
    getState() { return { allowed, optedIn: !destroyed && allowed && checkbox.checked }; },
    destroy() {
      if (destroyed) return;
      destroyed = true; ++generation;
      for (const controller of pending) controller.abort();
      checkbox.removeEventListener('change', changed); wrapper.remove();
    },
  };
}
