import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginDossierPanel, normalizePluginDossier, PLUGIN_DOSSIER_LIMITS } from './plugin-dossier.js';
import { readFile } from 'node:fs/promises';
import { collectEurostatGasOrigins } from '../../server/hosted/eurostat-gas-origins.js';
import { collectEcbPress } from '../../worker/plugins/ecb-press.js';
import { pluginFactsDigest } from './plugin-evidence.js';
import { collectEcPress } from '../../worker/plugins/ec-press.js';

class Element {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = new Map(); this.attributes = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...items) { for (const item of items) { if (typeof item === 'object') item.parentElement = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  trigger(type) { for (const fn of this.listeners.get(type) || []) fn(); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelector(selector) { return elements(this).find(el => el !== this && selector.startsWith('.') && el.className === selector.slice(1)) || null; }
}
const elements = (el) => [el, ...el.children.filter((child) => typeof child === 'object').flatMap(elements)];
const visibleText = el => el.hidden ? '' : el._text + (el.tagName === 'details' && !el.open ?
  el.children.filter(child => child.tagName === 'summary') : el.children).map(child => typeof child === 'string' ? child : visibleText(child)).join('');
const waitFor = async (condition, label) => {
  const deadline = performance.now() + 2000;
  while (!condition()) { if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 1)); }
};
const clone = (value) => structuredClone(value);
const receipt = { id: `receipt:${'e'.repeat(64)}`, capturedAt: '2026-10-12T04:00:00.000Z', recordedAt: '2026-10-12T04:01:00.000Z',
  sourceUpdatedAt: '2026-10-09T21:00:00.000Z', factsDigest: 'a'.repeat(64), rawSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64) };
