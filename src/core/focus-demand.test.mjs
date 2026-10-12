import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFocusDemand, extractCameraFocusDemand, FOCUS_DEMAND_LIMITS } from './focus-demand.js';
import { focusSceneSelection } from './focus-scene-contract.js';

const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
const owned = (leaf, point) => { const [level, x, y] = leaf, columns = 8 * 2 ** level, rows = 4 * 2 ** level;
  return Math.floor((wrap(point.lon) + 180) / 360 * columns) === x && Math.min(rows - 1, Math.max(0, Math.floor((90 - point.lat) / 180 * rows))) === y; };
const sampleCover = (demand, points) => { focusSceneSelection(demand); assert.ok(demand.leaves.length <= 128);
  for (const point of points) assert.equal(demand.leaves.filter(leaf => owned(leaf, point)).length, 1, JSON.stringify(point)); };
const world = { bounds: { west: -180, south: -90, east: 180, north: 90 }, center: { lon: 4, lat: 50 }, width: 1280, height: 720 };

test('mixed world leaves cover every sampled location once and spend finer detail on the center without building a global fine grid', () => {
  const demand = selectFocusDemand(world), points = [];
  for (let lon = -180; lon < 180; lon += 15) for (let lat = -90; lat <= 90; lat += 15) points.push({ lon, lat });
  sampleCover(demand, points); assert.ok(demand.displayBudget.refinements > 0); assert.ok(demand.focus[0] > Math.min(...demand.leaves.map(leaf => leaf[0])));
  assert.equal(demand.featureBudget, 0); assert.equal(demand.coverage.disjointLeaves, true); assert.ok(demand.displayBudget.leafCapacity <= 128);
});

test('city zoom goes beyond legacy detail while retaining a disjoint complete footprint and bounded projected screen/query work', () => {
  const input = { bounds: { west: 4.344, south: 50.844, east: 4.356, north: 50.856 }, center: { lon: 4.35, lat: 50.85 }, width: 1000, height: 700 },
    demand = selectFocusDemand(input), points = [];
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) points.push({ lon: input.bounds.west + i * .012 / 20, lat: input.bounds.south + j * .012 / 20 });
  sampleCover(demand, points); assert.ok(demand.focus[0] > 12); assert.equal(demand.featureBudget, 6);
  assert.ok(demand.leaves.every(leaf => leaf[0] <= FOCUS_DEMAND_LIMITS.maxLevel));
  assert.ok(encodeURIComponent(demand.leaves.map(leaf => leaf.join(':')).join(',')).length <= FOCUS_DEMAND_LIMITS.queryLeafBytes);
  assert.match(demand.displayBudget.projection, /not native screen visibility/);
});

test('dateline, longitude endpoints and both polar caps preserve coverage exactly once under coarsening rather than truncation', () => {
  const crossed = selectFocusDemand({ bounds: { west: 178, south: -5, east: -178, north: 5 }, center: { lon: 180, lat: 0 }, width: 390, height: 844 });
  sampleCover(crossed, [-180, -179.999, -178, 178, 179.999, 180].flatMap(lon => [-5, 0, 5].map(lat => ({ lon, lat }))));
  for (const north of [true, false]) {
    const cap = selectFocusDemand({ bounds: { west: 4, east: 5, south: north ? 89 : -90, north: north ? 90 : -89 },
      center: { lon: 4.5, lat: north ? 89.9 : -89.9 }, width: 320, height: 240 });
    sampleCover(cap, Array.from({ length: 37 }, (_, i) => ({ lon: -180 + i * 10, lat: north ? 90 : -90 })));
    assert.equal(cap.coverage.poleLongitudeExpanded, true); assert.ok(cap.leaves.length <= 128);
  }
});

test('tiny screens and extreme zoom use finite bounded cells; native camera fallback stays conservative and side-effect free', () => {
  const tiny = selectFocusDemand({ ...world, width: 1, height: 1 }); assert.equal(tiny.leaves.length, 32);
  const close = selectFocusDemand({ bounds: { west: 4.35, east: 4.350001, south: 50.85, north: 50.850001 },
    center: { lon: 4.3500005, lat: 50.8500005 }, width: 1280, height: 720 });
  sampleCover(close, [{ lon: 4.3500005, lat: 50.8500005 }]); assert.equal(close.focus[0], 18);
  const viewer = { camera: { computeViewRectangle: () => undefined, positionCartographic: { longitude: 0, latitude: 0 } },
    canvas: { clientWidth: 1280, clientHeight: 720 } }, camera = viewer.camera;
  const fallback = extractCameraFocusDemand(viewer, {}); assert.equal(viewer.camera, camera); assert.equal(fallback.extraction.method, 'conservative-world');
  sampleCover(fallback, [{ lon: -179, lat: -89 }, { lon: 179, lat: 89 }]);
  assert.throws(() => selectFocusDemand({ ...world, bounds: { ...world.bounds, west: NaN } }), TypeError);
});
