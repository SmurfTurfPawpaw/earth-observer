import { pluginFactsDigest, pluginJson } from './plugin-evidence.js';

export const EUROSTAT_GAS_SCOPE_ID = 'belgium-natural-gas-origins';
export const EUROSTAT_GAS_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ti_gas?lang=EN&freq=A&geo=BE&siec=G3000&unit=TJ_GCV&sinceTimePeriod=2024';
export const EUROSTAT_GAS_DATASET_URL = 'https://ec.europa.eu/eurostat/databrowser/view/nrg_ti_gas/default/table';
export const EUROSTAT_GAS_POLICY_ID = 'eurostat-gas-origin-shares-v1';
export const EUROSTAT_GAS_LIMITS = Object.freeze({ partners: 256, periods: 8, cells: 2048,
  artifactBytes: 64 * 1024, sharesPerYear: 20, missingPerYear: 20 });
const DIMS = ['freq', 'siec', 'partner', 'unit', 'geo', 'time'];
const FIXED = { freq: 'A', siec: 'G3000', unit: 'TJ_GCV', geo: 'BE' };
const OTHER = new Set(['EX_SU_OTH', 'EUR_OTH', 'AFR_OTH', 'AME_OTH', 'ASI_NME_OTH', 'ASI_OTH']);
const ITEM_ID = 'dataset:eurostat:nrg_ti_gas:BE:G3000:TJ_GCV:since2024';
const SOURCE_RECORD_ID = 'nrg_ti_gas:A:G3000:TJ_GCV:BE:since2024';
const TITLE = 'Belgium natural-gas import origins';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const utf8Bytes = value => new TextEncoder().encode(pluginJson(value)).byteLength;
const own = (value, key) => Object.hasOwn(value, key);
function fail() { throw new TypeError('Unsupported bounded Eurostat natural-gas dataset'); }

function categories(dimension, size) {
  if (!object(dimension?.category) || !object(dimension.category.label) || !text(dimension.label)) fail();
  const { index, label } = dimension.category;
  let codes;
  if (Array.isArray(index)) codes = [...index];
  else if (object(index)) {
    const keys = Object.keys(index);
    if (keys.length !== size || keys.some(code => !Number.isInteger(index[code]) || index[code] < 0 || index[code] >= size) ||
        new Set(keys.map(code => index[code])).size !== size) fail();
    codes = keys.sort((a, b) => index[a] - index[b]);
  } else if (index === undefined && size === 1 && Object.keys(label).length === 1) codes = Object.keys(label);
  else fail();
  if (codes.length !== size || new Set(codes).size !== size || codes.some(code => !text(code, 80) || !text(label[code]))) fail();
  return codes;
}
function series(value, count, status = false) {
  if (status && value === undefined) return () => null;
  if (status && typeof value === 'string') {
    if (value && !text(value, 80)) fail();
    return () => value || null;
  }
  if (Array.isArray(value)) {
    if (value.length !== count) fail();
  } else if (object(value)) {
    if (Object.keys(value).some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= count)) fail();
  } else fail();
  const read = index => Array.isArray(value) ? value[index] : own(value, String(index)) ? value[String(index)] : null;
  for (let index = 0; index < count; index++) {
    const cell = read(index);
    if (status ? cell != null && cell !== '' && !text(cell, 80) : cell != null && (typeof cell !== 'number' || !Number.isFinite(cell) || Math.abs(cell) > 1e12)) fail();
  }
  return index => read(index) === '' && status ? null : read(index);
}
function sourceStructure(payload) {
  const extension = payload.extension;
  if (extension?.id !== undefined && String(extension.id).toUpperCase() !== 'NRG_TI_GAS') fail();
  const structure = extension?.datastructure;
  if (structure !== undefined && (!object(structure) || structure.id !== 'NRG_TI_GAS' || structure.agencyId !== 'ESTAT' || !text(structure.version, 80))) fail();
  const version = extension?.version;
  if (version !== undefined && !text(version, 80)) fail();
  return { agencyId: 'ESTAT', id: 'NRG_TI_GAS', version: structure?.version ?? null, datasetVersion: version ?? null };
}

/** Decode JSON-stat row-major coordinates, not object insertion order. Missing is never zero.
 * Locators are source-layout evidence and deliberately excluded from canonical statistical facts.
 */
