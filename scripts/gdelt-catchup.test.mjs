import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateGkgSnapshot, historicalGkgDescriptor, readGkgArchive, GKG_UPDATE_MANIFEST, retainedGkgSnapshot } from './gdelt-snapshot.mjs';
import { createLocalGdeltSource } from './local-gdelt-source.mjs';
import { createGkgSnapshot, parseGkgRow, gkgTopicReport, gkgBatchTime, validateGkgSnapshot, GKG_CATCHUP_BUDGET } from '../server/hosted/gdelt-gkg.js';
import { createGdeltSnapshotReader } from '../server/hosted/gdelt-snapshot.js';

const NOW = Date.parse('2026-10-11T10:05:00.000Z');
const iso = (time) => new Date(time).toISOString();
const id = (time) => iso(time).replace(/[-:TZ.]/g, '').slice(0, 14);
const officialUrl = (batch) => `https://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip`;
const latest = '20261011100000', early = '20261011080000';

function fixture(batch, { corruptCrc = false } = {}) {
  const fields = Array(27).fill(''); Object.assign(fields, { 0: `${batch}-T1`, 1: batch, 2: '1', 3: 'publisher.example',
    4: `https://publisher.example/${batch}`, 7: 'ARMEDCONFLICT;WB_698_TRADE;NATURAL_DISASTER;', 9: '1#Belgium#BE##50#4#BE' });
  const text = `${fields.join('\t')}\n`, data = Buffer.from(text), compressed = deflateRawSync(data), name = Buffer.from(`${batch}.gkg.csv`);
  let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let n = 0; n < 8; n++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  crc = ((crc ^ 0xffffffff) ^ Number(corruptCrc)) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  const bytes = Buffer.concat([local, name, compressed, central, name, end]), md5 = createHash('md5').update(bytes).digest('hex');
  return { bytes, text, size: bytes.length, expandedBytes: data.length, etag: `"archive-${batch}"`, manifest: `${bytes.length} ${md5} http://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip\n` };
}

function prior(batches = [early], at = NOW - 60000) {
  const retrievedAt = iso(at);
  return createGkgSnapshot({ reports: batches.flatMap((batch) => parseGkgRow(fixture(batch).text.slice(0, -1), { batch, retrievedAt })),
    processedBatches: batches.map((batch) => ({ id: batch, retrievedAt, rows: 1, matchedRecords: 3 })), generatedAt: retrievedAt });
}

function transport({ latestBatch = latest, failure, fixtureOptions, delayed = false } = {}) {
  const calls = [], archives = new Map(); let active = 0, maxActive = 0;
  const get = (batch) => { if (!archives.has(batch)) archives.set(batch, fixture(batch, fixtureOptions?.(batch))); return archives.get(batch); };
  return { calls, get, maxActive: () => maxActive, fetchImpl: async (url, options = {}) => {
    const method = options.method || 'GET'; calls.push({ url, method, headers: options.headers });
    assert.equal(options.redirect, 'error'); options.signal?.throwIfAborted();
    if (url === GKG_UPDATE_MANIFEST) return new Response(get(latestBatch).manifest);
    const batch = /\/(\d{14})\.gkg\.csv\.zip$/.exec(url)?.[1]; assert.ok(batch); assert.equal(url, officialUrl(batch));
    const failed = failure?.(batch, method, options); if (failed) return failed;
    const archive = get(batch), headers = { etag: archive.etag, 'content-length': String(archive.size), 'content-type': 'application/zip' };
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    if (method === 'HEAD') return new Response(null, { headers });
    if (options.headers['If-Match']) assert.equal(options.headers['If-Match'], archive.etag);
    active++; maxActive = Math.max(maxActive, active);
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 3));
    active--; return new Response(archive.bytes, { headers });
  } };
}

