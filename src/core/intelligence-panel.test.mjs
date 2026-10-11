import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntelligencePanel } from './intelligence.js';
import { readFile } from 'node:fs/promises';

const primaryContext = JSON.parse(await readFile(new URL('../../public/research/primary-context.json', import.meta.url), 'utf8'));

// Exercises the real panel, feed and demand controller without a browser or HTTP.
class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.checked = false;
    this._text = '';
  }
  get value() { return this._value ?? (this.tagName === 'select' ? this.children.find((child) => child.tagName === 'option')?.value : '') ?? ''; }
  set value(value) { this._value = value; }
  get textContent() { return this._text + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) {
    for (const child of nodes) {
      if (typeof child === 'object') { child.remove(); child.parent = this; }
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) if (typeof child === 'object') child.parent = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  trigger(type) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
}
function elements(root) {
  return [root, ...root.children.filter((child) => typeof child === 'object').flatMap(elements)];
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { await tick(); await tick(); }

function fixture(t, { offline = false, intelligenceFetch } = {}) {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  // A production-origin string enables the real opt-in controller. fetchImpl
  // below intercepts every request; no public aggregate counters are touched.
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://giovannicallebaut.com' } });
  const documentRef = {
    hidden: false, listeners: new Map(),
    createElement(tag) { return new Element(tag, this); },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); },
  };
  const stamp = new Date().toISOString();
  const record = { id: 'trade-fixture', sourceId: 'gdelt', kind: 'topic-mention',
    title: 'Topic mention · Trade', url: 'https://publisher.example/fixture', source: 'publisher.example',
    category: 'economy', themes: ['WB_698_TRADE'], mentionedCountries: ['BE'], indexedAt: stamp, retrievedAt: stamp,
    publishedAt: null, observedAt: null };
  const payload = { reports: [record], sources: [{ id: 'gdelt', name: 'GDELT fixture', url: 'https://www.gdeltproject.org/',
    mode: 'scheduled-gkg', status: 'ready', retrievedAt: stamp }], nextRefreshMs: 300000,
    indexRecords: [record], indexCoverage: { schemaVersion: 1, sources: [{ id: 'gdelt', generation: stamp,
      expiresAt: new Date(Date.now() + 86400000).toISOString() }] } };
  const calls = []; let intelligenceRequests = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url, globalThis.location.origin);
    if (path.pathname === '/research/primary-context.json') return Response.json(primaryContext);
    if (path.pathname === '/api/intelligence') {
      intelligenceRequests++;
      return intelligenceFetch ? intelligenceFetch({ payload, url, init, count: intelligenceRequests }) : offline ? Response.json({ error: 'Fixture unavailable' }, { status: 503 }) : Response.json(payload);
    }
    if (path.pathname === '/api/economics') return Response.json({ status: 'ready', frequency: 'annual',
      country: { id: path.searchParams.get('country') }, indicators: [], retrievedAt: stamp, nextRefreshMs: 86400000 });
    assert.equal(url, '/api/discovery/demand', 'All test requests must use a known mocked route');
    assert.equal(init.method, 'POST');
    return Response.json({ enabled: true, accepted: true }, { status: 202 });
  };
  const container = documentRef.createElement('section');
  const panel = createIntelligencePanel({ container, documentRef, fetchImpl });
  const find = (predicate) => elements(container).find(predicate);
  const ui = {
    form: find((element) => element.tagName === 'form'),
    query: find((element) => element.type === 'search'),
    category: find((element) => element.attributes['aria-label'] === 'Intelligence topic'),
    country: find((element) => element.attributes['aria-label'] === 'Country mentioned or reported'),
    checkbox: find((element) => element.type === 'checkbox'),
    refresh: find((element) => element.tagName === 'button' && element.textContent === 'Refresh sources'),
    status: container.children.find((element) => element.className === 'intelligence-status'),
    list: find((element) => element.className === 'intelligence-list'),
    research: find((element) => element.className === 'intelligence-research'),
  };
  const demandCalls = () => calls.filter(({ url }) => url === '/api/discovery/demand');
  const intelligenceCalls = () => calls.filter(({ url }) => url.startsWith('/api/intelligence?'));
  const optIn = () => { ui.checkbox.checked = true; ui.checkbox.trigger('change'); };
  t.after(() => {
    panel.destroy();
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location;
  });
  return { panel, container, ui, calls, demandCalls, intelligenceCalls, optIn };
}

