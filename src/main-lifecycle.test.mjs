import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Execute the real entry and native context-recovery controller. Downstream
// owners are observable fixtures; their existing suites cover their disposal.
const modules = {
  './core/viewer.js': 'export function createGlobeViewer(){if(globalThis.fixture.startupError)throw globalThis.fixture.startupError;return globalThis.fixture.viewer;}',
  './core/layer-manager.js': 'export const STORAGE_KEY="layers"; export function createLayerManager(){return globalThis.fixture.manager;}',
  './core/catalog.js': 'export const LAYERS=[{id:"earthquakes"},{id:"flights"}];',
  './core/shell.js': 'export function createShell(viewer,manager,options){globalThis.fixture.shellOptions=options;return globalThis.fixture.shell;}',
  './core/navigation.js': `export function setCameraView(viewer,view){globalThis.fixture.cameraWrites.push(view);globalThis.fixture.onCamera?.();}
    export function cameraView(){return {lat:50,lon:4,alt:90000,heading:0,pitch:-90,roll:0};}
    export function serializeViewHash(view,ids,params,temporal){globalThis.fixture.serialized.push({view,ids,params,temporal});return "layers=earthquakes";}
    export function parseViewHash(){return {view:{lat:0,lon:0,alt:18000000}};}
    export function installNavigation(viewer,options){globalThis.fixture.navigation=options;return ()=>{};}`,
  './core/browser-store.js': 'export function createBrowserStore(){return {};}',
  './core/cached-fetch.js': 'export function createCachedFetch(){return {destroy(){globalThis.fixture.calls.push("fetch:stop");}};}',
  './core/session.js': `export const SESSION_KEY="session"; export function initialWorkspace(){if(globalThis.fixture.initialError)throw globalThis.fixture.initialError;return globalThis.fixture.initial;}
    export function loadSession(){return null;} export function saveSession(view,area,storage,temporal){globalThis.fixture.sessionSaves++;globalThis.fixture.savedTemporal.push(temporal);}
    export function safeStorage(){return {removeItem(){globalThis.fixture.preferenceRemovals++;}};}
    export function locateVisitor(){globalThis.fixture.geoCalls++;return globalThis.fixture.geo.promise;}`,
  './core/local-area.js': `export function validateArea(area){return area;} export function localCameraView(area){return {...area,alt:30000};}
    export function distanceKm(){return 0;}`,
  './core/scene-preview.js': 'export function installScenePreview(){return ()=>{};}',
  './core/basemap-state.js': 'export function loadBasemapMode(){return "map";} export function saveBasemapMode(){}',
  './core/basemap-coverage.js': 'export function streetMapCoverageNotice(){return "Available";}',
  './core/globe-framing.js': 'export function recoverInitialCameraView(viewer,view){return {view,recovered:false};}',
  './core/timeline.js': `export function createTimeline(options){globalThis.fixture.timeOptions=options;return {
    getContextState(){return {...globalThis.fixture.temporal};},
    prepareRestore(value){globalThis.fixture.temporal={...value,playing:false};},
    restore(value){globalThis.fixture.timelineRestores.push(value);globalThis.fixture.temporal={...value,playing:false};return Promise.resolve(false);},cancelRestore(){},
    live(){globalThis.fixture.temporal={mode:"live"};},destroy(){globalThis.fixture.calls.push("timeline:stop");}};}`,
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
async function fixture({ automatic = false, permission = Promise.resolve({ state: 'granted' }), closeGate, restorationGate,
  intentFactory, startupError, initialError, modeGate, hidden = false, temporal = { mode: 'live' } } = {}) {
  const f = { calls: [], cameraWrites: [], layerRestores: [], sessionSaves: 0, preferenceRemovals: 0, geoCalls: 0,
    geo: Promise.withResolvers(), initial: { view: { lat: 50, lon: 4, alt: 90000 }, temporal, area: null, layers: ['earthquakes'], requestLocation: automatic },
    timers: new Map(), nextTimer: 0, streamActive: false, rafActive: true, clockActive: true, viewerDestroyed: false, logs: [], startupError,
    temporal: { mode: 'live' }, serialized: [], savedTemporal: [], restoreModes: [], timelineRestores: [], initialError, replaced: [] };
  const nodes = new Map(), createdElements = [];
  const element = (tag = 'div') => {
    const result = new EventTarget(), attributes = new Map();
    result.tagName = tag.toUpperCase(); result.hidden = false; result.disabled = false;
    result.textContent = ''; result.value = '10'; result.children = [];
    result.setAttribute = (name, value) => attributes.set(name, String(value));
    result.getAttribute = name => attributes.get(name) ?? null;
    result.append = (...children) => { for (const child of children) { child.parentNode = result; result.children.push(child); } };
    result.remove = () => {
      const parent = result.parentNode;
      if (parent) { const index = parent.children.indexOf(result); if (index >= 0) parent.children.splice(index, 1); }
      result.parentNode = null;
    };
    return result;
  };
  const node = id => {
    if (!nodes.has(id)) {
      const result = element(); result.hidden = id === 'error'; nodes.set(id, result);
    }
    return nodes.get(id);
  };
  const document = new EventTarget(); document.hidden = hidden; document.getElementById = node;
  document.createElement = tag => { const result = element(tag); createdElements.push(result); return result; };
  document.createElementNS = (namespace, tag) => {
    assert.equal(namespace, 'http://www.w3.org/2000/svg');
    return document.createElement(tag);
  };
  document.querySelector = node;
  const window = new EventTarget();
  const canvas = new EventTarget(), renderError = event(), postRender = event();
  let loop = false;
  f.viewer = { scene: { canvas, renderError, postRender, requestRender() {} },
    earthBasemap: { setMode() {}, getState: () => ({ mode: 'map', status: 'ready' }), ready: Promise.resolve() },
    earthTime: { sceneClock: { destroy() { if (!f.clockActive) return; f.calls.push('clock:stop'); f.clockActive = false; } }, getState: () => f.temporal,
      pause() {}, setCoverage() {}, setTime(at) { f.temporal = at ? { mode: 'history', at } : { mode: 'live' }; }, setRate(rate) { f.temporal.rate = rate; } },
    isDestroyed: () => f.viewerDestroyed,
    get useDefaultRenderLoop() { return loop; }, set useDefaultRenderLoop(value) { assert.equal(f.viewerDestroyed, false, 'Disposed viewer resumed'); loop = value; },
    destroy() { f.calls.push('viewer:destroy'); f.viewerDestroyed = true; f.viewer.earthTime.sceneClock.destroy(); } };
  const requested = { earthquakes: { enabled: true }, flights: { enabled: false } };
  const modulesById = Object.fromEntries(Object.keys(requested).map(id => [id, { disable() { f.calls.push(`${id}:stop`); if (id === 'flights') f.rafActive = false; } }]));
  f.manager = { getState: () => requested, getLayerParams: () => ({}), setLocalArea(value) { f.area = value; },
    restore(ids) { f.layerRestores.push(ids); f.restoreModes.push(f.temporal.mode); return restorationGate?.promise || Promise.resolve(); },
    subscribe(listener) { f.managerSubscriber = listener; return () => {}; }, preload: () => Promise.resolve(),
    getLayer: id => modulesById[id], isTimelinePaused: () => false, requestRefresh() {},
    async setTimelineMode(mode) { f.calls.push(`mode:${mode}`); if (f.calls.filter(call => call.startsWith('mode:')).length === 1 && modeGate) await modeGate.promise; },
    destroy() { f.calls.push('manager:destroy'); f.timers.clear(); return closeGate?.promise ?? Promise.resolve(); } };
  f.shell = { setLocalStatus(text) { f.localStatus = text; }, notify(text) { f.calls.push(`notice:${text}`); },
    subscribePanels: () => () => {}, closeSidebar() {}, closeNews() {}, destroy() { f.calls.push('shell:stop'); } };
  const location = { href: 'https://example.com/earth/#layers=earthquakes', hash: '#layers=earthquakes', reload() { f.calls.push('reload'); } };
  const context = { fixture: f, document, window, navigator: { permissions: { query: () => permission } }, location,
    history: { replaceState(_state, _title, url) { f.replaced.push(url); } }, performance: { mark() {} }, URL, URLSearchParams, Event, CustomEvent, AbortController, DOMException,
    setTimeout(fn, delay) { const id = ++f.nextTimer; f.timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { f.timers.delete(id); },
    console: { error: (...args) => f.logs.push(args) }, queueMicrotask };
  vm.runInNewContext(await bundle, context);
  assert.equal(f.cameraWrites.length, 0, 'Importing main does not own an implicit second startup');
  const starting = context.application.start({ earlySearchIntent: intentFactory?.(f) });
  await flush();
  if (!startupError && !initialError) assert.equal(f.logs.length, 0,
    `Unexpected fixture startup error: ${f.logs[0]?.[1]?.message || 'unknown'}`);
  const loseGraphics = () => { const loss = new Event('webglcontextlost', { cancelable: true }); canvas.dispatchEvent(loss); return loss; };
  return { ...f, f, node, createdElements, document, window, canvas, context, renderError, loseGraphics, starting,
    locate: () => { const click = new Event('click'); node('locate').dispatchEvent(click); },
    navigate: () => f.navigation.onPlace({ lat: 51, lon: 5 }), flush };
}

test('successful Locate changes the area and camera without overriding disabled layer intent', async () => {
  const u = await fixture();
  const display = u.node('header-tools').children.find(child => child.id === 'compatible-display');
  assert.ok(display); assert.equal(display.getAttribute('aria-pressed'), 'false');
  assert.equal(u.createdElements.some(element => element.tagName === 'CANVAS'), false, 'Default startup creates no replacement framebuffer');
  u.locate(); u.f.geo.resolve({ lat: 51, lon: 5, radiusKm: 10 }); await u.flush();
  assert.equal(u.f.area.radiusKm, 10); assert.equal(u.f.cameraWrites.at(-1).lat, 51);
  assert.equal(u.f.layerRestores.length, 1, 'Locate must not apply another layer preset');
  assert.equal(u.f.manager.getState().flights.enabled, false);
  assert.match(u.f.calls.at(-1), /^notice:Local data is loading/);
  await u.context.application.destroy();
  assert.equal(u.node('header-tools').children.includes(display), false, 'Main disposal removes its optional display control');
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

test('early search readiness follows the initial camera and navigation handlers without waiting for layer restoration or invoking automatic location', async () => {
  const restorationGate = Promise.withResolvers(); let ready = 0, cleaned = 0, finished = false;
  const u = await fixture({ automatic: true, restorationGate, intentFactory: f => ({
    ready() { ready++; assert.equal(f.cameraWrites.length, 1); assert.equal(typeof f.navigation.onPlace, 'function');
      // An explicit unsupported query is still a submitted user intent, so it
      // must not trigger an unexpected location prompt as a fallback.
      return true; }, destroy() { cleaned++; },
  }) });
  void u.starting.then(() => { finished = true; }); await u.flush();
  assert.equal(ready, 1); assert.equal(finished, false); assert.equal(u.f.geoCalls, 0); assert.equal(u.f.layerRestores.length, 1);
  restorationGate.resolve(); await u.starting; assert.equal(ready, 1); await u.context.application.destroy(); assert.equal(cleaned, 1);
});

test('startup failure disposes pending search without readiness, and hidden readiness cannot start automatic location', async () => {
  let ready = 0, cleaned = 0;
  const failed = await fixture({ startupError: new Error('Fixture renderer failed'), intentFactory: () => ({ ready() { ready++; return true; }, destroy() { cleaned++; } }) });
  await failed.starting; assert.equal(ready, 0); assert.equal(cleaned, 1); assert.equal(failed.node('error').hidden, false);
  assert.match(failed.node('error-message').textContent, /Fixture renderer failed/); assert.equal(failed.f.geoCalls, 0);
  await failed.context.application.destroy(); assert.equal(cleaned, 1);
  const hidden = await fixture({ automatic: true, hidden: true, intentFactory: () => ({ ready() { return false; }, destroy() {} }) });
  assert.equal(hidden.f.geoCalls, 0); assert.equal(hidden.f.viewer.useDefaultRenderLoop, false); await hidden.context.application.destroy();
});

test('real main restores History before enabling layers and preserves exact time on camera/layer/committed edits without writing on ticks', async () => {
  const temporal = { mode: 'history', at: '2025-11-15T12:00:00.123Z', lens: 'known-then', rate: 86400 };
  const modeGate = Promise.withResolvers(), restorationGate = Promise.withResolvers();
  const u = await fixture({ temporal, modeGate, restorationGate });
  assert.equal(u.f.restoreModes.length, 0); assert.equal(u.f.sessionSaves, 0, 'Unapplied startup intent cannot replace the incoming URL');
  assert.equal(u.f.shellOptions.canShare(), false, 'Share cannot sample intermediate restored layer intent');
  u.f.navigation.onViewChange({ lat: 50, lon: 4, alt: 90000 }); u.f.managerSubscriber(); assert.equal(u.f.sessionSaves, 0);
  modeGate.resolve(); await u.flush();
  assert.equal(u.f.restoreModes[0], 'history');
  assert.equal(u.f.shellOptions.canShare(), true, 'Complete requested intent may checkpoint while source delivery is pending');
  u.f.navigation.onViewChange({ lat: 51, lon: 4, alt: 90000 }); u.f.managerSubscriber();
  assert.equal(u.f.sessionSaves, 2); assert.ok(u.f.savedTemporal.every(saved => saved.at === temporal.at && saved.lens === temporal.lens && saved.rate === temporal.rate));
  restorationGate.resolve(); await u.starting; assert.equal(u.f.sessionSaves, 3); assert.equal(u.f.savedTemporal[0].at, temporal.at);
  assert.equal(u.f.shellOptions.canShare(), true); assert.equal(u.f.shellOptions.getTemporal().at, temporal.at);
  assert.equal(u.f.serialized[0].temporal.lens, temporal.lens); assert.equal(u.f.serialized[0].temporal.rate, temporal.rate);
  u.f.temporal = { ...u.f.temporal, at: '2025-11-15T12:00:00.456Z' };
  u.f.navigation.onViewChange({ lat: 51, lon: 4, alt: 90000 }); u.f.managerSubscriber();
  assert.equal(u.f.serialized.at(-1).temporal.at, '2025-11-15T12:00:00.456Z');
  const writes = u.f.sessionSaves; await u.flush(); assert.equal(u.f.sessionSaves, writes, 'No clock subscriber performs persistence');
  u.f.timeOptions.onWorkspaceCommit(); assert.equal(u.f.sessionSaves, writes + 1);
  await u.context.application.destroy(); u.f.timeOptions.onWorkspaceCommit(); assert.equal(u.f.sessionSaves, writes + 1);
  assert.equal(u.f.shellOptions.canShare(), false);
});

test('actual hashchange ownership rejects stale History→Live→History completion and terminal callbacks cannot restore again', async () => {
  const first = { mode: 'history', at: '2025-11-15T12:00:00.123Z', lens: 'known-then', rate: 86400 }, restorationGate = Promise.withResolvers();
  const u = await fixture({ temporal: first, restorationGate });
  u.f.initial = { ...u.f.initial, view: { lat: 20, lon: 4, alt: 90000 }, temporal: { mode: 'live' }, layers: [] };
  u.context.location.hash = '#v=3&lat=20&layers='; u.window.dispatchEvent(new Event('hashchange')); await u.flush();
  const latest = { ...first, at: '2025-11-16T12:00:00.456Z', lens: 'reconstruction', rate: 60 };
  u.f.initial = { ...u.f.initial, view: { lat: 30, lon: 4, alt: 90000 }, temporal: latest };
  u.context.location.hash = '#v=4&mode=history&at=2025-11-16T12%3A00%3A00.456Z&lens=reconstruction&rate=60';
  u.window.dispatchEvent(new Event('hashchange')); await u.flush(); assert.equal(u.f.sessionSaves, 0);
  restorationGate.resolve(); await u.starting; await u.flush();
  assert.equal(u.f.sessionSaves, 1); assert.equal(u.f.savedTemporal[0].at, latest.at); assert.equal(u.f.savedTemporal[0].lens, latest.lens);
  assert.equal(u.f.cameraWrites.at(-1).lat, 30); assert.equal(u.f.temporal.playing, false);
  const restores = u.f.layerRestores.length, writes = u.f.sessionSaves;
  await u.context.application.destroy(); u.window.dispatchEvent(new Event('hashchange')); await u.flush();
  assert.equal(u.f.layerRestores.length, restores); assert.equal(u.f.sessionSaves, writes);
});

test('a newer explicit timeline intent owns the scene before an old mode barrier resolves or rejects', async () => {
  for (const reject of [false, true]) {
    const modeGate = Promise.withResolvers(), old = { mode: 'history', at: '2025-11-15T12:00:00.123Z', lens: 'known-then', rate: 86400 };
    const u = await fixture({ temporal: old, modeGate }); assert.equal(u.f.timelineRestores.length, 0);
    u.f.timeOptions.onWorkspaceIntent({ reason: 'seek' });
    const chosen = { ...old, at: '2025-11-16T12:00:00.456Z', lens: 'reconstruction' }; u.f.temporal = chosen;
    u.f.timeOptions.onWorkspaceCommit();
    if (reject) modeGate.reject(new Error('Obsolete disable failed')); else modeGate.resolve();
    await u.starting; assert.equal(u.f.timelineRestores.length, 0); assert.equal(u.f.temporal.at, chosen.at);
    assert.equal(u.f.viewerDestroyed, false); assert.equal(u.node('error').hidden, true); assert.equal(u.f.savedTemporal.at(-1).at, chosen.at);
    await u.context.application.destroy();
  }
});

test('invalid temporal startup exposes explicit Live recovery without initializing facts or deleting saved preferences', async () => {
  const error = new Error('Future History is unavailable. Choose an earlier UTC or Live.'); error.code = 'EARTH_WORKSPACE_INVALID';
  const u = await fixture({ initialError: error }); await u.starting;
  assert.equal(u.f.cameraWrites.length, 0); assert.equal(u.f.layerRestores.length, 0); assert.equal(u.f.timelineRestores.length, 0);
  assert.equal(u.node('#error h2').textContent, 'Workspace could not restore');
  const recover = u.node('error').children.find(child => child.id === 'recover-live-workspace'); assert.equal(recover.textContent, 'Return to Live');
  assert.equal(u.f.replaced.length, 0); recover.dispatchEvent(new Event('click'));
  assert.equal(u.f.serialized.at(-1).temporal.mode, 'live'); assert.equal(u.f.replaced.length, 1); assert.equal(u.f.calls.at(-1), 'reload');
  assert.equal(u.f.preferenceRemovals, 0); recover.dispatchEvent(new Event('click')); assert.equal(u.f.replaced.length, 1);
});
