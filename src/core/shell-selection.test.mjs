import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { liveEarthquakeSelection, createLiveEarthquakeDossier, selectionFields, createShell } from './shell.js';
import { createLayerManager } from './layer-manager.js';
import { createGdacsNoticesLayer } from '../layers/gdacs/index.js';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { createWorldSourceItem, worldHash } from './world-model.js';
import { normalizeGdacsSourceItems } from './gdacs-source-items.js';
import { readFile } from 'node:fs/promises';

const at = Cesium.JulianDate.fromIso8601('2026-10-12T02:26:17Z');
const facts = { usgsId: 'us6000u1iz', mag: 4.2, place: '26 km SE of Jurm, Afghanistan', time: Date.parse('2026-10-11T23:14:20.125Z'), depth: 213.6 };
const entity = (values = facts, id = `earthquake:${values.usgsId}`) => new Cesium.Entity({ id,
  position: Cesium.Cartesian3.fromDegrees(71.02, 36.72), properties: values });
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ''; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
}
const documentRef = { createElement: tag => new Node(tag) };
const nodes = node => [node, ...node.children.flatMap(nodes)];

test('a live picked point has readable reported facts, explicit occurrence UTC and one identity-bound official source link', () => {
  const point = entity(), selection = liveEarthquakeSelection(point, at), display = createLiveEarthquakeDossier(selection, { documentRef });
  assert.equal(selection.title, 'Magnitude 4.2 · 26 km SE of Jurm, Afghanistan');
  assert.equal(selection.sourceUrl, 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u1iz');
  assert.ok(selection.fields.some(([label, value]) => label === 'Occurred UTC' && value === '2026-10-11 23:14:20.125 UTC'));
  assert.ok(selection.fields.some(([label, value]) => label === 'Reported epicenter' && value === '36.72000°, 71.02000°'));
  const links = nodes(display).filter(node => node.tagName === 'a'); assert.equal(links.length, 1);
  assert.equal(links[0].href, selection.sourceUrl); assert.equal(links[0].rel, 'noopener noreferrer');
  assert.match(display.textContent, /Source: U.S. Geological Survey \(USGS\)/);
  assert.doesNotMatch(display.textContent, /First retained|Capture published|archive|snapshot|independently verified/);
  assert.deepEqual(point.properties.getValue(at), facts, 'the readable renderer does not mutate source facts or add retention claims');
});

test('missing, malformed and mismatched reported IDs cannot become source URLs while text remains readable and DOM-safe', () => {
  for (const id of [null, '', '../us6000u1iz', 'us6000u1iz?other=1', 'javascript:alert(1)', 'US6000U1IZ', 'a'.repeat(33)]) {
    const values = { ...facts, usgsId: id, place: '<img src=x onerror=alert(1)>' }, selection = liveEarthquakeSelection(entity(values), at);
    assert.equal(selection.sourceUrl, null); const display = createLiveEarthquakeDossier(selection, { documentRef });
    assert.equal(nodes(display).some(node => node.tagName === 'a' || node.tagName === 'img'), false); assert.ok(display.textContent.includes(values.place));
  }
  assert.equal(liveEarthquakeSelection(entity(facts, 'earthquake:us6000other'), at).sourceUrl, null);
  for (const url of ['javascript:alert(1)', 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u1iz?foreign=1', 'https://example.com/us6000u1iz']) {
    const display = createLiveEarthquakeDossier({ ...liveEarthquakeSelection(entity(), at), sourceUrl: url }, { documentRef });
    assert.equal(nodes(display).some(node => node.tagName === 'a'), false);
  }
});

test('missing occurrence and measurements stay unspecified; other layers and archive/context selections keep their existing path', () => {
  const selection = liveEarthquakeSelection(entity({ ...facts, time: NaN, depth: null, mag: null, place: null }), at);
  assert.equal(selection.title, 'Earthquake'); assert.deepEqual(selection.fields.slice(0, 2), [['Magnitude', 'Not reported'], ['Occurred UTC', 'Not reported']]);
  for (const [id, extra] of [['aircraft:us6000u1iz', {}], ['history:us6000u1iz', {}], ['earthquake:us6000u1iz', { _worldScene: { mode: 'reconstruction' } }], ['earthquake:us6000u1iz', { _worldReport: { kind: 'retained-source-context' } }]])
    assert.equal(liveEarthquakeSelection(entity({ ...facts, ...extra }, id), at), null);
  const other = entity({ name: 'Other layer', time: 1000 }, 'aircraft:other');
  assert.ok(selectionFields(other, at).some(([label, value]) => label === 'Time' && value === '1000'));
  assert.equal(createLiveEarthquakeDossier(null, { documentRef }), null);
});

test('scientific report types and correction clocks remain source statements rather than earthquake or verification claims', () => {
  for (const eventType of [null, 'quarry blast', 'other event', '<script>']) {
    const selection = liveEarthquakeSelection(entity({ ...facts, eventType, updatedAt: Date.parse('2026-10-12T01:14:20.125Z'), reviewStatus: 'reviewed' }), at);
    assert.equal(selection.kind, 'Seismic report');
    assert.ok(selection.fields.some(([key, value]) => key === 'Reported type' && value === (eventType || 'Not reported')));
    assert.ok(selection.fields.some(([key, value]) => key === 'Source revised UTC' && value === '2026-10-12 01:14:20.125 UTC'));
    assert.ok(selection.fields.some(([key, value]) => key === 'Source review status' && value === 'reviewed'));
    assert.equal(nodes(createLiveEarthquakeDossier(selection, { documentRef })).some(node => node.tagName === 'script'), false);
  }
  assert.equal(liveEarthquakeSelection(entity({ ...facts, eventType: 'earthquake' }), at).kind, 'Earthquake');
  for (const sourceUrl of [null, 'https://example.com/', 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000other'])
    assert.equal(liveEarthquakeSelection(entity({ ...facts, sourceUrl }), at).sourceUrl, null);
  const sourceUrl = 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u1iz/';
  assert.equal(liveEarthquakeSelection(entity({ ...facts, sourceUrl }), at).sourceUrl, sourceUrl);
});

// Minimal local DOM: models capture/bubble ownership and hidden/inert focus,
// without claiming native keyboard layout, CSS visibility or browser acceptance.
function shellDocument() {
  const walk = node => [node, ...node.children.flatMap(walk)];
  class Element {
    constructor(tag) { this.tagName = tag.toLowerCase(); this.children = []; this.listeners = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} }; this.className = ''; this._text = ''; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get hidden() { return this._hidden || false; }
    set hidden(value) { this._hidden = Boolean(value); if (value && this.contains(doc.activeElement)) doc.activeElement = doc.body; }
    get inert() { return this._inert || false; }
    set inert(value) { this._inert = Boolean(value); if (value && this.contains(doc.activeElement)) doc.activeElement = doc.body; }
    get isConnected() { return doc.body?.contains(this) || false; }
    get firstElementChild() { return this.children[0] || null; }
    get classList() {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      return { contains: value => values.has(value), add: (...items) => { for (const item of items) values.add(item); this.className = [...values].join(' '); },
        remove: (...items) => { for (const item of items) values.delete(item); this.className = [...values].join(' '); },
        toggle: (value, enabled = !values.has(value)) => { enabled ? values.add(value) : values.delete(value); this.className = [...values].join(' '); return enabled; } };
    }
    append(...items) { for (const item of items) {
      if (item.tagName === '#fragment') { this.append(...item.children.slice()); continue; }
      item.remove(); item.parentElement = this; this.children.push(item);
    } }
    replaceChildren(...items) { for (const child of this.children) { if (child.contains(doc.activeElement)) doc.activeElement = doc.body; child.parentElement = null; } this.children = []; this._text = ''; this.append(...items); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    replaceWith(value) { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); this.remove(); value.parentElement = parent; parent.children.splice(index, 0, value); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'class') this.className = String(value); }
    getAttribute(key) { return key === 'hidden' ? this.hidden ? '' : null : key === 'inert' ? this.inert ? '' : null : key.startsWith('data-') ?
      this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] ?? null : this.attributes[key] ?? this[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    matches(selector) {
      const tag = /^([a-z][a-z0-9-]*)/i.exec(selector)?.[1], id = /#([\w-]+)/.exec(selector)?.[1];
      if (tag && tag !== this.tagName || id && id !== this.id) return false;
      if ([...selector.matchAll(/\.([\w-]+)/g)].some(([, value]) => !this.classList.contains(value))) return false;
      return [...selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)].every(([, key, value]) => this.getAttribute(key) != null && (value === undefined || this.getAttribute(key) === value));
    }
    closest(selector) { for (let current = this; current; current = current.parentElement) if (selector.split(',').some(part => current.matches(part.trim()))) return current; return null; }
    querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector.split(',').some(part => {
      const parts = part.trim().replace(/\s*>\s*/g, ' ').split(/\s+/); if (!node.matches(parts.pop())) return false;
      let parent = node.parentElement; for (const ancestor of parts.reverse()) { while (parent && !parent.matches(ancestor)) parent = parent.parentElement; if (!parent) return false; parent = parent.parentElement; } return true;
    })); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: capture === true }); }
    removeEventListener(type, fn, capture = false) { this.listeners = this.listeners.filter(listener => listener.type !== type || listener.fn !== fn || listener.capture !== (capture === true)); }
    dispatchEvent(event) {
      if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true });
      const ancestry = []; for (let current = this; current; current = current.parentElement) ancestry.push(current);
      for (const current of ancestry.slice().reverse()) for (const listener of current.listeners.slice()) if (listener.type === event.type && listener.capture) listener.fn(event);
      for (const current of ancestry) for (const listener of current.listeners.slice()) if (listener.type === event.type && !listener.capture) listener.fn(event);
      return true;
    }
    click(detail = 0) { this.dispatchEvent({ type: 'click', detail, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() { if (this.isConnected && !this.disabled && !this.closest('[hidden], [inert]')) doc.activeElement = this; }
    getBoundingClientRect() { return { height: 40, width: 1280 }; }
  }
  const doc = new Element('#document'); doc.createElement = tag => { const node = new Element(tag); node.ownerDocument = doc; return node; };
  doc.createElementNS = (_, tag) => doc.createElement(tag); doc.createDocumentFragment = () => doc.createElement('#fragment');
  doc.getElementById = id => walk(doc).find(node => node.id === id) || null;
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body'); doc.append(doc.documentElement); doc.documentElement.append(doc.body); doc.activeElement = doc.body;
  doc.tab = () => {
    const choices = walk(doc.body).filter(node => !node.disabled && !node.closest('[hidden], [inert]') && ['button', 'a', 'input', 'select', 'summary'].includes(node.tagName));
    choices[(choices.indexOf(doc.activeElement) + 1) % choices.length]?.focus();
  };
  return doc;
}

async function mountedShell(t) {
  const doc = shellDocument(), html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  for (const [, tag, id] of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const node = doc.createElement(tag); node.id = id; doc.body.append(node);
  }
  const get = id => doc.getElementById(id), selection = get('selection'), sidebar = get('sidebar');
  const header = doc.createElement('header'), eyebrow = doc.createElement('span'); eyebrow.className = 'panel-eyebrow';
  header.append(eyebrow, get('selection-title'), get('clear-selection')); selection.append(header, get('selection-details'));
  get('clear-selection').setAttribute('aria-label', 'Close feature details'); sidebar.append(get('layers'));
  for (const id of ['selection', 'news-panel', 'notebook-panel']) get(id).hidden = true;
  const windowRef = doc.createElement('#window'); windowRef.matchMedia = () => Object.assign(doc.createElement('#media'), { matches: false });
  const storage = new Map(), local = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  const globals = { document: doc, window: windowRef, localStorage: local, location: { pathname: '/earth/', search: '', hash: '' } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  let shell, manager;
  t.after(async () => { shell?.destroy(); await manager?.destroy(); for (const [key, value] of previous) value ? Object.defineProperty(globalThis, key, value) : delete globalThis[key]; });
  const viewer = { clock: { currentTime: at }, scene: { requestRender() {}, globe: {} },
    cesiumWidget: { creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} } },
    earthTime: { getState: () => ({ mode: 'live' }) }, dataSources: { add() {}, remove() {} } };
  viewer._selectedEntityChanged = new Cesium.Event();
  Object.defineProperties(viewer, { selectedEntity: Object.getOwnPropertyDescriptor(Cesium.Viewer.prototype, 'selectedEntity'),
    selectedEntityChanged: Object.getOwnPropertyDescriptor(Cesium.Viewer.prototype, 'selectedEntityChanged') });
  const capturedAt = '2026-10-12T02:00:00.000Z', publishedAt = '2026-10-12T02:00:01.000Z';
  const record = canonicalDiscoveryRecord({ id: 'gdacs:FL:1001:1', sourceId: 'gdacs', source: 'GDACS', title: 'TEST ONLY flood notice', category: 'disasters',
    kind: 'hazard-report', eventType: 'FL', lat: 50, lon: 4, url: 'https://www.gdacs.org/report.aspx?eventid=1001&eventtype=FL&episodeid=1', retrievedAt: capturedAt });
  const body = { schemaVersion: 1, source: 'gdacs', records: [record], coordinates: [] };
  const snapshotId = await worldHash({ ...body, records: body.records.map(({ retrievedAt: _retrievedAt, ...value }) => value) });
  const item = { ...await createWorldSourceItem(record, { snapshotId, capturedAt, recordedAt: publishedAt }),
    origin: { snapshotId, firstCapturedAt: capturedAt, firstRecordedAt: publishedAt, validation: 'retained-revision-index-only', bodyValidated: false } };
  const snapshot = { schemaVersion: 1, kind: 'source-item-cohort', configured: true, available: true, mode: 'current-retained-cohort', readAt: publishedAt,
    version: await worldHash({ sourceId: 'gdacs', snapshotId, capturedAt, publishedAt }), source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    cohort: { sourceId: 'gdacs', snapshotId, bodySha256: await worldHash(body), capturedAt, publishedAt, recordCount: 1 }, items: [item], counts: { returned: 1, mapped: 1, unmapped: 0 },
    coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100, completeRetainedCohort: true, completeProviderArchive: false },
    operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
  await normalizeGdacsSourceItems(snapshot);
  let reads = 0, layer;
  manager = createLayerManager(viewer, () => {}, { document: doc, storage: local, createServices: () => ({}), layerServiceRequirements: () => [],
    setInterval: () => 1, clearInterval() {}, createLayer: async id => { assert.equal(id, 'gdacs-notices'); return layer = createGdacsNoticesLayer({ documentRef: doc,
      source: { getSnapshot: async () => { reads++; return snapshot; } } }); } });
  shell = createShell(viewer, manager); await manager.setEnabled('gdacs-notices', true);
  const row = get('layers').querySelector('[data-layer-id="gdacs-notices"]'), options = row.querySelector('details');
  options.open = true; options.dispatchEvent({ type: 'toggle' }); shell.openSidebar();
  const button = row.querySelector('button[data-control-key]'); assert(button, 'the real manager mounts its admitted notice row');
  return { doc, get, shell, manager, layer, viewer, button, get reads() { return reads; } };
}

