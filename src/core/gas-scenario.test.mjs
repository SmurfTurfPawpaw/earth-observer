import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGasExposureScenario, GAS_SCENARIO_METHOD } from './gas-scenario.js';
import { decodeEurostatGasOrigins, canonicalEurostatGasFacts, createEurostatGasDossier,
  EUROSTAT_GAS_URL, EUROSTAT_GAS_SCOPE_ID } from './eurostat-gas-origins.js';
import { pluginBytesDigest, pluginFactsDigest } from './plugin-evidence.js';

// The same actual bounded annual response used by the adapter's source-contract tests.
// No provider requests, database writes or model calls occur in this suite.
const raw = new Uint8Array(await readFile(new URL('../../server/hosted/fixtures/eurostat-gas-belgium-2024.json', import.meta.url)));
const payload = JSON.parse(new TextDecoder().decode(raw));
const decoded = decodeEurostatGasOrigins(payload), facts = await canonicalEurostatGasFacts(decoded.cube);
const source = { rawSha256: await pluginBytesDigest(raw), factsDigest: await pluginFactsDigest(facts),
  sourceUpdatedAt: new Date(payload.updated).toISOString(), sourceVersion: decoded.sourceVersion };
const artifact = createEurostatGasDossier(facts, decoded.locators, source);
const original = { schemaVersion: 1, available: true, configured: true,
  plugin: { id: 'eurostat-gas-origins-v1', scopeId: EUROSTAT_GAS_SCOPE_ID, kind: 'dataset', sourceUrl: EUROSTAT_GAS_URL },
  receipt: { id: `receipt:${'a'.repeat(64)}`, capturedAt: '2026-10-12T00:00:00.000Z', recordedAt: '2026-10-12T00:01:00.000Z',
    factsDigest: source.factsDigest, rawSha256: source.rawSha256, artifactSha256: await pluginFactsDigest(artifact),
    sourceUpdatedAt: source.sourceUpdatedAt, sourceVersion: source.sourceVersion }, artifact };
const options = { year: '2024', originCode: 'NO', reductionPercent: 25, replacementPercent: 40 };
const clone = value => JSON.parse(JSON.stringify(value));
const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-12), `${actual} ≈ ${expected}`);
async function revised(mutate) {
  const value = clone(original); mutate(value.artifact);
  value.receipt.artifactSha256 = await pluginFactsDigest(value.artifact);
  return value;
}
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

