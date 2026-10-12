import { pluginRevision, newerPluginRevision, PLUGIN_UPDATE_SCOPES } from '../src/core/live-updates.js';

const SELECT = 'SELECT collected_at, input_digest, record_count, revision FROM earth_collection_revision WHERE id = ?';
const SELECT_LEGACY = 'SELECT id,collected_at,input_digest,record_count,revision FROM earth_collection_revision WHERE id IN (1,2)';
const SELECT_ALL = `SELECT id,collected_at,input_digest,record_count,revision,
  NULL AS plugin_id,NULL AS scope_id,NULL AS receipt_id,NULL AS fence,NULL AS facts_digest,NULL AS recorded_at
  FROM earth_collection_revision WHERE id IN (1,2)
  UNION ALL SELECT 0,NULL,NULL,NULL,NULL,s.plugin_id,s.scope_id,c.receipt_id,c.fence,c.facts_digest,c.recorded_at
  FROM earth_plugin_state s JOIN earth_plugin_captures c ON c.receipt_id=s.current_receipt
    AND c.plugin_id=s.plugin_id AND c.scope_id=s.scope_id
  WHERE s.plugin_id IN ('ecb-press-v1','ec-press-v1','eurostat-gas-origins-v1','usgs-live-day-m2-5-v1')`;
const UPSERT = `INSERT INTO earth_collection_revision (id, collected_at, input_digest, record_count, revision)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET collected_at = excluded.collected_at,
  input_digest = excluded.input_digest, record_count = excluded.record_count, revision = excluded.revision
  WHERE excluded.collected_at > earth_collection_revision.collected_at`;
const encoder = new TextEncoder();
// Two main heads and four fixed typed heads exceed the former 2 KiB initial
// replay budget. Keep a finite 4 KiB queue; overflow still closes/reconnects.
export const COLLECTION_UPDATE_QUEUE_BYTES = 4096;
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const configured = (env) => Boolean(env?.EARTH_DB?.prepare);
const json = (value, status, headers = {}) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
} });

