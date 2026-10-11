import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAircraftCollector, AIRCRAFT_SOURCE_URL, AIRCRAFT_PUBLISH_URL, AIRCRAFT_SCOPE, AIRCRAFT_COLLECTOR_LIMITS } from './aircraft-collector.mjs';
import { readsbSnapshot } from '../src/sources/live/aircraft.js';

const START = Date.parse('2026-10-11T15:00:00.000Z'), CREDENTIAL = 'a'.repeat(64);
const iso = at => new Date(at).toISOString();
async function directory(t) {
  const parent = path.resolve(tmpdir()), target = await mkdtemp(path.join(parent, 'earth-aircraft-collector-'));
  assert.equal(path.dirname(path.resolve(target)), parent); assert.ok(path.basename(target).startsWith('earth-aircraft-collector-'));
  t.after(() => rm(target, { recursive: true, force: true })); return target;
}
function payload() {
  return { now: START / 1000, ac: [{ hex: 'abc123', flight: ' BEL123 ', lat: 50.9, lon: 4.4, seen_pos: 7.5, seen: 2,
    alt_baro: 29500, alt_geom: 30000, gs: 420, track: 96, baro_rate: 300, geom_rate: 600,
    category: 'A1', r: 'OO-TEST', t: 'A320', ownOp: 'Example', nic: 9, rc: 75, nac_p: 10, nac_v: 2, sil: 3, sil_type: 'persample' }] };
}
function transport() {
  let at = START, body = payload(), sourceStatus = 200, publishStatus = 200, retry = null, headers = { 'x-feed-cache': 'MISS', 'x-feed-age-ms': '0' };
  const calls = [], packets = [];
  const fetchImpl = async (url, options) => {
    assert.ok([AIRCRAFT_SOURCE_URL, AIRCRAFT_PUBLISH_URL].includes(url)); assert.equal(options.redirect, 'error'); options.signal.throwIfAborted();
    calls.push({ url, method: options.method });
    if (url === AIRCRAFT_SOURCE_URL) {
      assert.equal(options.headers.authorization, undefined, 'public source GET never carries the private writer credential');
      return sourceStatus === 200 ? Response.json(body, { headers }) : new Response('Source unavailable', { status: sourceStatus, headers: retry ? { 'retry-after': retry } : {} });
    }
    assert.equal(options.headers.authorization, `Bearer ${CREDENTIAL}`);
    assert.ok(Buffer.byteLength(options.body) <= AIRCRAFT_COLLECTOR_LIMITS.publishBytes);
    const packet = JSON.parse(options.body); assert.deepEqual(Object.keys(packet), ['action', 'packet']); assert.equal(packet.action, 'aircraft'); packets.push(packet);
    return publishStatus === 200 ? Response.json({ stored: true }) : new Response(`Reflected ${CREDENTIAL}`, { status: publishStatus, headers: retry ? { 'retry-after': retry } : {} });
  };
  return { fetchImpl, calls, packets, now: () => at, advance(ms = 30000) { at += ms; }, payload(value) { body = value; },
    source(status, retryAfter = null) { sourceStatus = status; retry = retryAfter; }, publish(status, retryAfter = null) { publishStatus = status; retry = retryAfter; },
    headers(value) { headers = value; } };
}

test('fixed local acquisition serializes cycles and preserves exact source observations, geometric rate and limited scope', async t => {
  const stateDirectory = await directory(t), source = transport();
  const collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
  const [first, concurrent] = await Promise.all([collector.cycle(), collector.cycle()]);
  assert.equal(first.published, true); assert.equal(concurrent.outcome, 'waiting'); assert.equal(source.calls.length, 2);
  const packet = source.packets[0].packet;
  assert.deepEqual(packet.scope, AIRCRAFT_SCOPE); assert.equal(packet.collectedAt, iso(START)); assert.equal(packet.observedAtMs, START); assert.equal(packet.observedAtSource, 'source');
  assert.deepEqual(packet.records, readsbSnapshot(payload(), { observedAtMs: START, observedAtSource: 'source', now: START }).records);
  assert.equal(packet.records[0].positionTimeMs, START - 7500); assert.equal(packet.records[0].verticalRateAltitudeType, 'geometric');
  assert.equal(packet.records[0].verticalRateMps, 600 * .00508);
  source.advance(); await collector.cycle();
  assert.equal(source.packets[1].packet.collectedAt, iso(START + 30000)); assert.deepEqual(source.packets[1].packet.records, packet.records);
  assert.equal(source.packets[1].packet.sourceState.ageMs, 30000, 'rereading the same snapshot ages it, rather than retiming fixes');
  assert.equal((await collector.status()).lastPublishedAt, iso(START + 30000));
  for (const category of ['A', 'AB', 'Z1234567']) {
    source.advance(); const data = payload(); data.ac[0].category = category; source.payload(data);
    assert.equal((await collector.cycle()).published, true, 'all source codes permitted by the writer remain publishable');
    assert.equal(source.packets.at(-1).packet.records[0].category, category);
  }
});