export function decodeEurostatGasOrigins(payload) {
  if (!object(payload) || payload.version !== '2.0' || payload.class !== 'dataset' || !text(payload.label, 300) ||
      !Array.isArray(payload.id) || payload.id.length !== DIMS.length || new Set(payload.id).size !== DIMS.length ||
      payload.id.some(id => !DIMS.includes(id)) || !Array.isArray(payload.size) || payload.size.length !== DIMS.length || !object(payload.dimension)) fail();
  const orders = {}, sizes = {};
  for (let offset = 0; offset < payload.id.length; offset++) {
    const id = payload.id[offset], size = payload.size[offset];
    if (!Number.isInteger(size) || size < 1 || size > (id === 'partner' ? EUROSTAT_GAS_LIMITS.partners : id === 'time' ? EUROSTAT_GAS_LIMITS.periods : 1)) fail();
    sizes[id] = size; orders[id] = categories(payload.dimension[id], size);
    if (FIXED[id] && orders[id][0] !== FIXED[id] || id === 'time' && orders[id].some(year => !/^20\d\d$/.test(year) || Number(year) < 2024)) fail();
  }
  const count = payload.size.reduce((product, size) => product * size, 1);
  if (count > EUROSTAT_GAS_LIMITS.cells || !orders.partner.includes('TOTAL')) fail();
  const values = series(payload.value, count), statuses = series(payload.status, count, true), cells = [], locators = [];
  for (let index = 0; index < count; index++) {
    let rest = index; const coordinate = {};
    for (let dimension = payload.id.length - 1; dimension >= 0; dimension--) {
      const id = payload.id[dimension], position = rest % sizes[id]; rest = Math.floor(rest / sizes[id]); coordinate[id] = orders[id][position];
    }
    const value = values(index), status = statuses(index);
    cells.push({ year: coordinate.time, partner: coordinate.partner, value, status });
    locators.push({ year: coordinate.time, partner: coordinate.partner,
      valueLocator: Array.isArray(payload.value) || own(payload.value, String(index)) ? `/value/${index}` : null,
      statusLocator: typeof payload.status === 'string' ? '/status' : payload.status &&
        (Array.isArray(payload.status) || own(payload.status, String(index))) ? `/status/${index}` : null });
  }
  cells.sort((a, b) => ordinal(a.year, b.year) || ordinal(a.partner, b.partner));
  locators.sort((a, b) => ordinal(a.year, b.year) || ordinal(a.partner, b.partner));
  const dimensions = DIMS.map(id => ({ id, label: payload.dimension[id].label,
    categories: [...orders[id]].sort(ordinal).map(code => ({ code, label: payload.dimension[id].category.label[code] })) }));
  const structure = sourceStructure(payload);
  const cube = { schemaVersion: 1, datasetCode: 'nrg_ti_gas', datasetLabel: payload.label, sourceStructure: { agencyId: structure.agencyId, id: structure.id },
    frequency: 'A', reportingCountry: { code: 'BE', label: payload.dimension.geo.category.label.BE, entityId: 'country:BE' },
    resource: { code: 'G3000', label: payload.dimension.siec.category.label.G3000, entityId: 'resource:siec:G3000', type: 'energy-resource' },
    unit: { code: 'TJ_GCV', label: payload.dimension.unit.category.label.TJ_GCV, entityId: 'unit:eurostat:TJ_GCV', basis: 'gross-calorific-value' },
    dimensions, cells };
  return { cube, locators, sourceVersion: structure.version };
}

export async function canonicalEurostatGasFacts(cube) {
  const content = { schemaVersion: 1, publisherId: 'eurostat', sourceRecordId: SOURCE_RECORD_ID, kind: 'statistical-dataset', title: TITLE,
    url: EUROSTAT_GAS_DATASET_URL, publishedAt: null, publishedPrecision: 'unknown', canonicalFacts: cube };
  const item = { itemId: ITEM_ID, ...content, sourceRevision: await pluginFactsDigest(content) };
  return { schemaVersion: 1, scopeId: EUROSTAT_GAS_SCOPE_ID, items: [item] };
}
export function eurostatGasItems(canonicalFacts) {
  if (canonicalFacts?.schemaVersion !== 1 || canonicalFacts.scopeId !== EUROSTAT_GAS_SCOPE_ID ||
      !Array.isArray(canonicalFacts.items) || canonicalFacts.items.length !== 1 || canonicalFacts.items[0].itemId !== ITEM_ID) fail();
  return canonicalFacts.items;
}

function partner(code, label) {
  if (code === 'NSP') return { code, label, type: 'unspecified-origin', entityId: 'eurostat:partner:NSP' };
  if (OTHER.has(code)) return { code, label, type: 'residual-statistical-region', entityId: `eurostat:partner:${code}` };
  if (/^[A-Z]{2}$/.test(code)) return { code, label, type: 'reported-country-or-territory', entityId: `eurostat:partner:${code}`,
    ...(['UK', 'EL'].includes(code) ? { iso2: code === 'UK' ? 'GB' : 'GR' } : {}) };
  return { code, label, type: 'unreviewed-statistical-aggregate', entityId: `eurostat:partner:${code}` };
}

/** Supported annual ratios only. Source statuses stay literal; unknown flags withhold derivation.
 * No consumption dependency, transit correction, present supply or causal conclusion is inferred.
 */
