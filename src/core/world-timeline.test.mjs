import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline } from './timeline.js';
import { timelineDateUtc } from './world-timeline.js';
import { createSceneClock } from './scene-clock.js';
import { worldHash } from './world-model.js';
import { WORLD_SCENE_SCOPE } from './world-scene-controller.js';
import { Entity } from 'cesium';

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
const waitFor = async (condition, label) => {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};
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
  const requestedRange=at?{from:new Date(Date.parse(at)-7*86400000+1).toISOString(),to:end}:range;
  if(extra.coverage) {
    const target=extra.coverage.requestedRange || (extra.knownMode==='scene'?{...requestedRange,to:at}:requestedRange);
    const clip=(piece)=>({...piece,from:piece.from<target.from?target.from:piece.from,to:piece.to>target.to?target.to:piece.to});
    extra={...extra,coverage:{...extra.coverage,requestedRange:target,
      segments:extra.coverage.segments.map(clip).filter(piece=>piece.from<=piece.to),
      gaps:extra.coverage.gaps.map(clip).filter(piece=>piece.from<=piece.to)}};
  }
  return Response.json({ schemaVersion: 1, configured: true, available: true, mode: 'reconstruction', scope: { id: WORLD_SCENE_SCOPE, sourceId: 'usgs' },
    at, window: '7d', knownAt: null, knownMode: 'none', version: 'archive:1', currentVersion: 'archive:1', events: [], points,
    counts: { returned: points.length, eligible: at ? points.length : null, omitted: at ? 0 : null }, complete: true, membershipComplete: true, truncated: false, cursor: null,
    validFrom: at, validTo: end, nextSceneChangeAt: end, bufferFrom: at, bufferTo: end, bufferWindowFrom: at ? new Date(Date.parse(at) - 7 * 86400000).toISOString() : null,
    coverage: { availableRange: range, requestedRange, segments: [requestedRange], gaps: [], complete: true, truncated: false, status: 'complete' }, ...extra });
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
  assert.equal(elements(dock).find(element => element.className === 'timeline-status').textContent,
    'Current UTC · live layers use their own source update times.', 'returning Live cannot retain a historical missing-scene message');
  timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.frameCallbacks.size, 0);
});

test('maximum-rate pause materializes exact origin and expiry boundaries before expanded or collapsed calendar delivery', async () => {
  for (const expanded of [true, false]) {
    const f = fixture(), start = '2025-06-08T00:00:00.000Z', requests = [];
    const range = { from: '2025-06-01T00:00:00.000Z', to: '2025-06-10T00:00:00.000Z' };
    const expired = await point('expireonpause', '2025-06-01T00:00:00.400Z');
    const entered = await point('enteronpause', '2025-06-08T00:00:00.400Z');
    f.container.open = expanded;
    const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
      requests.push(url); const query = new URL(url, 'https://example.test').searchParams;
      return query.has('metadata') ? response(null, [], range) : response(query.get('at'), [expired, entered], range, { bufferTo: range.to });
    } });
    await timeline.seek(start);
    const all = elements(f.container.parentElement), play = all.find(element => element.id === 'timeline-play');
    const rate = all.find(element => element.id === 'timeline-rate'), date = all.find(element => element.id === 'timeline-date');
    const slider = all.find(element => element.type === 'range'), readout = all.find(element => element.className === 'timeline-clock');
    rate.value = '86400'; rate.trigger('change'); play.trigger('click'); await settle();
    assert.equal(f.sceneClock.getState().playing, true);
    const count = requests.length;
    f.timing.advance(.002); for (const frame of f.frameCallbacks) frame();
    assert.deepEqual([...f.entities].map(entity => entity.name), ['expireonpause']);
    assert.equal(timeline.getState().selection.at, start, 'last UI tick still owns the earlier selection');
    f.timing.advance(.008); play.trigger('click');
    const frozen = f.sceneClock.getState();
    assert.equal(frozen.at, '2025-06-08T00:00:00.864Z'); assert.equal(frozen.playing, false);
    assert.equal(timeline.getState().selection.at, frozen.at, 'publication/evidence selection retains the exact millisecond pause instant');
    assert.deepEqual([...f.entities].map(entity => entity.name), ['enteronpause'], 'expired pin leaves and new origin enters at frozen UTC, even after close emission');
    assert.equal(timeline.getState().opened, expanded); assert.equal(requests.length, count, 'pause materialization is entirely retained and local');
    assert.equal(readout.dateTime, frozen.at); assert.equal(readout.textContent, '2025-06-08 00:00:00 UTC');
    assert.equal(date.value, '2025-06-08T00:00:00'); assert.equal(slider.value, String(Date.parse(start) / 1000));
    f.timing.advance(10000); for (const frame of f.frameCallbacks) frame(); await settle();
    assert.equal(f.sceneClock.getState().at, frozen.at); assert.equal(timeline.getState().selection.at, frozen.at);
    assert.deepEqual([...f.entities].map(entity => entity.name), ['enteronpause']); assert.equal(requests.length, count);
    timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.frameCallbacks.size, 0);
  }
});

