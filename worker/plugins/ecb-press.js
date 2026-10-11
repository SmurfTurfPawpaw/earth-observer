import { readResponseBytesCapped } from '../../src/sources/httpBody.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from '../../src/core/plugin-evidence.js';

export const ECB_PRESS_PLUGIN = Object.freeze({
  schemaVersion: 1, pluginId: 'ecb-press-v1', scopeId: 'ecb-institutional-press-en-v1', kind: 'publication-feed',
  sourceId: 'ecb', name: 'ECB institutional press releases', sourceUrl: 'https://www.ecb.europa.eu/rss/press.html',
  cadenceMs: 300000, deadlineMs: 20000, maxResponseBytes: 524288, maxItems: 32, maxArtifactBytes: 65536,
  rights: Object.freeze({ attribution: 'European Central Bank',
    policyUrl: 'https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html',
    scope: 'Accurately attributed institutional release title/link/publication metadata; named-author speeches, interviews, research publications and images are excluded.' }),
  coverage: Object.freeze({ mode: 'rolling-provider-feed', completeArchive: false, absenceMeaning: 'not-withdrawal' }),
});

const UTF8 = new TextEncoder(), MAX_XML_ITEMS = 100, MAX_XML_NODES = 2048, MAX_XML_TEXT = 16384;
const atomNamespace = 'http://www.w3.org/2005/Atom';
const keyNames = ['title', 'link', 'guid', 'pubDate'];
const publicationUrl = /^https:\/\/www\.ecb\.europa\.eu\/{1,2}press\/pr\/date\/(\d{4})\/html\/ecb\.pr(\d{2})\d{4}(?:_\d{1,3})?~[a-f0-9]{10}\.en\.html$/;
const validEtag = value => value == null ? null : typeof value === 'string' && /^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(value) ? value : undefined;
const validModified = value => value == null ? null : typeof value === 'string' && value.length <= 128 &&
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const fail = message => { throw Object.assign(new TypeError(message), { code: 'ECB_FEED_INVALID' }); };

function xmlEntities(value) {
  const reference = '(?:#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos)';
  if (new RegExp(`&(?!(?:${reference});)`).test(value)) fail('Unsupported or malformed ECB XML entity');
  const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_, name) => {
    if (Object.hasOwn(predefined, name)) return predefined[name];
    const point = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (![9, 10, 13].includes(point) && !(point >= 32 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff))
      fail('Invalid ECB XML character reference');
    return String.fromCodePoint(point);
  });
}

function attributes(value) {
  const result = Object.create(null), pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)[\t\r\n ]*=[\t\r\n ]*("[^"<]*"|'[^'<]*')/y;
  let at = 0;
  while (at < value.length) {
    const whitespace = /^[\t\r\n ]+/.exec(value.slice(at));
    if (!whitespace) fail('Missing whitespace between ECB XML attributes');
    at += whitespace[0].length; if (at === value.length) break;
    pattern.lastIndex = at; const match = pattern.exec(value);
    if (!match || Object.hasOwn(result, match[1])) fail('Invalid or duplicate ECB XML attribute');
    result[match[1]] = xmlEntities(match[2].slice(1, -1)); at = pattern.lastIndex;
  }
  return result;
}

/** Narrow RSS grammar for this fixed publisher, not an HTML/general XML parser.
 * No DTDs, custom entities, external resolution, namespace rebinding or processing instructions. */
