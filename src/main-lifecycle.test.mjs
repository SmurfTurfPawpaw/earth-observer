import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Execute the real entry and native context-recovery controller. Downstream
// owners are observable fixtures; their existing suites cover their disposal.
const modules = {
  './core/viewer.js': 'export function createGlobeViewer(){return globalThis.fixture.viewer;}',
  './core/layer-manager.js': 'export const STORAGE_KEY="layers"; export function createLayerManager(){return globalThis.fixture.manager;}',
  './core/catalog.js': 'export const LAYERS=[{id:"earthquakes"},{id:"flights"}];',
  './core/shell.js': 'export function createShell(){return globalThis.fixture.shell;}',
  './core/navigation.js': `export function setCameraView(viewer,view){globalThis.fixture.cameraWrites.push(view);globalThis.fixture.onCamera?.();}
    export function cameraView(){return {lat:50,lon:4,alt:90000,heading:0,pitch:-90,roll:0};}
    export function serializeViewHash(){return "layers=earthquakes";}
    export function parseViewHash(){return {view:{lat:0,lon:0,alt:18000000}};}
    export function installNavigation(viewer,options){globalThis.fixture.navigation=options;return ()=>{};}`,
  './core/browser-store.js': 'export function createBrowserStore(){return {};}',
  './core/cached-fetch.js': 'export function createCachedFetch(){return {destroy(){globalThis.fixture.calls.push("fetch:stop");}};}',
  './core/session.js': `export const SESSION_KEY="session"; export function initialWorkspace(){return globalThis.fixture.initial;}
    export function loadSession(){return null;} export function saveSession(){globalThis.fixture.sessionSaves++;}
    export function safeStorage(){return {removeItem(){globalThis.fixture.preferenceRemovals++;}};}
    export function locateVisitor(){globalThis.fixture.geoCalls++;return globalThis.fixture.geo.promise;}`,
  './core/local-area.js': `export function validateArea(area){return area;} export function localCameraView(area){return {...area,alt:30000};}
    export function distanceKm(){return 0;}`,
  './core/scene-preview.js': 'export function installScenePreview(){return ()=>{};}',
  './core/basemap-state.js': 'export function loadBasemapMode(){return "map";} export function saveBasemapMode(){}',
  './core/basemap-coverage.js': 'export function streetMapCoverageNotice(){return "Available";}',
  './core/globe-framing.js': 'export function recoverInitialCameraView(viewer,view){return {view,recovered:false};}',
  './core/timeline.js': `export function createTimeline(options){globalThis.fixture.timeOptions=options;return {
    live(){},destroy(){globalThis.fixture.calls.push("timeline:stop");}};}`,
  './core/live-updates.js': `export function createLiveUpdates(){return {subscribe(){return ()=>{};},start(){globalThis.fixture.streamActive=true;},
    destroy(){globalThis.fixture.calls.push("updates:stop");globalThis.fixture.streamActive=false;}};}`,
  './core/world-dossier-bridge.js': 'export function installWorldDossierBridge(){return {refresh(){},destroy(){globalThis.fixture.calls.push("dossiers:stop");}};}',
  './core/workspace-focus.js': `export function createPlaceNavigation(options){return ()=>{options.cancelLocation();return true;};}`,
  './core/plugin-dossier.js': 'export function createPluginDossierPanel(){throw new Error("Unused optional fixture");}',
  './core/intelligence.js': 'export function createIntelligencePanel(){throw new Error("Unused optional fixture");}',
  './core/report-dossier.js': 'export function createReportDossierController(){throw new Error("Unused optional fixture");}',
  './core/evidence.js': 'export function createEvidenceNotebook(){throw new Error("Unused optional fixture");}',
  cesium: 'export const Cartographic={fromCartesian(){}}; export const Math={toDegrees(x){return x;}};',
};
const bundle = build({
  entryPoints: [fileURLToPath(new URL('./main.js', import.meta.url))], bundle: true, write: false,
  format: 'iife', globalName: 'application', platform: 'browser', define: { 'import.meta.env': '{"PROD":true,"BASE_URL":"/earth/"}', 'import.meta.hot': 'undefined' },
  plugins: [{ name: 'main-owned-lifecycle-fixtures', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(modules, path) ? { path, namespace: 'fixture' } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: modules[path], loader: 'js' }));
  } }],
}).then(result => result.outputFiles[0].text);

