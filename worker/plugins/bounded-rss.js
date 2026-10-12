/** Bounded syntax primitives for reviewed RSS adapters, not a general XML parser.
 * Publisher identity, namespaces and fields are admitted by each adapter separately.
 * No DTDs, custom entities, external resolution or arbitrary processing instructions.
 */
export const RSS_XML_LIMITS = Object.freeze({ bytes: 524288, nodes: 2048, text: 16384, tag: 4096, depth: 4 });
const fail = message => { throw Object.assign(new TypeError(message), { code: 'RSS_XML_INVALID' }); };

function entities(value) {
  const reference = '(?:#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos)';
  if (new RegExp(`&(?!(?:${reference});)`).test(value)) fail('Unsupported or malformed RSS XML entity');
  const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_, name) => {
    if (Object.hasOwn(predefined, name)) return predefined[name];
    const point = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (![9, 10, 13].includes(point) && !(point >= 32 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff))
      fail('Invalid RSS XML character reference');
    return String.fromCodePoint(point);
  });
}
function attributes(value) {
  const result = Object.create(null), pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)[\t\r\n ]*=[\t\r\n ]*("[^"<]*"|'[^'<]*')/y;
  let at = 0;
  while (at < value.length) {
    const whitespace = /^[\t\r\n ]+/.exec(value.slice(at));
    if (!whitespace) fail('Missing whitespace between RSS XML attributes');
    at += whitespace[0].length; if (at === value.length) break;
    pattern.lastIndex = at; const match = pattern.exec(value);
    if (!match || Object.hasOwn(result, match[1])) fail('Invalid or duplicate RSS XML attribute');
    result[match[1]] = entities(match[2].slice(1, -1)); at = pattern.lastIndex;
  }
  return result;
}

export function parseBoundedRssXml(bytes, { guard = () => {}, maxBytes = RSS_XML_LIMITS.bytes } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > RSS_XML_LIMITS.bytes || bytes.byteLength > maxBytes || typeof guard !== 'function')
    fail('Invalid bounded RSS XML bytes');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('RSS XML is not valid UTF-8'); }
  const roots = [], stack = []; let at = 0, nodes = 0, declaration = false;
  if (text.charCodeAt(0) === 0xfeff) at++; // Parse view only; raw evidence stays untouched.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) fail('Invalid RSS XML control character');
  const append = (value, cdata = false) => {
    if (!stack.length) { if (value.trim()) fail('RSS XML text outside root'); return; }
    if (!cdata && value.includes(']]>')) fail('Invalid RSS XML text');
    const node = stack.at(-1); node.text += cdata ? value : entities(value);
    if (node.text.length > RSS_XML_LIMITS.text) fail('RSS XML text exceeds its bound');
  };
  while (at < text.length) {
    guard();
    if (text[at] !== '<') { const end = text.indexOf('<', at); append(text.slice(at, end < 0 ? text.length : end)); at = end < 0 ? text.length : end; continue; }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0 || end - at > RSS_XML_LIMITS.text || text.slice(at + 4, end).includes('--')) fail('Invalid RSS XML comment');
      at = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at + 9); if (end < 0 || !stack.length) fail('Invalid RSS XML CDATA');
      append(text.slice(at + 9, end), true); at = end + 3; continue;
    }
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end < 0 || declaration || roots.length || text.slice(at + 2, at + 5) !== 'xml') fail('Unsupported RSS XML processing instruction');
      const attrs = attributes(text.slice(at + 5, end));
      if (attrs.version !== '1.0' || attrs.encoding && !/^utf-8$/i.test(attrs.encoding) ||
          Object.keys(attrs).some(key => !['version', 'encoding', 'standalone'].includes(key)) ||
          attrs.standalone && !['yes', 'no'].includes(attrs.standalone)) fail('Unsupported RSS XML declaration');
      declaration = true; at = end + 2; continue;
    }
    if (text.startsWith('<!', at)) fail('RSS XML DTDs and entity declarations are forbidden');
    let end = at + 1, quote = null;
    while (end < text.length) {
      if (end - at > RSS_XML_LIMITS.tag) fail('RSS XML tag exceeds its bound');
      const character = text[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') fail('Invalid RSS XML tag');
      end++;
    }
    if (end === text.length) fail('Unclosed RSS XML tag');
    const tag = text.slice(at + 1, end); at = end + 1;
    if (tag.startsWith('/')) {
      if (!/^\/[A-Za-z_][A-Za-z0-9_.:-]*[\t\r\n ]*$/.test(tag) || stack.pop()?.name !== tag.slice(1).trim()) fail('Mismatched RSS XML close tag');
      continue;
    }
    const empty = tag.endsWith('/'), content = empty ? tag.slice(0, -1) : tag;
    const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(content);
    if (!match || ++nodes > RSS_XML_LIMITS.nodes || stack.length >= RSS_XML_LIMITS.depth) fail('RSS XML nesting or node limit exceeded');
    const node = { name: match[1], attrs: attributes(match[2]), text: '', children: [] };
    if (stack.length) stack.at(-1).children.push(node); else { if (roots.length) fail('Multiple RSS XML roots'); roots.push(node); }
    if (!empty) stack.push(node);
  }
  if (stack.length || roots.length !== 1) fail('Incomplete RSS XML document');
  return roots[0];
}

export const rssKeysAllowed = (node, allowed) => Object.keys(node.attrs).every(key => allowed.includes(key));
export function rssScalar(node, allowed = []) {
  if (!node || node.children.length || !rssKeysAllowed(node, allowed)) fail('Unsupported RSS field structure');
  return node.text;
}
export function rssField(node, name, required = true) {
  const children = node.children.filter(child => child.name === name);
  if (children.length > 1 || required && children.length !== 1) fail('Duplicate or missing RSS field');
  return children[0];
}

/** RFC822 source timestamp with an explicit offset, valid calendar and weekday. */
export function rssPublicationTime(value) {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|[+-]\d{4})$/.exec(value);
  if (!match) fail('RSS publication time lacks an explicit supported timezone');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = Number(match[4]), month = months.indexOf(match[3]), day = Number(match[2]), hour = Number(match[5]), minute = Number(match[6]), second = Number(match[7]);
  const local = new Date(Date.UTC(year, month, day, hour, minute, second));
  const zone = match[8], offsetHour = zone === 'GMT' ? 0 : Number(zone.slice(1, 3)), offsetMinute = zone === 'GMT' ? 0 : Number(zone.slice(3, 5));
  if (year < 1970 || year > 2100 || local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getUTCDay()] !== match[1] ||
      offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute) fail('Invalid RSS publication calendar time');
  const offset = (zone.startsWith('-') ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  return new Date(local.getTime() - offset * 60000).toISOString();
}