function gas() {
  return { schemaVersion: 1, configured: true, available: true, plugin: { id: 'eurostat-gas-origins-v1', scopeId: 'belgium-natural-gas-origins', name: 'Eurostat', sourceUrl: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ti_gas' },
    receipt: clone(receipt), check: { checkedAt: receipt.capturedAt }, artifact: { schemaVersion: 1, kind: 'dataset-dossier', dossierId: 'belgium-natural-gas-origins',
      source: { url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ti_gas', datasetUrl: 'https://ec.europa.eu/eurostat/databrowser/view/nrg_ti_gas/default/table' },
      reportingCountry: { code: 'BE' }, resource: { code: 'G3000' }, unit: { code: 'TJ_GCV', label: 'Terajoule (gross calorific value - GCV)' }, referenceYears: ['2024'], latestAvailableYear: '2024',
      years: [{ year: '2024', period: { from: '2024-01-01T00:00:00.000Z', until: '2025-01-01T00:00:00.000Z', meaning: 'calendar-year' }, total: { value: 100, status: null },
        shares: [{ partner: { code: 'NO', label: 'Norway', type: 'country-or-territory' }, quantity: 40, sharePercent: 40, status: null }],
        coverage: { partnerRows: 3, missingRows: 0, flaggedRows: 0, reconciled: true }, omittedShareRows: 0 }],
      formula: '100 × reported partner quantity / reported TOTAL in the same year, product and unit',
      limitations: 'Annual reported imports by country of ultimate origin. These reference-year quantities are not current supply, consumption dependency or shipment routes.' } };
}
function publications() {
  return { schemaVersion: 1, configured: true, available: true, plugin: { id: 'ecb-press-v1', scopeId: 'ecb-institutional-press-en-v1', name: 'European Central Bank', sourceUrl: 'https://www.ecb.europa.eu/rss/press.html' },
    receipt: clone(receipt), check: null, artifact: { schemaVersion: 1, kind: 'publication-feed-overview', pluginId: 'ecb-press-v1', scopeId: 'ecb-institutional-press-en-v1' },
    items: [{ itemId: 'publication:test', revision: 'd'.repeat(64), kind: 'original-publication', title: 'Institutional release <img src=x>',
      url: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.test.en.html', sourceRecordId: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.test.en.html',
      publishedAt: '2026-10-11T12:00:00.000Z', publishedPrecision: 'second', firstRecordedAt: receipt.recordedAt, lastRecordedAt: receipt.recordedAt,
      evidence: { ...clone(receipt), locator: { kind: 'rss-guid', guid: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.test.en.html' } } }],
    counts: { returned: 1, more: true } };
}
function fixture(fetchImpl = async (url) => Response.json(url.startsWith('/api/publications') ? publications() : gas()), options = {}) {
  const listeners = new Map(), timers = new Map(); let id = 0, now = 0, feedCreates = 0, feedOpens = 0, feedCloses = 0, feedDestroys = 0;
  const updates = new Set();
  const documentRef = { hidden: false, createElement: (tag) => new Element(tag, documentRef), createElementNS: (_namespace, tag) => new Element(tag, documentRef),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  const container = documentRef.createElement('div'), requests = [];
  const panel = createPluginDossierPanel({ container, documentRef, windowRef: null, now: () => now, ...options,
    subscribeUpdates(listener) { updates.add(listener); return () => updates.delete(listener); },
    setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    fetchImpl: (...args) => { requests.push(args); return fetchImpl(...args); },
    createFeed: async () => { feedCreates++; return { open() { feedOpens++; return true; }, close() { feedCloses++; }, setSceneMode() {}, destroy() { feedDestroys++; } }; } });
  return { panel, container, documentRef, timers, requests, stats: () => ({ feedCreates, feedOpens, feedCloses, feedDestroys }),
    advance(ms) { now += ms; }, emit(event) { for (const listener of updates) listener(event); }, updateListeners: updates,
    visibility(hidden) { documentRef.hidden = hidden; for (const fn of listeners.get('visibilitychange') || []) fn(); } };
}
const update = (payload, fence) => ({ type: 'plugin', schemaVersion: 1, pluginId: payload.plugin.id, scopeId: payload.plugin.scopeId,
  receiptId: payload.receipt.id, fence, factsDigest: payload.receipt.factsDigest, recordedAt: payload.receipt.recordedAt });
test('purpose navigation remembers the publication source and only the visible selected view acquires stored data', async () => {
  const ec = await commission(), f = fixture(async url => Response.json(url.includes('plugin=ec-press-v1') ? ec : url.startsWith('/api/publications') ? publications() : gas()));
  const nav = elements(f.container).find(el => el.className === 'context-navigation');
  const chooser = elements(f.container).find(el => el.attributes['aria-label'] === 'Context source');
  const publicationsButton = nav.children.find(el => el.textContent === 'Publications'), dataButton = nav.children.find(el => el.textContent === 'Datasets');
  assert.deepEqual(nav.children.map(el => el.textContent), ['Reports', 'Datasets', 'Publications']);
  publicationsButton.trigger('click'); assert.equal(f.panel.getView(), 'publications'); assert.equal(f.requests.length, 0);
  await f.panel.open(); assert.equal(f.requests[0][0], '/api/publications?plugin=ecb-press-v1&limit=20');
  assert.equal(chooser.attributes['aria-label'], 'Publication source'); assert.equal(chooser.parentElement.hidden, false);
  chooser.value = 'commission'; chooser.trigger('change');
  await waitFor(() => f.requests.length === 2 && visibleText(f.container).includes(ec.items.find(item => item.documentReference === 'statement_26_2127').title), 'Retained Commission source');
  assert.equal(f.panel.getView(), 'commission'); assert.equal(f.requests[1][0], '/api/publications?plugin=ec-press-v1&limit=20');
  dataButton.trigger('click'); await waitFor(() => f.requests.length === 3, 'Dataset source'); assert.equal(chooser.parentElement.hidden, true);
  publicationsButton.trigger('click'); await waitFor(() => f.panel.getView() === 'commission', 'Remembered publication');
  assert.equal(chooser.value, 'commission'); assert.equal(f.requests.length, 3, 'A compatible retained source cache serves the revisit');
  f.panel.close(); chooser.value = 'publications'; chooser.trigger('change'); assert.equal(f.requests.length, 3);
  f.panel.destroy(); assert.equal(chooser.listeners.get('change').size, 0);
});
function edition(payload, marker, facts = payload.receipt.factsDigest) {
  const value = clone(payload), at = '2026-10-12T04:02:00.000Z';
  value.receipt = { ...value.receipt, id: `receipt:${marker.repeat(64)}`, rawSha256: marker.repeat(64), factsDigest: facts, capturedAt: at, recordedAt: at };
  value.check = { checkedAt: at }; return value;
}

test('closed construction and selection do not fetch; one context source owns lazy delivery and opening a dossier preserves historical UTC semantics', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0); assert.equal(f.stats().feedCreates, 0);
  await f.panel.select('gas'); assert.equal(f.requests.length, 0); f.panel.setSceneMode('history'); await f.panel.open();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][0], '/api/dossiers/belgium-natural-gas-origins'); assert.equal(f.stats().feedCreates, 0);
  assert.match(f.container.textContent, /Annual reported imports · 2024/); assert.match(f.container.textContent, /Current context · source dates do not follow map time/);
  assert.match(f.container.textContent, /2024 reported imports/); assert.match(f.container.textContent, /Source retrieved2026-10-12 04:00:00 UTC/);
  assert.match(f.container.textContent, /Source revised2026-10-09 21:00:00 UTC/);
  await f.panel.select('feeds'); assert.equal(f.stats().feedCreates, 1); assert.equal(f.stats().feedOpens, 1); assert.equal(f.timers.size, 0);
  await f.panel.select('publications'); assert.equal(f.stats().feedCloses, 1); assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1][0], '/api/publications?plugin=ecb-press-v1&limit=20'); assert.match(f.container.textContent, /Published 2026-10-11 12:00:00 UTC/);
  assert.match(f.container.textContent, /First retained 2026-10-12 04:01:00 UTC/); assert.match(f.container.textContent, /absence is not withdrawal/);
  assert.ok(!elements(f.container).some((el) => el.tagName === 'img'), 'Provider titles remain text');
  f.panel.destroy(); assert.equal(f.stats().feedDestroys, 1); assert.equal(f.timers.size, 0);
});

test('missing or flagged shares remain unavailable rather than zero; missing breakdown cannot be called reconciled or mismatched', async () => {
  const payload = gas(), year = payload.artifact.years[0]; year.total.value = null; year.total.status = 'p';
  year.shares[0] = { ...year.shares[0], status: 'e', sharePercent: null, shareUnavailableReason: 'Reported total is missing, nonpositive or flagged' };
  year.coverage = { partnerRows: 3, missingRows: 1, flaggedRows: 2, reconciled: null };
  const f = fixture(async () => Response.json(payload)); await f.panel.select('gas'); await f.panel.open();
  assert.match(f.container.textContent, /Reported total unavailable/); assert.match(f.container.textContent, /Source flag: e/);
  assert.match(f.container.textContent, /UnavailableReported total is missing/); assert.match(f.container.textContent, /Missing quantities are not treated as zero/);
  assert.doesNotMatch(f.container.textContent, /0%|do not reconcile/); f.panel.destroy();
});

test('a checking-only refresh preserves open evidence and table nodes while the actual checked timestamp updates', async () => {
  let checkedAt = receipt.capturedAt; const f = fixture(async () => { const payload = gas(); payload.check.checkedAt = checkedAt; return Response.json(payload); });
  await f.panel.select('gas'); await f.panel.open();
  const evidence = elements(f.container).find((el) => el.className === 'plugin-evidence'), table = elements(f.container).find((el) => el.tagName === 'table'); evidence.open = true;
  checkedAt = '2026-10-12T04:10:00.000Z'; f.advance(PLUGIN_DOSSIER_LIMITS.refreshMs); await f.panel.open();
  assert.equal(elements(f.container).find((el) => el.className === 'plugin-evidence'), evidence); assert.equal(evidence.open, true);
  assert.equal(elements(f.container).find((el) => el.tagName === 'table'), table); assert.match(evidence.textContent, /Stored source checked2026-10-12 04:10:00 UTC/);
  await f.panel.select('publications'); await f.panel.select('gas'); assert.equal(f.requests.length, 3, 'Returning to a fresh retained view reuses its bounded memory cache'); f.panel.destroy();
});

test('switching or hiding aborts an obsolete request and a late response cannot replace the selected source', async () => {
  let resolveGas; const f = fixture(async (url) => url.startsWith('/api/dossiers') ? new Promise((resolve) => { resolveGas = resolve; }) : Response.json(publications()));
  await f.panel.select('gas'); const oldRead = f.panel.open(); const signal = f.requests[0][1].signal;
  await f.panel.select('publications'); assert.equal(signal.aborted, true); resolveGas(Response.json(gas())); await oldRead;
  assert.equal(f.panel.getView(), 'publications'); assert.match(f.container.textContent, /ECB institutional releases/); assert.doesNotMatch(f.container.textContent, /2024 reported imports/);
  f.visibility(true); assert.equal(f.timers.size, 0); const count = f.requests.length; await f.panel.open(); assert.equal(f.requests.length, count);
  f.panel.close(); f.visibility(false); assert.equal(f.requests.length, count); f.panel.destroy();
});

test('a failed or oversized refresh retains dated prior context and reports failure without a generic retry loop', async () => {
  let fail = false; const f = fixture(async () => fail ? new Response('x'.repeat(PLUGIN_DOSSIER_LIMITS.bytes + 1)) : Response.json(gas()));
  await f.panel.select('gas'); await f.panel.open(); const table = elements(f.container).find((el) => el.tagName === 'table');
  fail = true; f.advance(PLUGIN_DOSSIER_LIMITS.refreshMs); assert.equal(await f.panel.open(), false);
  assert.equal(elements(f.container).find((el) => el.tagName === 'table'), table); assert.match(f.container.textContent, /exceeds its delivery bound/);
  assert.match(f.container.textContent, /Previous retained context keeps its original dates/); assert.equal(f.requests.length, 2);
  f.panel.close(); assert.equal(f.timers.size, 0); f.panel.destroy();
});

test('unavailable projections give their stored explanation without fetching a provider; foreign URLs, kinds and duplicate publications fail closed', async () => {
  const unavailable = { ...gas(), available: false, receipt: null, artifact: null, explanation: 'No retained annual evidence exists yet.' };
  const f = fixture(async () => Response.json(unavailable)); await f.panel.select('gas'); await f.panel.open();
  assert.match(f.container.textContent, /No retained annual evidence exists yet/); assert.equal(f.requests.length, 1); f.panel.destroy();
  for (const mutate of [p => { p.items[0].url = 'javascript:alert(1)'; }, p => { p.items[0].url = 'https://www.ecb.europa.eu.evil.test/press/pr/date/2026/release'; },
    p => { p.items[0].kind = 'incident'; }, p => { p.items[0].publishedAt = '2026-02-30T00:00:00.000Z'; }, p => { p.items.push(p.items[0]); p.counts.returned = 2; }]) {
    const p = publications(); mutate(p); assert.throws(() => normalizePluginDossier(p, 'publications'));
  }
  const forged = gas(); forged.artifact.resource.code = 'LNG'; assert.throws(() => normalizePluginDossier(forged, 'gas'));
});

test('the reviewed Eurostat raw fixture and ECB exact double-slash institutional URLs are admitted without changing source identity or reporting dates', async () => {
  const bytes = await readFile(new URL('../../server/hosted/fixtures/eurostat-gas-belgium-2024.json', import.meta.url));
  const rawGas = await collectEurostatGasOrigins({ now: () => Date.parse(receipt.capturedAt),
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) });
  const gasPayload = { ...gas(), artifact: rawGas.artifact };
  normalizePluginDossier(gasPayload, 'gas');
  const f = fixture(async () => Response.json(gasPayload)); await f.panel.select('gas'); await f.panel.open();
  assert.match(f.container.textContent, /740,439\.9 TJ/); assert.match(f.container.textContent, /33\.21%/); assert.match(f.container.textContent, /Annual reported imports · 2024/); f.panel.destroy();
  const url = 'https://www.ecb.europa.eu//press/pr/date/2026/html/ecb.pr261007~6447350434.en.html';
  const xml = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>ECB - European Central Bank</title><link>https://www.ecb.europa.eu/</link><description>Official press feed</description><language>en</language><item><title>TEST ONLY institutional original</title><link>${url}</link><guid>${url}</guid><pubDate>Wed, 07 Oct 2026 10:00:00 +0200</pubDate></item></channel></rss>`;
  const ecb = await collectEcbPress({ now: () => Date.parse(receipt.capturedAt), fetchImpl: async () => new Response(xml, { headers: { 'content-type': 'application/rss+xml' } }) });
  const payload = publications(); payload.artifact = ecb.artifact;
  payload.items = ecb.canonicalFacts.items.map(({ sourceRevision, ...item }) => ({ ...item, revision: sourceRevision, firstRecordedAt: receipt.recordedAt, lastRecordedAt: receipt.recordedAt,
    evidence: { ...clone(receipt), locator: { kind: 'rss-guid', guid: item.sourceRecordId } } }));
  normalizePluginDossier(payload, 'publications'); assert.equal(payload.items[0].url, url);
  assert.equal(payload.items[0].publishedAt, '2026-10-07T08:00:00.000Z');
});

