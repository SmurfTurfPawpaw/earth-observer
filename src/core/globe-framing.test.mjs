import test from 'node:test';
import assert from 'node:assert/strict';
import { globeFrameAltitude } from './globe-framing.js';
test('global framing fills the same short-axis fraction on desktop and portrait without clipping', () => {
  for (const [width, height] of [[1384, 884], [390, 844], [844, 390], [800, 800]]) {
    const fov = Math.PI / 3, radius = 6378137, fill = .8;
    const alt = globeFrameAltitude({ width, height, fov, radius, fill });
    const smallerHalf = Math.atan(Math.tan(fov / 2) * Math.min(width, height) / Math.max(width, height));
    const projectedFraction = Math.tan(Math.asin(radius / (radius + alt))) / Math.tan(smallerHalf);
    assert.ok(Math.abs(projectedFraction - fill) < 1e-10);
    assert.ok(alt > 250 && alt < 50000000);
    assert.ok(globeFrameAltitude({ width, height, fill: .65 }) > alt);
  }
});
test('invalid framing cannot become a NaN camera destination', () => {
  for (const geometry of [{ width: 0 }, { height: NaN }, { fov: Math.PI }, { fill: 1 }, { radius: -1 }]) assert.throws(() => globeFrameAltitude(geometry), TypeError);
});