function parseXml(text, guard) {
  const roots = [], stack = []; let at = 0, nodes = 0, declaration = false;
  if (text.charCodeAt(0) === 0xfeff) at++; // Parsing view only; the original BOM is retained in raw bytes.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('Invalid ECB XML control character');
  const append = (value, cdata = false) => {
    if (!stack.length) { if (value.trim()) fail('ECB XML text outside root'); return; }
    if (!cdata && value.includes(']]>')) fail('Invalid ECB XML text');
    const node = stack.at(-1); node.text += cdata ? value : xmlEntities(value);
    if (node.text.length > MAX_XML_TEXT) fail('ECB XML text exceeds its bound');
  };
  while (at < text.length) {
    guard();
    if (text[at] !== '<') { const end = text.indexOf('<', at); append(text.slice(at, end < 0 ? text.length : end)); at = end < 0 ? text.length : end; continue; }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0 || end - at > MAX_XML_TEXT || text.slice(at + 4, end).includes('--')) fail('Invalid ECB XML comment');
      at = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at + 9); if (end < 0 || !stack.length) fail('Invalid ECB XML CDATA');
      append(text.slice(at + 9, end), true); at = end + 3; continue;
    }
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end < 0 || declaration || roots.length || text.slice(at + 2, at + 5) !== 'xml') fail('Unsupported ECB XML processing instruction');
      const attrs = attributes(text.slice(at + 5, end));
      if (attrs.version !== '1.0' || attrs.encoding && !/^utf-8$/i.test(attrs.encoding) ||
          Object.keys(attrs).some(key => !['version', 'encoding', 'standalone'].includes(key)) || attrs.standalone && !['yes', 'no'].includes(attrs.standalone)) fail('Unsupported ECB XML declaration');
      declaration = true; at = end + 2; continue;
    }
    if (text.startsWith('<!', at)) fail('ECB RSS DTDs and entity declarations are forbidden');
    let end = at + 1, quote = null;
    while (end < text.length) {
      if (end - at > 4096) fail('ECB XML tag exceeds its bound');
      const character = text[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') fail('Invalid ECB XML tag');
      end++;
    }
    if (end === text.length) fail('Unclosed ECB XML tag');
    const tag = text.slice(at + 1, end); at = end + 1;
    if (tag.startsWith('/')) {
      if (!/^\/[A-Za-z_][A-Za-z0-9_.:-]*[\t\r\n ]*$/.test(tag) || stack.pop()?.name !== tag.slice(1).trim()) fail('Mismatched ECB XML close tag');
      continue;
    }
    const empty = tag.endsWith('/'), content = empty ? tag.slice(0, -1) : tag, match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(content);
    if (!match || ++nodes > MAX_XML_NODES || stack.length >= 4) fail('ECB XML nesting or node limit exceeded');
    const node = { name: match[1], attrs: attributes(match[2]), text: '', children: [] };
    if (stack.length) stack.at(-1).children.push(node); else { if (roots.length) fail('Multiple ECB RSS roots'); roots.push(node); }
    if (!empty) stack.push(node);
  }
  if (stack.length || roots.length !== 1) fail('Incomplete ECB RSS document');
  return roots[0];
}

const keysAllowed = (node, allowed) => Object.keys(node.attrs).every(key => allowed.includes(key));
function scalar(node, allowed = []) {
  if (node.children.length || !keysAllowed(node, allowed)) fail('Unsupported ECB RSS field structure');
  return node.text;
}
function field(node, name, required = true) {
  const children = node.children.filter(child => child.name === name);
  if (children.length > 1 || required && children.length !== 1) fail('Duplicate or missing ECB RSS field');
  return children[0];
}

/** RFC 822 timestamp with explicit offset; reject rollover dates or incorrect weekdays. */
export function ecbPublicationTime(value) {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|[+-]\d{4})$/.exec(value);
  if (!match) fail('ECB publication time lacks an explicit supported timezone');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = Number(match[4]), month = months.indexOf(match[3]), day = Number(match[2]), hour = Number(match[5]), minute = Number(match[6]), second = Number(match[7]);
  const local = new Date(Date.UTC(year, month, day, hour, minute, second));
  const zone = match[8], offsetHour = zone === 'GMT' ? 0 : Number(zone.slice(1, 3)), offsetMinute = zone === 'GMT' ? 0 : Number(zone.slice(3, 5));
  if (year < 1970 || year > 2100 || local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getUTCDay()] !== match[1] ||
      offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute) fail('Invalid ECB publication calendar time');
  const offset = (zone.startsWith('-') ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  return new Date(local.getTime() - offset * 60000).toISOString();
}

export async function decodeEcbPress(bytes, { now = Date.now, guard = () => {} } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ECB_PRESS_PLUGIN.maxResponseBytes || !bytes.byteLength) fail('Invalid bounded ECB RSS bytes');
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('ECB RSS is not valid UTF-8'); }
  const rss = parseXml(text, guard);
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