test('pause during a stored selection load keeps UTC fixed and preserves expanded completion or collapsed cancellation without reacquiring', async () => {
  for (const expanded of [true, false]) {
    const f = fixture(), start = '2025-06-08T00:00:00.000Z', requests = [];
    const range = { from: start, to: '2025-06-10T00:00:00.000Z' }, pending = [];
    const p = await point('pendingpause', start); f.container.open = expanded;
    const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url, options) => {
      requests.push(url); const query = new URL(url, 'https://example.test').searchParams;
      if (query.has('metadata')) return response(null, [], range);
      return new Promise(resolve => pending.push({ resolve, signal: options.signal, at: query.get('at') }));
    } });
    const play = elements(f.container.parentElement).find(element => element.id === 'timeline-play');
    play.trigger('click'); await waitFor(() => pending.length === 1, 'the stored selection request'); assert.equal(timeline.getState().loading, true);
    assert.equal(f.sceneClock.getState().at, start); assert.equal(f.entities.size, 0);
    const count = requests.length; play.trigger('click'); assert.equal(f.sceneClock.getState().playing, false);
    assert.equal(pending[0].signal.aborted, !expanded);
    pending[0].resolve(response(pending[0].at, [p], range, { bufferTo: range.to }));
    // Origin identity hashing may settle after several event-loop turns when
    // other suites use WebCrypto too. Wait for the real retained publication,
    // rather than treating a fixed count of microtasks as source completion.
    if (expanded) await waitFor(() => !timeline.getState().loading, 'the expanded retained selection completion'); else await settle();
    assert.equal(f.sceneClock.getState().at, start); assert.equal(f.sceneClock.getState().playing, false);
    assert.equal(f.entities.size, expanded ? 1 : 0); assert.equal(requests.length, count);
    if (expanded) assert.equal(timeline.getState().selection.at, start);
    timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0);
  }
});

test('collapsing the calendar preserves one requested historical seek, then closes background acquisition at completion', async () => {
  const f = fixture(), at = '2025-06-08T00:00:00.000Z', p = await point('collapsedseek', at), pending = [], requests = [];
  f.container.open = true;
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url, options) => {
    requests.push(url); const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) return response();
    return new Promise(resolve => pending.push({ resolve, signal: options.signal, at: query.get('at') }));
  } });
  const seek = timeline.seek(at); await waitFor(() => pending.length === 1, 'the requested historical scene');
  f.container.open = false; f.container.trigger('toggle');
  assert.equal(pending[0].signal.aborted, false); assert.equal(f.sceneClock.getState().at, at);
  pending[0].resolve(response(at, [p])); assert.equal(await seek, true);
  assert.equal(timeline.getState().opened, false); assert.equal(f.sceneClock.getState().playing, false);
  assert.equal(timeline.getState().selection.at, at); assert.equal(f.entities.size, 1);
  const count = requests.length; f.timing.advance(600000); await settle();
  assert.equal(requests.length, count); assert.equal(f.sceneClock.getState().at, at);
  timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0);
});

