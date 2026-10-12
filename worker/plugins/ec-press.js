import { readResponseBytesCapped } from '../../src/sources/httpBody.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from '../../src/core/plugin-evidence.js';
import { parseBoundedRssXml, rssField, rssScalar, rssKeysAllowed, rssPublicationTime } from './bounded-rss.js';

export const EC_PRESS_PLUGIN = Object.freeze({
  schemaVersion: 1, pluginId: 'ec-press-v1', scopeId: 'ec-presscorner-en-metadata-v1', kind: 'publication-feed',
  sourceId: 'european-commission', name: 'European Commission publication metadata',
  sourceUrl: 'https://ec.europa.eu/commission/presscorner/api/rss?',
  cadenceMs: 300000, deadlineMs: 20000, maxResponseBytes: 524288, maxItems: 32, maxArtifactBytes: 65536,
  rights: Object.freeze({ attribution: 'European Commission / European Union; original source linked',
    policyUrl: 'https://commission.europa.eu/legal-notice_en', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    scope: 'EU-owned publication title/link/date/category metadata with attribution and normalization identified; individual and third-party exceptions apply. Images, logos and full document bodies are excluded.' }),
  coverage: Object.freeze({ mode: 'rolling-provider-feed', completeArchive: false, absenceMeaning: 'not-withdrawal',
    metadataScope: 'English-route publication metadata; document body language is unknown', observedProviderWindow: 10 }),
});
const UTF8 = new TextEncoder(), TYPES = new Set(['ip', 'statement', 'read', 'qanda', 'fs', 'mex', 'speech']);
const MAX_XML_ITEMS = 100, MAX_CATEGORIES = 8;
const publicationUrl = /^https:\/\/ec\.europa\.eu\/commission\/presscorner\/detail\/en\/([a-z]+)_([0-9]{2})_([0-9]{1,7})$/;
const fail = message => { throw Object.assign(new TypeError(message), { code: 'EC_FEED_INVALID' }); };
const validEtag = value => value == null ? null : typeof value === 'string' && /^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(value) ? value : undefined;
const validModified = value => value == null ? null : typeof value === 'string' && value.length <= 128 &&
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const fixedFeed = value => value === EC_PRESS_PLUGIN.sourceUrl || value === EC_PRESS_PLUGIN.sourceUrl.slice(0, -1);
function publicationTime(value) {
  try { return rssPublicationTime(value); } catch { fail('Invalid EC publication calendar time or explicit timezone'); }
}

