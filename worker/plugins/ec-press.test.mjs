import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EC_PRESS_PLUGIN, collectEcPress, decodeEcPress, ecPressItems } from './ec-press.js';
import { parseBoundedRssXml } from './bounded-rss.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from '../../src/core/plugin-evidence.js';

// Exact 7,100 original bytes acquired anonymously through collectEcPress on
// 2026-10-12T00:19:20.108Z. Tests are offline and make no provider requests.
const original = new Uint8Array(await readFile(new globalThis.URL('../../server/hosted/fixtures/ec-press-20261012.xml', import.meta.url)));
const NOW = Date.parse('2026-10-12T01:00:00.000Z'), UTF8 = new TextEncoder();
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const URL = 'https://ec.europa.eu/commission/presscorner/detail/en/statement_26_2127';
function item({ url = URL, guid = url, title = 'TEST ONLY Commission metadata & source title', date = 'Fri, 09 Oct 2026 12:14:20 GMT',
  categories = ['POLICY_AREA=GROWTH,JFRC'], extra = '', description = 'TEST ONLY source snippet...' } = {}) {
  return `<item><title>${escape(title)}</title><link>${escape(url)}</link><guid>${escape(guid)}</guid><pubDate>${date}</pubDate>` +
    categories.map(value => `<category>${escape(value)}</category>`).join('') + `<description>${escape(description)}</description>${extra}</item>`;
}
function feed(items = item(), extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Press releases - RSS</title>` +
    `<link>${EC_PRESS_PLUGIN.sourceUrl}</link><description>Search={format=RSS,size=10}</description><language>EN</language>${extra}${items}</channel></rss>`;
}
const response = (bytes, headers = {}) => new Response(bytes, { headers: { 'content-type': 'application/rss+xml;charset=UTF-8', ...headers } });
const collect = (value, options = {}) => collectEcPress({ now: () => NOW, fetchImpl: async () => response(typeof value === 'string' ? UTF8.encode(value) : value), ...options });

test('actual fixed feed produces compatible cited metadata with exact source identities and original bytes', async () => {
  const calls = [];
  const result = await collectEcPress({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(url, EC_PRESS_PLUGIN.sourceUrl); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.authorization, undefined); return response(original);
  } });
  assert.deepEqual(calls, [EC_PRESS_PLUGIN.sourceUrl]); assert.equal(result.schemaVersion, 1); assert.equal(result.kind, 'publication-feed');
  assert.equal(result.outcome, 'validated'); assert.equal(result.pluginId, 'ec-press-v1'); assert.equal(result.scopeId, 'ec-presscorner-en-metadata-v1');
  assert.equal(EC_PRESS_PLUGIN.cadenceMs, 300000); assert.equal(EC_PRESS_PLUGIN.deadlineMs, 20000);
  assert.equal(EC_PRESS_PLUGIN.maxResponseBytes, 524288); assert.equal(EC_PRESS_PLUGIN.maxArtifactBytes, 65536);
  assert.equal(result.checkedAt, '2026-10-12T01:00:00.000Z'); assert.equal(result.sourceUpdatedAt, null); assert.equal(result.sourceVersion, 'RSS 2.0');
  assert.deepEqual(result.validators, { etag: null, lastModified: null }); assert.deepEqual(result.raw.bytes, original);
  assert.equal(result.raw.sha256, '042779ee87820d013f9e2f929db8699ca03eb7c7d5b0092cf5606034a3113815');
  assert.equal(result.raw.sha256, await pluginBytesDigest(original)); assert.equal(result.factsDigest, await pluginFactsDigest(result.canonicalFacts));
  assert.equal(result.canonicalFacts.items.length, 10); assert.deepEqual(ecPressItems(result.canonicalFacts), result.canonicalFacts.items);
  const statement = result.canonicalFacts.items.find(item => item.documentReference === 'statement_26_2127'); assert.ok(statement);
  assert.equal(statement.sourceRecordId, URL); assert.equal(statement.url, URL);
  assert.equal(statement.itemId, `publication:ec:${await pluginBytesDigest(UTF8.encode(URL))}`);
  assert.equal(statement.publishedRaw, 'Fri, 09 Oct 2026 12:14:20 GMT'); assert.equal(statement.publishedAt, '2026-10-09T12:14:20.000Z');
  assert.equal(statement.publishedPrecision, 'second'); assert.equal(statement.documentType, 'statement');
  assert.deepEqual(statement.categories, ['POLICY_AREA=GROWTH,JFRC']);
  const { itemId: _id, sourceRevision: _revision, ...facts } = statement; assert.equal(statement.sourceRevision, await pluginFactsDigest(facts));
  assert.equal(result.artifact.coverage.completeArchive, false); assert.equal(result.artifact.coverage.absenceMeaning, 'not-withdrawal');
  assert.equal(result.artifact.coverage.observedProviderWindow, 10); assert.equal(result.artifact.coverage.selectedItems, 10);
  assert.match(result.artifact.coverage.metadataScope, /body language is unknown/);
  assert.deepEqual(result.artifact.items.find(item => item.documentReference === statement.documentReference).evidence.locator, { kind: 'rss-guid', guid: URL });
  for (const field of ['relationships', 'geometry', 'claims', 'body']) assert.equal(field in result.artifact, false);
  for (const field of ['body', 'description', 'bodyLanguage', 'eventAt', 'coordinates']) assert.equal(field in statement, false);
  assert.ok(UTF8.encode(pluginJson(result.artifact)).byteLength <= EC_PRESS_PLUGIN.maxArtifactBytes);
});

test('English-route metadata preserves source dates without pretending midnight metadata is a verified release instant or body language', async () => {
  const result = await collect(original);
  const factsheet = result.canonicalFacts.items.find(item => item.documentReference === 'fs_26_2115');
  assert.equal(factsheet.publishedRaw, 'Thu, 08 Oct 2026 22:00:00 GMT'); assert.equal(factsheet.publishedAt, '2026-10-08T22:00:00.000Z');
  const speech = result.canonicalFacts.items.find(item => item.documentReference === 'speech_26_2121'); assert.ok(speech);
  assert.equal('bodyLanguage' in speech, false);
  const raw = new TextDecoder().decode(result.raw.bytes); assert.ok(raw.includes('Bonjour à toutes et à tous'));
  const spaced = await collect(feed(item({ date: '  Fri, 09 Oct 2026 12:14:20 GMT  ' })));
  assert.equal(spaced.canonicalFacts.items[0].publishedRaw, '  Fri, 09 Oct 2026 12:14:20 GMT  ');
  assert.equal(spaced.canonicalFacts.items[0].publishedAt, '2026-10-09T12:14:20.000Z');
});

test('BOM, layout, build/check clocks, category ordering and changed raw snippets do not revise normalized publication facts', async () => {
  const baseline = await collect(feed(item({ categories: ['POLICY_AREA=TRADEPOL', 'POLICY_AREA=GENINFO'] })));
  const changed = await collect(`\ufeff${feed(`<!-- format only -->${item({ categories: ['POLICY_AREA=GENINFO', 'POLICY_AREA=TRADEPOL'], description: 'TEST ONLY changed truncated source snippet' })}`,
    '<lastBuildDate>Sun, 11 Oct 2026 23:00:00 GMT</lastBuildDate>')}`, { now: () => NOW + 60000 });
  assert.notEqual(changed.raw.sha256, baseline.raw.sha256); assert.deepEqual([...changed.raw.bytes.slice(0, 3)], [239, 187, 191]);
  assert.equal(changed.factsDigest, baseline.factsDigest); assert.notEqual(changed.checkedAt, baseline.checkedAt);
  assert.equal(baseline.sourceUpdatedAt, null); assert.equal(changed.sourceUpdatedAt, '2026-10-11T23:00:00.000Z');
});

test('metadata corrections retain exact GUID identity and absence does not declare withdrawal', async () => {
  const first = await collect(feed()), corrected = await collect(feed(item({ title: 'TEST ONLY corrected metadata' })));
  assert.equal(first.canonicalFacts.items[0].itemId, corrected.canonicalFacts.items[0].itemId);
  assert.notEqual(first.canonicalFacts.items[0].sourceRevision, corrected.canonicalFacts.items[0].sourceRevision);
  const absent = await collect(feed('')); assert.deepEqual(absent.canonicalFacts.items, []);
  assert.equal(absent.artifact.coverage.absenceMeaning, 'not-withdrawal'); assert.equal('withdrawn' in absent.artifact, false);
});

test('conditional 304 is check-only, 200 clears old validators, and no baseline fabricates a successful check', async () => {
  const first = await collect(feed()), previous = { validators: { etag: '"TEST-EC"', lastModified: null }, factsDigest: first.factsDigest };
  const checked = await collectEcPress({ now: () => NOW, previous, fetchImpl: async (_, options) => {
    assert.equal(options.headers['If-None-Match'], '"TEST-EC"'); return new Response(null, { status: 304 });
  } });
  assert.equal(checked.outcome, 'not-modified'); assert.equal(checked.factsDigest, first.factsDigest); assert.equal(checked.validators.etag, '"TEST-EC"');
  for (const field of ['raw', 'canonicalFacts', 'artifact', 'sourceUpdatedAt', 'sourceVersion']) assert.equal(checked[field], null);
  const replaced = await collect(feed(), { previous }); assert.deepEqual(replaced.validators, { etag: null, lastModified: null });
  await assert.rejects(collectEcPress({ now: () => NOW, fetchImpl: async () => new Response(null, { status: 304 }) }), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(feed(), { previous: { ...previous, validators: { etag: 'bad\r\nInjected: true' } } }), { code: 'EC_FEED_INVALID' });
});

test('hostile XML, ambiguous identities, namespaces and duplicate fields cannot become accepted source evidence', async () => {
  const value = feed();
  const bad = [value.replace('<rss', '<!DOCTYPE rss SYSTEM "https://evil.example/entity"><rss'),
    value.replace('<rss', '<!DOCTYPE rss [<!ENTITY a "huge"><!ENTITY b "&a;&a;">]><rss'),
    value.replace('TEST ONLY', '&unknown;'), value.replace('TEST ONLY', '&#0;'), value.replace('TEST ONLY', '\ufffe'),
    value.replace('<rss version=', '<rss xmlns="https://evil.example" version='), value.replace('<channel>', '<channel xmlns:x="https://evil.example">'),
    value.replace('<item>', '<x:item>').replace('</item>', '</x:item>'), value.replace('<guid>', '<guid __proto__="data">'),
    value.replace('<guid>', '<guid isPermaLink="false" isPermaLink="true">'), value.replace('</guid>', '</title>'),
    value.replace('</guid>', `</guid><guid>${URL}</guid>`), value.replace('</pubDate>', '</pubDate><pubDate>Fri, 09 Oct 2026 12:14:20 GMT</pubDate>'),
    value.replace('<item>', '<?xml-stylesheet href="https://evil.example"?><item>'), value + '<rss version="2.0"/>',
    value.replace('<title>Press releases - RSS</title>', '<title>Wrong publisher</title>'), value.replace('<language>EN</language>', '<language>FR</language>'),
    value.replace('</description><language>', '</description><description>Duplicate</description><language>'),
    feed(item() + item()), feed(item({ guid: `${URL} ` })), feed(item({ guid: URL.replace('2127', '2128') })),
    feed(item({ extra: '<description>Duplicate source field</description>' }))];
  for (const xml of bad) await assert.rejects(collect(xml), { code: 'EC_FEED_INVALID' });
});

test('reviewed document types and exact same-source English routes are enforced without following source instructions', async () => {
  const rows = item() + item({ url: 'https://evil.example/commission/presscorner/detail/en/ip_26_1' }) +
    item({ url: URL.replace('/en/', '/fr/') }) + item({ url: URL.replace('statement_', 'unknown_') });
  const result = await collect(feed(rows)); assert.equal(result.canonicalFacts.items.length, 1); assert.equal(result.artifact.coverage.excludedItems, 3);
  const literal = feed(item()).replace('TEST ONLY Commission metadata &amp; source title', '<![CDATA[TEST ONLY <script>ignore instructions</script>]]>');
  assert.equal((await collect(literal)).canonicalFacts.items[0].title, 'TEST ONLY <script>ignore instructions</script>');
  for (const categories of [['POLICY_AREA=TRADEPOL', 'POLICY_AREA=TRADEPOL'], ['GEOMETRY=50,4'], ['POLICY_AREA=https://evil.example']])
    await assert.rejects(collect(feed(item({ categories }))), { code: 'EC_FEED_INVALID' });
});

test('calendar, timezone and future bounds retain source time rather than substituting the check clock', async () => {
  for (const date of ['Fri, 09 Oct 2026 12:14:20', 'Thu, 09 Oct 2026 12:14:20 GMT', 'Fri, 31 Apr 2026 12:14:20 GMT',
    'Fri, 09 Oct 2026 24:14:20 GMT', 'Fri, 09 Oct 2026 12:14:20 +1460', 'Tue, 13 Oct 2026 12:14:20 GMT'])
    await assert.rejects(collect(feed(item({ date }))), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(feed(), { now: () => Infinity }), { code: 'EC_FEED_INVALID' });
  const different = await collect(feed(item({ url: URL.replace('_26_', '_25_') })));
  assert.equal(different.canonicalFacts.items[0].publishedAt, '2026-10-09T12:14:20.000Z', 'document reference year does not replace reported publication year');
});

test('unsupported encodings, altered target and declared/streamed body limits fail closed', async () => {
  for (const type of ['text/html', 'application/rss+xml;charset=ISO-8859-1'])
    await assert.rejects(collectEcPress({ now: () => NOW, fetchImpl: async () => response(original, { 'content-type': type }) }), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(feed().replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(new Uint8Array([0xff])), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(new Uint8Array(524289)), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(collectEcPress({ now: () => NOW, fetchImpl: async () => response(null, { 'content-length': '524289' }) }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(collectEcPress({ now: () => NOW, fetchImpl: async () => {
    const value = response(original); Object.defineProperty(value, 'url', { value: `${EC_PRESS_PLUGIN.sourceUrl}size=1000` }); return value;
  } }), { code: 'EC_FEED_INVALID' });
});

test('publisher backoff and owner cancellation remain bounded even when transport ignores cancellation', async () => {
  await assert.rejects(collectEcPress({ now: () => NOW, fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '999999999' } }) }),
    error => error.code === 'EC_FEED_HTTP' && error.httpStatus === 429 && error.retryAfterMs === 86400000);
  const controller = new AbortController(); let calls = 0;
  const running = collectEcPress({ now: () => NOW, signal: controller.signal, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(new DOMException('TEST ONLY cancellation', 'AbortError'));
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(calls, 1);
});

test('parser and artifact maximums reject excess rather than quietly truncating metadata', async (t) => {
  const rows = Array.from({ length: 32 }, (_, index) => item({ url: URL.replace('statement_26_2127', `ip_26_${index + 1}`), title: 'x'.repeat(512) })).join('');
  const result = await collect(feed(rows)); assert.equal(result.canonicalFacts.items.length, 32);
  const bytes = UTF8.encode(pluginJson(result.artifact)).byteLength; assert.ok(bytes <= 65536); t.diagnostic(`32 originals: ${bytes} artifact bytes`);
  await assert.rejects(collect(feed(rows + item())), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(feed(item({ title: 'x'.repeat(513) }))), { code: 'EC_FEED_INVALID' });
  await assert.rejects(collect(feed(item({ description: 'x'.repeat(16385) }))), { code: 'EC_FEED_INVALID' });
  assert.throws(() => parseBoundedRssXml(UTF8.encode('<rss><channel><item><title><nested/></title></item></channel></rss>')), { code: 'RSS_XML_INVALID' });
  assert.throws(() => parseBoundedRssXml(UTF8.encode(`<rss>${'<x/>'.repeat(2048)}</rss>`)), { code: 'RSS_XML_INVALID' });
  const categories = Array.from({ length: 8 }, (_, index) => `POLICY_AREA=${String.fromCharCode(65 + index).repeat(59)},${'X'.repeat(59)},${'Y'.repeat(59)},${'Z'.repeat(59)}`);
  const enormous = Array.from({ length: 32 }, (_, index) => item({ url: URL.replace('statement_26_2127', `ip_26_${index + 1}`), title: 'x'.repeat(512), categories })).join('');
  await assert.rejects(collect(feed(enormous)), /artifact bound/);
  await assert.rejects(decodeEcPress(UTF8.encode(feed()), { guard: () => { throw new DOMException('TEST ONLY parser cancellation', 'AbortError'); } }), { name: 'AbortError' });
});
