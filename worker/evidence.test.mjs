import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { handleEvidence } from './evidence.js';
import { inspectEvidenceJpeg, normalizeSubmission, safeEvidenceUrl, MAX_PHOTO_BYTES, MAX_EVIDENCE_BODY } from './evidence-policy.js';

globalThis.crypto ||= webcrypto;
// A real 2×2 RGB JPEG encoded by Pillow, without EXIF or other private metadata.
const PHOTO = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDmaKKKD5k//9k=', 'base64'));
const ORIGIN = 'https://observer.example.com', KEY = 'test-moderation-key-with-at-least-thirty-two-bytes';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const fields = { title: 'Flooded street', text: 'Water visible at the selected location.', alias: 'Local observer', sourceUrl: 'https://example.com/source', publishConsent: 'yes', rightsConsent: 'yes', lat: '50.850456', lon: '4.351749' };
class Bucket {
  items = new Map(); sequence = 0;
  async get(key) {
    const item = this.items.get(key); if (!item) return null;
    const bytes = item.bytes.slice();
    return { etag: item.etag, body: bytes, async arrayBuffer() { return bytes.buffer; }, async json() { return JSON.parse(new TextDecoder().decode(bytes)); } };
  }
  async put(key, value, options = {}) {
    const previous = this.items.get(key), condition = options.onlyIf;
    if (condition?.get?.('if-none-match') === '*' && previous || condition?.etagMatches && previous?.etag !== condition.etagMatches) return null;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice();
    const etag = String(++this.sequence); this.items.set(key, { bytes, etag }); return { key, etag };
  }
  async delete(key) { this.items.delete(key); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.items.keys()].filter((key) => key.startsWith(prefix)).sort(), start = Number(cursor || 0), page = keys.slice(start, start + limit);
    return { objects: page.map((key) => ({ key })), truncated: start + page.length < keys.length, cursor: String(start + page.length) };
  }
}
const environment = () => ({ EARTH_STORE: new Bucket(), EARTH_MODERATION_KEY: KEY });
function submission({ identity = 'trusted-user', values = {}, photo = PHOTO, headers = {} } = {}) {
  const form = new FormData(); for (const [key, value] of Object.entries({ ...fields, ...values })) { if (value !== undefined) form.set(key, value); }
  if (photo) form.set('photo', new Blob([photo], { type: 'image/jpeg' }), 'processed.jpg');
  return new Request(`${ORIGIN}/api/evidence/submissions`, { method: 'POST', headers: { origin: ORIGIN, ...(identity ? { 'oai-authenticated-user-id': identity } : {}), ...headers }, body: form });
}
const get = (path, headers = {}) => new Request(`${ORIGIN}${path}`, { headers });
const action = (id, value, key = KEY) => new Request(`${ORIGIN}/api/evidence/moderation/${id}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: value }) });
const handle = (request, env, overrides = {}) => handleEvidence(request, env, { now: () => NOW, createId: () => 'contribution-one', ...overrides });

test('anonymous and body/header impostors cannot submit; session only reveals sign-in availability', async () => {
  const env = environment();
  for (const request of [submission({ identity: null }), submission({ identity: null, values: { userId: 'pretend', email: 'fake@example.com' }, headers: { 'x-user-id': 'pretend', 'oai-authenticated-user-email': 'fake@example.com' } }), submission({ identity: 'invalid identity' })]) assert.equal((await handle(request, env)).status, 401);
  assert.equal(env.EARTH_STORE.items.size, 0);
  assert.deepEqual(await (await handle(get('/api/evidence/session'), env)).json(), { signedIn: false, enabled: true, maxPhotoBytes: MAX_PHOTO_BYTES });
  assert.equal(await handle(get('/api/earthquakes'), env), null);
});
test('writes fail closed without moderation configuration or same-origin form submission', async () => {
  const env = environment(); delete env.EARTH_MODERATION_KEY;
  assert.equal((await handle(submission(), env)).status, 503);
  assert.equal((await handle(get('/api/evidence/moderation', { authorization: `Bearer ${KEY}` }), env)).status, 503);
  for (const headers of [{ origin: '' }, { origin: 'https://other.example.com' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await handle(submission({ headers }), environment())).status, 403);
});
test('consent, aliases and source links are validated and map coordinates are rounded', () => {
  const normalized = normalizeSubmission(fields); assert.deepEqual(normalized.location, { lat: 50.85, lon: 4.352, meaning: 'Contributor-selected map location; not independently verified' });
  for (const values of [{ publishConsent: undefined }, { rightsConsent: 'false' }, { alias: 'person@example.com' }, { sourceUrl: 'javascript:alert(1)' }, { lat: 'invalid' }, { lon: '181' }]) assert.throws(() => normalizeSubmission({ ...fields, ...values }));
  for (const url of ['https://user:pass@example.com', 'http://127.0.0.1', 'http://localhost', 'http://test.internal', 'http://[::1]']) assert.throws(() => safeEvidenceUrl(url));
});
test('JPEG profile accepts a real image and rejects embedded metadata, truncation, malformed scans and excess dimensions', () => {
  assert.deepEqual(inspectEvidenceJpeg(PHOTO), { width: 2, height: 2 });
  const withMarker = (marker) => Uint8Array.from([...PHOTO.slice(0, 2), 255, marker, 0, 8, 69, 120, 105, 102, 0, 0, ...PHOTO.slice(2)]);
  for (const photo of [withMarker(0xe1), withMarker(0xed), withMarker(0xfe), PHOTO.slice(0, -2), Uint8Array.from([...PHOTO, 0]), new Uint8Array(20)]) assert.throws(() => inspectEvidenceJpeg(photo));
  const oversized = PHOTO.slice(), frame = oversized.findIndex((byte, index) => byte === 255 && oversized[index + 1] === 192); oversized[frame + 7] = 9; oversized[frame + 8] = 0; assert.throws(() => inspectEvidenceJpeg(oversized));
  const scan = PHOTO.slice(), scanIndex = scan.findIndex((byte, index) => byte === 255 && scan[index + 1] === 218); scan[scanIndex + 4] = 0; assert.throws(() => inspectEvidenceJpeg(scan));
  assert.throws(() => inspectEvidenceJpeg(new Uint8Array(MAX_PHOTO_BYTES + 1)), (error) => error.status === 413);
});
test('malformed, metadata-bearing and oversized uploads are rejected before R2 writes', async () => {
  const env = environment(), metadata = Uint8Array.from([255, 216, 255, 225, 0, 8, 69, 120, 105, 102, 0, 0, ...PHOTO.slice(2)]);
  for (const photo of [PHOTO.slice(0, -2), metadata]) assert.equal((await handle(submission({ photo }), env)).status, 400);
  const request = new Request(`${ORIGIN}/api/evidence/submissions`, { method: 'POST', headers: { origin: ORIGIN, 'oai-authenticated-user-id': 'trusted-user', 'content-type': 'multipart/form-data; boundary=test', 'content-length': String(MAX_EVIDENCE_BODY + 1) }, body: 'test' });
  assert.equal((await handle(request, env)).status, 413); assert.equal(env.EARTH_STORE.items.size, 0);
});
test('accepted submissions and photos remain private until an authorized moderator approves', async () => {
  const env = environment(); assert.equal((await handle(submission({ values: { userId: 'body-impostor', publishedAt: '2020-01-01' } }), env)).status, 202);
  const pending = await (await env.EARTH_STORE.get('evidence/pending/contribution-one.json')).json(); assert.equal(pending.userId, 'trusted-user'); assert.equal(pending.status, 'pending');
  assert.deepEqual((await (await handle(get('/api/evidence'), env)).json()).contributions, []);
  assert.equal((await handle(get('/api/evidence/contribution-one/photo'), env)).status, 404);
  assert.equal((await handle(get('/api/evidence/moderation/contribution-one/photo'), env)).status, 401);
  const privateImage = await handle(get('/api/evidence/moderation/contribution-one/photo', { authorization: `Bearer ${KEY}` }), env); assert.equal(privateImage.status, 200); assert.equal(privateImage.headers.get('cache-control'), 'no-store');
  assert.equal((await handle(action('contribution-one', 'approve', 'wrong-key'), env)).status, 403);
  assert.equal((await handle(action('contribution-one', 'approve'), env)).status, 200);
  const publicData = await (await handle(get('/api/evidence'), env)).json(); assert.equal(publicData.contributions.length, 1); assert.equal(publicData.contributions[0].photoUrl, '/api/evidence/contribution-one/photo');
  assert.equal('userId' in publicData.contributions[0], false); assert.equal('consent' in publicData.contributions[0], false); assert.match(publicData.contributions[0].verification, /not independently verified/);
  assert.equal(await env.EARTH_STORE.get('evidence/pending/contribution-one.json'), null); assert.equal(await env.EARTH_STORE.get('evidence/pending-photos/contribution-one.jpg'), null);
  const image = await handle(get('/api/evidence/contribution-one/photo'), env); assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PHOTO); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal((await handle(action('contribution-one', 'unpublish'), env)).status, 200); assert.equal((await handle(get('/api/evidence/contribution-one/photo'), env)).status, 404); assert.equal((await (await handle(get('/api/evidence'), env)).json()).contributions.length, 0);
});
test('moderation uses the separate secret, hides owner identifiers and deletes rejected photos', async () => {
  const env = environment(); await handle(submission(), env);
  assert.equal((await handle(get('/api/evidence/moderation', { 'oai-authenticated-user-id': 'trusted-user' }), env)).status, 401);
  const data = await (await handle(get('/api/evidence/moderation', { authorization: `Bearer ${KEY}` }), env)).json(); assert.equal(data.submissions.length, 1); assert.equal('userId' in data.submissions[0], false);
  assert.equal((await handle(action('contribution-one', 'reject'), env)).status, 200); assert.equal(await env.EARTH_STORE.get('evidence/pending/contribution-one.json'), null); assert.equal(await env.EARTH_STORE.get('evidence/pending-photos/contribution-one.jpg'), null);
});
test('photo integrity is checked again at approval and changed photos stay unpublished', async () => {
  const env = environment(); await handle(submission(), env);
  const changed = PHOTO.slice(); changed[changed.length - 4] ^= 1; await env.EARTH_STORE.put('evidence/pending-photos/contribution-one.jpg', changed);
  assert.equal((await handle(action('contribution-one', 'approve'), env)).status, 409); assert.equal((await (await handle(get('/api/evidence'), env)).json()).contributions.length, 0);
});
test('submission spacing and queue capacity bound writes', async () => {
  const env = environment(); await handle(submission({ photo: null }), env); assert.equal((await handle(submission({ photo: null }), env)).status, 429);
  for (let index = 0; index < 100; index++) await env.EARTH_STORE.put(`evidence/pending/item-${index}.json`, '{}');
  assert.equal((await handle(submission({ identity: 'different-user' }), env)).status, 429);
});
test('an identity collision does not overwrite or delete another pending photograph', async () => {
  const env = environment(); await handle(submission(), env);
  assert.equal((await handle(submission({ identity: 'different-user' }), env)).status, 409);
  assert.deepEqual(new Uint8Array(await (await env.EARTH_STORE.get('evidence/pending-photos/contribution-one.jpg')).arrayBuffer()), PHOTO);
  assert.equal((await (await env.EARTH_STORE.get('evidence/pending/contribution-one.json')).json()).userId, 'trusted-user');
});
test('public routes require a published record even if an unapproved object is accidentally put under a public prefix', async () => {
  const env = environment();
  await env.EARTH_STORE.put('evidence/public/records/unapproved.json', JSON.stringify({ id: 'unapproved', status: 'pending', publishedAt: new Date(NOW).toISOString(), title: 'Hidden', photo: {} }));
  await env.EARTH_STORE.put('evidence/public/photos/unapproved.jpg', PHOTO);
  assert.equal((await (await handle(get('/api/evidence'), env)).json()).contributions.length, 0);
  assert.equal((await handle(get('/api/evidence/unapproved/photo'), env)).status, 404);
});