test('a retained publication absent from the latest rolling feed displays its own older source receipt, not the feed hashes', async () => {
  const payload = publications(), item = payload.items[0]; payload.artifact.items = [];
  const earlier = { id: `receipt:${'f'.repeat(64)}`, capturedAt: '2026-10-11T14:00:00.000Z', recordedAt: '2026-10-11T14:01:00.000Z',
    rawSha256: '1'.repeat(64), factsDigest: '2'.repeat(64), artifactSha256: '3'.repeat(64), sourceUpdatedAt: null, sourceVersion: 'RSS 2.0' };
  item.evidence = { ...earlier, locator: { kind: 'rss-guid', guid: item.sourceRecordId } }; item.firstRecordedAt = item.lastRecordedAt = earlier.recordedAt;
  const f = fixture(async () => Response.json(payload)); await f.panel.select('publications'); await f.panel.open();
  const own = elements(f.container).find((el) => el.className === 'plugin-item-evidence'), feed = elements(f.container).find((el) => el.className === 'plugin-evidence');
  assert.ok(!own.open); assert.ok(!feed.open); assert.match(feed.children[0].textContent, /^Latest feed receipt$/);
  assert.match(own.textContent, /Receipt recorded2026-10-11 14:01:00 UTC/); assert.ok(own.textContent.includes(earlier.id));
  for (const field of ['rawSha256', 'factsDigest', 'artifactSha256']) { assert.ok(own.textContent.includes(earlier[field])); assert.ok(!own.textContent.includes(payload.receipt[field])); assert.ok(feed.textContent.includes(payload.receipt[field])); }
  assert.ok(own.textContent.includes(`RSS GUID locator${item.sourceRecordId}`)); f.panel.destroy();
  for (const mutate of [p => { p.items[0].evidence.id = 'receipt:invalid'; }, p => { p.items[0].evidence.rawSha256 = 'not-a-digest'; },
    p => { p.items[0].evidence.recordedAt = '2026-02-30T00:00:00.000Z'; }, p => { p.items[0].evidence.locator.guid = 'https://www.ecb.europa.eu/other'; },
    p => { p.items[0].evidence.recordedAt = p.receipt.recordedAt; }]) {
    const forged = clone(payload); mutate(forged); assert.throws(() => normalizePluginDossier(forged, 'publications'), /source receipt/);
  }
});

