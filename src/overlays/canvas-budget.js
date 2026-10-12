export const WORLD_OVERLAY_MAX_BACKING_PIXELS = 4 * 1024 * 1024;
export const WORLD_OVERLAY_MAX_DPR = 2;

/** Backing resolution only: projection, layout and picking retain CSS pixels. */
export function worldOverlayCanvasBudget(cssWidth, cssHeight, requestedDpr = 1) {
  const dimension = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
  const width = dimension(cssWidth), height = dimension(cssHeight);
  const suppliedDpr = Number(requestedDpr);
  const deviceDpr = Number.isFinite(suppliedDpr) ? Math.max(1, suppliedDpr) : 1;
  const dpr = width > 0 && height > 0
    ? Math.min(WORLD_OVERLAY_MAX_DPR, deviceDpr, Math.sqrt(WORLD_OVERLAY_MAX_BACKING_PIXELS / (width * height)))
    : 1;
  // Floor both dimensions so integer rounding cannot exceed the pixel budget.
  return { width, height, dpr, backingWidth: Math.floor(width * dpr), backingHeight: Math.floor(height * dpr) };
}
