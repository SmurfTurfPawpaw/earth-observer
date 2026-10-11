import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createLocalGdeltSource, parseLocalGkgArchive } from './local-gdelt-source.mjs';
import { createLocalPipeline, LOCAL_PUBLISH_URL } from './local-intelligence-pipeline.mjs';
import { generateGkgSnapshot, GKG_UPDATE_MANIFEST, GDELT_SNAPSHOT_ASSET } from './gdelt-snapshot.mjs';
import { GDELT_SNAPSHOT_URL } from '../server/hosted/gdelt-snapshot.js';
import { EONET_QUERY_URL } from '../server/hosted/eonet-snapshot.js';

const START = Date.parse('2026-10-11T10:05:00.000Z'), BATCH = '20261011100000';
const iso = (at) => new Date(at).toISOString(), filters = { category: 'all', country: '', q: '' };
async function directory(t) {
  const parent = path.resolve(tmpdir()), target = await mkdtemp(path.join(parent, 'earth-local-gkg-'));
  assert.equal(path.dirname(path.resolve(target)), parent); assert.ok(path.basename(target).startsWith('earth-local-gkg-'));
  t.after(() => rm(target, { recursive: true, force: true })); return target;
}
function archiveFixture(batch = BATCH, count = 1, { reviewed = true } = {}) {
  const rows = Array.from({ length: count }, (_, index) => {
    const fields = Array(27).fill('');
    Object.assign(fields, { 0: `${batch}-T${index + 1}`, 1: batch, 2: '1', 3: 'publisher.example',
      4: `https://publisher.example/${batch}/${index}`, 7: reviewed ? 'ARMEDCONFLICT;WB_698_TRADE;NATURAL_DISASTER;' : 'UNREVIEWED_THEME;',
      9: '1#Belgium#BE##50.85#4.35#BE;', 18: 'https://publisher.example/copyrighted.jpg', 26: 'Article text excluded' });
    return fields.join('\t');
  }).join('\n') + '\n';
  const data = Buffer.from(rows), compressed = deflateRawSync(data), name = Buffer.from(`${batch}.gkg.csv`);
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  const archive = Buffer.concat([local, name, compressed, central, name, end]);
  const descriptor = { batch, size: archive.length, md5: createHash('md5').update(archive).digest('hex'),
    url: `https://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip` };
  return { archive, descriptor, manifest: `${archive.length} ${descriptor.md5} http://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip\n` };
}
function upstream() {
  let clock = START, fixture = archiveFixture(), mode = 'ready'; const urls = [], publications = [];
  const fetchImpl = async (input, options) => {
    const url = String(input); urls.push(url); options.signal?.throwIfAborted();
    if (url === LOCAL_PUBLISH_URL) { publications.push(JSON.parse(options.body)); return Response.json({ stored: true }); }
    assert.equal(options.redirect, url.startsWith('https://data.gdeltproject.org/') ? 'error' : 'manual');
    if (url === GKG_UPDATE_MANIFEST) {
      if (mode === 'limited') return new Response(null, { status: 429, headers: { 'retry-after': '600' } });
      return new Response(mode === 'foreign' ? fixture.manifest.replace('data.gdeltproject.org', 'unreviewed.example') : fixture.manifest);
    }
    if (url === fixture.descriptor.url) return new Response(mode === 'corrupt' ? Buffer.from('bad archive') : fixture.archive);
    if (url === EONET_QUERY_URL) return Response.json({ events: [] });
    if (url.startsWith('https://earthquake.usgs.gov/') || url.startsWith('https://www.gdacs.org/')) return Response.json({ features: [] });
    throw new Error('Unregistered upstream request');
  };
  return { fetchImpl, urls, publications, now: () => clock, advance(ms = 61000) { clock += ms; }, mode(value) { mode = value; },
    batch(batch, at, options) { fixture = archiveFixture(batch, 1, options); clock = at; }, fixture: () => fixture };
}

