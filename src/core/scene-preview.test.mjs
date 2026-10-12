import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
const view = { lat: 50, lon: 4, alt: 20000, heading: 0, pitch: -90, roll: 0 };
const fingerprint = '50:4:20000:0:-90:0';
function event() {
  const listeners = new Set();
  return {
    addEventListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    raise() { for (const listener of [...listeners]) listener(); },
    get size() { return listeners.size; },
  };
}
async function fixture(t, { deferredBlob = false } = {}) {
  const caption = { setAttribute(name, value) { this[name] = value; } };
  const preview = { hidden: true, querySelector: () => caption }, image = {}, credits = [], stored = new Map(), blobCallbacks = [];
  const input = new Map(), timers = new Map(); let clock = 0, nextTimer = 0;
  const setTimeoutImpl = (fn, ms) => { timers.set(++nextTimer, { fn, at: clock + ms }); return nextTimer; };
  const clearTimeoutImpl = (id) => timers.delete(id);
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.delete(id)) timer.fn();
  };
  let drawings = 0;
  const creditContainer = { textContent: 'Natural Earth', append(node) { credits.push(node); } };
  const nodes = { 'scene-preview': preview, 'scene-preview-image': image, credits: creditContainer };
  const document = {
    getElementById: (id) => nodes[id],
    querySelectorAll: () => [...credits],
    addEventListener: (name, listener) => input.set(name, listener),
    removeEventListener: (name, listener) => { if (input.get(name) === listener) input.delete(name); },
    createElement(tag) {
      if (tag === 'small') return { remove() { const i = credits.indexOf(this); if (i >= 0) credits.splice(i, 1); } };
      assert.equal(tag, 'canvas');
      return {
        getContext: () => ({ drawImage() { drawings++; } }),
        toBlob(callback) { if (deferredBlob) blobCallbacks.push(callback); else callback(new Blob(['rendered frame'], { type: 'image/jpeg' })); },
      };
    },
  };
  const globals = {
    document,
    location: { hash: `#${new URLSearchParams(view)}` },
    localStorage: { getItem: key => stored.get(key) || null },
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  const pointer = new Map();
  const viewer = {
    camera: { moveStart: event(), moveEnd: event() },
    scene: { postRender: event(), globe: { tilesLoaded: false } },
    canvas: { width: 1280, height: 800,
      addEventListener: (name, listener) => pointer.set(name, listener),
      removeEventListener: (name, listener) => { if (pointer.get(name) === listener) pointer.delete(name); },
    },
    earthBasemap: { getState: () => ({ mode: 'map' }) },
  };
  const record = () => ({ schemaVersion: 2, scope: { temporal: { mode: 'live' }, layers: [], layerParams: {} },
    at: Date.now(), blob: new Blob(['saved frame']), basemap: 'map', fingerprint, credits: 'Saved attribution' });
  const writes = [], store = { get: async () => record(), put: async (key, value) => writes.push({ key, value }) };
  const module = await import(`./scene-preview.js?test=${++moduleId}`);
  const install = (state = {}, parameters = {}) => module.installScenePreview(viewer, { store, cameraView: () => view, getState: () => state,
    getLayerParams: id => parameters[id] || {}, setTimeoutImpl, clearTimeoutImpl });
  return { ...module, viewer, preview, image, caption, credits, stored, blobCallbacks, pointer, input, timers, advance, record, store, writes, install, drawings: () => drawings };
}

test('pending first-frame tiles keep the labeled saved overlay until a settled frame without saving incomplete tiles', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store);
  assert.equal(f.preview.hidden, false);
  assert.equal(f.credits.length, 1);
  f.image.onload();
  const dispose = f.install();
  f.viewer.scene.postRender.raise();
  assert.equal(f.preview.hidden, false);
  assert.equal(f.credits.length, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.drawings(), 0);
  assert.equal(f.writes.length, 0);
  f.viewer.scene.globe.tilesLoaded = true;
  f.viewer.scene.postRender.raise();
  assert.equal(f.preview.hidden, true);
  assert.equal(f.credits.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.drawings(), 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].key, 'scene-preview');
  assert.equal(f.writes[0].value.fingerprint, fingerprint);
  assert.equal(f.writes[0].value.basemap, 'map');
  dispose();
});