test('actual panel counts only opted-in explicit submits, never mount/open/change/refresh/reopen', async (t) => {
  const env = fixture(t);
  assert.equal(env.calls.length, 0);
  assert.equal(env.ui.checkbox.checked, false);
  await env.panel.open();
  env.ui.query.value = 'Trade';
  assert.equal(env.ui.form.trigger('submit').defaultPrevented, true);
  await settle();
  assert.equal(env.demandCalls().length, 0, 'A valid submit with default consent off must not count');
  env.optIn();
  env.ui.category.value = 'economy'; env.ui.category.trigger('change'); await settle();
  env.ui.country.value = 'BE'; env.ui.country.trigger('change'); await settle();
  env.ui.refresh.trigger('click'); await settle();
  env.panel.close(); await env.panel.open();
  assert.equal(env.demandCalls().length, 0, 'Source acquisition and preference changes do not express a search action');
  env.ui.form.trigger('submit'); await settle();
  assert.equal(env.demandCalls().length, 1);
  assert.deepEqual(JSON.parse(env.demandCalls()[0].init.body), { subjectId: 'gkg:WB_698_TRADE', country: 'BE', consent: true });
  assert.equal(env.demandCalls()[0].init.credentials, 'omit');
  assert.equal(env.demandCalls()[0].init.cache, 'no-store');
  assert.ok(env.intelligenceCalls().every(({ url }) => !new URL(url, 'https://fixture.invalid').searchParams.has('q')));
});

test('reviewed identifier normalization accepts the panel search and sends only its canonical demand subject', async (t) => {
  const env = fixture(t); await env.panel.open(); env.optIn();
  const before = env.intelligenceCalls().length;
  env.ui.query.value = 'wb_698_trade';
  env.ui.form.trigger('submit'); await settle();
  assert.match(env.ui.status.textContent, /1 groups · 1 matching records/);
  assert.doesNotMatch(env.ui.status.textContent, /Search needs/);
  assert.match(env.ui.list.textContent, /Topic mention · Trade/);
  assert.equal(env.intelligenceCalls().length, before, 'The identifier becomes a local Trade search');
  assert.equal(env.demandCalls().length, 1);
  assert.deepEqual(JSON.parse(env.demandCalls()[0].init.body), { subjectId: 'gkg:WB_698_TRADE', country: '', consent: true });
  assert.doesNotMatch(env.demandCalls()[0].init.body, /"q"|publisher\.example|wb_698_trade/);
});

test('invalid inputs cannot acquire feeds or count; valid unknown free text stays local and never counts', async (t) => {
  const env = fixture(t); await env.panel.open(); env.optIn();
  const before = env.calls.length;
  for (const query of ['<private@address>', 'WB_UNKNOWN_TOPIC', 'a'.repeat(65)]) {
    env.ui.query.value = query; env.ui.form.trigger('submit'); await settle();
    assert.match(env.ui.status.textContent, /Search needs/);
    assert.equal(env.calls.length, before);
  }
  for (const query of ['publisher.example', 'an arbitrary private sentence', 'Trad']) {
    env.ui.query.value = query; env.ui.form.trigger('submit'); await settle();
    assert.doesNotMatch(env.ui.status.textContent, /Search needs/);
    assert.equal(env.calls.length, before);
  }
  assert.equal(env.demandCalls().length, 0);
});

test('accepted reviewed demand does not depend on upstream availability', async (t) => {
  const env = fixture(t, { offline: true }); await env.panel.open(); env.optIn();
  env.ui.query.value = 'Trade'; env.ui.form.trigger('submit'); await settle();
  assert.match(env.ui.status.textContent, /Intelligence feed HTTP 503/);
  assert.equal(env.demandCalls().length, 1);
  assert.deepEqual(JSON.parse(env.demandCalls()[0].init.body), { subjectId: 'gkg:WB_698_TRADE', country: '', consent: true });
  assert.ok(env.intelligenceCalls().every(({ url }) => !url.includes('Trade') && !url.includes('q=')));
});

