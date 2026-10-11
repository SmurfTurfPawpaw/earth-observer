import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemandTracker } from './demand.js';

class Element {
  constructor(tag, document) { this.tag = tag; this.ownerDocument = document; this.children = []; this.listeners = new Map(); this.checked = false; }
  append(...nodes) { for (const node of nodes) { if (typeof node === 'object') node.parent = this; this.children.push(node); } }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  trigger(type) { this.listeners.get(type)?.(); }
}
function fixture() {
  const document = { createElement(tag) { return new Element(tag, this); } };
  const container = document.createElement('div');
  return { container, checkbox: () => container.children[0].children[0].children[0], status: () => container.children[0].children[2] };
}
const origin = 'https://giovannicallebaut.com';
test('default off has no network activity; explicit opt-in sends only a reviewed payload without credentials', async () => {
  const ui = fixture(), calls = [];
  const tracker = createDemandTracker({ container: ui.container, locationRef: { origin }, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ enabled: true, accepted: true }, { status: 202 }); } });
  assert.equal(ui.checkbox().checked, false); assert.equal(calls.length, 0);
  assert.equal(await tracker.noteSearch({ q: 'Trade', country: 'BE' }), false); assert.equal(calls.length, 0);
  ui.checkbox().checked = true; ui.checkbox().trigger('change');
  for (const q of ['publisher.example', 'unique person address', 'my GPS 50.84 4.35']) assert.equal(await tracker.noteSearch({ q }), false);
  assert.equal(calls.length, 0);
  assert.equal(await tracker.noteSearch({ q: 'Trade', country: 'BE', latitude: 50.84, identity: 'Must not escape' }), true);
  assert.equal(calls.length, 1); const { url, options } = calls[0];
  assert.equal(url, '/api/discovery/demand'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.deepEqual(JSON.parse(options.body), { subjectId: 'gkg:WB_698_TRADE', country: 'BE', consent: true });
  assert.doesNotMatch(options.body, /latitude|identity|Must not escape|"q"/);
  ui.checkbox().checked = false; ui.checkbox().trigger('change'); assert.equal(await tracker.noteSearch({ q: 'Trade' }), false);
  tracker.destroy(); assert.equal(ui.container.children.length, 0);
});
test('localhost/preview/test markers are disabled even when a script toggles the checkbox', async () => {
  for (const options of [{ locationRef: { origin: 'http://localhost:4174' } }, { locationRef: { origin: 'https://preview.giovannicallebaut.com' } }, { locationRef: { origin }, testTraffic: true }, { locationRef: { origin }, headers: { 'x-earth-test': '1' } }]) {
    const ui = fixture(); let calls = 0;
    const tracker = createDemandTracker({ container: ui.container, ...options, fetchImpl: async () => { calls++; throw Error('Must not send'); } });
    assert.equal(ui.checkbox().disabled, true); ui.checkbox().checked = true;
    assert.equal(await tracker.noteSearch({ q: 'Trade' }), false); assert.equal(calls, 0); tracker.destroy();
  }
});
test('server-disabled/error responses do not claim acceptance; opting out aborts in-flight work without reviving UI', async () => {
  const ui = fixture(); let resolve, request;
  const tracker = createDemandTracker({ container: ui.container, locationRef: { origin }, fetchImpl: (url, options) => { request = options; return new Promise((done) => { resolve = done; }); } });
  ui.checkbox().checked = true; ui.checkbox().trigger('change');
  const pending = tracker.noteSearch({ category: 'all' });
  ui.checkbox().checked = false; ui.checkbox().trigger('change'); assert.equal(request.signal.aborted, true);
  resolve(Response.json({ enabled: false, accepted: false }, { status: 503 })); assert.equal(await pending, false);
  assert.match(ui.status().textContent, /Off/); tracker.destroy();
  const next = fixture();
  const failed = createDemandTracker({ container: next.container, locationRef: { origin }, fetchImpl: async () => Response.json({ enabled: false, accepted: false }, { status: 503 }) });
  next.checkbox().checked = true; next.checkbox().trigger('change');
  assert.equal(await failed.noteSearch({}), false); assert.match(next.status().textContent, /not confirmed/); failed.destroy();
});
