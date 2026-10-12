import { readResponseBytesCapped } from '../../src/sources/httpBody.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from '../../src/core/plugin-evidence.js';
import { parseBoundedRssXml, rssField, rssScalar, rssKeysAllowed, rssPublicationTime } from './bounded-rss.js';

export const ECB_PRESS_PLUGIN = Object.freeze({
  schemaVersion: 1, pluginId: 'ecb-press-v1', scopeId: 'ecb-institutional-press-en-v1', kind: 'publication-feed',
  sourceId: 'ecb', name: 'ECB institutional press releases', sourceUrl: 'https://www.ecb.europa.eu/rss/press.html',
  cadenceMs: 300000, deadlineMs: 20000, maxResponseBytes: 524288, maxItems: 32, maxArtifactBytes: 65536,
  rights: Object.freeze({ attribution: 'European Central Bank',
    policyUrl: 'https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html',
    scope: 'Accurately attributed institutional release title/link/publication metadata; named-author speeches, interviews, research publications and images are excluded.' }),
  coverage: Object.freeze({ mode: 'rolling-provider-feed', completeArchive: false, absenceMeaning: 'not-withdrawal' }),
});

const UTF8 = new TextEncoder(), MAX_XML_ITEMS = 100;
const atomNamespace = 'http://www.w3.org/2005/Atom';
const publicationUrl = /^https:\/\/www\.ecb\.europa\.eu\/{1,2}press\/pr\/date\/(\d{4})\/html\/ecb\.pr(\d{2})\d{4}(?:_\d{1,3})?~[a-f0-9]{10}\.en\.html$/;
const validEtag = value => value == null ? null : typeof value === 'string' && /^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(value) ? value : undefined;
const validModified = value => value == null ? null : typeof value === 'string' && value.length <= 128 &&
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const fail = message => { throw Object.assign(new TypeError(message), { code: 'ECB_FEED_INVALID' }); };

const syntax = error => { if (error.code !== 'RSS_XML_INVALID') throw error; fail(error.message.replaceAll('RSS XML','ECB XML').replaceAll('RSS field','ECB RSS field')); };
const keysAllowed = rssKeysAllowed;
function scalar(node, allowed = []) { try { return rssScalar(node, allowed); } catch (error) { syntax(error); } }
function field(node, name, required = true) { try { return rssField(node, name, required); } catch (error) { syntax(error); } }
function parseRss(bytes, guard) { try { return parseBoundedRssXml(bytes, { guard, maxBytes: ECB_PRESS_PLUGIN.maxResponseBytes }); } catch (error) { syntax(error); } }
export function ecbPublicationTime(value) { try { return rssPublicationTime(value); } catch (error) { syntax(error); } }