test('newest batch is retained first, then two oldest explicit gaps; three archives stay sequential with bounded bytes', async () => {
  const source = transport({ delayed: true }), previous = prior();
  const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: previous, fetchImpl: source.fetchImpl, now: () => NOW });
  assert.equal(result.status, 'generated', result.reason); assert.equal(result.factualChanged, true);
  assert.deepEqual(source.calls.map((call) => `${call.method}:${call.url}`), [
    `GET:${GKG_UPDATE_MANIFEST}`, `GET:${officialUrl(latest)}`, `HEAD:${officialUrl('20261011081500')}`, `GET:${officialUrl('20261011081500')}`,
    `HEAD:${officialUrl('20261011083000')}`, `GET:${officialUrl('20261011083000')}`]);
  assert.equal(source.maxActive(), 1); assert.equal(result.archives, 3);
  assert.equal(result.archiveBytes, [latest, '20261011081500', '20261011083000'].reduce((sum, batch) => sum + source.get(batch).size, 0));
  assert.ok(result.archiveBytes <= 48 * 1024 * 1024); assert.ok(result.expandedBytes <= 384 * 1024 * 1024);
  assert.deepEqual(result.snapshot.coverage.catchup.budget, GKG_CATCHUP_BUDGET);
  assert.deepEqual(result.snapshot.coverage.catchup.pendingBatches, ['20261011084500', '20261011090000', '20261011091500', '20261011093000', '20261011094500']);
  assert.deepEqual(result.snapshot.coverage.catchup.cappedBatches, result.snapshot.coverage.sampleGaps);
  const old = result.snapshot.coverage.processedBatches.find((batch) => batch.id === early); assert.equal(old.retrievedAt, previous.generatedAt); assert.equal(old.integrity, undefined);
  for (const batch of result.snapshot.coverage.processedBatches.filter((batch) => batch.integrity)) {
    assert.equal(batch.integrity.sha256, createHash('sha256').update(source.get(batch.id).bytes).digest('hex'));
    assert.equal(batch.integrity.expandedBytes, source.get(batch.id).expandedBytes);
    assert.equal(batch.integrity.mode, batch.id === latest ? 'manifest-md5-and-zip-crc' : 'https-head-size-and-zip-crc');
    if (batch.id !== latest) { assert.equal(batch.integrity.providerMd5, null); assert.equal(batch.integrity.providerEtag, source.get(batch.id).etag); }
  }
  assert.deepEqual(validateGkgSnapshot(result.snapshot, NOW), result.snapshot);
});

test('a retained latest batch still repairs older gaps, and never re-fetches the latest archive', async () => {
  const source = transport(), previous = prior([early, latest]);
  const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: previous, fetchImpl: source.fetchImpl, now: () => NOW });
  assert.equal(result.status, 'generated', result.reason); assert.equal(result.archives, 2);
  assert.equal(source.calls.some((call) => call.url === officialUrl(latest)), false);
  assert.equal(result.snapshot.coverage.processedBatches.at(-1).retrievedAt, previous.generatedAt);
  assert.equal(result.snapshot.generatedAt, iso(NOW));
});

test('latest failure preserves the previous asset exactly and prevents every repair request', async () => {
  const previous = prior(), before = JSON.stringify(previous), source = transport({ failure: (batch, method) => batch === latest && method === 'GET' ? new Response(null, { status: 503 }) : null });
  const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: previous, fetchImpl: source.fetchImpl, now: () => NOW });
  assert.equal(result.status, 'skipped'); assert.equal(result.bytes, undefined); assert.equal(result.httpStatus, 503);
  assert.equal(source.calls.length, 2); assert.equal(JSON.stringify(previous), before);
});