const flush = async () => { for (let step = 0; step < 24; step++) await Promise.resolve(); };
function event() {
  const callbacks = new Set();
  return { addEventListener(fn) { callbacks.add(fn); return () => callbacks.delete(fn); },
    emit(...args) { for (const fn of [...callbacks]) fn(...args); }, callbacks };
}
async function fixture({ automatic = false, permission = Promise.resolve({ state: 'granted' }), closeGate } = {}) {
  const f = { calls: [], cameraWrites: [], layerRestores: [], sessionSaves: 0, preferenceRemovals: 0, geoCalls: 0,
    geo: Promise.withResolvers(), initial: { view: { lat: 50, lon: 4, alt: 90000 }, area: null, layers: ['earthquakes'], requestLocation: automatic },
    timers: new Map(), nextTimer: 0, streamActive: false, rafActive: true, clockActive: true, viewerDestroyed: false, logs: [] };
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const element = new EventTarget(); element.hidden = id === 'error'; element.disabled = false;
      element.setAttribute = () => {}; element.textContent = ''; element.value = '10'; nodes.set(id, element);
    }
    return nodes.get(id);
  };
  const document = new EventTarget(); document.hidden = false; document.getElementById = node;
  document.querySelector = node;
  const window = new EventTarget();
  const canvas = new EventTarget(), renderError = event(), postRender = event();
  let loop = false;
  f.viewer = { scene: { canvas, renderError, postRender, requestRender() {} },
    earthBasemap: { setMode() {}, getState: () => ({ mode: 'map', status: 'ready' }), ready: Promise.resolve() },
    earthTime: { sceneClock: { destroy() { if (!f.clockActive) return; f.calls.push('clock:stop'); f.clockActive = false; } }, getState: () => ({ mode: 'live' }) },
    isDestroyed: () => f.viewerDestroyed,
    get useDefaultRenderLoop() { return loop; }, set useDefaultRenderLoop(value) { assert.equal(f.viewerDestroyed, false, 'Disposed viewer resumed'); loop = value; },
    destroy() { f.calls.push('viewer:destroy'); f.viewerDestroyed = true; f.viewer.earthTime.sceneClock.destroy(); } };
  const requested = { earthquakes: { enabled: true }, flights: { enabled: false } };
  const modulesById = Object.fromEntries(Object.keys(requested).map(id => [id, { disable() { f.calls.push(`${id}:stop`); if (id === 'flights') f.rafActive = false; } }]));
  f.manager = { getState: () => requested, getLayerParams: () => ({}), setLocalArea(value) { f.area = value; },
    restore(ids) { f.layerRestores.push(ids); return Promise.resolve(); }, subscribe: () => () => {}, preload: () => Promise.resolve(),
    getLayer: id => modulesById[id], isTimelinePaused: () => false, requestRefresh() {},
    async setTimelineMode(mode) { f.calls.push(`mode:${mode}`); },
    destroy() { f.calls.push('manager:destroy'); f.timers.clear(); return closeGate?.promise ?? Promise.resolve(); } };
  f.shell = { setLocalStatus(text) { f.localStatus = text; }, notify(text) { f.calls.push(`notice:${text}`); },
    subscribePanels: () => () => {}, closeSidebar() {}, closeNews() {}, destroy() { f.calls.push('shell:stop'); } };
  const location = { href: 'https://example.com/earth/#layers=earthquakes', hash: '#layers=earthquakes', reload() { f.calls.push('reload'); } };
  const context = { fixture: f, document, window, navigator: { permissions: { query: () => permission } }, location,
    history: { replaceState() {} }, performance: { mark() {} }, URL, Event, CustomEvent, AbortController, DOMException,
    setTimeout(fn, delay) { const id = ++f.nextTimer; f.timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { f.timers.delete(id); },
    console: { error: (...args) => f.logs.push(args) }, queueMicrotask };
  vm.runInNewContext(await bundle, context);
  await flush();
  const loseGraphics = () => { const loss = new Event('webglcontextlost', { cancelable: true }); canvas.dispatchEvent(loss); return loss; };
  return { ...f, f, node, document, window, canvas, context, renderError, loseGraphics,
    locate: () => { const click = new Event('click'); node('locate').dispatchEvent(click); },
    navigate: () => f.navigation.onPlace({ lat: 51, lon: 5 }), flush };
}

