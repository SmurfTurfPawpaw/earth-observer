import { USGS_LIVE_DAY, validateUsgsLiveDayFacts, usgsLiveDayOverview } from '../src/core/usgs-live-day.js';
import { pluginFactsDigest, pluginJson } from '../src/core/plugin-evidence.js';

export const PREPARED_USGS_POLICY = 'usgs-seismic-geographic-grid-v1';
export const PREPARED_USGS_LIMITS = Object.freeze({ records: USGS_LIVE_DAY.records, selectedCells: 128,
  preparedBytes: 384 * 1024, viewBytes: 256 * 1024, deltaBytes: 256 * 1024 });
const LEVELS = Object.freeze([{ level: 0, columns: 8, rows: 4 }, { level: 1, columns: 32, rows: 16 }, { level: 2, columns: 128, rows: 64 }].map(Object.freeze));
const UTF8 = new TextEncoder(), HASH = /^[a-f0-9]{64}$/, RECEIPT = /^receipt:[a-f0-9]{64}$/;
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = message => { throw new TypeError(message); };
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const bounded = (value, maximum) => { if (UTF8.encode(pluginJson(value)).byteLength > maximum) fail('Prepared scene exceeds its delivery bound'); return freeze(value); };

export function preparedUsgsSource(receipt) {
  if (!receipt || !RECEIPT.test(receipt.id) || !Number.isSafeInteger(receipt.fence) || receipt.fence < 1 ||
      ![receipt.factsDigest, receipt.rawSha256, receipt.artifactSha256].every(value => typeof value === 'string' && HASH.test(value)) ||
      ![receipt.capturedAt, receipt.recordedAt, receipt.sourceUpdatedAt].every(utc)) fail('Invalid prepared source receipt');
  return { pluginId: USGS_LIVE_DAY.pluginId, scopeId: USGS_LIVE_DAY.scopeId, receiptId: receipt.id, fence: receipt.fence,
    factsDigest: receipt.factsDigest, rawSha256: receipt.rawSha256, artifactSha256: receipt.artifactSha256,
    capturedAt: receipt.capturedAt, recordedAt: receipt.recordedAt, sourceGeneratedAt: receipt.sourceUpdatedAt,
    knowledgeMeaning: 'Whole-cohort receipt; not each report\'s first-known time' };
}
function geographicLevels(features, signal) {
  return LEVELS.map(grid => {
    const cells = new Map();
    features.forEach((feature, index) => {
      signal?.throwIfAborted(); const { lon, lat, mag } = feature.record;
      const x = Math.floor((((lon + 180) % 360 + 360) % 360) / 360 * grid.columns);
      const y = Math.min(grid.rows - 1, Math.max(0, Math.floor((90 - lat) / 180 * grid.rows)));
      const key = `${x}/${y}`, cell = cells.get(key) || { x, y, indices: [], maximumMagnitude: mag };
      cell.indices.push(index); cell.maximumMagnitude = Math.max(cell.maximumMagnitude, mag); cells.set(key, cell);
    });
    return { ...grid, cells: [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x) };
  });
}

/** Cold-cache admission only. Public reads reuse the admitted immutable object;
 * row/whole-content hashes and the exact grid are checked before it enters that cache. */