test('the primary gas view uses readable TJ and retains precise units, diagnostics and methodology in one closed disclosure', async () => {
  const payload = gas(); payload.artifact.years[0].coverage.partnerRows = 167;
  const f = fixture(async () => Response.json(payload)); await f.panel.select('gas'); await f.panel.open();
  const source = elements(f.container).find(el => el.className === 'plugin-evidence'); assert.ok(!source.open);
  assert.match(visibleText(f.container), /2024 reported imports/); assert.match(visibleText(f.container), /100 TJ/);
  assert.match(visibleText(f.container), /Annual imports by reported country of origin/);
  assert.doesNotMatch(visibleText(f.container), /TJ_GCV|167 partner rows|consumption dependency|shipment routes/);
  assert.equal(elements(f.container).find(el => el.className === 'plugin-total').title, 'terajoules · gross calorific value');
  source.open = true; assert.match(visibleText(f.container), /terajoules · gross calorific value/);
  assert.match(visibleText(f.container), /TJ_GCV|167 partner rows/); assert.ok(source.textContent.includes(payload.artifact.limitations));
  assert.ok(source.textContent.includes(payload.artifact.formula)); f.panel.destroy();
});

test('typed events invalidate only their fixed source and an unchanged-facts receipt preserves table, disclosure and focus while evidence renews', async () => {
  let current = gas(); const f = fixture(async url => Response.json(url.startsWith('/api/publications') ? publications() : current));
  await f.panel.select('gas'); await f.panel.open();
  const evidence = elements(f.container).find(el => el.className === 'plugin-evidence'), table = elements(f.container).find(el => el.tagName === 'table');
  evidence.open = true; f.documentRef.activeElement = evidence.children[0];
  f.emit(update(publications(), 1)); f.emit(update(gas(), 1)); f.emit({ type: 'collection' });
  f.emit({ ...update(gas(), 2), scopeId: 'foreign' }); f.emit({ ...update(gas(), 2), sourceUrl: 'https://unreviewed.example/' });
  assert.equal(f.requests.length, 1);
  current = edition(gas(), 'f'); const signal = update(current, 2); f.emit(signal); f.emit(signal); await f.panel.open();
  assert.equal(f.requests.length, 2); assert.equal(elements(f.container).find(el => el.tagName === 'table'), table);
  assert.equal(elements(f.container).find(el => el.className === 'plugin-evidence'), evidence); assert.equal(evidence.open, true);
  assert.equal(f.documentRef.activeElement, evidence.children[0]); assert.ok(evidence.textContent.includes(current.receipt.rawSha256));
  assert.match(evidence.textContent, /Receipt recorded2026-10-12 04:02:00 UTC/);
  f.emit(update(gas(), 1)); f.emit({ ...update(current, 3), receiptId: current.receipt.id }); assert.equal(f.requests.length, 2);
  await f.panel.select('publications'); assert.equal(f.requests.length, 3); f.panel.destroy(); assert.equal(f.updateListeners.size, 0);
});

test('closed and hidden dossiers remember invalidation without fetching; reopening refreshes stale cache and fallback polling remains bounded', async () => {
  let current = gas(); const f = fixture(async () => Response.json(current)); await f.panel.select('gas');
  current = edition(current, 'f'); f.emit(update(current, 1)); assert.equal(f.requests.length, 0);
  await f.panel.open(); assert.equal(f.requests.length, 1); f.visibility(true);
  current = edition(current, '1'); f.emit(update(current, 2)); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
  f.visibility(false); await f.panel.open(); assert.equal(f.requests.length, 2);
  f.panel.close(); current = edition(current, '2'); f.emit(update(current, 3)); assert.equal(f.requests.length, 2);
  await f.panel.open(); assert.equal(f.requests.length, 3); assert.equal(f.timers.size, 1);
  f.advance(PLUGIN_DOSSIER_LIMITS.refreshMs); const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.fn(); await f.panel.open();
  assert.equal(f.requests.length, 4); assert.equal(f.timers.size, 1);
  f.panel.destroy(); f.emit(update(edition(current, '3'), 4)); assert.equal(f.requests.length, 4); assert.equal(f.timers.size, 0); assert.equal(f.updateListeners.size, 0);
});

