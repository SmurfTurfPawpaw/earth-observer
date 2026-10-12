import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMapBillboard, mapSymbolImage, gdacsMapSymbol, gdacsAlertColor, MAP_SYMBOL_KINDS } from './map-symbols.js';

test('source categories reuse seven fixed atlas images and never interpolate provider markup or URLs', () => {
  const images = new Set(MAP_SYMBOL_KINDS.map(mapSymbolImage));
  assert.equal(images.size, 7);
  for (const type of ['EQ', 'FL', 'TC', 'VO', 'WF', 'DR']) assert.ok(MAP_SYMBOL_KINDS.includes(gdacsMapSymbol({ eventType: type })));
  assert.equal(gdacsMapSymbol({ eventType: '<script>bad</script>' }), 'notice');
  assert.equal(mapSymbolImage('https://foreign.invalid/image.svg'), mapSymbolImage('notice'));
  for (const image of images) {
    const svg = decodeURIComponent(image.slice('data:image/svg+xml,'.length));
    assert.match(svg, /viewBox="0 0 32 32"/);
    assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''), /<script|<foreignObject|href=|onload=|https?:\/\//i,
      'The fixed category artwork contains no executable markup or provider URLs');
  }
});

test('constant billboards share artwork but own color state and retain centered normal surface occlusion', () => {
  const a = createMapBillboard('seismic', { color: Cesium.Color.RED, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND });
  const b = createMapBillboard('seismic', { color: Cesium.Color.YELLOW });
  const at = Cesium.JulianDate.now();
  assert.notEqual(a, b); assert.equal(a.image.getValue(at), b.image.getValue(at));
  a.color = Cesium.Color.BLUE; assert.equal(b.color.getValue(at).equals(Cesium.Color.YELLOW), true);
  assert.equal(a.image.isConstant, true); assert.equal(a.color.isConstant, true);
  assert.equal(a.horizontalOrigin.getValue(at), Cesium.HorizontalOrigin.CENTER);
  assert.equal(a.verticalOrigin.getValue(at), Cesium.VerticalOrigin.CENTER);
  assert.equal(a.heightReference.getValue(at), Cesium.HeightReference.CLAMP_TO_GROUND);
  assert.equal(b.heightReference.getValue(at), Cesium.HeightReference.NONE);
  assert.equal(a.disableDepthTestDistance, undefined);
  const distance = a.scaleByDistance.getValue(at);
  assert.ok(distance.near < distance.far && distance.nearValue <= 1 && distance.farValue >= .8);
  assert.equal(a.width.getValue(at), a.height.getValue(at)); assert.ok(a.width.getValue(at) <= 24);
});

test('GDACS alert coloring depends only on the source declaration and keeps unknown values neutral', () => {
  assert.notEqual(gdacsAlertColor('Red'), gdacsAlertColor('Green'));
  assert.equal(gdacsAlertColor('Orange'), gdacsAlertColor('orange'));
  assert.equal(gdacsAlertColor(null), gdacsAlertColor('unexpected'));
  assert.equal(gdacsAlertColor('https://foreign.invalid/'), gdacsAlertColor(null));
});