test('actual Norway annual volume yields cited hypothetical quantities without changing source data', async () => {
  const input = freeze(clone(original)), before = JSON.stringify(input);
  const result = await createGasExposureScenario(input, freeze(clone(options)));
  assert.equal(result.schemaVersion, 1); assert.equal(result.kind, 'conditional-gas-exposure');
  assert.equal(result.methodId, GAS_SCENARIO_METHOD); assert.equal(result.temporalMeaning, 'reference-year-counterfactual');
  assert.equal(result.baseline.referenceYear, '2024'); assert.equal(result.baseline.unit.code, 'TJ_GCV');
  assert.equal(result.baseline.originVolume, 245893.2); assert.equal(result.baseline.reportedTotal, 740439.9);
  approximately(result.result.lostOriginVolume, 61473.3);
  approximately(result.result.replacementVolume, 24589.32);
  approximately(result.result.residualGapVolume, 36883.98);
  approximately(result.result.residualGapPercentOfReportedTotal, 100 * 36883.98 / 740439.9);
  assert.equal(result.assumptions.replacementPercentOfLostVolume, 40);
  assert.equal(result.provenance.receiptId, input.receipt.id);
  assert.equal(result.provenance.inputRevision, input.artifact.inputRevision);
  assert.equal(result.provenance.rawSha256, input.receipt.rawSha256);
  assert.equal(result.provenance.artifactSha256, input.receipt.artifactSha256);
  assert.equal(result.provenance.locators.originValue, input.artifact.years[0].shares.find(row => row.partner.code === 'NO').valueLocator);
  assert.equal(result.provenance.locators.reportedTotal, '/value/165');
  assert.deepEqual(result.baseline.period, { from: '2024-01-01T00:00:00.000Z', until: '2025-01-01T00:00:00.000Z', meaning: 'calendar-year' });
  assert.equal(JSON.stringify(input), before);
  assert.match(result.limitations, /Hypothetical/); assert.match(result.limitations, /Replacement is an assumption/);
  assert.match(result.limitations, /not current supply/); assert.match(result.limitations, /price prediction/);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength < 8192);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('zero reduction, zero replacement and full replacement have their literal volume meanings', async () => {
  for (const [reductionPercent, replacementPercent] of [[0, 0], [0, 100], [100, 0], [100, 100], [-0, -0]]) {
    const result = await createGasExposureScenario(original, { ...options, reductionPercent, replacementPercent });
    const lost = result.baseline.originVolume * (reductionPercent / 100);
    approximately(result.result.lostOriginVolume, lost);
    approximately(result.result.replacementVolume, lost * replacementPercent / 100);
    approximately(result.result.residualGapVolume, lost * (1 - replacementPercent / 100));
    for (const value of Object.values(result.result)) assert.ok(value >= 0 && Number.isFinite(value) && !Object.is(value, -0));
    if (replacementPercent === 100 || reductionPercent === 0) assert.equal(result.result.residualGapVolume, 0);
  }
});

test('small finite percentages stay unrounded; replacement refers to loss rather than annual TOTAL', async () => {
  const result = await createGasExposureScenario(original, { ...options, reductionPercent: 0.0001, replacementPercent: 99.999 });
  assert.ok(result.result.residualGapVolume > 0 && result.result.residualGapVolume < 0.00001);
  approximately(result.result.lostOriginVolume, result.baseline.originVolume * 0.000001);
  assert.ok(result.result.replacementVolume < result.result.lostOriginVolume);
  const full = await createGasExposureScenario(original, { ...options, reductionPercent: 25, replacementPercent: 100 });
  assert.equal(full.result.replacementVolume, full.result.lostOriginVolume);
  assert.notEqual(full.result.replacementVolume, full.baseline.reportedTotal);
});

test('assumptions are bounded numeric percentages and exactly one source country, with no implicit multi-origin aggregation', async () => {
  const bad = [null, { ...options, year: 2024 }, { ...options, year: '2024-Q1' }, { ...options, originCode: ['NO', 'UK'] },
    { ...options, originCode: 'NSP' }, { ...options, originCode: 'TOTAL' }, { ...options, originCode: 'no' },
    { ...options, originCodes: ['NO', 'UK'] }, { year: '2024', originCode: 'NO', reductionPercent: 25 }];
  for (const key of ['reductionPercent', 'replacementPercent']) for (const value of [-1, 101, '25', null, true, NaN, Infinity, -Infinity])
    bad.push({ ...options, [key]: value });
  for (const value of bad) await assert.rejects(createGasExposureScenario(original, value), { code: 'gas_scenario_invalid_assumptions' });
});

test('unavailable scope, mismatched receipts and modified artifacts fail before calculation', async () => {
  const mutations = [value => { value.available = false; }, value => { value.configured = false; }, value => { value.receipt = null; },
    value => { value.plugin.id = 'ecb-press-v1'; }, value => { value.plugin.kind = 'publication-feed'; },
    value => { value.plugin.sourceUrl += '&geo=FR'; }, value => { value.receipt.id = 'receipt:unverified'; },
    value => { value.receipt.recordedAt = '2026-10-12'; }, value => { value.receipt.factsDigest = 'b'.repeat(64); },
    value => { value.receipt.rawSha256 = 'b'.repeat(64); }, value => { value.receipt.artifactSha256 = 'b'.repeat(64); },
    value => { value.receipt.sourceVersion = 'changed'; }, value => { value.artifact.title += ' changed'; },
    value => { value.artifact.inputRevision = 'not-a-revision'; }];
  for (const mutate of mutations) { const value = clone(original); mutate(value);
    await assert.rejects(createGasExposureScenario(value, options), { code: 'gas_scenario_unavailable' }); }
});

test('missing, flagged, negative and inconsistent annual coverage cannot yield an exposure scenario', async () => {
  const mutations = [artifact => { artifact.years[0].coverage.missingRows = 1; },
    artifact => { artifact.years[0].coverage.flaggedRows = 1; }, artifact => { artifact.years[0].coverage.negativeRows = 1; },
    artifact => { artifact.years[0].coverage.completeReportedBreakdown = false; }, artifact => { artifact.years[0].coverage.reconciled = null; },
    artifact => { artifact.years[0].coverage.reportedSum += 100; }, artifact => { artifact.years[0].coverage.totalDifference = 5; },
    artifact => { artifact.years[0].coverage.reconciliationTolerance = 100; }, artifact => { artifact.years[0].coverage.zeroRows++; },
    artifact => { artifact.years[0].total.value = null; }, artifact => { artifact.years[0].total.value = 0; },
    artifact => { artifact.years[0].total.value = -1; }, artifact => { artifact.years[0].total.status = 'p'; },
    artifact => { artifact.years[0].shares[0].quantity = -1; }, artifact => { artifact.years[0].shares[0].quantity = 1e12 + 1; },
    artifact => { artifact.years[0].shares[0].status = 'c'; }, artifact => { artifact.years[0].shares[0].sharePercent = null; },
    artifact => { artifact.years[0].shares[0].sharePercent += 1; }, artifact => { artifact.years[0].shares[0].denominatorLocator = '/value/10'; },
    artifact => { artifact.years[0].shares[0].valueLocator = '/value/2048'; }, artifact => { artifact.years[0].omittedShareRows++; },
    artifact => { artifact.years[0].shares.push(clone(artifact.years[0].shares[0])); }];
  for (const mutate of mutations) await assert.rejects(createGasExposureScenario(await revised(mutate), options), { code: 'gas_scenario_unavailable' });
});

test('units, reference periods, omitted rows and country aliases are admitted semantically, not by title', async () => {
  for (const mutate of [artifact => { artifact.unit.code = 'MIO_M3'; }, artifact => { artifact.unit.basis = 'net-calorific-value'; },
    artifact => { artifact.resource.code = 'G3100'; }, artifact => { artifact.reportingCountry.code = 'FR'; },
    artifact => { artifact.years[0].period.until = '2024-12-31T00:00:00.000Z'; },
    artifact => { artifact.years[0].period.meaning = 'forecast-year'; }, artifact => { artifact.referenceYears = ['2025']; },
    artifact => { artifact.latestAvailableYear = '2026'; },
    artifact => { artifact.years[0].year = '2023'; artifact.referenceYears = ['2023']; artifact.latestAvailableYear = '2023'; },
    artifact => { artifact.years[0].shares.find(row => row.partner.code === 'UK').partner.iso2 = 'UK'; },
    artifact => { const row = artifact.years[0].shares.find(row => row.partner.code !== 'UK');
      row.partner = { code: 'GB', label: 'United Kingdom alias', type: 'reported-country-or-territory', entityId: 'eurostat:partner:GB' }; },
    artifact => { artifact.years[0].shares[0].partner = { code: 'EU', label: 'Overlapping aggregate', type: 'reported-country-or-territory', entityId: 'eurostat:partner:EU' }; }])
    await assert.rejects(createGasExposureScenario(await revised(mutate), options), { code: 'gas_scenario_unavailable' });
  for (const value of [{ ...options, year: '2026' }, { ...options, originCode: 'ZZ' }, { ...options, originCode: 'AD' }]) {
    // AD is a zero reported row in the actual response and is absent from positive shares.
    await assert.rejects(createGasExposureScenario(original, value), { code: 'gas_scenario_unavailable' });
  }
});

test('a complete source with omitted display rows supports visible origins only, without estimating hidden quantities', async () => {
  const expanded = clone(payload), category = expanded.dimension.partner.category.index;
  const additions = decoded.cube.cells.filter(cell => cell.value === 0 && /^[A-Z]{2}$/.test(cell.partner)).slice(0, 11);
  for (const { partner } of additions) expanded.value[category[partner]] = 1;
  expanded.value[category.TOTAL] += additions.length;
  const parsed = decodeEurostatGasOrigins(expanded), facts = await canonicalEurostatGasFacts(parsed.cube);
  const bytes = new TextEncoder().encode(JSON.stringify(expanded));
  const provenance = { ...source, rawSha256: await pluginBytesDigest(bytes), factsDigest: await pluginFactsDigest(facts) };
  const value = clone(original); value.artifact = createEurostatGasDossier(facts, parsed.locators, provenance);
  value.receipt.rawSha256 = provenance.rawSha256; value.receipt.factsDigest = provenance.factsDigest;
  value.receipt.artifactSha256 = await pluginFactsDigest(value.artifact);
  const year = value.artifact.years[0]; assert.equal(year.coverage.positiveRows, 21); assert.equal(year.omittedShareRows, 1);
  const hidden = additions.find(({ partner }) => !year.shares.some(row => row.partner.code === partner)); assert.ok(hidden);
  const scenario = await createGasExposureScenario(value, options);
  assert.equal(scenario.baseline.coverage.omittedOriginRows, 1);
  await assert.rejects(createGasExposureScenario(value, { ...options, originCode: hidden.partner }), { code: 'gas_scenario_unavailable' });
});

test('nonfinite source quantities and dishonest JSON evidence fail closed with no result', async () => {
  for (const quantity of [NaN, Infinity, -Infinity]) {
    const value = clone(original); value.artifact.years[0].total.value = quantity;
    await assert.rejects(createGasExposureScenario(value, options), { code: 'gas_scenario_unavailable' });
  }
  const excessive = await revised(artifact => { artifact.limitations = 'x'.repeat(65536); });
  await assert.rejects(createGasExposureScenario(excessive, options), { code: 'gas_scenario_unavailable' });
});

test('scenario identity is repeatable and tied to assumptions and exact evidence; operational checks do not change it', async () => {
  const first = await createGasExposureScenario(original, options);
  const operational = clone(original); operational.check = { checkedAt: '2026-10-12T10:00:00.000Z' };
  assert.deepEqual(await createGasExposureScenario(operational, clone(options)), first);
  const changed = await createGasExposureScenario(original, { ...options, replacementPercent: 41 });
  assert.notEqual(changed.id, first.id);
  const receipt = clone(original); receipt.receipt.id = `receipt:${'b'.repeat(64)}`;
  assert.notEqual((await createGasExposureScenario(receipt, options)).id, first.id);
  const { id, ...content } = first; assert.equal(id, `scenario:${await pluginFactsDigest(content)}`);
  first.baseline.unit.label = 'caller edit'; first.baseline.origin.label = 'caller edit';
  assert.notEqual(original.artifact.unit.label, 'caller edit');
  assert.notEqual(original.artifact.years[0].shares[0].partner.label, 'caller edit');
});
