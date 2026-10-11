/** Sites sign-in remains a normal top-level navigation; the return path cannot leave this host. */
export function chatGPTSignInPath(value = '/') {
  let returnTo = '/';
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    try {
      const url = new URL(value, 'https://app.local');
      if (url.origin === 'https://app.local' && !/^\/(?:signin-with-chatgpt|signout-with-chatgpt|callback)(?:\/|$)/.test(url.pathname)) returnTo = `${url.pathname}${url.search}${url.hash}`;
    } catch { /* A safe root return path is always available. */ }
  }
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`;
}
export function contributionPhotoPath(record) {
  return typeof record?.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(record.id) && record.photoUrl === `/api/evidence/${record.id}/photo` ? record.photoUrl : null;
}
export function contributionSourceLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
export function contributionFormData(values, { photo = null, location = null } = {}) {
  if (!values.publishConsent || !values.rightsConsent) throw new Error('Confirm publication consent and your rights to this material.');
  const form = new FormData();
  for (const key of ['title', 'text', 'alias', 'sourceUrl']) form.set(key, String(values[key] || '').trim());
  if (values.observedAt) {
    const at = new Date(values.observedAt); if (!Number.isFinite(at.getTime())) throw new Error('Choose a valid observation date and time.');
    form.set('observedAt', at.toISOString());
  }
  form.set('publishConsent', 'yes'); form.set('rightsConsent', 'yes');
  if (location) {
    if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon) || Math.abs(location.lat) > 90 || Math.abs(location.lon) > 180) throw new Error('The camera coordinates are unavailable.');
    form.set('lat', location.lat.toFixed(3)); form.set('lon', location.lon.toFixed(3));
  }
  if (photo) {
    if (!(photo instanceof Blob) || photo.type !== 'image/jpeg' || photo.size > 2 * 1024 * 1024 || !photo.size) throw new Error('The processed JPEG must be 2 MB or smaller.');
    form.set('photo', photo, 'processed-photo.jpg');
  }
  return form;
}
