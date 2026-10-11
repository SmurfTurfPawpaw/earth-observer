import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DEMAND_SUMMARY_URL, MAX_DEMAND_SUMMARY_BYTES, validatePrioritySummary, readDemandPriority, createPriorityReservoir, prioritizeCategory, applyDemandPriority } from '../scripts/intelligence-priority.mjs';
import { generateGkgSnapshot, GKG_UPDATE_MANIFEST } from '../scripts/gdelt-snapshot.mjs';
import { gkgTopicReport, createGkgSnapshot, validateGkgSnapshot } from '../server/hosted/gdelt-gkg.js';
import { demandSubject } from '../src/core/demand-subjects.js';

// Synthetic metadata/aggregate fixtures only; no real provider, visitor or R2 operations.
const NOW = Date.parse('2026-10-11T10:00:00Z'), BATCH = '20261011094500', OLD_BATCH = '20261011091500';
const RETRIEVED = '2026-10-11T09:48:00.000Z', OLD_RETRIEVED = '2026-10-11T09:18:00.000Z';
const group = (subjectId = 'gkg:WB_698_TRADE', country = 'BE', actions = 300) => ({ subjectId, label: demandSubject(subjectId).label, country, actions });
const summary = (groups = [group()]) => ({ enabled: true, groups, window: { firstDay: '2026-10-05', lastDay: '2026-10-11', days: 7 },
  minimumActions: 300, bucketSize: 100, maximumGroups: 100, unit: 'Accepted search actions, not unique people', rounding: 'Rounded down to multiples of 100', countryMeaning: 'Explicit country filter, never a visitor or map location' });
const policy = (groups) => validatePrioritySummary(summary(groups), NOW);
const report = (index, { category = 'economy', theme = 'EPU_ECONOMY', country = 'US', host = `publisher-${index}.example`, old = false } = {}) => gkgTopicReport({
  url: `https://${host}/source-${index}`, themes: [theme], mentionedCountries: [country], category,
  batch: old ? OLD_BATCH : BATCH, retrievedAt: old ? OLD_RETRIEVED : RETRIEVED,
});
const batchEntries = () => [{ id: OLD_BATCH, retrievedAt: OLD_RETRIEVED, rows: 100, matchedRecords: 100 }, { id: BATCH, retrievedAt: RETRIEVED, rows: 100, matchedRecords: 100 }];