export async function decodeEcbPress(bytes, { now = Date.now, guard = () => {} } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ECB_PRESS_PLUGIN.maxResponseBytes || !bytes.byteLength) fail('Invalid bounded ECB RSS bytes');
  const rss = parseRss(bytes, guard);
  if (rss.name !== 'rss' || rss.attrs.version !== '2.0' || !keysAllowed(rss, ['version', 'xmlns:atom']) ||
      rss.attrs['xmlns:atom'] && rss.attrs['xmlns:atom'] !== atomNamespace || rss.text.trim() || rss.children.length !== 1 || rss.children[0].name !== 'channel') fail('Unsupported ECB RSS root or namespace');
  const channel = rss.children[0];
  if (Object.keys(channel.attrs).length || channel.text.trim()) fail('Unsupported ECB RSS channel');
  const channelNames = ['title', 'link', 'description', 'language', 'copyright', 'webMaster', 'managingEditor', 'lastBuildDate', 'pubDate', 'category', 'generator', 'docs', 'ttl', 'item', 'atom:link'];
  for (const node of channel.children) {
    if (!channelNames.includes(node.name)) fail('Unsupported ECB RSS channel field or namespace');
    if (node.name === 'item') continue;
    if (node.name === 'atom:link') {
      if (rss.attrs['xmlns:atom'] !== atomNamespace || node.children.length || node.text.trim() || !keysAllowed(node, ['href', 'rel', 'type']) ||
          node.attrs.href !== ECB_PRESS_PLUGIN.sourceUrl || node.attrs.rel !== 'self' || node.attrs.type !== 'application/rss+xml') fail('Ambiguous ECB RSS Atom link');
    } else scalar(node);
  }
  if (scalar(field(channel, 'title')).trim() !== 'ECB - European Central Bank' || scalar(field(channel, 'link')).trim() !== 'https://www.ecb.europa.eu/' ||
      scalar(field(channel, 'language')).trim() !== 'en') fail('ECB RSS publisher identity mismatch');
  const updated = field(channel, 'lastBuildDate', false), sourceUpdatedAt = updated ? ecbPublicationTime(scalar(updated).trim()) : null;
  const rows = channel.children.filter(node => node.name === 'item'); if (rows.length > MAX_XML_ITEMS) fail('ECB RSS item count exceeds its bound');
  const items = [], seen = new Set(), nowMs = now();
  if (!Number.isFinite(nowMs)) fail('Invalid ECB acquisition clock');
  for (const row of rows) {
    guard();
    if (Object.keys(row.attrs).length || row.text.trim() || row.children.some(node => !['title', 'link', 'guid', 'pubDate', 'description', 'author', 'category', 'comments'].includes(node.name))) fail('Unsupported ECB RSS item field or namespace');
    for (const node of row.children) scalar(node, node.name === 'guid' ? ['isPermaLink'] : []);
    const title = scalar(field(row, 'title')).trim(), link = scalar(field(row, 'link')).trim(), guidNode = field(row, 'guid'), guid = scalar(guidNode, ['isPermaLink']);
    if (guid !== guid.trim() || !guid || guid.length > 2048 || seen.has(guid) || guidNode.attrs.isPermaLink && !['true', 'false'].includes(guidNode.attrs.isPermaLink)) fail('Invalid or duplicate ECB source GUID');
    seen.add(guid);
    const match = publicationUrl.exec(link);
    if (!match) continue; // Speeches/interviews/accounts/foreign sources are outside this reviewed scope.
    const author = field(row, 'author', false); if (author && scalar(author).trim()) continue;
    if (guid !== link || match[1].slice(-2) !== match[2] || !title || UTF8.encode(title).byteLength > 512) fail('Invalid ECB institutional publication identity');
    const publishedRaw = scalar(field(row, 'pubDate')).trim(), publishedAt = ecbPublicationTime(publishedRaw);
    if (Date.parse(publishedAt) > nowMs + 300000) fail('ECB publication is future-dated');
    const facts = { schemaVersion: 1, kind: 'original-publication', publisherId: 'ecb', sourceRecordId: guid, title, url: link,
      publishedAt, publishedRaw, publishedPrecision: 'second' };
    const itemId = `publication:ecb:${await pluginBytesDigest(UTF8.encode(guid))}`, sourceRevision = await pluginFactsDigest(facts);
    items.push({ itemId, ...facts, sourceRevision });
    if (items.length > ECB_PRESS_PLUGIN.maxItems) fail('ECB institutional publication count exceeds its bound');
  }
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.itemId.localeCompare(b.itemId));
  return { canonicalFacts: { schemaVersion: 1, scopeId: ECB_PRESS_PLUGIN.scopeId, items }, sourceUpdatedAt,
    coverage: { ...ECB_PRESS_PLUGIN.coverage, feedItems: rows.length, selectedItems: items.length, excludedItems: rows.length - items.length } };
}

export const ecbPressItems = canonicalFacts => canonicalFacts.items;

async function bounded(task, signal) {
  signal.throwIfAborted(); let abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return task(); }).then(value => {
      if (signal.aborted && value?.body?.cancel) void value.body.cancel().catch(() => {});
      return value;
    }), new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
const closeResponse = response => { if (response.body) void response.body.cancel().catch(() => {}); };