test('events during an in-flight stored read coalesce to one newest follow-up and avoid it when the first response already includes that receipt', async () => {
  for (const alreadyLatest of [false, true]) {
    const initial = gas(), middle = edition(initial, 'f', 'b'.repeat(64)), latest = edition(initial, '1', 'c'.repeat(64));
    let reads = 0, resolvePending;
    const f = fixture(async () => { reads++; if (reads === 1) return Response.json(initial);
      if (reads === 2) return new Promise(resolve => { resolvePending = resolve; }); return Response.json(latest); });
    await f.panel.select('gas'); await f.panel.open(); f.emit(update(middle, 2));
    await waitFor(() => typeof resolvePending === 'function', 'the in-flight stored view read');
    f.emit(update(latest, 3)); f.emit(update(latest, 3)); f.emit(update(publications(), 1));
    assert.equal(f.requests.length, 2); resolvePending(Response.json(alreadyLatest ? latest : middle));
    await waitFor(() => f.container.textContent.includes(latest.receipt.rawSha256), 'the newest retained receipt');
    assert.equal(f.requests.length, alreadyLatest ? 2 : 3); f.emit(update(latest, 3)); assert.equal(f.requests.length, alreadyLatest ? 2 : 3);
    f.panel.destroy();
  }
});

test('unchanged publication facts retain article/disclosure nodes while each item source receipt and retained dates update in place', async () => {
  let current = publications(); const f = fixture(async () => Response.json(current)); await f.panel.select('publications'); await f.panel.open();
  const article = elements(f.container).find(el => el.className === 'plugin-publication'), source = elements(f.container).find(el => el.className === 'plugin-item-evidence');
  source.open = true; f.documentRef.activeElement = source.children[0];
  current = edition(current, 'f', 'b'.repeat(64)); current.items[0].lastRecordedAt = current.receipt.recordedAt;
  current.items[0].evidence = { ...clone(current.receipt), locator: { kind: 'rss-guid', guid: current.items[0].sourceRecordId } };
  f.emit(update(current, 2)); await f.panel.open();
  assert.equal(elements(f.container).find(el => el.className === 'plugin-publication'), article);
  assert.equal(elements(f.container).find(el => el.className === 'plugin-item-evidence'), source); assert.equal(source.open, true);
  assert.equal(f.documentRef.activeElement, source.children[0]); assert.ok(source.textContent.includes(current.receipt.id));
  assert.match(source.textContent, /latest retained 2026-10-12 04:02:00 UTC/); assert.match(source.textContent, /First retained 2026-10-12 04:01:00 UTC/);
  f.panel.destroy();
});

async function scenarioEnvelope(mutate = () => {}, marker = 'a') {
  const raw = JSON.parse(await readFile(new URL('../../server/hosted/fixtures/eurostat-gas-belgium-2024.json', import.meta.url), 'utf8')); mutate(raw);
  const capture = await collectEurostatGasOrigins({ now: () => Date.parse(receipt.capturedAt),
    fetchImpl: async () => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }) });
  return { schemaVersion: 1, available: true, configured: true,
    plugin: { id: capture.pluginId, scopeId: capture.scopeId, kind: 'dataset', sourceUrl: capture.sourceUrl, name: 'Eurostat' },
    receipt: { ...clone(receipt), id: `receipt:${marker.repeat(64)}`, sourceVersion: capture.sourceVersion, sourceUpdatedAt: capture.sourceUpdatedAt,
      factsDigest: capture.factsDigest, rawSha256: capture.raw.sha256, artifactSha256: await pluginFactsDigest(capture.artifact) },
    check: { checkedAt: receipt.capturedAt }, artifact: capture.artifact };
}
const scenarioElements = container => {
  const details = elements(container).find(el => el.className === 'plugin-evidence plugin-scenario'), all = elements(details);
  return { details, origin: all.find(el => el.name === 'gas-scenario-origin'), reduction: all.find(el => el.name === 'gas-scenario-reduction'),
    replacement: all.find(el => el.name === 'gas-scenario-replacement'), output: all.find(el => el.className === 'plugin-scenario-result'),
    status: all.find(el => el.className === 'plugin-note plugin-scenario-status'), proof: all.find(el => el.className === 'plugin-item-evidence') };
};

test('the closed scenario opens against actual retained 2024 evidence, binds its source receipt and calculates controls without requests', async () => {
  const payload = await scenarioEnvelope(), before = JSON.stringify(payload), f = fixture(async () => Response.json(payload));
  await f.panel.select('gas'); await f.panel.open(); const s = scenarioElements(f.container);
  assert.ok(!s.details.open); assert.ok(s.output.hidden); assert.match(visibleText(f.container), /Explore a scenario/);
  assert.equal(s.origin.attributes['aria-label'], 'Reported origin');
  assert.equal(s.reduction.attributes['aria-label'], 'Reduce this origin’s imports (%)');
  assert.equal(s.replacement.attributes['aria-label'], 'Replace the lost volume (%)');
  assert.doesNotMatch(visibleText(f.container), /Hypothetical result|Remaining gap/);
  assert.equal(s.origin.value, 'NO'); assert.equal(s.origin.children.length, 10); assert.ok(s.origin.children.every(option => /^[A-Z]{2}$/.test(option.value)));
  s.details.open = true; s.details.trigger('toggle'); await waitFor(() => !s.output.hidden, 'the local annual scenario');
  assert.match(visibleText(s.details), /Hypothetical · 2024 reported imports/);
  assert.match(visibleText(s.details), /Lost origin volume61,473\.3 TJAssumed replacement24,589\.32 TJRemaining gap36,883\.98 TJGap as share of 2024 TOTAL4\.98%/);
  assert.ok(!s.proof.open); s.proof.open = true;
  assert.ok(s.proof.textContent.includes(payload.receipt.id)); assert.ok(s.proof.textContent.includes(payload.artifact.inputRevision));
  assert.match(s.proof.textContent, /Lost volume replaced40%/); assert.match(s.proof.textContent, /Origin cell\/value\/29TOTAL cell\/value\/165/);
  s.replacement.value = '100'; s.replacement.trigger('input'); assert.ok(s.output.hidden);
  await waitFor(() => !s.output.hidden, 'the complete-replacement scenario'); assert.match(s.output.textContent, /Remaining gap0 TJGap as share of 2024 TOTAL0%/);
  s.reduction.value = ''; s.reduction.trigger('input'); await waitFor(() => s.status.textContent.startsWith('Scenario unavailable:'), 'invalid empty assumptions');
  assert.ok(s.output.hidden); assert.match(s.status.textContent, /finite reduction\/replacement percentages/);
  s.reduction.value = '101'; s.reduction.trigger('input'); await waitFor(() => s.status.textContent.startsWith('Scenario unavailable:'), 'out-of-range assumptions'); assert.ok(s.output.hidden);
  s.origin.value = 'RU'; s.reduction.value = '0'; s.reduction.trigger('input'); await waitFor(() => !s.output.hidden, 'the zero-reduction scenario');
  assert.match(s.output.textContent, /Lost origin volume0 TJ/); assert.match(s.proof.textContent, /OriginRussia/);
  assert.equal(f.requests.length, 1); assert.equal(JSON.stringify(payload), before, 'Scenario controls do not mutate source evidence'); f.panel.destroy();
});

