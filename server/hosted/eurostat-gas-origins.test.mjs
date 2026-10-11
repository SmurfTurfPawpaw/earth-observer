import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EUROSTAT_GAS_PLUGIN, collectEurostatGasOrigins, createEurostatGasCollector, eurostatGasItems } from './eurostat-gas-origins.js';
import { decodeEurostatGasOrigins, canonicalEurostatGasFacts, createEurostatGasDossier, EUROSTAT_GAS_URL } from '../../src/core/eurostat-gas-origins.js';
import { pluginFactsDigest, pluginBytesDigest, pluginJson } from '../../src/core/plugin-evidence.js';

// Actual bounded anonymous Eurostat response acquired 12 October 2026 from EUROSTAT_GAS_URL.
// Source: Eurostat nrg_ti_gas; tests make no provider requests.
const original = new Uint8Array(await readFile(new URL('./fixtures/eurostat-gas-belgium-2024.json', import.meta.url)));
const payload = () => JSON.parse(new TextDecoder().decode(original));
const NOW = Date.parse('2026-10-12T00:00:00.000Z'), now = () => NOW;
const encoded = value => new TextEncoder().encode(JSON.stringify(value));
const response = (bytes = original, headers = {}) => new Response(bytes, { headers: { 'content-type': 'application/json', ...headers } });
const capture = (value, options = {}) => collectEurostatGasOrigins({ now, ...options, fetchImpl: async () => response(value) });
const offset = (body, partner) => body.dimension.partner.category.index[partner];

test('actual annual Belgium response retains original bytes, one typed item, source clocks and supported cited denominator shares', async () => {
  let requests = 0;
  const value = await collectEurostatGasOrigins({ now, fetchImpl: async (url, options) => {
    requests++; assert.equal(url, EUROSTAT_GAS_URL); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Accept, 'application/json'); assert.equal(options.headers['If-None-Match'], undefined); return response();
  } });
  assert.equal(requests, 1); assert.equal(value.pluginId, EUROSTAT_GAS_PLUGIN.pluginId); assert.equal(value.kind, 'dataset');
  assert.equal(EUROSTAT_GAS_PLUGIN.schemaVersion, 1); assert.equal(EUROSTAT_GAS_PLUGIN.sourceId, 'eurostat');
  assert.equal(EUROSTAT_GAS_PLUGIN.cadenceMs, 21_600_000); assert.equal(EUROSTAT_GAS_PLUGIN.deadlineMs, 20_000);
  assert.equal(EUROSTAT_GAS_PLUGIN.maxResponseBytes, 524_288); assert.equal(EUROSTAT_GAS_PLUGIN.maxArtifactBytes, 65_536);
  assert.equal(value.checkedAt, new Date(NOW).toISOString()); assert.equal(value.sourceUpdatedAt, '2026-10-09T21:00:00.000Z');
  assert.equal(value.sourceVersion, '45.0'); assert.deepEqual(value.raw.bytes, original); assert.equal(value.raw.sha256, await pluginBytesDigest(original));
  assert.equal(value.factsDigest, await pluginFactsDigest(value.canonicalFacts));
  const item = eurostatGasItems(value.canonicalFacts)[0]; assert.equal(item.kind, 'statistical-dataset'); assert.equal(item.publishedAt, null);
  const { itemId: _id, sourceRevision: _revision, ...content } = item;
  assert.equal(item.sourceRevision, await pluginFactsDigest(content));
  assert.equal(item.canonicalFacts.cells.length, 167); assert.deepEqual(value.artifact.referenceYears, ['2024']);
  assert.equal(value.artifact.unit.code, 'TJ_GCV'); assert.equal(value.artifact.resource.code, 'G3000');
  const year = value.artifact.years[0]; assert.equal(year.total.value, 740439.9); assert.equal(year.total.valueLocator, '/value/165');
  assert.equal(year.period.from, '2024-01-01T00:00:00.000Z'); assert.equal(year.period.until, '2025-01-01T00:00:00.000Z');
  assert.equal(year.coverage.reconciled, true); assert.equal(year.coverage.completeReportedBreakdown, true); assert.equal(year.coverage.missingRows, 0);
  assert.equal(year.shares[0].partner.code, 'NO'); assert.equal(year.shares[0].quantity, 245893.2);
  assert.equal(year.shares[0].sharePercent, 100 * 245893.2 / 740439.9);
  const source = payload();
  for (const share of year.shares) {
    assert.equal(source.value[share.valueLocator.split('/').at(-1)], share.quantity);
    assert.equal(source.value[share.denominatorLocator.split('/').at(-1)], year.total.value);
  }
  assert.equal(year.shares.find(share => share.partner.code === 'UK').partner.iso2, 'GB');
  assert.ok(new TextEncoder().encode(pluginJson(value.artifact)).byteLength <= 64 * 1024);
});