export function collectionRevision(value, kind = 'collection') {
  if (!['collection', 'aircraft'].includes(kind)) throw new TypeError('Unknown collection revision kind');
  const collectedAt = value?.collectedAt ?? value?.at, inputDigest = value?.inputDigest ?? value?.digest;
  if (!iso(collectedAt) || !/^[a-f0-9]{64}$/.test(inputDigest || '') || !Number.isInteger(value?.recordCount) || value.recordCount < 0 || value.recordCount > (kind === 'aircraft' ? 2000 : 500))
    throw new TypeError('Invalid bounded collection revision');
  return Object.freeze({ schemaVersion: 1, revision: `${collectedAt}:${inputDigest}`, collectedAt, inputDigest, recordCount: value.recordCount });
}
function rowRevision(row, kind = 'collection') {
  if (!row) return null;
  const value = collectionRevision({ collectedAt: row.collected_at, inputDigest: row.input_digest, recordCount: row.record_count }, kind);
  if (row.revision !== value.revision) throw new Error('Stored collection revision is invalid');
  return value;
}
const primary = (db) => typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
const missingPluginTable = error => typeof error?.message === 'string' &&
  /^(?:D1_ERROR:\s*)?no such table: (?:main\.)?earth_plugin_(?:state|captures)(?:: SQLITE_ERROR)?$/.test(error.message);

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
    if (!state) { state = { latest: null, aircraft: null, plugins: new Map(), loaded: false, clients: 0, epoch: 0, readToken: null, nextReadAt: 0, failures: 0, unavailable: false }; states.set(db, state); }
    return state;
  }
  function remember(state, value, kind = 'collection') {
    const key = kind === 'aircraft' ? 'aircraft' : 'latest';
    if (value && (!state[key] || value.collectedAt > state[key].collectedAt || value.revision === state[key].revision)) state[key] = value;
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
    let acceptsFallback = true; const deadline = now() + readTimeoutMs;
    try {
      const rows = await bounded(async () => {
        const session = primary(db);
        try { return await session.prepare(SELECT_ALL).bind().all(); }
        catch (error) {
          if (!acceptsFallback || signal.aborted || now() >= deadline || !missingPluginTable(error)) throw error;
          // Exceptional incomplete-schema compatibility costs two queries in the
          // shared read slot; normal delivery costs one. Recheck every slot so a
          // completed migration recovers without restarting an isolate.
          countQuery(); return session.prepare(SELECT_LEGACY).bind().all();
        }
      }, signal, () => {
        if (state.readToken === token) state.readToken = null;
      });
      if (!signal.aborted && state.epoch === epoch && state.clients) {
        for (const row of rows.results || []) {
          if (row.id === 0) {
            const revision = pluginRevision({ schemaVersion: 1, pluginId: row.plugin_id, scopeId: row.scope_id,
              receiptId: row.receipt_id, fence: row.fence, factsDigest: row.facts_digest, recordedAt: row.recorded_at });
            if (revision && newerPluginRevision(revision, state.plugins.get(revision.pluginId))) state.plugins.set(revision.pluginId, revision);
          } else if (row.id === 1 || row.id === 2) {
            const kind = row.id === 2 ? 'aircraft' : 'collection'; remember(state, rowRevision(row, kind), kind);
          }
        }
        state.loaded = true; state.failures = 0; state.unavailable = false;
      }
    } catch {
      if (!signal.aborted && state.epoch === epoch && state.clients) {
        state.failures = Math.min(state.failures + 1, 5); state.unavailable = true;
        state.nextReadAt = now() + Math.min(15000, pollMs * 2 ** (state.failures - 1));
      }
    } finally { acceptsFallback = false; }
    // D1 has no query-abort API. A timed-out query keeps its admission slot until it
    // actually settles, preventing overlapping reads; its late result is ignored.
  }

  async function publishCollectionRevision(env, input, kind = 'collection') {
    const incoming = collectionRevision(input, kind), id = kind === 'aircraft' ? 2 : 1;
    if (Date.parse(incoming.collectedAt) > now() + 300000) throw new TypeError('Collection revision is in the future');
    if (!configured(env)) return { configured: false, stored: false };
    const db = env.EARTH_DB;
    await bounded(() => db.prepare(UPSERT).bind(id, incoming.collectedAt, incoming.inputDigest, incoming.recordCount, incoming.revision).run());
    const current = rowRevision(await bounded(() => primary(db).prepare(SELECT).bind(id).first()), kind);
    if (!current) throw new Error('Durable collection revision is unavailable');
    const state = stateFor(db); remember(state, current, kind); state.loaded = true; state.unavailable = false;
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
    let open = true, controller, waitTimer, releaseWait, lastKeepaliveAt = beganAt, checks = 0, sentReady = false, lastAvailability = null;
    const lastRevisions = { collection: '', aircraft: '' };
    const lastPluginReceipts = new Map();
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
          for (const kind of ['collection', 'aircraft']) {
            const latest = kind === 'aircraft' ? state.aircraft : state.latest;
            if (latest && latest.revision !== lastRevisions[kind]) {
              lastRevisions[kind] = latest.revision;
              send(`id: ${kind === 'aircraft' ? 'aircraft:' : ''}${latest.revision}\nevent: ${kind}\ndata: ${JSON.stringify(latest)}\n\n`);
            }
          }
          for (const pluginId of Object.keys(PLUGIN_UPDATE_SCOPES)) {
            const latest = state.plugins.get(pluginId);
            if (latest && latest.receiptId !== lastPluginReceipts.get(pluginId)) {
              lastPluginReceipts.set(pluginId, latest.receiptId);
              send(`id: plugin:${pluginId}:${latest.fence}:${latest.receiptId}\nevent: plugin\ndata: ${JSON.stringify(latest)}\n\n`);
            }
          }
          if (!state.latest && !state.aircraft && !state.plugins.size && !sentReady && (state.loaded || state.unavailable)) {
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
    }, { highWaterMark: COLLECTION_UPDATE_QUEUE_BYTES, size: (chunk) => chunk.byteLength });
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } });
  }
  function closeUpdates(env) {
    const state = env?.EARTH_DB && states.get(env.EARTH_DB);
    if (state) state.epoch++; // Every request-owned pump closes on its next tick.
  }
  function status(env) {
    const state = env?.EARTH_DB && states.get(env.EARTH_DB);
    return { clients: state?.clients || 0, reading: Boolean(state?.readToken), revision: state?.latest?.revision || null,
      aircraftRevision: state?.aircraft?.revision || null };
  }
  return { publishCollectionRevision, handleUpdates, closeUpdates, status };
}

const channel = createCollectionUpdates();
export const publishCollectionRevision = (env, value) => channel.publishCollectionRevision(env, value);
export const publishAircraftRevision = (env, value) => channel.publishCollectionRevision(env, value, 'aircraft');
export const handleUpdates = (request, env) => channel.handleUpdates(request, env);
export const closeUpdates = (env) => channel.closeUpdates(env);
