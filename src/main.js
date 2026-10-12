import { createGlobeViewer } from './core/viewer.js';
import { createLayerManager, STORAGE_KEY } from './core/layer-manager.js';
import { LAYERS } from './core/catalog.js';
import { createShell } from './core/shell.js';
import { installNavigation, parseViewHash, setCameraView, cameraView, serializeViewHash } from './core/navigation.js';
import { createBrowserStore } from './core/browser-store.js';
import { createCachedFetch } from './core/cached-fetch.js';
import { initialWorkspace, loadSession, saveSession, locateVisitor, safeStorage, SESSION_KEY } from './core/session.js';
import { validateArea, localCameraView, distanceKm } from './core/local-area.js';
import { installScenePreview } from './core/scene-preview.js';
import { loadBasemapMode, saveBasemapMode } from './core/basemap-state.js';
import { streetMapCoverageNotice } from './core/basemap-coverage.js';
import { recoverInitialCameraView } from './core/globe-framing.js';
import { installContextRecovery } from './core/context-recovery.js';
import { createTimeline } from './core/timeline.js';
import { createLiveUpdates } from './core/live-updates.js';
import { installWorldDossierBridge } from './core/world-dossier-bridge.js';
import { createPlaceNavigation } from './core/workspace-focus.js';
import { Cartographic, Math as CesiumMath } from 'cesium';

let viewer;
let manager;
let shell;
let destroyed = false;
let describeBasemap = () => {};
let contextRecovery;
let area = null, intelligence, notebook, timeline, updates, worldDossiers, reportDossiers, navigatePlace, panelLoading = {}, locationRevision = 0, warmTimer;
const store = createBrowserStore();
const cachedFetch = createCachedFetch({ store });
const disposers = [];
// Startup errors can happen before the shell exists.
document.getElementById('reload').addEventListener('click', () => location.reload());

function showError(error) {
  document.getElementById('loading').hidden = true;
  document.getElementById('error').hidden = false;
  const detail = error?.message || String(error);
  const graphicsInterrupted = typeof error?.code === 'string' && error.code.startsWith('EARTH_WEBGL_');
  document.querySelector('#error h2').textContent = graphicsInterrupted ? 'Map rendering interrupted' : 'The globe could not start';
  document.getElementById('error-message').textContent = graphicsInterrupted ? detail : /webgl|context|gpu/i.test(detail)
    ? 'WebGL could not initialize. Enable hardware acceleration in your browser, then reload. You can also try another browser.'
    : `The browser could not initialize the globe. ${detail}`;
  console.error('Earth Observer:', error);
}

function stopFailedScene(error) {
  if (destroyed) return;
  showError(error);
  // These callbacks report a viewer that requires a reload. Native context
  // restoration and ordinary tab/history suspension remain separate paths.
  void destroy().catch((failure) => console.error('Earth Observer cleanup:', failure));
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
  rememberWorkspace();
}
async function locate({ automatic = false } = {}) {
  if (destroyed) return;
  const revision = ++locationRevision;
  const button = document.getElementById('locate'); button.disabled = true;
  shell.setLocalStatus('Location permission…');
  try {
    if (automatic && navigator.permissions?.query) {
      const permission = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null);
      if (permission?.state === 'denied') return;
    }
    if (destroyed || revision !== locationRevision) return;
    const found = await locateVisitor();
    if (destroyed || revision !== locationRevision) return;
    await activateLocal(found);
    if (destroyed || revision !== locationRevision) return;
    if (!automatic) shell.notify('Local data is loading within the selected radius. Coverage depends on each source.');
  } catch (error) {
    if (destroyed || revision !== locationRevision) return;
    if (!automatic) shell.notify(error.message);
  } finally {
    if (!destroyed && revision === locationRevision) {
      shell.setLocalStatus(area ? 'Local area' : 'Choose a place', { active: Boolean(area), radiusKm: area?.radiusKm });
      button.disabled = false;
    }
  }
}
async function restoreView(state) {
  if (destroyed) return;
  setArea(state.area);
  const restored = recoverInitialCameraView(viewer, state.view);
  setCameraView(viewer, restored.view);
  if (restored.recovered) shell.notify('The saved camera pointed away from Earth. Its view has been restored.');
  if (state.layerParams) {
    for (const [id, params] of Object.entries(state.layerParams)) manager.setLayerParams?.(id, params);
  }
  await manager.restore(state.layers ?? (state.requestLocation ? ['earthquakes'] : undefined));
}