test('503 outbox retries survive restart, honor Retry-After and publish original capture before acquiring again', async t => {
  const stateDirectory = await directory(t), source = transport(); source.publish(503, '120');
  let collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
  const first = await collector.cycle(); assert.equal(first.published, false); assert.equal(first.queued, true); assert.equal(first.retryAt, iso(START + 120000));
  const queued = source.packets[0], saved = await readFile(path.join(stateDirectory, 'state.json'), 'utf8');
  assert.equal(saved.includes(CREDENTIAL), false); assert.deepEqual(JSON.parse(saved).outbox.body, queued);
  source.advance(60000); collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
  assert.equal((await collector.cycle()).outcome, 'backoff'); assert.equal(source.calls.length, 2);
  source.advance(60000); source.publish(200); const retried = await collector.cycle();
  assert.equal(retried.published, true); assert.equal(source.calls.length, 3); assert.deepEqual(source.packets[1], queued);
  assert.equal((await collector.status()).lastAcquiredAt, iso(START)); assert.equal((await collector.status()).lastPublishedAt, iso(START));
  assert.equal(JSON.parse(await readFile(path.join(stateDirectory, 'state.json'), 'utf8')).outbox, null);
  await collector.cycle(); assert.equal(source.calls.length, 5); assert.equal(source.packets[2].packet.collectedAt, iso(START + 120000));
});

test('denied source requests retain persisted backoff without endpoint substitution, empty publication or invented freshness', async t => {
  const stateDirectory = await directory(t), source = transport(); source.source(403, new Date(START + 600000).toUTCString());
  let collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
  assert.equal((await collector.cycle()).outcome, 'source-unavailable'); assert.equal(source.packets.length, 0);
  const before = await collector.status(); assert.equal(before.lastAcquiredAt, null); assert.equal(before.sourceFreshness, 'unknown'); assert.equal(before.retryAt, iso(START + 600000));
  source.advance(300000); collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
  assert.equal((await collector.cycle()).outcome, 'backoff'); assert.equal(source.calls.length, 1); assert.equal((await collector.status()).lastAcquiredAt, null);
  source.advance(300000); source.source(200); assert.equal((await collector.cycle()).published, true);
  assert.ok(source.calls.every(call => [AIRCRAFT_SOURCE_URL, AIRCRAFT_PUBLISH_URL].includes(call.url)));
});

test('missing or future source time stays unknown, missing position age stays fixed, and stale cache age is retained', async t => {
  const cases = [
    { name: 'missing-time', change: value => { delete value.now; }, observed: 'unknown', position: 'unknown', freshness: 'unknown' },
    { name: 'string-time', change: value => { value.now = String(value.now); }, observed: 'unknown', position: 'unknown', freshness: 'unknown' },
    { name: 'future-time', change: value => { value.now += 6; }, observed: 'unknown', position: 'unknown', freshness: 'unknown' },
    { name: 'missing-age', change: value => { delete value.ac[0].seen_pos; }, observed: 'source', position: 'unknown', freshness: 'current' },
    { name: 'stale-cache', change: () => {}, observed: 'source', position: 'reported', freshness: 'stale', headers: { 'x-feed-cache': 'STALE', 'x-feed-age-ms': '180000' } },
  ];
  for (const scenario of cases) {
    const stateDirectory = await directory(t), source = transport(), data = payload(); scenario.change(data); source.payload(data);
    if (scenario.headers) source.headers(scenario.headers);
    const collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
    assert.equal((await collector.cycle()).published, true, scenario.name);
    const packet = source.packets[0].packet, record = packet.records[0];
    assert.equal(packet.observedAtSource, scenario.observed); assert.equal(record.positionTimeQuality, scenario.position); assert.equal(packet.sourceState.freshness, scenario.freshness);
    assert.equal(packet.observedAtMs, scenario.observed === 'source' ? START : null); assert.equal(record.positionTimeMs, scenario.position === 'reported' ? START - 7500 : null);
    assert.equal(record.latitude, 50.9); if (scenario.headers) assert.equal(packet.sourceState.cacheAgeMs, 180000);
  }
});

