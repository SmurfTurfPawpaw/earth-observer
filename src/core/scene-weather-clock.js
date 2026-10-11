/** Adapt the existing valid-frame selector to the scene's sole time owner.
 * Frame changes, not animation ticks, trigger product work. Source observations
 * remain discrete even when sunlight and the scene clock advance continuously.
 */
export function createSceneWeatherClock(weatherClock, sceneClock) {
  if (!weatherClock?.selectFor || !sceneClock?.subscribe) throw new TypeError('Weather requires a source selector and scene clock');
  const listeners = new Set();
  let signature = null, notificationSignature = null, destroyed = false, pending = Promise.resolve(true);
  const getState = () => {
    const world = sceneClock.getState(), source = weatherClock.getState();
    return { ...source, mode: world.mode === 'live' ? 'latest' : 'history', target: world.mode === 'history' ? world.at : null,
      playing: world.playing, sceneTime: world.at, clockOwner: 'scene',
      products: source.products.map((product) => ({ ...product,
        selected: world.mode === 'live' ? product.selected : weatherClock.selectFor(product.id, world.at) })) };
  };
  const notify = () => {
    if (destroyed) return;
    const state = getState();
    // The time dock owns the running timestamp. Product controls only change
    // for a frame, manifest, playback intent or source-state transition.
    const next = JSON.stringify([state.mode, state.playing, state.timeline, state.products]);
    if (next === notificationSignature) return;
    notificationSignature = next;
    for (const listener of [...listeners]) listener(state);
  };
  function synchronize(force = false) {
    if (destroyed) return Promise.resolve(false);
    const state = getState();
    const next = JSON.stringify([state.mode, state.mode === 'latest' ? state.timeline : null,
      state.products.map((product) => [product.id, product.suspended, state.mode === 'history' ? product.selected : null])]);
    if (!force && next === signature) { notify(); return pending; }
    signature = next;
    pending = state.mode === 'latest' ? weatherClock.latest() : weatherClock.setTarget(state.target);
    notify(); return pending;
  }
  // A source manifest or registration can change the selected frame without a
  // change in scene time. Both sides therefore invalidate this tiny signature.
  const unsubscribeWeather = weatherClock.subscribe(() => { void synchronize(); });
  const unsubscribeScene = sceneClock.subscribe(() => { void synchronize(); });
  const api = {
    getState,
    getTimeline: () => weatherClock.getTimeline(),
    selectFor: (id, time) => weatherClock.selectFor(id, time),
    register(product) {
      if (destroyed) return () => {};
      const unregister = weatherClock.register(product); void synchronize();
      return () => { unregister(); void synchronize(); };
    },
    setTarget(time) { sceneClock.seek(time); return synchronize(); },
    latest() { sceneClock.live(); return synchronize(); },
    step(direction) {
      if (destroyed || ![-1, 1].includes(direction)) return Promise.resolve(false);
      const times = weatherClock.getTimeline(), at = sceneClock.getTimeMs();
      if (!times.length) return Promise.resolve(false);
      const next = direction < 0 ? times.findLast((time) => Date.parse(time) < at) ?? times[0]
        : times.find((time) => Date.parse(time) > at) ?? times.at(-1);
      return api.setTarget(next);
    },
    play() {
      if (destroyed) return Promise.resolve(false);
      if (sceneClock.getState().mode === 'live') {
        const first = weatherClock.getTimeline()[0]; if (!first) return Promise.resolve(false);
        sceneClock.seek(first);
      }
      sceneClock.play(); return synchronize();
    },
    pause() { sceneClock.pause(); },
    togglePlay() { return sceneClock.getState().playing ? api.pause() : api.play(); },
    refresh() { return synchronize(true); },
    subscribe(listener) { if (destroyed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    destroy() {
      if (destroyed) return;
      destroyed = true; unsubscribeScene(); unsubscribeWeather(); listeners.clear(); weatherClock.destroy();
    },
  };
  return api;
}
