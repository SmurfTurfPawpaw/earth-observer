import { prepareEvidencePhoto } from './evidence.js';
import { chatGPTSignInPath, contributionFormData, contributionPhotoPath, contributionSourceLink } from './community-policy.js';

/** Public contributions are fetched on explicit open; local notebook records are never read or uploaded. */
export function createCommunityPanel({ container, fetchImpl = fetch, getLocation = () => null, getReturnPath = () => `${location.pathname}${location.search}${location.hash}`, onNavigate, onSession = () => {}, preparePhoto = prepareEvidencePhoto }) {
  const doc = container.ownerDocument;
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  let active = false, destroyed = false, generation = 0, loading = false, saving = false, sending = false, session = null, nextCursor = null, loadRequest, submitRequest;
  const intro = el('p', 'Browse contributions approved for publication. Review does not establish that a photograph, description or selected location is authentic.', 'community-note');
  const controls = el('div', undefined, 'community-actions');
  const refresh = el('button', 'Refresh contributions'); refresh.type = 'button'; controls.append(refresh);
  const status = el('p', '', 'community-status'); status.setAttribute('role', 'status');
  const list = el('div', undefined, 'community-list'); list.setAttribute('aria-label', 'Public community contributions');
  const more = el('button', 'Load more'); more.type = 'button'; more.hidden = true;
  const submission = el('details', undefined, 'community-submit');
  const summary = el('summary', 'Submit for review');
  const auth = el('p', '', 'community-auth');
  const signIn = el('a', 'Sign in with ChatGPT'); signIn.target = '_top';
  const note = el('p', 'This is a separate public submission. Private notebook notes stay on your device. Submit only material you have the right to share; remove people’s private information. Nothing is published automatically.', 'community-note');
  const form = el('form'); form.className = 'notebook-form community-form';
  const fields = el('fieldset'); fields.disabled = true; form.append(fields);
  const field = (label, tag = 'input') => { const node = el(tag), wrapper = el('label', label); wrapper.append(node); fields.append(wrapper); return node; };
  const title = field('Title'); title.required = true; title.maxLength = 160;
  const description = field('What did you observe?', 'textarea'); description.required = true; description.minLength = 5; description.maxLength = 5000; description.rows = 4;
  const alias = field('Public display alias'); alias.required = true; alias.maxLength = 40; alias.autocomplete = 'off'; alias.placeholder = 'An alias, not an email address';
  const source = field('Original source link (optional)'); source.type = 'url'; source.maxLength = 2048; source.placeholder = 'https://…';
  const observed = field('Observation time (optional, your local time)'); observed.type = 'datetime-local';
  const photo = field('Photograph (optional)'); photo.type = 'file'; photo.accept = 'image/jpeg,image/png,image/webp';
  fields.append(el('p', 'Photos are resized and re-encoded as JPEG before upload to remove embedded metadata, including GPS/EXIF. Processed photos must be 2 MB or smaller.', 'community-note'));
  const check = (label) => { const wrapper = el('label', undefined, 'community-check'), input = el('input'); input.type = 'checkbox'; wrapper.append(input, doc.createTextNode(label)); fields.append(wrapper); return input; };
  const attachLocation = check('Attach current camera coordinates, rounded to 3 decimals (roughly 100 m). This is a selected location, not verified photo GPS.');
  const publishConsent = check('I consent to public display of this text, alias, photograph and optional selected location after review.'); publishConsent.required = true;
  const rightsConsent = check('I own this material or have permission to share it publicly, including any people’s private information.'); rightsConsent.required = true;
  const send = el('button', 'Submit for review'); send.type = 'submit'; fields.append(send);
  const receipt = el('p', '', 'community-status'); receipt.setAttribute('role', 'status');
  submission.append(summary, auth, signIn, note, form, receipt);
  container.replaceChildren(intro, controls, status, list, more, submission);

  const updateAuth = () => {
    signIn.href = chatGPTSignInPath(getReturnPath()); signIn.hidden = session?.signedIn === true;
    fields.disabled = saving || !session?.signedIn || !session?.enabled;
    auth.textContent = session ? !session.enabled ? 'Submissions are not enabled on this host yet. Public contributions can still be browsed.' : session.signedIn ? 'Signed in. Your public alias is independent of your sign-in identity.' : 'Sign in to submit material for review. Browsing is public.' : 'Checking whether submissions are available…';
  };
  const requestJson = async (url, options) => {
    const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    let data; try { data = await response.json(); } catch { throw new Error('The community service returned an unreadable response.'); }
    if (!response.ok) { const error = new Error(data.error || 'The community service is unavailable.'); error.status = response.status; throw error; }
    return { response, data };
  };
  const displayTime = (value) => { const at = new Date(value); return Number.isFinite(at.getTime()) ? at.toLocaleString() : 'Time unavailable'; };
  const renderCard = (record) => {
    const card = el('article', undefined, 'notebook-card community-card');
    card.append(el('h3', String(record.title || 'Community contribution').slice(0, 160)), el('p', String(record.text || '').slice(0, 5000)), el('small', `By ${String(record.alias || 'Contributor').slice(0, 40)} · Published ${displayTime(record.publishedAt)}`));
    if (record.observedAt) card.append(el('small', `Contributor-reported observation time: ${displayTime(record.observedAt)}`));
    card.append(el('small', 'Reviewed for publication · not independently verified'));
    const sourceUrl = contributionSourceLink(record.sourceUrl);
    if (sourceUrl) { const link = el('a', 'Original source'); link.href = sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); }
    if (Number.isFinite(record.location?.lat) && Number.isFinite(record.location?.lon) && Math.abs(record.location.lat) <= 90 && Math.abs(record.location.lon) <= 180) {
      card.append(el('small', `${record.location.lat}, ${record.location.lon} · contributor-selected location`));
      if (onNavigate) { const go = el('button', 'Show selected location'); go.type = 'button'; go.addEventListener('click', () => onNavigate(record.location)); card.append(go); }
    }
    const path = contributionPhotoPath(record);
    if (path) { const image = el('img'); image.alt = `Community photograph, unverified: ${String(record.title || '').slice(0, 160)}`; image.src = path; image.loading = 'lazy'; image.decoding = 'async'; card.append(image); }
    return card;
  };
  async function load(append = false) {
    if (!active || destroyed) return;
    loadRequest?.abort(); const controller = loadRequest = new AbortController(), owner = ++generation;
    loading = true; refresh.disabled = true; more.disabled = true; list.setAttribute('aria-busy', 'true'); status.textContent = append ? 'Loading more approved contributions…' : 'Loading approved contributions…';
    const jobs = [requestJson(`/api/evidence${append && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`, { signal: controller.signal })];
    if (!append) jobs.push(requestJson('/api/evidence/session', { signal: controller.signal }));
    const results = await Promise.allSettled(jobs);
    if (!active || destroyed || owner !== generation) return;
    if (!append) {
      const authResult = results[1];
      if (authResult.status === 'fulfilled') { session = { signedIn: authResult.value.data.signedIn === true, enabled: authResult.value.data.enabled === true }; onSession(session); }
      else { session = { signedIn: false, enabled: false }; }
      updateAuth();
    }
    const result = results[0];
    if (result.status === 'fulfilled' && Array.isArray(result.value.data.contributions)) {
      if (!append) list.replaceChildren();
      for (const record of result.value.data.contributions.slice(0, 20)) if (record && typeof record === 'object') list.append(renderCard(record));
      if (!list.childElementCount) list.append(el('p', 'No approved contributions yet. Pending submissions are private.', 'empty-state'));
      nextCursor = typeof result.value.data.nextCursor === 'string' && result.value.data.nextCursor.length <= 2048 ? result.value.data.nextCursor : null;
      status.textContent = 'Only approved material appears here. Publication review is not independent verification.';
    } else status.textContent = result.status === 'rejected' ? result.reason.message || 'Public contributions are unavailable.' : 'The community service returned an invalid list.';
    loading = false; refresh.disabled = false; more.disabled = false; more.hidden = !nextCursor; list.setAttribute('aria-busy', 'false');
  }
  const submit = async (event) => {
    event.preventDefault(); if (saving || destroyed || !active || !session?.enabled || !session.signedIn) return;
    if (!publishConsent.checked || !rightsConsent.checked) { receipt.textContent = 'Confirm publication consent and your rights to this material.'; return; }
    const owner = generation, file = photo.files[0];
    const values = { title: title.value, text: description.value, alias: alias.value, sourceUrl: source.value, observedAt: observed.value, publishConsent: publishConsent.checked, rightsConsent: rightsConsent.checked };
    const location = attachLocation.checked ? getLocation() : null;
    saving = true; updateAuth(); receipt.textContent = file ? 'Preparing the photograph and removing embedded metadata…' : 'Submitting for review…';
    const controller = submitRequest = new AbortController();
    try {
      const processed = file ? await preparePhoto(file) : null;
      if (!active || destroyed || owner !== generation) return;
      const body = contributionFormData(values, { photo: processed, location }); sending = true; receipt.textContent = 'Submitting for review…';
      const { response, data } = await requestJson('/api/evidence/submissions', { method: 'POST', body, signal: controller.signal });
      if (!active || destroyed || owner !== generation) return;
      if (response.status !== 202 || data.status !== 'pending' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.id || '')) throw new Error('The service did not confirm a pending submission.');
      form.reset(); receipt.textContent = `Submitted for review · reference ${data.id}. Nothing is public until a moderator approves it. Keep this reference.`;
    } catch (error) {
      if (!active || destroyed || owner !== generation) return;
      if (error.status === 401) { session = { ...session, signedIn: false }; onSession(session); }
      receipt.textContent = error.name === 'AbortError' ? 'The request was interrupted. Review status is unknown; do not retry immediately.' : error.message || 'The submission could not be sent.';
    } finally { saving = false; sending = false; if (!destroyed) updateAuth(); submitRequest = null; }
  };
  const refreshList = () => { if (!saving) void load(); };
  const loadMore = () => { if (!saving && !loading && nextCursor) void load(true); };
  const refreshSignIn = () => { signIn.href = chatGPTSignInPath(getReturnPath()); };
  form.addEventListener('submit', submit); refresh.addEventListener('click', refreshList); more.addEventListener('click', loadMore); signIn.addEventListener('click', refreshSignIn);
  updateAuth();
  return {
    open() { if (active || destroyed) return; active = true; updateAuth(); void load(); },
    close() { active = false; generation++; loadRequest?.abort(); submitRequest?.abort(); if (saving) receipt.textContent = sending ? 'The request was interrupted. Review status is unknown; do not retry immediately.' : 'Photo preparation was canceled. Nothing was submitted.'; },
    destroy() { destroyed = true; active = false; generation++; loadRequest?.abort(); submitRequest?.abort(); form.removeEventListener('submit', submit); refresh.removeEventListener('click', refreshList); more.removeEventListener('click', loadMore); signIn.removeEventListener('click', refreshSignIn); container.replaceChildren(); },
  };
}