test('a newest success survives failed repair; Retry-After persists an honest missing slot and avoids a same-host burst', async () => {
  const source = transport({ failure: (batch, method) => batch === '20261011081500' && method === 'HEAD' ? new Response(null, { status: 429, headers: { 'retry-after': '600' } }) : null });
  const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: prior(), fetchImpl: source.fetchImpl, now: () => NOW });
  assert.equal(result.status, 'generated', result.reason); assert.equal(result.factualChanged, true); assert.equal(result.archives, 1);
  assert.equal(result.snapshot.coverage.processedBatches.some((batch) => batch.id === latest), true);
  const checkpoint = result.snapshot.coverage.catchup;
  assert.deepEqual(checkpoint.attemptedBatches, ['20261011081500']); assert.equal(checkpoint.attempts[0].httpStatus, 429);
  assert.equal(checkpoint.attempts[0].retryAt, iso(NOW + 600000)); assert.ok(checkpoint.pendingBatches.includes('20261011081500'));
  assert.deepEqual(checkpoint.deferredBatches, checkpoint.pendingBatches); assert.equal(source.calls.length, 3);
  const calls = source.calls.length;
  const deferred = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: result.snapshot, fetchImpl: source.fetchImpl, now: () => NOW + 60000 });
  assert.equal(deferred.status, 'skipped'); assert.equal(deferred.code, 'unchanged'); assert.equal(deferred.checkedAt, null);
  assert.equal(source.calls.length, calls, 'a retained host rate-limit blocks later manifest and other-batch requests until Retry-After');
});

test('retry-only clock changes preserve exact factual dates and records, and survive an on-disk local restart', async (t) => {
  const taskDirectory = await mkdtemp(path.join(tmpdir(), 'earth-gkg-repair-'));
  assert.equal(path.dirname(taskDirectory), path.resolve(tmpdir())); assert.ok(path.basename(taskDirectory).startsWith('earth-gkg-repair-'));
  t.after(() => rm(taskDirectory, { recursive: true, force: true }));
  let clock = NOW; const source = transport({ failure: (batch, method) => method === 'HEAD' ? new Response(null, { status: 503 }) : null });
  const previous = prior([early, latest]);
  const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: previous, fetchImpl: source.fetchImpl, now: () => clock });
  assert.equal(result.status, 'generated', result.reason); assert.equal(result.factualChanged, false); assert.equal(result.snapshot.generatedAt, previous.generatedAt);
  assert.deepEqual(result.snapshot.categories, previous.categories); assert.deepEqual(result.snapshot.coverage.processedBatches, previous.coverage.processedBatches);
  await writeFile(path.join(taskDirectory, 'gdelt.snapshot.json'), result.bytes);
  const options = { repairEnabled: true, stateDirectory: taskDirectory, fetchImpl: source.fetchImpl, now: () => clock, archiveParser: readGkgArchive };
  // Failed oldest slots defer; the next two available gaps get attempts rather than re-fetching the failed pair.
  clock += 60000; const local = createLocalGdeltSource(options), read = await local.read({ category: 'all', country: '', q: '' }); local.close();
  assert.equal(read.state.generatedAt, previous.generatedAt); assert.deepEqual(read.state.catchup.deferredBatches.slice(0, 2), ['20261011081500', '20261011083000']);
  assert.equal(source.calls.filter((call) => call.url === officialUrl('20261011081500')).length, 1);
  const saved = JSON.parse(await readFile(path.join(taskDirectory, 'gdelt.snapshot.json'), 'utf8'));
  assert.equal(saved.generatedAt, previous.generatedAt); assert.deepEqual(saved.categories, previous.categories);
  const retained = retainedGkgSnapshot(saved, clock); assert.equal(retained.coverage.catchup.attempts.length, 4);
  const reader = createGdeltSnapshotReader({ now: () => clock, fetchImpl: async () => Response.json(saved) });
  const publicRead = await reader({ category: 'all', country: '', q: '' }); assert.equal(publicRead.state.catchup.checkedAt, iso(clock));
  assert.equal(publicRead.indexSource.generation, previous.generatedAt);
});

