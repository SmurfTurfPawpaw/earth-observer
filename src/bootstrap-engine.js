export const ENGINE_LOAD_TIMEOUT_MS = 15000;

/** Bound owned script loading; a removed script's late events cannot resume startup. */
export function loadEngineScript({ src, document = globalThis.document,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const engine = document.createElement('script');
    engine.src = src;
    engine.id = 'cesium-engine';
    engine.async = true;
    let settled = false, timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      engine.removeEventListener('load', loaded);
      engine.removeEventListener('error', failed);
      if (error) { engine.remove(); reject(error); }
      else resolve(engine);
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('The 3D engine could not download. Reload to try again.'));
    engine.addEventListener('load', loaded, { once: true });
    engine.addEventListener('error', failed, { once: true });
    try {
      timer = setTimeoutImpl(() => finish(new Error('Loading the 3D engine took too long. Check your connection, then reload to try again.')), ENGINE_LOAD_TIMEOUT_MS);
      document.head.append(engine);
    } catch (error) { finish(error); }
  });
}