test('the first-frame deadline reveals incomplete coverage after 2500 ms without being extended by later frames', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store); f.image.onload();
  const dispose = f.install();
  f.viewer.scene.postRender.raise();
  f.advance(2000); f.viewer.scene.postRender.raise();
  f.advance(499);
  assert.equal(f.preview.hidden, false); assert.equal(f.credits.length, 1);
  f.advance(1);
  assert.equal(f.preview.hidden, true); assert.equal(f.credits.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.viewer.scene.globe.tilesLoaded, false); assert.equal(f.drawings(), 0); assert.equal(f.writes.length, 0);
  f.viewer.scene.postRender.raise(); assert.equal(f.timers.size, 0);
  dispose();
});

for (const name of ['pointerdown', 'wheel', 'keydown']) test(`${name} anywhere clears the pending saved preview and its deadline immediately`, async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store); f.image.onload();
  const dispose = f.install(); f.viewer.scene.postRender.raise();
  assert.equal(f.preview.hidden, false); assert.equal(f.timers.size, 1);
  f.input.get(name)();
  assert.equal(f.preview.hidden, true); assert.equal(f.credits.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.drawings(), 0);
  dispose(); assert.equal(f.input.size, 0);
});

test('teardown clears a pending deadline and late callbacks cannot restore the preview', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store); f.image.onload();
  const dispose = f.install(); f.viewer.scene.postRender.raise();
  const queued = [...f.timers.values()][0].fn;
  dispose();
  assert.equal(f.timers.size, 0); assert.equal(f.preview.hidden, true); assert.equal(f.credits.length, 0);
  assert.equal(f.viewer.scene.postRender.size, 0); assert.equal(f.input.size, 0);
  queued(); await f.showSavedScene(f.store);
  assert.equal(f.preview.hidden, true); assert.equal(f.credits.length, 0); assert.equal(f.writes.length, 0);
});

test('camera movement reveals the live view before all imagery completes and teardown removes listeners', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store); f.image.onload();
  const dispose = f.install();
  f.viewer.scene.postRender.raise(); assert.equal(f.timers.size, 1);
  f.viewer.camera.moveStart.raise();
  assert.equal(f.preview.hidden, true);
  assert.equal(f.credits.length, 0);
  assert.equal(f.viewer.scene.globe.tilesLoaded, false);
  assert.equal(f.timers.size, 0);
  dispose();
  assert.equal(f.viewer.camera.moveStart.size, 0);
  assert.equal(f.viewer.camera.moveEnd.size, 0);
  assert.equal(f.viewer.scene.postRender.size, 0);
  assert.equal(f.pointer.size, 0);
  assert.equal(f.input.size, 0);
});

test('a slow saved-image read cannot cover a frame that has already rendered', async (t) => {
  const f = await fixture(t);
  let finishRead;
  const showing = f.showSavedScene({ get: () => new Promise((resolve) => { finishRead = resolve; }) });
  const dispose = f.install();
  f.viewer.scene.globe.tilesLoaded = true;
  f.viewer.scene.postRender.raise();
  finishRead(f.record());
  await showing;
  assert.equal(f.preview.hidden, true);
  assert.equal(f.image.src, undefined);
  assert.equal(f.credits.length, 0);
  dispose();
});

test('a delayed saved-image read cannot appear after the pending-tile deadline', async (t) => {
  const f = await fixture(t); let finishRead;
  const showing = f.showSavedScene({ get: () => new Promise((resolve) => { finishRead = resolve; }) });
  const dispose = f.install(); f.viewer.scene.postRender.raise(); f.advance(2500);
  finishRead(f.record()); await showing;
  assert.equal(f.preview.hidden, true); assert.equal(f.image.src, undefined); assert.equal(f.credits.length, 0);
  dispose();
});

