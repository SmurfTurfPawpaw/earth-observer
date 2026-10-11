import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateGdeltSnapshot, writeGdeltSnapshot, GDELT_SNAPSHOT_ASSET, MAX_GDELT_SNAPSHOT_BYTES } from '../../scripts/gdelt-snapshot.mjs';
import { gdeltQueryUrl } from './gdelt-query.js';

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
