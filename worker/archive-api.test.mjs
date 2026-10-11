import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publishWorldArchiveChunk } from './world-archive.js';
import { createArchiveApiHandler, ARCHIVE_IMPORT_PATH, ARCHIVE_API_LIMITS } from './archive-api.js';
import { acquireUsgsInterval, publishUsgsInterval, signArchiveImport, splitUsgsInterval,
  USGS_ARCHIVE_IMPORT_URL, USGS_ARCHIVE_SCOPE, runUsgsArchiveImport } from '../scripts/usgs-archive-import.mjs';

const NOW = Date.parse('2026-10-11T22:38:00.000Z'), KEY = 'archive_test_'.padEnd(64, 'k');
const RANGE = { from: '2025-10-01T00:00:00.000Z', to: '2025-10-08T00:00:00.000Z' };
const raw = (count = 1) => ({ type: 'FeatureCollection', metadata: { generated: NOW,
  url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?starttime=2025-10-01T00%3A00%3A00.000Z&endtime=2025-10-08T00%3A00%3A00.000Z&minmagnitude=4.5&eventtype=earthquake&format=geojson&orderby=time-asc&limit=501' },
  features: Array.from({ length: count }, (_, i) => ({ type: 'Feature', id: `us-test-${i}`, geometry: { type: 'Point', coordinates: [12, 50, 10] },
    properties: { type: 'earthquake', time: Date.parse('2025-10-02T00:00:00.000Z'), updated: NOW - 1000,
      mag: 5.3, status: 'reviewed', title: `USGS source fixture ${i}`, url: `https://earthquake.usgs.gov/earthquakes/eventpage/us-test-${i}` } })) });
const input = () => ({ schemaVersion: 1, scopeId: USGS_ARCHIVE_SCOPE, kind: 'interval', range: RANGE,
  capturedAt: new Date(NOW).toISOString(), expectedCount: 1, body: JSON.stringify(raw()) });
const env = () => ({ EARTH_ARCHIVE_IMPORT_KEY: KEY });
function request(value = input(), { key = KEY, nonce = 'a'.repeat(32), headers = {}, method = 'POST', suffix = '' } = {}) {
  const text = JSON.stringify(value), signed = signArchiveImport(key, text, { now: NOW, nonce });
  return new Request(`https://owned.example${ARCHIVE_IMPORT_PATH}${suffix}`, { method,
    headers: { ...signed, ...headers }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: text }) });
}
test('archive capability authenticates before streamed data or storage and rejects expanded input scope', async () => {
  let calls = 0;
  const handle = createArchiveApiHandler({ now: () => NOW, retain: async () => { calls++; return { stored: true }; }, publish: async () => { calls++; } });
  const trials = [
    [request(undefined, { key: 'wrong_'.padEnd(64, 'x') }), env(), 401],
    [request(undefined, { headers: { origin: 'https://owned.example' } }), env(), 401],
    [request(undefined, { suffix: '?source=other' }), env(), 401],
    [request(undefined, { method: 'GET' }), env(), 405],
    [request(), {}, 503],
    [request({ ...input(), url: 'https://unreviewed.example' }), env(), 400],
    [request({ ...input(), scopeId: 'other' }), env(), 400],
    [request({ ...input(), expectedCount: 501 }), env(), 400],
    [request(undefined, { headers: { 'x-earth-archive-digest': 'f'.repeat(64) } }), env(), 401],
    [request(undefined, { headers: { 'content-length': String(ARCHIVE_API_LIMITS.bodyBytes + 1) } }), env(), 413],
  ];
  for (const [r, settings, status] of trials) assert.equal((await handle(r, settings)).status, status);
  const stalled = new Request(`https://owned.example${ARCHIVE_IMPORT_PATH}`, { method: 'POST', duplex: 'half',
    headers: signArchiveImport('wrong_'.padEnd(64, 'x'), '', { now: NOW }), body: new ReadableStream({ start() {} }) });
  assert.equal((await handle(stalled, env())).status, 401); assert.equal(calls, 0);
});
test('interoperating Node signer retains unchanged original FDSN bytes and all features beyond the live sample limit', async () => {
  const value = { ...input(), expectedCount: 184, body: JSON.stringify(raw(184)) };
  let records, original;
  const handle = createArchiveApiHandler({ now: () => NOW,
    retain: async (_env, value) => { original = value.body; return { stored: true, rawSha256: createHash('sha256').update(value.body).digest('hex') }; },
    publish: async (_env, value) => { records = value.records; return { configured: true, available: true, stored: true,
      complete: true, recordCount: records.length, scopeId: value.scopeId, chunkId: 'b'.repeat(64) }; } });
  const response = await handle(request(value), env());
  assert.equal(response.status, 200); assert.equal((await response.json()).recordCount, 184);
  assert.equal(original, value.body); assert.equal(JSON.parse(original).metadata.count, undefined);
  assert.equal(records.length, 184); assert.equal(records.at(-1).id, 'usgs:us-test-183');
  assert.equal(records.at(-1).lat, 50); assert.equal(records.at(-1).lon, 12);
});
test('timed-out publication remains admitted until settlement and exposes an exact receipt for readback', async () => {
  let release, entered, calls = 0;
  const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { entered = resolve; });
  const tasks = [], configured = env();
  const handle = createArchiveApiHandler({ now: () => NOW, deadlineMs: 20,
    retain: async (_env, value) => ({ stored: true, rawSha256: createHash('sha256').update(value.body).digest('hex') }),
    publish: async () => { calls++; entered(); await held; return { stored: true }; } });
  const first = handle(request(), configured, { waitUntil: task => tasks.push(task) }); await arrived;
  const timed = await first, result = await timed.json();
  assert.equal(timed.status, 504); assert.equal(result.status, 'uncertain'); assert.equal(result.stored, null);
  assert.match(result.chunkId, /^[a-f0-9]{64}$/); assert.equal(result.readStatusBeforeRetry, true);
  assert.equal((await handle(request(undefined, { nonce: 'b'.repeat(32) }), configured)).status, 429);
  assert.equal(calls, 1); assert.equal(tasks.length, 1);
  release(); await Promise.all(tasks);
  assert.equal((await handle(request(), configured)).status, 409);
});
test('count-matched acquisition is fixed-source and neither sliced nor silently normalized to 100 records', async () => {
  const calls = [];
  const acquired = await acquireUsgsInterval({ range: RANGE, now: () => NOW, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(new URL(url).origin, 'https://earthquake.usgs.gov');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(new URL(url).searchParams.get('offset'), null);
    return url.includes('/count?') ? new Response('184', { headers: { 'content-type': 'text/plain' } }) : Response.json(raw(184));
  } });
  assert.equal(acquired.status, 'acquired'); assert.equal(acquired.expectedCount, 184); assert.equal(calls.length, 2);
  assert.equal(JSON.parse(acquired.body).features.length, 184); assert.match(acquired.chunkId, /^[a-f0-9]{64}$/);
  let writes = 0;
  const published = await publishUsgsInterval(acquired, { key: KEY, now: () => NOW, fetchImpl: async (url, options) => {
    writes++; assert.equal(url, USGS_ARCHIVE_IMPORT_URL); assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).body, acquired.body);
    return Response.json({ stored: true, complete: true, scopeId: USGS_ARCHIVE_SCOPE, recordCount: 184,
      chunkId: acquired.chunkId, publishedAt: new Date(NOW).toISOString(), unsafe: KEY });
  } });
  assert.equal(published.status, 'stored'); assert.equal(writes, 1); assert.ok(!JSON.stringify(published).includes(KEY));
});
test('dense intervals split with deliberate endpoint overlap; catalog changes and empty bodies remain incomplete', async () => {
  let calls = 0;
  const dense = await acquireUsgsInterval({ range: RANGE, fetchImpl: async () => { calls++; return new Response('501'); } });
  assert.equal(dense.status, 'split-required'); assert.equal(calls, 1);
  assert.equal(dense.parts[0].to, dense.parts[1].from); assert.deepEqual(dense.parts, splitUsgsInterval(RANGE));
  const changed = await acquireUsgsInterval({ range: RANGE, fetchImpl: async url => url.includes('/count?') ? new Response('2') : Response.json(raw(1)) });
  assert.equal(changed.status, 'changed-catalog'); assert.equal(changed.actualCount, 1);
  const empty = await acquireUsgsInterval({ range: RANGE, fetchImpl: async url => url.includes('/count?') ? new Response('0') : new Response(null, { status: 204 }) });
  assert.equal(empty.status, 'gap'); assert.equal(empty.body, undefined);
});

