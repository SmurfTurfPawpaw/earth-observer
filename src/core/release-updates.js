export const RELEASE_CHECK_MS = 300000;

/** Adopt our completed worker once; never evict caches or interrupt a text draft. */
export function installReleaseUpdates({ serviceWorker = globalThis.navigator?.serviceWorker,
  documentRef = globalThis.document, windowRef = documentRef?.defaultView || globalThis.window,
  locationRef = globalThis.location, navigatorRef = globalThis.navigator, scope = '/',
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  if (!serviceWorker?.register || !/^\/(?:[a-z0-9-]+\/)*$/.test(scope) || locationRef?.pathname !== scope) return { destroy() {} };
  const initialController = serviceWorker.controller;
  let destroyed = false, registration, pending = false, adopted = false, updateReady = false, timer, adoptionTimer;
  const stopTimer = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const stopAdoption = () => { if (adoptionTimer !== undefined) clearTimeoutImpl(adoptionTimer); adoptionTimer = undefined; };
  const owns = (worker) => {
    try { const url = new URL(worker?.scriptURL, locationRef.href); return url.origin === locationRef.origin && url.pathname === `${scope}sw.js` && !url.search; }
    catch { return false; }
  };
  const editing = () => {
    if (documentRef?.activeElement?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return true;
    return [...(documentRef?.querySelectorAll?.('.notebook-form input, .notebook-form textarea') || [])].some((input) =>
      input.type === 'file' ? input.files?.length > 0 : ['checkbox', 'radio'].includes(input.type) ? input.checked !== input.defaultChecked : input.value !== input.defaultValue);
  };
  function adopt() {
    stopAdoption();
    if (destroyed || adopted || !updateReady || documentRef?.hidden) return;
    const temporaryNotes = documentRef?.querySelector?.('.notebook-status')?.textContent?.includes('open tab only');
    if (editing() || temporaryNotes) {
      const notice = documentRef?.getElementById?.('notification');
      if (notice) { notice.textContent = temporaryNotes ? 'An app update is ready. Export your temporary notes before it refreshes.' :
        'An app update is ready. Finish or save your text before it refreshes.'; notice.hidden = false; }
      adoptionTimer = setTimeoutImpl(adopt, 1000); return;
    }
    adopted = true; stopTimer(); locationRef.reload();
  }
  const controllerChanged = () => {
    // First installation already serves the current online document. Only an
    // existing Earth Observer controller changing can require another boot.
    if (!initialController || !owns(initialController) || serviceWorker.controller === initialController || !owns(serviceWorker.controller)) return;
    updateReady = true; adopt();
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
    if (destroyed) return; destroyed = true; stopTimer(); stopAdoption();
    serviceWorker.removeEventListener?.('controllerchange', controllerChanged); documentRef?.removeEventListener?.('visibilitychange', visibility);
    windowRef?.removeEventListener?.('online', online); windowRef?.removeEventListener?.('pagehide', pagehide); windowRef?.removeEventListener?.('pageshow', pageshow);
  }
  serviceWorker.addEventListener('controllerchange', controllerChanged); documentRef?.addEventListener?.('visibilitychange', visibility);
  windowRef?.addEventListener?.('online', online); windowRef?.addEventListener?.('pagehide', pagehide); windowRef?.addEventListener?.('pageshow', pageshow);
  // Register immediately, independently of globe download and optional warming.
  void check();
  return { destroy };
}