test('BOM/newlines and global update clocks change raw provenance but never statistical identity; cell, flag and label changes do', async () => {
  const first = await capture(original), wrapped = new Uint8Array(original.length + 5);
  wrapped.set([239, 187, 191]); wrapped.set(original, 3); wrapped.set([13, 10], original.length + 3);
  const bom = await capture(wrapped); assert.deepEqual(bom.raw.bytes, wrapped); assert.notEqual(bom.raw.sha256, first.raw.sha256);
  assert.equal(bom.factsDigest, first.factsDigest);
  const clock = payload(); clock.updated = '2026-10-10T23:00:00+0200';
  const newer = await capture(encoded(clock)); assert.notEqual(newer.raw.sha256, first.raw.sha256);
  assert.equal(newer.factsDigest, first.factsDigest); assert.equal(newer.sourceUpdatedAt, '2026-10-10T21:00:00.000Z');
  const structure = payload(); structure.extension.datastructure.version = '46.0'; structure.extension.version = '2.0';
  const metadataOnly = await capture(encoded(structure)); assert.equal(metadataOnly.sourceVersion, '46.0');
  assert.equal(metadataOnly.factsDigest, first.factsDigest); assert.equal(metadataOnly.canonicalFacts.items[0].canonicalFacts.sourceStructure.version, undefined);
  for (const mutate of [body => { body.value[offset(body, 'NO')] += 1; },
    body => { body.status = { [offset(body, 'NO')]: 'p' }; }, body => { body.dimension.partner.category.label.NO += ' revised label'; }]) {
    const changed = payload(); mutate(changed); const next = await capture(encoded(changed));
    assert.notEqual(next.factsDigest, first.factsDigest); assert.notEqual(next.canonicalFacts.items[0].sourceRevision, first.canonicalFacts.items[0].sourceRevision);
  }
});

test('dimension/category reordering and dense values preserve facts while source cell locators follow actual layout', async () => {
  const source = payload(), originalCapture = await capture(original), reordered = payload();
  const previous = new Map(source.dimension.partner.category.index ? Object.keys(source.dimension.partner.category.index)
    .map(code => [code, source.value[offset(source, code)]]) : []);
  const codes = Object.keys(source.dimension.partner.category.index).sort((a, b) => offset(source, b) - offset(source, a));
  reordered.dimension.partner.category.index = codes;
  reordered.id.reverse(); reordered.size.reverse(); reordered.value = codes.map(code => previous.get(code));
  const next = await capture(encoded(reordered)); assert.equal(next.factsDigest, originalCapture.factsDigest);
  const no = next.artifact.years[0].shares.find(share => share.partner.code === 'NO');
  assert.equal(reordered.value[Number(no.valueLocator.split('/').at(-1))], no.quantity);
  assert.notEqual(no.valueLocator, originalCapture.artifact.years[0].shares[0].valueLocator);
});

