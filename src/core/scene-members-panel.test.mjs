import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneMembersPanel } from './scene-members-panel.js';

class Node extends EventTarget {
  constructor(doc) { super(); this.ownerDocument = doc; this.children = []; this.attributes = {}; this.hidden = false;
    const values = new Set(); this.classList = { add: key => values.add(key), remove: key => values.delete(key), contains: key => values.has(key) }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
function fixture() {
  const documentRef = new Node(); documentRef.ownerDocument = documentRef; documentRef.defaultView = { CustomEvent };
  documentRef.createElement = documentRef.createElementNS = () => new Node(documentRef);
  documentRef.body = new Node(documentRef); documentRef.append(documentRef.body);
  documentRef.getElementById = id => walk(documentRef).find(node => node.id === id);
  documentRef.querySelector = () => null;
  const panel = createSceneMembersPanel({ documentRef });
  return { documentRef, panel, get: name => walk(documentRef).find(node => node.className === name) };
}
const page = (context, members = []) => ({ count: context.cluster.count, clusterId: context.cluster.id,
  viewVersion: context.viewVersion, members, nextCursor: null });
const context = (id, loadPage, inspectMember = async () => true) => ({ sourceKey: 'earthquakes', sourceLabel: 'USGS',
  cluster: { id, count: 2 }, viewVersion: id + '-view', isCurrent: () => true, loadPage, inspectMember });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('late pages cannot replace the selected area; source headings remain literal text', async () => {
  const f = fixture(), old = Promise.withResolvers();
  const a = context('a', () => old.promise), b = context('b', async () => page(b, [{ id: 'report-b', title: '<img src=x onerror=alert(1)>' }]));
  f.panel.open(a); f.panel.open(b); await flush();
  old.resolve(page(a, [{ id: 'old', title: 'Late old report' }])); await flush();
  assert.equal(f.get('scene-members-list').children.length, 1);
  assert.equal(f.get('scene-member-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(f.get('scene-member-title').children.length, 0);
  f.panel.destroy();
});

test('source lifetime abort closes the panel and invalidates an in-flight member inspection', async () => {
  const f = fixture(), abort = new AbortController(), inspection = Promise.withResolvers(); let closed = 0, inspectSignal;
  const c = context('a', async () => page(c, [{ id: 'report', title: 'Report' }]), (_row, options) => { inspectSignal = options.signal; return inspection.promise; });
  Object.assign(c, { signal: abort.signal, onClose: () => { closed++; } });
  f.panel.open(c); await flush(); f.get('scene-member-row').dispatchEvent(new Event('click'));
  abort.abort(); inspection.resolve(true); await flush();
  assert.equal(f.panel.isOpen(), false); assert.equal(inspectSignal.aborted, true); assert.equal(closed, 1);
  assert.equal(f.documentRef.body.classList.contains('scene-members-open'), false);
  f.panel.destroy();
});

test('a failed request has a real retry; mismatched counts never render unverified rows', async () => {
  const f = fixture(); let calls = 0;
  const c = context('a', async () => ++calls === 1 ? { ...page(c, [{ title: 'Wrong count' }]), count: 3 } : page(c, [{ title: 'Verified' }]));
  f.panel.open(c); await flush();
  assert.equal(f.get('scene-members-list').children.length, 0); assert.equal(f.get('scene-members-more').hidden, false);
  assert.equal(f.get('scene-members-more').textContent, 'Try again');
  f.get('scene-members-more').dispatchEvent(new Event('click')); await flush();
  assert.equal(calls, 2); assert.equal(f.get('scene-member-title').textContent, 'Verified');
  assert.equal(f.get('scene-members-more').hidden, true); f.panel.destroy();
});

test('destroy cancels a pending page and removes panel and keyboard owner', async () => {
  const f = fixture(), pending = Promise.withResolvers(); let signal;
  const c = context('a', (_cursor, options) => { signal = options.signal; return pending.promise; });
  f.panel.open(c); f.panel.destroy(); pending.resolve(page(c, [{ title: 'Late' }])); await flush();
  assert.equal(signal.aborted, true); assert.equal(f.documentRef.getElementById('scene-members'), undefined);
  assert.equal(f.panel.open(c), false);
});

test('a shared area beacon lets users choose a category before fetching, retiring the parent lease first', async () => {
  const f = fixture(), abort = new AbortController(); let reads = 0, chosen;
  const c = context('area', async () => { reads++; return page(c); });
  Object.assign(c, { signal: abort.signal, onClose: () => abort.abort(), groups: [
    { id: 'flood', label: 'Flooding', count: 2 }, { id: 'quake', label: 'Earthquakes', count: 3 }],
    inspectGroup: id => { assert.equal(abort.signal.aborted, true); chosen = id; } });
  f.panel.open(c); await flush(); assert.equal(reads, 0); assert.equal(f.get('scene-members-list').children.length, 2);
  f.get('scene-member-row').dispatchEvent(new Event('click')); assert.equal(chosen, 'flood'); assert.equal(f.panel.isOpen(), false);
  f.panel.destroy();
});

test('newer reports offer explicit refresh while the opened edition and its rows stay pinned', async () => {
  const f = fixture(); let latest, unsubscribed = 0;
  const c = context('old', async () => page(c, [{ title: 'Original edition' }]));
  Object.assign(c, { isLatest: () => true, refresh: async () => true,
    subscribeLatest: listener => { latest = listener; return () => { unsubscribed++; }; } });
  f.panel.open(c); await flush(); assert.equal(f.get('icon-button scene-members-refresh').hidden, true);
  latest(false); assert.equal(f.get('icon-button scene-members-refresh').hidden, false);
  assert.equal(f.get('scene-member-title').textContent, 'Original edition');
  f.panel.close(); assert.equal(unsubscribed, 1);
  latest(false); assert.equal(f.panel.isOpen(), false); f.panel.destroy();
});

test('an expired edition keeps a real recovery action even when its facts still match the head', async () => {
  const f = fixture(); let latest;
  const c = context('old', async () => { throw Object.assign(new Error('Expired'), { refreshRequired: true }); });
  Object.assign(c, { isLatest: () => true, refresh: async () => { throw Object.assign(new Error('Not ready'), { refreshRequired: true }); },
    subscribeLatest: listener => { latest = listener; return () => {}; } });
  f.panel.open(c); await flush(); latest(true);
  assert.equal(f.get('icon-button scene-members-refresh').hidden, false);
  assert.equal(f.get('scene-members-more').hidden, true);
  assert.match(f.get('scene-members-status').textContent, /expired/);
  f.get('icon-button scene-members-refresh').dispatchEvent(new Event('click')); await flush(); latest(true);
  assert.equal(f.get('icon-button scene-members-refresh').hidden, false);
  assert.equal(f.get('icon-button scene-members-refresh').disabled, false);
  assert.match(f.get('scene-members-status').textContent, /not ready/); f.panel.destroy();
});

test('explicit refresh promotes a new verified context and late old work cannot overwrite it', async () => {
  const f = fixture(), refreshResult = Promise.withResolvers(); let refreshSignal;
  const newer = context('new', async () => page(newer, [{ title: 'Updated edition' }]));
  const old = context('old', async () => page(old, [{ title: 'Original edition' }]));
  Object.assign(old, { isLatest: () => false, refresh: ({ signal }) => { refreshSignal = signal; return refreshResult.promise; } });
  f.panel.open(old); await flush(); f.get('icon-button scene-members-refresh').dispatchEvent(new Event('click'));
  f.panel.open(newer); await flush(); refreshResult.resolve(true); await flush();
  assert.equal(refreshSignal.aborted, true); assert.equal(f.get('scene-member-title').textContent, 'Updated edition');
  assert.match(f.get('scene-members-status').textContent, /^1 of 2 reports/); f.panel.destroy();
});

test('cancelled source inspection preserves the prior status without inventing expiry', async () => {
  const f = fixture(); const c = context('a', async () => page(c, [{ title: 'Report' }]), async () => false);
  f.panel.open(c); await flush(); const before = f.get('scene-members-status').textContent;
  f.get('scene-member-row').dispatchEvent(new Event('click')); await flush();
  assert.equal(f.panel.isOpen(), true); assert.equal(f.get('scene-members-status').textContent, before);
  assert.equal(f.get('scene-member-row').disabled, false); f.panel.destroy();
});

test('ready empty and individually displayed latest areas are distinct from unavailable data', async () => {
  for (const [code, expected] of [['latest-group-individuals', /shows these reports individually/], ['latest-area-empty', /No reports appear in the latest view/]]) {
    const f = fixture(); const c = context('old', async () => page(c, [{ title: 'Retained report' }]));
    Object.assign(c, { isLatest: () => false, refresh: async () => { throw Object.assign(new Error(code), { code, refreshRequired: true }); } });
    f.panel.open(c); await flush(); f.get('icon-button scene-members-refresh').dispatchEvent(new Event('click')); await flush();
    assert.match(f.get('scene-members-status').textContent, expected);
    assert.equal(f.get('scene-member-title').textContent, 'Retained report');
    assert.equal(f.get('icon-button scene-members-refresh').disabled, false); f.panel.destroy();
  }
});
