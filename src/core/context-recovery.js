const guidance = (message, code) => Object.assign(new Error(message), { name: 'GraphicsContextError', code });

/** Loss invalidates this viewer until a reload rebuilds its graphics resources. */
export function installContextRecovery(viewer, { onLost = () => {}, onRestored = () => {} } = {}) {
  const canvas = viewer?.scene?.canvas;
  if (!canvas?.addEventListener || !canvas?.removeEventListener) throw new TypeError('A viewer with a graphics canvas is required');
  if (typeof onLost !== 'function' || typeof onRestored !== 'function') throw new TypeError('Graphics recovery callbacks must be functions');
  let lost = false, restored = false, destroyed = false;
  const contextLost = (event) => {
    if (destroyed) return;
    // Canceling this event permits the browser to restore its WebGL context later.
    event.preventDefault();
    viewer.useDefaultRenderLoop = false;
    if (lost) return;
    lost = true;
    onLost(guidance('The map graphics context was lost. Reload to rebuild the globe.', 'EARTH_WEBGL_CONTEXT_LOST'));
  };
  const contextRestored = () => {
    if (destroyed || !lost) return;
    viewer.useDefaultRenderLoop = false;
    if (restored) return;
    restored = true;
    // A restored browser context alone does not establish that Cesium has rebuilt the viewer.
    onRestored(guidance('Graphics are available again. Reload to rebuild the globe.', 'EARTH_WEBGL_CONTEXT_RESTORED_RELOAD_REQUIRED'));
  };
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  return {
    // Keep the visibility guard latched even after restoration, until this viewer is replaced.
    isLost: () => lost,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
    },
  };
}
