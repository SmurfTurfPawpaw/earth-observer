import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { generateGdeltSnapshot, generateGkgSnapshot, parseGkgUpdateManifest, inspectGkgZip, readGkgArchive, writeGdeltSnapshot, GDELT_SNAPSHOT_ASSET, MAX_GDELT_SNAPSHOT_BYTES, GKG_UPDATE_MANIFEST, MAX_GKG_ZIP_BYTES } from '../../scripts/gdelt-snapshot.mjs';
import { gdeltQueryUrl } from './gdelt-query.js';
import { validateGdeltSnapshot, GDELT_SNAPSHOT_URL } from './gdelt-snapshot.js';

const START = Date.parse('2026-10-11T10:00:00Z');
const metadata = (index = 0) => ({ articles: [{ title: `Example report ${index}`, url: `https://example.org/report/${index}?utm_source=tracker`,
  seendate: '20261011T094500Z', language: 'English', sourcecountry: 'Belgium', socialimage: 'https://example.org/image.jpg', body: 'Do not retain article bodies' }] });
const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('scheduled GDELT batch uses exactly three fixed spaced queries and preserves honest indexing metadata', async () => {
  let at = START; const starts = [], urls = [], sleeps = [];
  const result = await generateGdeltSnapshot({ now: () => at, minGapMs: 0,
    sleepImpl: async (ms) => { sleeps.push(ms); at += ms; },
    fetchImpl: async (url, options) => { starts.push(at); urls.push(url); assert.equal(options.redirect, 'error'); at += 250; const body = metadata(urls.length); body.articles.push({ ...body.articles[0], url: body.articles[0].url.replace('tracker', 'duplicate') }); return json(body); } });
  assert.equal(result.status, 'generated');
  assert.equal(result.bytes.byteLength <= MAX_GDELT_SNAPSHOT_BYTES, true);
  assert.deepEqual(starts, [START, START + 6000, START + 12000]);
  assert.deepEqual(sleeps, [5750, 5750]);
  assert.deepEqual(urls, ['geopolitics', 'economy', 'disasters'].map((category) => gdeltQueryUrl({ category, country: '', countryName: '', q: '' })));
  assert.equal(result.snapshot.generatedAt, new Date(START + 12250).toISOString());
  for (const [category, value] of Object.entries(result.snapshot.categories)) {
    assert.equal(value.reports.length, 1); const report = value.reports[0];
    assert.equal(report.category, category); assert.equal(report.sourceId, 'gdelt');
    assert.equal(report.publishedAt, null); assert.equal(report.observedAt, null);
    assert.equal(report.indexedAt, '2026-10-11T09:45:00.000Z');
    assert.equal(report.retrievedAt, value.retrievedAt);
    assert.equal(report.url.includes('utm_source'), false);
    assert.equal('body' in report, false); assert.equal('socialimage' in report, false);
  }
});

test('GDELT rate limit skips all publication and never retries or continues the batch', async () => {
  let calls = 0;
  const result = await generateGdeltSnapshot({ now: () => START, fetchImpl: async () => { calls++; return new Response('Slow down', { status: 429 }); } });
  assert.equal(result.status, 'skipped'); assert.match(result.reason, /429/); assert.equal(calls, 1); assert.equal(result.bytes, undefined);
});

