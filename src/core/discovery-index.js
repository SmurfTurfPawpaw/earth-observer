export const DISCOVERY_INDEX_SCHEMA_VERSION = 1;
export const DISCOVERY_INDEX_MAX_RECORDS = 600;
export const DISCOVERY_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const DISCOVERY_INDEX_NOTE = 'Search covers only retained metadata: titles or generated topic labels, reviewed topics, publishers and explicitly attributed country fields. It does not search article text or establish complete coverage, an incident location, confidence or truth.';
const DAY = 86400000, SOURCE_IDS = new Set(['gdelt', 'usgs', 'gdacs']);
const CATEGORY_NAMES = { geopolitics: 'Geopolitics', economy: 'Economics and trade', disasters: 'Disasters' };
const CATEGORIES = Object.keys(CATEGORY_NAMES);
// Kept in sync with the reviewed GKG taxonomy by a primary-contract test.
export const DISCOVERY_REVIEWED_TOPICS = Object.freeze({
  ARMEDCONFLICT: ['geopolitics', 'Armed conflict'], ELECTION: ['geopolitics', 'Elections'], SANCTIONS: ['geopolitics', 'Sanctions'],
  NEGOTIATIONS: ['geopolitics', 'Negotiations'], ALLIANCE: ['geopolitics', 'Alliances'], BORDER: ['geopolitics', 'Borders'],
  PROTEST: ['geopolitics', 'Protests'], MILITARY: ['geopolitics', 'Military'],
  WB_2473_DIPLOMACY_AND_NEGOTIATIONS: ['geopolitics', 'Diplomacy'], WB_2462_POLITICAL_VIOLENCE_AND_WAR: ['geopolitics', 'Political violence and war'],
  WB_698_TRADE: ['economy', 'Trade'], EPU_ECONOMY: ['economy', 'Economy'], ECON_INFLATION: ['economy', 'Inflation'],
  ECON_STOCKMARKET: ['economy', 'Stock markets'], ECON_INTEREST_RATES: ['economy', 'Interest rates'], ECON_OILPRICE: ['economy', 'Oil prices'],
  ECON_CURRENCY_EXCHANGE_RATE: ['economy', 'Exchange rates'], ECON_DEBT: ['economy', 'Debt'],
  WB_793_TRANSPORT_AND_LOGISTICS_SERVICES: ['economy', 'Transport and logistics'], WB_471_ECONOMIC_GROWTH: ['economy', 'Economic growth'],
  NATURAL_DISASTER: ['disasters', 'Natural disasters'], DISASTER_FIRE: ['disasters', 'Fires'], MANMADE_DISASTER: ['disasters', 'Human-caused disasters'],
  EVACUATION: ['disasters', 'Evacuations'], HEALTH_PANDEMIC: ['disasters', 'Pandemics'],
  WB_2166_HEALTH_EMERGENCY_PREPAREDNESS_AND_DISASTER_RESPONSE: ['disasters', 'Emergency response'],
});
export const discoveryQueryText = (value) => {
  const query = String(value || '').trim();
  return DISCOVERY_REVIEWED_TOPICS[query.toUpperCase()]?.[1] || query;
};
const COUNTRY_ALIASES = {
  UA: ['Ukraine'], US: ['United States', 'United States of America', 'USA', 'U.S.', 'U.S.A.'], GB: ['United Kingdom', 'UK', 'Britain', 'Great Britain'],
  CN: ['China', "People's Republic of China", 'PRC'], RU: ['Russia', 'Russian Federation'], KR: ['South Korea', 'Republic of Korea'], KP: ['North Korea'],
  CD: ['Democratic Republic of the Congo', 'DR Congo', 'DRC'], CG: ['Republic of the Congo'], CI: ["Côte d’Ivoire", "Cote d'Ivoire", 'Ivory Coast'],
  CZ: ['Czechia', 'Czech Republic'], SZ: ['Eswatini', 'Swaziland'], TR: ['Türkiye', 'Turkey'], MM: ['Myanmar', 'Burma'],
  IR: ['Iran', 'Islamic Republic of Iran'], LA: ['Laos', 'Lao PDR'], VN: ['Vietnam', 'Viet Nam'], PS: ['Palestine', 'Palestinian Territories', 'State of Palestine'],
  SY: ['Syria', 'Syrian Arab Republic'], BO: ['Bolivia'], TZ: ['Tanzania'], MD: ['Moldova'], VE: ['Venezuela'], CV: ['Cabo Verde', 'Cape Verde'],
};
const NAMES = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }) : null;
const text = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const fold = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const tokens = (value) => fold(value).match(/[\p{L}\p{N}]+/gu) || [];
const stamp = (value) => { const at = value && Date.parse(value); return Number.isFinite(at) ? new Date(at).toISOString() : null; };
const time = (value) => Number.isFinite(value) ? value : Date.parse(value || '');
const identity = (record) => `${record.kind}\n${record.url}`;
const recordTime = (record) => time(record.publishedAt || record.observedAt || record.indexedAt || record.updatedAt || record.retrievedAt) || 0;
function countryInfo(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code) || ['ZZ', 'EU', 'UN', 'QO', 'XA', 'XB'].includes(code)) return null;
  let name; try { name = NAMES?.of(code); } catch {}
  name ||= COUNTRY_ALIASES[code]?.[0];
  return name ? { code, name, aliases: [code, name, ...(COUNTRY_ALIASES[code] || [])] } : null;
}
const countries = (value) => [...new Set((Array.isArray(value) ? value : []).filter((code) => countryInfo(code)))].sort().slice(0, 32);
export function canonicalDiscoveryUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return null;
    url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

