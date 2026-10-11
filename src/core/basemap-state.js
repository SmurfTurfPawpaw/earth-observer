export const BASEMAP_KEY = 'earth-observer:basemap:v1';
export function loadBasemapMode() {
  try { return localStorage.getItem(BASEMAP_KEY) === 'imagery' ? 'imagery' : 'map'; }
  catch { return 'map'; }
}
export function saveBasemapMode(mode) {
  try { localStorage.setItem(BASEMAP_KEY, mode === 'imagery' ? 'imagery' : 'map'); } catch {}
}
