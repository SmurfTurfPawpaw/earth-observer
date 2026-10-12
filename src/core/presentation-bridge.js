export const PRESENTATION_BRIDGE_PIXEL_LIMIT = 4 * 1024 * 1024;
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;

function backingSize(source) {
  const width = source?.width, height = source?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('The completed map frame has no drawable dimensions.');
  const scale = Math.min(1, Math.sqrt(PRESENTATION_BRIDGE_PIXEL_LIMIT / (width * height)));
  let w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  // A very thin source can round one dimension up to a pixel; the cap still holds.
  if (w * h > PRESENTATION_BRIDGE_PIXEL_LIMIT) {
    if (w >= h) w = Math.floor(PRESENTATION_BRIDGE_PIXEL_LIMIT / h);
    else h = Math.floor(PRESENTATION_BRIDGE_PIXEL_LIMIT / w);
  }
  return { width: w, height: h };
}

/** Optional presentation experiment, never a data or render-loop owner.
 * A successful canvas copy proves copying succeeded, not that source pixels are healthy. */
export function installPresentationBridge(viewer, { container = viewer?.container, documentRef = globalThis.document,
  onError = () => {}, getSceneTime = () => null, performanceRef = globalThis.performance } = {}) {
  const source = viewer?.canvas || viewer?.scene?.canvas;
  let canvas = null, context = null, unsubscribe = null, originalOpacity = null, opacityOwned = false;
  let enabled = false, destroyed = false, status = 'disabled', frameCount = 0, copyMs = null, capturedSceneUtc = null;
  const getState = () => ({ enabled, status, frameCount, copyMs, capturedSceneUtc,
    width: canvas?.width || 0, height: canvas?.height || 0, pixelLimit: PRESENTATION_BRIDGE_PIXEL_LIMIT });
  function disposeSurface() {
    enabled = false;
    const remove = unsubscribe; unsubscribe = null;
    try { remove?.(); } catch { /* Continue restoring presentation even if a host is already destroyed. */ }
    source?.removeEventListener?.('webglcontextlost', contextLost);
    if (opacityOwned && source?.style) source.style.opacity = originalOpacity;
    opacityOwned = false; originalOpacity = null;
    if (canvas) {
      canvas.hidden = true;
      canvas.remove?.(); canvas.height = 0; canvas.width = 0;
    }
    canvas = null; context = null;
  }
  function failure(error) {
    if (!enabled || destroyed) return;
    disposeSurface(); status = 'failed';
    try { onError(error instanceof Error ? error : new Error('The compatibility display could not copy a completed map frame.')); }
    catch { /* Optional presentation diagnostics must never take down the application. */ }
  }
  function contextLost() {
    if (enabled) failure(Object.assign(new Error('The compatibility display stopped because the map context was lost.'),
      { code: 'EARTH_PRESENTATION_CONTEXT_LOST' }));
  }
  function copyFrame() {
    if (!enabled || destroyed) return;
    try {
      const began = performanceRef?.now?.() ?? 0, at = utc(getSceneTime());
      const size = backingSize(source);
      if (canvas.width !== size.width || canvas.height !== size.height) {
        // Avoid allocating an intermediate old-height/new-width backing.
        canvas.height = 0; canvas.width = size.width; canvas.height = size.height;
      }
      context.drawImage(source, 0, 0, source.width, source.height, 0, 0, size.width, size.height);
      copyMs = Math.max(0, (performanceRef?.now?.() ?? began) - began);
      capturedSceneUtc = at; frameCount++;
      canvas.dataset.frameCount = String(frameCount);
      canvas.dataset.copyMs = copyMs.toFixed(2);
      if (at) canvas.dataset.sceneUtc = at; else delete canvas.dataset.sceneUtc;
      // Commit the replacement only after drawImage succeeded, in this same turn.
      canvas.hidden = false;
      if (!opacityOwned) { originalOpacity = source.style.opacity; source.style.opacity = '0'; opacityOwned = true; }
      status = 'active';
    } catch (error) { failure(error); }
  }
  function setEnabled(value) {
    if (destroyed || typeof value !== 'boolean') return false;
    if (!value) { disposeSurface(); status = 'disabled'; return true; }
    if (enabled) return true;
    enabled = true; status = 'waiting-frame';
    try {
      if (!source?.style || !container?.append || typeof documentRef?.createElement !== 'function' || viewer?.isDestroyed?.())
        throw new Error('The map presentation surface is unavailable.');
      canvas = documentRef.createElement('canvas'); canvas.className = 'earth-presentation-bridge';
      canvas.setAttribute('aria-hidden', 'true'); canvas.dataset.presentationBridge = '2d'; canvas.hidden = true;
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      canvas.width = 0; canvas.height = 0;
      context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!context || typeof context.drawImage !== 'function') throw new Error('A 2D compatibility display is unavailable.');
      container.append(canvas);
      const event = viewer?.scene?.postRender;
      if (typeof event?.addEventListener !== 'function') throw new Error('Completed map frames are unavailable.');
      const remove = event.addEventListener(copyFrame);
      unsubscribe = typeof remove === 'function' ? remove : () => event.removeEventListener?.(copyFrame);
      source.addEventListener?.('webglcontextlost', contextLost);
      if (!documentRef.hidden) viewer.scene.requestRender?.();
      return enabled;
    } catch (error) { failure(error); return false; }
  }
  return { setEnabled, getState, destroy() {
    if (destroyed) return; disposeSurface(); destroyed = true; status = 'destroyed';
  } };
}
