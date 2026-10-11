import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePrimaryContext, filterPrimaryContext, createPrimaryContextLoader, renderPrimaryContextDetails,
  createPrimaryContextPanel, PRIMARY_CONTEXT_MAX_BYTES } from './primary-context.js';

const fixture = JSON.parse(await readFile(new URL('../../public/research/primary-context.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-11T12:00:00Z'), origin = 'https://example.com', url = '/earth/research/primary-context.json';
const options = { origin, url, now: () => NOW };
const response = (data = fixture) => Response.json(data);
const tick = () => new Promise((resolve) => setImmediate(resolve));
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; }
  set innerHTML(_value) { assert.fail('Research must use textContent'); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return (this._text || '') + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
function document() {
  return { hidden: false, listeners: new Map(), createElement(tag) { return new Element(tag, this); },
    addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); } };
}
const elements = (root) => [root, ...root.children.filter((child) => typeof child === 'object').flatMap(elements)];

test('the checked-in primary context preserves all five official links, dates and limited creator coverage', () => {
  const normalized = normalizePrimaryContext(fixture, { now: NOW });
  assert.equal(normalized.records.length, 3);
  assert.equal(normalized.reviewedAt, fixture.reviewedAt);
  assert.equal(normalized.reviewAgeMs, NOW - Date.parse(fixture.reviewedAt));
  assert.equal(normalized.records.flatMap((record) => record.sources).length, 5);
  for (const [index, record] of normalized.records.entries()) {
    assert.deepEqual(record.temporalScope, fixture.records[index].temporalScope);
    assert.deepEqual(record.sources, fixture.records[index].sources);
    assert.equal(record.relationToCreator.kind, 'inference');
    assert.equal(record.relatedCreator.officialTranscriptRetrieved, false);
    assert.equal(record.relatedCreator.audioVerified, false);
  }
  assert.equal(normalized.records[1].temporalScope.authorizations.every((item) => item.statusAtReview === 'expired'), true);
});

test('unsafe links, text, identifiers, dates, unsupported claims and implicit locations are rejected', () => {
  const mutations = [
    (value) => { value.records[0].sources[0].url = 'javascript:alert(1)'; },
    (value) => { value.records[0].sources[0].url += '?redirect=https://evil.example'; },
    (value) => { value.records[0].sources[0].url = value.records[0].sources[0].url.replace('mofcom.gov.cn', 'mofcom.gov.cn.evil.example'); },
    (value) => { value.records[0].relatedCreator.url = 'https://www.youtube.com.evil.example/watch?v=BXLGV0Sj0n8'; },
    (value) => { value.records[0].finding.text = '<img src=x onerror=alert(1)>'; },
    (value) => { value.records[0].limitations[0] = 'Hidden\u202e instruction'; },
    (value) => { value.records[0].id = '../api/evidence'; },
    (value) => { value.records[1].id = value.records[0].id; },
    (value) => { value.records[0].finding.sourceIds = ['unreviewed-source']; },
    (value) => { value.reviewedAt = '2027-10-11T10:01:19Z'; },
    (value) => { value.records[0].sources[0].date = '2027-01-01'; },
    (value) => { value.records[0].sources[0].date = '2026-02-30'; },
    (value) => { value.records[0].relatedCreator.publishedDate = '2026-12-01'; },
    (value) => { value.records[0].relationToCreator.kind = 'verified'; },
    (value) => { value.records[0].relatedCreator.officialTranscriptRetrieved = true; },
    (value) => { value.records[0].relatedCreator.audioVerified = true; },
    (value) => { value.records[0].lat = 50; },
    (value) => { value.records[0].countries = ['ZZ']; },
    (value) => { value.records[1].temporalScope.authorizations[0].expiresAt = '2026-12-01T00:01:00-04:00'; },
  ];
  for (const mutate of mutations) { const value = structuredClone(fixture); mutate(value); assert.throws(() => normalizePrimaryContext(value, { now: NOW }), /invalid/); }
  const huge = structuredClone(fixture); huge.scope = 'x'.repeat(PRIMARY_CONTEXT_MAX_BYTES);
  assert.throws(() => normalizePrimaryContext(huge, { now: NOW }), /invalid/);
});

test('dated research filtering uses jurisdiction/subject and local text without inventing incident geography', () => {
  const normalized = normalizePrimaryContext(fixture, { now: NOW });
  assert.deepEqual(filterPrimaryContext(normalized, { category: 'economy', country: 'US', q: 'productivity' }).map((record) => record.id), ['us-productivity-q2-2026']);
  assert.deepEqual(filterPrimaryContext(normalized, { category: 'geopolitics', country: 'IR' }).map((record) => record.id), ['iranian-oil-expired-authorizations']);
  assert.deepEqual(filterPrimaryContext(normalized, { category: 'disasters' }), []);
  assert.deepEqual(filterPrimaryContext(normalized, { country: 'BE' }), []);
  assert.deepEqual(filterPrimaryContext(normalized, { q: '<script>' }), []);
});

