const TYPES = Object.freeze({ EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', WF: 'Wildfire', DR: 'Drought' });
export const gdacsNoticeType = code => TYPES[code] || 'Unknown notice type';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const stamp = value => utc(value) ? value.replace('T', ' ').replace('Z', ' UTC') : null;

function noticeLink(record) {
  const parts = /^gdacs:([A-Z]{2}):([^:\s]{1,100}):([^:\s]{0,100})$/.exec(record?.id || '');
  if (!parts || !Object.hasOwn(TYPES, parts[1]) || record.eventType !== parts[1]) return null;
  try {
    const url = new URL(record.url);
    if (!['https://gdacs.org', 'https://www.gdacs.org'].includes(url.origin) || url.username || url.password || url.pathname !== '/report.aspx' ||
      url.searchParams.getAll('eventid').length !== 1 || url.searchParams.get('eventid') !== parts[2] ||
      url.searchParams.getAll('eventtype').length !== 1 || url.searchParams.get('eventtype') !== parts[1] ||
      url.searchParams.getAll('episodeid').length > 1 ||
      (parts[3] ? url.searchParams.get('episodeid') !== parts[3] : ![null, '', '0'].includes(url.searchParams.get('episodeid')))) return null;
    return record.url;
  } catch { return null; }
}

/** The layer supplies one item from a fully validated cohort. Structural binding
 * also keeps generic, historical and foreign source entities out of this view. */
export function gdacsNoticeSelection(entity, time) {
  try {
    const values = entity?.properties?.getValue?.(time), notice = values?._gdacsNotice;
    if (!notice || values._worldEvent || values._worldScene || notice.schemaVersion !== 1 || !digest(notice.version) ||
      notice.source?.id !== 'gdacs' || notice.source.url !== 'https://www.gdacs.org/' ||
      notice.source.attribution !== 'Global Disaster Alert and Coordination System, GDACS') return null;
    const { item, cohort, coverage, operational, history } = notice, record = item?.record, evidence = item?.evidence, origin = item?.origin;
    if (!record || record.sourceId !== 'gdacs' || record.kind !== 'hazard-report' || record.category !== 'disasters' ||
      typeof record.title !== 'string' || !record.title || record.title.length > 300 || !noticeLink(record) ||
      record.publishedAt !== null || record.indexedAt !== null || !/^item:[a-f0-9]{64}$/.test(item.itemId || '') ||
      entity.id !== `gdacs-notice:${item.itemId}` || item.schemaVersion !== 1 || item.sourceId !== 'gdacs' || item.sourceRecordId !== record.id ||
      !digest(item.revision) || cohort?.sourceId !== 'gdacs' || !digest(cohort.snapshotId) || !digest(cohort.bodySha256) ||
      !utc(cohort.capturedAt) || !utc(cohort.publishedAt) || item.capturedAt !== cohort.capturedAt || item.recordedAt !== cohort.publishedAt ||
      evidence?.schemaVersion !== 1 || evidence.sourceId !== 'gdacs' || evidence.sourceRecordId !== record.id || evidence.itemId !== item.itemId ||
      evidence.revision !== item.revision || evidence.snapshotId !== cohort.snapshotId ||
      origin?.validation !== 'retained-revision-index-only' || origin.bodyValidated !== false || !digest(origin.snapshotId) ||
      !utc(origin.firstCapturedAt) || !utc(origin.firstRecordedAt) || origin.firstCapturedAt > cohort.capturedAt || origin.firstRecordedAt > cohort.publishedAt ||
      coverage?.mode !== 'retained-seven-day-notice-sample' || coverage.windowDays !== 7 || coverage.completeRetainedCohort !== true ||
      coverage.completeProviderArchive !== false || operational?.status !== 'unknown' || operational.checkedAt !== null ||
      history?.replay !== false || history.future !== false) return null;
    return { title: record.title, kind: `${TYPES[record.eventType]} · GDACS notice`, notice };
  } catch { return null; }
}

/** Source-attributed notice metadata in the existing selection panel. No reads,
 * provider acquisition, map navigation or scene-clock changes occur here. */
export function createGdacsNoticeDossier(selection, { documentRef = globalThis.document } = {}) {
  const notice = selection?.notice;
  const verified = notice && gdacsNoticeSelection({ id: `gdacs-notice:${notice.item?.itemId}`, properties: { getValue: () => ({ _gdacsNotice: notice }) } }, null);
  if (!verified) return null;
  const { item, cohort } = notice, record = item.record;
  const node = (tag, className, text) => {
    const result = documentRef.createElement(tag); if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text); return result;
  };
  const dossier = node('article', 'world-dossier'); dossier.append(node('p', 'world-kicker', verified.kind));
  const source = node('a', 'world-source', 'Read the GDACS notice'); source.href = noticeLink(record);
  source.target = '_blank'; source.rel = 'noopener noreferrer'; dossier.append(source);
  const facts = node('dl', 'world-facts');
  const field = (container, label, value) => { if (value !== null && value !== undefined && value !== '') container.append(node('dt', '', label), node('dd', '', value)); };
  field(facts, 'Source alert', record.alertLevel || 'Not reported');
  field(facts, 'Country', record.country);
  field(facts, 'Reported start UTC', stamp(record.observedAt) || 'Not reported');
  field(facts, 'Source revised UTC', stamp(record.updatedAt) || 'Not reported');
  const mapped = Number.isFinite(record.lat) && Math.abs(record.lat) <= 90 && Number.isFinite(record.lon) && Math.abs(record.lon) <= 180;
  field(facts, 'Indicative location', mapped ? `${record.lat.toFixed(4)}°, ${record.lon.toFixed(4)}°` : 'Not reported');
  dossier.append(facts, node('p', 'world-dossier-note', 'Modeled or automated source notice · locations are indicative.'));
  const evidence = node('details', 'world-evidence'); evidence.append(node('summary', '', 'Evidence and dates'));
  const dates = node('dl', 'world-facts');
  for (const [label, value] of [['Reported interval to UTC', stamp(record.eventEndAt)], ['Source metadata retrieved', stamp(record.retrievedAt)],
    ['Current cohort captured', stamp(cohort.capturedAt)], ['Current cohort published', stamp(cohort.publishedAt)],
    ['This revision first indexed capture', stamp(item.origin.firstCapturedAt)], ['This revision first indexed publication', stamp(item.origin.firstRecordedAt)],
    ['Source notice identity', record.id], ['Retained notice revision', item.revision], ['Cited normalized snapshot', item.evidence.snapshotId],
    ['Normalized body hash', cohort.bodySha256], ['Earlier index reference', item.origin.snapshotId]]) field(dates, label, value);
  evidence.append(dates, node('p', 'world-dossier-note',
    'Retained normalized metadata, not raw provider originals or independently observed impacts. Earlier dates cite an index reference whose original body is not validated by this view.'));
  evidence.append(node('p', 'world-dossier-note',
    'Source dates are independent of globe time. A reported interval end or absence from this bounded sample does not confirm that the event ended. Operational source freshness is unknown.'));
  dossier.append(evidence); return dossier;
}

/** A correction updates the current evidence without closing the reader's
 * same-notice disclosure or stealing its summary focus. New notices start shut. */
export function updateGdacsNoticeDossier(container, selection, { documentRef = globalThis.document } = {}) {
  const dossier = createGdacsNoticeDossier(selection, { documentRef });
  if (!dossier) return false;
  const item = selection.notice.item, identity = `${item.itemId}:${item.sourceRecordId}`;
  const previous = container.firstElementChild, same = previous?.dataset?.gdacsNoticeIdentity === identity;
  const oldEvidence = same ? previous.querySelector('details.world-evidence') : null;
  const oldSummary = oldEvidence?.querySelector('summary');
  const focused = Boolean(oldSummary && (oldSummary === documentRef.activeElement || oldSummary.contains(documentRef.activeElement)));
  const evidence = dossier.querySelector('details.world-evidence');
  evidence.open = oldEvidence?.open === true;
  dossier.dataset.gdacsNoticeIdentity = identity;
  container.replaceChildren(dossier);
  if (focused) evidence.querySelector('summary').focus({ preventScroll: true });
  return true;
}
