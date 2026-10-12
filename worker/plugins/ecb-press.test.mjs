import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ECB_PRESS_PLUGIN, collectEcbPress, decodeEcbPress, ecbPublicationTime, ecbPressItems } from './ecb-press.js';
import { pluginFactsDigest, pluginJson } from '../../src/core/plugin-evidence.js';

const NOW = Date.parse('2026-10-12T00:00:00.000Z'), UTF8 = new TextEncoder();
const URL = 'https://www.ecb.europa.eu//press/pr/date/2026/html/ecb.pr261007~6447350434.en.html';
const TITLE = 'TEST ONLY institutional ECB publication & source metadata';
const pubDate = 'Wed, 07 Oct 2026 10:00:00 +0200';
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function item({ url = URL, guid = url, title = TITLE, date = pubDate, extra = '' } = {}) {
  return `<item><title> ${escape(title)}</title><link>${escape(url)}</link><guid>${escape(guid)}</guid><pubDate>${date}</pubDate>${extra}</item>`;
}
function feed(items = item(), { build = 'Fri, 09 Oct 2026 14:26:54 +0200', rootAttrs = '', channelAttrs = '', extra = '' } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"${rootAttrs}><channel${channelAttrs}><title>ECB - European Central Bank</title><link>https://www.ecb.europa.eu/</link><description>Official press feed</description><language>en</language><copyright>Copyright 2026, European Central Bank</copyright><lastBuildDate>${build}</lastBuildDate>${extra}${items}</channel></rss>`;
}
const response = value => new Response(value, { headers: { 'content-type': 'application/rss+xml', etag: '"test-only-feed"' } });
const collect = (text, options = {}) => collectEcbPress({ now: () => NOW, fetchImpl: async () => response(UTF8.encode(text)), ...options });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('fixed anonymous Worker-compatible collection retains exact bytes, GUID identity, original metadata and evidence locators', async () => {
  const bytes = UTF8.encode(feed()), calls = [];
  const result = await collectEcbPress({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(url, ECB_PRESS_PLUGIN.sourceUrl); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined); return response(bytes);
  } });
  assert.deepEqual(calls, [ECB_PRESS_PLUGIN.sourceUrl]); assert.equal(result.pluginId, 'ecb-press-v1'); assert.equal(result.outcome, 'validated');
  assert.equal(result.kind, 'publication-feed'); assert.equal(result.checkedAt, '2026-10-12T00:00:00.000Z');
  assert.deepEqual(result.raw.bytes, bytes); assert.equal(result.raw.sha256, hash(bytes));
  const sourceItem = result.canonicalFacts.items[0]; assert.equal(sourceItem.title, TITLE); assert.equal(sourceItem.url, URL); assert.equal(sourceItem.sourceRecordId, URL);
  assert.equal(sourceItem.itemId, `publication:ecb:${hash(UTF8.encode(URL))}`); assert.equal(sourceItem.publishedAt, '2026-10-07T08:00:00.000Z');
  assert.equal(sourceItem.publishedRaw, pubDate); assert.equal(sourceItem.publishedPrecision, 'second'); assert.equal(sourceItem.kind, 'original-publication');
  const { itemId: _itemId, sourceRevision: _revision, ...facts } = sourceItem;
  assert.equal(sourceItem.sourceRevision, await pluginFactsDigest(facts)); assert.equal(result.factsDigest, await pluginFactsDigest(result.canonicalFacts));
  assert.equal(result.sourceUpdatedAt, '2026-10-09T12:26:54.000Z'); assert.equal(result.sourceVersion, 'RSS 2.0');
  assert.deepEqual(ecbPressItems(result.canonicalFacts), result.canonicalFacts.items);
  assert.deepEqual(result.artifact.items[0].evidence.locator, { kind: 'rss-guid', guid: URL });
  assert.equal(result.artifact.relationships[0].basis, 'publisher-remit'); assert.equal(result.artifact.relationships[0].geometry, null);
  assert.equal(result.artifact.coverage.completeArchive, false); assert.equal(result.artifact.coverage.absenceMeaning, 'not-withdrawal');
  assert.ok(UTF8.encode(pluginJson(result.artifact)).byteLength <= 65536);
});