test('oversized source bodies, record counts, packet bytes and invalid canonical facts never queue partial replacements', async t => {
  const scenarios = [
    { name: 'body', response: () => new Response(new ReadableStream({ cancel() {} }), { headers: { 'content-length': String(AIRCRAFT_COLLECTOR_LIMITS.upstreamBytes + 1) } }) },
    { name: 'count', payload: () => ({ now: START / 1000, ac: Array.from({ length: 2001 }, (_, i) => ({ ...payload().ac[0], hex: i.toString(16).padStart(6, '0') })) }) },
    { name: 'invalid-fact', payload: () => ({ now: START / 1000, ac: [{ ...payload().ac[0], track: 360 }] }) },
    { name: 'invalid-category', payload: () => ({ now: START / 1000, ac: [{ ...payload().ac[0], category: 'A-1' }] }) },
    { name: 'packet', payload: () => ({ now: START / 1000, ac: Array.from({ length: 2000 }, (_, i) => ({ ...payload().ac[0], hex: i.toString(16).padStart(6, '0'),
      flight: 'X'.repeat(32), t: 'T'.repeat(24), r: 'R'.repeat(48), ownOp: 'O'.repeat(160) })) }) },
  ];
  for (const scenario of scenarios) {
    const stateDirectory = await directory(t), calls = [];
    const data = scenario.payload?.();
    if (scenario.name === 'packet') {
      const snapshot = readsbSnapshot(data, { observedAtMs: START, observedAtSource: 'source', now: START });
      const wireBytes = Buffer.byteLength(JSON.stringify({ action: 'aircraft', packet: { schemaVersion: 1, source: 'adsb.lol',
        collectedAt: iso(START), scope: AIRCRAFT_SCOPE, observedAtMs: START, observedAtSource: 'source',
        sourceState: { freshness: 'current', cache: 'MISS', cacheAgeMs: 0, ageMs: 0, complete: true, rejectedCount: 0 }, records: snapshot.records } }));
      assert.ok(wireBytes > 1500000 && wireBytes < 1.5 * 1024 * 1024, 'valid facts between decimal API limit and 1.5MiB must not enter the outbox');
    }
    const collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, now: () => START, fetchImpl: async url => {
      calls.push(url); assert.equal(url, AIRCRAFT_SOURCE_URL); return scenario.response ? scenario.response() : Response.json(data);
    } });
    const result = await collector.cycle(); assert.equal(result.outcome, 'invalid-response', scenario.name); assert.equal(result.published, false); assert.equal(result.queued, false);
    assert.equal(result.lastAcquiredAt, null); assert.deepEqual(calls, [AIRCRAFT_SOURCE_URL]);
  }
});

test('request deadline and owner cancellation cancel an actual stalled body without publishing or overlapping acquisition', { timeout: 5000 }, async t => {
  for (const ownerStop of [false, true]) {
    const stateDirectory = await directory(t), began = Promise.withResolvers(); let cancelled = 0, calls = 0;
    const collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, now: () => START,
      requestDeadlineMs: ownerStop ? 1000 : 10, fetchImpl: async url => {
        assert.equal(url, AIRCRAFT_SOURCE_URL); calls++;
        return new Response(new ReadableStream({ pull() { began.resolve(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
      } });
    const pending = collector.cycle(); await began.promise; if (ownerStop) collector.stop();
    const result = await pending; assert.equal(result.outcome, ownerStop ? 'cancelled' : 'timeout'); assert.equal(cancelled, 1); assert.equal(calls, 1);
    assert.equal(result.lastAcquiredAt, null); assert.equal(result.queued, false);
    const saved = JSON.parse(await readFile(path.join(stateDirectory, 'state.json'), 'utf8'));
    assert.equal(saved.acquisitionFailures, ownerStop ? 0 : 1); assert.equal(saved.lastAcquiredAt, null);
  }
});

test('once daemon collects without a visitor and logs only safe summaries; corrupted outboxes fail before requests', async t => {
  const stateDirectory = await directory(t), source = transport(), logs = []; source.publish(503, '60');
  const collector = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now, once: true, logger: value => logs.push(value) });
  await collector.start(); assert.equal(source.calls.length, 2);
  const logged = JSON.stringify(logs); assert.equal(logged.includes(CREDENTIAL), false); assert.equal(logged.includes('BEL123'), false); assert.equal(logged.includes('latitude'), false);
  const filename = path.join(stateDirectory, 'state.json'), state = JSON.parse(await readFile(filename, 'utf8')); state.outbox.body.packet.collectedAt = iso(START + 1);
  await writeFile(filename, JSON.stringify(state));
  const restarted = createAircraftCollector({ credential: CREDENTIAL, stateDirectory, fetchImpl: source.fetchImpl, now: source.now });
  await assert.rejects(restarted.cycle(), /local state is unavailable or invalid/); assert.equal(source.calls.length, 2);
});