test('successful Locate changes the area and camera without overriding disabled layer intent', async () => {
  const u = await fixture();
  u.locate(); u.f.geo.resolve({ lat: 51, lon: 5, radiusKm: 10 }); await u.flush();
  assert.equal(u.f.area.radiusKm, 10); assert.equal(u.f.cameraWrites.at(-1).lat, 51);
  assert.equal(u.f.layerRestores.length, 1, 'Locate must not apply another layer preset');
  assert.equal(u.f.manager.getState().flights.enabled, false);
  assert.match(u.f.calls.at(-1), /^notice:Local data is loading/);
  await u.context.application.destroy();
});

test('a canceled permission check cannot initiate geolocation, and canceled activation cannot announce local loading', async () => {
  const permission = Promise.withResolvers(), automatic = await fixture({ automatic: true, permission: permission.promise });
  automatic.navigate(); permission.resolve({ state: 'granted' }); await automatic.flush();
  assert.equal(automatic.f.geoCalls, 0);
  await automatic.context.application.destroy();

  const manual = await fixture();
  manual.f.onCamera = () => queueMicrotask(() => manual.navigate());
  manual.locate(); manual.f.geo.resolve({ lat: 51, lon: 5, radiusKm: 10 }); await manual.flush();
  assert.equal(manual.f.geoCalls, 1); assert.equal(manual.f.calls.some(call => call.startsWith('notice:')), false);
  await manual.context.application.destroy();
});

test('terminal native graphics loss stops every owner once before delayed disposal while preserving reload and preferences', async () => {
  const closeGate = Promise.withResolvers(), permission = Promise.withResolvers();
  const u = await fixture({ automatic: true, permission: permission.promise, closeGate });
  const restores = u.f.layerRestores.length, saves = u.f.sessionSaves;
  const savedFailure = [...u.renderError.callbacks][0];
  const aircraft = u.f.manager.getLayer('flights'), stopAircraft = aircraft.disable;
  aircraft.disable = () => { stopAircraft(); throw new Error('Test-only owner cleanup failure'); };
  const loss = u.loseGraphics();
  assert.equal(loss.defaultPrevented, true, 'Native restoration remains permitted');
  assert.equal(u.f.viewer.useDefaultRenderLoop, false); assert.equal(u.f.clockActive, false);
  assert.equal(u.f.rafActive, false); assert.equal(u.f.streamActive, false); assert.equal(u.f.timers.size, 0);
  assert.equal(u.f.viewerDestroyed, false, 'Viewer disposal waits for its pending owners');
  assert.equal(u.node('error').hidden, false); assert.match(u.node('error-message').textContent, /Reload to rebuild/);
  savedFailure(u.f.viewer.scene, new Error('Late render failure'));
  u.canvas.dispatchEvent(new Event('webglcontextrestored')); u.document.dispatchEvent(new Event('visibilitychange'));
  permission.resolve({ state: 'granted' }); await u.flush();
  assert.equal(u.f.geoCalls, 0); assert.equal(u.f.layerRestores.length, restores); assert.equal(u.f.sessionSaves, saves);
  assert.equal(u.f.preferenceRemovals, 0); assert.equal(u.f.manager.getState().flights.enabled, false);
  assert.equal(u.f.calls.filter(call => call === 'manager:destroy').length, 1);
  assert.equal(u.f.logs.some(args => args[1]?.message === 'Test-only owner cleanup failure'), true);
  closeGate.resolve(); await u.flush();
  assert.equal(u.f.viewerDestroyed, true); assert.equal(u.f.calls.filter(call => call === 'viewer:destroy').length, 1);
  assert.match(u.node('error-message').textContent, /Reload to rebuild/);
  u.node('reload').dispatchEvent(new Event('click')); assert.equal(u.f.calls.at(-1), 'reload');
});

test('tab visibility and retained-history transitions do not dispose a healthy scene', async () => {
  const u = await fixture();
  u.document.hidden = true; u.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(u.f.viewer.useDefaultRenderLoop, false);
  u.document.hidden = false; u.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(u.f.viewer.useDefaultRenderLoop, true);
  await u.f.timeOptions.onTimeChange({ mode: 'history' });
  assert.equal(u.f.calls.includes('manager:destroy'), false); assert.equal(u.f.viewerDestroyed, false);
  await u.context.application.destroy();
});