test('HEAD and historical GET enforce fixed sizes, strong ETags and identity encoding; no ETag becomes a provider MD5', async () => {
  const archive = fixture('20261011081500'), headers = { 'content-length': String(archive.size), etag: archive.etag };
  const descriptor = historicalGkgDescriptor(new Response(null, { headers }), '20261011081500', NOW);
  assert.equal(descriptor.md5, null); const parsed = await readGkgArchive(archive.bytes, descriptor, { retrievedAt: iso(NOW) });
  assert.equal(parsed.integrity.providerMd5, null); assert.equal(parsed.integrity.mode, 'https-head-size-and-zip-crc');
  for (const change of [{ etag: 'W/"weak"' }, { etag: '*' }, { etag: '"bad\nvalue"' }, { 'content-length': '16777217' }, { 'content-length': '0' }, { 'content-encoding': 'gzip' }]) {
    const normalized = { ...headers, ...change };
    assert.throws(() => historicalGkgDescriptor(new Response(null, { headers: normalized }), '20261011081500', NOW));
  }
  for (const headersChange of [{ etag: '"different"' }, { 'content-length': String(archive.size + 1) }, { 'content-encoding': 'gzip' }]) {
    const source = transport({ failure: (batch, method) => batch === '20261011081500' && method === 'GET' ? new Response(archive.bytes, { headers: { ...headers, ...headersChange } }) : null });
    const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: prior(), fetchImpl: source.fetchImpl, now: () => NOW });
    assert.equal(result.status, 'generated', result.reason); assert.equal(result.snapshot.coverage.processedBatches.some((batch) => batch.id === '20261011081500'), false);
    assert.equal(result.snapshot.coverage.catchup.attempts[0].code, 'invalid-response');
  }
});

test('a corrupted historical CRC remains a pending interval while other valid acquisitions are preserved', async () => {
  const source = transport({ fixtureOptions: (batch) => ({ corruptCrc: batch === '20261011081500' }) });
  const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: prior(), fetchImpl: source.fetchImpl, now: () => NOW });
  assert.equal(result.status, 'generated', result.reason); assert.ok(result.snapshot.coverage.sampleGaps.includes('20261011081500'));
  assert.ok(result.snapshot.coverage.processedBatches.some((batch) => batch.id === '20261011083000'));
  assert.equal(result.snapshot.coverage.catchup.attempts[0].code, 'invalid-response');
});

test('CPU parser enforces an absolute acquisition deadline even before an event-loop timeout can fire', async () => {
  const archive = fixture(latest), descriptor = { batch: latest, size: archive.size, md5: createHash('md5').update(archive.bytes).digest('hex'), url: officialUrl(latest) };
  await assert.rejects(readGkgArchive(archive.bytes, descriptor, { retrievedAt: iso(NOW), expiresAt: Date.now() - 1 }), { name: 'TimeoutError' });
});

test('deadline and owner cancellation settle ignored-signal transports, retaining an already completed newest archive', async () => {
  const latestFixture = fixture(latest);
  const ignored = async (url) => url === GKG_UPDATE_MANIFEST ? new Response(latestFixture.manifest) : url === officialUrl(latest) ? new Response(latestFixture.bytes) : new Promise(() => {});
  // Keep one referenced timer while AbortSignal.timeout uses an unreferenced native timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: prior(), fetchImpl: ignored, timeoutMs: 300, now: () => NOW });
    assert.equal(result.status, 'generated', result.reason); assert.equal(result.snapshot.coverage.catchup.attempts[0].code, 'timeout');
    assert.equal(result.snapshot.coverage.processedBatches.at(-1).id, latest); assert.equal(result.archives, 1);
    const controller = new AbortController(), running = generateGkgSnapshot({ repairEnabled: true, previousSnapshot: prior(), fetchImpl: async () => new Promise(() => {}), signal: controller.signal, now: () => NOW });
    controller.abort(new DOMException('Synthetic owner shutdown', 'AbortError')); const cancelled = await running;
    assert.equal(cancelled.status, 'skipped'); assert.equal(cancelled.code, 'aborted'); assert.equal(cancelled.bytes, undefined);
  } finally { clearTimeout(keepAlive); }
});