test('BOM, feed build/check clocks, comments and excluded author material do not alter institutional facts', async () => {
  const original = await collect(feed());
  const speech = item({ url: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp261007~6447350434.en.html', title: 'Named author speech' });
  const changed = await collect(`\ufeff${feed(`<!-- independent layout comment -->${item()}${speech}`, { build: 'Sun, 11 Oct 2026 15:00:00 +0200' })}`,
    { now: () => NOW + 60000 });
  assert.notEqual(changed.raw.sha256, original.raw.sha256); assert.equal(changed.raw.bytes[0], 0xef); assert.equal(changed.raw.bytes[1], 0xbb); assert.equal(changed.raw.bytes[2], 0xbf);
  assert.equal(changed.factsDigest, original.factsDigest); assert.notEqual(changed.checkedAt, original.checkedAt); assert.notEqual(changed.sourceUpdatedAt, original.sourceUpdatedAt);
  assert.equal(changed.artifact.coverage.feedItems, 2); assert.equal(changed.artifact.coverage.excludedItems, 1);
});

test('corrections preserve the exact original GUID ID and create a distinct source revision; feed disappearance never asserts withdrawal', async () => {
  const first = await collect(feed()), corrected = await collect(feed(item({ title: 'TEST ONLY corrected publication metadata' })));
  assert.equal(corrected.canonicalFacts.items[0].itemId, first.canonicalFacts.items[0].itemId);
  assert.notEqual(corrected.canonicalFacts.items[0].sourceRevision, first.canonicalFacts.items[0].sourceRevision); assert.notEqual(corrected.factsDigest, first.factsDigest);
  const absent = await collect(feed('')); assert.deepEqual(absent.canonicalFacts.items, []); assert.equal(absent.artifact.coverage.absenceMeaning, 'not-withdrawal');
  assert.equal('withdrawn' in absent.artifact, false); assert.equal('withdrawn' in absent.canonicalFacts, false);
});

test('conditional 304 returns only operational metadata and preserves previous validators without raw/facts/artifact', async () => {
  const first = await collect(feed()), previous = { validators: first.validators, factsDigest: first.factsDigest };
  const unchanged = await collectEcbPress({ previous, now: () => NOW + 60000, fetchImpl: async (url, options) => {
    assert.equal(url, ECB_PRESS_PLUGIN.sourceUrl); assert.equal(options.headers['If-None-Match'], '"test-only-feed"');
    return new Response(null, { status: 304, headers: { etag: '"test-only-feed"' } });
  } });
  assert.equal(unchanged.outcome, 'not-modified'); assert.equal(unchanged.checkedAt, '2026-10-12T00:01:00.000Z');
  assert.equal(unchanged.factsDigest, first.factsDigest);
  for (const key of ['raw', 'canonicalFacts', 'artifact']) assert.equal(unchanged[key], null);
  await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => new Response(null, { status: 304 }) }), /Unsolicited/);
  const modified = 'Fri, 09 Oct 2026 12:26:54 GMT';
  const fallback = await collectEcbPress({ now: () => NOW, previous: { validators: { lastModified: modified }, factsDigest: first.factsDigest },
    fetchImpl: async (_, options) => { assert.equal(options.headers['If-Modified-Since'], modified); return new Response(null, { status: 304 }); } });
  assert.equal(fallback.validators.lastModified, modified);
  const changedWithoutValidators = await collectEcbPress({ now: () => NOW, previous, fetchImpl: async () =>
    new Response(feed(), { headers: { 'content-type': 'application/rss+xml' } }) });
  assert.deepEqual(changedWithoutValidators.validators, { etag: null, lastModified: null }, 'a 200 body cannot inherit validators that belong to an older body');
});

test('explicit publication offsets preserve source precision and reject rollover, missing-zone or future assertions', async () => {
  assert.equal(ecbPublicationTime(pubDate), '2026-10-07T08:00:00.000Z');
  assert.equal(ecbPublicationTime('Thu, 15 Jan 2026 10:00:00 +0100'), '2026-01-15T09:00:00.000Z');
  for (const value of ['Wed, 07 Oct 2026 10:00:00', 'Fri, 31 Apr 2026 10:00:00 +0200', 'Thu, 07 Oct 2026 10:00:00 +0200',
    'Wed, 07 Oct 2026 24:00:00 +0200', 'Wed, 07 Oct 2026 10:00:00 +1460']) assert.throws(() => ecbPublicationTime(value));
  await assert.rejects(collect(feed(item({ date: 'Tue, 13 Oct 2026 10:00:00 +0200' }))), /future-dated/);
});