test('public priority schema excludes unknown/private/raw, stale, below-threshold and exact-count summaries', () => {
  assert.equal(policy([group()]).mode, 'demand-prioritized');
  assert.equal(policy([]).mode, 'balanced');
  assert.equal(policy([group('overview:all', '', 900)]).mode, 'balanced');
  assert.equal(policy([group('overview:country', 'XK')]).interests[0].country, 'XK');
  for (const payload of [
    { ...summary(), rawQuery: 'private' }, { ...summary(), enabled: false }, { ...summary(), minimumActions: 1 },
    { ...summary(), window: { firstDay: '2026-10-04', lastDay: '2026-10-10', days: 7 } },
    summary([{ ...group(), actions: 299 }]), summary([{ ...group(), actions: 301 }]), summary([{ ...group(), actions: 7000100 }]),
    summary([{ ...group(), country: 'ZZ' }]), summary([{ ...group(), label: 'injected label' }]), summary([{ ...group(), subjectId: 'arbitrary:topic' }]),
    summary([{ ...group(), query: 'private' }]), summary([group(), group()]), summary(Array.from({ length: 101 }, () => group())),
  ]) assert.throws(() => validatePrioritySummary(payload, NOW));
});
test('reader performs one bounded owned-origin GET with no auth or POST, and failure preserves balanced baseline', async () => {
  const calls = [];
  const active = await readDemandPriority({ now: () => NOW, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(summary()); } });
  assert.equal(active.mode, 'demand-prioritized'); assert.equal(calls.length, 1); assert.equal(calls[0].url, DEMAND_SUMMARY_URL);
  assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.credentials, 'omit');
  assert.equal('Authorization' in calls[0].options.headers, false); assert.equal('body' in calls[0].options, false);
  let disabledCalls = 0; assert.equal((await readDemandPriority({ enabled: false, fetchImpl: () => { disabledCalls++; } })).mode, 'balanced'); assert.equal(disabledCalls, 0);
  for (const response of [Response.json({ enabled: false }), new Response('Unavailable', { status: 503 }), new Response('x'.repeat(MAX_DEMAND_SUMMARY_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
    Response.json(summary(), { headers: { 'content-length': String(MAX_DEMAND_SUMMARY_BYTES + 1) } }), new Response('<html>Redirect login</html>', { headers: { 'content-type': 'text/html' } }),
    Response.json({ ...summary(), window: { firstDay: '2026-10-04', lastDay: '2026-10-10', days: 7 } })]) {
    assert.equal((await readDemandPriority({ now: () => NOW, fetchImpl: async () => response })).mode, 'balanced');
  }
  const redirected = Response.json(summary()); Object.defineProperty(redirected, 'redirected', { value: true });
  assert.equal((await readDemandPriority({ now: () => NOW, fetchImpl: async () => redirected })).mode, 'balanced');
});
test('summary fetch and chunked body honor the deadline and decoded-byte limit', async () => {
  let signal;
  const timeout = await readDemandPriority({ timeoutMs: 100, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(timeout.mode, 'balanced'); assert.equal(signal.aborted, true);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_DEMAND_SUMMARY_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  assert.equal((await readDemandPriority({ fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) })).mode, 'balanced'); assert.equal(cancelled, true);
});
test('focused reservoir remains within the existing10k budget and rescues a rare match without bulk requests', () => {
  const limits = [];
  const factory = (limit) => { limits.push(limit); const rows = []; return { get size() { return rows.length; }, resize(nextLimit) { limit = nextLimit; rows.length = Math.min(rows.length, limit); }, add(row) { if (rows.length < limit) rows.push(row); }, values: () => rows }; };
  const reservoir = createPriorityReservoir(policy([group()]), factory);
  assert.deepEqual(limits, [10000, 2000]);
  for (let index = 0; index < 10000; index++) reservoir.add(report(index));
  assert.equal(reservoir.values().length, 10000);
  const rare = report(10001, { theme: 'WB_698_TRADE', country: 'BE' }); reservoir.add(rare);
  assert.equal(reservoir.values().some((row) => row.url === rare.url), true); assert.equal(reservoir.values().length <= 10000, true);
  assert.equal(createPriorityReservoir({ mode: 'balanced', interests: [] }, factory), null);
  const many = policy(['US', 'BE', 'DE', 'FR', 'JP', 'IN', 'BR', 'AU', 'ZA', 'CA'].flatMap((country) =>
    ['gkg:WB_698_TRADE', 'gkg:EPU_ECONOMY', 'gkg:ECON_INFLATION', 'gkg:ECON_STOCKMARKET', 'gkg:ECON_DEBT', 'gkg:ECON_INTEREST_RATES', 'gkg:ECON_OILPRICE', 'gkg:ECON_CURRENCY_EXCHANGE_RATE', 'gkg:WB_793_TRANSPORT_AND_LOGISTICS_SERVICES', 'gkg:WB_471_ECONOMIC_GROWTH'].map((id) => group(id, country))));
  const tinyLimits = []; const tiny = createPriorityReservoir(many, (limit) => { tinyLimits.push(limit); return factory(limit); }, 100); tiny.add(rare);
  assert.equal(tinyLimits.reduce((sum, count) => sum + count, 0), 120); assert.equal(tinyLimits.every((limit) => limit > 0), true); assert.equal(tiny.values().length <= 100, true);
});
test('demand keeps at least60 balanced rows, improves rare topic/country retention, and keeps source facts unchanged', () => {
  const countries = ['US', 'DE', 'FR', 'GB', 'JP', 'IN', 'BR', 'AU', 'ZA', 'CA'];
  const global = Array.from({ length: 80 }, (_, index) => report(index, { country: countries[index % countries.length] }));
  const interested = Array.from({ length: 30 }, (_, index) => report(1000 + index, { theme: 'WB_698_TRADE', country: 'BE', old: true }));
  const input = [...global, ...interested];
  const baseline = createGkgSnapshot({ reports: input, processedBatches: batchEntries(), generatedAt: new Date(NOW).toISOString() });
  assert.equal(baseline.categories.economy.reports.length, 80); assert.equal(baseline.categories.economy.reports.some((row) => row.mentionedCountries.includes('BE')), false);
  for (const row of input) { Object.freeze(row.themes); Object.freeze(row.mentionedCountries); Object.freeze(row); }
  const preferred = applyDemandPriority(baseline, input, policy([group()]));
  const chosen = preferred.categories.economy.reports;
  assert.equal(chosen.length, 80); assert.equal(chosen.filter((row) => row.mentionedCountries.includes('BE')).length, 8);
  for (const row of baseline.categories.economy.reports.slice(0, 60)) assert.equal(chosen.includes(row), true);
  for (const row of chosen) { assert.equal(input.includes(row), true); assert.equal(row.observedAt, null); assert.equal(row.publishedAt, null); assert.match(row.verification, /not verified incidents/); assert.equal('popularity' in row, false); }
  assert.deepEqual(validateGkgSnapshot(preferred, NOW), preferred); assert.deepEqual(preferred.coverage, baseline.coverage);
  assert.equal(applyDemandPriority(baseline, input, { mode: 'balanced', interests: [] }), baseline);
  const unmatched = policy([group('gkg:HEALTH_PANDEMIC', 'BE')]); assert.deepEqual(applyDemandPriority(baseline, input, unmatched), baseline);
});
test('fair coarse weights cannot crowd out baseline/topics/publishers or enlarge snapshot categories', () => {
  const baseline = Array.from({ length: 80 }, (_, index) => report(index));
  const extra = [
    ...Array.from({ length: 30 }, (_, index) => report(1000 + index, { theme: 'WB_698_TRADE', country: 'BE', host: index < 12 ? 'dominant.example' : `trade-${index}.example` })),
    ...Array.from({ length: 30 }, (_, index) => report(2000 + index, { theme: 'ECON_INFLATION', country: 'US' })),
    ...Array.from({ length: 30 }, (_, index) => report(3000 + index, { theme: 'WB_471_ECONOMIC_GROWTH', country: 'DE' })),
  ];
  const preferred = prioritizeCategory(baseline, [...baseline, ...extra], policy([group(), group('gkg:ECON_INFLATION', 'US', 2400), group('gkg:WB_471_ECONOMIC_GROWTH', 'DE', 600)]), 'economy');
  const additions = preferred.filter((row) => !baseline.includes(row));
  assert.equal(preferred.length, 80); assert.equal(additions.length, 20); assert.equal(preferred.filter((row) => baseline.includes(row)).length, 60);
  for (const key of ['source', 'country', 'theme']) {
    const counts = new Map(); for (const row of additions) { const value = key === 'country' ? row.mentionedCountries[0] : key === 'theme' ? row.themes[0] : row.source; counts.set(value, (counts.get(value) || 0) + 1); }
    assert.equal(Math.max(...counts.values()) <= (key === 'source' ? 2 : 8), true);
  }
  assert.equal(additions.filter((row) => row.themes.includes('ECON_INFLATION')).length >= additions.filter((row) => row.themes.includes('WB_698_TRADE')).length, true);
  assert.throws(() => prioritizeCategory(baseline, extra, policy([group()]), 'economy', 81));
});

function fixtureZip() {
  const fields = Array(27).fill(''); fields[0] = `${BATCH}-T1`; fields[1] = BATCH; fields[2] = '1'; fields[4] = 'https://fixture-publisher.example/source'; fields[7] = 'WB_698_TRADE;'; fields[9] = '1#Belgium#BE##50.85#4.35#BE;';
  const data = Buffer.from(`${fields.join('\t')}\n`), name = Buffer.from(`${BATCH}.gkg.csv`);
  let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
test('scheduled generator uses demand only for sampling existing archive, and unavailable priority matches disabled baseline', async () => {
  const archive = fixtureZip(), archiveUrl = `https://data.gdeltproject.org/gdeltv2/${BATCH}.gkg.csv.zip`;
  const manifest = `${archive.length} ${createHash('md5').update(archive).digest('hex')} ${archiveUrl}\n`;
  const run = async (demandPriority, response) => {
    const calls = [];
    const result = await generateGkgSnapshot({ demandPriority, previousSnapshot: null, now: () => NOW, fetchImpl: async (url, options) => {
      calls.push({ url, options }); if (url === GKG_UPDATE_MANIFEST) return new Response(manifest); if (url === archiveUrl) return new Response(archive); if (url === DEMAND_SUMMARY_URL) return response; throw Error('Unapproved acquisition');
    } });
    assert.equal(result.status, 'generated', result.reason); return { result, calls };
  };
  const disabled = await run(false); assert.equal(disabled.calls.length, 2); assert.equal(disabled.result.sampling.mode, 'balanced');
  const unavailable = await run(true, Response.json({ enabled: false })); assert.deepEqual(unavailable.result.bytes, disabled.result.bytes);
  const active = await run(true, Response.json(summary())); assert.equal(active.result.sampling.mode, 'demand-prioritized');
  const unmatched = await run(true, Response.json(summary([group('gkg:HEALTH_PANDEMIC', 'BE')]))); assert.deepEqual(unmatched.result.bytes, disabled.result.bytes);
  assert.deepEqual(active.calls.map(({ url }) => url).sort(), [GKG_UPDATE_MANIFEST, archiveUrl, DEMAND_SUMMARY_URL].sort());
  assert.equal(active.calls.every(({ options }) => options.method === undefined && options.redirect === 'error'), true);
  assert.deepEqual(validateGkgSnapshot(active.result.snapshot, NOW), active.result.snapshot); assert.equal(active.result.rows, 1);
  const skippedCalls = [];
  const skipped = await generateGkgSnapshot({ demandPriority: true, previousSnapshot: active.result.snapshot, now: () => NOW, fetchImpl: async (url) => { skippedCalls.push(url); return new Response(manifest); } });
  assert.equal(skipped.status, 'skipped'); assert.deepEqual(skippedCalls, [GKG_UPDATE_MANIFEST]);
});
