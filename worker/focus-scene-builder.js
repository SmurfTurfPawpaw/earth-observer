import { pluginJson, pluginFactsDigest } from '../src/core/plugin-evidence.js';
import { PREPARED_SCENE_SOURCES, comparePreparedSceneSources, freezePreparedScene } from '../src/core/prepared-scene-contract.js';
import { FOCUS_SCENE_POLICY, FOCUS_SCENE_LIMITS, FOCUS_SCENE_GRIDS, focusSceneSelection, focusLeafKey, focusLeafBounds,
  focusCellAt, validateFocusRegionalScene } from '../src/core/focus-scene-contract.js';
const UTF8 = new TextEncoder(), same = (a, b) => pluginJson(a) === pluginJson(b);
const bounded = value => { if (UTF8.encode(pluginJson(value)).length > FOCUS_SCENE_LIMITS.viewBytes) throw Object.assign(new RangeError('Focus scene byte budget'), { code: 'scene-byte-budget' }); return freezePreparedScene(value); };
function excerpt(value) { let title = '', size = 0; const text = String(value || '');
  for (const character of text) { const bytes = UTF8.encode(character).length; if (size + bytes > 256) break; title += character; size += bytes; }
  return { title, titleTruncated: title !== text }; }
const date = value => value == null ? null : typeof value === 'number' ? new Date(value).toISOString() : value;
function compact(sourceKey, feature, role) {
  const r = feature.record, title = sourceKey === 'earthquakes' ? r.sourceTitle || `M${r.mag} · ${r.place || 'Reported seismic location'}` : r.title;
  return { id: feature.id, sourceRecordId: feature.sourceRecordId, revision: feature.revision, geometry: feature.geometry,
    category: feature.category, symbol: feature.symbol, ...excerpt(title), role, sourceAssessment: feature.sourceAssessment,
    display: { sourceType: r.eventType ?? null, observedAt: date(sourceKey === 'earthquakes' ? r.time : r.observedAt), updatedAt: date(r.updatedAt),
      magnitude: sourceKey === 'earthquakes' ? r.mag : r.magnitude ?? null, depthKm: sourceKey === 'earthquakes' ? r.depthKm : null } };
}
function sourceTime(feature) { const r = feature.record, value = r.updatedAt ?? r.time ?? r.observedAt; return typeof value === 'number' ? value : Date.parse(value); }
const pointKey = feature => `${Math.abs(feature.geometry.lat) === 90 ? 0 : feature.geometry.lon === 180 ? -180 : feature.geometry.lon}:${feature.geometry.lat}`;
const distance = (feature, center) => { const raw = Math.abs(feature.geometry.lon - center.lon), lon = Math.min(raw, 360 - raw) * Math.cos(center.lat * Math.PI / 180);
  return lon * lon + (feature.geometry.lat - center.lat) ** 2; };
