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
async function fixture(t) {
  const preview = { hidden: true }, image = {}, credits = [];
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
        toBlob(callback) { callback(new Blob(['rendered frame'], { type: 'image/jpeg' })); },
      };
    },
  };
  const globals = {
    document,
    location: { hash: `#${new URLSearchParams(view)}` },
    localStorage: { getItem: () => null },
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
  const record = () => ({ at: Date.now(), blob: new Blob(['saved frame']), basemap: 'map', fingerprint, credits: 'Saved attribution' });
  const writes = [], store = { get: async () => record(), put: async (key, value) => writes.push({ key, value }) };
  const module = await import(`./scene-preview.js?test=${++moduleId}`);
  const install = (state = {}) => module.installScenePreview(viewer, { store, cameraView: () => view, getState: () => state, setTimeoutImpl, clearTimeoutImpl });
  return { ...module, viewer, preview, image, credits, pointer, input, timers, advance, record, store, writes, install, drawings: () => drawings };
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