test('missing and suppressed observations remain explicit; ratios require positive unflagged TOTAL and never add LNG or mix units', async () => {
  const missing = payload(); delete missing.value[offset(missing, 'NO')]; missing.status = { [offset(missing, 'NO')]: 'c' };
  const observed = await capture(encoded(missing)), year = observed.artifact.years[0];
  const no = observed.canonicalFacts.items[0].canonicalFacts.cells.find(cell => cell.partner === 'NO');
  assert.equal(no.value, null); assert.equal(no.status, 'c'); assert.equal(year.coverage.missingRows, 1); assert.equal(year.coverage.reconciled, null);
  assert.equal(year.shares.some(share => share.partner.code === 'NO'), false); assert.equal(year.missing[0].code, 'NO');
  const flagged = payload(); flagged.status = 'e'; const estimate = await capture(encoded(flagged));
  assert.equal(estimate.artifact.years[0].total.status, 'e'); assert.ok(estimate.artifact.years[0].shares.every(share => share.sharePercent === null));
  const zero = payload(); zero.value[offset(zero, 'TOTAL')] = 0;
  assert.ok((await capture(encoded(zero))).artifact.years[0].shares.every(share => share.sharePercent === null));
  const absent = payload(); delete absent.value[offset(absent, 'TOTAL')];
  assert.ok((await capture(encoded(absent))).artifact.years[0].shares.every(share => share.sharePercent === null));
  for (const [dimension, code] of [['unit', 'MIO_M3'], ['siec', 'G3100'], ['geo', 'FR']]) {
    const wrong = payload(); wrong.dimension[dimension].category.index = { [code]: 0 }; wrong.dimension[dimension].category.label = { [code]: code };
    await assert.rejects(capture(encoded(wrong)), { code: 'source_invalid_dataset' });
  }
});

test('negative observations remain raw evidence but cannot support a complete or above-100-percent origin breakdown', async () => {
  const source = payload(), old = source.value[offset(source, 'DE')];
  source.value[offset(source, 'DE')] = -100; source.value[offset(source, 'NO')] += old + 100;
  const next = await capture(encoded(source)), year = next.artifact.years[0];
  assert.equal(year.coverage.negativeRows, 1); assert.equal(year.coverage.reconciled, true);
  assert.equal(year.coverage.completeReportedBreakdown, false);
  assert.equal(next.canonicalFacts.items[0].canonicalFacts.cells.find(cell => cell.partner === 'DE').value, -100);
  assert.ok(year.shares.every(share => share.sharePercent === null && share.shareUnavailableReason === 'Negative import observations require review'));
});

test('conditional requests require a known baseline; malformed validators never become request headers', async () => {
  const initial = await capture(original), previous = { validators: { etag: '"reported-version"', lastModified: null }, factsDigest: initial.factsDigest };
  const unchanged = await collectEurostatGasOrigins({ now, previous, fetchImpl: async (url, options) => {
    assert.equal(url, EUROSTAT_GAS_URL); assert.equal(options.headers['If-None-Match'], '"reported-version"'); return new Response(null, { status: 304 });
  } });
  assert.equal(unchanged.outcome, 'not-modified'); assert.equal(unchanged.factsDigest, initial.factsDigest); assert.equal(unchanged.raw, null);
  assert.equal(unchanged.canonicalFacts, null); assert.equal(unchanged.artifact, null);
  assert.equal(unchanged.validators.etag, '"reported-version"');
  await assert.rejects(collectEurostatGasOrigins({ now, fetchImpl: async () => new Response(null, { status: 304 }) }), { code: 'source_not_modified_without_baseline' });
  await collectEurostatGasOrigins({ now, previous: { validators: { etag: 'unquoted\r\nheader', lastModified: '<script>' } }, fetchImpl: async (_url, options) => {
    assert.equal(options.headers['If-None-Match'], undefined); assert.equal(options.headers['If-Modified-Since'], undefined); return response();
  } });
});

test('a changed HTTP200 without validators clears the old ETag so A/B/A cannot falsely preserve B on a 304', async () => {
  const initial = await capture(original), changed = payload(); changed.value[offset(changed, 'NO')] += 1;
  const second = await collectEurostatGasOrigins({ now,
    previous: { factsDigest: initial.factsDigest, validators: { etag: '"version-A"', lastModified: 'Fri, 09 Oct 2026 21:00:00 GMT' } },
    fetchImpl: async (_url, options) => { assert.equal(options.headers['If-None-Match'], '"version-A"'); return response(encoded(changed)); } });
  assert.notEqual(second.factsDigest, initial.factsDigest); assert.deepEqual(second.validators, { etag: null, lastModified: null });
  const returnedA = await collectEurostatGasOrigins({ now, previous: second, fetchImpl: async (_url, options) => {
    assert.equal(options.headers['If-None-Match'], undefined); assert.equal(options.headers['If-Modified-Since'], undefined); return response();
  } });
  assert.equal(returnedA.factsDigest, initial.factsDigest);
  await assert.rejects(collectEurostatGasOrigins({ now, previous: second, fetchImpl: async () => new Response(null, { status: 304 }) }),
    { code: 'source_not_modified_without_baseline' });
});

