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
  let drawings = 0;
  const creditContainer = { textContent: 'Natural Earth', append(node) { credits.push(node); } };
  const nodes = { 'scene-preview': preview, 'scene-preview-image': image, credits: creditContainer };
  const document = {
    getElementById: (id) => nodes[id],
    querySelectorAll: () => [...credits],
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
  const install = (state = {}) => module.installScenePreview(viewer, { store, cameraView: () => view, getState: () => state });
  return { ...module, viewer, preview, image, credits, pointer, record, store, writes, install, drawings: () => drawings };
}

test('the first partial live frame replaces the saved overlay without saving incomplete tiles', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store);
  assert.equal(f.preview.hidden, false);
  assert.equal(f.credits.length, 1);
  f.image.onload();
  const dispose = f.install();
  f.viewer.scene.postRender.raise();
  assert.equal(f.preview.hidden, true);
  assert.equal(f.credits.length, 0);
  assert.equal(f.drawings(), 0);
  assert.equal(f.writes.length, 0);
  f.viewer.scene.globe.tilesLoaded = true;
  f.viewer.scene.postRender.raise();
  assert.equal(f.drawings(), 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].key, 'scene-preview');
  assert.equal(f.writes[0].value.fingerprint, fingerprint);
  assert.equal(f.writes[0].value.basemap, 'map');
  dispose();
});

test('camera movement reveals the live view before all imagery completes and teardown removes listeners', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store); f.image.onload();
  const dispose = f.install();
  f.viewer.camera.moveStart.raise();
  assert.equal(f.preview.hidden, true);
  assert.equal(f.credits.length, 0);
  assert.equal(f.viewer.scene.globe.tilesLoaded, false);
  dispose();
  assert.equal(f.viewer.camera.moveStart.size, 0);
  assert.equal(f.viewer.camera.moveEnd.size, 0);
  assert.equal(f.viewer.scene.postRender.size, 0);
  assert.equal(f.pointer.size, 0);
});

test('a slow saved-image read cannot cover a frame that has already rendered', async (t) => {
  const f = await fixture(t);
  let finishRead;
  const showing = f.showSavedScene({ get: () => new Promise((resolve) => { finishRead = resolve; }) });
  const dispose = f.install();
  f.viewer.scene.postRender.raise();
  finishRead(f.record());
  await showing;
  assert.equal(f.preview.hidden, true);
  assert.equal(f.image.src, undefined);
  assert.equal(f.credits.length, 0);
  dispose();
});

test('an unreadable saved image never leaves an opaque empty preview over startup', async (t) => {
  const f = await fixture(t);
  await f.showSavedScene(f.store);
  assert.equal(f.preview.hidden, false);
  f.image.onerror();
  assert.equal(f.preview.hidden, true);
  assert.equal(f.credits.length, 0);
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