test('legacy output is unchanged by default and pending coverage is finite, never fabricated before the first retained batch', async () => {
  const source = transport(), previous = prior();
  const disabled = await generateGkgSnapshot({ previousSnapshot: previous, fetchImpl: source.fetchImpl, now: () => NOW });
  assert.equal(disabled.status, 'generated'); assert.equal(disabled.snapshot.coverage.catchup, undefined);
  assert.equal(disabled.snapshot.coverage.processedBatches.every((entry) => entry.integrity === undefined), true);
  assert.equal(source.calls.length, 2);
  const first = await generateGkgSnapshot({ repairEnabled: true, previousSnapshot: null, fetchImpl: transport().fetchImpl, now: () => NOW });
  assert.deepEqual(first.snapshot.coverage.sampleGaps, []); assert.deepEqual(first.snapshot.coverage.catchup.pendingBatches, []);
});

test('96-slot checkpoint and 240 long canonical records fit the release bound, with oversized payloads rejected', (t) => {
  const end = Date.parse(gkgBatchTime(latest)), start = end - 95 * 900000, retrievedAt = iso(NOW - 1000), first = id(start);
  const reports = ['geopolitics', 'economy', 'disasters'].flatMap((category, group) => Array.from({ length: 80 }, (_, n) => {
    const themes = category === 'geopolitics' ? ['ARMEDCONFLICT'] : category === 'economy' ? ['WB_698_TRADE'] : ['NATURAL_DISASTER'];
    return gkgTopicReport({ url: `https://publisher-${n}.example/${group}/${'x'.repeat(1024)}`, themes, batch: latest, retrievedAt, category,
      mentionedCountries: ['BE', 'DE', 'FR', 'US', 'GB', 'CN', 'JP', 'AU', 'AT', 'BR', 'CA', 'CH', 'DK', 'ES', 'FI', 'IE', 'IN', 'IT', 'KR', 'NL', 'NO', 'NZ', 'PL', 'PT', 'RU', 'SA', 'SE', 'SG', 'TR', 'UA', 'ZA', 'MX'] });
  }));
  const attempts = Array.from({ length: 94 }, (_, n) => ({ id: id(start + (n + 1) * 900000), checkedAt: iso(NOW), retryAt: iso(NOW + 600000), code: 'http-error', httpStatus: 503 }));
  const snapshot = createGkgSnapshot({ reports, generatedAt: retrievedAt, processedBatches: [{ id: first, retrievedAt, rows: 0, matchedRecords: 0 }, { id: latest, retrievedAt, rows: 80, matchedRecords: 240 }],
    catchup: { checkedAt: iso(NOW), attemptedBatches: [], attempts } });
  const valid = validateGkgSnapshot(snapshot, NOW), bytes = Buffer.byteLength(`${JSON.stringify(valid)}\n`);
  assert.equal(valid.coverage.catchup.attempts.length, 94); assert.equal(valid.coverage.sampleGaps.length, 94);
  assert.equal(Object.values(valid.categories).reduce((sum, entry) => sum + entry.reports.length, 0), 240);
  assert.ok(bytes < 1048576, `measured release ${bytes} bytes`);
  t.diagnostic(`240 long records and 94 retry checkpoints: ${bytes} serialized bytes`);
  const oversized = structuredClone(snapshot);
  for (const entry of Object.values(oversized.categories)) for (const report of entry.reports) {
    const replacement = gkgTopicReport({ ...report, url: report.url.replace(/x+$/, 'x'.repeat(1970)) }); Object.assign(report, replacement);
  }
  assert.throws(() => validateGkgSnapshot(oversized, NOW), /byte limit/);
  for (const mutate of [(v) => { v.coverage.catchup.pendingBatches.pop(); }, (v) => { v.coverage.catchup.budget.maxRepairs = 3; },
    (v) => { v.coverage.catchup.attempts[0].retryAt = iso(NOW + 86400001); }, (v) => { v.coverage.catchup.attemptedBatches = [first, latest, id(start + 900000)]; }]) {
    const altered = structuredClone(snapshot); mutate(altered); assert.throws(() => validateGkgSnapshot(altered, NOW));
  }
});
