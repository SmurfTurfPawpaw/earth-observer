/** A durable collection revision, never a source observation or a visitor identifier. */
export function collectionRevision(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.collectedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.collectedAt)) || new Date(value.collectedAt).toISOString() !== value.collectedAt ||
      !/^[a-f0-9]{64}$/.test(value.inputDigest || '') || !Number.isInteger(value.recordCount) ||
      value.recordCount < 0 || value.recordCount > 500 || value.revision !== `${value.collectedAt}:${value.inputDigest}`) return null;
  return { schemaVersion: 1, revision: value.revision, collectedAt: value.collectedAt,
    inputDigest: value.inputDigest, recordCount: value.recordCount };
}

/** One page-owned EventSource. Timekeeping and rendering never depend on this transport. */
export function createLiveUpdates({ url = `${import.meta.env?.BASE_URL || '/'}api/updates`,
  EventSourceImpl = globalThis.EventSource, documentRef = globalThis.document,
  windowRef = documentRef?.defaultView || globalThis.window, online = () => globalThis.navigator?.onLine !== false,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  const listeners = new Set();
  let started = false, destroyed = false, source, retryTimer, retryMs = 1000, status = 'connecting', latest;
  const notify = (value) => { for (const listener of listeners) { try { listener(value); } catch {} } };
  const state = () => ({ type: 'status', status, revision: latest?.revision || null });
  const setStatus = (value) => { if (status === value) return; status = value; notify(state()); };
  function disconnect() {
    clearTimeoutImpl(retryTimer); retryTimer = undefined;
    const previous = source; source = undefined; previous?.close();
  }
  function connect() {
    if (!started || destroyed) return;
    disconnect();
    if (documentRef?.hidden) { setStatus('hidden'); return; }
    if (!online()) { setStatus('offline'); return; }
    if (typeof EventSourceImpl !== 'function') { setStatus('unsupported'); return; }
    setStatus(latest ? 'reconnecting' : 'connecting');
    let current;
    try { current = new EventSourceImpl(url); source = current; }
    catch { setStatus('unsupported'); return; }
    current.addEventListener('open', () => {
      if (source !== current || destroyed) return;
      retryMs = 1000; setStatus('connected');
    });
    current.addEventListener('collection', (event) => {
      if (source !== current || destroyed || typeof event.data !== 'string' || event.data.length > 1024) return;
      let revision; try { revision = collectionRevision(JSON.parse(event.data)); } catch { return; }
      if (!revision || latest?.revision === revision.revision || latest?.collectedAt > revision.collectedAt) return;
      latest = revision; notify({ type: 'collection', ...revision });
    });
    current.addEventListener('status', (event) => {
      if (source !== current || destroyed || typeof event.data !== 'string' || event.data.length > 256) return;
      let value; try { value = JSON.parse(event.data); } catch { return; }
      if (value?.schemaVersion === 1 && typeof value.available === 'boolean') setStatus(value.available ? 'connected' : 'reconnecting');
    });
    current.addEventListener('error', () => {
      if (source !== current || destroyed) return;
      setStatus(online() ? 'reconnecting' : 'offline');
      // EventSource owns ordinary reconnection and Last-Event-ID. A terminal
      // HTTP failure needs a bounded retry, without creating a second stream.
      if (current.readyState === 2) {
        disconnect();
        if (!documentRef?.hidden && online()) {
          retryTimer = setTimeoutImpl(() => { retryTimer = undefined; connect(); }, retryMs);
          retryMs = Math.min(30000, retryMs * 2);
        }
      }
    });
  }
  const visibility = () => { if (documentRef?.hidden) { disconnect(); setStatus('hidden'); } else connect(); };
  const offline = () => { disconnect(); setStatus('offline'); };
  const reconnect = () => connect();
  return {
    getState: () => ({ ...state(), latest: latest ? { ...latest } : null }),
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener); listener(state());
      if (latest) listener({ type: 'collection', ...latest });
      return () => listeners.delete(listener);
    },
    start() {
      if (started || destroyed) return;
      started = true;
      documentRef?.addEventListener?.('visibilitychange', visibility);
      windowRef?.addEventListener?.('online', reconnect); windowRef?.addEventListener?.('offline', offline);
      connect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; disconnect(); listeners.clear();
      documentRef?.removeEventListener?.('visibilitychange', visibility);
      windowRef?.removeEventListener?.('online', reconnect); windowRef?.removeEventListener?.('offline', offline);
    },
  };
}
