import { selectSpatialDemand, extractCameraDemand } from './spatial-demand.js';
import { focusSceneSelection, focusLeafBounds, FOCUS_SCENE_POLICY } from './focus-scene-contract.js';

export const FOCUS_DEMAND_LIMITS = Object.freeze({ leaves: 128, maxLevel: 18, peripheralPixels: 128,
  centerPixels: 32, queryLeafBytes: 3200 });
const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
const span = bounds => Math.abs(bounds.east - bounds.west) === 360 ? 360 : bounds.east >= bounds.west ?
  bounds.east - bounds.west : 360 + bounds.east - bounds.west;
const grid = level => [8 * 2 ** level, 4 * 2 ** level];
const compare = (a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1];
const leafAt = (point, level) => { const [columns, rows] = grid(level); return [level,
  Math.floor((wrap(point.lon) + 180) / 360 * columns), Math.min(rows - 1, Math.max(0, Math.floor((90 - point.lat) / 180 * rows)))]; };
const equalLeaf = (a, b) => a && b && a.every((value, index) => value === b[index]);
const children = ([level, x, y]) => [[level + 1, 2 * x, 2 * y], [level + 1, 2 * x + 1, 2 * y],
  [level + 1, 2 * x, 2 * y + 1], [level + 1, 2 * x + 1, 2 * y + 1]];
const leafBytes = leaves => new TextEncoder().encode(encodeURIComponent(leaves.map(leaf => leaf.join(':')).join(','))).byteLength;
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function coverage(bounds, level, limit) {
  const [columns, rows] = grid(level), width = span(bounds), start = Math.floor((wrap(bounds.west) + 180) / 360 * columns),
    end = Math.floor(((wrap(bounds.west) + 180) + width) / 360 * columns), xCount = width === 360 ? columns : Math.min(columns, end - start + 1),
    row = lat => Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / 180 * rows))), first = row(bounds.north), last = row(bounds.south),
    poles = new Set([...(bounds.north === 90 ? [0] : []), ...(bounds.south === -90 ? [rows - 1] : [])]),
    count = xCount * (last - first + 1) + poles.size * (columns - xCount);
  // Compute cardinality before allocating; global fine grids never materialize.
  if (count > limit) return null;
  const xs = width === 360 ? Array.from({ length: columns }, (_, x) => x) :
    [...new Set(Array.from({ length: xCount }, (_, offset) => (start + offset) % columns))].sort((a, b) => a - b);
  const leaves = [];
  for (let y = first; y <= last; y++) {
    if (poles.has(y)) for (let x = 0; x < columns; x++) leaves.push([level, x, y]);
    else for (const x of xs) leaves.push([level, x, y]);
  }
  return leaves;
}
function longitudeIntersection(a, bounds) {
  const pieces = span(bounds) === 360 ? [[-180, 180]] : bounds.east >= bounds.west ? [[bounds.west, bounds.east]] :
    [[bounds.west, 180], [-180, bounds.east]];
  return pieces.reduce((sum, [west, east]) => sum + Math.max(0, Math.min(a.east, east) - Math.max(a.west, west)), 0);
}
function pixels(leaf, bounds, width, height) {
  const box = focusLeafBounds(leaf), longitude = longitudeIntersection(box, bounds), latitude = Math.max(0, Math.min(box.north, bounds.north) - Math.max(box.south, bounds.south));
  return Math.min(width, longitude / Math.max(1e-9, span(bounds)) * width) *
    Math.min(height, latitude / Math.max(1e-9, bounds.north - bounds.south) * height);
}
function distance(leaf, center) {
  const box = focusLeafBounds(leaf), lon = (box.west + box.east) / 2, lat = (box.south + box.north) / 2,
    dx = Math.abs(wrap(lon - center.lon)) * Math.max(.05, Math.cos(center.lat * Math.PI / 180));
  return dx * dx + (lat - center.lat) ** 2;
}

