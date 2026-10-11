import * as Cesium from 'cesium';
import { createLiveClock, LIVE_CLOCK_TICK_MS } from './live-clock.js';

export const ASTRONOMY_REFRESH_MS = LIVE_CLOCK_TICK_MS;

/** Calculated astronomical positions follow UTC; no observation feed is implied. */
export function installAstronomy(viewer, { documentRef = globalThis.document,
  now = Date.now, setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
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
  let destroyed = false;
  const utcClock = createLiveClock({ documentRef, now, setTimeoutImpl, clearTimeoutImpl });
  const render = () => { if (!destroyed && !documentRef?.hidden && !viewer.isDestroyed?.()) scene.requestRender(); };
  const getState = () => ({ ...utcClock.getState(), lighting: scene.globe.enableLighting,
    model: 'Sun and Moon are calculated from the selected UTC time, not live observations.' });
  // Moving layers already render continuously under the governor. A parked
  // scene needs only a one-second astronomy frame; it never acquires a hold.
  const unsubscribe = utcClock.subscribe(({ mode }) => { if (mode === 'live' && scene.requestRenderMode !== false) render(); });
  function setTime(at = null) {
    if (destroyed) return false;
    if (at === null) clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    else {
      const time = Cesium.JulianDate.fromIso8601(at);
      clock.clockStep = Cesium.ClockStep.TICK_DEPENDENT;
      clock.multiplier = 0; clock.shouldAnimate = false; clock.currentTime = time;
    }
    utcClock.setTime(at); render(); return true;
  }
  const visibility = () => {
    if (!documentRef?.hidden && utcClock.getState().mode === 'live') clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    render();
  };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  setTime();
  return {
    setTime,
    subscribeClock(listener) { return utcClock.subscribe(() => listener(getState())); },
    setLighting(enabled) { if (destroyed) return; scene.globe.enableLighting = Boolean(enabled); render(); },
    getState,
    destroy() {
      if (destroyed) return;
      destroyed = true; unsubscribe(); utcClock.destroy(); documentRef?.removeEventListener?.('visibilitychange', visibility);
      if (scene.sun === sun) scene.sun = previousSun;
      if (scene.moon === moon) scene.moon = previousMoon;
      if (!sun.isDestroyed()) sun.destroy();
      if (!moon.isDestroyed()) moon.destroy();
    },
  };
}
