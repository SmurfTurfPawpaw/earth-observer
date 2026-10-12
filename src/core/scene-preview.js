import { createBrowserStore } from './browser-store.js';
import { loadBasemapMode } from './basemap-state.js';
const fingerprint = (view) => ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'].map((key) => Number(Number(view[key] || 0).toFixed(key === 'lat' || key === 'lon' ? 3 : 0))).join(':');
const WORKSPACE_KEY = 'earth-observer:workspace:v2', LAYERS_KEY = 'earth-observer:layers:v1';
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
// A tiny conservative startup key: do not import navigation's city corpus or
// layer engines before the essential globe downloads.
function canonical(value, depth = 0) {
  if (depth > 8) throw new Error('Preview scope is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (!object(value)) throw new Error('Preview scope is invalid');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
}
function sceneScope(layers, layerParams = {}) {
  if (!Array.isArray(layers) || layers.length > 32 || layers.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) || !object(layerParams)) return null;
  const ids = [...new Set(layers)].sort(), selected = {};
  for (const id of ids) {
    if (layerParams[id] !== undefined && !object(layerParams[id])) return null;
    selected[id] = canonical(layerParams[id] || {});
  }
  const scope = { temporal: { mode: 'live' }, layers: ids, layerParams: selected };
  return JSON.stringify(scope).length <= 8192 ? scope : null;
}
const scopeKey = scope => JSON.stringify(scope);
function readRequestedScene() {
  const params = new URLSearchParams(location.hash.slice(1));
  const shared = ['v', 'lat', 'lon', 'layers', 'mode', 'at', 'lens', 'rate'].some(key => params.has(key));
  const session = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null');
  const preferences = JSON.parse(localStorage.getItem(LAYERS_KEY) || 'null');
  if (shared) {
    if (params.getAll('v').length > 1 || params.has('v') && !['1', '2', '3', '4'].includes(params.get('v'))) return null;
    if (params.get('v') === '4') {
      for (const key of ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll', 'layers', 'params', 'mode', 'at', 'lens', 'rate']) if (params.getAll(key).length > 1) return null;
      if ((params.get('mode') || 'live') !== 'live' || ['at', 'lens', 'rate'].some(key => params.has(key))) return null;
    }
  } else if (![2, 3].includes(session?.version) || session.version === 3 &&
      (!object(session.temporal) || session.temporal.mode !== 'live' || ['at', 'lens', 'rate'].some(key => session.temporal[key] != null))) return null;
  let layers = [], layerParams = {};
  if (shared && params.has('layers')) {
    layers = params.get('layers').split(',').filter(Boolean);
    if (params.has('params')) layerParams = JSON.parse(params.get('params'));
  } else if (preferences?.version === 1 && object(preferences.layers)) {
    for (const [id, value] of Object.entries(preferences.layers)) if (value?.enabled === true) {
      layers.push(id); layerParams[id] = value.params || {};
    }
    // Shared params are applied before saved preferences; ambiguous precedence
    // is optional preview work, so leave the actual workspace restore to main.
    if (shared && params.has('params')) return null;
  } else if (shared && params.has('params')) return null;
  const scope = sceneScope(layers, layerParams);
  const view = shared ? params.has('lat') && params.has('lon') ? Object.fromEntries(params) : null : session.view;
  return scope && view ? { scope, view } : null;
}
function requestedScene() {
  try { return readRequestedScene(); } catch { return null; }
}
function captureScope(state, getLayerParams) {
  try {
    if (state.timelinePaused) return null;
    const enabled = Object.entries(state).filter(([, value]) => value?.enabled === true);
    if (enabled.some(([, value]) => value.settledEnabled !== true || value.sceneMode === 'history' || value.status !== 'ready' || value.activating) ||
        enabled.length && typeof getLayerParams !== 'function') return null;
    const actualParameters = Object.fromEntries(enabled.map(([id]) => [id, getLayerParams(id)]));
    if (Object.values(actualParameters).some(value => !object(value))) return null;
    const actual = sceneScope(enabled.map(([id]) => id), actualParameters);
    const requested = requestedScene();
    return actual && requested && scopeKey(actual) === scopeKey(requested.scope) ? actual : null;
  } catch { return null; }
}
let liveSceneReady = false;
export async function showSavedScene(store = createBrowserStore()) {
  try {
    const target = document.getElementById('scene-preview'), image = document.getElementById('scene-preview-image');
    if (!target || !image) return;
    const record = await store.get('scene-preview');
    const age = Date.now() - record?.at;
    if (liveSceneReady || record?.schemaVersion !== 2 || !record.blob || !Number.isSafeInteger(record.at) || record.at < 1 || !Number.isFinite(age) || age < 0 ||
        record.basemap !== loadBasemapMode() || age > 7 * 86400000 || !object(record.scope) || Object.keys(record.scope).length !== 3 || !object(record.scope.layerParams) || !object(record.scope.temporal) ||
        record.scope.temporal.mode !== 'live' || Object.keys(record.scope.temporal).length !== 1) return;
    const requested = requestedScene(), retainedScope = sceneScope(record.scope.layers, record.scope.layerParams);
    if (!requested || !retainedScope || scopeKey(requested.scope) !== scopeKey(retainedScope) || fingerprint(requested.view) !== record.fingerprint) return;
    if (liveSceneReady) return;
    const url = URL.createObjectURL(record.blob);
    image.onload = () => URL.revokeObjectURL(url);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      target.hidden = true;
      document.querySelectorAll('.preview-credits').forEach((node) => node.remove());
    };
    image.src = url;
    const caption = target.querySelector?.('span'), capturedAt = new Date(record.at).toISOString();
    if (caption) {
      caption.textContent = `Saved · ${capturedAt.slice(0, 16).replace('T', ' ')} UTC`;
      caption.title = `Saved Live view captured ${capturedAt}`;
      caption.setAttribute?.('aria-label', caption.title);
    }
    if (record.credits) {
      const credits = document.createElement('small'); credits.className = 'preview-credits'; credits.textContent = record.credits;
      document.getElementById('credits')?.append(credits);
    }
    target.hidden = false;
  } catch { /* A saved image is optional, never a startup dependency. */ }
}
export function installScenePreview(viewer, { store, cameraView, getState, getLayerParams,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout }) {
  let wanted = true, lastSave = 0, capturing = false, stopped = false, revealTimer;
  const preview = document.getElementById('scene-preview');
  const hide = () => {
    if (revealTimer !== undefined) { clearTimeoutImpl(revealTimer); revealTimer = undefined; }
    if (liveSceneReady) return;
    liveSceneReady = true;
    if (preview) preview.hidden = true;
    document.querySelectorAll('.preview-credits').forEach((node) => node.remove());
  };
  const moveStart = viewer.camera.moveStart.addEventListener(hide);
  const move = viewer.camera.moveEnd.addEventListener(() => { wanted = true; hide(); });
  const post = viewer.scene.postRender.addEventListener(() => {
    // A first frame may contain only the globe's base color. Keep the labeled
    // saved view until tiles settle, but reveal incomplete/offline coverage soon.
    if (!liveSceneReady) {
      if (viewer.scene.globe.tilesLoaded) hide();
      else if (revealTimer === undefined) revealTimer = setTimeoutImpl(hide, 2500);
    }
    if (stopped || capturing || !wanted || !viewer.scene.globe.tilesLoaded || Date.now() - lastSave < 10000) return;
    // Complex registered notices are shown only by their live renderer, never flattened into an image.
    const state = getState();
    if (state.timelinePaused || state.wind?.enabled || state.cctv?.enabled || state.transit?.enabled) return;
    const scope = captureScope(state, getLayerParams);
    if (!scope) return;
    capturing = true; wanted = false; lastSave = Date.now();
    const capturedAt = lastSave;
    try {
      const canvas = document.createElement('canvas'), source = viewer.canvas;
      const scale = Math.min(1, 960 / source.width); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale);
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const view = cameraView(viewer), credits = document.getElementById('credits')?.textContent?.slice(0, 2000) || '';
      const basemap = viewer.earthBasemap?.getState().mode || 'map';
      canvas.toBlob(async (blob) => {
        try {
          const currentScope = !stopped && captureScope(getState(), getLayerParams);
          if (blob && currentScope && scopeKey(currentScope) === scopeKey(scope) && fingerprint(cameraView(viewer)) === fingerprint(view) &&
              (viewer.earthBasemap?.getState().mode || 'map') === basemap)
            await store.put('scene-preview', { schemaVersion: 2, scope, blob, at: capturedAt, fingerprint: fingerprint(view), basemap, credits });
        }
        catch { /* Storage limits must not interrupt the live scene. */ }
        finally { capturing = false; }
      }, 'image/jpeg', .75);
    } catch { capturing = false; }
  });
  const inputEvents = ['pointerdown', 'wheel', 'keydown'];
  for (const name of inputEvents) document.addEventListener(name, hide, { capture: true, passive: true });
  return () => {
    stopped = true; moveStart(); move(); post(); hide();
    for (const name of inputEvents) document.removeEventListener(name, hide, { capture: true });
  };
}
