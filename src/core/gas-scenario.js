import { EUROSTAT_GAS_SCOPE_ID, EUROSTAT_GAS_POLICY_ID, EUROSTAT_GAS_URL, EUROSTAT_GAS_DATASET_URL,
  EUROSTAT_GAS_LIMITS } from './eurostat-gas-origins.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from './plugin-evidence.js';

export const GAS_SCENARIO_METHOD = 'gas-origin-reduction-v1';
const PLUGIN_ID = 'eurostat-gas-origins-v1', MAX_QUANTITY = 1e12;
const RESIDUALS = new Set(['EX_SU_OTH', 'EUR_OTH', 'AFR_OTH', 'AME_OTH', 'ASI_NME_OTH', 'ASI_OTH']);
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= EUROSTAT_GAS_LIMITS.partners;
const quantity = value => finite(value) && value >= 0 && value <= MAX_QUANTITY;
const percent = value => finite(value) && value >= 0 && value <= 100;
const locator = value => typeof value === 'string' && /^\/value\/(?:0|[1-9]\d*)$/.test(value) &&
  Number(value.slice(7)) < EUROSTAT_GAS_LIMITS.cells;
const clone = value => JSON.parse(pluginJson(value));
const zero = value => value === 0 ? 0 : value;
function fail(reason, code = 'gas_scenario_unavailable') {
  throw Object.assign(new TypeError(reason), { code });
}
function close(left, right, scale = Math.max(Math.abs(left), Math.abs(right), 1)) {
  return finite(left) && finite(right) && Math.abs(left - right) <= Math.max(1e-10, scale * 1e-12);
}
function countryKey(partner) {
  if (!object(partner) || !text(partner.code) || !text(partner.label) || partner.entityId !== `eurostat:partner:${partner.code}`)
    fail('Origin identity is not compatible with the reviewed source.');
  if (partner.type === 'reported-country-or-territory' && /^[A-Z]{2}$/.test(partner.code) && !['EU', 'EA', 'UN', 'ZZ'].includes(partner.code)) {
    const iso2 = partner.code === 'UK' ? 'GB' : partner.code === 'EL' ? 'GR' : partner.code;
    if (partner.iso2 !== undefined && partner.iso2 !== iso2) fail('Origin country aliases are inconsistent.');
    return iso2;
  }
  if (partner.type === 'unspecified-origin' && partner.code === 'NSP' ||
      partner.type === 'residual-statistical-region' && RESIDUALS.has(partner.code)) return null;
  fail('An overlapping or unreviewed source aggregate cannot support this method.');
}

/** Pure, deterministic arithmetic over one integrity-checked stored annual dossier.
 * Replacement is a percentage of the lost origin volume, never of the TOTAL.
 * This counterfactual has no present-day observation, probability or forecast clock.
 */
