import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_VIEW, parseViewHash, resolvePlace, serializeViewHash } from './navigation-state.js';

test('camera links survive migration while unsupported layers and effects disappear', () => {
  const state = parseViewHash('#v=2&lat=50.7572&lon=4.3502&alt=91675&heading=360&pitch=-90&style=ir&l=s.t', ['earthquakes']);
  assert.equal(state.view.lat, 50.7572);
  assert.equal(state.view.lon, 4.3502);
  assert.equal(state.view.alt, 91675);
  assert.equal(state.view.heading, 360);
  assert.equal(state.layers, undefined);
  assert.equal(state.view.style, undefined);
});

test('malformed camera coordinates never reach Cesium', () => {
  const state = parseViewHash('#lat=999&lon=NaN&alt=-7&heading=Infinity&pitch=20&roll=');
  assert.deepEqual(state.view, HOME_VIEW);
});

test('share links round-trip enabled layers and filter unknown parameters', () => {
  const hash = serializeViewHash({ ...HOME_VIEW, lat: -33.86881, lon: 151.20929 }, ['wind', 'wind', 'earthquakes'], { wind: { model: 'gfs', height: 10 }, private: { apiKey: 'none' } });
  const state = parseViewHash(hash, ['wind', 'earthquakes']);
  assert.equal(state.view.lat, -33.86881);
  assert.equal(state.view.lon, 151.20929);
  assert.deepEqual(state.layers, ['wind', 'earthquakes']);
  assert.deepEqual(state.layerParams, { wind: { model: 'gfs', height: 10 } });
  assert.deepEqual(parseViewHash('#layers=', ['wind']).layers, []);
});

test('coordinate search checks both ranges and keeps latitude-longitude order', () => {
  assert.deepEqual(resolvePlace('50.85, 4.35'), { name: '50.8500, 4.3500', lat: 50.85, lon: 4.35 });
  assert.equal(resolvePlace('91, 4.35'), null);
  assert.equal(resolvePlace('50.85, -181'), null);
  assert.equal(resolvePlace('50.85, Infinity'), null);
});

test('offline search supports accents and rejects ambiguous or empty queries', () => {
  assert.equal(resolvePlace('sao paulo').name, 'São Paulo');
  assert.equal(resolvePlace('Brussels').lat, 50.8503);
  assert.equal(resolvePlace(''), null);
  assert.equal(resolvePlace('new'), null);
  assert.equal(resolvePlace('somewhere unknown'), null);
});