test('mounted research context loads once on news open and filters locally outside live groups and demand', async (t) => {
  const env = fixture(t);
  const requests = () => env.calls.filter(({ url }) => new URL(url, globalThis.location.origin).pathname === '/research/primary-context.json');
  assert.equal(env.calls.length, 0, 'Mounting the optional context must not acquire anything');
  await env.panel.open(); await settle();
  assert.equal(requests().length, 1);
  assert.match(env.ui.research.textContent, /Primary-record paraphrase/);
  assert.match(env.ui.research.textContent, /expired/);
  assert.match(env.ui.research.textContent, /inference/);
  assert.doesNotMatch(env.ui.list.textContent, /Primary-record paraphrase/);
  const before = env.intelligenceCalls().length;
  env.ui.query.value = 'productivity'; env.ui.form.trigger('submit'); await settle();
  assert.match(env.ui.research.textContent, /Reference period 2026-Q2/);
  assert.doesNotMatch(env.ui.research.textContent, /General License U/);
  assert.equal(env.intelligenceCalls().length, before);
  assert.equal(env.demandCalls().length, 0);
  env.ui.category.value = 'disasters'; env.ui.category.trigger('change'); await settle();
  assert.match(env.ui.research.textContent, /No dated research context matches/);
  env.panel.close(); await env.panel.open(); await settle();
  assert.equal(requests().length, 1, 'Reopen uses validated memory and does not poll or refetch');
});

test('revalidation keeps unchanged cards and open source context mounted while dates and freshness remain honest', async (t) => {
  const body = Promise.withResolvers(), began = Promise.withResolvers(); let latest;
  const env = fixture(t, { intelligenceFetch: ({ payload, count }) => {
    payload.reports[0].timeMeaning = 'Fixture batch date is not a publication time.';
    latest = payload;
    if (count === 2) return { ok: true, json() { began.resolve(); return body.promise; } };
    return Response.json(payload);
  } });
  await env.panel.open(); await settle();
  const card = env.ui.list.children[0], context = elements(card).find((element) => element.tagName === 'details');
  context.open = true;
  assert.match(env.container.textContent, /Checks for new metadata every minute while this panel is open and visible/);
  assert.doesNotMatch(env.container.textContent, /continuous observation|live observation|real-time verified/i);
  env.ui.refresh.trigger('click'); await began.promise;
  assert.equal(env.ui.list.children[0], card);
  assert.equal(context.open, true);
  assert.match(env.ui.status.textContent, /Checking for updates · previous results remain available/);
  assert.equal(env.intelligenceCalls()[1].init.cache, 'no-cache');
  body.resolve(structuredClone(latest)); await settle();
  assert.equal(env.ui.list.children[0], card, 'An unchanged response must preserve the existing DOM and investigation state');
  assert.equal(context.open, true);
  assert.match(card.textContent, /GDELT batch/); assert.doesNotMatch(card.textContent, /Published /);
  assert.equal(env.demandCalls().length, 0);
});

test('a failed delivery retains existing cards and marks their source stale without inventing a new retrieval date', async (t) => {
  const env = fixture(t, { intelligenceFetch: ({ payload, count }) => {
    if (count > 1) throw new Error('Fixture reconnect pending');
    return Response.json(payload);
  } });
  await env.panel.open(); await settle();
  const card = env.ui.list.children[0], before = card.textContent;
  env.ui.refresh.trigger('click'); await settle();
  assert.equal(env.ui.list.children[0], card); assert.equal(card.textContent, before);
  assert.match(env.ui.status.textContent, /Fixture reconnect pending · Previous results remain displayed/);
  assert.match(env.container.textContent, /older cached data/);
  assert.match(env.container.textContent, /retained metadata keeps its original dates/);
  assert.equal(env.demandCalls().length, 0);
});