export async function validatePreparedUsgsScene(value, { signal } = {}) {
  signal?.throwIfAborted();
  if (!value || value.schemaVersion !== 1 || value.kind !== 'prepared-usgs-source-scene' ||
      Object.keys(value).some(key => !['schemaVersion','kind','source','content','contentDigest','version'].includes(key)) ||
      value.content?.schemaVersion !== 1 || value.content.policyId !== PREPARED_USGS_POLICY || value.content.scopeId !== USGS_LIVE_DAY.scopeId ||
      Object.keys(value.content).some(key => !['schemaVersion','policyId','scopeId','factsDigest','features','levels'].includes(key)) ||
      !Array.isArray(value.content.features) || value.content.features.length > PREPARED_USGS_LIMITS.records ||
      !Array.isArray(value.content.levels) || value.content.levels.length !== LEVELS.length)
    fail('Invalid stored prepared scene');
  const source = preparedUsgsSource({ id:value.source?.receiptId, fence:value.source?.fence, factsDigest:value.source?.factsDigest,
    rawSha256:value.source?.rawSha256, artifactSha256:value.source?.artifactSha256, capturedAt:value.source?.capturedAt,
    recordedAt:value.source?.recordedAt, sourceUpdatedAt:value.source?.sourceGeneratedAt });
  if (pluginJson(source) !== pluginJson(value.source) || value.content.factsDigest !== source.factsDigest)
    fail('Invalid stored prepared source basis');
  const facts = validateUsgsLiveDayFacts({ schemaVersion:1,kind:'usgs-rolling-seismic-observations',scopeId:USGS_LIVE_DAY.scopeId,
    sourceId:'usgs',minimumMagnitude:2.5,windowHours:24,records:value.content.features.map(feature => feature?.record) });
  await Promise.all(value.content.features.map(async (feature,index) => {
    signal?.throwIfAborted();
    if (!feature || Object.keys(feature).some(key => !['id','revision','record'].includes(key)) ||
        feature.id !== `earthquake:${facts.records[index].stableId}` || feature.revision !== await pluginFactsDigest(feature.record))
      fail('Invalid stored prepared feature');
  }));
  if (await pluginFactsDigest(facts) !== source.factsDigest || pluginJson(geographicLevels(value.content.features,signal)) !== pluginJson(value.content.levels) ||
      await pluginFactsDigest(value.content) !== value.contentDigest ||
      value.version !== `prepared:${await pluginFactsDigest({source,contentDigest:value.contentDigest})}`)
    fail('Stored prepared scene integrity mismatch');
  signal?.throwIfAborted(); return bounded(value,PREPARED_USGS_LIMITS.preparedBytes);
}

/** Rebind already admitted content only after the exact completed receipt has
 * been resolved by the owner. A/B/A can reuse facts without retaining extra keys. */
export async function rebindPreparedUsgsScene(prepared,receipt,{signal}={}) {
  signal?.throwIfAborted(); const source=preparedUsgsSource(receipt);
  if (prepared?.kind !== 'prepared-usgs-source-scene' || prepared.content?.factsDigest !== source.factsDigest)
    fail('Prepared content does not match the new receipt');
  return bounded({schemaVersion:1,kind:'prepared-usgs-source-scene',source,content:prepared.content,contentDigest:prepared.contentDigest,
    version:`prepared:${await pluginFactsDigest({source,contentDigest:prepared.contentDigest})}`},PREPARED_USGS_LIMITS.preparedBytes);
}

/** Pure derivative of the completed, digest-verified stored observation reader.
 * This does not authenticate a caller, read raw evidence, acquire providers or publish heads. */