export async function selectFocusScene(prepared, input, { now = Date.now, signal } = {}) {
  signal?.throwIfAborted(); const selection = focusSceneSelection(input), sourceKey = prepared?.sourceKey;
  if (prepared?.kind !== 'prepared-source-scene' || !Object.hasOwn(PREPARED_SCENE_SOURCES, sourceKey) ||
      !Array.isArray(prepared.content?.features) || prepared.content.features.length > PREPARED_SCENE_SOURCES[sourceKey].maxRecords)
    throw new TypeError('Use an admitted retained prepared source');
  const leaves = new Map(selection.leaves.map(leaf => [focusLeafKey(leaf), leaf])), selected = [], unmapped = [];
  let mappedTotal = 0;
  for (const feature of prepared.content.features) {
    signal?.throwIfAborted(); if (!feature.geometry) { unmapped.push(compact(sourceKey, feature, 'unmapped')); continue; } ++mappedTotal;
    for (let level = 0; level <= 18; ++level) { const key = focusLeafKey(focusCellAt(feature.geometry, level)); if (!leaves.has(key)) continue;
      selected.push({ feature, leaf: leaves.get(key) }); break; }
  }
  const at = Math.floor(now() / 60000) * 60000, interest = { policyId: 'source-attention-v1', evaluatedAt: new Date(at).toISOString(),
    windowMs: 3600000, maxHighlights: 16, reach: 'unresolved', meaning: 'Recent source M6+ earthquake or red GDACS assessment prioritizes investigation/display; global consequences remain unresolved' };
  const focusBounds = focusLeafBounds(selection.focus), center = { lon: (focusBounds.west + focusBounds.east) / 2, lat: (focusBounds.south + focusBounds.north) / 2 };
  const chosen = [], ids = new Set(), positions = new Set();
  const choose = (items, role, maximum) => { let used = 0; for (const { feature } of items) {
    if (used >= maximum || chosen.length >= 64) break; const position = pointKey(feature); if (ids.has(feature.id) || positions.has(position)) continue;
    chosen.push(compact(sourceKey, feature, role)); ids.add(feature.id); positions.add(position); ++used; } return used; };
  const highlights = selected.filter(({ feature }) => { const time = sourceTime(feature); return Number.isFinite(time) && time <= at && at - time < 3600000 &&
    (sourceKey === 'earthquakes' ? feature.record.eventType === 'earthquake' && feature.record.mag >= 6 : String(feature.record.alertLevel).toLowerCase() === 'red'); })
    .sort((a, b) => (sourceKey === 'earthquakes' ? b.feature.record.mag - a.feature.record.mag : 0) || sourceTime(b.feature) - sourceTime(a.feature) || a.feature.id.localeCompare(b.feature.id));
  const highlightCount = choose(highlights, 'highlight', 16), [focusLevel, focusX, focusY] = selection.focus, [columns] = FOCUS_SCENE_GRIDS[focusLevel];
  const byCenter = (a, b) => distance(a.feature, center) - distance(b.feature, center) || a.feature.id.localeCompare(b.feature.id);
  const neighborhood = selected.filter(({ feature }) => { const [, x, y] = focusCellAt(feature.geometry, focusLevel), dx = Math.abs(x - focusX);
    return Math.min(dx, columns - dx) <= 1 && Math.abs(y - focusY) <= 1; }).sort(byCenter);
  const focusCount = choose(neighborhood, 'focus', selection.featureBudget);
  const residual = new Map();
  for (const item of selected) { if (ids.has(item.feature.id)) continue; const key = `${focusLeafKey(item.leaf)}:${item.feature.symbol}`;
    const group = residual.get(key) || []; group.push(item); residual.set(key, group); }
  const singleton = [...residual.values()].filter(group => group.length === 1 && group[0].leaf[0] >= 7).map(group => group[0]).sort(byCenter);
  const detailCount = choose(singleton, 'detail', 42), groups = new Map();
  for (const { feature, leaf } of selected) { signal?.throwIfAborted(); if (ids.has(feature.id)) continue;
    const id = `focus-cell:${sourceKey}:${focusLeafKey(leaf)}:${feature.symbol}`, old = groups.get(id);
    if (old) { ++old.count; continue; } const bounds = focusLeafBounds(leaf);
    groups.set(id, { id, leaf, lon: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2, bounds, count: 1,
      symbol: feature.symbol, category: feature.category, positionMeaning: 'Geographic-cell summary, not a reported event location' });
  }
  chosen.sort((a, b) => a.id.localeCompare(b.id)); unmapped.sort((a, b) => a.id.localeCompare(b.id)); const clusters = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  const selectionKey = await pluginFactsDigest(selection), result = { schemaVersion: 2, kind: 'focus-regional-scene', policyId: FOCUS_SCENE_POLICY,
    sourceKey, source: prepared.source, selection, selectionKey, contentDigest: prepared.contentDigest,
    version: `view:${await pluginFactsDigest([FOCUS_SCENE_POLICY, prepared.version, selectionKey, interest])}`,
    features: chosen, clusters, unmappedFeatures: unmapped, interest,
    counts: { sourceTotal: prepared.content.features.length, mappedTotal, unmappedTotal: unmapped.length, selectedMapped: selected.length,
      outsideMapped: mappedTotal - selected.length, features: chosen.length, highlights: highlightCount, focusFeatures: focusCount, details: detailCount,
      clusters: clusters.length, clusteredReports: selected.length - chosen.length },
    coverage: { selectedLeavesComplete: true, retainedSourceComplete: true, history: false,
      meaning: 'Complete retained source membership in disjoint whole leaves; conservative cell overcoverage is possible. Outside mapped and unlocated reports are counted separately. This is not complete physical or historical coverage.',
      absenceMeaning: 'Display membership/removal does not assert source withdrawal, an event ending, or evidence deletion' } };
  signal?.throwIfAborted(); return bounded(validateFocusRegionalScene(result, { now }));
}
export const buildFocusScene = selectFocusScene;
/** Exact residual membership in a recomputed, pinned display edition. */
export function focusClusterMembers(prepared, view, clusterId) {
  const cluster = view.clusters.find(item => item.id === clusterId); if (!cluster) return null;
  const shown = new Set(view.features.map(feature => feature.id)), key = focusLeafKey(cluster.leaf);
  const members = prepared.content.features.filter(feature => feature.geometry && !shown.has(feature.id) && feature.symbol === cluster.symbol &&
    focusLeafKey(focusCellAt(feature.geometry, cluster.leaf[0])) === key).map(feature => compact(view.sourceKey, feature, 'member')).sort((a, b) => a.id.localeCompare(b.id));
  if (members.length !== cluster.count) throw new TypeError('Pinned residual membership mismatch'); return freezePreparedScene(members);
}
export function diffFocusScenes(previous, next) {
  if (!previous || previous.sourceKey !== next?.sourceKey || previous.policyId !== FOCUS_SCENE_POLICY || next.policyId !== previous.policyId ||
      previous.selectionKey !== next.selectionKey || !same(previous.selection, next.selection)) return { snapshotRequired: true, reason: 'selection-or-policy-changed' };
  const order = comparePreparedSceneSources(next.sourceKey, next.source, previous.source); if (order === null || order < 0) return { snapshotRequired: true, reason: 'source-edition-incomparable' };
  const diff = (before, after) => { const old = new Map(before.map(item => [item.id, item])), current = new Set(after.map(item => item.id));
    return { upserts: after.filter(item => !old.has(item.id) || !same(item, old.get(item.id))), removals: before.filter(item => !current.has(item.id)).map(item => item.id) }; };
  const f = diff(previous.features, next.features), c = diff(previous.clusters, next.clusters), u = diff(previous.unmappedFeatures, next.unmappedFeatures);
  return bounded({ schemaVersion: 2, kind: 'focus-scene-delta', sourceKey: next.sourceKey, snapshotRequired: false, baseVersion: previous.version,
    version: next.version, source: next.source, selectionKey: next.selectionKey, counts: next.counts, coverage: next.coverage, interest: next.interest,
    upsertFeatures: f.upserts, removeFeatureIds: f.removals, upsertClusters: c.upserts, removeClusterIds: c.removals,
    upsertUnmappedFeatures: u.upserts, removeUnmappedFeatureIds: u.removals, removalMeaning: next.coverage.absenceMeaning });
}