/** Display detail only. Leaves remain a complete disjoint geographic cover;
 * CSS area estimates are angular approximations, not native GPU visibility or source accuracy. */
export function selectFocusDemand(input) {
  const legacy = selectSpatialDemand(input), { bounds, center } = legacy,
    width = Math.min(16384, input.width), height = Math.min(16384, input.height),
    capacity = Math.max(32, Math.min(128, Math.floor(width * height / (FOCUS_DEMAND_LIMITS.peripheralPixels ** 2))));
  let leaves = coverage(bounds, 0, capacity), baseLevel = 0;
  for (let level = 1; level <= 18; level++) {
    const candidate = coverage(bounds, level, capacity);
    if (!candidate || leafBytes(candidate) > FOCUS_DEMAND_LIMITS.queryLeafBytes) break;
    leaves = candidate; baseLevel = level;
  }
  if (!leaves) throw new TypeError('A conservative root cover is required');
  let focus = leaves.find(leaf => equalLeaf(leaf, leafAt(center, leaf[0]))), fallback = false;
  if (!focus) { focus = [...leaves].sort((a, b) => distance(a, center) - distance(b, center) || compare(a, b))[0]; fallback = true; }
  const focusPoint = fallback ? (() => { const box = focusLeafBounds(focus); return { lon: (box.west + box.east) / 2, lat: (box.south + box.north) / 2 }; })() : center;
  let refinements = 0, queryCoarsened = false;
  // Every replacement adds exactly three leaves. At most128 nodes and18 levels are considered, never a global fine grid.
  while (leaves.length + 3 <= capacity) {
    const candidates = leaves.filter(leaf => leaf[0] < 18).map(leaf => {
      const centered = equalLeaf(leaf, leafAt(focusPoint, leaf[0])), area = pixels(leaf, bounds, width, height), threshold = centered ? 32 ** 2 : 128 ** 2;
      return { leaf, centered, score: area / threshold, distance: distance(leaf, focusPoint) };
    }).filter(item => item.score >= 1).sort((a, b) => Number(b.centered) - Number(a.centered) || b.score - a.score || a.distance - b.distance || compare(a.leaf, b.leaf));
    if (!candidates.length) break;
    let replaced = false;
    for (const { leaf } of candidates) {
      const candidate = [...leaves.filter(value => value !== leaf), ...children(leaf)].sort(compare);
      if (leafBytes(candidate) > FOCUS_DEMAND_LIMITS.queryLeafBytes) { queryCoarsened = true; continue; }
      leaves = candidate; refinements++; replaced = true; break;
    }
    if (!replaced) break;
  }
  leaves.sort(compare); focus = leaves.find(leaf => equalLeaf(leaf, leafAt(focusPoint, leaf[0])));
  const selection = focusSceneSelection({ schemaVersion: 2, policyId: FOCUS_SCENE_POLICY, leaves, focus,
    featureBudget: legacy.tier === 'world' ? 0 : 6 });
  return freeze({ ...selection, key: JSON.stringify(selection), tier: legacy.tier, bounds, center,
    displayBudget: { cssWidth: width, cssHeight: height, leafCapacity: capacity, baseLevel, refinements, queryCoarsened,
      projection: 'Angular CSS area estimate; not native screen visibility', centerTargetPixels: 32, peripheralTargetPixels: 128 },
    coverage: { allVisibleCells: true, disjointLeaves: true, poleLongitudeExpanded: bounds.north === 90 || bounds.south === -90,
      meaning: 'Complete whole-cell cover of supplied bounds; refinements preserve parent union, not source completeness or coordinate precision' },
    focusFallback: fallback });
}

export function extractCameraFocusDemand(viewer, Cesium) {
  const prior = extractCameraDemand(viewer, Cesium), demand = selectFocusDemand({ bounds: prior.bounds, center: prior.center,
    width: prior.displayBudget.cssWidth, height: prior.displayBudget.cssHeight });
  return freeze({ ...demand, extraction: prior.extraction });
}