test('keyboard GDACS row activation hands focus from the inert Layers workspace to visible feature details and its next source link', async t => {
  const f = await mountedShell(t), close = f.get('clear-selection'); f.button.focus(); f.button.click(0);
  assert.equal(f.doc.activeElement, close); assert.equal(f.get('selection').hidden, false); assert.equal(f.get('sidebar').inert, true);
  assert.equal(close.getAttribute('aria-label'), 'Close feature details'); f.doc.tab();
  assert.equal(f.doc.activeElement.className, 'world-source'); assert.equal(f.doc.activeElement.href, 'https://www.gdacs.org/report.aspx?eventid=1001&eventtype=FL&episodeid=1');
  const selected = f.viewer.selectedEntity; f.shell.openSidebar(); f.button.focus(); f.button.click(0);
  assert.equal(f.viewer.selectedEntity, selected); assert.equal(f.doc.activeElement, close); assert.equal(f.reads, 1, 'reopening requests no new source data');
});

test('pointer/background selections, unfulfilled keyboard actions and disposed row controls cannot inherit keyboard focus intent', async t => {
  const f = await mountedShell(t), north = f.get('north'); f.button.focus(); f.button.click(1);
  assert.notEqual(f.doc.activeElement, f.get('clear-selection')); const selected = f.viewer.selectedEntity;
  north.focus(); f.viewer.selectedEntityChanged.raiseEvent(selected); assert.equal(f.doc.activeElement, north, 'background selection notification never claims focus');
  selected.name = 'TEST ONLY background title update'; await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(f.doc.activeElement, north, 'the real entity property repaint does not hand off keyboard focus');
  f.shell.openSidebar(); const original = f.layer.setParams; f.layer.setParams = () => false;
  f.button.focus(); f.button.click(0); await Promise.resolve(); f.layer.setParams = original;
  north.focus(); f.viewer.selectedEntityChanged.raiseEvent(selected); assert.equal(f.doc.activeElement, north, 'a failed row action expires instead of arming a later selection');
  f.shell.openSidebar(); f.layer.setParams = () => { f.viewer.selectedEntity = new Cesium.Entity({ id: 'unrelated:TEST_ONLY', name: 'TEST ONLY irrelevant selection' }); return false; };
  f.button.focus(); f.button.click(0); assert.notEqual(f.doc.activeElement, f.get('clear-selection'), 'an unrelated entity cannot consume this notice action as a focus handoff');
  await Promise.resolve(); f.layer.setParams = original;
  f.viewer.selectedEntity = new Cesium.Entity({ id: 'report:TEST_ONLY', name: 'TEST ONLY report', properties: { _worldReport: { kind: 'retained-source-context' } } });
  f.get('clear-selection').click(0); assert.equal(f.doc.activeElement, f.get('toggle-news'), 'the existing report close focus return remains intact');
  north.focus(); f.shell.destroy(); f.button.click(0); f.viewer.selectedEntityChanged.raiseEvent(selected); f.shell.selectEntity(selected);
  assert.equal(f.doc.activeElement, north); assert.equal(f.reads, 1);
});
