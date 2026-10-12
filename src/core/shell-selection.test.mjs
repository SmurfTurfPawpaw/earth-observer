import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { liveEarthquakeSelection, createLiveEarthquakeDossier, selectionFields } from './shell.js';

const at = Cesium.JulianDate.fromIso8601('2026-10-12T02:26:17Z');
const facts = { usgsId: 'us6000u1iz', mag: 4.2, place: '26 km SE of Jurm, Afghanistan', time: Date.parse('2026-10-11T23:14:20.125Z'), depth: 213.6 };
const entity = (values = facts, id = `earthquake:${values.usgsId}`) => new Cesium.Entity({ id,
  position: Cesium.Cartesian3.fromDegrees(71.02, 36.72), properties: values });
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ''; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
}
const documentRef = { createElement: tag => new Node(tag) };
const nodes = node => [node, ...node.children.flatMap(nodes)];

test('a live picked point has readable reported facts, explicit occurrence UTC and one identity-bound official source link', () => {
  const point = entity(), selection = liveEarthquakeSelection(point, at), display = createLiveEarthquakeDossier(selection, { documentRef });
  assert.equal(selection.title, 'Magnitude 4.2 · 26 km SE of Jurm, Afghanistan');
  assert.equal(selection.sourceUrl, 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u1iz');
  assert.ok(selection.fields.some(([label, value]) => label === 'Occurred UTC' && value === '2026-10-11 23:14:20.125 UTC'));
  assert.ok(selection.fields.some(([label, value]) => label === 'Reported epicenter' && value === '36.72000°, 71.02000°'));
  const links = nodes(display).filter(node => node.tagName === 'a'); assert.equal(links.length, 1);
  assert.equal(links[0].href, selection.sourceUrl); assert.equal(links[0].rel, 'noopener noreferrer');
  assert.match(display.textContent, /Source: U.S. Geological Survey \(USGS\)/);
  assert.doesNotMatch(display.textContent, /First retained|Capture published|archive|snapshot|independently verified/);
  assert.deepEqual(point.properties.getValue(at), facts, 'the readable renderer does not mutate source facts or add retention claims');
});

test('missing, malformed and mismatched reported IDs cannot become source URLs while text remains readable and DOM-safe', () => {
  for (const id of [null, '', '../us6000u1iz', 'us6000u1iz?other=1', 'javascript:alert(1)', 'US6000U1IZ', 'a'.repeat(33)]) {
    const values = { ...facts, usgsId: id, place: '<img src=x onerror=alert(1)>' }, selection = liveEarthquakeSelection(entity(values), at);
    assert.equal(selection.sourceUrl, null); const display = createLiveEarthquakeDossier(selection, { documentRef });
    assert.equal(nodes(display).some(node => node.tagName === 'a' || node.tagName === 'img'), false); assert.ok(display.textContent.includes(values.place));
  }
  assert.equal(liveEarthquakeSelection(entity(facts, 'earthquake:us6000other'), at).sourceUrl, null);
  for (const url of ['javascript:alert(1)', 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u1iz?foreign=1', 'https://example.com/us6000u1iz']) {
    const display = createLiveEarthquakeDossier({ ...liveEarthquakeSelection(entity(), at), sourceUrl: url }, { documentRef });
    assert.equal(nodes(display).some(node => node.tagName === 'a'), false);
  }
});

test('missing occurrence and measurements stay unspecified; other layers and archive/context selections keep their existing path', () => {
  const selection = liveEarthquakeSelection(entity({ ...facts, time: NaN, depth: null, mag: null, place: null }), at);
  assert.equal(selection.title, 'Earthquake'); assert.deepEqual(selection.fields.slice(0, 2), [['Magnitude', 'Not reported'], ['Occurred UTC', 'Not reported']]);
  for (const [id, extra] of [['aircraft:us6000u1iz', {}], ['history:us6000u1iz', {}], ['earthquake:us6000u1iz', { _worldScene: { mode: 'reconstruction' } }], ['earthquake:us6000u1iz', { _worldReport: { kind: 'retained-source-context' } }]])
    assert.equal(liveEarthquakeSelection(entity({ ...facts, ...extra }, id), at), null);
  const other = entity({ name: 'Other layer', time: 1000 }, 'aircraft:other');
  assert.ok(selectionFields(other, at).some(([label, value]) => label === 'Time' && value === '1000'));
  assert.equal(createLiveEarthquakeDossier(null, { documentRef }), null);
});