/** Whitelisted source metadata only; never retains bodies, images or topic-mention coordinates. */
export function canonicalDiscoveryRecord(value) {
  if (!value || typeof value !== 'object' || !SOURCE_IDS.has(value.sourceId)) return null;
  const url = canonicalDiscoveryUrl(value.url); if (!url) return null;
  const kind = value.kind === 'topic-mention' ? 'topic-mention' : value.sourceId === 'gdelt' ? 'article-link' : 'hazard-report';
  if (kind === 'topic-mention' && (value.sourceId !== 'gdelt' || value.publishedAt != null || value.observedAt != null)) return null;
  const themes = [...new Set((Array.isArray(value.themes) ? value.themes : []).filter((code) => Object.hasOwn(DISCOVERY_REVIEWED_TOPICS, code)))].sort();
  if (kind === 'topic-mention' && !themes.length) return null;
  const categories = [...new Set([value.category, ...(Array.isArray(value.categories) ? value.categories : []),
    ...(kind === 'topic-mention' ? themes.map((code) => DISCOVERY_REVIEWED_TOPICS[code][0]) : [])])].filter((category) => CATEGORIES.includes(category)).sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
  if (!categories.length) return null;
  const category = categories.includes(value.category) ? value.category : categories[0], publisher = new URL(url).hostname.replace(/^www\./, '');
  const reviewedTopics = [...new Set(themes.map((code) => DISCOVERY_REVIEWED_TOPICS[code][1]))];
  const title = kind === 'topic-mention' ? `Topic mention · ${themes.filter((code) => DISCOVERY_REVIEWED_TOPICS[code][0] === category).map((code) => DISCOVERY_REVIEWED_TOPICS[code][1]).slice(0, 3).join(', ')}` : text(value.title);
  if (!title) return null;
  const record = { id: text(value.id, 2400) || `${value.sourceId}:${kind}:${url}`, url, kind, title, sourceId: value.sourceId,
    source: text(value.source, 253) || publisher, publisher, category, categories, themes, reviewedTopics,
    mentionedCountries: kind === 'topic-mention' ? countries(value.mentionedCountries) : [],
    countries: kind === 'hazard-report' ? countries(value.countries) : [],
    publishedAt: kind === 'topic-mention' ? null : stamp(value.publishedAt), observedAt: kind === 'topic-mention' ? null : stamp(value.observedAt),
    indexedAt: stamp(value.indexedAt), updatedAt: kind === 'topic-mention' ? null : stamp(value.updatedAt), retrievedAt: stamp(value.retrievedAt),
    publisherCountry: kind === 'topic-mention' ? null : text(value.publisherCountry, 80) || null,
    verification: text(value.verification, 400), timeMeaning: text(value.timeMeaning, 250), relatedReports: [] };
  for (const key of ['aggregator', 'language', ...(kind === 'topic-mention' ? ['batch'] : []), ...(kind === 'hazard-report' ? ['country', 'eventType', 'reviewStatus', 'alertLevel', 'measurementSource'] : [])]) if (text(value[key], 120)) record[key] = text(value[key], 120);
  const aggregatorUrl = canonicalDiscoveryUrl(value.aggregatorUrl); if (aggregatorUrl) record.aggregatorUrl = aggregatorUrl;
  if (kind === 'hazard-report') {
    if (Number.isFinite(value.lat) && Number.isFinite(value.lon) && Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180) { record.lat = value.lat; record.lon = value.lon; }
    if (Number.isFinite(value.magnitude)) record.magnitude = value.magnitude;
    if (stamp(value.eventEndAt)) record.eventEndAt = stamp(value.eventEndAt);
  }
  return record;
}
function mergeRecords(a, b) {
  const newer = recordTime(b) > recordTime(a) ? b : a;
  // Older mentions must not inherit a newer batch's timestamp or expiry.
  if (a.kind === 'topic-mention' && a.indexedAt !== b.indexedAt) return newer;
  const categories = [...new Set([...a.categories, ...b.categories])].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
  const themes = [...new Set([...a.themes, ...b.themes])].sort();
  return { ...newer, categories, themes, reviewedTopics: [...new Set(themes.map((code) => DISCOVERY_REVIEWED_TOPICS[code][1]))],
    mentionedCountries: [...new Set([...a.mentionedCountries, ...b.mentionedCountries])].sort().slice(0, 32), countries: [...new Set([...a.countries, ...b.countries])].sort().slice(0, 32) };
}
function fieldsFor(record) {
  const fields = [], add = (label, value, weight = 2, searchable = value) => { if (value) fields.push({ label, value, weight, words: tokens(searchable) }); };
  add(record.kind === 'topic-mention' ? 'Generated topic label' : 'Title', record.title, 6);
  for (const topic of record.reviewedTopics) add('Reviewed topic', topic, 5);
  for (const code of record.mentionedCountries) { const info = countryInfo(code); add('Country mentioned', `${info.name} (${code})`, 5, info.aliases.join(' ')); }
  for (const code of record.countries) { const info = countryInfo(code); add('Reported country', `${info.name} (${code})`, 5, info.aliases.join(' ')); }
  add('Reported country name', record.country, 5); add('Publisher domain', record.publisher, 3); add('Publisher country', record.publisherCountry, 3);
  add('Source', record.source); for (const category of record.categories) add('Category', CATEGORY_NAMES[category], 2, `${category} ${CATEGORY_NAMES[category]}`);
  return fields;
}
const matches = (field, term) => field.words.some((word) => word === term || term.length >= 3 && word.startsWith(term));
function countryMatch(record, code) {
  if (!code) return '';
  const info = countryInfo(code); if (!info) return null;
  if (record.mentionedCountries.includes(code)) return `Country filter: ${info.name} (${code}) is mentioned; this does not establish an incident location.`;
  if (record.countries.includes(code)) return `Country filter: ${info.name} (${code}) is reported by ${record.source}.`;
  if (record.kind === 'article-link' && info.aliases.filter((alias) => alias.length > 2).some((alias) => fold(record.title).includes(fold(alias))))
    return `Country filter: the title mentions ${info.name}; no authoritative incident-country tag is supplied.`;
  return null;
}
function diversified(rows, limit) {
  const selected = [], chosen = new Set(), publishers = new Map(), topics = new Map();
  const topicCount = new Set(rows.map((row) => row.record.category)).size, topicLimit = Math.max(4, Math.ceil(limit / Math.max(1, topicCount)));
  for (const row of rows) {
    if ((publishers.get(row.record.publisher) || 0) >= 4 || (topics.get(row.record.category) || 0) >= topicLimit) continue;
    selected.push(row); chosen.add(row); publishers.set(row.record.publisher, (publishers.get(row.record.publisher) || 0) + 1); topics.set(row.record.category, (topics.get(row.record.category) || 0) + 1);
    if (selected.length >= limit) return selected;
  }
  for (const row of rows) { if (!chosen.has(row)) selected.push(row); if (selected.length >= limit) break; }
  return selected;
}
const byteLength = (record) => new TextEncoder().encode(JSON.stringify(record)).byteLength;
function frozen(record) { for (const value of Object.values(record)) if (Array.isArray(value)) Object.freeze(value); return Object.freeze(record); }