test('partial or oversized GDELT batches do not replace the prior local snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-gdelt-test-'));
  try {
    const prior = path.join(directory, GDELT_SNAPSHOT_ASSET); await writeFile(prior, 'previous validated snapshot');
    let at = START, calls = 0;
    const failed = await generateGdeltSnapshot({ now: () => at, sleepImpl: async (ms) => { at += ms; },
      fetchImpl: async () => { calls++; return calls === 1 ? json(metadata()) : json({ error: 'bad response' }); } });
    assert.equal(failed.status, 'skipped'); assert.equal(calls, 2);
    assert.equal(await writeGdeltSnapshot(directory, failed), false);
    assert.equal(await readFile(prior, 'utf8'), 'previous validated snapshot');
    const huge = await generateGdeltSnapshot({ now: () => START, fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) });
    assert.equal(huge.status, 'skipped'); assert.equal(await writeGdeltSnapshot(directory, huge), false);
    const excess = await generateGdeltSnapshot({ now: () => START, fetchImpl: async () => json({ articles: Array.from({ length: 81 }, () => metadata().articles[0]) }) });
    assert.equal(excess.status, 'skipped');
    assert.equal(await readFile(prior, 'utf8'), 'previous validated snapshot');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('complete empty discovery sample is valid and serializes exactly one bounded release asset', async () => {
  let at = START;
  const result = await generateGdeltSnapshot({ now: () => at, sleepImpl: async (ms) => { at += ms; }, fetchImpl: async () => json({ articles: [] }) });
  assert.equal(result.status, 'generated');
  assert.equal(Object.values(result.snapshot.categories).every((value) => value.reports.length === 0), true);
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-gdelt-test-'));
  try { const output = await writeGdeltSnapshot(directory, result); assert.equal(path.basename(output), GDELT_SNAPSHOT_ASSET); assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result.snapshot); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

const BATCH = '20261011094500';
function gkgRow(index = 0, { batch = BATCH, url = `https://example.org/gkg/${index}`, themes = 'ARMEDCONFLICT;ECON_INFLATION;NATURAL_DISASTER;', collection = '1' } = {}) {
  const fields = Array(27).fill(''); fields[0] = `${batch}-T${index + 1}`; fields[1] = batch; fields[2] = collection;
  fields[3] = 'example.org'; fields[4] = url; fields[7] = themes; fields[9] = '1#Belgium#BE##50.85#4.35#BE;';
  return fields.join('\t');
}
function zipFixture(text, batch = BATCH, { flags = 0, method = 8, name = `${batch}.gkg.csv`, sizeAdjustment = 0 } = {}) {
  const data = Buffer.from(text), compressed = method === 0 ? data : deflateRawSync(data), file = Buffer.from(name);
  let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length + sizeAdjustment, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length + sizeAdjustment, 24); central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + file.length, 12); end.writeUInt32LE(local.length + file.length + compressed.length, 16);
  return Buffer.concat([local, file, compressed, central, file, end]);
}
function descriptor(archive, batch = BATCH) { return { batch, size: archive.length, md5: createHash('md5').update(archive).digest('hex'), url: `https://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip` }; }
const manifest = (archive, batch = BATCH) => `${archive.length} ${descriptor(archive, batch).md5} http://data.gdeltproject.org/gdeltv2/${batch}.gkg.csv.zip\n`;

test('GKG generator downloads one fixed manifest/archive and retains only neutral topic metadata', async () => {
  const archive = zipFixture([gkgRow(), gkgRow(1, { collection: '2' }), gkgRow(2, { themes: 'UNREVIEWED_THEME;' })].join('\n') + '\n');
  const calls = [];
  const result = await generateGkgSnapshot({ previousSnapshot: null, now: () => START, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); return url === GKG_UPDATE_MANIFEST ? new Response(manifest(archive)) : new Response(archive);
  } });
  assert.equal(result.status, 'generated', result.reason); assert.deepEqual(calls, [GKG_UPDATE_MANIFEST, descriptor(archive).url]);
  assert.equal(result.snapshot.schemaVersion, 2); assert.equal(result.snapshot.kind, 'gkg-topic-sample');
  assert.equal(result.rows, 3); assert.equal(result.matchedRecords, 3); assert.equal(result.bytes.length <= MAX_GDELT_SNAPSHOT_BYTES, true);
  assert.deepEqual(result.snapshot.coverage.processedBatches, [{ id: BATCH, retrievedAt: new Date(START).toISOString(), rows: 3, matchedRecords: 3 }]);
  for (const entry of Object.values(result.snapshot.categories)) {
    assert.equal(entry.reports.length, 1); const report = entry.reports[0];
    assert.equal(report.kind, 'topic-mention'); assert.match(report.title, /^Topic mention · /); assert.equal(report.publishedAt, null); assert.equal(report.observedAt, null);
    assert.deepEqual(report.mentionedCountries, ['BE']); assert.equal(report.indexedAt, '2026-10-11T09:45:00.000Z');
    for (const key of ['body', 'image', 'lat', 'lon']) assert.equal(key in report, false);
  }
  assert.deepEqual(validateGdeltSnapshot(result.snapshot, START), result.snapshot);
});