export async function decodeEcPress(bytes, { now = Date.now, guard = () => {} } = {}) {
  let rss;
  try { rss = parseBoundedRssXml(bytes, { guard, maxBytes: EC_PRESS_PLUGIN.maxResponseBytes }); }
  catch (error) { if (error.code === 'RSS_XML_INVALID') fail(error.message); throw error; }
  const scalar = (node, allowed = []) => {
    try { return rssScalar(node, allowed); } catch (error) { if (error.code === 'RSS_XML_INVALID') fail(error.message); throw error; }
  };
  const field = (node, name, required = true) => {
    try { return rssField(node, name, required); } catch (error) { if (error.code === 'RSS_XML_INVALID') fail(error.message); throw error; }
  };
  if (rss.name !== 'rss' || rss.attrs.version !== '2.0' || !rssKeysAllowed(rss, ['version']) || rss.text.trim() ||
      rss.children.length !== 1 || rss.children[0].name !== 'channel') fail('Unsupported EC RSS root or namespace');
  const channel = rss.children[0], names = ['title', 'link', 'description', 'language', 'copyright', 'lastBuildDate', 'item'];
  if (Object.keys(channel.attrs).length || channel.text.trim() || channel.children.some(node => !names.includes(node.name)))
    fail('Unsupported EC RSS channel field or namespace');
  for (const name of names.filter(name => name !== 'item')) {
    const node = field(channel, name, ['title', 'link', 'description', 'language'].includes(name)); if (node) scalar(node);
  }
  if (scalar(field(channel, 'title')).trim() !== 'Press releases - RSS' ||
      !fixedFeed(scalar(field(channel, 'link')).trim()) || scalar(field(channel, 'language')).trim() !== 'EN')
    fail('EC RSS publisher or English-route identity mismatch');
  const build = field(channel, 'lastBuildDate', false), sourceUpdatedAt = build ? publicationTime(scalar(build).trim()) : null;
  const rows = channel.children.filter(node => node.name === 'item');
  if (rows.length > MAX_XML_ITEMS) fail('EC RSS item count exceeds its bound');
  const nowMs = now(); if (!Number.isFinite(nowMs)) fail('Invalid EC acquisition clock');
  const items = [], seen = new Set();
  for (const row of rows) {
    guard();
    if (Object.keys(row.attrs).length || row.text.trim() || row.children.some(node => !['title', 'link', 'guid', 'pubDate', 'description', 'category'].includes(node.name)))
      fail('Unsupported EC RSS item field or namespace');
    for (const node of row.children) scalar(node, node.name === 'guid' ? ['isPermaLink'] : []);
    const title = scalar(field(row, 'title')).trim(), link = scalar(field(row, 'link')).trim(), guidNode = field(row, 'guid');
    const guid = scalar(guidNode, ['isPermaLink']);
    if (!guid || guid !== guid.trim() || guid.length > 2048 || seen.has(guid) ||
        guidNode.attrs.isPermaLink && !['true', 'false'].includes(guidNode.attrs.isPermaLink)) fail('Invalid or duplicate EC source GUID');
    seen.add(guid);
    const match = publicationUrl.exec(link);
    if (!match || !TYPES.has(match[1])) continue;
    if (guid !== link || !title || UTF8.encode(title).byteLength > 512) fail('Invalid EC publication identity');
    const publishedRaw = scalar(field(row, 'pubDate'));
    if (publishedRaw.length > 128) fail('EC publication date exceeds its bound');
    const publishedAt = publicationTime(publishedRaw.trim());
    if (Date.parse(publishedAt) > nowMs + 300000) fail('EC publication is future-dated');
    const categoryNodes = row.children.filter(node => node.name === 'category');
    if (categoryNodes.length > MAX_CATEGORIES) fail('EC policy category count exceeds its bound');
    const categories = categoryNodes.map(node => scalar(node).trim());
    if (new Set(categories).size !== categories.length || categories.some(category => category.length > 256 ||
        !/^POLICY_AREA=[A-Z][A-Z0-9]{0,63}(?:,[A-Z][A-Z0-9]{0,63}){0,15}$/.test(category)))
      fail('Unsupported or duplicate EC source policy category');
    field(row, 'description', false); // Detect duplicates; snippet text is raw evidence only.
    const documentReference = `${match[1]}_${match[2]}_${match[3]}`;
    const facts = { schemaVersion: 1, kind: 'original-publication', publisherId: 'european-commission', sourceRecordId: guid,
      title, url: link, publishedAt, publishedRaw, publishedPrecision: 'second',
      documentReference, documentType: match[1], categories: categories.sort() };
    const itemId = `publication:ec:${await pluginBytesDigest(UTF8.encode(guid))}`;
    items.push({ itemId, ...facts, sourceRevision: await pluginFactsDigest(facts) });
    if (items.length > EC_PRESS_PLUGIN.maxItems) fail('EC publication count exceeds its bound');
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.itemId.localeCompare(b.itemId));
  return { canonicalFacts: { schemaVersion: 1, scopeId: EC_PRESS_PLUGIN.scopeId, items }, sourceUpdatedAt,
    coverage: { ...EC_PRESS_PLUGIN.coverage, feedItems: rows.length, selectedItems: items.length, excludedItems: rows.length - items.length } };
}

export function ecPressItems(value) {
  if (value?.schemaVersion !== 1 || value.scopeId !== EC_PRESS_PLUGIN.scopeId || !Array.isArray(value.items) || value.items.length > EC_PRESS_PLUGIN.maxItems)
    fail('Use the bounded reviewed EC publication scope');
  return value.items;
}
async function bounded(task, signal) {
  signal.throwIfAborted(); let stop;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return task(); }).then(value => {
      if (signal.aborted && value?.body?.cancel) void value.body.cancel().catch(() => {}); return value;
    }), new Promise((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); })]);
  } finally { signal.removeEventListener('abort', stop); }
}
const closeResponse = response => { if (response.body) void response.body.cancel().catch(() => {}); };

