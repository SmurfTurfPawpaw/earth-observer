import { createGlobeViewer } from './core/viewer.js';
import { createLayerManager, STORAGE_KEY } from './core/layer-manager.js';
import { LAYERS } from './core/catalog.js';
import { createShell } from './core/shell.js';
import { installNavigation, parseViewHash, setCameraView, cameraView, serializeViewHash } from './core/navigation.js';
import { createBrowserStore } from './core/browser-store.js';
import { createCachedFetch } from './core/cached-fetch.js';
import { initialWorkspace, loadSession, saveSession, locateVisitor, safeStorage, SESSION_KEY } from './core/session.js';
import { validateArea, localCameraView, distanceKm, LOCAL_DEFAULT_LAYERS } from './core/local-area.js';
import { installScenePreview } from './core/scene-preview.js';
import { loadBasemapMode, saveBasemapMode } from './core/basemap-state.js';

let viewer;
let manager;
let shell;
let destroyed = false;
let area = null, intelligence, notebook, panelLoading = {}, locationRevision = 0, warmTimer;
const store = createBrowserStore();
const cachedFetch = createCachedFetch({ store });
const disposers = [];
// Startup errors can happen before the shell exists.
document.getElementById('reload').addEventListener('click', () => location.reload());

function showError(error) {
  document.getElementById('loading').hidden = true;
  document.getElementById('error').hidden = false;
  const detail = error?.message || String(error);
  document.getElementById('error-message').textContent = /webgl|context|gpu/i.test(detail)
    ? 'WebGL could not initialize. Enable hardware acceleration in your browser, then reload. You can also try another browser.'
    : `The browser could not initialize the globe. ${detail}`;
  console.error('Earth Observer:', error);
}

function rememberWorkspace() {
  if (destroyed || !viewer || !manager) return;
  const view = cameraView(viewer), state = manager.getState();
  saveSession(view, area);
  const ids = LAYERS.filter((layer) => state[layer.id]?.enabled).map((layer) => layer.id);
  const params = Object.fromEntries(ids.map((id) => [id, manager.getLayerParams(id)]).filter(([, value]) => Object.keys(value).length));
  const url = new URL(location.href); url.hash = serializeViewHash(view, ids, params); history.replaceState(null, '', url);
}
function setArea(value) {
  area = validateArea(value); manager.setLocalArea(area);
  shell.setLocalStatus(area ? 'Local area' : 'Global view', { active: Boolean(area), radiusKm: area?.radiusKm });
}
async function activateLocal(value, { animate = false } = {}) {
  setArea(value); setCameraView(viewer, localCameraView(area), animate);
  const state = manager.getState();
  await manager.restore([...new Set([...LOCAL_DEFAULT_LAYERS, ...LAYERS.filter((layer) => state[layer.id]?.enabled).map((layer) => layer.id)])]);
  rememberWorkspace();
}
async function locate() {
  const revision = ++locationRevision;
  const button = document.getElementById('locate'); button.disabled = true;
  shell.setLocalStatus('Location permission…');
  try {
    const found = await locateVisitor();
    if (destroyed || revision !== locationRevision) return;
    await activateLocal(found);
    shell.notify('Local data is loading within the selected radius. Coverage depends on each source.');
  } catch (error) {
    if (destroyed || revision !== locationRevision) return;
    shell.setLocalStatus(area ? 'Local area' : 'Choose a place', { active: Boolean(area), radiusKm: area?.radiusKm }); shell.notify(error.message);
  } finally { if (!destroyed && revision === locationRevision) button.disabled = false; }
}
async function restoreView(state) {
  setArea(state.area);
  setCameraView(viewer, state.view);
  if (state.layerParams) {
    for (const [id, params] of Object.entries(state.layerParams)) manager.setLayerParams?.(id, params);
  }
  await manager.restore(state.layers ?? (state.requestLocation ? ['earthquakes'] : undefined));
}

