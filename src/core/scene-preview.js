import { createBrowserStore } from './browser-store.js';
import { loadBasemapMode } from './basemap-state.js';
const fingerprint = (view) => ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'].map((key) => Number(Number(view[key] || 0).toFixed(key === 'lat' || key === 'lon' ? 3 : 0))).join(':');
let liveSceneReady = false;
export async function showSavedScene(store = createBrowserStore()) {
  try {
    const target = document.getElementById('scene-preview'), image = document.getElementById('scene-preview-image');
    if (!target || !image) return;
    const record = await store.get('scene-preview');
    if (liveSceneReady || !record?.blob || record.basemap !== loadBasemapMode() || Date.now() - record.at > 7 * 86400000) return;
    const params = new URLSearchParams(location.hash.slice(1));
    let view;
    if (params.has('lat') && params.has('lon')) view = Object.fromEntries(params);
    else { try { view = JSON.parse(localStorage.getItem('earth-observer:workspace:v2') || 'null')?.view; } catch {} }
    if (!view || fingerprint(view) !== record.fingerprint) return;
    if (liveSceneReady) return;
    const url = URL.createObjectURL(record.blob);
    image.onload = () => URL.revokeObjectURL(url);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      target.hidden = true;
      document.querySelectorAll('.preview-credits').forEach((node) => node.remove());
    };
    image.src = url;
    if (record.credits) {
      const credits = document.createElement('small'); credits.className = 'preview-credits'; credits.textContent = record.credits;
      document.getElementById('credits')?.append(credits);
    }
    target.hidden = false;
  } catch { /* A saved image is optional, never a startup dependency. */ }
}
export function installScenePreview(viewer, { store, cameraView, getState }) {
  let wanted = true, lastSave = 0, capturing = false, stopped = false;
  const preview = document.getElementById('scene-preview');
  const hide = () => {
    if (liveSceneReady) return;
    liveSceneReady = true;
    if (preview) preview.hidden = true;
    document.querySelectorAll('.preview-credits').forEach((node) => node.remove());
  };
  const moveStart = viewer.camera.moveStart.addEventListener(hide);
  const move = viewer.camera.moveEnd.addEventListener(() => { wanted = true; hide(); });
  const post = viewer.scene.postRender.addEventListener(() => {
    // A rendered partial globe is usable. Waiting for every tile could leave a
    // stale opaque preview covering the live scene indefinitely on a slow link.
    hide();
    if (stopped || capturing || !wanted || !viewer.scene.globe.tilesLoaded || Date.now() - lastSave < 10000) return;
    // Complex registered notices are shown only by their live renderer, never flattened into an image.
    const state = getState();
    if (state.wind?.enabled || state.cctv?.enabled || state.transit?.enabled) return;
    capturing = true; wanted = false; lastSave = Date.now();
    try {
      const canvas = document.createElement('canvas'), source = viewer.canvas;
      const scale = Math.min(1, 960 / source.width); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale);
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const view = cameraView(viewer), credits = document.getElementById('credits')?.textContent?.slice(0, 2000) || '';
      const basemap = viewer.earthBasemap?.getState().mode || 'map';
      canvas.toBlob(async (blob) => {
        try { if (blob && !stopped) await store.put('scene-preview', { blob, at: Date.now(), fingerprint: fingerprint(view), basemap, credits }); }
        catch { /* Storage limits must not interrupt the live scene. */ }
        finally { capturing = false; }
      }, 'image/jpeg', .75);
    } catch { capturing = false; }
  });
  viewer.canvas.addEventListener('pointerdown', hide, { passive: true });
  return () => { stopped = true; moveStart(); move(); post(); hide(); viewer.canvas.removeEventListener('pointerdown', hide); };
}
