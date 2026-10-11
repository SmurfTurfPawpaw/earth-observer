import { createGlobeViewer } from './core/viewer.js';
import { createLayerManager } from './core/layer-manager.js';
import { LAYERS } from './core/catalog.js';
import { createShell } from './core/shell.js';
import { installNavigation, parseViewHash, setCameraView } from './core/navigation.js';

let viewer;
let manager;
let shell;
let destroyed = false;
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

async function restoreView() {
  const state = parseViewHash(location.hash, LAYERS.map((layer) => layer.id));
  setCameraView(viewer, state.view);
  if (state.layerParams) {
    for (const [id, params] of Object.entries(state.layerParams)) manager.setLayerParams?.(id, params);
  }
  await manager.restore(state.layers);
}

export async function start() {
  try {
    viewer = createGlobeViewer({
      container: document.getElementById('globe'),
      creditContainer: document.getElementById('credits'),
      onNotice: (message) => shell?.notify(message),
    });
    manager = createLayerManager(viewer);
    shell = createShell(viewer, manager);
    // Set the requested camera before the first render or imagery request.
    const restoration = restoreView();
    disposers.push(installNavigation(viewer, { onPlace: () => shell.closeSidebar() }));
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
      restoreView().catch((error) => shell.notify(error.message || 'The shared view could not be restored.'));
    };
    window.addEventListener('hashchange', hashchange);
    disposers.push(() => window.removeEventListener('hashchange', hashchange));
    document.getElementById('loading').hidden = true;
    visibility();
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
  disposers.splice(0).reverse().forEach((dispose) => dispose());
  shell?.destroy();
  await manager?.destroy();
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
}

// bfcache keeps the existing session alive; actual unload disposes owned work.
window.addEventListener('pagehide', (event) => { if (!event.persisted) destroy(); });
if (import.meta.hot) import.meta.hot.dispose(destroy);
start();