test('strict fixed RSS grammar rejects DTD/entity expansion, ambiguous namespaces, duplicate keys and injected documents', async () => {
  const valid = feed();
  const bad = [
    valid.replace('<rss', '<!DOCTYPE rss SYSTEM "https://evil.example/secret"><rss'),
    valid.replace('<rss', '<!DOCTYPE rss [<!ENTITY a "huge"><!ENTITY b "&a;&a;">]><rss'),
    valid.replace('TEST ONLY', '&unknown;'), valid.replace('TEST ONLY', '&#0;'), valid.replace('TEST ONLY', '\ufffe'),
    feed(item(), { rootAttrs: ' xmlns="https://evil.example/namespace"' }), feed(item(), { channelAttrs: ' xmlns:atom="https://evil.example/atom"' }),
    valid.replace('http://www.w3.org/2005/Atom', 'https://evil.example/atom'), valid.replace('<item>', '<other:item>').replace('</item>', '</other:item>'),
    valid.replace('<title> TEST', '<title x="one" x="two"> TEST'), valid.replace('<guid>', '<guid __proto__="ignored">'),
    valid.replace('</title><link>https://www.ecb.europa.eu//press', '</title><title>Override</title><link>https://www.ecb.europa.eu//press'),
    valid + '<rss version="2.0"/>', valid.replace('</guid>', '</title>'), valid.replace('<item>', '<?xml-stylesheet href="https://evil.example"?><item>'),
    feed(item() + item()), feed(item({ guid: URL.replace('//press', '/press') })),
  ];
  for (const xml of bad) await assert.rejects(collect(xml), error => error.code === 'ECB_FEED_INVALID');
});

test('only reviewed institutional pages enter the artifact; authored press entries and off-scope publishers stay excluded', async () => {
  const rows = item() + item({ url: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp261007~6447350434.en.html' }) +
    item({ url: 'https://evil.example/press/pr/date/2026/html/ecb.pr261007~6447350434.en.html' }) +
    item({ url: URL.replace('261007', '261006'), extra: '<author>Named author</author>' });
  const result = await collect(feed(rows)); assert.equal(result.canonicalFacts.items.length, 1); assert.equal(result.artifact.coverage.excludedItems, 3);
  assert.equal(result.artifact.items.some(value => value.url.includes('evil.example')), false);
  const cdata = feed(item()).replace(escape(TITLE), '<![CDATA[TEST ONLY institutional ECB publication & source metadata]]>');
  assert.equal((await collect(cdata)).canonicalFacts.items[0].title, TITLE);
});

test('invalid content type/encoding, altered target and oversized or malformed input fail before any accepted capture', async () => {
  for (const type of ['text/html', 'application/rss+xml; charset=iso-8859-1'])
    await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => new Response(feed(), { headers: { 'content-type': type } }) }));
  await assert.rejects(collect(feed().replace('encoding="utf-8"', 'encoding="iso-8859-1"')), /Unsupported ECB XML declaration/);
  await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => {
    const value = response(feed()); Object.defineProperty(value, 'url', { value: 'https://evil.example/feed' }); return value;
  } }), /fixed source/);
  await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => response(new Uint8Array([0xff])) }), /UTF-8/);
  await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => response(new Uint8Array(524289)) }), error => error.code === 'RESPONSE_TOO_LARGE');
  await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => new Response(null, { headers: { 'content-type': 'application/rss+xml', 'content-length': '524289' } }) }), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('provider Retry-After is bounded and owner cancellation settles an ignored-signal transport without evidence publication', async () => {
  await assert.rejects(collectEcbPress({ now: () => NOW, fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '999999999' } }) }),
    error => error.code === 'ECB_FEED_HTTP' && error.httpStatus === 429 && error.retryAfterMs === 86400000);
  const controller = new AbortController(); let calls = 0;
  const running = collectEcbPress({ now: () => NOW, signal: controller.signal, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(new DOMException('TEST ONLY owner cancellation', 'AbortError'));
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(calls, 1);
});

test('bounded parser and artifact admit maximum selected institutional items and reject the next instead of silently omitting evidence', async (t) => {
  const rows = Array.from({ length: 32 }, (_, n) => item({ url: URL.replace('6447350434', n.toString(16).padStart(10, '0')), title: `TEST ONLY ${n} ${'x'.repeat(475)}` })).join('');
  const result = await collect(feed(rows)); assert.equal(result.canonicalFacts.items.length, 32);
  const bytes = UTF8.encode(pluginJson(result.artifact)).byteLength; assert.ok(bytes <= 65536); t.diagnostic(`32 institutional originals: ${bytes} artifact bytes`);
  await assert.rejects(collect(feed(rows + item({ url: URL.replace('6447350434', 'ffffffffff') }))), /count exceeds/);
  await assert.rejects(decodeEcbPress(UTF8.encode(feed().replace('<title> TEST', `<title>${'x'.repeat(16385)} TEST`)), { now: () => NOW }), /text exceeds/);
});