test('pause cannot repaint a stale capped selection when the frozen UTC has no admissible retained buffer', async () => {
  for (const expanded of [true, false]) {
    const f = fixture(), start = '2025-06-08T00:00:00.000Z', p = await point('cappedpause', start); let requests = 0;
    f.container.open = expanded;
    const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
      requests++; const query = new URL(url, 'https://example.test').searchParams;
      return query.has('metadata') ? response() : response(query.get('at'), [p], baseRange,
        { membershipComplete: false, truncated: true, complete: false, counts: { returned: 1, eligible: null, omitted: null } });
    } });
    await timeline.seek(start); assert.equal(f.entities.size, 1); const count = requests;
    // Another shared scene-clock control may advance UTC independently of the
    // archive's playback admission. It cannot make this capped buffer complete.
    f.sceneClock.setRate(86400); f.sceneClock.play(); f.timing.advance(.01);
    elements(f.container.parentElement).find(element => element.id === 'timeline-play').trigger('click');
    assert.equal(f.sceneClock.getState().at, '2025-06-08T00:00:00.864Z'); assert.equal(f.sceneClock.getState().playing, false);
    assert.equal(timeline.getState().selection, null); assert.equal(timeline.getState().selectedAt, f.sceneClock.getState().at);
    assert.equal(f.entities.size, 0); assert.equal(requests, count);
    assert.match(elements(f.container).find(element => element.className === 'timeline-status').textContent, /No stored scene/);
    timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0);
  }
});

test('an incomplete capped point buffer cannot start an automatic reload loop disguised as playback', async t => {
  const f = fixture(), at = '2025-06-01T12:00:00.000Z', p = await point('partial', at); let requests = 0;
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
    requests++; const query = new URL(url, 'https://example.test').searchParams;
    return query.has('metadata') ? response() : response(query.get('at'), [p], baseRange, { membershipComplete: false, truncated: true, complete: false, counts: { returned: 1, eligible: null, omitted: null } });
  } });
  t.after(()=>{timeline.destroy();f.sceneClock.destroy();});
  await timeline.seek(at); const play = elements(f.container.parentElement).find((element) => element.id === 'timeline-play'); play.trigger('click'); await settle();
  await waitFor(()=>!timeline.getState().loading&&timeline.getState().selection?.truncated,'the settled incomplete scene');
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
  assert.equal(lens.children.find(option=>option.value==='known-then').textContent,'Platform knew then');
  assert.match(lens.title,/later retained source corrections.*available on this site/);
  lens.value = 'known-then'; lens.trigger('change'); await settle();
  assert.equal(f.entities.size, 0); assert.equal(f.sceneClock.getState().at, at); assert.equal(transitions.at(-1).lens, 'known-then');
  assert.ok(calls.some((query) => query.get('knownMode') === 'scene' && !query.has('points')));
  const status=elements(f.container).find((element)=>element.className==='timeline-status');
  assert.match(status.textContent,/No evidence.*on this platform.*selected UTC.*Reconstruction/);
  assert.doesNotMatch(status.textContent,/No qualifying earthquakes/,'missing platform knowledge is not reported as event absence');
  assert.match(elements(f.container).find(element=>element.className==='timeline-note').textContent,/evidence was imported later/);
  lens.value='reconstruction';lens.trigger('change');await settle();
  assert.equal(f.sceneClock.getState().at,at);assert.equal(f.entities.size,1,'following the recovery wording restores later-imported evidence without changing UTC');
  assert.match(elements(f.container).find(element=>element.className==='timeline-note').textContent,/retained source reports and later corrections/);
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

test('browser minute-only dates with zero seconds leave Live and seek exact UTC; seconds stay intact and impossible dates cannot move the scene', async () => {
  const f = fixture(), calls = [];
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
    const query = new URL(url, 'https://example.test').searchParams; calls.push(query);
    return response(query.get('at'));
  } });
  const date = elements(f.container).find((element) => element.id === 'timeline-date');
  assert.equal(f.sceneClock.getState().mode, 'live'); date.value = '2025-10-08T00:00'; date.trigger('change'); await settle();
  assert.equal(f.sceneClock.getState().mode, 'history'); assert.equal(f.sceneClock.getState().at, '2025-10-08T00:00:00.000Z');
  assert.ok(calls.some((query) => query.get('at') === '2025-10-08T00:00:00.000Z'));
  date.value = '2025-10-08T14:26:17'; date.trigger('change'); await settle();
  assert.equal(f.sceneClock.getState().at, '2025-10-08T14:26:17.000Z');
  const accepted = f.sceneClock.getState().at, count = calls.length;
  for (const invalid of ['', '2025-02-29T00:00', '2025-04-31T00:00:00', '2025-10-08T24:00', '2025-10-08T14:60', '2025-10-08T14:26Z', '2025-10-08T14:26+02:00']) {
    date.value = invalid; date.trigger('change'); await settle(); assert.equal(f.sceneClock.getState().at, accepted); assert.equal(calls.length, count);
  }
  assert.equal(timelineDateUtc('2024-02-29T00:00'), '2024-02-29T00:00:00.000Z');
  assert.equal(timelineDateUtc('2025-10-08T14:26:17.125'), '2025-10-08T14:26:17.125Z');
  assert.equal(timelineDateUtc('2025-10-08T14:26:60'), null);
  timeline.destroy(); f.sceneClock.destroy();
});

