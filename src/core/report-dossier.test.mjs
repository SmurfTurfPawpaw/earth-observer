import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportDossierController, retainedReportReference } from './report-dossier.js';
import { createWorldSourceItem, provisionalWorldEvent } from './world-model.js';

const at = '2026-10-12T00:00:00.000Z';
const report = { id: 'usgs:us7000test', sourceId: 'usgs', kind: 'hazard-report', eventType: 'EQ',
  title: 'M 5.1 - retained fixture', source: 'U.S. Geological Survey', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',
  category: 'disasters', observedAt: at, updatedAt: at, retrievedAt: at, lat: 10, lon: 20, magnitude: 5.1, reviewStatus: 'reviewed' };
const item = await createWorldSourceItem(report, { snapshotId: 'a'.repeat(64), capturedAt: at, recordedAt: at });
const event = { ...provisionalWorldEvent(item), capture: { capturedAt: at, publishedAt: at, snapshotId: 'a'.repeat(64) } };
const payload = { schemaVersion: 1, configured: true, available: true, event };
function fixture(fetchImpl = async () => Response.json(payload)) {
  let scene = { mode: 'history', at: '2025-10-08T00:00:00.000Z' }, selected, navigation = 'initial';
  const opened = [], errors = [], calls = [];
  const controller = createReportDossierController({ getScene: () => scene, getSelection: () => selected, getNavigationKey: () => navigation,
    fetchImpl: (...args) => { calls.push(args); return fetchImpl(...args); }, onOpen: (value) => opened.push(value), onError: (value) => errors.push(value) });
  return { controller, opened, errors, calls, setScene: (value) => { scene = value; }, select: (value) => { selected = value; }, move: () => { navigation = 'moved'; }, scene: () => scene };
}

test('explicit source-context inspection resolves the exact retained revision without changing historical time', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  assert.equal(await f.controller.open(report), true); assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].evidence.revision, item.revision); assert.equal(f.scene().at, '2025-10-08T00:00:00.000Z');
  assert.equal(f.calls[0][0], `/api/world/events/${event.id}`); assert.equal(f.calls[0][1].cache, 'no-store');
  assert.deepEqual(f.errors, []); f.controller.destroy();
});

test('identity and factual revision match before opening; a corrected or substituted event is not silently accepted', async () => {
  for (const forged of [{ ...event, reportedFacts: { ...event.reportedFacts, magnitude: 5.2 } },
    { ...event, evidence: { ...event.evidence, revision: 'b'.repeat(64) } },
    { ...event, evidence: { ...event.evidence, itemId: `item:${'b'.repeat(64)}` } },
    { ...event, source: { ...event.source, url: 'https://publisher.example/substitute' } }]) {
    const f = fixture(async () => Response.json({ ...payload, event: forged }));
    assert.equal(await f.controller.open(report), false); assert.equal(f.opened.length, 0); assert.match(f.errors[0], /revised/); f.controller.destroy();
  }
});

test('unchanged revision strings cannot hide substituted review, title or source correction facts', async () => {
  for (const forged of [{ ...event, title: 'Substituted headline' },
    { ...event, reportedFacts: { ...event.reportedFacts, reviewStatus: 'automatic' } },
    { ...event, sourceTimes: { ...event.sourceTimes, updatedAt: '2026-10-12T00:01:00.000Z' } }]) {
    const f = fixture(async () => Response.json({ ...payload, event: forged }));
    assert.equal(await f.controller.open(report), false); assert.equal(f.opened.length, 0); assert.match(f.errors[0], /displayed source facts/); f.controller.destroy();
  }
});

test('another selection, time seek, navigation or closed context cancels late report completion', async () => {
  for (const action of [f => f.select({}), f => f.setScene({ mode: 'history', at: at }), f => f.move(), f => f.controller.cancel()]) {
    let release, started; const begun = new Promise(resolve => { started = resolve; });
    const f = fixture(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = f.controller.open(report); await begun; action(f); release(Response.json(payload));
    assert.equal(await pending, false); assert.equal(f.opened.length, 0); assert.equal(f.errors.length, 0); f.controller.destroy();
  }
});

test('a continuous Live clock tick does not invalidate an explicit report read', async () => {
  let release, started; const begun = new Promise(resolve => { started = resolve; });
  const f = fixture(async () => { started(); return new Promise(resolve => { release = resolve; }); });
  f.setScene({ mode: 'live', at }); const pending = f.controller.open(report); await begun;
  f.setScene({ mode: 'live', at: '2026-10-12T00:00:01.000Z' }); release(Response.json(payload));
  assert.equal(await pending, true); assert.equal(f.opened.length, 1); f.controller.destroy();
});

test('unsupported reports, missing retained membership and oversized bodies do not acquire providers or fabricate dossiers', async () => {
  for (const value of [{ ...report, sourceId: 'gdacs' }, { ...report, id: 'usgs:bad/slash' }, { ...report, eventType: 'FL' }])
    assert.equal(await retainedReportReference(value), null);
  const invalid = fixture(); assert.equal(await invalid.controller.open({ ...report, id: 'usgs:bad/slash' }), false);
  assert.equal(invalid.calls.length, 0); invalid.controller.destroy();
  const missing = fixture(async () => Response.json({}, { status: 404 }));
  assert.equal(await missing.controller.open(report), false); assert.match(missing.errors[0], /outside the current retained/); missing.controller.destroy();
  const large = fixture(async () => new Response('x'.repeat(256 * 1024 + 1)));
  assert.equal(await large.controller.open(report), false); assert.match(large.errors[0], /reading budget/); large.controller.destroy();
});

test('early status and declared-size rejection cancel transport bodies', async () => {
  for (const status of [200, 404]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const f = fixture(async () => new Response(body, { status, headers: { 'content-length': String(256 * 1024 + 1) } }));
    assert.equal(await f.controller.open(report), false); assert.equal(cancelled, true); assert.equal(f.opened.length, 0); f.controller.destroy();
  }
});