test('provider failures, invalid encoding/schema and size caps return safe errors without accepting invented data', async () => {
  await assert.rejects(collectEurostatGasOrigins({ now, fetchImpl: async () => new Response('untrusted source instructions', { status: 429, headers: { 'retry-after': '120' } }) }),
    error => error.code === 'source_limit' && error.retryAfterMs === 120_000 && !error.message.includes('instructions'));
  await assert.rejects(capture(new Uint8Array([255])), { code: 'source_invalid_json' });
  await assert.rejects(capture(encoded({ warning: { status: 413, label: 'ASYNCHRONOUS_RESPONSE' } })), { code: 'source_invalid_dataset' });
  await assert.rejects(capture(new Uint8Array(EUROSTAT_GAS_PLUGIN.maxResponseBytes + 1)), { code: 'source_response_limit' });
  const malformed = payload(); malformed.dimension.partner.category.index.NO = malformed.dimension.partner.category.index.RU;
  await assert.rejects(capture(encoded(malformed)), { code: 'source_invalid_dataset' });
  const future = payload(); future.updated = '2026-10-13T00:00:00Z'; await assert.rejects(capture(encoded(future)), { code: 'source_invalid_dataset' });
  for (const timestamp of ['2026-02-30T00:00:00Z', '2026-09-30T24:00:00+0200', '2026-10-09T21:00:00+2360']) {
    const invalid = payload(); invalid.updated = timestamp; await assert.rejects(capture(encoded(invalid)), { code: 'source_invalid_dataset' });
  }
});

test('fetch/body deadlines and cancellation finish with no acquisition on pre-cancelled input', async () => {
  const collect = createEurostatGasCollector({ timeoutMs: 20 }), stopped = new AbortController(); stopped.abort(); let requests = 0;
  await assert.rejects(collect({ now, signal: stopped.signal, fetchImpl() { requests++; } }), { name: 'AbortError' }); assert.equal(requests, 0);
  await assert.rejects(collect({ now, fetchImpl() { requests++; return new Promise(() => {}); } }), { code: 'source_deadline' });
  assert.equal(requests, 1);
  await assert.rejects(collect({ now, fetchImpl: async () => response(new ReadableStream({ pull() { return new Promise(() => {}); } })) }), { code: 'source_deadline' });
});

test('a multi-year cube respects JSON-stat strides and keeps each numerator tied to its own annual total', async () => {
  const source = payload(), cube = payload(), yearDimension = cube.id.indexOf('time');
  cube.size[yearDimension] = 2; cube.dimension.time.category.index = { '2024': 0, '2025': 1 }; cube.dimension.time.category.label = { '2024': '2024', '2025': '2025' };
  cube.value = {};
  for (const code of Object.keys(source.dimension.partner.category.index)) {
    const old = offset(source, code), value = source.value[old]; cube.value[old * 2] = value; cube.value[old * 2 + 1] = value * 2;
  }
  const decoded = decodeEurostatGasOrigins(cube), canonical = await canonicalEurostatGasFacts(decoded.cube);
  const artifact = createEurostatGasDossier(canonical, decoded.locators, { rawSha256: await pluginBytesDigest(encoded(cube)),
    factsDigest: await pluginFactsDigest(canonical), sourceUpdatedAt: '2026-10-09T21:00:00.000Z', sourceVersion: '45.0' });
  assert.deepEqual(artifact.referenceYears, ['2024', '2025']); assert.equal(artifact.years[1].total.value, source.value[offset(source, 'TOTAL')] * 2);
  for (const year of artifact.years) {
    assert.equal(year.coverage.reconciled, true);
    for (const share of year.shares) assert.equal(share.sharePercent, 100 * share.quantity / cube.value[share.denominatorLocator.split('/').at(-1)]);
  }
});
