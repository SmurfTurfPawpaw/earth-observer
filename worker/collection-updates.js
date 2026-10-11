const SELECT = 'SELECT collected_at, input_digest, record_count, revision FROM earth_collection_revision WHERE id = ?';
const UPSERT = `INSERT INTO earth_collection_revision (id, collected_at, input_digest, record_count, revision)
  VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET collected_at = excluded.collected_at,
  input_digest = excluded.input_digest, record_count = excluded.record_count, revision = excluded.revision
  WHERE excluded.collected_at > earth_collection_revision.collected_at`;
const encoder = new TextEncoder();
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const configured = (env) => Boolean(env?.EARTH_DB?.prepare);
const json = (value, status, headers = {}) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
} });

export function collectionRevision(value) {
  const collectedAt = value?.collectedAt ?? value?.at, inputDigest = value?.inputDigest ?? value?.digest;
  if (!iso(collectedAt) || !/^[a-f0-9]{64}$/.test(inputDigest || '') || !Number.isInteger(value?.recordCount) || value.recordCount < 0 || value.recordCount > 500)
    throw new TypeError('Invalid bounded collection revision');
  return Object.freeze({ schemaVersion: 1, revision: `${collectedAt}:${inputDigest}`, collectedAt, inputDigest, recordCount: value.recordCount });
}
function rowRevision(row) {
  if (!row) return null;
  const value = collectionRevision({ collectedAt: row.collected_at, inputDigest: row.input_digest, recordCount: row.record_count });
  if (row.revision !== value.revision) throw new Error('Stored collection revision is invalid');
  return value;
}
const primary = (db) => typeof db.withSession === 'function' ? db.withSession('first-primary') : db;

/** Only plain public data/admission are shared. Streams and timers remain request-owned.
 * Workers forbid reusing request-scoped I/O objects across invocations. Each connected
 * pump competes for the same one-second D1 read slot; a surviving pump takes over.
 * No upstream provider acquisition occurs here. Factory injection is for bounded tests.
 */
