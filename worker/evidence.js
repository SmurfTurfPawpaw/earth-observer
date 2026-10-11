import { EvidenceError, normalizeSubmission, inspectEvidenceJpeg, readBoundedBody, MAX_EVIDENCE_BODY } from './evidence-policy.js';

const ROOT = 'evidence/';
const MAX_PENDING = 100, MAX_APPROVED = 500;
const validId = (id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const isPublished = (record) => validId(record?.id || '') && record.status === 'published' && Number.isFinite(Date.parse(record.publishedAt));
const absentCondition = () => new Headers({ 'If-None-Match': '*' });
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const userId = (request) => { const id = request.headers.get('oai-authenticated-user-id'); return id && id.length <= 256 && !/[\s\u0000-\u001f]/.test(id) ? id : null; };
const configured = (env) => Boolean(env.EARTH_STORE?.get && env.EARTH_STORE?.put && env.EARTH_STORE?.list && env.EARTH_STORE?.delete && typeof env.EARTH_MODERATION_KEY === 'string' && env.EARTH_MODERATION_KEY.length >= 32 && env.EARTH_MODERATION_KEY.length <= 256);
async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
async function moderator(request, env) {
  if (!configured(env)) throw new EvidenceError('Community submissions are not configured on this host.', 503);
  const candidate = request.headers.get('authorization')?.match(/^Bearer (.{1,256})$/)?.[1];
  if (!candidate) throw new EvidenceError('Moderator authorization is required.', 401);
  const [expected, supplied] = await Promise.all([digest(env.EARTH_MODERATION_KEY), digest(candidate)]);
  let difference = 0; for (let index = 0; index < 32; index++) difference |= expected[index] ^ supplied[index];
  if (difference !== 0) throw new EvidenceError('Moderator authorization is invalid.', 403);
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) throw new EvidenceError('Submissions must originate from this site.', 403);
}
const readJson = async (bucket, key) => { const value = await bucket.get(key); return value ? value.json() : null; };
const publicRecord = (record) => ({ id: record.id, title: record.title, text: record.text, alias: record.alias, sourceUrl: record.sourceUrl, location: record.location, observedAt: record.observedAt || null, submittedAt: record.submittedAt, publishedAt: record.publishedAt, verification: 'Community submission; reviewed for publication, not independently verified', photoUrl: record.photo ? `/api/evidence/${record.id}/photo` : null });
async function claim(bucket, key, { at, max, spacing = 0 }) {
  const previous = await bucket.get(key), stored = previous ? await previous.json() : null;
  const day = new Date(at).toISOString().slice(0, 10), count = stored?.day === day ? Number(stored.count) || 0 : 0;
  if (count >= max || (stored?.at != null && at - stored.at < spacing)) throw new EvidenceError('Submission limit reached. Please try again later.', 429);
  const result = await bucket.put(key, JSON.stringify({ day, count: count + 1, at }), { onlyIf: previous ? { etagMatches: previous.etag } : absentCondition(), httpMetadata: { contentType: 'application/json' } });
  if (result === null) throw new EvidenceError('Another submission is being processed. Try again shortly.', 429);
}
async function photoResponse(bucket, key, request, isPublic) {
  const object = await bucket.get(key);
  if (!object) throw new EvidenceError('Photograph not found.', 404);
  return new Response(request.method === 'HEAD' ? null : object.body || await object.arrayBuffer(), { headers: { 'content-type': 'image/jpeg', 'cache-control': isPublic ? 'public, max-age=60' : 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'content-disposition': 'inline; filename="community-photo.jpg"' } });
}
async function listRecords(bucket, prefix, request) {
  const params = new URL(request.url).searchParams;
  const cursor = params.get('cursor') || undefined;
  if (cursor && cursor.length > 2048) throw new EvidenceError('Invalid page cursor.');
  const page = await bucket.list({ prefix, limit: 20, cursor });
  const records = await Promise.all(page.objects.map((object) => readJson(bucket, object.key)));
  return { records: records.filter(Boolean), nextCursor: page.truncated ? page.cursor : null };
}