test('uncertain import resumes from intact original evidence and hosted receipt without acquiring or publishing twice', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-archive-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalFile = path.join(directory, 'journal.json');
  let candidate, providerRequests = 0, publications = 0, receipts = 0;
  const first = await runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, now: () => NOW,
    fetchImpl: async (url, options) => {
      if (new URL(url).origin === 'https://earthquake.usgs.gov') {
        providerRequests++;
        return url.includes('/count?') ? new Response('1') : Response.json(raw());
      }
      if (options?.method === 'POST') {
        publications++; candidate = JSON.parse(options.body);
        return Response.json({ status: 'uncertain', stored: null }, { status: 504 });
      }
      receipts++; return Response.json({ configured: true, available: true, stored: false,
        scopeId: USGS_ARCHIVE_SCOPE, chunkId: url.split('/').at(-1) });
    } });
  assert.equal(first.failed, true); assert.equal(first.remainingIntervals, 1);
  assert.equal(providerRequests, 2); assert.equal(publications, 1); assert.equal(receipts, 1);
  const saved = JSON.parse(await readFile(journalFile, 'utf8'));
  assert.match(saved.candidate.chunkId, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(directory, 'raw', `${saved.candidate.rawSha256}.json`), 'utf8'), candidate.body);
  await assert.rejects(access(`${journalFile}.lock`), { code: 'ENOENT' });
  const second = await runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, now: () => NOW,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://giovannicallebaut.com');
      assert.notEqual(options?.method, 'POST');
      receipts++; assert.ok(url.endsWith(saved.candidate.chunkId));
      return Response.json({ configured: true, available: true, stored: true, complete: true,
        scopeId: USGS_ARCHIVE_SCOPE, kind: 'interval', publicationOrder: 1,
        capturedAt: saved.candidate.capturedAt, snapshotId: saved.candidate.snapshotId, expectedCount: 1,
        chunkId: saved.candidate.chunkId, rawSha256: saved.candidate.rawSha256,
        recordCount: 1, range: RANGE, publishedAt: new Date(NOW).toISOString() });
    } });
  assert.equal(second.failed, false); assert.equal(second.completedThisRun, 1);
  assert.equal(second.sourceRequests, 0); assert.equal(second.recordsThisRun, 1);
  assert.equal(second.remainingIntervals, 0); assert.equal(receipts, 2);
  const completed = JSON.parse(await readFile(journalFile, 'utf8'));
  assert.equal(completed.candidate, undefined); assert.equal(completed.completed.length, 1);
  assert.equal(completed.failures.length, 1);
  assert.equal(completed.completed[0].capturedAt, saved.candidate.capturedAt);
});

