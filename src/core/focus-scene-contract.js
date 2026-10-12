import { pluginJson } from './plugin-evidence.js';
import { PREPARED_SCENE_SOURCES, PREPARED_SCENE_SYMBOLS, preparedSceneSource, preparedSceneFeature,
  comparePreparedSceneSources, freezePreparedScene } from './prepared-scene-contract.js';

export const FOCUS_SCENE_POLICY = 'mixed-focus-leaves-v1';
export const FOCUS_SCENE_GRIDS = Object.freeze(Array.from({ length: 19 }, (_, level) => Object.freeze([8 * 2 ** level, 4 * 2 ** level])));
export const FOCUS_SCENE_LIMITS = Object.freeze({ leaves: 128, maxLevel: 18, highlights: 16, focusFeatures: 6, details: 42,
  features: 64, detailLevel: 7, titleBytes: 256, viewBytes: 112 * 1024, deliveryBytes: 128 * 1024, queryBytes: 4096 });
const UTF8 = new TextEncoder(), HASH = /^[a-f0-9]{64}$/, VIEW = /^view:[a-f0-9]{64}$/;
const invalid = () => { throw new TypeError('Invalid disjoint focus scene'); };
const same = (a, b) => pluginJson(a) === pluginJson(b);
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const focusLeafKey = leaf => leaf.join(':');
export function validateFocusLeaf(leaf) {
  if (!Array.isArray(leaf) || leaf.length !== 3 || !leaf.every(count) || !FOCUS_SCENE_GRIDS[leaf[0]] ||
      leaf[1] >= FOCUS_SCENE_GRIDS[leaf[0]][0] || leaf[2] >= FOCUS_SCENE_GRIDS[leaf[0]][1]) invalid(); return leaf;
}
export function focusLeafBounds(leaf) {
  validateFocusLeaf(leaf); const [level, x, y] = leaf, [columns, rows] = FOCUS_SCENE_GRIDS[level];
  const west = -180 + x * 360 / columns, east = -180 + (x + 1) * 360 / columns,
    north = 90 - y * 180 / rows, south = 90 - (y + 1) * 180 / rows;
  return freezePreparedScene({ west, south, east, north });
}
export function focusSceneSelection(value) {
  if (value?.schemaVersion !== 2 || value.policyId !== FOCUS_SCENE_POLICY || !Array.isArray(value.leaves) || !value.leaves.length ||
      value.leaves.length > 128 || !Number.isInteger(value.featureBudget) || value.featureBudget < 0 || value.featureBudget > 6) invalid();
  const seen = new Set(); let prior;
  for (const leaf of value.leaves) {
    validateFocusLeaf(leaf);
    if (prior && (leaf[0] < prior[0] || leaf[0] === prior[0] && (leaf[2] < prior[2] || leaf[2] === prior[2] && leaf[1] <= prior[1]))) invalid();
    for (let level = 0; level < leaf[0]; ++level) { const scale = 2 ** (leaf[0] - level);
      if (seen.has(`${level}:${Math.floor(leaf[1] / scale)}:${Math.floor(leaf[2] / scale)}`)) invalid(); }
    const key = focusLeafKey(leaf); if (seen.has(key)) invalid(); seen.add(key); prior = leaf;
  }
  validateFocusLeaf(value.focus); if (!seen.has(focusLeafKey(value.focus))) invalid();
  return freezePreparedScene({ schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves: value.leaves.map(leaf => [...leaf]),
    focus: [...value.focus], featureBudget: value.featureBudget });
}
export function focusCellAt(geometry, level) {
  const [columns, rows] = FOCUS_SCENE_GRIDS[level];
  return [level, Math.floor((((geometry.lon + 180) % 360 + 360) % 360) / 360 * columns),
    Math.min(rows - 1, Math.max(0, Math.floor((90 - geometry.lat) / 180 * rows)))];
}
export function focusSourceVersion(sourceKey, source) { return sourceKey === 'earthquakes' ? source.receiptId : source.version; }
export function validateFocusFeature(sourceKey, feature) {
  if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) || !fields(feature, ['id', 'sourceRecordId', 'revision', 'geometry', 'category', 'symbol',
    'title', 'titleTruncated', 'display', 'role', 'sourceAssessment']) || typeof feature.id !== 'string' || feature.id.length > 180 ||
      typeof feature.sourceRecordId !== 'string' || feature.sourceRecordId.length > 240 || !HASH.test(feature.revision) ||
      !PREPARED_SCENE_SYMBOLS.includes(feature.symbol) || feature.category !== feature.symbol || typeof feature.title !== 'string' ||
      UTF8.encode(feature.title).length > 256 || typeof feature.titleTruncated !== 'boolean' || !['highlight', 'focus', 'detail', 'unmapped', 'member'].includes(feature.role)) invalid();
  if (sourceKey === 'earthquakes' ? !/^earthquake:[A-Za-z0-9_.:-]{1,128}$/.test(feature.id) || feature.symbol !== 'seismic' || feature.sourceAssessment !== null :
    !/^item:[a-f0-9]{64}$/.test(feature.id) || !fields(feature.sourceAssessment, ['kind', 'level', 'reach']) ||
      feature.sourceAssessment.kind !== 'source-reported-alert' || feature.sourceAssessment.reach !== 'unresolved' ||
      !(feature.sourceAssessment.level === null || typeof feature.sourceAssessment.level === 'string' && feature.sourceAssessment.level.length <= 120)) invalid();
  if (feature.geometry !== null && (!fields(feature.geometry, ['lon', 'lat', 'positionMeaning']) || !Number.isFinite(feature.geometry.lon) || Math.abs(feature.geometry.lon) > 180 ||
      !Number.isFinite(feature.geometry.lat) || Math.abs(feature.geometry.lat) > 90 || feature.geometry.positionMeaning !==
        (sourceKey === 'earthquakes' ? 'source-reported-seismic-location' : 'indicative-notice-location'))) invalid();
  if ((feature.geometry === null) !== (feature.role === 'unmapped') || sourceKey === 'earthquakes' && feature.geometry === null) invalid();
  const d = feature.display;
  if (!fields(d, ['sourceType', 'observedAt', 'updatedAt', 'magnitude', 'depthKm']) || Object.keys(d).length !== 5 ||
      !(d.sourceType === null || typeof d.sourceType === 'string' && d.sourceType.length <= 120) ||
      ![d.observedAt, d.updatedAt].every(value => value === null || utc(value)) ||
      ![d.magnitude, d.depthKm].every(value => value === null || Number.isFinite(value))) invalid();
  return feature;
}
/** A compact projection is not proof. Compare it with the stored full feature
 * and exact receipt before materializing source-specific dossier properties. */