/** An incremental, portable metadata index. Limits describe serialized records, not JS heap size. */
export function createDiscoveryIndex({ now = Date.now, maxRecords = DISCOVERY_INDEX_MAX_RECORDS, maxBytes = DISCOVERY_INDEX_MAX_BYTES } = {}) {
  maxRecords = Math.max(1, Math.min(DISCOVERY_INDEX_MAX_RECORDS, Number(maxRecords) || DISCOVERY_INDEX_MAX_RECORDS));
  maxBytes = Math.max(1, Math.min(DISCOVERY_INDEX_MAX_BYTES, Number(maxBytes) || DISCOVERY_INDEX_MAX_BYTES));
  let entries = new Map(), version = 0, storedBytes = 2, omittedRecords = 0;
  const sources = new Map();
  function rebuild(values) {
    const candidates = [...values].sort((a, b) => recordTime(b.record) - recordTime(a.record) || identity(a.record).localeCompare(identity(b.record)));
    const next = new Map(); let bytes = 2;
    // Reserve a small share for every source before filling by metadata time.
    const ordered = [], seen = new Set();
    for (const id of sources.keys()) for (const entry of candidates.filter((entry) => entry.record.sourceId === id).slice(0, 10)) { ordered.push(entry); seen.add(entry); }
    ordered.push(...candidates.filter((entry) => !seen.has(entry)));
    for (const entry of ordered) {
      const size = byteLength(entry.record) + (next.size ? 1 : 0);
      if (next.size >= maxRecords || bytes + size > maxBytes) continue;
      next.set(identity(entry.record), entry); bytes += size;
    }
    omittedRecords = Math.max(0, candidates.length - next.size); entries = next; storedBytes = bytes;
  }
  function expire() {
    const at = now(), active = [...entries.values()].filter((entry) => entry.expiresAt > at);
    if (active.length !== entries.size) { rebuild(active); version++; }
  }
  function replaceSource({ id, generation, records, expiresAt, coverage = '', status = 'ready' } = {}) {
    if (!SOURCE_IDS.has(id) || !Array.isArray(records)) throw new TypeError('A supported metadata source and records are required');
    const incomingGeneration = text(String(generation || ''), 160), previous = sources.get(id);
    const declaredExpiry = time(expiresAt), latestRetrieval = Math.max(0, ...records.slice(0, 1200).map((record) => time(record?.retrievedAt) || 0));
    const sourceExpiry = Number.isFinite(declaredExpiry) ? declaredExpiry : latestRetrieval ? latestRetrieval + DAY : 0;
    const metadata = { id, generation: incomingGeneration, expiresAt: sourceExpiry ? new Date(sourceExpiry).toISOString() : null,
      coverage: text(coverage, 2000), status: text(status, 30) };
    if (previous && previous.generation === incomingGeneration && previous.expiresAt === metadata.expiresAt) { sources.set(id, metadata); expire(); return false; }
    const changed = new Map();
    for (const value of records.slice(0, 1200)) {
      const record = canonicalDiscoveryRecord(value); if (!record || record.sourceId !== id) continue;
      const key = identity(record), prior = changed.get(key); changed.set(key, prior ? mergeRecords(prior, record) : record);
    }
    const replacement = [...entries.values()].filter((entry) => entry.record.sourceId !== id);
    for (const record of changed.values()) {
      const batchExpiry = record.kind === 'topic-mention' ? time(record.indexedAt) + DAY : sourceExpiry;
      const recordExpiry = Math.min(sourceExpiry, batchExpiry);
      if (Number.isFinite(recordExpiry) && recordExpiry > now()) replacement.push({ record: frozen(record), expiresAt: recordExpiry, fields: fieldsFor(record) });
    }
    sources.set(id, metadata); rebuild(replacement); version++; expire(); return true;
  }
  function getState() {
    expire(); const records = [...entries.values()].map((entry) => entry.record);
    return { schemaVersion: DISCOVERY_INDEX_SCHEMA_VERSION, indexVersion: version, recordCount: records.length, byteLength: storedBytes,
      omittedRecords, records, sources: [...sources.values()].map((source) => ({ ...source, recordCount: records.filter((record) => record.sourceId === source.id).length })), note: DISCOVERY_INDEX_NOTE };
  }
  function replacePayload(payload) {
    if (!Array.isArray(payload?.indexRecords) || payload.indexCoverage?.schemaVersion !== DISCOVERY_INDEX_SCHEMA_VERSION || !Array.isArray(payload.indexCoverage.sources)) throw new TypeError('The metadata index payload is invalid');
    let changed = false;
    for (const source of payload.indexCoverage.sources.slice(0, 3)) changed = replaceSource({ ...source, records: payload.indexRecords.filter((record) => record.sourceId === source.id) }) || changed;
    return changed;
  }
  function search({ q = '', category = 'all', country = '', limit = 80 } = {}) {
    expire(); q = text(q, 65); if (q.length > 64) throw new TypeError('Search is limited to 64 characters');
    if (category !== 'all' && !CATEGORIES.includes(category)) throw new TypeError('Unknown discovery category');
    country = String(country || '').toUpperCase(); if (country && !countryInfo(country)) throw new TypeError('Unknown discovery country');
    const terms = [...new Set(tokens(q))], rows = [];
    for (const entry of entries.values()) {
      if (category !== 'all' && !entry.record.categories.includes(category)) continue;
      const countryReason = countryMatch(entry.record, country); if (countryReason === null) continue;
      const reasons = countryReason ? [countryReason] : []; let relevance = 0, accepted = true;
      for (const term of terms) {
        const matched = entry.fields.filter((field) => matches(field, term)).sort((a, b) => b.weight - a.weight);
        if (!matched.length) { accepted = false; break; }
        relevance += matched[0].weight;
        for (const field of matched.slice(0, 3)) reasons.push(`${field.label} “${field.value}” matches “${term}”.`);
      }
      if (!accepted) continue;
      rows.push({ record: category === 'all' ? entry.record : { ...entry.record, category,
        ...(entry.record.kind === 'topic-mention' ? { title: `Topic mention · ${entry.record.themes.filter((code) => DISCOVERY_REVIEWED_TOPICS[code][0] === category).map((code) => DISCOVERY_REVIEWED_TOPICS[code][1]).slice(0, 3).join(', ')}` } : {}) }, relevance, reasons: [...new Set(reasons)] });
    }
    const kindOrder = { 'hazard-report': 0, 'article-link': 1, 'topic-mention': 2 };
    rows.sort((a, b) => b.relevance - a.relevance || recordTime(b.record) - recordTime(a.record) || kindOrder[a.record.kind] - kindOrder[b.record.kind] || a.record.url.localeCompare(b.record.url));
    limit = Math.max(0, Math.min(DISCOVERY_INDEX_MAX_RECORDS, Math.floor(Number(limit) || 0)));
    const selected = limit ? diversified(rows, limit) : [];
    return { reports: selected.map(({ record, reasons }) => ({ ...record, matchReasons: reasons })), matchCount: rows.length,
      indexedRecords: entries.size, indexVersion: version, coverage: DISCOVERY_INDEX_NOTE,
      ranking: 'Metadata term matches, then source time and record kind, with publisher and topic diversity. This ordering is not a confidence, truth or popularity score.' };
  }
  return { replaceSource, replacePayload, search, getState, clear() { entries.clear(); sources.clear(); storedBytes = 2; omittedRecords = 0; version++; } };
}