function warmTools() {
  // Warm the common lightweight view; other engines warm on hover/focus.
  // Importing every optional engine also loads large terrain/space assets.
  const queue = ['earthquakes', 'weather-satellite'];
  async function worker() {
    while (queue.length && !destroyed && !contextRecovery?.isLost()) {
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
  if (destroyed) return;
  if (!['news', 'notebook'].includes(panel)) return;
  if (!open) { (panel === 'news' ? intelligence : notebook)?.close(); if (panel === 'news') reportDossiers?.cancel(); return; }
  if (!panelLoading[panel]) panelLoading[panel] = (async () => {
    if (panel === 'news') {
      const { createPluginDossierPanel } = await import('./core/plugin-dossier.js');
      if (destroyed) return;
      document.querySelector('#news-panel .panel-note').hidden = true;
      document.getElementById('news-status').hidden = true;
      intelligence = createPluginDossierPanel({ container: document.getElementById('news-content'), fetchImpl: cachedFetch, subscribeUpdates: updates.subscribe,
        getScene: () => timeline?.getContextState() || { ...viewer.earthTime.getState(), lens: 'reconstruction' },
        createFeed: async (container) => {
          const [{ createIntelligencePanel }, { createReportDossierController }] = await Promise.all([
            import('./core/intelligence.js'), import('./core/report-dossier.js'),
          ]);
          if (destroyed) throw new Error('The workspace is closed.');
          reportDossiers ||= createReportDossierController({ fetchImpl: cachedFetch,
            getScene: () => viewer.earthTime.getState(), getSelection: () => viewer.selectedEntity,
            getNavigationKey: () => JSON.stringify(cameraView(viewer)),
            onOpen(event) { navigatePlace({ lat: event.place.lat, lon: event.place.lon }); shell.openWorldReport(event); }, onError: shell.notify });
          return createIntelligencePanel({ container, fetchImpl: cachedFetch, store,
            subscribeUpdates: updates.subscribe,
            onStatus: () => {},
            onNavigate: (place) => navigatePlace(place),
            onOpenReport: (report) => reportDossiers.open(report),
            onSuspend: () => reportDossiers.cancel(),
          });
        },
      });
      void intelligence.commitScene(timeline?.getContextState() || { ...viewer.earthTime.getState(), lens: 'reconstruction' });
    } else {
      const { createEvidenceNotebook } = await import('./core/evidence.js');
      if (destroyed) return;
      notebook = createEvidenceNotebook({ container: document.getElementById('notebook-content'), store, getLocation: () => cameraView(viewer), notify: shell.notify });
    }
  })().catch((error) => { delete panelLoading[panel]; if (!destroyed) shell?.notify(error.message || 'The panel could not load.'); });
  await panelLoading[panel];
  if (destroyed || document.getElementById(panel === 'news' ? 'news-panel' : 'notebook-panel').hidden) return;
  await (panel === 'news' ? intelligence : notebook)?.open();
}

export async function start({ earlySearchIntent } = {}) {
  if (destroyed) { earlySearchIntent?.destroy(); return; }
  disposers.push(() => earlySearchIntent?.destroy());
  try {
    const initial = initialWorkspace(location.hash, loadSession(), LAYERS.map((layer) => layer.id));
    viewer = createGlobeViewer({
      container: document.getElementById('globe'),
      creditContainer: document.getElementById('credits'),
      onNotice: (message) => { shell?.notify(message); describeBasemap(); },
    });
    contextRecovery = installContextRecovery(viewer, {
      onLost: stopFailedScene,
      onRestored: stopFailedScene,
    });
    disposers.push(() => contextRecovery.destroy());
    manager = createLayerManager(viewer, () => {}, { fetchImpl: cachedFetch, localArea: initial.area });
    shell = createShell(viewer, manager);
    navigatePlace = createPlaceNavigation({ viewer, cancelLocation() { ++locationRevision; document.getElementById('locate').disabled = false; }, closeSidebar: shell.closeSidebar });
    updates = createLiveUpdates();
    disposers.push(() => updates.destroy());
    worldDossiers = installWorldDossierBridge({ viewer, subscribeUpdates: updates.subscribe,
      readSelection(entity) {
        const values = entity?.properties?.getValue?.(viewer.clock.currentTime);
        if (values?._worldReport) return values;
        const position = entity?.position?.getValue?.(viewer.clock.currentTime);
        if (!values?.usgsId || !position) return null;
        const point = Cartographic.fromCartesian(position);
        return { ...values, lat: CesiumMath.toDegrees(point.latitude), lon: CesiumMath.toDegrees(point.longitude) };
      },
    });
    disposers.push(() => worldDossiers.destroy());
    disposers.push(() => reportDossiers?.destroy());
    const basemapButton = document.getElementById('toggle-basemap');
    describeBasemap = () => {
      const state = viewer.earthBasemap?.getState();
      const action = state?.mode === 'imagery' ? 'Show roads and place names' : 'Show global overview imagery';
      const detail = state?.mode === 'map'
        ? state.status === 'unavailable' ? 'Street map unavailable; coarse imagery is shown. Reconnect and choose the map again to retry.'
          : state.coverage ? streetMapCoverageNotice(state.coverage) : 'NASA global overview imagery has limited close-up detail.'
        : state?.active === 'bundled' ? 'Bundled overview imagery is shown while NASA imagery is unavailable.' : 'NASA global overview imagery has limited close-up detail; roads and place names provide local detail.';
      basemapButton.title = detail ? `${action}. ${detail}` : action;
      basemapButton.setAttribute('aria-label', action);
      if (detail) basemapButton.setAttribute('aria-description', detail);
      else basemapButton.removeAttribute('aria-description');
    };
    const setBasemap = (mode) => {
      viewer.earthBasemap?.setMode(mode);
      saveBasemapMode(mode);
      basemapButton.setAttribute('aria-pressed', String(mode === 'imagery'));
      describeBasemap();
    };
    setBasemap(loadBasemapMode());
    void viewer.earthBasemap?.ready?.then(describeBasemap);
    basemapButton.disabled = false;
    const toggleBasemap = () => setBasemap(viewer.earthBasemap?.getState().mode === 'imagery' ? 'map' : 'imagery');
    basemapButton.addEventListener('click', toggleBasemap);
    disposers.push(() => basemapButton.removeEventListener('click', toggleBasemap));
    // Set the requested camera before the first render or imagery request.
    const restoration = restoreView(initial);
    disposers.push(installNavigation(viewer, {
      onPlace: navigatePlace,
      onViewChange(view) {
        if (area && (view.alt > 1500000 || distanceKm(view.lat, view.lon, area) > area.radiusKm * 3)) setArea(null);
        rememberWorkspace();
      },
    }));
    // The initial camera and ordinary search handler are ready; layer delivery
    // remains independent. An explicit early search supersedes automatic locate.
    const earlySearchReplayed = earlySearchIntent?.ready() === true;
    disposers.push(manager.subscribe(rememberWorkspace));
    disposers.push(shell.subscribePanels(handlePanel));
    disposers.push(installScenePreview(viewer, { store, cameraView, getState: () => ({ ...manager.getState(), timelinePaused: manager.isTimelinePaused() }) }));
    let appliedSceneMode = 'live';
    timeline = createTimeline({ container: document.getElementById('earth-timeline'), viewer, fetchImpl: cachedFetch,
      onContextCommit: (state) => intelligence?.commitScene(state),
      async onTimeChange(state) {
        if (destroyed) return;
        const changed = appliedSceneMode !== state.mode;
        appliedSceneMode = state.mode;
        if (changed && state.mode === 'history') { shell.closeNews(); viewer.selectedEntity = undefined; viewer.trackedEntity = undefined; }
        if (changed) await manager.setTimelineMode(state.mode);
        if (destroyed || appliedSceneMode !== state.mode) return;
        if (changed) intelligence?.setSceneMode(state.mode);
        void worldDossiers.refresh();
        window.dispatchEvent(new CustomEvent('earth-observer:timechange', { detail: state }));
      },
      onNavigate(report) { setCameraView(viewer, { ...cameraView(viewer), lat: report.lat, lon: report.lon, alt: 200000, pitch: -90 }, true); },
    });
    disposers.push(() => timeline.destroy());
    disposers.push(updates.subscribe((event) => {
      if (event.type === 'collection') {
        // A global collection revision wakes a fresh stored GDACS read. It is
        // not a source-specific edition fence or an event occurrence clock.
        manager.getLayer('gdacs-notices')?.invalidatePreparedSnapshot?.();
        manager.requestRefresh('gdacs-notices');
        return;
      }
      if (event.type === 'plugin' && event.pluginId === 'usgs-live-day-m2-5-v1') {
        manager.requestRefresh('earthquakes', event);
        return;
      }
      if (event.type !== 'aircraft') return;
      for (const id of ['flights', 'military']) manager.requestRefresh(id);
    }));
    updates.start();
    const locateButton = document.getElementById('locate'); locateButton.title = 'Explore local data near your location'; locateButton.setAttribute('aria-label', locateButton.title);
    locateButton.disabled = false; locateButton.addEventListener('click', locate); disposers.push(() => locateButton.removeEventListener('click', locate));
    const radius = document.getElementById('local-radius');
    const radiusChange = () => { if (area) { setArea({ ...area, radiusKm: Number(radius.value) }); setCameraView(viewer, localCameraView(area), true); rememberWorkspace(); } };
    radius.addEventListener('change', radiusChange); disposers.push(() => radius.removeEventListener('change', radiusChange));
    const resetButton = document.getElementById('reset-session'); resetButton.disabled = false;
    const reset = async () => {
      timeline.live();
      ++locationRevision; locateButton.disabled = false;
      const storage = safeStorage(); try { storage?.removeItem(SESSION_KEY); storage?.removeItem(STORAGE_KEY); } catch {}
      area = null; manager.setLocalArea(null); await manager.restore(['earthquakes']);
      if (destroyed) return;
      setBasemap('map');
      const global = parseViewHash('', LAYERS.map((layer) => layer.id)); setCameraView(viewer, global.view);
      shell.setLocalStatus('Global view'); shell.notify('View and layer preferences reset. Your evidence notebook stays saved.'); rememberWorkspace();
    };
    resetButton.addEventListener('click', reset); disposers.push(() => resetButton.removeEventListener('click', reset));
    disposers.push(viewer.scene.renderError.addEventListener((_scene, error) => stopFailedScene(error)));
    const visibility = () => {
      if (destroyed) return;
      viewer.useDefaultRenderLoop = !document.hidden && !contextRecovery.isLost();
      if (viewer.useDefaultRenderLoop) viewer.scene.requestRender();
    };
    document.addEventListener('visibilitychange', visibility);
    disposers.push(() => document.removeEventListener('visibilitychange', visibility));
    const hashchange = () => {
      // Document anchors (for example the search skip link) do not replace a shared view.
      const params = new URLSearchParams(location.hash.slice(1));
      if (location.hash && !['v', 'lat', 'lon', 'layers'].some((key) => params.has(key))) return;
      ++locationRevision;
      restoreView(initialWorkspace(location.hash, loadSession(), LAYERS.map((layer) => layer.id))).catch((error) => { if (!destroyed) shell.notify(error.message || 'The shared view could not be restored.'); });
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
    if (initial.requestLocation && !earlySearchReplayed && !document.hidden) void locate({ automatic: true });
    // Startup must finish before optional code warming or offline-cache installation.
    warmTimer = setTimeout(() => {
      if (destroyed || contextRecovery.isLost()) return;
      const run = () => { if (!destroyed && !contextRecovery.isLost()) warmTools(); };
      if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 3000 }); else run();
    }, 1000);
    await restoration;
    if (destroyed) return;
    document.getElementById('loading').hidden = true;
    viewer.scene.requestRender();
    visibility();
  } catch (error) {
    if (!destroyed) showError(error);
    await destroy();
  }
}

export async function destroy() {
  if (destroyed) return;
  destroyed = true;
  describeBasemap = () => {};
  const pending = [];
  const stop = (work) => {
    try { const result = work(); if (result?.then) pending.push(Promise.resolve(result)); }
    catch (error) { console.error('Earth Observer cleanup:', error); }
  };
  ++locationRevision; clearTimeout(warmTimer);
  if (viewer && !viewer.isDestroyed()) {
    stop(() => { viewer.useDefaultRenderLoop = false; });
    stop(() => viewer.earthTime?.sceneClock?.destroy());
    // Stop independent animation before a pending lazy load can delay disposal.
    // Direct teardown leaves requested intent and saved preferences untouched.
    for (const { id } of LAYERS) stop(() => manager?.getLayer(id)?.disable?.(viewer));
  }
  stop(() => intelligence?.destroy()); stop(() => notebook?.destroy()); stop(() => cachedFetch.destroy());
  for (const dispose of disposers.splice(0).reverse()) stop(dispose);
  stop(() => shell?.destroy());
  stop(() => manager?.destroy());
  for (const result of await Promise.allSettled(pending)) if (result.status === 'rejected') console.error('Earth Observer cleanup:', result.reason);
  if (viewer && !viewer.isDestroyed()) stop(() => viewer.destroy());
}

// bfcache keeps the existing session alive; actual unload disposes owned work.
window.addEventListener('pagehide', (event) => { if (!event.persisted) destroy(); });
if (import.meta.hot) import.meta.hot.dispose(destroy);
