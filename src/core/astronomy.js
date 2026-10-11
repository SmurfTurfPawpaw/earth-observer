import * as Cesium from 'cesium';
import { createSceneClock, SCENE_CLOCK_TICK_MS } from './scene-clock.js';
import { installRenderGovernor, holdContinuousRender, releaseContinuousRender, uninstallRenderGovernor } from '../renderGovernor.js';

export const ASTRONOMY_REFRESH_MS = SCENE_CLOCK_TICK_MS;
const PLAYBACK_HOLD = 'scene-astronomy-playback';
export const CARTOGRAPHIC_NIGHT_OPACITY = 0.35;
const TWILIGHT_WIDTH = Math.sin(Cesium.Math.toRadians(6));

/** Calculated astronomical positions follow UTC; no observation feed is implied. */
export function installAstronomy(viewer, { documentRef = globalThis.document,
  now = Date.now, monotonicNow, sceneClock: suppliedClock,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  const { scene, clock } = viewer;
  const previousSun = scene.sun, previousMoon = scene.moon, previousLight = scene.light;
  const previousMaterial = scene.globe.material, previousLighting = scene.globe.enableLighting;
  const previousGroundAtmosphere = scene.globe.showGroundAtmosphere;
  const previousAtmosphereFromSun = scene.globe.dynamicAtmosphereLightingFromSun;
  const sun = new Cesium.Sun(), moon = new Cesium.Moon();
  scene.sun = sun; scene.moon = moon; scene.sunBloom = false;
  const sunlight = new Cesium.SunLight({ intensity: 1 }); scene.light = sunlight;
  // Public Fabric material: shade source cartography gently with real solar
  // geometry, instead of the ellipsoid shader's fixed 30% night intensity.
  // positionToEyeEC avoids requiring terrain vertex normals on the ellipsoid.
  const nightMaterial = new Cesium.Material({ fabric: {
    type: 'EarthObserverCartographicNight',
    uniforms: { nightOpacity: CARTOGRAPHIC_NIGHT_OPACITY, twilightWidth: TWILIGHT_WIDTH,
      nightTint: Cesium.Color.fromCssColorString('#080f16'),
      inverseRadiiSquared: Cesium.Cartesian3.clone((scene.globe.ellipsoid || Cesium.Ellipsoid.WGS84).oneOverRadiiSquared) },
    source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
      czm_material material = czm_getDefaultMaterial(materialInput);
      vec3 positionWC = (czm_inverseView3D * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
      vec3 surfaceDirection = normalize(positionWC * inverseRadiiSquared);
      float solarElevation = dot(surfaceDirection, czm_sunDirectionWC);
      float night = 1.0 - smoothstep(-twilightWidth, twilightWidth, solarElevation);
      material.diffuse = nightTint.rgb;
      material.alpha = nightOpacity * night;
      return material;
    }`,
  }, translucent: true });
  scene.globe.material = nightMaterial;
  scene.globe.enableLighting = false;
  scene.globe.dynamicAtmosphereLightingFromSun = true;
  // Retain the separate sky rim; no second atmosphere/night darkening pass.
  scene.globe.showGroundAtmosphere = false;
  let destroyed = false, playbackHeld = false, lighting = true;
  const sceneClock = suppliedClock || createSceneClock({ documentRef, now, monotonicNow, setTimeoutImpl, clearTimeoutImpl });
  const date = new Date();
  installRenderGovernor(viewer);
  const render = () => { if (!destroyed && !documentRef?.hidden && !viewer.isDestroyed?.()) scene.requestRender(); };
  const getState = () => ({ ...sceneClock.getState(), lighting, appearance: 'cartographic-night',
    model: 'Sun and Moon are calculated from the selected UTC time, not live observations.' });
  // Mutate the Date/JulianDate in place: Cesium passes this same JulianDate
  // from Clock.tick to render. Native clock accumulation is not another owner.
  const syncJulian = () => {
    if (destroyed || documentRef?.hidden) return;
    date.setTime(sceneClock.getTimeMs());
    Cesium.JulianDate.fromDate(date, clock.currentTime);
  };
  const configure = (state) => {
    if (destroyed) return;
    if (state.mode === 'live') clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    else {
      clock.clockStep = Cesium.ClockStep.TICK_DEPENDENT;
      clock.multiplier = 0; clock.shouldAnimate = false;
    }
    const continuous = Boolean(state.playing && !documentRef?.hidden);
    if (continuous !== playbackHeld) {
      playbackHeld = continuous;
      if (continuous) holdContinuousRender(PLAYBACK_HOLD); else releaseContinuousRender(PLAYBACK_HOLD);
    }
    syncJulian();
    if (scene.requestRenderMode !== false || state.mode === 'history' && !state.playing) render();
  };
  const unsubscribe = sceneClock.subscribe(configure);
  const unsubscribeFrame = clock.onTick?.addEventListener(syncJulian);
  const visibility = () => {
    configure(sceneClock.getState());
    render();
  };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  const invoke = (method, ...args) => { if (destroyed) return false; return sceneClock[method](...args); };
  return {
    sceneClock,
    setTime(at = null) { return invoke('setTime', at); },
    seek(at) { return invoke('seek', at); },
    play() { return invoke('play'); },
    pause() { return invoke('pause'); },
    setRate(value) { return invoke('setRate', value); },
    setCoverage(value = null) { return invoke('setCoverage', value); },
    getTimeMs: sceneClock.getTimeMs,
    subscribeClock(listener) { return sceneClock.subscribe(() => listener(getState())); },
    setLighting(enabled) { if (destroyed) return; lighting = Boolean(enabled); nightMaterial.uniforms.nightOpacity = lighting ? CARTOGRAPHIC_NIGHT_OPACITY : 0; render(); },
    getState,
    destroy() {
      if (destroyed) return;
      destroyed = true; unsubscribe(); unsubscribeFrame?.(); releaseContinuousRender(PLAYBACK_HOLD);
      if (!suppliedClock) sceneClock.destroy();
      uninstallRenderGovernor(viewer); documentRef?.removeEventListener?.('visibilitychange', visibility);
      if (scene.sun === sun) scene.sun = previousSun;
      if (scene.moon === moon) scene.moon = previousMoon;
      if (scene.light === sunlight) scene.light = previousLight;
      if (scene.globe.material === nightMaterial) {
        scene.globe.material = previousMaterial;
        scene.globe.enableLighting = previousLighting;
        scene.globe.showGroundAtmosphere = previousGroundAtmosphere;
        scene.globe.dynamicAtmosphereLightingFromSun = previousAtmosphereFromSun;
      }
      if (!nightMaterial.isDestroyed()) nightMaterial.destroy();
      if (!sun.isDestroyed()) sun.destroy();
      if (!moon.isDestroyed()) moon.destroy();
    },
  };
}