test('details retain review age, expired periods, source-date kinds, inference and transcript/audio caveats', () => {
  const doc = document(), later = Date.parse('2026-11-12T12:00:00Z');
  const element = renderPrimaryContextDetails(normalizePrimaryContext(fixture, { now: later }), { documentRef: doc, now: later });
  assert.equal(element.tagName, 'details'); assert.equal(element.children[0].tagName, 'summary');
  for (const expected of ['not a live feed', 'current sanctions guidance', fixture.reviewedAt, '32 days since review',
    '2026-03-20T00:01:00-04:00', '2026-04-19T00:01:00-04:00', '2026-07-17T00:01:00-04:00', 'expired at',
    'published deadline has passed', 'inference', 'unverified third-party text reviewed', 'official description only',
    'no official transcript retrieved; audio not verified', 'document-dated: 2026-03-20', 'released: 2026-09-03']) assert.ok(element.textContent.includes(expected), expected);
  const links = elements(element).filter((node) => node.tagName === 'a'); assert.equal(links.length, 8);
  assert.equal(links.every((node) => node.target === '_blank' && node.rel === 'noopener noreferrer'), true);
  const unsafe = structuredClone(fixture); unsafe.records[0].sources[0].url = 'javascript:alert(1)';
  assert.throws(() => renderPrimaryContextDetails(unsafe, { documentRef: doc, now: NOW }), /invalid/);
});

test('loader is lazy, shares one bounded acquisition and returns memory with newly calculated review age', async () => {
  let calls = 0, clock = NOW; const gate = Promise.withResolvers();
  const loader = createPrimaryContextLoader({ ...options, now: () => clock, fetchImpl: (address, init) => {
    calls++; assert.equal(address, origin + url); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.mode, 'same-origin'); return gate.promise;
  } });
  assert.equal(calls, 0);
  const first = loader.load(), joined = loader.load(); await tick(); assert.equal(calls, 1);
  gate.resolve(response()); assert.equal((await first).loadedFrom, 'network'); assert.equal((await joined).data.records.length, 3);
  clock += 86400000; const retained = await loader.load();
  assert.equal(retained.loadedFrom, 'memory'); assert.equal(retained.data.reviewAgeMs, clock - Date.parse(fixture.reviewedAt));
  assert.equal(calls, 1); loader.destroy();
});

test('only fixed same-origin research paths are admitted before fetching', () => {
  for (const address of ['https://evil.example' + url, 'https://user@example.com' + url, url + '?q=private', url + '#fragment', '/api/intelligence', 'javascript:alert(1)', '/earth/research/other.json'])
    assert.throws(() => createPrimaryContextLoader({ ...options, url: address, fetchImpl: () => assert.fail('Invalid URL fetch') }), /invalid/);
});

test('a failing cache write cannot reject successfully validated network metadata', async () => {
  let writes = 0;
  const loader = createPrimaryContextLoader({ ...options, store: { put() { writes++; throw new Error('Quota'); } }, fetchImpl: async () => response() });
  assert.equal((await loader.load()).data.records.length, 3); await tick(); assert.equal(writes, 1); loader.destroy();
});

test('offline device metadata keeps original dates, is bounded to seven days, and rejects invalid cache values', async () => {
  const later = Date.parse('2026-10-15T12:00:00Z'), cached = { data: fixture, retrievedAt: '2026-10-12T12:00:00.000Z' };
  const loader = createPrimaryContextLoader({ ...options, now: () => later, store: { get: async (key) => {
    assert.equal(key, `research:primary-context:v1:${origin}${url}`); return cached;
  } }, fetchImpl: async () => { throw new Error('Offline'); } });
  const result = await loader.load(); assert.equal(result.loadedFrom, 'device'); assert.equal(result.data.reviewedAt, fixture.reviewedAt);
  assert.equal(result.retrievedAt, cached.retrievedAt); assert.equal(result.data.reviewAgeMs, later - Date.parse(fixture.reviewedAt)); loader.destroy();
  for (const invalid of [{ ...cached, retrievedAt: '2026-10-20T12:00:00.000Z' }, { ...cached, retrievedAt: '2026-10-01T12:00:00.000Z' },
    { ...cached, retrievedAt: '2026-10-10T12:00:00.000Z' }, { ...cached, data: {} }]) {
    const bad = createPrimaryContextLoader({ ...options, now: () => later, store: { get: async () => invalid }, fetchImpl: async () => new Response('offline', { status: 503 }) });
    await assert.rejects(bad.load(), /unavailable/); bad.destroy();
  }
});

