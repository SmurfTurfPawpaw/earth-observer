import { pluginJson } from './plugin-evidence.js';
import { validateUsgsLiveDayFacts } from './usgs-live-day.js';
import { canonicalDiscoveryRecord } from './discovery-index.js';

export const PREPARED_SCENE_POLICY = 'retained-geographic-scenes-v1';
export const PREPARED_SCENE_SOURCES = Object.freeze({
  earthquakes: Object.freeze({ key: 'earthquakes', sourceId: 'usgs', scopeId: 'usgs-live-day-m2-5-v1', maxRecords: 500, title: 'Seismic reports', symbol: 'seismic' }),
  gdacs: Object.freeze({ key: 'gdacs', sourceId: 'gdacs', scopeId: 'gdacs-retained-seven-day-notices', maxRecords: 100, title: 'Disaster notices', symbol: 'notice' }),
});
export const PREPARED_SCENE_GRIDS = Object.freeze([[8, 4], [32, 16], [128, 64]].map(Object.freeze));
export const PREPARED_SCENE_LIMITS = Object.freeze({ objectBytes: 384 * 1024, viewBytes: 250 * 1024, deliveryBytes: 270 * 1024, cells: 128, highlights: 16, interestMs: 3600000 });
export const PREPARED_SCENE_SYMBOLS = Object.freeze(['seismic', 'flood', 'cyclone', 'volcano', 'wildfire', 'drought', 'notice']);
const HASH = /^[a-f0-9]{64}$/, VIEW = /^view:[a-f0-9]{64}$/, RECEIPT = /^receipt:[a-f0-9]{64}$/;
const invalid = () => { throw new TypeError('Invalid complete prepared scene contract'); };
const equal = (a, b) => pluginJson(a) === pluginJson(b);
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = value => Number.isSafeInteger(value) && value >= 0;
export function freezePreparedScene(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freezePreparedScene); Object.freeze(value); } return value; }
export function preparedSceneSelection(value) {
  if (!value || !Number.isInteger(value.level) || !PREPARED_SCENE_GRIDS[value.level] || !['clusters', 'features'].includes(value.mode) ||
      !Array.isArray(value.cells) || value.cells.length > 128) invalid();
  let prior; const [columns, rows] = PREPARED_SCENE_GRIDS[value.level];
  for (const cell of value.cells) {
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(count) || cell[0] >= columns || cell[1] >= rows ||
        prior && (cell[1] < prior[1] || cell[1] === prior[1] && cell[0] <= prior[0])) invalid(); prior = cell;
  }
  return freezePreparedScene({ level: value.level, cells: value.cells.map(cell => [...cell]), mode: value.mode });
}
export function preparedSceneSource(sourceKey, basis, { now = Date.now } = {}) {
  const source = Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) && PREPARED_SCENE_SOURCES[sourceKey]; if (!source) invalid();
  const dates = sourceKey === 'earthquakes' ? ['capturedAt', 'recordedAt', 'sourceGeneratedAt'] : ['capturedAt', 'publishedAt'];
  if (!keys(basis, sourceKey === 'earthquakes' ? ['pluginId', 'scopeId', 'receiptId', 'fence', 'factsDigest', 'rawSha256', 'artifactSha256',
    'capturedAt', 'recordedAt', 'sourceGeneratedAt', 'knowledgeMeaning'] : ['sourceId', 'scopeId', 'version', 'snapshotId', 'bodySha256', 'capturedAt', 'publishedAt', 'knowledgeMeaning']) ||
      basis.scopeId !== source.scopeId || !dates.every(key => utc(basis[key])) ||
      dates.some(key => Date.parse(basis[key]) > now() + 305000) || typeof basis.knowledgeMeaning !== 'string' || basis.knowledgeMeaning.length > 256 ||
      Date.parse(basis.capturedAt) > Date.parse(basis.recordedAt ?? basis.publishedAt) + 305000) invalid();
  if (sourceKey === 'earthquakes') {
    if (basis.pluginId !== source.scopeId || !RECEIPT.test(basis.receiptId) || !Number.isSafeInteger(basis.fence) || basis.fence < 1 ||
        ![basis.factsDigest, basis.rawSha256, basis.artifactSha256].every(value => HASH.test(value))) invalid();
  } else if (basis.sourceId !== 'gdacs' || ![basis.version, basis.snapshotId, basis.bodySha256].every(value => HASH.test(value))) invalid();
  return freezePreparedScene(basis);
}
export function comparePreparedSceneSources(sourceKey, left, right) {
  if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) || !left || !right) return null;
  if (equal(left, right)) return 0;
  if (sourceKey === 'earthquakes') return left.fence === right.fence ? null : left.fence > right.fence ? 1 : -1;
  if (left.capturedAt === right.capturedAt) return null;
  const sign = left.capturedAt > right.capturedAt ? 1 : -1;
  return sign === 1 && left.publishedAt >= right.publishedAt || sign === -1 && left.publishedAt <= right.publishedAt ? sign : null;
}
export const preparedSceneSymbol = record => ({ EQ: 'seismic', FL: 'flood', TC: 'cyclone', VO: 'volcano', WF: 'wildfire', DR: 'drought' })[record?.eventType] || 'notice';
export function preparedSceneFeature(sourceKey, value) {
  const descriptor = Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) && PREPARED_SCENE_SOURCES[sourceKey];
  if (!descriptor || !keys(value, ['id', 'sourceRecordId', 'revision', 'record', 'geometry', 'category', 'symbol', 'provenance', 'sourceAssessment']) ||
      typeof value.id !== 'string' || value.id.length > 180 || !HASH.test(value.revision) || typeof value.sourceRecordId !== 'string' || value.sourceRecordId.length > 180 ||
      !PREPARED_SCENE_SYMBOLS.includes(value.symbol) || value.category !== value.symbol) invalid();
  const record = value.record;
  if (sourceKey === 'earthquakes') {
    validateUsgsLiveDayFacts({ schemaVersion: 1, kind: 'usgs-rolling-seismic-observations', scopeId: descriptor.scopeId,
      sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24, records: [record] });
    if (value.id !== `earthquake:${record.stableId}` || value.sourceRecordId !== record.usgsId || value.symbol !== 'seismic' || value.provenance !== null || value.sourceAssessment !== null) invalid();
  } else {
    const canonical = canonicalDiscoveryRecord(record), p = value.provenance;
    if (!canonical || !equal(canonical, record) || record.sourceId !== 'gdacs' || value.sourceRecordId !== record.id || value.symbol !== preparedSceneSymbol(record) ||
        !/^item:[a-f0-9]{64}$/.test(value.id) || !p || p.schemaVersion !== 1 || p.itemId !== value.id || p.sourceId !== 'gdacs' || p.sourceRecordId !== record.id || p.revision !== value.revision ||
        !utc(p.capturedAt) || !utc(p.recordedAt) || p.evidence?.itemId !== value.id || p.evidence?.revision !== value.revision ||
        p.evidence?.sourceId !== 'gdacs' || p.evidence?.sourceRecordId !== record.id || !HASH.test(p.evidence?.snapshotId) ||
        p.origin?.validation !== 'retained-revision-index-only' || p.origin.bodyValidated !== false || !HASH.test(p.origin.snapshotId) ||
        !utc(p.origin.firstCapturedAt) || !utc(p.origin.firstRecordedAt) || p.origin.firstCapturedAt > p.capturedAt || p.origin.firstRecordedAt > p.recordedAt ||
        !keys(value.sourceAssessment, ['kind', 'level', 'reach']) || value.sourceAssessment.kind !== 'source-reported-alert' ||
        value.sourceAssessment.level !== (record.alertLevel ?? null) || value.sourceAssessment.reach !== 'unresolved') invalid();
  }
  const mapped = Number.isFinite(record.lon) && Number.isFinite(record.lat) && Math.abs(record.lon) <= 180 && Math.abs(record.lat) <= 90;
  if (mapped ? !keys(value.geometry, ['lon', 'lat', 'positionMeaning']) || value.geometry.lon !== record.lon || value.geometry.lat !== record.lat ||
    value.geometry.positionMeaning !== (sourceKey === 'earthquakes' ? 'source-reported-seismic-location' : 'indicative-notice-location') : value.geometry !== null) invalid();
  return value;
}
export function preparedSceneCell(geometry, level) {
  const [columns, rows] = PREPARED_SCENE_GRIDS[level];
  return [Math.floor((((geometry.lon + 180) % 360 + 360) % 360) / 360 * columns), Math.min(rows - 1, Math.max(0, Math.floor((90 - geometry.lat) / 180 * rows)))];
}
export function validatePreparedRegionalScene(value, { sourceKey = value?.sourceKey, selection = value?.selection, now = Date.now } = {}) {
  const descriptor = Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) && PREPARED_SCENE_SOURCES[sourceKey], selected = preparedSceneSelection(selection);
  if (!descriptor || !keys(value, ['schemaVersion', 'kind', 'policyId', 'sourceKey', 'source', 'selection', 'selectionKey', 'version', 'contentDigest',
    'features', 'clusters', 'unmappedFeatures', 'counts', 'coverage', 'interest']) || value.schemaVersion !== 1 || value.kind !== 'prepared-regional-scene' ||
      value.policyId !== PREPARED_SCENE_POLICY || value.sourceKey !== sourceKey || !equal(value.selection, selected) || !HASH.test(value.selectionKey) ||
      !VIEW.test(value.version) || !(value.contentDigest === null || HASH.test(value.contentDigest))) invalid();
  preparedSceneSource(sourceKey, value.source, { now }); const wanted = new Set(selected.cells.map(cell => cell.join(':'))), ids = new Set();
  if (!Array.isArray(value.features) || value.features.length > descriptor.maxRecords || !Array.isArray(value.unmappedFeatures) ||
      value.unmappedFeatures.length > descriptor.maxRecords || !Array.isArray(value.clusters) || value.clusters.length > descriptor.maxRecords) invalid();
  for (const feature of [...value.features, ...value.unmappedFeatures]) {
    preparedSceneFeature(sourceKey, feature); if (ids.has(feature.id)) invalid(); ids.add(feature.id);
    if (sourceKey === 'gdacs' && (feature.provenance.capturedAt !== value.source.capturedAt || feature.provenance.recordedAt !== value.source.publishedAt ||
        feature.provenance.evidence.snapshotId !== value.source.snapshotId)) invalid();
    if (value.features.includes(feature) ? !feature.geometry || !wanted.has(preparedSceneCell(feature.geometry, selected.level).join(':')) : feature.geometry !== null) invalid();
  }
  const [columns, rows] = PREPARED_SCENE_GRIDS[selected.level]; let clustered = 0;
  for (const cluster of value.clusters) {
    const match = new RegExp(`^scene-cell:${sourceKey}:${selected.level}:(\\d+):(\\d+):([a-z]+)$`).exec(cluster?.id || '');
    if (!keys(cluster, ['id', 'lon', 'lat', 'bounds', 'count', 'symbol', 'category', 'positionMeaning']) || !match || ids.has(cluster.id) ||
        !PREPARED_SCENE_SYMBOLS.includes(cluster.symbol) || match[3] !== cluster.symbol || cluster.category !== cluster.symbol ||
        !wanted.has(`${Number(match[1])}:${Number(match[2])}`) || !count(cluster.count) || cluster.count < 1 ||
        cluster.positionMeaning !== 'Geographic-cell summary, not a reported event location') invalid();
    const west = -180 + Number(match[1]) * 360 / columns, east = west + 360 / columns,
      north = 90 - Number(match[2]) * 180 / rows, south = north - 180 / rows;
    if (!equal(cluster.bounds, { west, south, east, north }) || cluster.lon !== (west + east) / 2 || cluster.lat !== (south + north) / 2) invalid();
    clustered += cluster.count; ids.add(cluster.id);
  }
  const c = value.counts;
  if (!keys(c, ['sourceTotal', 'mappedTotal', 'unmappedTotal', 'selectedMapped', 'features', 'highlights', 'clusters', 'clusteredReports']) ||
      Object.keys(c).length !== 8 || !Object.values(c).every(count) || c.sourceTotal > descriptor.maxRecords || c.sourceTotal !== c.mappedTotal + c.unmappedTotal ||
      c.selectedMapped > c.mappedTotal || c.features !== value.features.length || c.clusters !== value.clusters.length || c.unmappedTotal !== value.unmappedFeatures.length ||
      c.clusteredReports !== clustered || c.selectedMapped !== c.features + clustered || c.highlights > Math.min(c.features, 16) ||
      selected.mode === 'clusters' && (c.features !== c.highlights || c.features > 16) || selected.mode === 'features' && clustered !== 0 ||
      !keys(value.coverage, ['selectedCellsComplete', 'retainedSourceComplete', 'history', 'meaning', 'absenceMeaning']) ||
      value.coverage.selectedCellsComplete !== true || value.coverage.retainedSourceComplete !== true || value.coverage.history !== false ||
      typeof value.coverage.meaning !== 'string' || value.coverage.meaning.length > 512 || typeof value.coverage.absenceMeaning !== 'string' || value.coverage.absenceMeaning.length > 512 ||
      !keys(value.interest, ['policyId', 'evaluatedAt', 'windowMs', 'maxHighlights', 'reach', 'meaning']) || value.interest.policyId !== 'source-attention-v1' ||
      !utc(value.interest.evaluatedAt) || Date.parse(value.interest.evaluatedAt) > now() + 305000 || value.interest.windowMs !== 3600000 ||
      value.interest.maxHighlights !== 16 || value.interest.reach !== 'unresolved' || typeof value.interest.meaning !== 'string' || value.interest.meaning.length > 512) invalid();
  return freezePreparedScene(value);
}
export function applyPreparedSceneDelta(previous, delta, { sourceKey = previous?.sourceKey, now = Date.now } = {}) {
  validatePreparedRegionalScene(previous, { sourceKey, now });
  if (!keys(delta, ['schemaVersion', 'kind', 'snapshotRequired', 'sourceKey', 'baseVersion', 'version', 'source', 'selectionKey', 'counts', 'coverage', 'interest',
    'upsertFeatures', 'removeFeatureIds', 'upsertClusters', 'removeClusterIds', 'upsertUnmappedFeatures', 'removeUnmappedFeatureIds', 'removalMeaning']) ||
      delta.schemaVersion !== 1 || delta.kind !== 'prepared-scene-delta' || delta.sourceKey !== sourceKey || delta.snapshotRequired !== false ||
      delta.baseVersion !== previous.version || !VIEW.test(delta.version) || delta.selectionKey !== previous.selectionKey ||
      typeof delta.removalMeaning !== 'string' || delta.removalMeaning.length > 512) invalid();
  preparedSceneSource(sourceKey, delta.source, { now }); const order = comparePreparedSceneSources(sourceKey, delta.source, previous.source);
  if (order === null || order < 0) invalid();
  const apply = (before, upserts, removals) => {
    if (!Array.isArray(upserts) || !Array.isArray(removals) || upserts.length > 500 || removals.length > 500 ||
        new Set(upserts.map(item => item?.id)).size !== upserts.length || new Set(removals).size !== removals.length) invalid();
    const values = new Map(before.map(item => [item.id, item]));
    for (const id of removals) { if (typeof id !== 'string' || !values.has(id) || upserts.some(item => item.id === id)) invalid(); values.delete(id); }
    for (const item of upserts) values.set(item.id, item); return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  const next = { ...previous, source: delta.source, version: delta.version, contentDigest: delta.version === previous.version ? previous.contentDigest : null,
    counts: delta.counts, coverage: delta.coverage, interest: delta.interest, features: apply(previous.features, delta.upsertFeatures, delta.removeFeatureIds),
    clusters: apply(previous.clusters, delta.upsertClusters, delta.removeClusterIds), unmappedFeatures: apply(previous.unmappedFeatures, delta.upsertUnmappedFeatures, delta.removeUnmappedFeatureIds) };
  if (delta.version === previous.version && !equal({ ...next, contentDigest: null }, { ...previous, contentDigest: null })) invalid();
  return validatePreparedRegionalScene(next, { sourceKey, now });
}