test('direct laptop path processes one official archive, persists it across restarts, deduplicates batches and reports honest gaps/dates', async (t) => {
  const stateDirectory = await directory(t), source = upstream(), jobs = [];
  const options = { stateDirectory, fetchImpl: source.fetchImpl, now: source.now, gdeltMode: 'local-gkg',
    publishUrl: LOCAL_PUBLISH_URL, publishCredential: 'synthetic_local_gkg_token_1234567890123456',
    infer: async (records) => { jobs.push(records.map((row) => row.id)); return []; } };
  const first = await createLocalPipeline(options).cycle();
  assert.ok(first.packet.payload.indexRecords.length > 0);
  assert.equal(first.packet.payload.sources.find((row) => row.id === 'gdelt').mode, 'local-gkg');
  assert.deepEqual(source.urls.filter((url) => url.includes('gdelt')), [GKG_UPDATE_MANIFEST, source.fixture().descriptor.url]);
  assert.equal(source.urls.includes(GDELT_SNAPSHOT_URL), false);
  const snapshotFile = path.join(stateDirectory, 'gdelt', GDELT_SNAPSHOT_ASSET), before = await readFile(snapshotFile, 'utf8');
  assert.ok(Buffer.byteLength(before) <= 1024 * 1024); assert.equal(JSON.parse(before).coverage.scheduledIntervalMinutes, 30, 'legacy schema remains compatible');
  const count = source.urls.length; const restart = createLocalPipeline(options); await restart.cycle();
  assert.equal(source.urls.filter((url) => url.includes('gdelt')).length, 2, 'persisted admission clock stops immediate repeated batch fetch');
  source.advance(); const same = await restart.cycle();
  assert.equal(source.urls.filter((url) => url.endsWith('.gkg.csv.zip')).length, 1);
  assert.equal(await readFile(snapshotFile, 'utf8'), before); assert.equal(jobs.length, 1);
  assert.equal(source.publications.at(-1).action, 'heartbeat');
  assert.equal(same.packet.payload.indexRecords[0].retrievedAt, first.packet.payload.indexRecords[0].retrievedAt);
  assert.ok(source.urls.length > count);
  source.batch('20261011103000', Date.parse('2026-10-11T10:35:00.000Z'));
  const next = await restart.cycle(), state = next.packet.payload.sources.find((row) => row.id === 'gdelt');
  assert.equal(source.urls.filter((url) => url.endsWith('.gkg.csv.zip')).length, 2);
  assert.deepEqual(state.sampleGaps, ['20261011101500']); assert.equal(state.sourceCadenceMs, 900000); assert.equal(state.refreshIntervalMs, 60000);
  assert.equal(state.processedBatches[0].retrievedAt, iso(START)); assert.equal(state.processedBatches[1].retrievedAt, iso(source.now()));
  assert.ok(next.packet.payload.indexRecords.some((record) => record.indexedAt === '2026-10-11T10:00:00.000Z' && record.retrievedAt === iso(START)));
  assert.doesNotMatch(JSON.stringify(next.packet), /Article text excluded|copyrighted\.jpg/);
  assert.equal(jobs.length, 2); assert.ok(source.urls.every((url) => !url.includes('api.gdeltproject') && !url.includes('github.com') && !url.includes('publisher.example')));
  source.batch('20261011104500', Date.parse('2026-10-11T10:50:00.000Z'), { reviewed: false });
  const emptyBatch = await restart.cycle();
  assert.equal(emptyBatch.inputDigest, next.inputDigest); assert.equal(jobs.length, 2, 'coverage-only revisions never repeat inference');
  assert.equal(source.publications.at(-1).action, 'publish', 'new processed batch coverage is sent even if selected facts are unchanged');
  assert.equal(source.publications.at(-1).packet.payload.sources.find((row) => row.id === 'gdelt').processedBatches.at(-1).id, '20261011104500');
  assert.equal(source.publications.at(-1).analysis.createdAt, emptyBatch.packet.collectedAt);
  source.batch('20261012101500', Date.parse('2026-10-12T10:20:00.000Z'));
  const nextDay = await createLocalPipeline(options).cycle(), dayState = nextDay.packet.payload.sources.find((row) => row.id === 'gdelt');
  assert.deepEqual(dayState.processedBatches.map((row) => row.id), ['20261011103000', '20261011104500', '20261012101500']);
  assert.ok(nextDay.packet.payload.indexRecords.some((row) => row.indexedAt === '2026-10-11T10:30:00.000Z' && row.retrievedAt === '2026-10-11T10:35:00.000Z'));
  assert.ok(nextDay.packet.payload.indexRecords.every((row) => row.indexedAt !== '2026-10-11T10:00:00.000Z'));
});

