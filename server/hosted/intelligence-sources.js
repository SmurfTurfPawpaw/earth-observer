export { GROUPING_NOTE, groupReports } from '../../src/core/intelligence-grouping.js';
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