test('checking-only refresh preserves a scenario, while newer evidence clears and recomputes its retained baseline with assumptions and focus preserved', async () => {
  let current = await scenarioEnvelope(), resolveRead, hold = false;
  const f = fixture(async () => hold ? new Promise(resolve => { resolveRead = resolve; }) : Response.json(current));
  await f.panel.select('gas'); await f.panel.open(); const s = scenarioElements(f.container);
  s.details.open = true; s.details.trigger('toggle'); await waitFor(() => !s.output.hidden, 'initial scenario');
  s.proof.open = true; f.documentRef.activeElement = s.proof.children[0];
  const prior = s.output.textContent; current = clone(current); current.check.checkedAt = '2026-10-12T04:10:00.000Z';
  await f.panel.refresh(); await f.panel.open(); assert.equal(s.output.textContent, prior); assert.equal(scenarioElements(f.container).details, s.details);
  current = await scenarioEnvelope(raw => { raw.value['29'] -= 10000; raw.value['45'] += 10000; }, 'b');
  hold = true; f.emit(update(current, 2)); assert.ok(s.output.hidden); assert.match(s.status.textContent, /Waiting for the updated 2024 baseline/);
  await waitFor(() => typeof resolveRead === 'function', 'the new stored baseline read'); hold = false; resolveRead(Response.json(current));
  await waitFor(() => !s.output.hidden && s.proof.textContent.includes(current.receipt.id), 'the corrected baseline scenario');
  assert.equal(scenarioElements(f.container).details, s.details); assert.equal(s.details.open, true); assert.equal(s.proof.open, true);
  assert.equal(f.documentRef.activeElement, s.proof.children[0]); assert.equal(s.origin.value, 'NO'); assert.equal(s.reduction.value, '25'); assert.equal(s.replacement.value, '40');
  assert.match(s.status.textContent, /Stored evidence updated; scenario recalculated/);
  assert.match(s.output.textContent, /Lost origin volume58,973\.3 TJAssumed replacement23,589\.32 TJRemaining gap35,383\.98 TJ/);
  assert.equal(f.requests.length, 3); f.panel.destroy();
});

test('scenario gaps fail closed and asynchronous local calculations cannot overwrite newer assumptions or a destroyed panel', async () => {
  const payload = await scenarioEnvelope(raw => { raw.status = { '29': 'e' }; });
  const f = fixture(async () => Response.json(payload)); await f.panel.select('gas'); await f.panel.open(); let s = scenarioElements(f.container);
  assert.ok(!s.origin.children.some(option => option.value === 'NO'), 'Flagged source rows are not offered as selectable origins');
  s.details.open = true; s.details.trigger('toggle'); await waitFor(() => s.status.textContent.startsWith('Scenario unavailable:'), 'a flagged-breakdown rejection');
  assert.ok(s.output.hidden); assert.match(s.status.textContent, /completed, unflagged and reconciled/); f.panel.destroy();
  const valid = await scenarioEnvelope(), g = fixture(async () => Response.json(valid)); await g.panel.select('gas'); await g.panel.open(); s = scenarioElements(g.container);
  s.details.open = true; s.details.trigger('toggle'); s.reduction.value = '0'; s.reduction.trigger('input');
  await waitFor(() => !s.output.hidden, 'the newest local assumptions'); assert.match(s.output.textContent, /Lost origin volume0 TJ/);
  s.reduction.value = '25'; s.reduction.trigger('input'); assert.ok(s.output.hidden); g.panel.destroy();
  await new Promise(resolve => setImmediate(resolve)); assert.ok(s.output.hidden); assert.equal(g.container.textContent, ''); assert.equal(g.requests.length, 1);
});