export async function collectEcbPress({ now = Date.now, signal: callerSignal, previous = {}, fetchImpl = fetch } = {}) {
  const controller = new AbortController(), expiresAt = Date.now() + ECB_PRESS_PLUGIN.deadlineMs;
  const timer = setTimeout(() => controller.abort(new DOMException('ECB acquisition timed out', 'TimeoutError')), ECB_PRESS_PLUGIN.deadlineMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const guard = () => { signal.throwIfAborted(); if (Date.now() >= expiresAt) throw new DOMException('ECB acquisition deadline exceeded', 'TimeoutError'); };
  try {
    guard();
    const etag = validEtag(previous.validators?.etag), modified = validModified(previous.validators?.lastModified);
    if (etag === undefined || modified === undefined) fail('Invalid ECB conditional validators');
    const hasPrevious = /^[a-f0-9]{64}$/.test(previous.factsDigest || ''), headers = { Accept: 'application/rss+xml, application/xml;q=0.9', 'User-Agent': 'earth-observer-source-plugin/1.0' };
    if (hasPrevious && etag) headers['If-None-Match'] = etag;
    else if (hasPrevious && modified) headers['If-Modified-Since'] = modified;
    const response = await bounded(() => fetchImpl(ECB_PRESS_PLUGIN.sourceUrl, { signal, redirect: 'error', credentials: 'omit', headers }), signal);
    if (response.redirected || response.url && response.url !== ECB_PRESS_PLUGIN.sourceUrl) { closeResponse(response); fail('ECB feed changed its fixed source'); }
    const responseEtag = validEtag(response.headers.get('etag')), responseModified = validModified(response.headers.get('last-modified'));
    if (responseEtag === undefined || responseModified === undefined) { closeResponse(response); fail('Invalid ECB response validators'); }
    const validators = { etag: response.status === 304 ? responseEtag ?? etag : responseEtag,
      lastModified: response.status === 304 ? responseModified ?? modified : responseModified };
    const base = { schemaVersion: 1, pluginId: ECB_PRESS_PLUGIN.pluginId, scopeId: ECB_PRESS_PLUGIN.scopeId,
      kind: ECB_PRESS_PLUGIN.kind, checkedAt: new Date(now()).toISOString(), validators, sourceUrl: ECB_PRESS_PLUGIN.sourceUrl };
    if (response.status === 304) {
      closeResponse(response); if (!hasPrevious || !headers['If-None-Match'] && !headers['If-Modified-Since']) fail('Unsolicited ECB not-modified response');
      return { ...base, outcome: 'not-modified', factsDigest: previous.factsDigest,
        sourceUpdatedAt: null, sourceVersion: null, raw: null, canonicalFacts: null, artifact: null };
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after'), delay = /^\d{1,9}$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
      closeResponse(response); throw Object.assign(new Error(`ECB feed HTTP ${response.status}`), { code: 'ECB_FEED_HTTP', httpStatus: response.status,
        retryAfterMs: Number.isFinite(delay) ? Math.max(0, Math.min(86400000, delay)) : 0 });
    }
    const type = response.headers.get('content-type') || '';
    if (!/^(?:application\/(?:rss\+xml|xml)|text\/xml)(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(type)) { closeResponse(response); fail('ECB source did not return supported UTF-8 RSS XML'); }
    const bytes = await bounded(() => readResponseBytesCapped(response, ECB_PRESS_PLUGIN.maxResponseBytes, signal), signal);
    guard(); const decoded = await bounded(() => decodeEcbPress(bytes, { now, guard }), signal); guard();
    const factsDigest = await pluginFactsDigest(decoded.canonicalFacts), rawSha = await pluginBytesDigest(bytes);
    const artifact = { schemaVersion: 1, kind: 'publication-feed-overview', pluginId: ECB_PRESS_PLUGIN.pluginId, scopeId: ECB_PRESS_PLUGIN.scopeId,
      title: ECB_PRESS_PLUGIN.name, items: decoded.canonicalFacts.items.map(item => ({ ...item,
        evidence: { sourceUrl: ECB_PRESS_PLUGIN.sourceUrl, locator: { kind: 'rss-guid', guid: item.sourceRecordId } } })),
      relationships: [{ kind: 'jurisdiction', subject: 'organization:ecb', object: 'jurisdiction:euro-area', basis: 'publisher-remit', geometry: null }],
      coverage: decoded.coverage };
    if (UTF8.encode(pluginJson(artifact)).byteLength > ECB_PRESS_PLUGIN.maxArtifactBytes) fail('ECB overview exceeds its artifact bound');
    guard();
    return { ...base, checkedAt: new Date(now()).toISOString(), outcome: 'validated', sourceUpdatedAt: decoded.sourceUpdatedAt, sourceVersion: 'RSS 2.0',
      raw: { bytes, mediaType: 'application/rss+xml', sha256: rawSha }, canonicalFacts: decoded.canonicalFacts, factsDigest, artifact };
  } finally { clearTimeout(timer); }
}
