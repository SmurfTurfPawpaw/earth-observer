import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moderationRequest, runModeration } from '../scripts/evidence-moderate.mjs';
const KEY = 'private-test-key-longer-than-thirty-two-characters';
test('moderation credentials are only in authorization headers and scoped site paths are preserved', () => {
  const request = moderationRequest('https://example.com/earth/', 'approve', 'reference-one', KEY);
  assert.equal(request.url, 'https://example.com/earth/api/evidence/moderation/reference-one'); assert.equal(request.method, 'POST'); assert.equal(request.headers.get('authorization'), `Bearer ${KEY}`); assert.equal(request.url.includes(KEY), false);
  assert.equal(moderationRequest('https://example.com', 'list', 'cursor/with?symbols', KEY).url, 'https://example.com/api/evidence/moderation?cursor=cursor%2Fwith%3Fsymbols');
  assert.equal(moderationRequest('https://example.com', 'photo', 'reference-one', KEY).method, 'GET');
});
test('moderation tooling rejects insecure hosts, URL credentials, guessed path references and missing keys', () => {
  for (const base of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com#secret']) assert.throws(() => moderationRequest(base, 'list', undefined, KEY));
  for (const id of ['../owner', 'abc/def', '', 'space id']) assert.throws(() => moderationRequest('https://example.com', 'approve', id, KEY));
  assert.throws(() => moderationRequest('https://example.com', 'list', undefined, 'short'));
});
test('failed moderation responses do not leak a secret even if an upstream response reflects it', async () => {
  await assert.rejects(runModeration({ base: 'https://example.com', command: 'approve', idOrCursor: 'reference', secret: KEY, fetchImpl: async () => Response.json({ error: KEY }, { status: 403 }) }), (error) => error.message.includes('403') && !error.message.includes(KEY));
});