test('declared or chunked oversized bodies and wrong MIME never become research context', async () => {
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(PRIMARY_CONTEXT_MAX_BYTES + 1)); }, cancel() { canceled = true; } });
  for (const value of [new Response(stream, { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(PRIMARY_CONTEXT_MAX_BYTES + 1) } }),
    new Response(JSON.stringify(fixture), { headers: { 'content-type': 'text/html' } })]) {
    const loader = createPrimaryContextLoader({ ...options, fetchImpl: async () => value }); await assert.rejects(loader.load(), /unavailable/); loader.destroy();
  }
  assert.equal(canceled, true);
});

test('close/cancel rejects promptly despite an abort-ignoring transport and late responses cannot enter memory', async () => {
  const gate = Promise.withResolvers(); let calls = 0, signal;
  const loader = createPrimaryContextLoader({ ...options, fetchImpl: async (_url, init) => { signal = init.signal; return ++calls === 1 ? gate.promise : response(); } });
  const pending = loader.load(); const rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
  loader.cancel(); await rejected; assert.equal(signal.aborted, true); gate.resolve(response()); await tick();
  assert.equal((await loader.load()).loadedFrom, 'network'); assert.equal(calls, 2); loader.destroy();
});

test('immediate cancellation skips a transport that has not started', async () => {
  let calls = 0;
  const loader = createPrimaryContextLoader({ ...options, fetchImpl: async () => { calls++; return response(); } });
  const pending = loader.load(); loader.cancel();
  await assert.rejects(pending, { name: 'AbortError' }); await tick();
  assert.equal(calls, 0);
  assert.equal((await loader.load()).loadedFrom, 'network'); assert.equal(calls, 1); loader.destroy();
});

test('panel loads only on open, filters locally, preserves disclosure state, and reopening never polls', async () => {
  const doc = document(), container = doc.createElement('section'), calls = [];
  const panel = createPrimaryContextPanel(container, { ...options, fetchImpl: async (address) => { calls.push(address); return response(); } });
  panel.setFilters({ q: 'productivity', category: 'economy', country: 'US' }); assert.equal(calls.length, 0);
  assert.equal(container.children[0].tagName, 'details'); assert.equal(await panel.open(), true); assert.equal(calls.length, 1);
  assert.ok(container.textContent.includes('Q2 productivity')); assert.equal(container.textContent.includes('Expired US authorizations'), false);
  container.children[0].open = true;
  panel.setFilters({ q: '', category: 'geopolitics', country: 'IR' });
  assert.equal(container.children[0].open, true); assert.ok(container.textContent.includes('Expired US authorizations')); assert.equal(calls.length, 1);
  panel.close(); assert.equal(await panel.open(), true); assert.equal(calls.length, 1);
  assert.deepEqual(calls, [origin + url]); panel.destroy(); assert.equal(container.children.length, 0); assert.equal(doc.listeners.size, 0);
});

test('panel keeps an unavailable notice after settlement and does not paint a late closed response', async () => {
  const doc = document(), container = doc.createElement('section');
  const failed = createPrimaryContextPanel(container, { ...options, fetchImpl: async () => new Response('Unavailable', { status: 503 }) });
  assert.equal(await failed.open(), false); assert.ok(container.textContent.includes('Dated research context is unavailable')); failed.destroy();
  const gate = Promise.withResolvers(); const closed = createPrimaryContextPanel(container, { ...options, fetchImpl: async () => gate.promise });
  const pending = closed.open(); await tick(); closed.close(); assert.equal(await pending, false);
  gate.resolve(response()); await tick(); assert.equal(container.textContent.includes('Q2 productivity'), false); closed.destroy();
});

test('a hidden panel cancels acquisition and resumes only while its news-panel intent remains open', async () => {
  const doc = document(), container = doc.createElement('section'), gate = Promise.withResolvers(); let calls = 0;
  const panel = createPrimaryContextPanel(container, { ...options, fetchImpl: async () => ++calls === 1 ? gate.promise : response() });
  const first = panel.open(); await tick(); assert.equal(calls, 1);
  doc.hidden = true; doc.listeners.get('visibilitychange')(); assert.equal(await first, false);
  gate.resolve(response()); await tick(); assert.equal(container.textContent.includes('Q2 productivity'), false);
  doc.hidden = false; doc.listeners.get('visibilitychange')(); await tick();
  assert.equal(calls, 2); assert.ok(container.textContent.includes('Q2 productivity'));
  doc.hidden = true; doc.listeners.get('visibilitychange')(); panel.close();
  doc.hidden = false; doc.listeners.get('visibilitychange')(); await tick(); assert.equal(calls, 2);
  panel.destroy();
});
