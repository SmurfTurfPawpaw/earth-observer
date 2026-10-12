/** Counts requested work; network byte totals and completion times are unknown. */
export function preparationState(state = {}) {
  const counts = { selected: 0, ready: 0, loading: 0, queued: 0, unavailable: 0, paused: 0, refreshing: 0, degraded: 0 };
  for (const entry of Object.values(state)) {
    if (!entry?.enabled) continue;
    counts.selected++;
    if (entry.timelinePaused || entry.status === 'paused') counts.paused++;
    else if (entry.queued || entry.status === 'queued') counts.queued++;
    else if (entry.activating || entry.status === 'loading') counts.loading++;
    else if (entry.status === 'error' || entry.error && entry.settledEnabled === false) counts.unavailable++;
    else if (entry.status === 'ready') {
      counts.ready++;
      if (entry.refreshing) counts.refreshing++;
      if (entry.error || entry.degraded || entry.stale) counts.degraded++;
    } else counts.queued++;
  }
  return counts;
}
export function preparationLabel(counts) {
  if (!counts.selected) return '';
  const parts = [`${counts.ready}/${counts.selected} layers ready`];
  for (const [key, label] of [['loading', 'loading'], ['queued', 'queued'], ['refreshing', 'refreshing'], ['unavailable', 'unavailable'], ['paused', 'paused'], ['degraded', 'with older data']]) {
    if (counts[key]) parts.push(`${counts[key]} ${label}`);
  }
  return parts.join(' · ');
}