export async function buildPreparedUsgsScene(snapshot, { signal } = {}) {
  signal?.throwIfAborted();
  const receipt = snapshot?.receipt;
  if (snapshot?.schemaVersion !== 1 || snapshot.configured !== true || snapshot.available !== true ||
      snapshot.plugin?.id !== USGS_LIVE_DAY.pluginId || snapshot.plugin.scopeId !== USGS_LIVE_DAY.scopeId ||
      snapshot.scope?.id !== USGS_LIVE_DAY.scopeId || snapshot.scope.sourceId !== 'usgs' ||
      snapshot.scope.minimumMagnitude !== 2.5 || snapshot.scope.windowHours !== 24 ||
      !receipt || !RECEIPT.test(receipt.id) || snapshot.version !== receipt.id || !Number.isSafeInteger(receipt.fence) || receipt.fence < 1 ||
      ![receipt.factsDigest, receipt.rawSha256, receipt.artifactSha256].every(value => typeof value === 'string' && HASH.test(value)) ||
      ![receipt.capturedAt, receipt.recordedAt, receipt.sourceUpdatedAt].every(utc) ||
      snapshot.knownAt !== null && (!utc(snapshot.knownAt) || receipt.recordedAt > snapshot.knownAt) ||
      snapshot.coverage?.complete !== true || snapshot.coverage.recordCount !== snapshot.records?.length)
    fail('Use one complete retained USGS observation edition');
  const facts = validateUsgsLiveDayFacts({ schemaVersion: 1, kind: 'usgs-rolling-seismic-observations',
    scopeId: USGS_LIVE_DAY.scopeId, sourceId: 'usgs', minimumMagnitude: 2.5, windowHours: 24, records: snapshot.records });
  const counts = new Map(); for (const record of facts.records) counts.set(record.eventType, (counts.get(record.eventType) || 0) + 1);
  const overview = usgsLiveDayOverview({ canonicalFacts: facts, sourceGeneratedAt: receipt.sourceUpdatedAt,
    sourceFeatureCount: snapshot.overview?.sourceFeatureCount,
    countsBySourceType: [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => String(a.type).localeCompare(String(b.type))) });
  if (!Number.isSafeInteger(overview.sourceFeatureCount) || overview.sourceFeatureCount < facts.records.length ||
      overview.sourceFeatureCount > USGS_LIVE_DAY.features || pluginJson(snapshot.overview) !== pluginJson(overview) ||
      await pluginFactsDigest(facts) !== receipt.factsDigest || await pluginFactsDigest(overview) !== receipt.artifactSha256)
    fail('Prepared scene evidence does not match its retained receipt');
  signal?.throwIfAborted();
  const features = await Promise.all(facts.records.map(async record => {
    signal?.throwIfAborted();
    return { id: `earthquake:${record.stableId}`, revision: await pluginFactsDigest(record), record };
  }));
  // Indexing wraps the dateline/clamps poles; reported coordinates stay exact.
  const levels = geographicLevels(features,signal);
  const content = { schemaVersion: 1, policyId: PREPARED_USGS_POLICY, scopeId: USGS_LIVE_DAY.scopeId,
    factsDigest: receipt.factsDigest, features, levels };
  const contentDigest = await pluginFactsDigest(content);
  const source = preparedUsgsSource(receipt);
  signal?.throwIfAborted();
  return bounded({ schemaVersion: 1, kind: 'prepared-usgs-source-scene', source, content, contentDigest,
    version: `prepared:${await pluginFactsDigest({ source, contentDigest })}` }, PREPARED_USGS_LIMITS.preparedBytes);
}

/** Select already prepared whole geographic cells. API/storage admission must
 * verify the authoritative source basis and immutable content before this internal transform. */
