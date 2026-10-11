/** CSS-pixel rendering keeps canvas detail stable across device pixel ratios. */
export const CSS_PIXEL_RENDERING = Object.freeze({ useBrowserRecommendedResolution: true, resolutionScale: 1 });

export function globeScreenSpaceError(mode, moving = false) {
  if (!['map', 'imagery'].includes(mode)) throw new TypeError('Choose map or imagery');
  return mode === 'map' && !moving ? 1.5 : 3;
}

/** Refine a settled street map without increasing work while the camera moves. */
export function installGlobeRenderingPolicy(viewer) {
  let mode = 'imagery', moving = false, destroyed = false;
  viewer.useBrowserRecommendedResolution = CSS_PIXEL_RENDERING.useBrowserRecommendedResolution;
  viewer.resolutionScale = CSS_PIXEL_RENDERING.resolutionScale;
  const apply = () => {
    if (destroyed) return;
    const error = globeScreenSpaceError(mode, moving);
    if (viewer.scene.globe.maximumScreenSpaceError === error) return;
    viewer.scene.globe.maximumScreenSpaceError = error;
    viewer.scene.requestRender();
  };
  const start = viewer.camera.moveStart.addEventListener(() => { moving = true; apply(); });
  const end = viewer.camera.moveEnd.addEventListener(() => { moving = false; apply(); });
  apply();
  return {
    setBasemapMode(value) {
      globeScreenSpaceError(value); // Validate before changing the active policy.
      if (destroyed) return;
      mode = value;
      apply();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      start(); end();
    },
  };
}
