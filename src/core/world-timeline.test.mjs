import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline } from './timeline.js';
import { createSceneClock } from './scene-clock.js';
import { worldHash } from './world-model.js';
import { WORLD_SCENE_SCOPE } from './world-scene-controller.js';

class Element {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { if (typeof node === 'object') { node.remove(); node.parentElement = this; } this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of [...this.children]) if (typeof node === 'object') node.remove(); this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
  replaceWith(node) { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); node.remove(); parent.children.splice(index, 1, node); node.parentElement = parent; this.parentElement = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  trigger(type) { for (const fn of this.listeners.get(type) || []) fn(); }
}
const elements = (root) => [root, ...root.children.filter((child) => typeof child === 'object').flatMap(elements)];
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
function fixture() {
  let time = 0, id = 0; const timers = new Map(), listeners = new Map(), entities = new Set();
  const timing = { now: () => time, monotonicNow: () => time, setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, item] of [...timers]) if (item.at <= time && timers.delete(id)) item.fn(); } };
  const documentRef = { hidden: false, createElement: (tag) => new Element(tag, documentRef), addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  const sceneClock = createSceneClock({ ...timing, documentRef, now: () => Date.parse('2026-10-12T00:00:00Z') + time });
  const frameCallbacks = new Set();
  const viewer = { earthTime: { ...sceneClock, getState: () => ({ ...sceneClock.getState(), lighting: true }), subscribeClock: sceneClock.subscribe },
    entities: { add(value) { entities.add(value); return value; }, remove(value) { entities.delete(value); } },
    scene: { requestRender() {}, preUpdate: { addEventListener(fn) { frameCallbacks.add(fn); return () => frameCallbacks.delete(fn); } } } };
  return { timing, timers, documentRef, sceneClock, viewer, entities, frameCallbacks, container: documentRef.createElement('details') };
}
async function point(name, originAt) {
  const key = await worldHash(['usgs', `usgs:${name}`]);
  return { id: `event:usgs:${key}`, sourceId: 'usgs', sourceRecordId: `usgs:${name}`, itemId: `item:${key}`, revision: 'a'.repeat(64), snapshotId: 'b'.repeat(64),
    lat: 50, lon: 4, magnitude: 5.2, originAt, title: name, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${name}` };
}
const baseRange = { from: '2024-10-12T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z' };
function response(at = null, points = [], range = baseRange, extra = {}) {
  const end = at ? new Date(Date.parse(at) + 7 * 86400000).toISOString() : null;
  return Response.json({ schemaVersion: 1, configured: true, available: true, mode: 'reconstruction', scope: { id: WORLD_SCENE_SCOPE, sourceId: 'usgs' },
    at, window: '7d', knownAt: null, knownMode: 'none', version: 'archive:1', currentVersion: 'archive:1', events: [], points,
    counts: { returned: points.length, eligible: at ? points.length : null, omitted: at ? 0 : null }, complete: true, membershipComplete: true, truncated: false, cursor: null,
    validFrom: at, validTo: end, nextSceneChangeAt: end, bufferFrom: at, bufferTo: end, bufferWindowFrom: at ? new Date(Date.parse(at) - 7 * 86400000).toISOString() : null,
    coverage: { availableRange: range, segments: [range], gaps: [], complete: true, truncated: false, status: 'complete' }, ...extra });
}

test('calendar uses origin coverage across years, retains UTC through renewal, and crosses midnight without transferring an unchanged buffer', async () => {
  const f = fixture(), requests = [], beforeMidnight = '2025-06-01T23:59:50.000Z'; let metadataCalls = 0;
  const old = await point('earlier', '2025-06-01T20:00:00.000Z'), upcoming = await point('upcoming', '2025-06-02T00:00:20.000Z');
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
    requests.push(url); const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) return response(null, [], ++metadataCalls > 1 ? { ...baseRange, from: '2024-10-01T00:00:00.000Z' } : baseRange);
    const at = query.get('at');
    return response(at, [old, upcoming].filter((item) => Date.parse(item.originAt) > Date.parse(at) - 7 * 86400000));
  } });
  assert.equal(requests.length, 0); f.container.open = true; f.container.trigger('toggle'); await settle();
  const dock = f.container.parentElement, summary = elements(f.container).find((element) => element.tagName === 'summary'), all = elements(dock);
  const slider = all.find((element) => element.type === 'range'), date = all.find((element) => element.id === 'timeline-date');
  const play = all.find((element) => element.id === 'timeline-play'), rate = all.find((element) => element.id === 'timeline-rate');
  assert.equal(summary.attributes['aria-label'], 'Calendar and historical coverage');
  assert.ok(!elements(summary).some((element) => ['button', 'select', 'input'].includes(element.tagName)));
  assert.equal(slider.min, String(Date.parse(baseRange.from) / 1000));
  await timeline.seek(beforeMidnight); assert.equal(f.sceneClock.getState().at, beforeMidnight); assert.equal(f.entities.size, 1);
  assert.equal([...f.entities][0].properties.time, Date.parse(old.originAt)); assert.equal([...f.entities][0].properties._worldScene.mode, 'reconstruction');
  rate.value = '60'; rate.trigger('change'); play.trigger('click'); await settle(); const transferred = requests.length;
  f.timing.advance(600); for (const frame of f.frameCallbacks) frame();
  assert.equal(f.entities.size, 2, 'Native presentation frames apply exact origin membership before the next one-second label tick');
  assert.equal(requests.length, transferred, 'Presentation frames cannot fetch');
  f.timing.advance(400); await settle();
  assert.equal(f.sceneClock.getState().at, '2025-06-02T00:00:50.000Z'); assert.equal(f.entities.size, 2); assert.equal(date.value, '2025-06-02T00:00:50');
  assert.equal(requests.length, transferred, 'The new event enters locally; source requests do not follow event boundaries');
  play.trigger('click'); const chosen = f.sceneClock.getState().at;
  f.timing.advance(60000); await settle(); assert.equal(f.sceneClock.getState().at, chosen); assert.equal(date.value, chosen.slice(0, 19));
  assert.equal(slider.min, String(Date.parse('2024-10-01T00:00:00.000Z') / 1000));
  slider.value = String(Date.parse('2025-06-04T12:00:00.000Z') / 1000); slider.trigger('input'); f.timing.advance(60000); await settle();
  assert.equal(slider.value, String(Date.parse('2025-06-04T12:00:00.000Z') / 1000)); slider.trigger('change'); await settle(); assert.equal(f.sceneClock.getState().at, '2025-06-04T12:00:00.000Z');
  timeline.live(); assert.equal(f.sceneClock.getState().mode, 'live'); assert.equal(f.entities.size, 0);
  timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.frameCallbacks.size, 0);
});

test('an incomplete capped point buffer cannot start an automatic reload loop disguised as playback', async () => {
  const f = fixture(), at = '2025-06-01T12:00:00.000Z', p = await point('partial', at); let requests = 0;
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
    requests++; const query = new URL(url, 'https://example.test').searchParams;
    return query.has('metadata') ? response() : response(query.get('at'), [p], baseRange, { membershipComplete: false, truncated: true, complete: false, counts: { returned: 1, eligible: null, omitted: null } });
  } });
  await timeline.seek(at); const play = elements(f.container.parentElement).find((element) => element.id === 'timeline-play'); play.trigger('click'); await settle();
  assert.equal(f.sceneClock.getState().playing, false); const count = requests; f.timing.advance(10000); await settle(); assert.equal(requests, count);
  assert.match(elements(f.container).find((element) => element.className === 'timeline-status').textContent, /incomplete/);
  timeline.destroy(); f.sceneClock.destroy();
});

test('a gap owns the selected UTC and clears past/live substitutes; Known then does not rename event time as retention time', async () => {
  const f = fixture(), at = '2025-06-01T12:00:00.000Z', p = await point('historical', at), calls = [], transitions = [];
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, onTimeChange: (state) => transitions.push(state), fetchImpl: async (url) => {
    const query = new URL(url, 'https://example.test').searchParams; calls.push(query);
    if (query.has('metadata')) return response();
    if (query.get('knownMode') === 'scene') return response(query.get('at'), [], baseRange, { points: undefined, mode: 'as-known', knownMode: 'scene', knownAt: query.get('at'),
      complete: false, version: 'archive:0', coverage: { availableRange: baseRange, segments: [], gaps: [{ from: '2025-05-25T12:00:00.001Z', to: at, status: 'unavailable-at-cutoff' }], complete: false, truncated: false, status: 'unavailable-at-cutoff' } });
    return response(query.get('at'), [p]);
  } });
  await timeline.seek(at); assert.equal(f.entities.size, 1); const lens = elements(f.container).find((element) => element.id === 'timeline-lens');
  lens.value = 'known-then'; lens.trigger('change'); await settle();
  assert.equal(f.entities.size, 0); assert.equal(f.sceneClock.getState().at, at); assert.equal(transitions.at(-1).lens, 'known-then');
  assert.ok(calls.some((query) => query.get('knownMode') === 'scene' && !query.has('points')));
  assert.match(elements(f.container).find((element) => element.className === 'timeline-status').textContent, /knowledge cutoff/);
  timeline.live(); assert.equal(f.sceneClock.getState().mode, 'live'); timeline.destroy(); f.sceneClock.destroy();
});

test('a manually entered calendar gap does not borrow completeness from unrelated global source intervals', async () => {
  const f = fixture(), at = '2025-06-02T12:00:00.000Z', gapAt = '2025-06-15T12:00:00.000Z';
  const p = await point('retained', at), range = { from: '2025-06-01T00:00:00.000Z', to: '2025-06-30T00:00:00.000Z' };
  const segments = [{ from: range.from, to: '2025-06-07T00:00:00.000Z' }, { from: '2025-06-21T00:00:00.000Z', to: range.to }];
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
    const query = new URL(url, 'https://example.test').searchParams, selected = query.get('at');
    return response(selected, selected === at ? [p] : [], range, { coverage: { availableRange: range, segments,
      gaps: selected === gapAt ? [{ from: '2025-06-08T12:00:00.001Z', to: gapAt, status: 'not-imported' }] : [], complete: false, truncated: false, status: 'partial' }, complete: false });
  } });
  await timeline.seek(at); assert.equal(f.entities.size, 1);
  const date = elements(f.container).find((element) => element.id === 'timeline-date'); date.value = gapAt.slice(0, 19); date.trigger('change'); await settle();
  assert.equal(f.sceneClock.getState().at, gapAt); assert.equal(f.entities.size, 0);
  assert.equal(elements(f.container).find((element) => element.className === 'timeline-status').textContent, 'This period has not been imported; no current data substitutes for it.');
  timeline.destroy(); f.sceneClock.destroy();
});