test('GKG manifest rejects foreign/ambiguous, oversized, expired and future archives before fetching', () => {
  const archive = zipFixture(gkgRow()); const text = manifest(archive);
  assert.equal(parseGkgUpdateManifest(text, START).url.startsWith('https://'), true);
  for (const invalid of [text.replace('data.gdeltproject.org', 'example.org'), text + text,
    text.replace(String(archive.length), String(MAX_GKG_ZIP_BYTES + 1)), text.replace(BATCH, '20261009100000'),
    text.replace(BATCH, '20261012100000'), text.replace(BATCH, '20261011094700'), 'x'.repeat(16385)]) assert.throws(() => parseGkgUpdateManifest(invalid, START));
});

test('the observed forward-labelled manifest yields exact bounded diagnostics and keeps the existing five-minute admission boundary', () => {
  const row = '2386569 6f65cb2d4da7e95693960d9826bc34c7 http://data.gdeltproject.org/gdeltv2/20261012004500.gkg.csv.zip';
  const checkedAt = '2026-10-12T00:38:54.000Z';
  assert.throws(() => parseGkgUpdateManifest(row, Date.parse(checkedAt)), error => {
    assert.deepEqual(error.diagnostic, { schemaVersion: 1, code: 'manifest-batch-future', checkedAt, batch: '20261012004500', sizeBytes: 2386569,
      batchAt: '2026-10-12T00:45:00.000Z', batchDeltaMs: 366000, notBefore: '2026-10-12T00:40:00.000Z', retryAt: '2026-10-12T00:40:00.000Z' });
    assert.ok(Buffer.byteLength(JSON.stringify(error.diagnostic)) < 512); return true;
  });
  assert.throws(() => parseGkgUpdateManifest(row, Date.parse('2026-10-12T00:39:59.999Z')), error => error.diagnostic.code === 'manifest-batch-future');
  assert.equal(parseGkgUpdateManifest(row, Date.parse('2026-10-12T00:40:00.000Z')).batch, '20261012004500');
  for (const [text, code] of [[row.replace('2386569', String(MAX_GKG_ZIP_BYTES + 1)), 'manifest-archive-oversized'],
    [row.replace('20261012004500', '20261010004500'), 'manifest-batch-expired'], [row.replace('20261012004500', '20261012004700'), 'manifest-batch-invalid'],
    [row.replace('data.gdeltproject.org', 'evil.example'), 'manifest-source-mismatch'], [row + '\n' + row, 'manifest-gkg-ambiguous'],
    ['No GKG row', 'manifest-gkg-missing'], ['x'.repeat(16385), 'manifest-byte-budget']]) {
    assert.throws(() => parseGkgUpdateManifest(text, Date.parse(checkedAt)), error => {
      assert.equal(error.diagnostic.code, code); assert.equal(error.diagnostic.checkedAt, checkedAt);
      assert.ok(!JSON.stringify(error.diagnostic).includes('evil.example')); return true;
    });
  }
});

