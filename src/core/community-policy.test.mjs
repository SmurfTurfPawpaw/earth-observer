import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatGPTSignInPath, contributionPhotoPath, contributionSourceLink, contributionFormData } from './community-policy.js';
test('sign-in only returns to a safe relative path and preserves the selected view', () => {
  assert.equal(chatGPTSignInPath('/earth?foo=bar#lat=50'), '/signin-with-chatgpt?return_to=%2Fearth%3Ffoo%3Dbar%23lat%3D50');
  for (const path of ['//other.example', '/\\other.example', 'https://other.example', '/signin-with-chatgpt', '/callback/subpath']) assert.equal(chatGPTSignInPath(path), '/signin-with-chatgpt?return_to=%2F');
});
test('public cards use only exact published-photo routes and safe link protocols', () => {
  assert.equal(contributionPhotoPath({ id: 'photo-one', photoUrl: '/api/evidence/photo-one/photo' }), '/api/evidence/photo-one/photo');
  for (const photoUrl of ['https://other.example/photo', '/api/evidence/moderation/photo-one/photo', '/api/evidence/other/photo']) assert.equal(contributionPhotoPath({ id: 'photo-one', photoUrl }), null);
  assert.equal(contributionPhotoPath({ id: '../secret', photoUrl: '/api/evidence/../secret/photo' }), null);
  assert.equal(contributionSourceLink('javascript:alert(1)'), null); assert.equal(contributionSourceLink('https://user:pass@example.com'), null);
});
test('submission serialization requires both consents, strips original filenames and rounds optional coordinates', () => {
  const values = { title: 'Photo', text: 'Observed water', alias: 'Observer', sourceUrl: '', publishConsent: true, rightsConsent: true, observedAt: '2026-10-10T12:30:00Z' };
  assert.throws(() => contributionFormData({ ...values, rightsConsent: false }));
  const form = contributionFormData(values, { photo: new Blob(['photo'], { type: 'image/jpeg' }), location: { lat: 50.850456, lon: 4.351749 } });
  assert.equal(form.get('photo').name, 'processed-photo.jpg'); assert.equal(form.get('lat'), '50.850'); assert.equal(form.get('lon'), '4.352'); assert.equal(form.get('observedAt'), '2026-10-10T12:30:00.000Z');
  assert.equal(form.has('userId'), false); assert.equal(form.has('email'), false);
  assert.throws(() => contributionFormData(values, { photo: new Blob(['png'], { type: 'image/png' }) }));
  assert.throws(() => contributionFormData(values, { photo: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' }) }));
  assert.throws(() => contributionFormData(values, { location: { lat: 91, lon: 2 } }));
});