export async function selectPreparedUsgsCells(prepared, { level, cells, mode = 'clusters' } = {}) {
  if (prepared?.schemaVersion !== 1 || prepared.kind !== 'prepared-usgs-source-scene' || prepared.content?.policyId !== PREPARED_USGS_POLICY ||
      !Number.isInteger(level) || !['clusters', 'features'].includes(mode) || !Array.isArray(cells) || cells.length > PREPARED_USGS_LIMITS.selectedCells)
    fail('Use a bounded prepared geographic-cell selection');
  const grid = prepared.content.levels.find(value => value.level === level);
  if (!grid) fail('Choose an available prepared detail level');
  const requested = [], seen = new Set();
  for (const cell of cells) {
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger) || cell[0] < 0 || cell[0] >= grid.columns || cell[1] < 0 || cell[1] >= grid.rows)
      fail('Invalid geographic cell');
    const key = cell.join('/'); if (seen.has(key)) fail('Duplicate geographic cell'); seen.add(key); requested.push([...cell]);
  }
  requested.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const selected = grid.cells.filter(cell => seen.has(`${cell.x}/${cell.y}`)), indices = selected.flatMap(cell => cell.indices).sort((a, b) => a - b);
  const selection = { level, cells: requested, mode }, selectionKey = await pluginFactsDigest(selection);
  const clusters = mode === 'clusters' ? selected.map(cell => {
    const west = -180 + cell.x * 360 / grid.columns, east = west + 360 / grid.columns;
    const north = 90 - cell.y * 180 / grid.rows, south = north - 180 / grid.rows;
    return { id: `seismic-cell:${level}:${cell.x}:${cell.y}`, lon: (west + east) / 2, lat: (south + north) / 2,
      bounds: { west, south, east, north }, count: cell.indices.length, maximumMagnitude: cell.maximumMagnitude,
      positionMeaning: 'Geographic-cell summary, not an event epicenter' };
  }) : [];
  return bounded({ schemaVersion: 1, kind: 'prepared-usgs-regional-scene', policyId: PREPARED_USGS_POLICY,
    source: prepared.source, contentDigest: prepared.contentDigest, selection, selectionKey,
    version: `view:${await pluginFactsDigest([prepared.version, selectionKey])}`,
    features: mode === 'features' ? indices.map(index => prepared.content.features[index]) : [], clusters,
    counts: { sourceReports: prepared.content.features.length, selectedReports: indices.length, features: mode === 'features' ? indices.length : 0, clusters: clusters.length },
    coverage: { selectedCellsComplete: true, sourceMembershipComplete: true,
      meaning: 'Complete selected cells within the retained rolling-day response; not all physical events or a historical archive' } }, PREPARED_USGS_LIMITS.viewBytes);
}

/** Delta applies only to an exact prior regional version. Display removals never
 * assert withdrawal, an event ending, or evidence deletion. No stream is created here. */
export function diffPreparedUsgsViews(previous, next) {
  if (previous?.kind !== 'prepared-usgs-regional-scene' || next?.kind !== previous.kind || previous.schemaVersion !== 1 || next.schemaVersion !== 1 ||
      previous.policyId !== PREPARED_USGS_POLICY || next.policyId !== previous.policyId || previous.source?.scopeId !== USGS_LIVE_DAY.scopeId ||
      next.source?.scopeId !== previous.source.scopeId || previous.selectionKey !== next.selectionKey || pluginJson(previous.selection) !== pluginJson(next.selection))
    return { snapshotRequired: true, reason: 'selection-or-policy-changed' };
  if (next.source.fence < previous.source.fence || next.source.fence === previous.source.fence && pluginJson(next.source) !== pluginJson(previous.source))
    return { snapshotRequired: true, reason: 'source-edition-incomparable' };
  const diff = (before, after, equal) => {
    const old = new Map(before.map(value => [value.id, value])), current = new Map(after.map(value => [value.id, value]));
    return { upserts: after.filter(value => !old.has(value.id) || !equal(old.get(value.id), value)), removals: before.filter(value => !current.has(value.id)).map(value => value.id) };
  };
  const features = diff(previous.features, next.features, (a, b) => a.revision === b.revision);
  const clusters = diff(previous.clusters, next.clusters, (a, b) => pluginJson(a) === pluginJson(b));
  const value = { schemaVersion: 1, kind: 'prepared-usgs-scene-delta', snapshotRequired: false,
    baseVersion: previous.version, version: next.version, source: next.source, selectionKey: next.selectionKey,
    counts: next.counts, coverage: next.coverage, upsertFeatures: features.upserts, removeFeatureIds: features.removals,
    upsertClusters: clusters.upserts, removeClusterIds: clusters.removals,
    removalMeaning: 'No longer visible in this selected source cohort; no withdrawal, ending or evidence deletion asserted' };
  if (UTF8.encode(pluginJson(value)).byteLength > PREPARED_USGS_LIMITS.deltaBytes) return { snapshotRequired: true, reason: 'delta-byte-budget' };
  return freeze(value);
}
