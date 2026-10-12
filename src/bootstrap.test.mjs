import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ENGINE_LOAD_TIMEOUT_MS, loadEngineScript } from './bootstrap-engine.js';

function scriptFixture({ appendError } = {}) {
  let clock = 0, nextId = 0;
  const timers = new Map(), scripts = [];
  const setTimeoutImpl = (fn, delay) => { timers.set(++nextId, { fn, at: clock + delay, delay }); return nextId; };
  const clearTimeoutImpl = (id) => timers.delete(id);
  const document = {
    createElement(tag) {
      assert.equal(tag, 'script');
      const listeners = new Map(), captured = new Map();
      return { listeners, captured, removed: false,
        addEventListener(name, fn) { listeners.set(name, fn); captured.set(name, fn); },
        removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
        remove() { this.removed = true; }, emit(name) { listeners.get(name)?.(); } };
    },
    head: { append(script) { scripts.push(script); if (appendError) throw appendError; } },
  };
  const advance = (ms) => {
    clock += ms;
    for (const [id, value] of [...timers]) if (value.at <= clock && timers.delete(id)) value.fn();
  };
  return { document, scripts, timers, advance, setTimeoutImpl, clearTimeoutImpl };
}

test('slow engine loading can complete just before the practical deadline and cleans owned listeners/timer', async () => {
  const f = scriptFixture();
  const loading = loadEngineScript({ ...f, src: 'https://example.com/earth/cesium/1.138.0/Cesium.js' });
  const engine = f.scripts[0]; let settled = false;
  void loading.then(() => { settled = true; });
  assert.equal(ENGINE_LOAD_TIMEOUT_MS, 15000); assert.equal(engine.async, true);
  assert.equal(engine.src, 'https://example.com/earth/cesium/1.138.0/Cesium.js');
  f.advance(14999); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.timers.size, 1);
  engine.emit('load'); assert.equal(await loading, engine);
  assert.equal(engine.removed, false); assert.equal(engine.listeners.size, 0); assert.equal(f.timers.size, 0);
  engine.captured.get('error')(); f.advance(1);
  assert.equal(engine.removed, false);
});

test('a stalled engine removes its script and late load/error cannot settle it again', async () => {
  const f = scriptFixture();
  const loading = loadEngineScript({ ...f, src: '/earth/cesium/1.138.0/Cesium.js' });
  const rejected = assert.rejects(loading, /took too long.*reload/i);
  f.advance(15000); await rejected;
  const engine = f.scripts[0];
  assert.equal(engine.removed, true); assert.equal(engine.listeners.size, 0); assert.equal(f.timers.size, 0);
  engine.captured.get('load')(); engine.captured.get('error')();
  await assert.rejects(loading, /took too long/);
});

test('download and append failures remove owned script/listeners and leave no waiting deadline', async () => {
  const failed = scriptFixture();
  const loading = loadEngineScript({ ...failed, src: '/earth/cesium/1.138.0/Cesium.js' });
  const rejected = assert.rejects(loading, /could not download.*Reload/);
  failed.scripts[0].emit('error'); await rejected;
  assert.equal(failed.timers.size, 0); assert.equal(failed.scripts[0].listeners.size, 0); assert.equal(failed.scripts[0].removed, true);
  const blocked = scriptFixture({ appendError: new Error('Script insertion blocked') });
  await assert.rejects(loadEngineScript({ ...blocked, src: '/earth/cesium/1.138.0/Cesium.js' }), /insertion blocked/);
  assert.equal(blocked.timers.size, 0); assert.equal(blocked.scripts[0].listeners.size, 0); assert.equal(blocked.scripts[0].removed, true);
});