test('damaged journal ranges and ambiguous receipt absence cannot expand or repeat an import', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-archive-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalFile = path.join(directory, 'journal.json');
  await writeFile(journalFile, JSON.stringify({ schemaVersion: 1, scopeId: USGS_ARCHIVE_SCOPE, range: RANGE,
    completed: [], pending: [{ ...RANGE, from: '2025-09-30T00:00:00.000Z' }], failures: [] }));
  let calls = 0;
  await assert.rejects(runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, fetchImpl: async () => { calls++; } }), /gap or expanded interval/);
  assert.equal(calls, 0); await rm(journalFile);
  let publications = 0;
  const result = await runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, now: () => NOW,
    fetchImpl: async (url, options) => {
      if (new URL(url).origin === 'https://earthquake.usgs.gov') return url.includes('/count?') ? new Response('1') : Response.json(raw());
      if (options?.method === 'POST') { publications++; throw new Error('Must not publish'); }
      return Response.json({ stored: false });
    } });
  assert.equal(result.failed, true); assert.equal(publications, 0); assert.equal(result.remainingIntervals, 1);
  const saved = JSON.parse(await readFile(journalFile, 'utf8')); saved.candidate.chunkId = 'a'.repeat(64);
  await writeFile(journalFile, JSON.stringify(saved)); calls = 0;
  const damaged = await runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, now: () => NOW, fetchImpl: async () => { calls++; } });
  assert.equal(damaged.failed, true); assert.equal(calls, 0);
});

