const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** workerd accepts manual/follow only; retain providers' no-redirect policy. */
export function createWorkerFetch(fetchImpl = (...args) => fetch(...args)) {
  return async (input, init) => {
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
    if (redirect !== 'error') return fetchImpl(input, init);
    // Do not change callers' reusable options, headers, body or signal.
    const response = await fetchImpl(input, { ...init, redirect: 'manual' });
    if (REDIRECT_STATUSES.has(response.status)) {
      try { await response.body?.cancel(); } catch {}
      // No Location URL, request identifiers or upstream body enter errors/logs.
      throw new TypeError('Upstream redirect refused');
    }
    return response;
  };
}