// Execute the actual production bootstrap, replacing only its optional image read
// and downstream application entry. The loader and catch/retry path are unmodified.
const bootstrapBundle = build({
  entryPoints: [fileURLToPath(new URL('./bootstrap.js', import.meta.url))], bundle: true, write: false,
  format: 'iife', platform: 'browser', define: { 'import.meta.env': '{"PROD":true,"BASE_URL":"/earth/"}' },
  plugins: [{ name: 'bootstrap-downstream-fixtures', setup(plugin) {
    plugin.onResolve({ filter: /^\.\/core\/scene-preview\.js$/ }, () => ({ path: 'preview', namespace: 'fixture' }));
    plugin.onResolve({ filter: /^\.\/main\.js$/ }, () => ({ path: 'main', namespace: 'fixture' }));
    plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'preview'
      ? 'export function showSavedScene(){globalThis.previewCalls++; return Promise.resolve();}'
      : `export function start({earlySearchIntent}={}){globalThis.mainCalls++;
          const form=document.getElementById('search-form'), button=form?.querySelector('button[type="submit"]');
          if(form){form.addEventListener('submit',event=>{event.preventDefault();globalThis.searchSubmissions.push(document.getElementById('search').value);});button.disabled=false;}
          earlySearchIntent?.ready();return Promise.resolve();}`, loader: 'js' }));
  } }],
}).then((result) => result.outputFiles[0].text);

async function productionFixture({ alreadyLoaded = false, releaseUpdates = false } = {}) {
  const f = scriptFixture(), workerListeners = new Map(), sent = [], logs = [];
  let reloads = 0;
  const retryListeners = new Map();
  const registrations = [], workerGate = Promise.withResolvers();
  const nodes = { loading: { hidden: false }, error: { hidden: true }, 'error-message': {}, notification: { hidden: true },
    reload: { addEventListener(name, fn, options) { retryListeners.set(name, { fn, once: options?.once }); } } };
  nodes.search = new EventTarget(); nodes.search.value = ''; nodes.search.ownerDocument = f.document;
  nodes['search-status'] = { textContent: '' };
  const searchButton = { disabled: true }, searchForm = new EventTarget();
  searchForm.querySelector = () => searchButton;
  searchForm.requestSubmit = () => searchForm.dispatchEvent(new Event('submit', { cancelable: true }));
  nodes['search-form'] = searchForm;
  const label = { textContent: '' };
  f.document.getElementById = (id) => nodes[id];
  f.document.querySelector = (selector) => selector === 'link[data-globe-engine]' ? { href: '/earth/cesium/1.138.0/Cesium.js' } : label;
  const context = { document: f.document,
    navigator: { serviceWorker: { addEventListener: (name, fn) => workerListeners.set(name, fn),
      ...(releaseUpdates ? { register(url, options) { registrations.push({ url, options }); return workerGate.promise; } } : {}),
      controller: { scriptURL: 'https://example.com/earth/sw.js', postMessage: (message) => sent.push(message) } } },
    setTimeout: f.setTimeoutImpl, clearTimeout: f.clearTimeoutImpl,
    location: { origin: 'https://example.com', href: 'https://example.com/earth/', pathname: '/earth/', reload() { reloads++; } }, console: { error: (...args) => logs.push(args) }, previewCalls: 0, mainCalls: 0, searchSubmissions: [],
    ...(alreadyLoaded ? { Cesium: {} } : {}) };
  vm.runInNewContext(await bootstrapBundle, context);
  const flush = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };
  const retry = () => { const listener = retryListeners.get('click'); if (!listener) return; if (listener.once) retryListeners.delete('click'); listener.fn(); };
  return { ...f, nodes, label, context, flush, retry, reloads: () => reloads, logs, workerListeners, sent, registrations, workerGate };
}