export function focusFeatureMatches(sourceKey, compact, full) {
  try { validateFocusFeature(sourceKey, compact); preparedSceneFeature(sourceKey, full);
    const record = full.record, date = value => value == null ? null : typeof value === 'number' ? new Date(value).toISOString() : value;
    const display = { sourceType: record.eventType ?? null, observedAt: date(sourceKey === 'earthquakes' ? record.time : record.observedAt), updatedAt: date(record.updatedAt),
      magnitude: sourceKey === 'earthquakes' ? record.mag : record.magnitude ?? null, depthKm: sourceKey === 'earthquakes' ? record.depthKm : null };
    return compact.id === full.id && compact.sourceRecordId === full.sourceRecordId && compact.revision === full.revision &&
      same(compact.geometry, full.geometry) && compact.category === full.category && compact.symbol === full.symbol &&
      same(compact.sourceAssessment, full.sourceAssessment) && same(compact.display, display);
  } catch { return false; }
}
export function validateFocusRegionalScene(value, { sourceKey = value?.sourceKey, selection = value?.selection, now = Date.now } = {}) {
  const normalized = focusSceneSelection(selection), descriptor = PREPARED_SCENE_SOURCES[sourceKey];
  if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) || !fields(value, ['schemaVersion', 'kind', 'policyId', 'sourceKey', 'source', 'selection', 'selectionKey',
    'contentDigest', 'version', 'features', 'clusters', 'unmappedFeatures', 'counts', 'coverage', 'interest']) || value.schemaVersion !== 2 ||
      value.kind !== 'focus-regional-scene' || value.policyId !== FOCUS_SCENE_POLICY || value.sourceKey !== sourceKey || !same(value.selection, normalized) ||
      !HASH.test(value.selectionKey) || !(value.contentDigest === null || HASH.test(value.contentDigest)) || !VIEW.test(value.version)) invalid();
  preparedSceneSource(sourceKey, value.source, { now }); const leaves = new Set(normalized.leaves.map(focusLeafKey)), ids = new Set();
  if (!Array.isArray(value.features) || value.features.length > 64 || !Array.isArray(value.clusters) || value.clusters.length > descriptor.maxRecords ||
      !Array.isArray(value.unmappedFeatures) || value.unmappedFeatures.length > descriptor.maxRecords) invalid();
  const roles = { highlight: 0, focus: 0, detail: 0 }, positions = new Set(), details = new Set();
  const [focusLevel, focusX, focusY] = normalized.focus, [focusColumns] = FOCUS_SCENE_GRIDS[focusLevel];
  for (const feature of [...value.features, ...value.unmappedFeatures]) {
    validateFocusFeature(sourceKey, feature); if (ids.has(feature.id)) invalid(); ids.add(feature.id);
    if (value.unmappedFeatures.includes(feature)) { if (feature.geometry !== null) invalid(); continue; }
    if (feature.geometry === null) invalid(); let covered;
    for (let level = 0; level <= 18; ++level) { const leaf = focusCellAt(feature.geometry, level);
      if (leaves.has(focusLeafKey(leaf))) { covered = leaf; break; } }
    if (!covered || !Object.hasOwn(roles, feature.role)) invalid();
    const position = `${Math.abs(feature.geometry.lat) === 90 ? 0 : feature.geometry.lon === 180 ? -180 : feature.geometry.lon}:${feature.geometry.lat}`;
    if (positions.has(position)) invalid(); positions.add(position);
    if (feature.role === 'detail') { const key = `${focusLeafKey(covered)}:${feature.symbol}`;
      if (covered[0] < 7 || details.has(key)) invalid(); details.add(key); }
    if (feature.role === 'focus') { const [, x, y] = focusCellAt(feature.geometry, focusLevel), dx = Math.abs(x - focusX);
      if (Math.min(dx, focusColumns - dx) > 1 || Math.abs(y - focusY) > 1) invalid(); }
    if (feature.role === 'highlight') { const at = Date.parse(value.interest?.evaluatedAt), time = Date.parse(feature.display.updatedAt ?? feature.display.observedAt);
      if (!Number.isFinite(at) || !Number.isFinite(time) || time > at || at - time >= 3600000 ||
          (sourceKey === 'earthquakes' ? feature.display.sourceType !== 'earthquake' || feature.display.magnitude < 6 :
            String(feature.sourceAssessment.level).toLowerCase() !== 'red')) invalid(); }
    ++roles[feature.role];
  }
  if (roles.highlight > 16 || roles.focus > normalized.featureBudget || roles.detail > 42) invalid(); let clustered = 0;
  for (const cluster of value.clusters) {
    if (!fields(cluster, ['id', 'leaf', 'lon', 'lat', 'bounds', 'count', 'symbol', 'category', 'positionMeaning']) || !leaves.has(focusLeafKey(validateFocusLeaf(cluster.leaf))) ||
        cluster.id !== `focus-cell:${sourceKey}:${focusLeafKey(cluster.leaf)}:${cluster.symbol}` || ids.has(cluster.id) ||
        !PREPARED_SCENE_SYMBOLS.includes(cluster.symbol) || cluster.category !== cluster.symbol || !count(cluster.count) || cluster.count < 1 ||
        details.has(`${focusLeafKey(cluster.leaf)}:${cluster.symbol}`) ||
        cluster.positionMeaning !== 'Geographic-cell summary, not a reported event location' || !same(cluster.bounds, focusLeafBounds(cluster.leaf)) ||
        cluster.lon !== (cluster.bounds.west + cluster.bounds.east) / 2 || cluster.lat !== (cluster.bounds.south + cluster.bounds.north) / 2) invalid();
    clustered += cluster.count; ids.add(cluster.id);
  }
  const c = value.counts;
  if (!fields(c, ['sourceTotal', 'mappedTotal', 'unmappedTotal', 'selectedMapped', 'outsideMapped', 'features', 'highlights', 'focusFeatures', 'details', 'clusters', 'clusteredReports']) ||
      Object.keys(c).length !== 11 || !Object.values(c).every(count) || c.sourceTotal > descriptor.maxRecords || c.sourceTotal !== c.mappedTotal + c.unmappedTotal ||
      c.mappedTotal !== c.selectedMapped + c.outsideMapped || c.selectedMapped !== c.features + c.clusteredReports ||
      c.features !== value.features.length || c.features !== c.highlights + c.focusFeatures + c.details ||
      c.highlights !== roles.highlight || c.focusFeatures !== roles.focus || c.details !== roles.detail ||
      c.clusters !== value.clusters.length || c.clusteredReports !== clustered || c.unmappedTotal !== value.unmappedFeatures.length ||
      !fields(value.coverage, ['selectedLeavesComplete', 'retainedSourceComplete', 'history', 'meaning', 'absenceMeaning']) ||
      value.coverage.selectedLeavesComplete !== true || value.coverage.retainedSourceComplete !== true || value.coverage.history !== false ||
      typeof value.coverage.meaning !== 'string' || value.coverage.meaning.length > 512 || typeof value.coverage.absenceMeaning !== 'string' || value.coverage.absenceMeaning.length > 512 ||
      !fields(value.interest, ['policyId', 'evaluatedAt', 'windowMs', 'maxHighlights', 'reach', 'meaning']) || value.interest.policyId !== 'source-attention-v1' ||
      !utc(value.interest.evaluatedAt) || !value.interest.evaluatedAt.endsWith(':00.000Z') || Date.parse(value.interest.evaluatedAt) > now() + 305000 || value.interest.windowMs !== 3600000 ||
      value.interest.maxHighlights !== 16 || value.interest.reach !== 'unresolved' || typeof value.interest.meaning !== 'string' || value.interest.meaning.length > 512) invalid();
  return freezePreparedScene(value);
}
export function applyFocusSceneDelta(previous, delta, { sourceKey = previous?.sourceKey, now = Date.now } = {}) {
  validateFocusRegionalScene(previous, { sourceKey, now });
  if (!fields(delta, ['schemaVersion', 'kind', 'sourceKey', 'snapshotRequired', 'baseVersion', 'version', 'source', 'selectionKey', 'counts', 'coverage', 'interest',
    'upsertFeatures', 'removeFeatureIds', 'upsertClusters', 'removeClusterIds', 'upsertUnmappedFeatures', 'removeUnmappedFeatureIds', 'removalMeaning']) ||
      delta.schemaVersion !== 2 || delta.kind !== 'focus-scene-delta' || delta.sourceKey !== sourceKey || delta.snapshotRequired !== false ||
      delta.baseVersion !== previous.version || !VIEW.test(delta.version) || delta.selectionKey !== previous.selectionKey ||
      typeof delta.removalMeaning !== 'string' || delta.removalMeaning.length > 512) invalid();
  preparedSceneSource(sourceKey, delta.source, { now }); const order = comparePreparedSceneSources(sourceKey, delta.source, previous.source); if (order === null || order < 0) invalid();
  const apply = (before, changed, removed) => {
    if (!Array.isArray(changed) || !Array.isArray(removed) || changed.length > 500 || removed.length > 500 ||
        new Set(changed.map(item => item?.id)).size !== changed.length || new Set(removed).size !== removed.length) invalid();
    const next = new Map(before.map(item => [item.id, item])); for (const id of removed) { if (typeof id !== 'string' || !next.has(id) || changed.some(item => item.id === id)) invalid(); next.delete(id); }
    for (const item of changed) next.set(item.id, item); return [...next.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  const result = { ...previous, source: delta.source, version: delta.version, contentDigest: delta.version === previous.version ? previous.contentDigest : null,
    counts: delta.counts, coverage: delta.coverage, interest: delta.interest, features: apply(previous.features, delta.upsertFeatures, delta.removeFeatureIds),
    clusters: apply(previous.clusters, delta.upsertClusters, delta.removeClusterIds), unmappedFeatures: apply(previous.unmappedFeatures, delta.upsertUnmappedFeatures, delta.removeUnmappedFeatureIds) };
  if (delta.version === previous.version && !same({ ...result, contentDigest: null }, { ...previous, contentDigest: null })) invalid();
  return validateFocusRegionalScene(result, { sourceKey, now });
}