test('an unreadable saved image never leaves an opaque empty preview over startup', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store);
  const dispose = f.install(); f.viewer.scene.postRender.raise();
  assert.equal(f.preview.hidden, false);
  f.image.onerror();
  assert.equal(f.preview.hidden, true);
  assert.equal(f.credits.length, 0);
  dispose(); assert.equal(f.timers.size, 0);
});

test('registered notices still prevent flattening complex layers into saved images', async (t) => {
  const f = await fixture(t);
  for (const id of ['wind', 'cctv', 'transit']) {
    const dispose = f.install({ [id]: { enabled: true } });
    f.viewer.scene.globe.tilesLoaded = true;
    f.viewer.scene.postRender.raise();
    assert.equal(f.drawings(), 0);
    assert.equal(f.writes.length, 0);
    dispose();
  }
});

test('recorded-time rendering cannot replace the startup Live scene preview', async (t) => {
  const f = await fixture(t), dispose = f.install({ timelinePaused: true });
  f.viewer.scene.globe.tilesLoaded = true; f.viewer.scene.postRender.raise();
  assert.equal(f.drawings(), 0); assert.equal(f.writes.length, 0);
  dispose();
});

test('a saved Live frame never stands in for requested or remembered History, or an unscoped legacy frame', async (t) => {
  const f = await fixture(t), saved = f.record();
  const history = { mode: 'history', at: '2025-10-12T12:34:56.789Z', lens: 'known-then', rate: 3600 };
  const historyHash = new URLSearchParams({ v: '4', ...view, ...history, layers: '' });
  location.hash = `#${historyHash}`;
  await f.showSavedScene({ get: async () => saved }); assert.equal(f.image.src, undefined);
  location.hash = '';
  f.stored.set('earth-observer:workspace:v2', JSON.stringify({ version: 3, view, temporal: history }));
  await f.showSavedScene({ get: async () => saved }); assert.equal(f.image.src, undefined);
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: '' })}`;
  await f.showSavedScene({ get: async () => ({ ...saved, schemaVersion: undefined, scope: undefined }) });
  assert.equal(f.image.src, undefined); assert.equal(f.credits.length, 0);
  await f.showSavedScene({ get: async () => saved }); assert.equal(f.preview.hidden, false);
  assert.match(f.caption.textContent, /^Saved · \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  assert.equal(f.caption['aria-label'], `Saved Live view captured ${new Date(saved.at).toISOString()}`); f.image.onload();
});

test('enabled layer membership and canonical parameters must match, regardless of order', async (t) => {
  const f = await fixture(t), saved = { ...f.record(), scope: { temporal: { mode: 'live' }, layers: ['earthquakes', 'satellites'],
    layerParams: { earthquakes: {}, satellites: { catalog: 'curated', display: { labels: true, size: 2 } } } } };
  const hash = (layers, params) => `#${new URLSearchParams({ v: '4', ...view, layers, params: JSON.stringify(params) })}`;
  for (const [layers, params] of [['earthquakes', {}], ['satellites,earthquakes', { satellites: { catalog: 'all', display: { labels: true, size: 2 } } }]]) {
    location.hash = hash(layers, params); await f.showSavedScene({ get: async () => saved }); assert.equal(f.image.src, undefined);
  }
  location.hash = hash('satellites,earthquakes', { satellites: { display: { size: 2, labels: true }, catalog: 'curated' } });
  await f.showSavedScene({ get: async () => saved }); assert.equal(f.preview.hidden, false); f.image.onload();
});

