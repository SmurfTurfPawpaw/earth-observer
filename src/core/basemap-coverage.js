/** Missing street tiles describe partial coverage, never a failed whole provider. */
export function observeStreetMapCoverage(provider, onChange = () => {}) {
  let failedRequests = 0, destroyed = false, previous = 'ready:false';
  const getState = () => {
    const stats = provider.getStats();
    return {
      status: failedRequests ? 'partial' : 'ready', failedRequests,
      savedTileReads: stats.savedTileReads || 0,
      latestCachedAt: stats.latestCachedAt || null,
      savedMetadataAt: stats.savedMetadataAt || null,
    };
  };
  const update = () => {
    if (destroyed) return;
    const state = getState(), key = `${state.status}:${state.savedTileReads > 0}`;
    if (key === previous) return;
    previous = key;
    onChange(state);
  };
  const remove = provider.errorEvent.addEventListener(() => {
    failedRequests = Math.min(1000000, failedRequests + 1);
    update();
  });
  return {
    getState,
    tileSucceeded: update,
    destroy() { if (!destroyed) { destroyed = true; remove(); } },
  };
}

export function streetMapCoverageNotice(state) {
  if (state.status === 'partial') return state.savedTileReads > 0
    ? 'Saved street-map detail shown where available. Gaps use bundled imagery; reconnect and reload for more coverage.'
    : 'Street-map coverage is partial. Available street detail remains visible; gaps use bundled imagery. Reconnect and reload to retry.';
  return state.savedTileReads > 0 ? 'Saved street-map tiles shown where available. Coverage may be incomplete.' : '';
}
