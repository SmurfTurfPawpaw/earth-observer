import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWorkspaceFocus, createPlaceNavigation } from './workspace-focus.js';
import { createSceneClock } from './scene-clock.js';
import { installNavigation, setCameraView, cameraView, HOME_VIEW } from './navigation.js';
import { createPlaceStore } from './places.js';

class Calendar extends EventTarget {
  #open = false; #queued = false;
  get open() { return this.#open; }
  set open(value) { const next = Boolean(value); if (next === this.#open) return; this.#open = next;
    if (!this.#queued) { this.#queued = true; queueMicrotask(() => { this.#queued = false; this.dispatchEvent(new Event('toggle')); }); } }
}
function workspace() {
  let mono = 0, id = 0; const timers = new Map(), calendar = new Calendar(), listeners = new Set(), calls = [];
  const clock = createSceneClock({ now: () => Date.parse('2026-10-12T00:00:00.000Z'), monotonicNow: () => mono,
    documentRef: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: mono + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); } });
  clock.seek('2025-10-08T00:00:00.000Z'); clock.setRate(60); clock.play();
  const selectedEntity = { id: 'source-pin' }, pins = new Set([selectedEntity]), draft = { title: 'Unsubmitted observation', note: 'Keep this draft', attachment: new Uint8Array([1, 2]) };
  let panel = null, sidebar = false, external = false, externalCloses = 0;
  const emit = (name, open) => { calls.push([name, open]); for (const listener of listeners) listener({ panel: name, open }); };
  const closeExpandedWorkspace = () => { if (panel) { const previous = panel; panel = null; emit(previous, false); } sidebar = false; };
  const focus = createWorkspaceFocus({ calendar, subscribePanels(listener) { listeners.add(listener); return () => listeners.delete(listener); }, closeExpandedWorkspace,
    closeExternalWorkspace() { if (external) externalCloses++; external = false; } });
  return { calendar, focus, clock, timers, selectedEntity, pins, draft, calls, listeners,
    getPanel: () => panel, getSidebar: () => sidebar,
    getExternal: () => external, externalCloses: () => externalCloses,
    openExternal() { external = true; focus.focusExternalWorkspace(); },
    openPanel(name) { if (panel) emit(panel, false); panel = name; emit(name, true); },
    openSidebar() { sidebar = true; focus.focusWorkspace(); },
    advance(ms) { mono += ms; for (const [key, timer] of [...timers]) if (timer.at <= mono && timers.delete(key)) timer.fn(); },
    destroy() { focus.destroy(); clock.destroy(); } };
}

test('calendar and each existing dossier alternate visibility while historical playback, pins, selection and hidden drafts continue', async () => {
  const f = workspace(), draft = f.draft, attachment = draft.attachment;
  for (const panel of ['news', 'notebook', 'selection']) {
    f.openPanel(panel); const before = f.clock.getState(); f.calendar.open = true; await Promise.resolve();
    assert.equal(f.getPanel(), null); assert.equal(f.calendar.open, true); assert.deepEqual(f.clock.getState(), before);
    assert.equal(f.clock.getState().playing, true); assert.equal(f.timers.size, 1); assert.equal(f.pins.has(f.selectedEntity), true);
    f.advance(1000); assert.equal(Date.parse(f.clock.getState().at), Date.parse(before.at) + 60000);
    const at = f.clock.getState().at; f.openPanel(panel); assert.equal(f.calendar.open, false); await Promise.resolve();
    assert.equal(f.getPanel(), panel); assert.equal(f.clock.getState().at, at); assert.equal(f.clock.getState().playing, true);
  }
  assert.equal(f.draft, draft); assert.equal(f.draft.attachment, attachment); assert.equal(f.draft.note, 'Keep this draft');
  assert.ok(f.calls.some(([panel, open]) => panel === 'notebook' && open === false), 'Existing close lifecycle runs instead of destroying the form');
  f.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});

test('external source context shares one surface with calendar and dossiers without changing historical time, pinned evidence or hidden drafts', async () => {
  const f = workspace(), before = f.clock.getState(), draft = f.draft, selected = f.selectedEntity;
  f.openPanel('selection'); f.calendar.open = true; await Promise.resolve(); f.openExternal(); await Promise.resolve();
  assert.equal(f.getExternal(), true); assert.equal(f.getPanel(), null); assert.equal(f.calendar.open, false);
  assert.equal(f.externalCloses(), 0, 'Claiming its own surface does not cancel the new source context');
  assert.deepEqual(f.clock.getState(), before); assert.equal(f.pins.has(selected), true); assert.equal(f.draft, draft);
  f.openPanel('selection'); assert.equal(f.getExternal(), false); assert.equal(f.getPanel(), 'selection'); assert.equal(f.externalCloses(), 1);
  f.openExternal(); f.calendar.open = true; await Promise.resolve();
  assert.equal(f.getExternal(), false); assert.equal(f.calendar.open, true); assert.equal(f.externalCloses(), 2);
  f.openExternal(); f.openSidebar(); assert.equal(f.getExternal(), false); assert.equal(f.getSidebar(), true);
  assert.equal(f.draft.note, 'Keep this draft'); assert.equal(f.clock.getState().playing, true);
  f.openExternal(); f.focus.destroy(); f.openPanel('notebook'); f.calendar.open = true; await Promise.resolve();
  assert.equal(f.getExternal(), true, 'Disposed coordination cannot close another owner'); f.destroy();
});

test('coalesced native detail toggles cannot close a newly opened dossier; sidebar focus and teardown have bounded ownership', async () => {
  const f = workspace(); f.calendar.open = true; f.openPanel('news'); await Promise.resolve();
  assert.equal(f.calendar.open, false); assert.equal(f.getPanel(), 'news', 'A queued toggle reads the current closed state');
  f.calendar.open = true; await Promise.resolve(); f.openSidebar(); assert.equal(f.calendar.open, false); await Promise.resolve();
  assert.equal(f.getSidebar(), true); assert.equal(f.getPanel(), null);
  f.focus.destroy(); f.focus.destroy(); assert.equal(f.listeners.size, 0);
  f.openPanel('selection'); f.calendar.open = true; await Promise.resolve(); assert.equal(f.getPanel(), 'selection', 'Disposed coordination cannot keep hiding another workspace');
  f.destroy();
});

test('opening a dossier while the scene is paused does not seek, resume or remove source features', async () => {
  const f = workspace(); f.clock.pause(); const paused = f.clock.getState(); f.calendar.open = true; await Promise.resolve();
  f.openPanel('selection'); await Promise.resolve(); f.advance(5000);
  assert.deepEqual(f.clock.getState(), paused); assert.equal(f.pins.size, 1); assert.equal(f.calendar.open, false); assert.equal(f.timers.size, 0); f.destroy();
});

test('real search-form input moves the Cesium camera without enabling local layers, asking location permission or replacing scene time; saved camera recall retains its pose', (t) => {
  const globals = ['document', 'window', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let dispose;
  t.after(() => { dispose?.(); for (const [key, previous] of globals) { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; } });
  class Element extends EventTarget {
    constructor() { super(); this.attributes = new Map(); this.value = ''; }
    setAttribute(key, value) { this.attributes.set(key, value); } replaceChildren() {}
    submit() { this.dispatchEvent(new Event('submit', { cancelable: true })); }
  }
  const elements = new Map(), document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement: () => new Element() };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document }); Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  let permissionReads = 0; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get geolocation() { permissionReads++; throw new Error('Search must not request geolocation'); } } });
  const canvas = { clientWidth: 1280, clientHeight: 720 }, scene = { canvas, drawingBufferWidth: 1280, drawingBufferHeight: 720,
    mapProjection: new Cesium.GeographicProjection(), mode: Cesium.SceneMode.SCENE3D, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 }, screenSpaceCameraController: {}, requestRender() {} };
  const camera = new Cesium.Camera(scene); scene.camera = camera; const viewer = { canvas, camera, scene, isDestroyed: () => false };
  camera.flyTo = (options) => { camera.setView(options); camera.moveEnd.raiseEvent(); }; setCameraView(viewer, HOME_VIEW);
  const layers = { earthquakes: true, wind: true, flights: false, cctv: false }, initialLayers = { ...layers };
  let locationRevision = 1, sidebarClosures = 0; const historical = { mode: 'history', at: '2025-10-08T00:00:00.000Z', playing: false }; viewer.earthTime = { getState: () => historical };
  const navigatePlace = createPlaceNavigation({ viewer, cancelLocation() { locationRevision++; }, closeSidebar() { sidebarClosures++; } });
  dispose = installNavigation(viewer, { onPlace: navigatePlace });
  document.getElementById('search').value = 'Brussels'; document.getElementById('search-form').submit();
  assert.ok(Math.abs(cameraView(viewer).lat - 50.8503) < .00001); assert.ok(Math.abs(cameraView(viewer).lon - 4.3517) < .00001);
  assert.ok(Math.abs(cameraView(viewer).alt - 90000) < 1); assert.equal(locationRevision, 2); assert.equal(sidebarClosures, 1);
  assert.deepEqual(layers, initialLayers); assert.equal(viewer.earthTime.getState(), historical); assert.equal(permissionReads, 0);
  document.getElementById('search').value = '51, 3'; document.getElementById('search-form').submit(); assert.ok(Math.abs(cameraView(viewer).lat - 51) < .00001);
  const beforeInvalid = cameraView(viewer); document.getElementById('search').value = '91, 3'; document.getElementById('search-form').submit();
  assert.deepEqual(cameraView(viewer), beforeInvalid); assert.equal(locationRevision, 3); assert.deepEqual(layers, initialLayers);
  const values = new Map(), store = createPlaceStore({ getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }, { createId: () => 'saved-fixture' });
  const saved = store.save('Saved camera', { ...HOME_VIEW, lat: 47, lon: 8, alt: 50000, heading: 35 });
  setCameraView(viewer, store.get(saved.id).view, true); assert.ok(Math.abs(cameraView(viewer).heading - 35) < .00001);
  assert.ok(Math.abs(cameraView(viewer).lat - 47) < .00001); assert.deepEqual(layers, initialLayers); assert.equal(viewer.earthTime.getState(), historical);
});
