import { pluginJson, pluginFactsDigest } from '../src/core/plugin-evidence.js';
import { normalizeGdacsSourceItems } from '../src/core/gdacs-source-items.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { worldHash } from '../src/core/world-identity.js';
import { validatePreparedUsgsScene } from './prepared-usgs-scene.js';
import { PREPARED_SCENE_POLICY, PREPARED_SCENE_SOURCES, PREPARED_SCENE_GRIDS, PREPARED_SCENE_LIMITS,
  preparedSceneSelection, preparedSceneSource, preparedSceneFeature, preparedSceneCell, preparedSceneSymbol,
  validatePreparedRegionalScene, comparePreparedSceneSources, freezePreparedScene } from '../src/core/prepared-scene-contract.js';
const UTF8 = new TextEncoder(), HASH = /^[a-f0-9]{64}$/;
const same = (a, b) => pluginJson(a) === pluginJson(b);
const invalid = () => { throw new TypeError('Invalid verified prepared-source input'); };
const bounded = (value, max) => { if (UTF8.encode(pluginJson(value)).byteLength > max) throw Object.assign(new RangeError('Prepared scene byte budget'), { code: 'scene-byte-budget' }); return freezePreparedScene(value); };
export function preparedSceneBasisFromInput(sourceKey, input) {
  if (sourceKey === 'earthquakes') return input?.prepared?.source;
  if (sourceKey === 'gdacs' && input?.cohort) return { sourceId: 'gdacs', scopeId: PREPARED_SCENE_SOURCES.gdacs.scopeId,
    version: input.version, snapshotId: input.cohort.snapshotId, bodySha256: input.cohort.bodySha256,
    capturedAt: input.cohort.capturedAt, publishedAt: input.cohort.publishedAt,
    knowledgeMeaning: 'Completed normalized source cohort; not independently observed impacts or each notice first-known time' };
  invalid();
}
function grids(features, signal) {
  return PREPARED_SCENE_GRIDS.map(([columns, rows], level) => {
    const cells = new Map(); features.forEach((feature, index) => {
      signal?.throwIfAborted(); if (!feature.geometry) return; const [x, y] = preparedSceneCell(feature.geometry, level), key = `${x}:${y}`;
      const cell = cells.get(key) || { x, y, indices: [] }; cell.indices.push(index); cells.set(key, cell);
    }); return { level, columns, rows, cells: [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x) };
  });
}
export async function buildPreparedScene(sourceKey, input, { now = Date.now, signal } = {}) {
  signal?.throwIfAborted(); if (!Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) || input?.available !== true) invalid();
  if (sourceKey === 'earthquakes') await validatePreparedUsgsScene(input.prepared, { signal }); else await normalizeGdacsSourceItems(input);
  const source = preparedSceneSource(sourceKey, preparedSceneBasisFromInput(sourceKey, input), { now });
  const features = sourceKey === 'earthquakes' ? input.prepared.content.features.map(feature => ({ id: feature.id,
    sourceRecordId: feature.record.usgsId, revision: feature.revision, record: feature.record,
    geometry: { lon: feature.record.lon, lat: feature.record.lat, positionMeaning: 'source-reported-seismic-location' },
    category: 'seismic', symbol: 'seismic', provenance: null, sourceAssessment: null })) : input.items.map(item => {
      const { record, ...provenance } = item, symbol = preparedSceneSymbol(record);
      return { id: item.itemId, sourceRecordId: item.sourceRecordId, revision: item.revision, record,
        geometry: Number.isFinite(record.lon) && Number.isFinite(record.lat) ? { lon: record.lon, lat: record.lat, positionMeaning: 'indicative-notice-location' } : null,
        category: symbol, symbol, provenance, sourceAssessment: { kind: 'source-reported-alert', level: record.alertLevel ?? null, reach: 'unresolved' } };
    });
  const content = { schemaVersion: 1, policyId: PREPARED_SCENE_POLICY, sourceKey, features, levels: grids(features, signal) }, contentDigest = await pluginFactsDigest(content);
  signal?.throwIfAborted(); return bounded({ schemaVersion: 1, kind: 'prepared-source-scene', policyId: PREPARED_SCENE_POLICY,
    sourceKey, source, content, contentDigest, version: `prepared:${await pluginFactsDigest([source, contentDigest])}` }, PREPARED_SCENE_LIMITS.objectBytes);
}
export async function validateStoredPreparedScene(value, { now = Date.now, signal } = {}) {
  signal?.throwIfAborted(); const descriptor = Object.hasOwn(PREPARED_SCENE_SOURCES, value?.sourceKey) && PREPARED_SCENE_SOURCES[value.sourceKey];
  if (!descriptor || value.schemaVersion !== 1 || value.kind !== 'prepared-source-scene' || value.policyId !== PREPARED_SCENE_POLICY ||
      Object.keys(value).sort().join(',') !== 'content,contentDigest,kind,policyId,schemaVersion,source,sourceKey,version' ||
      value.content?.schemaVersion !== 1 || value.content.policyId !== PREPARED_SCENE_POLICY || value.content.sourceKey !== value.sourceKey ||
      Object.keys(value.content).sort().join(',') !== 'features,levels,policyId,schemaVersion,sourceKey' ||
      !Array.isArray(value.content.features) || value.content.features.length > descriptor.maxRecords || !HASH.test(value.contentDigest)) invalid();
  preparedSceneSource(value.sourceKey, value.source, { now }); const ids = new Set();
  for (const feature of value.content.features) { signal?.throwIfAborted(); preparedSceneFeature(value.sourceKey, feature);
    if (ids.has(feature.id)) invalid(); ids.add(feature.id);
    const facts = value.sourceKey === 'gdacs' ? (({ retrievedAt: _retrievedAt, ...record }) => record)(canonicalDiscoveryRecord(feature.record)) : feature.record;
    if (await (value.sourceKey === 'gdacs' ? worldHash(facts) : pluginFactsDigest(facts)) !== feature.revision) invalid();
    if (value.sourceKey === 'gdacs' && feature.id !== `item:${await worldHash(['gdacs', feature.sourceRecordId])}`) invalid();
  }
  if (!same(grids(value.content.features, signal), value.content.levels) || await pluginFactsDigest(value.content) !== value.contentDigest ||
      `prepared:${await pluginFactsDigest([value.source, value.contentDigest])}` !== value.version) invalid();
  if (value.sourceKey === 'gdacs') {
    const records = value.content.features.map(feature => canonicalDiscoveryRecord(feature.record)), body = { schemaVersion: 1, source: 'gdacs', records, coordinates: [] };
    if (await worldHash(body) !== value.source.bodySha256 || await worldHash({ ...body,
      records: records.map(({ retrievedAt: _retrievedAt, ...record }) => record) }) !== value.source.snapshotId ||
        await worldHash({ sourceId: 'gdacs', snapshotId: value.source.snapshotId, capturedAt: value.source.capturedAt,
          publishedAt: value.source.publishedAt }) !== value.source.version ||
        value.content.features.some(feature => feature.provenance.capturedAt !== value.source.capturedAt || feature.provenance.recordedAt !== value.source.publishedAt ||
          feature.provenance.evidence.snapshotId !== value.source.snapshotId)) invalid();
  }
  signal?.throwIfAborted(); return bounded(value, PREPARED_SCENE_LIMITS.objectBytes);
}
function interestTime(feature) {
  const value = feature.record.updatedAt ?? (typeof feature.record.time === 'number' ? feature.record.time : feature.record.observedAt);
  return typeof value === 'number' ? value : Date.parse(value);
}
function qualifies(sourceKey, feature, at) {
  const time = interestTime(feature); return Number.isFinite(time) && time <= at && at - time < 3600000 &&
    (sourceKey === 'earthquakes' ? feature.record.eventType === 'earthquake' && feature.record.mag >= 6 : String(feature.record.alertLevel).toLowerCase() === 'red');
}
export async function selectPreparedScene(prepared, demand, { now = Date.now, signal } = {}) {
  signal?.throwIfAborted(); const selection = preparedSceneSelection(demand), { sourceKey } = prepared;
  if (prepared.kind !== 'prepared-source-scene' || prepared.policyId !== PREPARED_SCENE_POLICY || !Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey)) invalid();
  const at = Math.floor(now() / 60000) * 60000, evaluatedAt = new Date(at).toISOString(), interest = { policyId: 'source-attention-v1', evaluatedAt,
    windowMs: 3600000, maxHighlights: 16, reach: 'unresolved', meaning: 'Recent source earthquake M6+ or red GDACS assessment; investigation/display priority, not established global consequences' };
  const all = prepared.content.features, wanted = new Set(selection.cells.map(cell => cell.join(':'))), grid = prepared.content.levels[selection.level];
  const chosen = grid.cells.filter(cell => wanted.has(`${cell.x}:${cell.y}`)).flatMap(cell => cell.indices).map(index => all[index]);
  const priorities = chosen.filter(feature => qualifies(sourceKey, feature, at)).sort((a, b) =>
    (sourceKey === 'earthquakes' ? b.record.mag - a.record.mag : 0) || interestTime(b) - interestTime(a) || a.id.localeCompare(b.id)).slice(0, 16);
  const highlighted = new Set(priorities.map(feature => feature.id)), features = selection.mode === 'features' ? chosen : priorities, clusters = [];
  if (selection.mode === 'clusters') {
    const groups = new Map(), [columns, rows] = PREPARED_SCENE_GRIDS[selection.level];
    for (const feature of chosen) { if (highlighted.has(feature.id)) continue;
      const [x, y] = preparedSceneCell(feature.geometry, selection.level), id = `scene-cell:${sourceKey}:${selection.level}:${x}:${y}:${feature.symbol}`;
      const old = groups.get(id); if (old) { old.count++; continue; }
      const west = -180 + x * 360 / columns, east = west + 360 / columns, north = 90 - y * 180 / rows, south = north - 180 / rows;
      groups.set(id, { id, lon: (west + east) / 2, lat: (south + north) / 2, bounds: { west, south, east, north }, count: 1,
        symbol: feature.symbol, category: feature.category, positionMeaning: 'Geographic-cell summary, not a reported event location' });
    } clusters.push(...groups.values());
  }
  features.sort((a, b) => a.id.localeCompare(b.id)); clusters.sort((a, b) => a.id.localeCompare(b.id));
  const unmappedFeatures = all.filter(feature => !feature.geometry), mappedTotal = all.length - unmappedFeatures.length,
    selectionKey = await pluginFactsDigest(selection), counts = { sourceTotal: all.length, mappedTotal, unmappedTotal: unmappedFeatures.length,
      selectedMapped: chosen.length, features: features.length, highlights: priorities.length, clusters: clusters.length,
      clusteredReports: chosen.length - features.length };
  const view = { schemaVersion: 1, kind: 'prepared-regional-scene', policyId: PREPARED_SCENE_POLICY, sourceKey, source: prepared.source,
    contentDigest: prepared.contentDigest, selection, selectionKey, version: `view:${await pluginFactsDigest([prepared.version, selectionKey, interest])}`,
    features, clusters, unmappedFeatures, counts, interest, coverage: { selectedCellsComplete: true, retainedSourceComplete: true, history: false,
      meaning: sourceKey === 'earthquakes' ? 'Selected whole cells within the retained rolling-day M2.5+ seismic response; not complete physical or historical coverage' :
        'Selected cells and unlocated metadata in the retained seven-day GDACS notice sample; not a complete provider archive or observed impacts',
      absenceMeaning: 'Absent from this displayed source cohort does not assert withdrawal, an event ending, or evidence deletion' } };
  signal?.throwIfAborted(); return bounded(validatePreparedRegionalScene(view, { now }), PREPARED_SCENE_LIMITS.viewBytes);
}
export function diffPreparedScenes(previous, next) {
  if (!previous || previous.sourceKey !== next?.sourceKey || previous.policyId !== PREPARED_SCENE_POLICY || next.policyId !== previous.policyId ||
      previous.selectionKey !== next.selectionKey || !same(previous.selection, next.selection)) return { snapshotRequired: true, reason: 'selection-or-policy-changed' };
  const order = comparePreparedSceneSources(next.sourceKey, next.source, previous.source);
  if (order === null || order < 0) return { snapshotRequired: true, reason: 'source-edition-incomparable' };
  const difference = (before, after) => { const old = new Map(before.map(item => [item.id, item])), current = new Set(after.map(item => item.id));
    return { upserts: after.filter(item => !old.has(item.id) || !same(item, old.get(item.id))), removals: before.filter(item => !current.has(item.id)).map(item => item.id) }; };
  const f = difference(previous.features, next.features), c = difference(previous.clusters, next.clusters), u = difference(previous.unmappedFeatures, next.unmappedFeatures);
  return bounded({ schemaVersion: 1, kind: 'prepared-scene-delta', sourceKey: next.sourceKey, snapshotRequired: false, baseVersion: previous.version,
    version: next.version, source: next.source, selectionKey: next.selectionKey, counts: next.counts, coverage: next.coverage, interest: next.interest,
    upsertFeatures: f.upserts, removeFeatureIds: f.removals, upsertClusters: c.upserts, removeClusterIds: c.removals,
    upsertUnmappedFeatures: u.upserts, removeUnmappedFeatureIds: u.removals, removalMeaning: next.coverage.absenceMeaning }, PREPARED_SCENE_LIMITS.viewBytes);
}