export async function createGasExposureScenario(envelope, assumptions) {
  if (!object(assumptions) || Object.keys(assumptions).length !== 4 ||
      Object.keys(assumptions).some(key => !['year', 'originCode', 'reductionPercent', 'replacementPercent'].includes(key)) ||
      !/^20\d\d$/.test(assumptions.year || '') || typeof assumptions.year !== 'string' ||
      typeof assumptions.originCode !== 'string' || !/^[A-Z]{2}$/.test(assumptions.originCode) ||
      !percent(assumptions.reductionPercent) || !percent(assumptions.replacementPercent))
    fail('Choose one reported country, a reference year and finite reduction/replacement percentages from 0 to 100.', 'gas_scenario_invalid_assumptions');
  if (!object(envelope) || envelope.schemaVersion !== 1 || envelope.configured !== true || envelope.available !== true ||
      envelope.plugin?.id !== PLUGIN_ID || envelope.plugin.scopeId !== EUROSTAT_GAS_SCOPE_ID || envelope.plugin.kind !== 'dataset' ||
      envelope.plugin.sourceUrl !== EUROSTAT_GAS_URL)
    fail('An available retained Eurostat gas dossier is required.');
  const { artifact, receipt } = envelope;
  if (!object(receipt) || !/^receipt:[a-f0-9]{64}$/.test(receipt.id || '') || !utc(receipt.capturedAt) || !utc(receipt.recordedAt) ||
      !['factsDigest', 'rawSha256', 'artifactSha256'].every(key => digest(receipt[key])) ||
      receipt.sourceUpdatedAt !== null && !utc(receipt.sourceUpdatedAt) || receipt.sourceVersion !== null && !text(receipt.sourceVersion))
    fail('The annual dossier has no compatible completed evidence receipt.');
  if (!object(artifact) || artifact.schemaVersion !== 1 || artifact.kind !== 'dataset-dossier' ||
      artifact.dossierId !== EUROSTAT_GAS_SCOPE_ID || artifact.policyId !== EUROSTAT_GAS_POLICY_ID ||
      !digest(artifact.inputRevision) || artifact.inputDigest !== receipt.factsDigest ||
      artifact.source?.name !== 'Eurostat' || artifact.source.datasetCode !== 'nrg_ti_gas' ||
      artifact.source.url !== EUROSTAT_GAS_URL || artifact.source.datasetUrl !== EUROSTAT_GAS_DATASET_URL ||
      artifact.source.rawSha256 !== receipt.rawSha256 || artifact.source.sourceUpdatedAt !== receipt.sourceUpdatedAt ||
      artifact.source.sourceVersion !== receipt.sourceVersion || artifact.reportingCountry?.code !== 'BE' ||
      artifact.reportingCountry.entityId !== 'country:BE' || !text(artifact.reportingCountry.label) ||
      artifact.resource?.code !== 'G3000' || artifact.resource.entityId !== 'resource:siec:G3000' ||
      artifact.resource.type !== 'energy-resource' || !text(artifact.resource.label) ||
      artifact.unit?.code !== 'TJ_GCV' || artifact.unit.entityId !== 'unit:eurostat:TJ_GCV' ||
      artifact.unit.basis !== 'gross-calorific-value' || !text(artifact.unit.label) ||
      !Array.isArray(artifact.years) || artifact.years.length < 1 || artifact.years.length > EUROSTAT_GAS_LIMITS.periods ||
      !Array.isArray(artifact.referenceYears) || artifact.referenceYears.length !== artifact.years.length ||
      new Set(artifact.referenceYears).size !== artifact.referenceYears.length ||
      artifact.years.some((year, index) => !object(year) || !/^20\d\d$/.test(year.year || '') ||
        typeof year.year !== 'string' || Number(year.year) < 2024 || artifact.referenceYears[index] !== year.year ||
        index > 0 && artifact.years[index - 1].year >= year.year) ||
      artifact.latestAvailableYear !== artifact.referenceYears.at(-1))
    fail('The retained annual dossier has incompatible source scope, units or provenance.');
  let bytes;
  try { bytes = new TextEncoder().encode(pluginJson(artifact)); }
  catch { fail('The annual dossier must contain bounded finite JSON evidence.'); }
  if (bytes.byteLength > EUROSTAT_GAS_LIMITS.artifactBytes || await pluginBytesDigest(bytes) !== receipt.artifactSha256)
    fail('The annual dossier does not match its retained artifact digest.');
  const year = artifact.years.find(value => value.year === assumptions.year);
  if (!year) fail('The chosen reference year is not retained in this dossier.');
  const total = year.total, coverage = year.coverage;
  const expectedTolerance = quantity(total?.value) ? Math.max(1e-6, Math.abs(total.value) * 1e-12) : null;
  if (!object(year.period) || year.period.meaning !== 'calendar-year' ||
      year.period.from !== `${year.year}-01-01T00:00:00.000Z` || year.period.until !== `${Number(year.year) + 1}-01-01T00:00:00.000Z` ||
      Date.parse(year.period.until) > Date.parse(receipt.recordedAt) ||
      !object(total) || !quantity(total.value) || total.value <= 0 || total.status !== null || !locator(total.valueLocator) ||
      !object(coverage) || coverage.completeReportedBreakdown !== true || coverage.reconciled !== true ||
      coverage.missingRows !== 0 || coverage.flaggedRows !== 0 || coverage.negativeRows !== 0 ||
      !count(coverage.partnerRows) || !count(coverage.positiveRows) || !count(coverage.zeroRows) ||
      coverage.partnerRows !== coverage.positiveRows + coverage.zeroRows + 1 ||
      !quantity(coverage.reportedSum) || !finite(coverage.totalDifference) ||
      !close(coverage.reconciliationTolerance, expectedTolerance, expectedTolerance) ||
      !close(coverage.totalDifference, total.value - coverage.reportedSum, total.value) ||
      Math.abs(coverage.totalDifference) > expectedTolerance ||
      !Array.isArray(year.missing) || year.missing.length !== 0 || !Array.isArray(year.shares) ||
      year.shares.length !== Math.min(coverage.positiveRows, EUROSTAT_GAS_LIMITS.sharesPerYear) ||
      !count(year.omittedShareRows) || year.omittedShareRows !== coverage.positiveRows - year.shares.length)
    fail('A completed, unflagged and reconciled annual breakdown with a positive reported TOTAL is required.');
  const codes = new Set(), countries = new Set(), values = new Set(); let visibleSum = 0;
  for (const row of year.shares) {
    const iso2 = countryKey(row?.partner);
    if (!object(row) || !quantity(row.quantity) || row.quantity <= 0 || row.quantity > total.value || row.status !== null ||
        !percent(row.sharePercent) || !close(row.sharePercent, 100 * row.quantity / total.value, 100) ||
        !locator(row.valueLocator) || row.valueLocator === total.valueLocator || row.denominatorLocator !== total.valueLocator ||
        codes.has(row.partner.code) || values.has(row.valueLocator) || iso2 && countries.has(iso2))
      fail('Origin rows are missing, flagged, inconsistent or geographically overlapping.');
    codes.add(row.partner.code); values.add(row.valueLocator); if (iso2) countries.add(iso2); visibleSum += row.quantity;
  }
  if (visibleSum > total.value + expectedTolerance || year.omittedShareRows === 0 && Math.abs(visibleSum - total.value) > expectedTolerance)
    fail('The visible annual origin quantities do not agree with the reported TOTAL.');
  const origin = year.shares.find(row => row.partner.code === assumptions.originCode);
  if (!origin || countryKey(origin.partner) === null)
    fail('Choose one cited reported country row; missing, zero or omitted origins cannot be estimated from the displayed sample.');
  const lostOriginVolume = zero(origin.quantity * (assumptions.reductionPercent / 100));
  const replacementVolume = zero(lostOriginVolume * (assumptions.replacementPercent / 100));
  const residualGapVolume = zero(lostOriginVolume - replacementVolume);
  const residualGapPercentOfReportedTotal = zero(100 * residualGapVolume / total.value);
  const value = {
    schemaVersion: 1, kind: 'conditional-gas-exposure', methodId: GAS_SCENARIO_METHOD,
    temporalMeaning: 'reference-year-counterfactual',
    baseline: { referenceYear: year.year, period: clone(year.period),
      reportingCountry: { code: artifact.reportingCountry.code, label: artifact.reportingCountry.label, entityId: artifact.reportingCountry.entityId },
      origin: { code: origin.partner.code, label: origin.partner.label, type: origin.partner.type, entityId: origin.partner.entityId,
        ...(origin.partner.iso2 ? { iso2: origin.partner.iso2 } : {}) },
      resource: { code: artifact.resource.code, label: artifact.resource.label, type: artifact.resource.type, entityId: artifact.resource.entityId },
      unit: { code: artifact.unit.code, label: artifact.unit.label, entityId: artifact.unit.entityId, basis: artifact.unit.basis },
      originVolume: origin.quantity, reportedTotal: total.value, reportedSharePercent: origin.sharePercent,
      coverage: { completeReportedBreakdown: true, visibleOriginRows: year.shares.length, omittedOriginRows: year.omittedShareRows } },
    assumptions: { originReductionPercent: zero(assumptions.reductionPercent), replacementPercentOfLostVolume: zero(assumptions.replacementPercent),
      meaning: 'Reduce the cited reference-year origin quantity by the chosen percentage; replace the chosen percentage of that lost volume. Other reported origins are held fixed.' },
    result: { lostOriginVolume, replacementVolume, residualGapVolume, residualGapPercentOfReportedTotal },
    formulas: { lostOriginVolume: 'originVolume × originReductionPercent / 100',
      replacementVolume: 'lostOriginVolume × replacementPercentOfLostVolume / 100',
      residualGapVolume: 'lostOriginVolume − replacementVolume',
      residualGapPercentOfReportedTotal: '100 × residualGapVolume / reportedTotal' },
    provenance: { pluginId: PLUGIN_ID, scopeId: EUROSTAT_GAS_SCOPE_ID, receiptId: receipt.id, capturedAt: receipt.capturedAt,
      recordedAt: receipt.recordedAt, inputRevision: artifact.inputRevision, inputDigest: artifact.inputDigest,
      rawSha256: receipt.rawSha256, artifactSha256: receipt.artifactSha256, sourceUpdatedAt: receipt.sourceUpdatedAt,
      sourceVersion: receipt.sourceVersion, sourceUrl: artifact.source.url, datasetUrl: artifact.source.datasetUrl,
      sourceName: artifact.source.name, datasetCode: artifact.source.datasetCode,
      locators: { originValue: origin.valueLocator, reportedTotal: total.valueLocator } },
    limitations: 'Hypothetical arithmetic against the cited annual reported imports. Replacement is an assumption, not verified capacity or availability. This is not current supply, consumption dependency, a shipment route, disruption likelihood, a geopolitical effect or a price prediction. It does not create or change source statistics, observations or forecasts.',
  };
  return { ...value, id: `scenario:${await pluginFactsDigest(value)}` };
}
