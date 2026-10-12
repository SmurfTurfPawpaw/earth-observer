export const EARLY_SEARCH_INTENT_LIMITS = Object.freeze({ queryChars: 256 });

/** Remember one explicit search while its ordinary submit control is unavailable.
 * This controller never resolves places, moves a preview or requests source data. */
export function createEarlySearchIntent({ input, form, status, submitButton = form?.querySelector('button[type="submit"]'),
  documentRef = input?.ownerDocument || globalThis.document,
  windowRef = documentRef?.defaultView || globalThis.window } = {}) {
  if (!input?.addEventListener || !form?.addEventListener || typeof form.requestSubmit !== 'function' || !status || !submitButton)
    throw new TypeError('Early search needs the existing search form and controls');
  let queued = null, notice = '', settled = false, destroyed = false;
  const clearNotice = () => { if (notice && status.textContent === notice) status.textContent = ''; notice = ''; };
  const cancel = () => { queued = null; clearNotice(); };
  const capture = event => {
    if (settled || destroyed || !submitButton.disabled) return;
    event.preventDefault(); cancel();
    const value = String(input.value || '');
    if (!value.trim() || value.length > EARLY_SEARCH_INTENT_LIMITS.queryChars) {
      notice = 'Enter a supported place or latitude, longitude (up to 256 characters).';
    } else {
      queued = value; notice = 'Search queued until the globe is ready.';
    }
    status.textContent = notice;
  };
  const keydown = event => {
    if (event.key === 'Escape') { cancel(); return; }
    if (event.key === 'Enter' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) capture(event);
  };
  const hidden = () => { if (documentRef?.hidden) cancel(); };
  const detach = () => {
    input.removeEventListener('keydown', keydown, true); input.removeEventListener('input', cancel);
    form.removeEventListener('submit', capture, true); form.removeEventListener('reset', cancel);
    documentRef?.removeEventListener?.('visibilitychange', hidden); windowRef?.removeEventListener?.('pagehide', destroy);
  };
  function destroy() { if (destroyed) return; destroyed = true; cancel(); detach(); }
  input.addEventListener('keydown', keydown, true); input.addEventListener('input', cancel);
  form.addEventListener('submit', capture, true); form.addEventListener('reset', cancel);
  documentRef?.addEventListener?.('visibilitychange', hidden); windowRef?.addEventListener?.('pagehide', destroy);
  return {
    ready() {
      if (settled || destroyed) return false;
      settled = true; const value = queued; cancel(); detach();
      if (value === null || documentRef?.hidden || submitButton.disabled || input.value !== value ||
        form.isConnected === false || input.isConnected === false) return false;
      // The navigation handler owns validation and camera/layer semantics.
      form.requestSubmit(); return true;
    },
    destroy,
  };
}
