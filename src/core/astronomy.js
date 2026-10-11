import * as Cesium from 'cesium';

export const ASTRONOMY_REFRESH_MS = 60000;

/** Calculated astronomical positions follow UTC; no observation feed is implied. */
export function installAstronomy(viewer, { documentRef = globalThis.document,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  const { scene, clock } = viewer;
  const previousSun = scene.sun, previousMoon = scene.moon;
  const sun = new Cesium.Sun(), moon = new Cesium.Moon();
  scene.sun = sun; scene.moon = moon; scene.sunBloom = false;
  scene.light = new Cesium.SunLight({ intensity: 1 });
  scene.globe.enableLighting = true;
  scene.globe.dynamicAtmosphereLightingFromSun = true;
  // The ellipsoid shader retains 30% surface light at night. Ground-atmosphere
  // darkening would obscure that floor, so retain only the separate sky rim.
  scene.globe.showGroundAtmosphere = false;
  scene.globe.lightingFadeOutDistance = 0;
  scene.globe.lightingFadeInDistance = 1;
  let mode = 'live', timer, destroyed = false;
  const stop = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const render = () => { if (!destroyed && !documentRef?.hidden && !viewer.isDestroyed?.()) scene.requestRender(); };
  function arm() {
    stop();
    if (destroyed || mode !== 'live' || documentRef?.hidden) return;
    timer = setTimeoutImpl(() => { timer = undefined; render(); arm(); }, ASTRONOMY_REFRESH_MS);
  }
  function setTime(at = null) {
    if (destroyed) return false;
    if (at === null) { mode = 'live'; clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK; }
    else {
      const time = Cesium.JulianDate.fromIso8601(at);
      mode = 'history'; clock.clockStep = Cesium.ClockStep.TICK_DEPENDENT;
      clock.multiplier = 0; clock.shouldAnimate = false; clock.currentTime = time;
    }
    render(); arm(); return true;
  }
  const visibility = () => {
    if (!documentRef?.hidden && mode === 'live') clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    render(); arm();
  };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  setTime();
  return {
    setTime,
    setLighting(enabled) { if (destroyed) return; scene.globe.enableLighting = Boolean(enabled); render(); },
    getState: () => ({ mode, at: Cesium.JulianDate.toIso8601(clock.currentTime, 0), lighting: scene.globe.enableLighting,
      model: 'Sun and Moon are calculated from the selected UTC time, not live observations.' }),
    destroy() {
      if (destroyed) return;
      destroyed = true; stop(); documentRef?.removeEventListener?.('visibilitychange', visibility);
      if (scene.sun === sun) scene.sun = previousSun;
      if (scene.moon === moon) scene.moon = previousMoon;
      if (!sun.isDestroyed()) sun.destroy();
      if (!moon.isDestroyed()) moon.destroy();
    },
  };
}
