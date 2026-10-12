const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : null;
const officialLink = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'earthquake.usgs.gov' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};

/** A retained event's readable evidence surface; no additional acquisition. */
export function createWorldDossier(entity, time, { documentRef = globalThis.document } = {}) {
  const event = entity?.properties?.getValue?.(time)?._worldEvent;
  if (!event || event.schemaVersion !== 1 || !/^event:usgs:[a-f0-9]{64}$/.test(event.id) ||
      event.source?.id !== 'usgs' || event.kind !== 'earthquake' || !digest(event.evidence?.revision) ||
      !digest(event.evidence?.snapshotId) || !Number.isFinite(event.place?.lat) || Math.abs(event.place.lat) > 90 ||
      !Number.isFinite(event.place?.lon) || Math.abs(event.place.lon) > 180) return null;
  const url = officialLink(event.source.url); if (!url) return null;
  const node = (tag, className, text) => {
    const element = documentRef.createElement(tag); if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text); return element;
  };
  const dossier = node('article', 'world-dossier');
  dossier.append(node('p', 'world-kicker', 'Earthquake · source report'));
  const source = node('a', 'world-source', 'Read the USGS report'); source.href = url;
  source.target = '_blank'; source.rel = 'noopener noreferrer'; dossier.append(source);
  const facts = node('dl', 'world-facts');
  const field = (label, value) => { if (value !== undefined && value !== null && value !== '') facts.append(node('dt', '', label), node('dd', '', value)); };
  field('Magnitude', Number.isFinite(event.reportedFacts?.magnitude) ? event.reportedFacts.magnitude : 'Not reported');
  field('Review', event.reportedFacts?.reviewStatus || 'Not reported');
  field('Epicenter', `${event.place.lat.toFixed(4)}°, ${event.place.lon.toFixed(4)}°`);
  field('Occurred', stamp(event.eventTime?.at) || 'Not reported');
  field('Source revised', stamp(event.sourceTimes?.updatedAt));
  field('First retained', stamp(event.knowledge?.firstRecordedAt));
  dossier.append(facts);
  const context = entity?.properties?.getValue?.(time)?._worldScene;
  const report = entity?.properties?.getValue?.(time)?._worldReport;
  dossier.append(node('p', 'world-dossier-note', report?.kind === 'retained-source-context' ?
    'Retained source report. Its occurrence and evidence dates are independent of the selected globe time; opening it does not add a map feature.' : context?.mode === 'reconstruction' ?
    'Historical reconstruction uses retained USGS corrections. The event date and the date this platform retained evidence are separate.' :
    context?.mode === 'as-known' ? 'This historical scene includes only evidence this platform published by the selected UTC.' :
    'Location and measurements come from USGS. The report may be revised as evidence develops.'));
  const evidence = node('details', 'world-evidence'); evidence.append(node('summary', '', 'Evidence and dates'));
  const dates = node('dl', 'world-facts');
  for (const [label, value] of [['Source retrieved', stamp(event.sourceTimes?.retrievedAt)],
    ['First captured', stamp(event.knowledge?.firstCapturedAt)], ['Selected capture', stamp(event.capture?.capturedAt)],
    ['Capture published', stamp(event.capture?.publishedAt)], ['Archive retrieved', stamp(event.archive?.capturedAt)],
    ['Archive published', stamp(event.archive?.publishedAt)]]) {
    if (value) dates.append(node('dt', '', label), node('dd', '', value));
  }
  dates.append(node('dt', '', 'Source revision'), node('dd', 'world-evidence-id', event.evidence.revision),
    node('dt', '', 'Retained snapshot'), node('dd', 'world-evidence-id', event.evidence.snapshotId));
  if (event.archive) {
    dates.append(node('dt', '', 'Dataset'), node('dd', 'world-evidence-id', event.archive.scopeId));
    if (event.archive.conflictCount > 0) dates.append(node('dt', '', 'Source conflicts'), node('dd', '', `${event.archive.conflictCount} alternative retained revision${event.archive.conflictCount === 1 ? '' : 's'} share the provider update date.`));
  }
  evidence.append(dates, node('p', 'world-dossier-note', 'A missing item in a limited feed does not establish that it ended or was disproved.'));
  dossier.append(evidence); return dossier;
}
