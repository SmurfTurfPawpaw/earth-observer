import test from 'node:test';
import assert from 'node:assert/strict';
import { gdacsNoticeSelection, createGdacsNoticeDossier, updateGdacsNoticeDossier } from './gdacs-dossier.js';
import { canonicalDiscoveryRecord } from './discovery-index.js';
import { createWorldSourceItem } from './world-model.js';
import { worldHash } from './world-identity.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this._text = ''; this.dataset = {}; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Source HTML must remain literal text'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get firstElementChild() { return this.children[0] || null; }
  querySelector(selector) {
    const [tag, className] = selector.split('.');
    return this.children.flatMap(walk).find(node => node.tagName === tag && (!className || node.className?.split(' ').includes(className))) || null;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { documentRef.activeElement = this; }
}
const documentRef = { createElement: tag => new Node(tag) }, walk = node => [node, ...node.children.flatMap(walk)];
async function entity(changes = {}) {
  const capturedAt = '2026-10-12T03:30:00.000Z', publishedAt = '2026-10-12T03:30:01.000Z';
  const record = canonicalDiscoveryRecord({ id: 'gdacs:FL:1001:1', sourceId: 'gdacs', source: 'GDACS', kind: 'hazard-report', category: 'disasters',
    title: 'TEST ONLY source flood notice', eventType: 'FL', alertLevel: 'Orange', country: 'Belgium', lat: 50, lon: 4,
    url: 'https://www.gdacs.org/report.aspx?eventid=1001&eventtype=FL&episodeid=1', observedAt: '2026-10-11T10:00:00.000Z',
    eventEndAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-12T02:00:00.000Z', retrievedAt: '2026-10-12T03:29:59.000Z', ...changes });
  const snapshotId = await worldHash(record), item = { ...await createWorldSourceItem(record, { snapshotId, capturedAt, recordedAt: publishedAt }),
    origin: { snapshotId: 'a'.repeat(64), firstCapturedAt: '2026-10-11T11:00:00.000Z', firstRecordedAt: '2026-10-11T11:00:01.000Z',
      validation: 'retained-revision-index-only', bodyValidated: false } };
  const notice = { schemaVersion: 1, version: 'b'.repeat(64), source: { id: 'gdacs', url: 'https://www.gdacs.org/', attribution: 'Global Disaster Alert and Coordination System, GDACS' },
    item, cohort: { sourceId: 'gdacs', snapshotId, bodySha256: 'c'.repeat(64), capturedAt, publishedAt },
    coverage: { mode: 'retained-seven-day-notice-sample', windowDays: 7, completeRetainedCohort: true, completeProviderArchive: false },
    operational: { status: 'unknown', checkedAt: null }, history: { replay: false, future: false } };
  return { id: `gdacs-notice:${item.itemId}`, properties: { getValue: () => ({ _gdacsNotice: notice }) }, notice };
}

test('a retained GDACS notice presents literal source dates and link with independently qualified current cohort/index evidence', async () => {
  const selected = await entity(), selection = gdacsNoticeSelection(selected, null), dossier = createGdacsNoticeDossier(selection, { documentRef });
  assert.equal(selection.title, selected.notice.item.record.title); assert.equal(selection.kind, 'Flood · GDACS notice');
  const link = walk(dossier).find(node => node.tagName === 'a'); assert.equal(link.href, selected.notice.item.record.url); assert.equal(link.rel, 'noopener noreferrer');
  assert.match(dossier.textContent, /Reported start UTC2026-10-11 10:00:00.000 UTC/);
  assert.match(dossier.textContent, /Source revised UTC2026-10-12 02:00:00.000 UTC/);
  assert.match(dossier.textContent, /Current cohort captured2026-10-12 03:30:00.000 UTC/);
  assert.match(dossier.textContent, /Current cohort published2026-10-12 03:30:01.000 UTC/);
  assert.match(dossier.textContent, /This revision first indexed capture2026-10-11 11:00:00.000 UTC/);
  assert.match(dossier.textContent, /This revision first indexed publication2026-10-11 11:00:01.000 UTC/);
  assert.match(dossier.textContent, /original body is not validated/); assert.match(dossier.textContent, /not raw provider originals/);
  const proof = walk(dossier).find(node => node.tagName === 'details'); assert.equal(Boolean(proof.open), false);
  assert.match(proof.textContent, /Reported interval to UTC2026-10-13 10:00:00.000 UTC/);
  assert.match(proof.textContent, /does not confirm that the event ended/); assert.match(proof.textContent, /freshness is unknown/);
  assert.match(proof.textContent, /independent of globe time/);
});

test('unknown locations and valid canonical long titles retain an inspectable source dossier without fabricated geometry', async () => {
  const selected = await entity({ lat: undefined, lon: undefined, title: 'A'.repeat(280) });
  const selection = gdacsNoticeSelection(selected, null); assert.equal(selection.title.length, 280);
  assert.match(createGdacsNoticeDossier(selection, { documentRef }).textContent, /Indicative locationNot reported/);
  assert.equal(selected.position, undefined);
  const literal = await entity({ title: '<img src=x onerror=alert(1)> Source notice', country: '<script>TEST ONLY</script>' });
  const dossier = createGdacsNoticeDossier(gdacsNoticeSelection(literal, null), { documentRef }); assert.match(dossier.textContent, /<script>TEST ONLY<\/script>/);
});

test('foreign executable links, mismatched episode/identity/revision/cohort and fabricated freshness or originals cannot enter the dossier', async () => {
  const selected = await entity();
  for (const change of [value => { value.item.record.url = 'javascript:alert(1)'; }, value => { value.item.record.url = 'https://example.com/report'; },
    value => { value.item.record.url = 'https://www.gdacs.org/report.aspx?eventid=1001&eventtype=FL&episodeid=2'; },
    value => { value.item.evidence.snapshotId = value.item.origin.snapshotId; }, value => { value.item.evidence.revision = 'd'.repeat(64); },
    value => { value.item.origin.bodyValidated = true; }, value => { value.operational.checkedAt = value.cohort.publishedAt; },
    value => { value.history.replay = true; }]) {
    const notice = structuredClone(selected.notice); change(notice);
    const candidate = { id: selected.id, properties: { getValue: () => ({ _gdacsNotice: notice }) } };
    assert.equal(gdacsNoticeSelection(candidate, null), null); assert.equal(createGdacsNoticeDossier({ notice }, { documentRef }), null);
  }
  assert.equal(gdacsNoticeSelection({ ...selected, id: 'earthquake:unrelated' }, null), null);
  assert.equal(gdacsNoticeSelection({ id: selected.id, properties: { getValue: () => ({ _gdacsNotice: selected.notice, _worldScene: { mode: 'as-known' } }) } }, null), null);
});

test('same-notice corrections update evidence while preserving its disclosure and summary focus; new episodes and containers start closed', async () => {
  const first = await entity(), container = new Node('div');
  assert.equal(updateGdacsNoticeDossier(container, gdacsNoticeSelection(first, null), { documentRef }), true);
  const prior = container.firstElementChild, disclosure = prior.querySelector('details.world-evidence'), summary = disclosure.querySelector('summary');
  disclosure.open = true; summary.focus();
  const corrected = await entity({ title: 'TEST ONLY corrected source notice' });
  assert.equal(updateGdacsNoticeDossier(container, gdacsNoticeSelection(corrected, null), { documentRef }), true);
  assert.notEqual(container.firstElementChild, prior); assert.equal(container.firstElementChild.querySelector('details.world-evidence').open, true);
  assert.equal(documentRef.activeElement, container.firstElementChild.querySelector('summary'));
  assert.match(container.textContent, new RegExp(corrected.notice.item.revision)); assert.doesNotMatch(container.textContent, new RegExp(first.notice.item.revision));
  const other = await entity({ id: 'gdacs:FL:1001:2', url: 'https://www.gdacs.org/report.aspx?eventid=1001&eventtype=FL&episodeid=2' });
  updateGdacsNoticeDossier(container, gdacsNoticeSelection(other, null), { documentRef }); assert.equal(container.firstElementChild.querySelector('details.world-evidence').open, false);
  const fresh = new Node('div'); updateGdacsNoticeDossier(fresh, gdacsNoticeSelection(corrected, null), { documentRef });
  assert.equal(fresh.firstElementChild.querySelector('details.world-evidence').open, false);
  const visible = container.firstElementChild; assert.equal(updateGdacsNoticeDossier(container, null, { documentRef }), false); assert.equal(container.firstElementChild, visible);
});