function warmTools() {
  const queue = LAYERS.map((layer) => layer.id);
  async function worker() {
    while (queue.length && !destroyed) {
      if (document.hidden || navigator.connection?.saveData || ['slow-2g', '2g'].includes(navigator.connection?.effectiveType)) return;
      await manager.preload(queue.shift());
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  void Promise.all([worker(), worker()]);
  if (!document.hidden && !navigator.connection?.saveData && !['slow-2g', '2g'].includes(navigator.connection?.effectiveType)) {
    void Promise.allSettled([import('./core/intelligence.js'), import('./core/evidence.js')]);
  }
}

async function handlePanel({ panel, open }) {
  if (!['news', 'notebook'].includes(panel)) return;
  if (!open) { (panel === 'news' ? intelligence : notebook)?.close(); return; }
  if (!panelLoading[panel]) panelLoading[panel] = (async () => {
    if (panel === 'news') {
      const { createIntelligencePanel } = await import('./core/intelligence.js');
      if (destroyed) return;
      intelligence = createIntelligencePanel({ container: document.getElementById('news-content'), fetchImpl: cachedFetch,
        onStatus: () => { document.getElementById('news-status').hidden = true; },
        onNavigate: ({ lat, lon }) => { void activateLocal({ lat, lon, radiusKm: 25 }, { animate: true }); },
      });
    } else {
      const { createEvidenceNotebook } = await import('./core/evidence.js');
      if (destroyed) return;
      notebook = createEvidenceNotebook({ container: document.getElementById('notebook-content'), store, getLocation: () => cameraView(viewer), notify: shell.notify });
    }
  })().catch((error) => { delete panelLoading[panel]; shell?.notify(error.message || 'The panel could not load.'); });
  await panelLoading[panel];
  if (destroyed || document.getElementById(panel === 'news' ? 'news-panel' : 'notebook-panel').hidden) return;
  await (panel === 'news' ? intelligence : notebook)?.open();
}

export async function start() {
  try {
    const initial = initialWorkspace(location.hash, loadSession(), LAYERS.map((layer) => layer.id));
    viewer = createGlobeViewer({
      container: document.getElementById('globe'),
      creditContainer: document.getElementById('credits'),
      onNotice: (message) => shell?.notify(message),
    });
    manager = createLayerManager(viewer, () => {}, { fetchImpl: cachedFetch, localArea: initial.area });
    shell = createShell(viewer, manager);
    const basemapButton = document.getElementById('toggle-basemap');
    const setBasemap = (mode) => {
      viewer.earthBasemap?.setMode(mode);
      saveBasemapMode(mode);
      basemapButton.setAttribute('aria-pressed', String(mode === 'imagery'));
      basemapButton.title = mode === 'imagery' ? 'Show roads and place names' : 'Show global satellite imagery';
      basemapButton.setAttribute('aria-label', basemapButton.title);
    };
    setBasemap(loadBasemapMode());
    basemapButton.disabled = false;
    const toggleBasemap = () => setBasemap(viewer.earthBasemap?.getState().mode === 'imagery' ? 'map' : 'imagery');
    basemapButton.addEventListener('click', toggleBasemap);
    disposers.push(() => basemapButton.removeEventListener('click', toggleBasemap));
    // Set the requested camera before the first render or imagery request.
    const restoration = restoreView(initial);
    disposers.push(installNavigation(viewer, {
      onPlace(place) { ++locationRevision; document.getElementById('locate').disabled = false; void activateLocal({ lat: place.lat, lon: place.lon, radiusKm: 10 }, { animate: true }); shell.closeSidebar(); return true; },
      onViewChange(view) {
        if (area && (view.alt > 1500000 || distanceKm(view.lat, view.lon, area) > area.radiusKm * 3)) setArea(null);
        rememberWorkspace();
      },
    }));
    disposers.push(manager.subscribe(rememberWorkspace));
    disposers.push(shell.subscribePanels(handlePanel));
    disposers.push(installScenePreview(viewer, { store, cameraView, getState: manager.getState }));
    const locateButton = document.getElementById('locate'); locateButton.disabled = false; locateButton.addEventListener('click', locate); disposers.push(() => locateButton.removeEventListener('click', locate));
    const radius = document.getElementById('local-radius');
    const radiusChange = () => { if (area) { setArea({ ...area, radiusKm: Number(radius.value) }); setCameraView(viewer, localCameraView(area), true); rememberWorkspace(); } };
    radius.addEventListener('change', radiusChange); disposers.push(() => radius.removeEventListener('change', radiusChange));
    const resetButton = document.getElementById('reset-session'); resetButton.disabled = false;
    const reset = async () => {
      ++locationRevision; locateButton.disabled = false;
      const storage = safeStorage(); try { storage?.removeItem(SESSION_KEY); storage?.removeItem(STORAGE_KEY); } catch {}
      area = null; manager.setLocalArea(null); await manager.restore(['earthquakes']);
      setBasemap('map');
      const global = parseViewHash('', LAYERS.map((layer) => layer.id)); setCameraView(viewer, global.view);
      shell.setLocalStatus('Global view'); shell.notify('View and layer preferences reset. Your evidence notebook stays saved.'); rememberWorkspace();
    };
    resetButton.addEventListener('click', reset); disposers.push(() => resetButton.removeEventListener('click', reset));
    disposers.push(viewer.scene.renderError.addEventListener((_scene, error) => showError(error)));
    const visibility = () => {
      viewer.useDefaultRenderLoop = !document.hidden;
      if (!document.hidden) viewer.scene.requestRender();
    };
    document.addEventListener('visibilitychange', visibility);
    disposers.push(() => document.removeEventListener('visibilitychange', visibility));
    const hashchange = () => {
      // Document anchors (for example the search skip link) do not replace a shared view.
      const params = new URLSearchParams(location.hash.slice(1));
      if (location.hash && !['v', 'lat', 'lon', 'layers'].some((key) => params.has(key))) return;
      ++locationRevision;
      restoreView(initialWorkspace(location.hash, loadSession(), LAYERS.map((layer) => layer.id))).catch((error) => shell.notify(error.message || 'The shared view could not be restored.'));
    };
    window.addEventListener('hashchange', hashchange);
    disposers.push(() => window.removeEventListener('hashchange', hashchange));
    document.getElementById('loading').hidden = true;
    performance.mark('earth-observer:controls-ready');
    const firstFrame = viewer.scene.postRender.addEventListener(() => {
      performance.mark('earth-observer:first-frame');
      firstFrame();
    });
    disposers.push(firstFrame);
    visibility();
    if (initial.requestLocation) void locate();
    // Startup must finish before optional code warming or offline-cache installation.
    warmTimer = setTimeout(() => {
      if (destroyed) return;
      const run = () => { if (!destroyed) warmTools(); };
      if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 3000 }); else run();
      if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
    }, 1000);
    await restoration;
    if (destroyed) return;
    document.getElementById('loading').hidden = true;
    viewer.scene.requestRender();
    visibility();
  } catch (error) {
    showError(error);
    await destroy();
  }
}

export async function destroy() {
  if (destroyed) return;
  destroyed = true;
  ++locationRevision; clearTimeout(warmTimer); intelligence?.destroy(); notebook?.destroy(); cachedFetch.destroy();
  disposers.splice(0).reverse().forEach((dispose) => dispose());
  shell?.destroy();
  await manager?.destroy();
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
}

// bfcache keeps the existing session alive; actual unload disposes owned work.
window.addEventListener('pagehide', (event) => { if (!event.persisted) destroy(); });
if (import.meta.hot) import.meta.hot.dispose(destroy);
start();
