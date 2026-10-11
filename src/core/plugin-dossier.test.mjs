import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginDossierPanel, normalizePluginDossier, PLUGIN_DOSSIER_LIMITS } from './plugin-dossier.js';
import { readFile } from 'node:fs/promises';
import { collectEurostatGasOrigins } from '../../server/hosted/eurostat-gas-origins.js';
import { collectEcbPress } from '../../worker/plugins/ecb-press.js';

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
}
const elements = (el) => [el, ...el.children.filter((child) => typeof child === 'object').flatMap(elements)];
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
function fixture(fetchImpl = async (url) => Response.json(url.startsWith('/api/publications') ? publications() : gas())) {
  const listeners = new Map(), timers = new Map(); let id = 0, now = 0, feedCreates = 0, feedOpens = 0, feedCloses = 0, feedDestroys = 0;
  const documentRef = { hidden: false, createElement: (tag) => new Element(tag, documentRef),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  const container = documentRef.createElement('div'), requests = [];
  const panel = createPluginDossierPanel({ container, documentRef, windowRef: null, now: () => now,
    setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    fetchImpl: (...args) => { requests.push(args); return fetchImpl(...args); },
    createFeed: async () => { feedCreates++; return { open() { feedOpens++; return true; }, close() { feedCloses++; }, setSceneMode() {}, destroy() { feedDestroys++; } }; } });
  return { panel, container, documentRef, timers, requests, stats: () => ({ feedCreates, feedOpens, feedCloses, feedDestroys }),
    advance(ms) { now += ms; }, visibility(hidden) { documentRef.hidden = hidden; for (const fn of listeners.get('visibilitychange') || []) fn(); } };
}

test('closed construction and selection do not fetch; one context source owns lazy delivery and opening a dossier preserves historical UTC semantics', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0); assert.equal(f.stats().feedCreates, 0);
  await f.panel.select('gas'); assert.equal(f.requests.length, 0); f.panel.setSceneMode('history'); await f.panel.open();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][0], '/api/dossiers/belgium-natural-gas-origins'); assert.equal(f.stats().feedCreates, 0);
  assert.match(f.container.textContent, /Annual reported imports · 2024/); assert.match(f.container.textContent, /not a historical globe layer/);
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
  assert.match(f.container.textContent, /740,439\.9 TJ_GCV/); assert.match(f.container.textContent, /33\.21%/); assert.match(f.container.textContent, /Annual reported imports · 2024/); f.panel.destroy();
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