export function createEurostatGasDossier(canonicalFacts, locators, provenance) {
  const item = eurostatGasItems(canonicalFacts)[0], cube = item.canonicalFacts;
  const labels = new Map(cube.dimensions.find(dimension => dimension.id === 'partner').categories.map(entry => [entry.code, entry.label]));
  const locations = new Map(locators.map(location => [`${location.year}:${location.partner}`, location]));
  const referenceYears = [...new Set(cube.cells.map(cell => cell.year))].sort(ordinal);
  const years = referenceYears.map(year => {
    const cells = cube.cells.filter(cell => cell.year === year), total = cells.find(cell => cell.partner === 'TOTAL');
    const breakdown = cells.filter(cell => cell.partner !== 'TOTAL'), present = breakdown.filter(cell => cell.value !== null);
    const missing = cells.filter(cell => cell.value === null), flagged = cells.filter(cell => cell.status !== null);
    const negativeRows = breakdown.filter(cell => cell.value !== null && cell.value < 0).length;
    const recognized = breakdown.every(cell => partner(cell.partner, labels.get(cell.partner)).type !== 'unreviewed-statistical-aggregate');
    const reportedSum = missing.length || !recognized ? null : present.reduce((sum, cell) => sum + cell.value, 0);
    const difference = reportedSum !== null && total?.value !== null ? total.value - reportedSum : null;
    const tolerance = total?.value !== null ? Math.max(1e-6, Math.abs(total.value) * 1e-12) : null;
    const eligibleTotal = Number.isFinite(total?.value) && total.value > 0 && total.status === null;
    const positive = breakdown.filter(cell => cell.value !== null && cell.value > 0).sort((a, b) => b.value - a.value || ordinal(a.partner, b.partner));
    const shares = positive.slice(0, EUROSTAT_GAS_LIMITS.sharesPerYear).map(cell => {
      const origin = partner(cell.partner, labels.get(cell.partner));
      const supported = eligibleTotal && negativeRows === 0 && origin.type !== 'unreviewed-statistical-aggregate' && cell.status === null && cell.value <= total.value;
      return { partner: origin, quantity: cell.value,
        sharePercent: supported ? 100 * cell.value / total.value : null, status: cell.status,
        valueLocator: locations.get(`${year}:${cell.partner}`)?.valueLocator ?? null,
        denominatorLocator: locations.get(`${year}:TOTAL`)?.valueLocator ?? null,
        ...(!supported ? { shareUnavailableReason: !eligibleTotal ? 'Reported total is missing, nonpositive or flagged' :
          negativeRows > 0 ? 'Negative import observations require review' : origin.type === 'unreviewed-statistical-aggregate' ? 'Source partner category requires review' :
          cell.status !== null ? 'Source observation status requires review' : 'Reported quantity exceeds the total' } : {}) };
    });
    return { year, period: { from: `${year}-01-01T00:00:00.000Z`, until: `${Number(year) + 1}-01-01T00:00:00.000Z`, meaning: 'calendar-year' },
      total: { value: total?.value ?? null, status: total?.status ?? null,
        valueLocator: locations.get(`${year}:TOTAL`)?.valueLocator ?? null, statusLocator: locations.get(`${year}:TOTAL`)?.statusLocator ?? null },
      shares, coverage: { partnerRows: cells.length, missingRows: missing.length, flaggedRows: flagged.length,
        zeroRows: breakdown.filter(cell => cell.value === 0).length, positiveRows: positive.length,
        reportedSum, totalDifference: difference, reconciliationTolerance: tolerance,
        reconciled: difference !== null ? Math.abs(difference) <= tolerance : null,
        completeReportedBreakdown: missing.length === 0 && flagged.length === 0 && negativeRows === 0 && recognized && difference !== null && Math.abs(difference) <= tolerance,
        negativeRows },
      missing: missing.slice(0, EUROSTAT_GAS_LIMITS.missingPerYear).map(cell => ({ code: cell.partner, label: labels.get(cell.partner), status: cell.status })),
      omittedShareRows: Math.max(0, positive.length - shares.length) };
  });
  const artifact = { schemaVersion: 1, kind: 'dataset-dossier', dossierId: EUROSTAT_GAS_SCOPE_ID, title: TITLE,
    policyId: EUROSTAT_GAS_POLICY_ID, source: { name: 'Eurostat', datasetCode: 'nrg_ti_gas', url: EUROSTAT_GAS_URL,
      datasetUrl: EUROSTAT_GAS_DATASET_URL, rawSha256: provenance.rawSha256, sourceUpdatedAt: provenance.sourceUpdatedAt,
      sourceVersion: provenance.sourceVersion }, inputRevision: item.sourceRevision, inputDigest: provenance.factsDigest,
    reportingCountry: cube.reportingCountry, resource: cube.resource, unit: cube.unit, referenceYears,
    latestAvailableYear: referenceYears.at(-1), years,
    formula: '100 × reported partner quantity / reported TOTAL in the same year, product and unit',
    limitations: 'Annual reported imports by country of ultimate origin, as defined by Eurostat. These reference-year quantities are not current supply, consumption dependency or shipment routes. Natural gas and LNG quantities are not added together. Source status codes are retained without inferred meanings. Reported ratios are not a causal explanation or a forecast.' };
  if (utf8Bytes(artifact) > EUROSTAT_GAS_LIMITS.artifactBytes) throw new TypeError('Eurostat dossier exceeds its serving bound');
  return artifact;
}
