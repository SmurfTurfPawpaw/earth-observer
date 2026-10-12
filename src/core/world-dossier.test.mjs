import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldDossier } from './world-dossier.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ''; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
}
const documentRef = { createElement: (tag) => new Node(tag) };
const event = { schemaVersion: 1, id: `event:usgs:${'a'.repeat(64)}`, kind: 'earthquake', source: { id: 'usgs', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/test' },
  evidence: { revision: 'b'.repeat(64), snapshotId: 'c'.repeat(64) }, place: { lat: 50, lon: 4 }, reportedFacts: { magnitude: 5.2, reviewStatus: 'reviewed' },
  eventTime: { at: '2025-06-01T12:00:00.000Z' }, sourceTimes: { updatedAt: '2025-06-02T12:00:00.000Z' },
  knowledge: { firstRecordedAt: '2026-10-12T02:00:00.000Z', firstCapturedAt: '2026-10-12T01:59:00.000Z' },
  archive: { scopeId: 'usgs-catalog-m4.5-v1', capturedAt: '2026-10-12T01:59:00.000Z', publishedAt: '2026-10-12T02:00:00.000Z', conflictCount: 1 } };
const entity = (mode) => ({ properties: { getValue: () => ({ _worldEvent: event, _worldScene: { mode } }) } });

test('a reconstructed old event keeps occurrence, scientific correction and actual archive publication dates separate', () => {
  const dossier = createWorldDossier(entity('reconstruction'), null, { documentRef });
  assert.match(dossier.textContent, /Occurred2025-06-01 12:00:00 UTC/); assert.match(dossier.textContent, /Source revised2025-06-02 12:00:00 UTC/);
  assert.match(dossier.textContent, /First retained2026-10-12 02:00:00 UTC/); assert.match(dossier.textContent, /Archive published2026-10-12 02:00:00 UTC/);
  assert.match(dossier.textContent, /Historical reconstruction uses retained USGS corrections/); assert.match(dossier.textContent, /alternative retained revision/);
});

test('knowledge replay has its own explanation and source links cannot become arbitrary executable URLs', () => {
  assert.match(createWorldDossier(entity('as-known'), null, { documentRef }).textContent, /only evidence this platform published by the selected UTC/);
  const forged = { properties: { getValue: () => ({ _worldEvent: { ...event, source: { id: 'usgs', url: 'javascript:alert(1)' } } }) } };
  assert.equal(createWorldDossier(forged, null, { documentRef }), null);
});

test('a source-context dossier explicitly separates retained report dates from globe time and adds no map feature', () => {
  const selected = { properties: { getValue: () => ({ _worldEvent: event, _worldReport: { kind: 'retained-source-context' } }) } };
  const dossier = createWorldDossier(selected, null, { documentRef });
  assert.match(dossier.textContent, /independent of the selected globe time/); assert.match(dossier.textContent, /does not add a map feature/);
  assert.match(dossier.textContent, /Occurred2025-06-01 12:00:00 UTC/);
});