export function createCollectionUpdates({ now = Date.now, schedule = setTimeout, unschedule = clearTimeout,
  pollMs = 1000, keepaliveMs = 15000, maxClients = 128, streamLifetimeMs = 40000, readTimeoutMs = 2500 } = {}) {
  if (![pollMs, keepaliveMs, maxClients, streamLifetimeMs, readTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) throw new TypeError('Invalid update channel bounds');
  const states = new WeakMap();
  function stateFor(db) {
    let state = states.get(db);
    if (!state) { state = { latest: null, loaded: false, clients: 0, epoch: 0, readToken: null, nextReadAt: 0, failures: 0, unavailable: false }; states.set(db, state); }
    return state;
  }
  function remember(state, value) {
    if (value && (!state.latest || value.collectedAt > state.latest.collectedAt || value.revision === state.latest.revision)) state.latest = value;
  }
  async function bounded(task, signal, settled = () => {}) {
    if (signal?.aborted) throw new Error('Update read canceled');
    let timer, abort;
    const operation = Promise.resolve().then(task).finally(settled);
    const deadline = new Promise((_resolve, reject) => {
      timer = schedule(() => reject(new Error('Update database deadline exceeded')), readTimeoutMs);
      abort = () => reject(new Error('Update read canceled'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([operation, deadline]); }
    finally { unschedule(timer); signal?.removeEventListener('abort', abort); }
  }
  async function readDue(db, state, signal, countQuery) {
    if (state.readToken || now() < state.nextReadAt) return;
    const token = Symbol(), epoch = state.epoch;
    state.readToken = token; state.nextReadAt = now() + pollMs; countQuery();
    try {
      const row = await bounded(() => primary(db).prepare(SELECT).bind(1).first(), signal, () => {
        if (state.readToken === token) state.readToken = null;
      });
      if (!signal.aborted && state.epoch === epoch && state.clients) {
        remember(state, rowRevision(row)); state.loaded = true; state.failures = 0; state.unavailable = false;
      }
    } catch {
      if (!signal.aborted && state.epoch === epoch && state.clients) {
        state.failures = Math.min(state.failures + 1, 5); state.unavailable = true;
        state.nextReadAt = now() + Math.min(15000, pollMs * 2 ** (state.failures - 1));
      }
    }
    // D1 has no query-abort API. A timed-out query keeps its admission slot until it
    // actually settles, preventing overlapping reads; its late result is ignored.
  }

  async function publishCollectionRevision(env, input) {
    const incoming = collectionRevision(input);
    if (Date.parse(incoming.collectedAt) > now() + 300000) throw new TypeError('Collection revision is in the future');
    if (!configured(env)) return { configured: false, stored: false };
    const db = env.EARTH_DB;
    await bounded(() => db.prepare(UPSERT).bind(incoming.collectedAt, incoming.inputDigest, incoming.recordCount, incoming.revision).run());
    const current = rowRevision(await bounded(() => primary(db).prepare(SELECT).bind(1).first()));
    if (!current) throw new Error('Durable collection revision is unavailable');
    const state = stateFor(db); remember(state, current); state.loaded = true; state.unavailable = false;
    return { configured: true, stored: true, superseded: current.revision !== incoming.revision, ...current };
  }

  function handleUpdates(request, env) {
    if (new URL(request.url).pathname !== '/api/updates') return null;
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405, { allow: 'GET' });
    if (!configured(env)) return json({ available: false, error: 'Durable collection updates are not configured' }, 503, { 'retry-after': '15' });
    if (request.signal.aborted) return json({ error: 'Update connection canceled' }, 408);
    const db = env.EARTH_DB, state = stateFor(db);
    if (state.clients >= maxClients) return json({ error: 'Update connection limit reached' }, 429, { 'retry-after': '15' });
    state.clients++;
    const epoch = state.epoch, internal = new AbortController(), beganAt = now();
    let open = true, controller, waitTimer, releaseWait, lastRevision = '', lastKeepaliveAt = beganAt, checks = 0, sentReady = false, lastAvailability = null;
    function stop(close = true) {
      if (!open) return; open = false;
      unschedule(waitTimer); releaseWait?.(); internal.abort(); request.signal.removeEventListener('abort', aborted);
      state.clients--; if (!state.clients) { state.epoch++; state.nextReadAt = 0; }
      if (close) { try { controller.close(); } catch { /* The client may already have canceled its stream. */ } }
    }
    const aborted = () => stop();
    function send(text) {
      if (!open) return;
      const bytes = encoder.encode(text);
      if (controller.desiredSize < bytes.byteLength) { stop(); return; }
      try { controller.enqueue(bytes); } catch { stop(false); }
    }
    function wait() {
      return new Promise((resolve) => { releaseWait = resolve; waitTimer = schedule(resolve, pollMs); }).finally(() => { releaseWait = null; waitTimer = null; });
    }
    async function pump() {
      try {
        send('retry: 2000\n\n');
        while (open && state.epoch === epoch && now() - beganAt < streamLifetimeMs && checks < 40) {
          await readDue(db, state, internal.signal, () => checks++);
          if (!open || state.epoch !== epoch) break;
          if (state.loaded || state.unavailable) {
            const available = !state.unavailable;
            if (available !== lastAvailability) {
              lastAvailability = available;
              send(`event: status\ndata: ${JSON.stringify({ schemaVersion: 1, available })}\n\n`);
            }
          }
          if (state.latest && state.latest.revision !== lastRevision) {
            lastRevision = state.latest.revision;
            send(`id: ${lastRevision}\nevent: collection\ndata: ${JSON.stringify(state.latest)}\n\n`);
          } else if (!state.latest && !sentReady && (state.loaded || state.unavailable)) {
            sentReady = true;
            send(`event: ready\ndata: ${JSON.stringify({ schemaVersion: 1, available: false })}\n\n`);
          }
          if (now() - lastKeepaliveAt >= keepaliveMs) { send(': keepalive\n\n'); lastKeepaliveAt = now(); }
          if (open) await wait();
        }
      } finally { stop(); }
    }
    const body = new ReadableStream({
      start(value) { controller = value; request.signal.addEventListener('abort', aborted, { once: true }); if (request.signal.aborted) stop(); else return pump(); },
      cancel() { stop(false); },
    }, { highWaterMark: 2048, size: (chunk) => chunk.byteLength });
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } });
  }
  function closeUpdates(env) {
    const state = env?.EARTH_DB && states.get(env.EARTH_DB);
    if (state) state.epoch++; // Every request-owned pump closes on its next tick.
  }
  function status(env) {
    const state = env?.EARTH_DB && states.get(env.EARTH_DB);
    return { clients: state?.clients || 0, reading: Boolean(state?.readToken), revision: state?.latest?.revision || null };
  }
  return { publishCollectionRevision, handleUpdates, closeUpdates, status };
}

const channel = createCollectionUpdates();
export const publishCollectionRevision = (env, value) => channel.publishCollectionRevision(env, value);
export const handleUpdates = (request, env) => channel.handleUpdates(request, env);
export const closeUpdates = (env) => channel.closeUpdates(env);