async function commission() {
  const bytes = await readFile(new URL('../../server/hosted/fixtures/ec-press-20261012.xml', import.meta.url));
  const capture = await collectEcPress({ now: () => Date.parse(receipt.capturedAt),
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/rss+xml' } }) });
  const own = { ...clone(receipt), sourceUpdatedAt: capture.sourceUpdatedAt, sourceVersion: capture.sourceVersion,
    rawSha256: capture.raw.sha256, factsDigest: capture.factsDigest, artifactSha256: await pluginFactsDigest(capture.artifact) };
  return { schemaVersion: 1, available: true, configured: true,
    plugin: { id: capture.pluginId, scopeId: capture.scopeId, kind: 'publication-feed', name: 'European Commission publication metadata', sourceUrl: capture.sourceUrl },
    receipt: own, check: { checkedAt: receipt.capturedAt }, artifact: capture.artifact,
    items: capture.canonicalFacts.items.map(({ sourceRevision, ...item }) => ({ ...item, revision: sourceRevision, firstRecordedAt: own.recordedAt,
      lastRecordedAt: own.recordedAt, evidence: { ...clone(own), locator: { kind: 'rss-guid', guid: item.sourceRecordId } } })),
    counts: { returned: capture.canonicalFacts.items.length, more: false } };
}

test('Commission publications lazily preserve actual source metadata, visible attribution and dates while source evidence stays closed', async () => {
  const payload = await commission(), f = fixture(async () => Response.json(payload));
  await f.panel.select('commission'); assert.equal(f.requests.length, 0); await f.panel.open();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][0], '/api/publications?plugin=ec-press-v1&limit=20');
  assert.equal(elements(f.container).find(el => el.className === 'context-navigation').children.length, 3);
  assert.match(visibleText(f.container), /Source: European Commission \/ European Union/); assert.match(visibleText(f.container), /document body language is unknown/);
  assert.match(visibleText(f.container), /Published 2026-10-09 12:14:20 UTC/); assert.match(visibleText(f.container), /Statement · statement_26_2127/);
  assert.doesNotMatch(visibleText(f.container), /SHA-256|RSS GUID|POLICY_AREA|Raw publication date|independent corroboration/);
  const article = elements(f.container).find(el => el.className === 'plugin-publication' && el.textContent.includes('statement_26_2127'));
  const proof = elements(article).find(el => el.className === 'plugin-item-evidence'); assert.ok(!proof.open); proof.open = true;
  assert.match(visibleText(proof), /Source publication dateFri, 09 Oct 2026 12:14:20 GMT/); assert.match(visibleText(proof), /Source policy tagsPOLICY_AREA=GROWTH,JFRC/);
  assert.ok(proof.textContent.includes(payload.items.find(item => item.documentReference === 'statement_26_2127').evidence.rawSha256));
  assert.equal(elements(article).find(el => el.tagName === 'a').href, 'https://ec.europa.eu/commission/presscorner/detail/en/statement_26_2127');
  f.panel.destroy();
  for (const mutate of [p => { p.plugin.sourceUrl += '&foreign=1'; }, p => { p.artifact.scopeId = 'other-scope'; },
    p => { p.items[0].documentReference = 'statement_26_999999'; }, p => { p.items[0].documentType = 'incident'; },
    p => { p.items[0].publisherId = 'independent-media'; }, p => { p.items[0].url = p.items[0].url.replace('/detail/en/', '/detail/fr/'); },
    p => { p.items[0].publishedRaw = 'Sun, 11 Oct 2026 15:26:33 GMT'; }, p => { p.items[0].categories = ['GEOMETRY=50,4']; },
    p => { p.items[0].categories = ['POLICY_AREA=GROWTH', 'POLICY_AREA=GROWTH']; }]) {
    const invalid = clone(payload); mutate(invalid); assert.throws(() => normalizePluginDossier(invalid, 'commission'));
  }
});

test('Commission events are source-isolated and receipt renewal preserves each publication’s own evidence and focus', async () => {
  let current = await commission(); const older = current.items.find(item => item.documentReference === 'statement_26_2127');
  older.firstRecordedAt = older.lastRecordedAt = '2026-10-11T14:00:00.000Z';
  older.evidence = { ...clone(older.evidence), id: `receipt:${'1'.repeat(64)}`, capturedAt: '2026-10-11T13:59:00.000Z', recordedAt: older.lastRecordedAt,
    rawSha256: '2'.repeat(64), factsDigest: '3'.repeat(64), artifactSha256: '4'.repeat(64) };
  current.artifact.items = current.artifact.items.filter(item => item.itemId !== older.itemId);
  const f = fixture(async url => Response.json(url.includes('plugin=ec-press-v1') ? current : gas())); await f.panel.select('gas'); await f.panel.open();
  f.emit(update(current, 1)); assert.equal(f.requests.length, 1); await f.panel.select('commission'); assert.equal(f.requests.length, 2);
  const article = elements(f.container).find(el => el.className === 'plugin-publication' && el.textContent.includes('statement_26_2127'));
  const proof = elements(article).find(el => el.className === 'plugin-item-evidence'); proof.open = true; f.documentRef.activeElement = proof.children[0];
  assert.ok(proof.textContent.includes(older.evidence.id)); assert.ok(!proof.textContent.includes(current.receipt.rawSha256));
  f.emit(update(publications(), 1)); f.emit(update(gas(), 1)); assert.equal(f.requests.length, 2);
  current = edition(current, 'f', current.receipt.factsDigest); f.emit(update(current, 2)); await f.panel.open();
  assert.equal(f.requests.length, 3); assert.equal(elements(f.container).find(el => el.className === 'plugin-publication' && el.textContent.includes('statement_26_2127')), article);
  assert.equal(proof.open, true); assert.equal(f.documentRef.activeElement, proof.children[0]); assert.ok(proof.textContent.includes(older.evidence.id));
  assert.ok(!proof.textContent.includes(current.receipt.rawSha256)); f.panel.destroy();
});