test('saved layer preferences apply only when the hash does not explicitly choose a layer set', async (t) => {
  const f = await fixture(t), saved = { ...f.record(), scope: { temporal: { mode: 'live' }, layers: ['satellites'], layerParams: { satellites: { catalog: 'curated' } } } };
  f.stored.set('earth-observer:workspace:v2', JSON.stringify({ version: 3, view, temporal: { mode: 'live' } }));
  f.stored.set('earth-observer:layers:v1', JSON.stringify({ version: 1, layers: { satellites: { enabled: true, params: { catalog: 'curated' } }, earthquakes: { enabled: false, params: {} } } }));
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: '' })}`;
  await f.showSavedScene({ get: async () => saved }); assert.equal(f.image.src, undefined);
  location.hash = ''; await f.showSavedScene({ get: async () => saved }); assert.equal(f.preview.hidden, false); f.image.onload();
});

test('frame encoding retains the frame capture time and rejects a later temporal or layer change', async (t) => {
  const f = await fixture(t, { deferredBlob: true }), now = Date.now;
  let clock = now(); Date.now = () => clock; t.after(() => { Date.now = now; });
  const state = { earthquakes: { enabled: true, settledEnabled: true, status: 'ready', sceneMode: 'live' } };
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: 'earthquakes' })}`;
  const dispose = f.install(state); f.viewer.scene.globe.tilesLoaded = true; f.viewer.scene.postRender.raise();
  const capturedAt = clock; clock += 5000;
  await f.blobCallbacks.shift()(new Blob(['frame']));
  assert.equal(f.writes[0].value.at, capturedAt); assert.deepEqual(f.writes[0].value.scope.layers, ['earthquakes']);
  clock += 10001; f.viewer.camera.moveEnd.raise(); f.viewer.scene.postRender.raise();
  state.timelinePaused = true; await f.blobCallbacks.shift()(new Blob(['old frame'])); assert.equal(f.writes.length, 1);
  state.timelinePaused = false; clock += 10001; f.viewer.camera.moveEnd.raise(); f.viewer.scene.postRender.raise();
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: '' })}`;
  await f.blobCallbacks.shift()(new Blob(['old layers'])); assert.equal(f.writes.length, 1);
  dispose();
});

test('malformed scopes and pending enabled layers skip optional capture without interrupting rendering', async (t) => {
  const f = await fixture(t), state = { earthquakes: { enabled: true, settledEnabled: false, status: 'loading', sceneMode: 'live' } };
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: 'earthquakes' })}`;
  const dispose = f.install(state); f.viewer.scene.globe.tilesLoaded = true; f.viewer.scene.postRender.raise();
  assert.equal(f.drawings(), 0);
  Object.assign(state.earthquakes, { settledEnabled: true, status: 'ready' }); location.hash += '&params=invalid';
  assert.doesNotThrow(() => f.viewer.scene.postRender.raise()); assert.equal(f.writes.length, 0);
  await f.showSavedScene({ get: async () => f.record() }); assert.equal(f.image.src, undefined);
  dispose();
});

test('actual renderer parameters fence a delayed frame even before the workspace URL changes', async (t) => {
  const f = await fixture(t, { deferredBlob: true });
  const state = { satellites: { enabled: true, settledEnabled: true, status: 'ready', sceneMode: 'live' } }, parameters = { satellites: { catalog: 'curated' } };
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: 'satellites', params: JSON.stringify(parameters) })}`;
  const dispose = f.install(state, parameters); f.viewer.scene.globe.tilesLoaded = true; f.viewer.scene.postRender.raise();
  assert.equal(f.blobCallbacks.length, 1);
  parameters.satellites.catalog = 'all';
  await f.blobCallbacks.shift()(new Blob(['old parameters']));
  assert.equal(f.writes.length, 0); dispose();
});

test('unknown actual layer parameters and omitted defaults never produce a claimed matching preview', async (t) => {
  const f = await fixture(t), state = { satellites: { enabled: true, settledEnabled: true, status: 'ready', sceneMode: 'live' } };
  location.hash = `#${new URLSearchParams({ v: '4', ...view, layers: 'satellites' })}`;
  const missing = f.installScenePreview(f.viewer, { store: f.store, cameraView: () => view, getState: () => state });
  f.viewer.scene.globe.tilesLoaded = true; f.viewer.scene.postRender.raise(); assert.equal(f.drawings(), 0); missing();
  const omitted = f.install(state, { satellites: { catalog: 'curated' } }); f.viewer.scene.postRender.raise();
  assert.equal(f.drawings(), 0); assert.equal(f.writes.length, 0); omitted();
});
