export const LIVE_CLOCK_TICK_MS = 1000;

/** UTC follows the wall clock, rather than elapsed timers or rendered frames. */
export function createLiveClock({ now = Date.now, documentRef = globalThis.document,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  let recordedAt = null, timer, destroyed = false;
  const listeners = new Set();
  const getState = () => ({ mode: recordedAt === null ? 'live' : 'history', at: recordedAt ?? new Date(now()).toISOString() });
  const emit = () => { if (!destroyed && !documentRef?.hidden) for (const listener of [...listeners]) listener(getState()); };
  const stop = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  function arm() {
    stop();
    if (destroyed || recordedAt !== null || documentRef?.hidden) return;
    const remainder = ((now() % LIVE_CLOCK_TICK_MS) + LIVE_CLOCK_TICK_MS) % LIVE_CLOCK_TICK_MS;
    timer = setTimeoutImpl(() => { timer = undefined; emit(); arm(); }, LIVE_CLOCK_TICK_MS - remainder);
  }
  const visibility = () => { emit(); arm(); };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  arm();
  return {
    getState,
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener); if (!documentRef?.hidden) listener(getState());
      return () => listeners.delete(listener);
    },
    setTime(at = null) {
      if (destroyed) return false;
      if (at !== null) {
        const parsed = typeof at === 'string' ? Date.parse(at) : NaN;
        if (!Number.isFinite(parsed)) throw new TypeError('Recorded time must be a valid UTC timestamp');
        recordedAt = new Date(parsed).toISOString();
      } else recordedAt = null;
      emit(); arm(); return true;
    },
    destroy() { if (destroyed) return; destroyed = true; stop(); listeners.clear(); documentRef?.removeEventListener?.('visibilitychange', visibility); },
  };
}