test('real signed API, generated SQL schema and immutable store complete a timed-out import exactly once', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-archive-sql-'));
  const journalFile = path.join(directory, 'journal.json'), sqlite = new DatabaseSync(':memory:');
  t.after(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  sqlite.function('strftime', { varargs: true }, (_format, _value, modifier) =>
    new Date(NOW + (modifier === '+305 seconds' ? 305000 : 0)).toISOString());
  for (const filename of ['0000_glossy_overlord.sql', '0001_collection_revision.sql', '0002_aircraft_observations.sql',
    '0003_world_evidence.sql', '0004_world_archive_investigations.sql', '0005_investigation_queue_index.sql'])
    sqlite.exec(await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  const db = { withSession: () => db, prepare(sql) {
    const statement = (...values) => ({ sql, values,
      all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values) }),
      first: async () => sqlite.prepare(sql).get(...values) || null,
      run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }) });
    return { ...statement(), bind: statement };
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const value of statements)
      results.push(/^\s*(SELECT|WITH)/.test(value.sql) ? await value.all() : await value.run());
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const objects = new Map(), store = { get: async key => objects.has(key) ? {
    text: async () => objects.get(key), json: async () => JSON.parse(objects.get(key)), size: Buffer.byteLength(objects.get(key)) } : null,
    put: async (key, text, options) => {
      if (options?.onlyIf?.get('if-none-match') === '*' && objects.has(key)) return null;
      objects.set(key, text); return { etag: String(objects.size) };
    } };
  let release, publicationError, publications = 0, sourceRequests = 0;
  const held = new Promise(resolve => { release = resolve; }), background = [];
  const settings = { EARTH_DB: db, EARTH_STORE: store, EARTH_ARCHIVE_IMPORT_KEY: KEY };
  const handle = createArchiveApiHandler({ now: () => NOW, deadlineMs: 20, publish: async (...args) => {
    publications++; await held;
    try { return await publishWorldArchiveChunk(...args); } catch (error) { publicationError = error; throw error; }
  } });
  const fetchImpl = async (url, options) => {
    if (new URL(url).origin === 'https://earthquake.usgs.gov') {
      sourceRequests++; return url.includes('/count?') ? new Response('1') : Response.json(raw());
    }
    const normalized = new URL(url); normalized.pathname = normalized.pathname.replace(/^\/earth/, '');
    return handle(new Request(normalized, options), settings, { waitUntil: task => background.push(task) });
  };
  const first = await runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, now: () => NOW, fetchImpl });
  assert.equal(first.failed, true); assert.equal(publications, 1); assert.equal(background.length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 0);
  release(); await Promise.all(background);
  assert.ifError(publicationError);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_chunks').get().n, 1);
  const second = await runUsgsArchiveImport({ range: RANGE, key: KEY, journalFile, now: () => NOW, fetchImpl });
  assert.equal(second.failed, false); assert.equal(second.completedIntervals, 1); assert.equal(second.remainingIntervals, 0);
  assert.equal(sourceRequests, 2); assert.equal(publications, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_coverage').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_archive_heads').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM earth_world_sources').get().n, 0);
});
