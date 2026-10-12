export const RELEASE_CHECK_MS = 300000;
export const RELEASE_IDENTITY_MS = 2000;
const IDENTITY_TYPE = 'earth-observer:document-identity';

/** Adopt only a verified different UI; keep current documents and active exploration. */
export function installReleaseUpdates({ serviceWorker = globalThis.navigator?.serviceWorker,
  documentRef = globalThis.document, windowRef = documentRef?.defaultView || globalThis.window,
  locationRef = globalThis.location, navigatorRef = globalThis.navigator, scope = '/',
  cryptoRef = globalThis.crypto, now = Date.now,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  if (!serviceWorker?.register || !/^\/(?:[a-z0-9-]+\/)*$/.test(scope) || locationRef?.pathname !== scope) return { destroy() {} };
  const initialController = serviceWorker.controller;
  let destroyed = false, registration, pending = false, adopted = false, updateReady = false, timer, adoptionTimer, identityTimer, identityRequest, checkedController, noticeText;
  const stopTimer = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const stopAdoption = () => { if (adoptionTimer !== undefined) clearTimeoutImpl(adoptionTimer); adoptionTimer = undefined; };
  const stopIdentity = () => { if (identityTimer !== undefined) clearTimeoutImpl(identityTimer); identityTimer = undefined; identityRequest = null; };
  const owns = (worker) => {
    try { const url = new URL(worker?.scriptURL, locationRef.href); return url.origin === locationRef.origin && url.pathname === `${scope}sw.js` && !url.search && !url.hash && !url.username && !url.password; }
    catch { return false; }
  };
  const editing = () => {
    if (documentRef?.activeElement?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return true;
    return [...(documentRef?.querySelectorAll?.('.notebook-form input, .notebook-form textarea') || [])].some((input) =>
      input.type === 'file' ? input.files?.length > 0 : ['checkbox', 'radio'].includes(input.type) ? input.checked !== input.defaultChecked : input.value !== input.defaultValue);
  };
  const exploring = () => {
    const timeline = documentRef?.getElementById?.('earth-timeline');
    return Boolean(timeline?.open || timeline?.dataset?.mode === 'history' || ['news-panel', 'selection'].some(id => {
      const panel = documentRef?.getElementById?.(id); return panel && !panel.hidden;
    }));
  };
  const notify = message => {
    const notice = documentRef?.getElementById?.('notification'); noticeText = message;
    if (notice) { notice.textContent = message; notice.hidden = false; }
  };
  const clearNotice = () => { const notice = documentRef?.getElementById?.('notification'); if (notice?.textContent === noticeText) notice.hidden = true; noticeText = null; };
  function adopt() {
    stopAdoption();
    if (destroyed || adopted || !updateReady || documentRef?.hidden) return;
    const temporaryNotes = documentRef?.querySelector?.('.notebook-status')?.textContent?.includes('open tab only');
    if (editing() || temporaryNotes || exploring()) {
      notify(temporaryNotes ? 'An app update is ready. Export your temporary notes before it refreshes.' : editing() ?
        'An app update is ready. Finish or save your text before it refreshes.' :
        'An app update is ready. Close the open context or calendar and return to Live when you are ready, or reload yourself.');
      return;
    }
    adopted = true; stopTimer(); locationRef.reload();
  }
  const unknownIdentity = () => { if (destroyed) return; stopIdentity(); updateReady = false; notify('An app update may be available. Reload when ready; your current workspace remains open.'); };
  const identityMessage = event => {
    const request = identityRequest, value = event.data;
    if (destroyed || !request || event.source !== request.worker || event.source !== serviceWorker.controller || event.origin !== locationRef.origin || !owns(event.source) ||
      !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'identity,requestId,schemaVersion,scope,type' ||
      value.type !== IDENTITY_TYPE || value.schemaVersion !== 1 || value.requestId !== request.id || value.scope !== scope ||
      typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity) || now() >= request.until) return;
    const metas = documentRef?.querySelectorAll?.('meta[name="earth-observer-ui-identity"]') || [];
    const identity = metas.length === 1 ? metas[0].getAttribute?.('content') : null;
    stopIdentity();
    if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) { unknownIdentity(); return; }
    updateReady = identity !== value.identity;
    if (updateReady) adopt(); else clearNotice();
  };
  const controllerChanged = () => {
    // First installation already serves the current online document. Only an
    // existing Earth Observer controller changing can require another boot.
    const worker = serviceWorker.controller;
    if (destroyed || adopted || !initialController || !owns(initialController) || worker === initialController || worker === checkedController || !owns(worker)) return;
    checkedController = worker; stopIdentity(); stopAdoption(); updateReady = false;
    try {
      const id = [...cryptoRef.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
      identityRequest = { worker, id, until: now() + RELEASE_IDENTITY_MS };
      identityTimer = setTimeoutImpl(() => { if (identityRequest?.id === id) unknownIdentity(); }, RELEASE_IDENTITY_MS);
      worker.postMessage({ type: IDENTITY_TYPE, schemaVersion: 1, requestId: id, scope });
    } catch { unknownIdentity(); }
  };
  const wakeAdoption = () => {
    if (!updateReady || destroyed || adopted || documentRef?.hidden || adoptionTimer !== undefined) return;
    // Run after the existing input/panel/calendar handlers have committed their state.
    adoptionTimer = setTimeoutImpl(adopt, 0);
  };
  function arm() {
    stopTimer(); if (destroyed || adopted || documentRef?.hidden || navigatorRef?.onLine === false || pending) return;
    timer = setTimeoutImpl(() => { timer = undefined; void check(); }, RELEASE_CHECK_MS);
  }
  async function check() {
    if (destroyed || adopted || documentRef?.hidden || navigatorRef?.onLine === false || pending) return;
    pending = true; stopTimer();
    try {
      if (!registration) registration = await serviceWorker.register(`${scope}sw.js`, { scope, updateViaCache: 'none' });
      else if (!registration.installing) await registration.update();
    } catch { /* Keep the working scene; offline/failed installation cannot authorize adoption. */ }
    finally { pending = false; arm(); }
  }
  const visibility = () => { if (documentRef?.hidden) { stopTimer(); stopAdoption(); } else { adopt(); void check(); } };
  const online = () => { adopt(); void check(); };
  const pagehide = (event) => { if (!event.persisted) destroy(); else { stopTimer(); stopAdoption(); } };
  const pageshow = (event) => { if (event.persisted) { adopt(); void check(); } };
  function destroy() {
    if (destroyed) return; destroyed = true; stopTimer(); stopAdoption(); stopIdentity();
    serviceWorker.removeEventListener?.('controllerchange', controllerChanged); serviceWorker.removeEventListener?.('message', identityMessage); documentRef?.removeEventListener?.('visibilitychange', visibility);
    for (const name of ['input', 'change', 'focusout', 'toggle', 'earth-observer:panel']) documentRef?.removeEventListener?.(name, wakeAdoption, true);
    windowRef?.removeEventListener?.('earth-observer:timechange', wakeAdoption);
    windowRef?.removeEventListener?.('online', online); windowRef?.removeEventListener?.('pagehide', pagehide); windowRef?.removeEventListener?.('pageshow', pageshow);
  }
  serviceWorker.addEventListener('controllerchange', controllerChanged); serviceWorker.addEventListener('message', identityMessage); documentRef?.addEventListener?.('visibilitychange', visibility);
  for (const name of ['input', 'change', 'focusout', 'toggle', 'earth-observer:panel']) documentRef?.addEventListener?.(name, wakeAdoption, true);
  windowRef?.addEventListener?.('earth-observer:timechange', wakeAdoption);
  windowRef?.addEventListener?.('online', online); windowRef?.addEventListener?.('pagehide', pagehide); windowRef?.addEventListener?.('pageshow', pageshow);
  // Register immediately, independently of globe download and optional warming.
  void check();
  return { destroy };
}
