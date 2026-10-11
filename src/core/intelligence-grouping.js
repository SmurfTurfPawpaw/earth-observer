export const GROUPING_NOTE = 'Related coverage is indicative. Similar headlines, locations or times do not establish independent confirmation; providers may share the same underlying source.';
const STOP_WORDS = new Set('the a an and or of for in on to at by from with as is are was were new latest report reports update says said after amid over more'.split(' '));
const words = (title) => new Set(String(title).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu)?.filter((word) => !STOP_WORDS.has(word)) || []);
const reportTime = (report) => Date.parse(report.kind === 'curated-event' ? report.sourceGeometryAt || report.closedAt || '' : report.observedAt || report.indexedAt || report.updatedAt || report.publishedAt || '');
function near(a, b) {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return false;
  const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h))) <= 80;
}
function relatedReason(a, b) {
  // A shared machine-generated topic label is not evidence of the same story.
  if (['topic-mention', 'curated-event'].includes(a.kind) || ['topic-mention', 'curated-event'].includes(b.kind)) return null;
  if (a.category !== b.category || a.source === b.source) return null;
  const difference = Math.abs(reportTime(a) - reportTime(b));
  if (!Number.isFinite(difference)) return null;
  if (a.eventType === 'EQ' && b.eventType === 'EQ' && difference <= 12 * 3600000 && near(a, b)) return 'Similar earthquake location and time; providers may use the same measurements';
  if (difference > 36 * 3600000) return null;
  const wa = words(a.title), wb = words(b.title);
  const common = [...wa].filter((word) => wb.has(word)).length;
  return common >= 3 && common / Math.max(wa.size, wb.size) >= 0.6 ? 'Similar headline and time; possible shared or syndicated coverage' : null;
}

/** Keep every original link separate; never synthesize a claim or a confirmation score.
 * Query callers can preserve index relevance order, including the primary link
 * in each group. Default feeds retain the original chronological ordering. */
export function groupReports(input, limit = 80, { preserveOrder = false } = {}) {
  const groups = [], seen = new Set();
  const reports = preserveOrder ? [...input] : [...input].sort((a, b) => (reportTime(b) || 0) - (reportTime(a) || 0));
  for (const report of reports) {
    if (seen.has(report.url)) continue;
    seen.add(report.url);
    const target = groups.find((candidate) => candidate.relatedReports.length < 5 && relatedReason(candidate, report));
    if (target) target.relatedReports.push({ ...report, relatedReports: [], relatedReason: relatedReason(target, report) });
    else groups.push({ ...report, relatedReports: [] });
  }
  const maximum = Math.max(0, Math.min(200, Number(limit) || 0));
  if (groups.length <= maximum) return groups;
  // Preserve each provider before filling by the selected order, so a dense
  // earthquake sequence cannot hide every flood or cyclone in the sample.
  const bucket = (group) => group.kind === 'topic-mention' ? `${group.sourceId}:${group.category}` : group.sourceId;
  const sources = [...new Set(groups.map(bucket).filter(Boolean))];
  const reserve = Math.min(10, Math.floor(maximum / Math.max(1, sources.length)));
  const selected = new Set();
  for (const source of sources) for (const group of groups.filter((group) => bucket(group) === source).slice(0, reserve)) selected.add(group);
  for (const group of groups) { if (selected.size >= maximum) break; selected.add(group); }
  return groups.filter((group) => selected.has(group));
}