test('an archive edition update keeps equal-revision Cesium pins and facts stable while renewing their detail-read edition', async () => {
  const f = fixture(), at = '2025-06-01T12:00:00.000Z', p = await point('unchanged', at); let version = 'archive:1', mounts = 0;
  f.viewer.entities.add = (value) => { mounts++; const entity = new Entity(value); f.entities.add(entity); return entity; };
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async (url) => {
    const query = new URL(url, 'https://example.test').searchParams;
    return response(query.get('at'), query.has('metadata') ? [] : [p], baseRange, { version, currentVersion: version });
  } });
  f.container.open = true; f.container.trigger('toggle'); await settle(); await timeline.seek(at);
  const entity = [...f.entities][0], position = entity.position, facts = ['source', 'observedAt', 'url', 'usgsId', 'mag', 'time'].map((name) => entity.properties[name]);
  let contextChanges = 0; entity.properties._worldScene.definitionChanged.addEventListener(() => { contextChanges++; });
  f.viewer.selectedEntity = entity; version = 'archive:2'; f.timing.advance(60000);
  for (let i = 0; i < 100 && timeline.getState().selection?.version !== version; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(f.entities.size, 1); assert.equal([...f.entities][0], entity); assert.equal(mounts, 1);
  assert.equal(f.viewer.selectedEntity, entity); assert.equal(entity.position, position);
  assert.deepEqual(['source', 'observedAt', 'url', 'usgsId', 'mag', 'time'].map((name) => entity.properties[name]), facts);
  assert.equal(entity.properties._worldScene.getValue().version, 'archive:2'); assert.equal(contextChanges, 1);
  assert.equal(entity.properties._worldScene.getValue().revision, p.revision);
  assert.equal(f.sceneClock.getState().at, at);
  timeline.destroy(); f.sceneClock.destroy();
});

test('historical reports are behind an independent closed disclosure while calendar coverage and transport stay outside it', async () => {
  const f = fixture(), at = '2025-06-01T12:00:00.000Z', points = await Promise.all(Array.from({ length: 41 }, (_, i) => point(`report${i}`, at)));
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef,
    fetchImpl: async (url) => { const query = new URL(url, 'https://example.test').searchParams; return response(query.get('at'), query.has('metadata') ? [] : points); } });
  await timeline.seek(at);
  const all = elements(f.container), disclosure = all.find((element) => element.className === 'timeline-reports');
  assert.ok(!disclosure.open); assert.equal(disclosure.hidden, false);
  assert.match(disclosure.children[0].textContent, /41 · first 40 listed/);
  assert.equal(elements(disclosure).filter((element) => element.className === 'timeline-card').length, 40);
  assert.ok(!elements(disclosure).some((element) => ['timeline-date', 'timeline-play', 'timeline-rate'].includes(element.id) || element.className === 'timeline-coverage-band'));
  disclosure.open = true; f.timing.advance(1000); assert.equal(disclosure.open, true);
  assert.equal(f.entities.size, 41, 'Disclosure presentation does not cap scene membership');
  timeline.live(); assert.equal(disclosure.hidden, true);
  timeline.destroy(); f.sceneClock.destroy();
});

