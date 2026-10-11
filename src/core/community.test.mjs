import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createCommunityPanel } from './community.js';
class Element {
  constructor(tag, doc) { this.tag = tag; this.ownerDocument = doc; this.children = []; this.listeners = new Map(); this.attributes = {}; this.text = ''; this.value = ''; this.files = []; this.checked = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((node) => node.textContent).join(''); }
  get childElementCount() { return this.children.filter((node) => node.tag !== '#text').length; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node)); }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn)); }
  async trigger(type) { await Promise.all((this.listeners.get(type) || []).map((fn) => fn({ preventDefault() {} }))); }
  reset() { for (const node of descendants(this)) { node.value = ''; node.checked = false; node.files = []; } }
}
const descendants = (root) => [root, ...root.children.flatMap(descendants)];
const fixture = () => {
  const doc = { createElement(tag) { return new Element(tag, this); }, createTextNode(text) { const node = new Element('#text', this); node.textContent = text; return node; } };
  return new Element('div', doc);
};
const find = (root, predicate) => descendants(root).find(predicate);
const field = (root, label) => find(root, (node) => node.tag === 'label' && node.textContent.startsWith(label)).children[0];
const settle = async () => { await setImmediate(); await setImmediate(); };
test('community data is fetched only on explicit open and an obsolete completion cannot repopulate a closed panel', async () => {
  const container = fixture(), pending = [], calls = [];
  const panel = createCommunityPanel({ container, getReturnPath: () => '/earth/', fetchImpl: (url, options) => { calls.push({ url, options }); return new Promise((resolve) => pending.push(resolve)); } });
  assert.equal(calls.length, 0); panel.open(); assert.equal(calls.length, 2); panel.close(); assert.equal(calls.every((call) => call.options.signal.aborted), true);
  pending[0](Response.json({ contributions: [{ id: 'old', title: 'Obsolete response', text: 'Old', publishedAt: '2026-10-11T12:00:00Z' }] })); pending[1](Response.json({ signedIn: true, enabled: true })); await settle();
  assert.doesNotMatch(container.textContent, /Obsolete response/); panel.destroy(); assert.equal(container.children.length, 0);
});
test('submission requires explicit consent and uploads only the processed JPEG; a pending receipt does not add a public card', async () => {
  const container = fixture(), calls = [], prepared = [], original = new Blob(['original metadata'], { type: 'image/png' });
  const panel = createCommunityPanel({ container, getReturnPath: () => '/earth/#view', getLocation: () => ({ lat: 50.850456, lon: 4.351749 }), preparePhoto: async (photo) => { prepared.push(photo); return new Blob(['processed bytes'], { type: 'image/jpeg' }); }, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url === '/api/evidence/session' ? Response.json({ signedIn: true, enabled: true }) : url === '/api/evidence/submissions' ? Response.json({ id: 'pending-reference', status: 'pending' }, { status: 202 }) : Response.json({ contributions: [], nextCursor: null });
  } });
  panel.open(); await settle(); assert.equal(calls.length, 2);
  const form = find(container, (node) => node.tag === 'form');
  field(container, 'Title').value = 'Observation'; field(container, 'What did you').value = 'Observed water'; field(container, 'Public display alias').value = 'Observer'; field(container, 'Photograph').files = [original];
  await form.trigger('submit'); assert.equal(calls.length, 2); assert.equal(prepared.length, 0);
  field(container, 'I consent').checked = true; field(container, 'I own').checked = true; field(container, 'Attach current').checked = true;
  await form.trigger('submit'); const upload = calls.find((call) => call.url === '/api/evidence/submissions');
  assert.deepEqual(prepared, [original]); assert.equal(upload.options.body.get('photo').type, 'image/jpeg'); assert.equal(await upload.options.body.get('photo').text(), 'processed bytes'); assert.equal(upload.options.body.get('photo').name, 'processed-photo.jpg'); assert.equal(upload.options.body.get('lat'), '50.850'); assert.equal(upload.options.body.has('userId'), false);
  assert.match(container.textContent, /Submitted for review · reference pending-reference/); assert.equal(descendants(container).filter((node) => node.className === 'notebook-card community-card').length, 0); panel.destroy();
});
