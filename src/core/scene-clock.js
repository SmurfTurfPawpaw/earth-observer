export const SCENE_CLOCK_TICK_MS = 1000;
export const MAX_SCENE_RATE = 86400;

const instant = (value, label = 'Scene time') => {
  const milliseconds = typeof value === 'number' ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8640000000000000) throw new TypeError(`${label} must be a valid UTC timestamp`);
  return milliseconds;
};

/** One scene time; observation acquisition never belongs to this clock. */
export function createSceneClock({ now = Date.now,
  monotonicNow = () => globalThis.performance?.now?.() ?? now(), documentRef = globalThis.document,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout,
  rate: initialRate = 3600 } = {}) {
  let mode = 'live', playing = false, rate = initialRate, coverage = null;
  let anchorAt = now(), anchorMono = monotonicNow(), suspended = Boolean(documentRef?.hidden), timer, destroyed = false;
  const listeners = new Set();
  const validRate = (value) => { if (!Number.isFinite(value) || value <= 0 || value > MAX_SCENE_RATE) throw new RangeError('Playback rate must be greater than zero and at most one day per second'); return value; };
  validRate(rate);
  const clamp = (at) => coverage ? Math.max(coverage.firstMs, Math.min(coverage.lastMs, at)) : at;
  const current = () => mode === 'live' ? now() : clamp(anchorAt + (playing && !suspended ? Math.max(0, monotonicNow() - anchorMono) * rate : 0));
  const getTimeMs = () => Math.trunc(current());
  const getState = () => ({ mode, at: new Date(getTimeMs()).toISOString(), playing, rate, suspended,
    coverage: coverage ? { firstAt: coverage.firstAt, lastAt: coverage.lastAt } : null });
  const stop = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const emit = () => { if (!destroyed && !suspended) for (const listener of [...listeners]) listener(getState()); };
  const reanchor = () => { anchorAt = current(); anchorMono = monotonicNow(); };
  function arm() {
    stop();
    if (destroyed || suspended || mode === 'history' && !playing) return;
    let delay = mode === 'live' ? SCENE_CLOCK_TICK_MS - ((now() % SCENE_CLOCK_TICK_MS + SCENE_CLOCK_TICK_MS) % SCENE_CLOCK_TICK_MS) : SCENE_CLOCK_TICK_MS;
    if (mode === 'history' && coverage) delay = Math.min(delay, Math.max(1, (coverage.lastMs - current()) / rate));
    timer = setTimeoutImpl(() => {
      timer = undefined;
      if (mode === 'history' && coverage && current() >= coverage.lastMs) { reanchor(); playing = false; }
      emit(); arm();
    }, delay);
  }
  const visibility = () => {
    if (destroyed) return;
    const hidden = Boolean(documentRef?.hidden);
    if (hidden === suspended) return;
    if (hidden) reanchor();
    suspended = hidden; anchorMono = monotonicNow(); emit(); arm();
  };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  arm();
  const api = {
    getState, getTimeMs,
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener); if (!suspended) listener(getState());
      return () => listeners.delete(listener);
    },
    seek(at) {
      if (destroyed) return false;
      const target = instant(at);
      mode = 'history'; playing = false; anchorAt = clamp(target); anchorMono = monotonicNow(); emit(); arm(); return true;
    },
    play() {
      if (destroyed || mode !== 'history' || coverage && current() >= coverage.lastMs) return false;
      if (playing) return true;
      reanchor(); playing = true; emit(); arm(); return true;
    },
    pause() {
      if (destroyed) return false;
      if (!playing) return true;
      reanchor(); playing = false; emit(); arm(); return true;
    },
    setRate(value) {
      if (destroyed) return false;
      validRate(value); reanchor(); rate = value; emit(); arm(); return true;
    },
    setCoverage(value = null) {
      if (destroyed) return false;
      let next = null;
      if (value !== null) {
        const firstMs = instant(value.firstAt, 'Coverage start'), lastMs = instant(value.lastAt, 'Coverage end');
        if (firstMs > lastMs) throw new RangeError('Scene coverage must have an ordered range');
        next = { firstMs, lastMs, firstAt: new Date(firstMs).toISOString(), lastAt: new Date(lastMs).toISOString() };
      }
      if (coverage?.firstMs === next?.firstMs && coverage?.lastMs === next?.lastMs) return true;
      reanchor(); coverage = next;
      if (mode === 'history') { anchorAt = clamp(anchorAt); if (coverage && anchorAt >= coverage.lastMs) playing = false; }
      emit(); arm(); return true;
    },
    live() { if (destroyed) return false; mode = 'live'; playing = false; anchorAt = now(); anchorMono = monotonicNow(); emit(); arm(); return true; },
    setTime(at = null) { return at === null ? api.live() : api.seek(at); },
    destroy() { if (destroyed) return; destroyed = true; stop(); listeners.clear(); documentRef?.removeEventListener?.('visibilitychange', visibility); },
  };
  return api;
}
