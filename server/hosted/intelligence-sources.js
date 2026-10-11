export const GROUPING_NOTE = 'Related coverage is indicative. Similar headlines, locations or times do not establish independent confirmation; providers may share the same underlying source.';
const clean = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export function safeReportUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
export function isoTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(typeof value === 'string' && !/[Zz]|[+-]\d\d:\d\d$/.test(value) ? `${value}Z` : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function gdeltTime(value) {
  const match = String(value || '').match(/^(\d{4})(\d\d)(\d\d)T?(\d\d)(\d\d)(\d\d)Z?$/);
  return match ? isoTime(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : isoTime(value);
}
// These public metadata keys retain the canonical identity exactly; truncating
// a hash could collapse unrelated reports. No key is an authentication token.
const identity = (source, value) => `${source}:${String(value)}`;
function point(coordinates) {
  const [lon, lat] = coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : {};
}
export function normalizeGdelt(payload, retrievedAt, category = 'all') {
  if (!Array.isArray(payload?.articles)) throw new Error('GDELT article metadata is invalid');
  return payload.articles.slice(0, 80).flatMap((article) => {
    const url = safeReportUrl(article.url), title = clean(article.title);
    if (!url || !title) return [];
    const inferred = /earthquake|flood|cyclone|hurricane|wildfire|disaster|volcan/i.test(title) ? 'disasters' : /trade|econom|tariff|inflation|shipping|market/i.test(title) ? 'economy' : 'geopolitics';
    return [{ id: identity('gdelt', url), title, url, sourceId: 'gdelt', source: new URL(url).hostname.replace(/^www\./, ''),
      aggregator: 'The GDELT Project', aggregatorUrl: 'https://www.gdeltproject.org/', category: category === 'all' ? inferred : category,
      publishedAt: null, observedAt: null, indexedAt: gdeltTime(article.seendate), retrievedAt,
      timeMeaning: 'GDELT indexing time; original publication time is not supplied',
      publisherCountry: clean(article.sourcecountry, 80) || null, language: clean(article.language, 40) || null,
      verification: 'Publisher report discovered by GDELT; claims have not been verified by Earth Observer', relatedReports: [] }];
  });
}
export function normalizeUsgs(payload, retrievedAt) {
  if (!Array.isArray(payload?.features)) throw new Error('USGS hazard feed is invalid');
  return payload.features.slice(0, 100).flatMap((feature) => {
    const props = feature.properties || {}, url = safeReportUrl(props.url), location = point(feature.geometry?.coordinates);
    if (!url || !url.startsWith('https://earthquake.usgs.gov/') || location.lat === undefined || !feature.id) return [];
    return [{ id: identity('usgs', feature.id), title: clean(props.title || `Earthquake · ${props.place || feature.id}`), url,
      sourceId: 'usgs', source: 'U.S. Geological Survey', category: 'disasters', eventType: 'EQ', ...location,
      observedAt: isoTime(props.time), publishedAt: null, updatedAt: isoTime(props.updated), indexedAt: null, retrievedAt,
      timeMeaning: 'Earthquake origin time; measurements and review status may change',
      magnitude: Number.isFinite(props.mag) ? props.mag : null, reviewStatus: clean(props.status, 40),
      verification: 'Scientific event report; consult USGS for revisions', relatedReports: [] }];
  });
}
export function normalizeGdacs(payload, retrievedAt) {
  if (!Array.isArray(payload?.features)) throw new Error('GDACS hazard feed is invalid');
  return payload.features.slice(0, 100).flatMap((feature) => {
    const props = feature.properties || {}, url = safeReportUrl(props.url?.report), location = point(feature.geometry?.coordinates);
    if (!url || !/^https:\/\/(www\.)?gdacs\.org\//i.test(url) || !props.eventid) return [];
    const countries = (Array.isArray(props.affectedcountries) ? props.affectedcountries : []).map((item) => clean(item.iso2, 2).toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
    return [{ id: identity('gdacs', `${props.eventtype}:${props.eventid}:${props.episodeid || ''}`), title: clean(props.name || props.eventname || 'GDACS disaster report'), url,
      sourceId: 'gdacs', source: 'Global Disaster Alert and Coordination System, GDACS', category: 'disasters',
      eventType: clean(props.eventtype, 8), ...location, countries, country: clean(props.country, 100),
      observedAt: isoTime(props.fromdate), publishedAt: null, updatedAt: isoTime(props.datemodified), indexedAt: null, retrievedAt,
      eventEndAt: isoTime(props.todate), alertLevel: clean(props.alertlevel, 30),
      measurementSource: clean(props.source, 100), timeMeaning: 'Event start and latest GDACS modification time',
      verification: 'GDACS modeled impact / automated notification; validate against national authorities', relatedReports: [] }];
  });
}
const STOP_WORDS = new Set('the a an and or of for in on to at by from with as is are was were new latest report reports update says said after amid over more'.split(' '));
const words = (title) => new Set(String(title).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu)?.filter((word) => !STOP_WORDS.has(word)) || []);
const reportTime = (report) => Date.parse(report.observedAt || report.indexedAt || report.updatedAt || report.publishedAt || '');
function near(a, b) {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return false;
  const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h))) <= 80;
}
function relatedReason(a, b) {
  // A shared machine-generated topic label is not evidence of the same story.
  if (a.kind === 'topic-mention' || b.kind === 'topic-mention') return null;
  if (a.category !== b.category || a.source === b.source) return null;
  const difference = Math.abs(reportTime(a) - reportTime(b));
  if (!Number.isFinite(difference)) return null;
  if (a.eventType === 'EQ' && b.eventType === 'EQ' && difference <= 12 * 3600000 && near(a, b)) return 'Similar earthquake location and time; providers may use the same measurements';
  if (difference > 36 * 3600000) return null;
  const wa = words(a.title), wb = words(b.title);
  const common = [...wa].filter((word) => wb.has(word)).length;
  return common >= 3 && common / Math.max(wa.size, wb.size) >= 0.6 ? 'Similar headline and time; possible shared or syndicated coverage' : null;
}
/** Keep every original link separate; never synthesize a claim or a confirmation score. */
export function groupReports(input, limit = 80) {
  const groups = [], seen = new Set();
  const reports = [...input].sort((a, b) => (reportTime(b) || 0) - (reportTime(a) || 0));
  for (const report of reports) {
    if (seen.has(report.url)) continue;
    seen.add(report.url);
    const target = groups.find((candidate) => candidate.relatedReports.length < 5 && relatedReason(candidate, report));
    if (target) target.relatedReports.push({ ...report, relatedReports: [], relatedReason: relatedReason(target, report) });
    else groups.push({ ...report, relatedReports: [] });
  }
  const maximum = Math.max(0, Math.min(200, Number(limit) || 0));
  if (groups.length <= maximum) return groups;
  // Preserve each provider before filling by recency, so a dense earthquake
  // sequence cannot hide every flood or cyclone in this bounded sample.
  const bucket = (group) => group.kind === 'topic-mention' ? `${group.sourceId}:${group.category}` : group.sourceId;
  const sources = [...new Set(groups.map(bucket).filter(Boolean))];
  const reserve = Math.min(10, Math.floor(maximum / Math.max(1, sources.length)));
  const selected = new Set();
  for (const source of sources) for (const group of groups.filter((group) => bucket(group) === source).slice(0, reserve)) selected.add(group);
  for (const group of groups) { if (selected.size >= maximum) break; selected.add(group); }
  return groups.filter((group) => selected.has(group));
}