test('rejected complete manifests retain their original check UTC and last-good facts; future-only recovery may probe one missing prior slot', async () => {
  const previousBatch = '20261011233000', previousAt = Date.parse('2026-10-11T23:40:00.000Z'), archive = zipFixture(gkgRow(0, { batch: previousBatch }), previousBatch);
  const prior = await generateGkgSnapshot({ previousSnapshot: null, now: () => previousAt,
    fetchImpl: async url => url === GKG_UPDATE_MANIFEST ? new Response(manifest(archive, previousBatch)) : new Response(archive) });
  assert.equal(prior.status, 'generated', prior.reason); const before = JSON.stringify(prior.snapshot);
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-gkg-diagnostic-'));
  try {
    await writeGdeltSnapshot(directory, prior); const sourcePath = path.join(directory, GDELT_SNAPSHOT_ASSET), originalBytes = await readFile(sourcePath);
    for (const [text, code] of [
      ['2386569 6f65cb2d4da7e95693960d9826bc34c7 http://data.gdeltproject.org/gdeltv2/20261012004500.gkg.csv.zip', 'manifest-batch-future'],
      [`${MAX_GKG_ZIP_BYTES + 1} ${'a'.repeat(32)} http://data.gdeltproject.org/gdeltv2/20261012003000.gkg.csv.zip`, 'manifest-archive-oversized'],
      [`123 ${'a'.repeat(32)} http://data.gdeltproject.org/gdeltv2/20261010003000.gkg.csv.zip`, 'manifest-batch-expired'],
      ['invalid complete source manifest', 'manifest-gkg-missing'],
    ]) {
      let at = Date.parse('2026-10-12T00:38:54.000Z'), calls = 0;
      const failed = await generateGkgSnapshot({ previousSnapshot: prior.snapshot, now: () => at, repairEnabled: true, fetchImpl: async (url, options) => {
        calls++; at += 200;
        if(url === GKG_UPDATE_MANIFEST) return new Response(text);
        assert.equal(code,'manifest-batch-future');assert.equal(options.method,'HEAD');
        assert.equal(url,'https://data.gdeltproject.org/gdeltv2/20261012003000.gkg.csv.zip');
        return new Response(null,{status:404});
      } });
      assert.equal(failed.status, 'skipped'); assert.equal(failed.code, 'invalid-response', 'Existing reader/backoff code remains compatible');
      assert.equal(failed.checkedAt, '2026-10-12T00:38:54.200Z'); assert.equal(failed.manifestCheckedAt, failed.checkedAt);
      assert.equal(failed.diagnostic.checkedAt, failed.checkedAt); assert.equal(failed.diagnostic.code, code); assert.equal(calls, code === 'manifest-batch-future' ? 2 : 1);
      assert.equal(failed.snapshot, undefined); assert.equal(failed.bytes, undefined); assert.equal(failed.retryAfterMs, undefined, 'Retry diagnostics do not change scheduling policy');
      assert.equal(await writeGdeltSnapshot(directory, failed), false); assert.deepEqual(await readFile(sourcePath), originalBytes);
      assert.equal(JSON.stringify(prior.snapshot), before, 'Generation, retrieval and factual coverage stay unchanged');
    }
    const oversized = await generateGkgSnapshot({ previousSnapshot: prior.snapshot, now: () => START, fetchImpl: async url => {
      assert.equal(url, GKG_UPDATE_MANIFEST); return new Response('x'.repeat(16385));
    } });
    assert.equal(oversized.diagnostic.code, 'manifest-byte-budget'); assert.equal(oversized.manifestCheckedAt, null);
    assert.equal(oversized.checkedAt, null, 'A body rejected before completion cannot claim a completed manifest check');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GKG ZIP rejects encryption, paths, extra entries/trailing bytes and verifies MD5/CRC/inflation limits', async () => {
  const archive = zipFixture(gkgRow()); const stamp = new Date(START).toISOString();
  assert.equal(inspectGkgZip(archive, BATCH).method, 8);
  assert.throws(() => inspectGkgZip(zipFixture(gkgRow(), BATCH, { flags: 1 }), BATCH));
  assert.throws(() => inspectGkgZip(zipFixture(gkgRow(), BATCH, { name: `../${BATCH}.gkg.csv` }), BATCH));
  assert.throws(() => inspectGkgZip(Buffer.concat([archive, Buffer.from('trailing')]), BATCH));
  const extraEntry = Buffer.from(archive); extraEntry.writeUInt16LE(2, archive.length - 22 + 8); extraEntry.writeUInt16LE(2, archive.length - 22 + 10); assert.throws(() => inspectGkgZip(extraEntry, BATCH));
  await assert.rejects(readGkgArchive(archive, { ...descriptor(archive), md5: '0'.repeat(32) }, { retrievedAt: stamp }), /MD5/);
  const stored = zipFixture(gkgRow(), BATCH, { method: 0 }); stored[30 + `${BATCH}.gkg.csv`.length + 5] ^= 1;
  await assert.rejects(readGkgArchive(stored, descriptor(stored), { retrievedAt: stamp }), /CRC|batch identity/);
  const inflated = zipFixture(gkgRow(), BATCH, { sizeAdjustment: -1 });
  await assert.rejects(readGkgArchive(inflated, descriptor(inflated), { retrievedAt: stamp }), /inflation/);
  const huge = zipFixture('x'.repeat(524289)); await assert.rejects(readGkgArchive(huge, descriptor(huge), { retrievedAt: stamp }), /row exceeds|length/);
  const unicode = zipFixture(gkgRow() + 'é'.repeat(262145));
  await assert.rejects(readGkgArchive(unicode, descriptor(unicode), { retrievedAt: stamp }), /byte length|byte limit/);
  const malformed = zipFixture('not\t27\tfields\n'); await assert.rejects(readGkgArchive(malformed, descriptor(malformed), { retrievedAt: stamp }), /Unexpected GKG/);
});

test('GKG merges a validated prior batch with exact gaps and skips a repeated latest archive', async () => {
  const previousBatch = '20261011091500'; const priorArchive = zipFixture(gkgRow(0, { batch: previousBatch }), previousBatch);
  const previous = await generateGkgSnapshot({ previousSnapshot: null, now: () => START - 1200000, fetchImpl: async (url) => url === GKG_UPDATE_MANIFEST ? new Response(manifest(priorArchive, previousBatch)) : new Response(priorArchive) });
  assert.equal(previous.status, 'generated', previous.reason);
  const archive = zipFixture(gkgRow(1)), urls = [];
  const result = await generateGkgSnapshot({ now: () => START, fetchImpl: async (url) => {
    urls.push(url); return url === GDELT_SNAPSHOT_URL ? json(previous.snapshot) : url === GKG_UPDATE_MANIFEST ? new Response(manifest(archive)) : new Response(archive);
  } });
  assert.equal(result.status, 'generated', result.reason); assert.deepEqual(urls, [GDELT_SNAPSHOT_URL, GKG_UPDATE_MANIFEST, descriptor(archive).url]);
  assert.deepEqual(result.snapshot.coverage.sampleGaps, ['20261011093000']); assert.equal(result.snapshot.categories.economy.reports.length, 2);
  let calls = 0;
  const repeated = await generateGkgSnapshot({ previousSnapshot: result.snapshot, now: () => START, fetchImpl: async () => { calls++; return new Response(manifest(archive)); } });
  assert.equal(repeated.status, 'skipped'); assert.match(repeated.reason, /already processed/); assert.equal(calls, 1);
});

test('a failed or malformed GKG batch preserves prior bytes and never retries DocAPI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'earth-gkg-test-'));
  try {
    const output = path.join(directory, GDELT_SNAPSHOT_ASSET); await writeFile(output, 'last good'); let calls = 0;
    const failed = await generateGkgSnapshot({ previousSnapshot: null, now: () => START, fetchImpl: async (url) => {
      calls++; assert.equal(url, GKG_UPDATE_MANIFEST); return new Response('Unavailable', { status: 429 });
    } });
    assert.equal(failed.status, 'skipped'); assert.match(failed.reason, /429/); assert.equal(calls, 1);
    assert.equal(await writeGdeltSnapshot(directory, failed), false); assert.equal(await readFile(output, 'utf8'), 'last good');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GKG candidate memory is bounded while all rows and matched records remain explicitly counted', async () => {
  const lines = Array.from({ length: 4000 }, (_, i) => gkgRow(i)).join('\n') + '\n', archive = zipFixture(lines);
  const parsed = await readGkgArchive(archive, descriptor(archive), { retrievedAt: new Date(START).toISOString() });
  assert.equal(parsed.rows, 4000); assert.equal(parsed.matchedRecords, 12000); assert.equal(parsed.reports.length, 10000);
});

test('GKG row and declared inflation caps fail the entire sample rather than silently truncating it', async () => {
  const archive = zipFixture((gkgRow(0, { collection: '2' }) + '\n').repeat(50001));
  await assert.rejects(readGkgArchive(archive, descriptor(archive), { retrievedAt: new Date(START).toISOString() }), /row count/);
  const oversized = zipFixture(gkgRow()); const central = oversized.readUInt32LE(oversized.length - 22 + 16);
  oversized.writeUInt32LE(128 * 1024 * 1024 + 1, central + 24);
  assert.throws(() => inspectGkgZip(oversized, BATCH), /contract/);
});