test('persistent Retry-After and invalid upstreams retain exact last-good bytes without release bootstrap or archive retries', async (t) => {
  const stateDirectory = await directory(t), source = upstream(), options = { stateDirectory, fetchImpl: source.fetchImpl, now: source.now };
  let adapter = createLocalGdeltSource(options); const first = await adapter.read(filters), before = await readFile(path.join(stateDirectory, GDELT_SNAPSHOT_ASSET), 'utf8');
  source.advance(); source.mode('limited'); const failure = await adapter.read(filters);
  assert.equal(failure.state.status, 'stale'); assert.equal(failure.state.retryAt, source.now() + 600000);
  assert.equal(failure.records[0].retrievedAt, first.records[0].retrievedAt); const count = source.urls.length;
  adapter = createLocalGdeltSource(options); source.advance(300000); await adapter.read(filters); assert.equal(source.urls.length, count);
  source.advance(300000); source.mode('ready'); const restored = await adapter.read(filters);
  assert.equal(restored.state.status, 'ready'); assert.equal(restored.records[0].retrievedAt, first.records[0].retrievedAt);
  assert.equal(await readFile(path.join(stateDirectory, GDELT_SNAPSHOT_ASSET), 'utf8'), before);
  source.advance(); source.mode('foreign'); const foreign = await adapter.read(filters);
  assert.equal(foreign.state.status, 'stale'); assert.equal(source.urls.at(-1), GKG_UPDATE_MANIFEST);
  source.advance(300000); source.batch('20261011101500', source.now()); source.mode('corrupt'); await adapter.read(filters);
  assert.equal(await readFile(path.join(stateDirectory, GDELT_SNAPSHOT_ASSET), 'utf8'), before);
  assert.ok(source.urls.every((url) => url === GKG_UPDATE_MANIFEST || /^https:\/\/data\.gdeltproject\.org\/gdeltv2\/\d{14}\.gkg\.csv\.zip$/.test(url)));
});

test('local parser uses an isolated thread and termination handles abort before CPU work without leaving a parse running', async () => {
  const fixture = archiveFixture(BATCH, 1000), signal = new AbortController(), archive = new Uint8Array(fixture.archive);
  const parsed = await parseLocalGkgArchive(fixture.archive, fixture.descriptor, { retrievedAt: iso(START) });
  assert.equal(parsed.rows, 1000); assert.equal(parsed.matchedRecords, 3000);
  const cancelled = parseLocalGkgArchive(archive, fixture.descriptor, { retrievedAt: iso(START), signal: signal.signal });
  assert.equal(archive.byteLength, 0, 'transfer detaches owned archive rather than copying its buffer to the thread');
  signal.abort(new DOMException('Synthetic owner stop', 'AbortError'));
  await assert.rejects(cancelled, /Synthetic owner stop/);
});

test('caller cancellation and bounded timeout cancel manifest acquisition and persist restart-safe admission without false freshness', { timeout: 10000 }, async (t) => {
  const stateDirectory = await directory(t), controller = new AbortController(), acquisitionStarted = Promise.withResolvers();
  let cancellations = 0, calls = 0;
  const fetchImpl = async (url, { signal }) => {
    assert.equal(url, GKG_UPDATE_MANIFEST); signal.throwIfAborted(); calls++;
    // With no prefetch queue, pull signals an actual pending manifest read,
    // after initialization/admission writes and the reader's abort listener.
    return new Response(new ReadableStream({ pull() { acquisitionStarted.resolve(); }, cancel() { cancellations++; } }, { highWaterMark: 0 }));
  };
  const adapter = createLocalGdeltSource({ stateDirectory, now: () => START, fetchImpl });
  const pending = adapter.read(filters, { signal: controller.signal });
  const rejection = assert.rejects(pending, /Synthetic cycle deadline/);
  await Promise.race([acquisitionStarted.promise, pending]);
  controller.abort(new DOMException('Synthetic cycle deadline', 'AbortError'));
  await rejection; assert.equal(cancellations, 1);
  const saved = await adapter.status(); assert.equal(saved.lastCode, 'aborted'); assert.equal(saved.lastCheckedAt, null); assert.equal(saved.failures, 0);
  await createLocalGdeltSource({ stateDirectory, now: () => START, fetchImpl }).read(filters); assert.equal(calls, 1);
  const hold = setTimeout(() => {}, 1000);
  try {
    const timeout = await generateGkgSnapshot({ previousSnapshot: null, now: () => START, timeoutMs: 10, fetchImpl });
    assert.equal(timeout.code, 'timeout'); assert.equal(timeout.checkedAt, null); assert.equal(cancellations, 2);
  } finally { clearTimeout(hold); }
});