test('Inspect document is fixed-item-only and lazy; Back preserves the publication list, disclosure and focus', async t => {
  const { documentFixture, syntheticPdf, syntheticAnalysis } = await import('../../worker/document-investigation-fixture.mjs');
  const { claimDocumentInvestigation: claim, retainDocumentRaw: retain, completeDocumentInvestigation: complete, readDocumentAnalysis: read } = await import('../../worker/document-investigations.js');
  const { readPluginPublications } = await import('../../worker/plugins/store.js');
  const stored = await documentFixture(t); await stored.source('A', { other: true });
  const job = (await claim(stored.env, { workerId: 'test-only-ui', claimId: '1'.repeat(32) }, { now: stored.now })).job;
  const rawBytes = syntheticPdf('UI'); stored.advance(1000);
  const raw = await retain(stored.env, { jobId: job.jobId, fence: job.fence, leaseToken: job.leaseToken, acquiredAt: stored.stamp(), rawBytes }, { now: stored.now });
  stored.advance(1000); await complete(stored.env, { jobId: job.jobId, fence: job.fence, leaseToken: job.leaseToken, rawReceiptId: raw.receipt.id, ...await syntheticAnalysis(rawBytes) }, { now: stored.now });
  let feed = await readPluginPublications(stored.env, 'ec-press-v1', { now: stored.now }), document = await read(stored.env, {}, { now: stored.now }), imports = 0;
  stored.reset();
  const f = fixture(async url => Response.json(url.startsWith('/api/documents/') ? document : feed), {
    loadDocument: () => { imports++; return import('./document-dossier.js'); }
  });
  await f.panel.select('commission'); assert.equal(imports, 0); assert.equal(f.requests.length, 0); await f.panel.open();
  const buttons = elements(f.container).filter(el => el.tagName === 'button' && el.textContent === 'Inspect document'); assert.equal(buttons.length, 1); assert.equal(imports, 0);
  const article = buttons[0].parentElement, evidence = elements(article).find(el => el.className === 'plugin-item-evidence'); evidence.open = true;
  const nav = elements(f.container).find(el => el.className === 'context-navigation'), source = elements(f.container).find(el => el.className === 'context-source');
  const title = elements(f.container).find(el => el.className === 'plugin-title'), subtitle = elements(f.container).find(el => el.className === 'plugin-subtitle');
  assert.equal(Boolean(nav.hidden), false); assert.equal(source.hidden, false);
  f.panel.setSceneMode('history'); buttons[0].trigger('click');
  await waitFor(() => elements(f.container).filter(el => el.className === 'document-statement').length === 4, 'the retained original examination');
  assert.equal(imports, 1); assert.equal(f.requests.length, 2); assert.equal(f.requests[1][0], '/api/documents/ec-statement-26-2127');
  assert.match(visibleText(f.container), /Source statements · not independently corroborated/); assert.match(visibleText(f.container), /Current context · source dates do not follow map time/);
  const documentHost = elements(f.container).find(el => el.className === 'plugin-document');
  assert.equal(nav.hidden, true); assert.equal(source.hidden, true); assert.equal(title.hidden, true); assert.equal(subtitle.hidden, true);
  assert.equal(Boolean(elements(f.container).find(el => el.className === 'plugin-refresh' && el.textContent === 'Refresh stored examination').hidden), false);
  assert.equal(f.documentRef.activeElement.textContent, 'Back to publications');
  const proof = elements(documentHost).find(el => el.className === 'plugin-evidence'); proof.open = true;
  f.emit(update(publications(), 1)); assert.equal(f.requests.length, 2);
  feed = edition(feed, 'f'); document = { ...document, bodyCheck: { ...document.bodyCheck, checkedAt: '2026-10-12T04:10:00.000Z' } };
  f.emit(update(feed, 1)); await waitFor(() => f.requests.length === 3, 'the source-isolated document invalidation'); await f.panel.open();
  assert.equal(f.requests[2][0], '/api/documents/ec-statement-26-2127'); assert.equal(elements(documentHost).find(el => el.className === 'plugin-evidence'), proof);
  assert.equal(proof.open, true); assert.equal(elements(article).find(el => el.className === 'plugin-item-evidence') === evidence, true);
  elements(documentHost).find(el => el.tagName === 'button' && el.textContent === 'Back to publications').trigger('click');
  await waitFor(() => f.requests.length === 4, 'the invalidated stored publication list'); await f.panel.open();
  assert.equal(documentHost.hidden, true); assert.equal(evidence.open, true); assert.equal(f.documentRef.activeElement, buttons[0]);
  assert.equal(nav.hidden, false); assert.equal(source.hidden, false); assert.equal(title.hidden, false); assert.equal(subtitle.hidden, false);
  assert.equal(title.textContent, 'European Commission publications'); assert.equal(subtitle.textContent, 'Original publication metadata · European Commission / European Union');
  assert.equal(stored.activity.providers.length, 0, 'public UI reads do not acquire');
  buttons[0].trigger('click'); await f.panel.open(); assert.equal(imports, 1); assert.equal(f.requests.length, 4, 'the same document reuses its bounded memory cache');
  f.panel.destroy(); assert.equal(f.timers.size, 0);
});

test('a late lazy document import cannot construct or fetch after source change, hiding or destruction', async () => {
  const ec = await commission();
  for (const close of [f => f.panel.select('publications'), f => f.visibility(true), f => f.panel.destroy()]) {
    let resolveImport, constructed = 0;
    const f = fixture(async url => Response.json(url.includes('plugin=ec-press-v1') ? ec : publications()), {
      loadDocument: () => new Promise(resolve => { resolveImport = resolve; })
    });
    await f.panel.select('commission'); await f.panel.open();
    elements(f.container).find(el => el.tagName === 'button' && el.textContent === 'Inspect document').trigger('click');
    await waitFor(() => typeof resolveImport === 'function', 'lazy import dispatch'); await close(f);
    resolveImport({ createDocumentDossier() { constructed++; assert.fail('an obsolete lazy import constructed a document view'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(constructed, 0); assert.equal(f.requests.filter(([url]) => url.startsWith('/api/documents/')).length, 0); f.panel.destroy();
  }
});

test('hiding an active document cancels its read and reopening or Back cannot be overwritten by late evidence', async () => {
  const ec = await commission(); let complete, signal;
  const f = fixture(async (url, options) => {
    if (!url.startsWith('/api/documents/')) return Response.json(ec);
    signal = options.signal; return new Promise(resolve => { complete = resolve; });
  });
  await f.panel.select('commission'); await f.panel.open();
  elements(f.container).find(el => el.tagName === 'button' && el.textContent === 'Inspect document').trigger('click');
  await waitFor(() => typeof complete === 'function', 'stored document read dispatch');
  f.visibility(true); assert.equal(signal.aborted, true);
  complete(Response.json({ schemaVersion: 1, configured: true, available: false, explanation: 'Late hidden response' }));
  await new Promise(resolve => setImmediate(resolve)); assert.doesNotMatch(f.container.textContent, /Late hidden response/);
  await f.panel.select('commission'); f.visibility(false); await f.panel.open();
  assert.equal(elements(f.container).find(el => el.className === 'plugin-document').hidden, true);
  assert.equal(f.requests.filter(([url]) => url.startsWith('/api/documents/')).length, 1); f.panel.destroy();
});