test('collapsed History identifies the exact supported source window, preserves UTC and uses a local progressive explanation without narrowing Live', async () => {
  const f = fixture(), at = '2025-06-01T12:00:00.000Z', p = await point('scope', at), requests = [];
  const timeline = createTimeline({ ...f.timing, container: f.container, viewer: f.viewer, documentRef: f.documentRef, fetchImpl: async url => {
    const query = new URL(url, 'https://example.test').searchParams; requests.push(query);
    return query.get('knownMode') === 'scene' ? response(query.get('at'), [], baseRange, { mode: 'as-known', knownMode: 'scene', knownAt: query.get('at'), points: undefined }) :
      response(query.get('at'), query.has('metadata') ? [] : [p]);
  } });
  const all = elements(f.container.parentElement), caption = all.find(el => el.className === 'timeline-current-scope'), readout = all.find(el => el.className === 'timeline-readout');
  const explanation = all.find(el => el.className === 'timeline-method'), clock = all.find(el => el.className === 'timeline-clock'), lens = all.find(el => el.id === 'timeline-lens');
  assert.equal(caption.hidden, true); assert.equal(readout.attributes['aria-label'], 'Scene UTC time'); assert.ok(!explanation.open); assert.equal(requests.length, 0);
  await timeline.seek(at); assert.ok(!f.container.open); assert.equal(caption.hidden, false); assert.equal(caption.textContent, 'USGS · M4.5+ · 7d');
  assert.match(caption.attributes['aria-label'], /magnitude 4.5 or greater.*preceding seven days.*Reconstruction/);
  assert.equal(clock.dateTime, at); assert.equal(f.sceneClock.getState().at, at); const count = requests.length;
  explanation.open = true; explanation.trigger('toggle'); assert.match(explanation.textContent, /base map imagery is not historical/);
  assert.equal(requests.length, count); assert.equal(f.sceneClock.getState().at, at); assert.equal(f.entities.size, 1);
  lens.value = 'known-then'; lens.trigger('change'); await waitFor(() => !timeline.getState().loading && timeline.getState().selection?.mode === 'as-known', 'the known-then stored scene');
  assert.equal(clock.dateTime, at); assert.match(caption.attributes['aria-label'], /Only evidence published by this platform by the selected UTC/);
  assert.equal(explanation.open, true, 'Mode explanations update without replacing the disclosure');
  timeline.live(); assert.equal(caption.hidden, true); assert.equal(readout.attributes['aria-label'], 'Scene UTC time');
  assert.equal(f.sceneClock.getState().mode, 'live'); timeline.destroy(); f.sceneClock.destroy(); assert.equal(f.timers.size, 0);
});


test('a bounded calendar band keeps all historical dates selectable and never labels unloaded dates as missing source coverage',async()=>{
  const f=fixture(), old='2025-06-01T12:00:00.000Z', p=await point('old-selectable',old);
  const checked={from:'2026-10-01T00:00:00.000Z',to:baseRange.to};
  const timeline=createTimeline({...f.timing,container:f.container,viewer:f.viewer,documentRef:f.documentRef,fetchImpl:async(url)=>{
    const q=new URL(url,'https://example.test').searchParams;
    if(q.has('metadata'))return response(null,[],baseRange,{coverage:{availableRange:baseRange,requestedRange:checked,segments:[checked],gaps:[],complete:true,truncated:false,status:'complete'}});
    return response(q.get('at'),[p]);
  }});
  try {
    f.container.open=true;f.container.trigger('toggle');await settle();
    const all=elements(f.container.parentElement), slider=all.find(item=>item.type==='range');
    const band=all.find(item=>item.className==='timeline-coverage-band');
    assert.equal(slider.min,String(Date.parse(baseRange.from)/1000));assert.equal(slider.max,String(Date.parse(baseRange.to)/1000));
    assert.ok(band);const before=band.attributes['aria-label'];assert.match(before,/checked calendar window/);assert.match(before,/have not been checked here/);
    await timeline.seek(old);assert.equal(f.sceneClock.getState().at,old);assert.equal(f.entities.size,1);
    assert.equal(band.attributes['aria-label'],before,'The old scene does not replace the loaded calendar band');
    assert.match(all.find(item=>item.className==='timeline-coverage').textContent,/other dates load on selection/);
  }finally{timeline.destroy();f.sceneClock.destroy();}
});
