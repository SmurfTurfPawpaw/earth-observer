import { safeReportUrl } from './intelligence-sources.js';

export const GKG_CATEGORIES = Object.freeze(['geopolitics', 'economy', 'disasters']);
export const GKG_SOURCE = Object.freeze({ id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' });
// Exact identifiers reviewed against GDELT's official LOOKUP-GKGTHEMES.TXT.
export const GKG_THEMES = Object.freeze({
  ARMEDCONFLICT: ['geopolitics', 'Armed conflict'], ELECTION: ['geopolitics', 'Elections'],
  SANCTIONS: ['geopolitics', 'Sanctions'], NEGOTIATIONS: ['geopolitics', 'Negotiations'],
  ALLIANCE: ['geopolitics', 'Alliances'], BORDER: ['geopolitics', 'Borders'],
  PROTEST: ['geopolitics', 'Protests'], MILITARY: ['geopolitics', 'Military'],
  WB_2473_DIPLOMACY_AND_NEGOTIATIONS: ['geopolitics', 'Diplomacy'],
  WB_2462_POLITICAL_VIOLENCE_AND_WAR: ['geopolitics', 'Political violence and war'],
  WB_698_TRADE: ['economy', 'Trade'], EPU_ECONOMY: ['economy', 'Economy'],
  ECON_INFLATION: ['economy', 'Inflation'], ECON_STOCKMARKET: ['economy', 'Stock markets'],
  ECON_INTEREST_RATES: ['economy', 'Interest rates'], ECON_OILPRICE: ['economy', 'Oil prices'],
  ECON_CURRENCY_EXCHANGE_RATE: ['economy', 'Exchange rates'], ECON_DEBT: ['economy', 'Debt'],
  WB_793_TRANSPORT_AND_LOGISTICS_SERVICES: ['economy', 'Transport and logistics'],
  WB_471_ECONOMIC_GROWTH: ['economy', 'Economic growth'],
  NATURAL_DISASTER: ['disasters', 'Natural disasters'], DISASTER_FIRE: ['disasters', 'Fires'],
  MANMADE_DISASTER: ['disasters', 'Human-caused disasters'], EVACUATION: ['disasters', 'Evacuations'],
  HEALTH_PANDEMIC: ['disasters', 'Pandemics'], WB_2166_HEALTH_EMERGENCY_PREPAREDNESS_AND_DISASTER_RESPONSE: ['disasters', 'Emergency response'],
});

// Geography uses FIPS, NOT ISO. Explicit current-country crosswalk; obsolete,
// ocean and disputed-island entries with no unambiguous ISO counterpart are omitted.
// Primary reference: https://www.gdeltproject.org/data/lookups/FIPS.country.txt
// Correct its outdated GV/LO labels against NIST FIPS10-4 and USGS country codes:
// https://nvlpubs.nist.gov/nistpubs/Legacy/FIPS/fipspub10-4.pdf
// https://www.pwrc.usgs.gov/BBL/Bander_Portal/login/country_codes.php
export const GKG_FIPS_TO_ISO = Object.freeze(Object.fromEntries(`
AF:AF AL:AL AG:DZ AQ:AS AN:AD AO:AO AV:AI AY:AQ AC:AG AR:AR AM:AM AA:AW AS:AU AU:AT AJ:AZ
BF:BS BA:BH BG:BD BB:BB BO:BY BE:BE BH:BZ BN:BJ BD:BM BT:BT BL:BO BK:BA BC:BW BV:BV BR:BR IO:IO VI:VG BX:BN BU:BG UV:BF BY:BI
CB:KH CM:CM CA:CA CV:CV CJ:KY CT:CF CD:TD CI:CL CH:CN KT:CX CK:CC CO:CO CN:KM CF:CG CW:CK CS:CR IV:CI HR:HR CU:CU CY:CY EZ:CZ CG:CD
DA:DK DJ:DJ DO:DM DR:DO TT:TL EC:EC EG:EG ES:SV GV:GN EK:GQ ER:ER EN:EE ET:ET FK:FK FO:FO FJ:FJ FI:FI FR:FR FG:GF FP:PF FS:TF
GB:GA GA:GM GZ:PS GG:GE GM:DE GH:GH GI:GI GR:GR GL:GL GJ:GD GP:GP GQ:GU GT:GT GK:GG PU:GW GY:GY HA:HT HM:HM HO:HN HK:HK HU:HU
IC:IS IN:IN ID:ID IR:IR IZ:IQ EI:IE IM:IM IS:IL IT:IT JM:JM JA:JP JE:JE JO:JO KZ:KZ KE:KE KR:KI KV:XK KU:KW KG:KG LA:LA LG:LV LE:LB LT:LS LI:LR LY:LY LS:LI LH:LT LO:SK LU:LU
MC:MO MK:MK MA:MG MI:MW MY:MY MV:MV ML:ML MT:MT RM:MH MB:MQ MR:MR MP:MU MF:YT MX:MX FM:FM MD:MD MN:MC MG:MN MJ:ME MH:MS MO:MA MZ:MZ BM:MM
WA:NA NR:NR NP:NP NL:NL NC:NC NZ:NZ NU:NI NG:NE NI:NG NE:NU NF:NF KN:KP CQ:MP NO:NO MU:OM PK:PK PS:PW PM:PA PP:PG PA:PY PE:PE RP:PH PC:PN PL:PL PO:PT RQ:PR QA:QA RE:RE RO:RO RS:RU RW:RW
SH:SH SC:KN ST:LC RN:MF SB:PM VC:VC TB:BL WS:WS SM:SM TP:ST SA:SA SG:SN RI:RS SE:SC SL:SL SN:SG SI:SI BP:SB SO:SO SF:ZA SX:GS KS:KR OD:SS SP:ES CE:LK SU:SD NS:SR SV:SJ WZ:SZ SW:SE SZ:CH SY:SY
TW:TW TI:TJ TZ:TZ TH:TH TO:TG TL:TK TN:TO TD:TT TS:TN TU:TR TX:TM TK:TC TV:TV UG:UG UP:UA AE:AE UK:GB US:US UY:UY UZ:UZ NH:VU VT:VA VE:VE VM:VN VQ:VI WF:WF WE:PS WI:EH YM:YE ZA:ZM ZI:ZW
`.trim().split(/\s+/).map((entry) => entry.split(':'))));
const DAY = 86400000, STEP = 900000;
const ISO_COUNTRIES = new Set(Object.values(GKG_FIPS_TO_ISO));
const UTF8 = new TextEncoder();
export function gkgBatchTime(value) {
  const match = typeof value === 'string' && /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(value);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso && time % STEP === 0 ? iso : null;
}
const batchId = (time) => new Date(time).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
export function gkgTopicReport({ url: value, themes, mentionedCountries = [], batch, retrievedAt, category }) {
  const url = safeReportUrl(value), indexedAt = gkgBatchTime(batch);
  if (!url || !indexedAt || !GKG_CATEGORIES.includes(category)) return null;
  const selected = [...new Set(themes || [])].filter((theme) => Object.hasOwn(GKG_THEMES, theme)).sort();
  if (!selected.some((theme) => GKG_THEMES[theme][0] === category)) return null;
  const countries = [...new Set(mentionedCountries)].filter((code) => ISO_COUNTRIES.has(code)).sort().slice(0, 32);
  const labels = [...new Set(selected.filter((theme) => GKG_THEMES[theme][0] === category).map((theme) => GKG_THEMES[theme][1]))];
  return { id: `gdelt-gkg:${url}`, kind: 'topic-mention', title: `Topic mention · ${labels.slice(0, 3).join(', ')}`,
    url, sourceId: 'gdelt', source: new URL(url).hostname.replace(/^www\./, ''), aggregator: GKG_SOURCE.name,
    aggregatorUrl: GKG_SOURCE.url, category, themes: selected, mentionedCountries: countries, batch,
    publishedAt: null, observedAt: null, indexedAt, retrievedAt, publisherCountry: null, language: null,
    timeMeaning: 'GDELT update batch time; original publication and incident times are not supplied',
    verification: 'Machine-extracted topic and country mentions; consult the original publisher. These are not verified incidents or independent corroboration.', relatedReports: [] };
}

/** GKG 2.1 is 27 tab-separated fields; use only WEB URLs, themes and country mentions. */
export function parseGkgRow(line, { batch, retrievedAt } = {}) {
  if (typeof line !== 'string' || line.length > 524288 || UTF8.encode(line).byteLength > 524288) throw new Error('GKG row exceeds its limit');
  const fields = line.replace(/\r$/, '').split('\t');
  if (fields.length !== 27 || !gkgBatchTime(batch)) throw new Error('Unexpected GKG 2.1 row');
  if (fields[2] !== '1') return []; // No citation-only, subscription repository or television proxy records.
  if (!new RegExp(`^${batch}-T?\\d+$`).test(fields[0]) || fields[1] !== batch) throw new Error('GKG batch identity mismatch');
  const themes = fields[7].split(';').filter((value) => Object.hasOwn(GKG_THEMES, value));
  const countries = [...new Set(fields[9].split(';').map((location) => GKG_FIPS_TO_ISO[location.split('#')[2]]).filter(Boolean))];
  return GKG_CATEGORIES.map((category) => gkgTopicReport({ url: fields[4], themes, mentionedCountries: countries, batch, retrievedAt, category })).filter(Boolean);
}

export function gkgCoverage(processedBatches) {
  const batches = [...processedBatches].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set(batches.map((batch) => batch.id)), gaps = [];
  if (batches.length) for (let time = Date.parse(gkgBatchTime(batches[0].id)); time <= Date.parse(gkgBatchTime(batches.at(-1).id)); time += STEP)
    if (!seen.has(batchId(time))) gaps.push(batchId(time));
  return { timespan: '24h', maxRecordsPerCategory: 80, categories: [...GKG_CATEGORIES], sampled: true,
    batchIntervalMinutes: 15, scheduledIntervalMinutes: 30, processedBatches: batches, sampleGaps: gaps,
    windowStart: batches.length ? gkgBatchTime(batches[0].id) : null, windowEnd: batches.length ? gkgBatchTime(batches.at(-1).id) : null,
    note: 'Bounded sample of processed GDELT batches; gaps and records omitted by topic, country and publisher quotas are not evidence of absence. Country filters match countries mentioned, not publisher countries or incident locations.' };
}
/** Preserve topic/country/publisher diversity rather than taking the first TSV rows. */
function balanced(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = `${row.mentionedCountries[0] || '?'}:${row.source}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const groups = [...buckets.values()].sort((a, b) => b[0].indexedAt.localeCompare(a[0].indexedAt) || a[0].url.localeCompare(b[0].url));
  const selected = [], countryCounts = new Map(), publisherCounts = new Map();
  for (let pass = 0; selected.length < 80; pass++) {
    let added = 0;
    for (const group of groups) {
      const row = group[pass]; if (!row || selected.length >= 80) continue;
      const country = row.mentionedCountries[0] || '?';
      if (pass < 3 && ((countryCounts.get(country) || 0) >= 8 || (publisherCounts.get(row.source) || 0) >= 4)) continue;
      selected.push(row); added++; countryCounts.set(country, (countryCounts.get(country) || 0) + 1); publisherCounts.set(row.source, (publisherCounts.get(row.source) || 0) + 1);
    }
    if (!added && pass >= 3) break;
  }
  return selected.sort((a, b) => b.indexedAt.localeCompare(a.indexedAt) || a.url.localeCompare(b.url));
}
export function createGkgSnapshot({ reports, processedBatches, generatedAt }) {
  const now = Date.parse(generatedAt), uniqueBatches = new Map();
  for (const entry of processedBatches) {
    const time = Date.parse(gkgBatchTime(entry.id));
    if (Number.isFinite(time) && time <= now + 300000 && now - time <= DAY) uniqueBatches.set(entry.id, { id: entry.id, retrievedAt: entry.retrievedAt, rows: entry.rows, matchedRecords: entry.matchedRecords });
  }
  const batches = [...uniqueBatches.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(-96);
  const retained = new Set(batches.map((entry) => entry.id)), categories = {};
  for (const category of GKG_CATEGORIES) {
    const unique = new Map();
    const rows = reports.filter((row) => row.category === category && retained.has(row.batch)).sort((a, b) => b.indexedAt.localeCompare(a.indexedAt));
    for (const row of rows) if (!unique.has(row.url)) unique.set(row.url, row);
    categories[category] = { reports: balanced([...unique.values()]) };
  }
  return { schemaVersion: 2, kind: 'gkg-topic-sample', generatedAt, source: { ...GKG_SOURCE }, coverage: gkgCoverage(batches), categories };
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonicalStamp = (value) => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keysOnly = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
/** Canonical, tiny portable contract; rejects full text, images and asserted coordinates. */
export function validateGkgSnapshot(payload, nowMs = Date.now()) {
  if (!isObject(payload) || payload.schemaVersion !== 2 || payload.kind !== 'gkg-topic-sample' ||
      !keysOnly(payload, ['schemaVersion', 'kind', 'generatedAt', 'source', 'coverage', 'categories']) ||
      !isObject(payload.source) || !keysOnly(payload.source, Object.keys(GKG_SOURCE)) || Object.entries(GKG_SOURCE).some(([key, value]) => payload.source[key] !== value) || !canonicalStamp(payload.generatedAt) ||
      !isObject(payload.coverage) || !Array.isArray(payload.coverage.processedBatches) ||
      !payload.coverage.processedBatches.length || payload.coverage.processedBatches.length > 96 ||
      !isObject(payload.categories) || Object.keys(payload.categories).length !== 3) throw new Error('Invalid GKG snapshot schema');
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 1048576) throw new Error('GKG snapshot exceeds its byte limit');
  const generated = Date.parse(payload.generatedAt), seenBatches = new Map();
  if (generated > nowMs + 300000 || nowMs - generated > DAY) throw new Error('GKG snapshot is expired or future-dated');
  for (const entry of payload.coverage.processedBatches) {
    if (!isObject(entry) || !keysOnly(entry, ['id', 'retrievedAt', 'rows', 'matchedRecords']) || !gkgBatchTime(entry.id) ||
        !canonicalStamp(entry.retrievedAt) || seenBatches.has(entry.id) || !Number.isInteger(entry.rows) || entry.rows < 0 || entry.rows > 50000 ||
        !Number.isInteger(entry.matchedRecords) || entry.matchedRecords < 0 || entry.matchedRecords > entry.rows * 3) throw new Error('Invalid GKG processed batch');
    const time = Date.parse(gkgBatchTime(entry.id)), retrieved = Date.parse(entry.retrievedAt);
    if (generated - time > DAY || time > generated + 300000 || retrieved > generated || retrieved < time - 300000 || generated - retrieved > DAY) throw new Error('Invalid GKG batch time');
    seenBatches.set(entry.id, entry);
  }
  const coverage = gkgCoverage([...seenBatches.values()]);
  if (!keysOnly(payload.coverage, Object.keys(coverage)) || Object.keys(coverage).some((key) => !same(payload.coverage[key], coverage[key]))) throw new Error('Invalid GKG sampling coverage');
  const categories = {};
  for (const category of GKG_CATEGORIES) {
    const entry = payload.categories[category], seen = new Set();
    if (!isObject(entry) || !keysOnly(entry, ['reports']) || !Array.isArray(entry.reports) || entry.reports.length > 80) throw new Error('Invalid GKG category');
    const reports = entry.reports.map((report) => {
      const batch = seenBatches.get(report?.batch);
      if (!isObject(report) || !batch || report.kind !== 'topic-mention' || report.category !== category || report.retrievedAt !== batch.retrievedAt ||
          !Array.isArray(report.themes) || report.themes.length > Object.keys(GKG_THEMES).length || !Array.isArray(report.mentionedCountries) || report.mentionedCountries.length > 32 || seen.has(report.url)) throw new Error('Invalid GKG report');
      const canonical = gkgTopicReport(report);
      if (!canonical || !keysOnly(report, Object.keys(canonical)) || Object.keys(canonical).some((key) => !same(report[key], canonical[key]))) throw new Error('Invalid GKG report provenance');
      seen.add(report.url); return canonical;
    });
    categories[category] = { reports };
  }
  return { schemaVersion: 2, kind: 'gkg-topic-sample', generatedAt: payload.generatedAt, source: { ...GKG_SOURCE }, coverage, categories };
}
