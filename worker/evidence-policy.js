export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_EVIDENCE_BODY = MAX_PHOTO_BYTES + 65536;
export class EvidenceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function safeEvidenceUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048 || !host.includes('.') || host.includes(':') || /(^|\.)(localhost|local|internal)$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) throw new Error();
    return url.href;
  } catch { throw new EvidenceError('Use a public HTTP or HTTPS source link.'); }
}
const textField = (value, max, name) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new EvidenceError(`${name} is missing or too long.`);
  return value.trim();
};
export function normalizeSubmission(values) {
  if (values.publishConsent !== 'yes' || values.rightsConsent !== 'yes') throw new EvidenceError('Confirm publication consent and your rights to the submitted material.');
  const title = textField(values.title, 160, 'Title'), text = textField(values.text, 5000, 'Description'), alias = textField(values.alias, 40, 'Display alias');
  if (!title || text.length < 5 || !alias || /[@<>]|https?:\/\//i.test(alias)) throw new EvidenceError('Add a title, description and public display alias. Do not use an email address as your alias.');
  let location = null;
  if (values.lat !== undefined || values.lon !== undefined) {
    const lat = values.lat === '' ? NaN : Number(values.lat), lon = values.lon === '' ? NaN : Number(values.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new EvidenceError('The selected map coordinates are invalid.');
    location = { lat: Number(lat.toFixed(3)), lon: Number(lon.toFixed(3)), meaning: 'Contributor-selected map location; not independently verified' };
  }
  let observedAt = null;
  if (values.observedAt) {
    if (typeof values.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(values.observedAt) || !Number.isFinite(Date.parse(values.observedAt))) throw new EvidenceError('Use a valid observation date and time.');
    observedAt = new Date(values.observedAt).toISOString();
  }
  return { title, text, alias, sourceUrl: safeEvidenceUrl(values.sourceUrl), location, observedAt, consent: { publication: true, rights: true, version: '2026-10-11' } };
}

/** Canvas JPEGs only: reject embedded metadata, oversized dimensions and malformed segment/scan boundaries. */
export function inspectEvidenceJpeg(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.length > MAX_PHOTO_BYTES) throw new EvidenceError('The processed photograph must be 2 MB or smaller.', 413);
  const invalid = () => { throw new EvidenceError('The photograph is not a supported, complete JPEG image.'); };
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2, frame = null, hasScan = false, segments = 0, frameMarker, componentIds;
  while (offset < bytes.length && ++segments < 2048) {
    if (bytes[offset] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { if (!frame || !hasScan || offset !== bytes.length) invalid(); return frame; }
    if (marker === 0x00 || marker === 0xd8 || marker === undefined || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (offset + 2 > bytes.length) invalid();
    const length = bytes[offset] * 256 + bytes[offset + 1], end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) throw new EvidenceError('Embedded photo metadata is not accepted. Re-process the photograph before submitting.');
    if (marker === 0xe0 && (length !== 16 || String.fromCharCode(...bytes.slice(offset + 2, offset + 7)) !== 'JFIF\0' || bytes[end - 2] !== 0 || bytes[end - 1] !== 0)) throw new EvidenceError('Unsupported embedded photo metadata.');
    if (![0xe0, 0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xda].includes(marker)) invalid();
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 8) invalid();
      const height = bytes[offset + 3] * 256 + bytes[offset + 4], width = bytes[offset + 5] * 256 + bytes[offset + 6], components = bytes[offset + 7];
      if (!width || !height || width > 2048 || height > 2048 || width * height > 4194304 || ![1, 3].includes(components) || length !== 8 + 3 * components || bytes[offset + 2] !== 8) invalid();
      componentIds = new Set();
      for (let index = 0; index < components; index++) {
        const start = offset + 8 + index * 3, sampling = bytes[start + 1];
        if (componentIds.has(bytes[start]) || !(sampling >> 4) || !(sampling & 15) || (sampling >> 4) > 4 || (sampling & 15) > 4 || bytes[start + 2] > 3) invalid();
        componentIds.add(bytes[start]);
      }
      frame = { width, height }; frameMarker = marker;
    }
    if (marker === 0xdd && length !== 4) invalid();
    if (marker === 0xda) {
      const components = bytes[offset + 2];
      if (!frame || !components || components > componentIds.size || length !== 6 + 2 * components || (frameMarker === 0xc0 && hasScan)) invalid();
      const selected = new Set();
      for (let index = 0; index < components; index++) {
        const start = offset + 3 + index * 2, tables = bytes[start + 1];
        if (!componentIds.has(bytes[start]) || selected.has(bytes[start]) || (tables >> 4) > 3 || (tables & 15) > 3) invalid();
        selected.add(bytes[start]);
      }
      if (frameMarker === 0xc0 && (bytes[end - 3] !== 0 || bytes[end - 2] !== 63 || bytes[end - 1] !== 0)) invalid();
      if (frameMarker === 0xc2 && (bytes[end - 3] > bytes[end - 2] || bytes[end - 2] > 63 || (bytes[end - 1] >> 4) > 13 || (bytes[end - 1] & 15) > 13)) invalid();
    }
    offset = end;
    if (marker === 0xda) {
      hasScan = true;
      // Escaped 0xff and restart markers are scan bytes; all other markers return to the parser.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        const scanMarker = bytes[next];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) { offset = next + 1; continue; }
        break;
      }
    }
  }
  invalid();
}
export async function readBoundedBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new EvidenceError('The submission is too large.', 413);
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const parts = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new EvidenceError('The submission is too large.', 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