test('the production bootstrap exposes retry after timeout and never imports main after late events', async () => {
  const f = await productionFixture();
  assert.equal(f.context.previewCalls, 1); assert.equal(f.context.mainCalls, 0);
  assert.equal(f.label.textContent, 'Loading the 3D engine…');
  f.advance(15000); await f.flush();
  assert.equal(f.nodes.loading.hidden, true); assert.equal(f.nodes.error.hidden, false);
  assert.match(f.nodes['error-message'].textContent, /took too long.*reload/i);
  assert.equal(f.context.mainCalls, 0); assert.equal(f.logs.length, 1);
  f.scripts[0].captured.get('load')(); f.scripts[0].captured.get('error')(); await f.flush();
  assert.equal(f.context.mainCalls, 0); assert.equal(f.logs.length, 1);
  f.retry(); assert.equal(f.reloads(), 1); f.retry(); assert.equal(f.reloads(), 1);
});

test('production success imports main once and retains the existing offline status handshake and notices', async () => {
  const f = await productionFixture();
  assert.equal(f.sent[0].type, 'earth-observer:shell-status');
  f.workerListeners.get('message')({ data: { type: 'earth-observer:shell-status', message: 'Saved app loaded offline.' } });
  assert.equal(f.nodes.notification.hidden, false); assert.equal(f.nodes.notification.textContent, 'Saved app loaded offline.');
  f.advance(14999); await f.flush(); assert.equal(f.context.mainCalls, 0);
  f.scripts[0].emit('load'); await f.flush();
  assert.equal(f.context.mainCalls, 1); assert.equal(f.label.textContent, 'Opening the globe…'); assert.equal(f.nodes.error.hidden, true);
  assert.equal(f.timers.size, 0); assert.equal(f.scripts[0].listeners.size, 0);
  f.advance(1); f.scripts[0].captured.get('load')(); await f.flush(); assert.equal(f.context.mainCalls, 1);
});

test('an already available engine preserves startup without adding a script or timeout', async () => {
  const f = await productionFixture({ alreadyLoaded: true }); await f.flush();
  assert.equal(f.context.mainCalls, 1); assert.equal(f.context.previewCalls, 1);
  assert.equal(f.scripts.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.nodes.error.hidden, true);
});

test('production starts its worker release check before the engine finishes, and a stalled check cannot delay the globe', async () => {
  const f = await productionFixture({ releaseUpdates: true });
  assert.equal(f.registrations.length, 1); assert.equal(f.registrations[0].url, '/earth/sw.js'); assert.equal(f.registrations[0].options.updateViaCache, 'none');
  assert.equal(f.context.mainCalls, 0); f.scripts[0].emit('load'); await f.flush();
  assert.equal(f.context.mainCalls, 1); assert.equal(f.nodes.error.hidden, true);
  f.workerGate.reject(new Error('Update connection unavailable')); await f.flush(); assert.equal(f.context.mainCalls, 1); assert.equal(f.nodes.error.hidden, true);
});

test('production captures early Enter and transfers it once to explicit startup; an engine failure discards the pending action', async () => {
  const enter = input => { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Enter' }); input.dispatchEvent(event); return event; };
  const f = await productionFixture(); f.nodes.search.value = 'Brussels';
  assert.equal(enter(f.nodes.search).defaultPrevented, true);
  assert.match(f.nodes['search-status'].textContent, /queued/); assert.equal(f.context.mainCalls, 0);
  assert.equal(f.context.searchSubmissions.length, 0);
  f.scripts[0].emit('load'); await f.flush();
  assert.equal(f.context.mainCalls, 1); assert.deepEqual([...f.context.searchSubmissions], ['Brussels']);
  assert.equal(f.nodes['search-status'].textContent, '');
  f.scripts[0].captured.get('load')(); await f.flush(); assert.equal(f.context.searchSubmissions.length, 1);
  const failed = await productionFixture(); failed.nodes.search.value = '51, 3'; enter(failed.nodes.search);
  failed.scripts[0].emit('error'); await failed.flush();
  assert.equal(failed.nodes['search-status'].textContent, ''); assert.equal(failed.context.mainCalls, 0);
  failed.scripts[0].captured.get('load')(); await failed.flush(); assert.equal(failed.context.searchSubmissions.length, 0);
});