export async function collectEcPress({ now = Date.now, signal: callerSignal, previous = {}, fetchImpl = fetch } = {}) {
  const controller = new AbortController(), expiresAt = Date.now() + EC_PRESS_PLUGIN.deadlineMs;
  const timer = setTimeout(() => controller.abort(new DOMException('EC acquisition timed out', 'TimeoutError')), EC_PRESS_PLUGIN.deadlineMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const guard = () => { signal.throwIfAborted(); if (Date.now() >= expiresAt) throw new DOMException('EC acquisition deadline exceeded', 'TimeoutError'); };
  try {
    guard(); if (!Number.isFinite(now())) fail('Invalid EC acquisition clock');
    const etag = validEtag(previous.validators?.etag), modified = validModified(previous.validators?.lastModified);
    if (etag === undefined || modified === undefined) fail('Invalid EC conditional validators');
    const hasPrevious = /^[a-f0-9]{64}$/.test(previous.factsDigest || '');
    const headers = { Accept: 'application/rss+xml, application/xml;q=0.9', 'User-Agent': 'earth-observer-source-plugin/1.0' };
    if (hasPrevious && etag) headers['If-None-Match'] = etag; else if (hasPrevious && modified) headers['If-Modified-Since'] = modified;
    const response = await bounded(() => fetchImpl(EC_PRESS_PLUGIN.sourceUrl, { signal, redirect: 'error', credentials: 'omit', headers }), signal);
    if (response.redirected || response.url && !fixedFeed(response.url)) { closeResponse(response); fail('EC feed changed its fixed source'); }
    const responseEtag = validEtag(response.headers.get('etag')), responseModified = validModified(response.headers.get('last-modified'));
    if (responseEtag === undefined || responseModified === undefined) { closeResponse(response); fail('Invalid EC response validators'); }
    const validators = { etag: response.status === 304 ? responseEtag ?? etag : responseEtag,
      lastModified: response.status === 304 ? responseModified ?? modified : responseModified };
    const base = { schemaVersion: 1, pluginId: EC_PRESS_PLUGIN.pluginId, scopeId: EC_PRESS_PLUGIN.scopeId,
      kind: EC_PRESS_PLUGIN.kind, checkedAt: new Date(now()).toISOString(), validators, sourceUrl: EC_PRESS_PLUGIN.sourceUrl };
    if (response.status === 304) {
      closeResponse(response); if (!hasPrevious || !headers['If-None-Match'] && !headers['If-Modified-Since']) fail('Unsolicited EC not-modified response');
      return { ...base, outcome: 'not-modified', factsDigest: previous.factsDigest,
        sourceUpdatedAt: null, sourceVersion: null, raw: null, canonicalFacts: null, artifact: null };
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after'), delay = /^\d{1,9}$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
      closeResponse(response); throw Object.assign(new Error(`EC feed HTTP ${response.status}`), { code: 'EC_FEED_HTTP', httpStatus: response.status,
        retryAfterMs: Number.isFinite(delay) ? Math.max(0, Math.min(86400000, delay)) : 0 });
    }
    if (!/^(?:application\/(?:rss\+xml|xml)|text\/xml)(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(response.headers.get('content-type') || '')) {
      closeResponse(response); fail('EC source did not return supported UTF-8 RSS XML');
    }
    const bytes = await bounded(() => readResponseBytesCapped(response, EC_PRESS_PLUGIN.maxResponseBytes, signal), signal);
    guard(); const decoded = await bounded(() => decodeEcPress(bytes, { now, guard }), signal); guard();
    const factsDigest = await pluginFactsDigest(decoded.canonicalFacts), rawSha = await pluginBytesDigest(bytes);
    const artifact = { schemaVersion: 1, kind: 'publication-feed-overview', pluginId: EC_PRESS_PLUGIN.pluginId, scopeId: EC_PRESS_PLUGIN.scopeId,
      title: EC_PRESS_PLUGIN.name, items: decoded.canonicalFacts.items.map(item => ({ ...item,
        evidence: { sourceUrl: EC_PRESS_PLUGIN.sourceUrl, locator: { kind: 'rss-guid', guid: item.sourceRecordId } } })),
      coverage: decoded.coverage,
      limitations: 'Publication metadata only. Feed snippets may be truncated and document body language is unknown. Policy categories are source tags, not verified claims, incident locations or legal effects. The rolling feed may omit publications between checks; disappearance is not withdrawal.' };
    if (UTF8.encode(pluginJson(artifact)).byteLength > EC_PRESS_PLUGIN.maxArtifactBytes) fail('EC overview exceeds its artifact bound');
    guard();
    return { ...base, checkedAt: new Date(now()).toISOString(), outcome: 'validated', sourceUpdatedAt: decoded.sourceUpdatedAt, sourceVersion: 'RSS 2.0',
      raw: { bytes, mediaType: 'application/rss+xml', sha256: rawSha }, canonicalFacts: decoded.canonicalFacts, factsDigest, artifact };
  } finally { clearTimeout(timer); }
}