/** Sites dispatch supplies trusted identity headers. Never expose this Worker directly with caller-controlled identity headers. */
export async function handleEvidence(request, env, { now = Date.now, createId = () => crypto.randomUUID() } = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/api/evidence' && !path.startsWith('/api/evidence/')) return null;
  try {
    if (path === '/api/evidence/session' && request.method === 'GET') return json({ signedIn: Boolean(userId(request)), enabled: configured(env), maxPhotoBytes: 2097152 });
    const bucket = env.EARTH_STORE;
    if (!bucket?.get || !bucket?.list) throw new EvidenceError('Community contributions are not available on this host.', 503);
    if (path === '/api/evidence' && request.method === 'GET') {
      const page = await listRecords(bucket, `${ROOT}public/records/`, request);
      return json({ contributions: page.records.filter(isPublished).map(publicRecord), nextCursor: page.nextCursor }, 200, { 'cache-control': 'public, max-age=60' });
    }
    const publicPhoto = path.match(/^\/api\/evidence\/([A-Za-z0-9_-]{1,100})\/photo$/);
    if (publicPhoto && ['GET', 'HEAD'].includes(request.method)) {
      const record = await readJson(bucket, `${ROOT}public/records/${publicPhoto[1]}.json`);
      if (!isPublished(record) || !record.photo) throw new EvidenceError('Photograph not found.', 404);
      return photoResponse(bucket, `${ROOT}public/photos/${publicPhoto[1]}.jpg`, request, true);
    }
    if (path === '/api/evidence/submissions' && request.method === 'POST') {
      const owner = userId(request); if (!owner) throw new EvidenceError('Sign in with ChatGPT before submitting for review.', 401);
      if (!configured(env)) throw new EvidenceError('Submissions are not enabled on this host yet.', 503);
      sameOrigin(request);
      if (!/^multipart\/form-data;\s*boundary=/i.test(request.headers.get('content-type') || '')) throw new EvidenceError('Submit the form with its photograph as multipart data.', 415);
      const bytes = await readBoundedBody(request, MAX_EVIDENCE_BODY);
      let form; try { form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData(); } catch { throw new EvidenceError('The submission form could not be read.'); }
      const values = Object.fromEntries(['title', 'text', 'alias', 'sourceUrl', 'observedAt', 'publishConsent', 'rightsConsent', 'lat', 'lon'].flatMap((key) => form.has(key) ? [[key, form.get(key)]] : []));
      const metadata = normalizeSubmission(values), file = form.get('photo');
      let photo = null, image = null;
      if (file && (typeof file !== 'string' || file)) {
        if (!(file instanceof Blob) || file.type !== 'image/jpeg' || !file.size) throw new EvidenceError('Use a processed JPEG photograph.', 415);
        photo = new Uint8Array(await file.arrayBuffer()); image = inspectEvidenceJpeg(photo);
      }
      if ((await bucket.list({ prefix: `${ROOT}pending/`, limit: MAX_PENDING + 1 })).objects.length >= MAX_PENDING) throw new EvidenceError('The review queue is full. Please try again later.', 429);
      const at = now(), ownerHash = hex(await digest(owner));
      await claim(bucket, `${ROOT}limits/user-${ownerHash}.json`, { at, max: 5, spacing: 60000 });
      await claim(bucket, `${ROOT}limits/global.json`, { at, max: 25 });
      const id = createId(); if (!validId(id)) throw new Error('Invalid contribution identity');
      const record = { id, ...metadata, userId: owner, submittedAt: new Date(at).toISOString(), status: 'pending', photo: photo ? { ...image, bytes: photo.length, sha256: hex(await digest(photo)) } : null };
      const photoKey = `${ROOT}pending-photos/${id}.jpg`;
      let storedPhoto = false;
      try {
        if (photo) {
          const result = await bucket.put(photoKey, photo, { onlyIf: absentCondition(), httpMetadata: { contentType: 'image/jpeg' } });
          if (result === null) throw new EvidenceError('The submission could not be assigned a new identity. Try again.', 409);
          storedPhoto = true;
        }
        const result = await bucket.put(`${ROOT}pending/${id}.json`, JSON.stringify(record), { onlyIf: absentCondition(), httpMetadata: { contentType: 'application/json' } });
        if (result === null) throw new EvidenceError('The submission could not be assigned a new identity. Try again.', 409);
      } catch (error) { if (storedPhoto) await bucket.delete(photoKey).catch(() => {}); throw error; }
      return json({ id, status: 'pending', message: 'Submitted for review. Nothing is public until a moderator approves it.' }, 202);
    }
    if (path === '/api/evidence/moderation' && request.method === 'GET') {
      await moderator(request, env);
      const page = await listRecords(bucket, `${ROOT}pending/`, request);
      return json({ submissions: page.records.map(({ userId: _owner, ...record }) => ({ ...record, photoUrl: record.photo ? `/api/evidence/moderation/${record.id}/photo` : null })), nextCursor: page.nextCursor });
    }
    const privatePhoto = path.match(/^\/api\/evidence\/moderation\/([A-Za-z0-9_-]{1,100})\/photo$/);
    if (privatePhoto && ['GET', 'HEAD'].includes(request.method)) {
      await moderator(request, env);
      if (!await readJson(bucket, `${ROOT}pending/${privatePhoto[1]}.json`)) throw new EvidenceError('Photograph not found.', 404);
      return photoResponse(bucket, `${ROOT}pending-photos/${privatePhoto[1]}.jpg`, request, false);
    }
    const moderationAction = path.match(/^\/api\/evidence\/moderation\/([A-Za-z0-9_-]{1,100})$/);
    if (moderationAction && request.method === 'POST') {
      await moderator(request, env);
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw new EvidenceError('Use a JSON moderation action.', 415);
      const bytes = await readBoundedBody(request, 2048);
      let action; try { action = JSON.parse(new TextDecoder().decode(bytes)).action; } catch { throw new EvidenceError('Use an approve, reject or unpublish action.'); }
      if (!['approve', 'reject', 'unpublish'].includes(action)) throw new EvidenceError('Use an approve, reject or unpublish action.');
      const id = moderationAction[1];
      if (action === 'unpublish') {
        await bucket.delete(`${ROOT}public/records/${id}.json`); await bucket.delete(`${ROOT}public/photos/${id}.jpg`); return json({ id, status: 'unpublished' });
      }
      const key = `${ROOT}pending/${id}.json`, record = await readJson(bucket, key);
      if (!record) throw new EvidenceError('Pending submission not found.', 404);
      if (action === 'approve') {
        if ((await bucket.list({ prefix: `${ROOT}public/records/`, limit: MAX_APPROVED + 1 })).objects.length >= MAX_APPROVED) throw new EvidenceError('The public contribution limit has been reached.', 409);
        if (record.photo) {
          const object = await bucket.get(`${ROOT}pending-photos/${id}.jpg`);
          if (!object) throw new EvidenceError('The submitted photograph is unavailable.', 409);
          const photo = new Uint8Array(await object.arrayBuffer()); inspectEvidenceJpeg(photo);
          if (hex(await digest(photo)) !== record.photo.sha256) throw new EvidenceError('The submitted photograph failed its integrity check.', 409);
          await bucket.put(`${ROOT}public/photos/${id}.jpg`, photo, { httpMetadata: { contentType: 'image/jpeg' } });
        }
        const { userId: _owner, ...published } = record;
        await bucket.put(`${ROOT}public/records/${id}.json`, JSON.stringify({ ...published, status: 'published', publishedAt: new Date(now()).toISOString() }), { httpMetadata: { contentType: 'application/json' } });
      }
      await bucket.delete(key); await bucket.delete(`${ROOT}pending-photos/${id}.jpg`);
      return json({ id, status: action === 'approve' ? 'published' : 'rejected' });
    }
    if (['GET', 'HEAD', 'POST'].includes(request.method)) throw new EvidenceError('Evidence endpoint not found.', 404);
    return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, HEAD, POST' });
  } catch (error) {
    if (!(error instanceof EvidenceError)) console.error('Evidence storage operation failed.');
    return json({ error: error instanceof EvidenceError ? error.message : 'The contribution could not be processed. Try again later.' }, error instanceof EvidenceError ? error.status : 503);
  }
}
