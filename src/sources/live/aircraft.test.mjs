import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenSkyAircraft, normalizeReadsbAircraft, openSkySnapshot, readsbSnapshot, preparedAircraftSnapshot } from './aircraft.js';

const NOW = 1791676800000;
const receiver = (fields = {}) => ({ hex: 'ABC123', lat: 50.85, lon: 4.35, gs: 200, track: 90, ...fields });
const reported = { observedAtSource: 'source' };

test('readsb fix eligibility requires source time and an explicit valid position age, without losing coordinates', () => {
  const fresh = normalizeReadsbAircraft(receiver({ seen_pos: 0, seen: 1 }), NOW, reported);
  assert.equal(fresh.positionTimeMs, NOW);
  assert.equal(fresh.positionTimeQuality, 'reported');
  assert.equal(fresh.contactTimeMs, NOW - 1000);
  assert.equal(normalizeReadsbAircraft(receiver({ seen_pos: 2.5 }), NOW, reported).positionTimeMs, NOW - 2500);

  for (const seen_pos of [undefined, null, '', '0', false, -1, NaN, Infinity, Number.MAX_VALUE]) {
    const record = normalizeReadsbAircraft(receiver({ seen_pos }), NOW, reported);
    assert.equal(record.positionTimeMs, null, `Invalid position age ${String(seen_pos)} must not create a fix time`);
    assert.equal(record.positionTimeQuality, 'unknown');
    assert.equal(record.latitude, 50.85);
    assert.equal(record.longitude, 4.35);
    assert.ok(record.speedMps > 0, 'Reported motion facts remain available even when prediction is ineligible');
  }
  for (const observedAtSource of ['receipt', 'unknown', undefined]) {
    const record = normalizeReadsbAircraft(receiver({ seen_pos: 0, seen: 0 }), NOW, { observedAtSource });
    assert.equal(record.positionTimeQuality, 'unknown');
    assert.equal(record.positionTimeMs, null);
    assert.equal(record.contactTimeMs, null);
  }
  for (const sourceTime of [undefined, null, -1, Infinity, 8640000000000001]) {
    assert.equal(normalizeReadsbAircraft(receiver({ seen_pos: 0 }), sourceTime, reported).positionTimeQuality, 'unknown');
  }
});

test('snapshot provenance is explicit, and receipt freshness cannot silently qualify aircraft positions', () => {
  const payload = { ac: [receiver({ seen_pos: 3 })] };
  const source = readsbSnapshot(payload, { observedAtMs: NOW, observedAtSource: 'source', now: NOW + 5000 });
  assert.equal(source.observedAtSource, 'source');
  assert.equal(source.records[0].positionTimeMs, NOW - 3000);
  assert.equal(source.records[0].positionTimeQuality, 'reported');
  assert.equal(source.ageMs, 5000);

  const receipt = readsbSnapshot(payload, { observedAtMs: NOW, observedAtSource: 'receipt', now: NOW });
  assert.equal(receipt.observedAtSource, 'receipt');
  assert.equal(receipt.freshness, 'unknown');
  assert.equal(receipt.records[0].positionTimeQuality, 'unknown');
  assert.equal(receipt.records.length, 1);
  const unspecified = readsbSnapshot(payload, { observedAtMs: NOW, now: NOW });
  assert.equal(unspecified.observedAtSource, 'unknown');
  assert.equal(unspecified.records[0].positionTimeQuality, 'unknown');
  assert.equal(readsbSnapshot(payload, { observedAtMs: NaN, observedAtSource: 'source', now: NOW }).observedAtSource, 'unknown');
});

test('OpenSky uses its true per-position epoch, independently of a missing source snapshot time', () => {
  const row = ['abc123', 'EX123', 'Belgium', NOW / 1000 - 5, NOW / 1000, 4.35, 50.85, 1100, false, 100, 90, 3, null, 1200];
  const snapshot = openSkySnapshot({ states: [row] }, { now: NOW });
  assert.equal(snapshot.observedAtSource, 'unknown');
  assert.equal(snapshot.records[0].positionTimeQuality, 'reported');
  assert.equal(snapshot.records[0].positionTimeMs, NOW - 5000);
  assert.equal(snapshot.records[0].verticalRateAltitudeType, null);
  assert.equal(openSkySnapshot({ time: NOW / 1000, states: [row] }, { now: NOW }).observedAtSource, 'source');
  for (const positionTime of [undefined, null, -1, NaN, Infinity]) {
    const record = normalizeOpenSkyAircraft(row.map((value, index) => index === 3 ? positionTime : value));
    assert.equal(record.positionTimeMs, null);
    assert.equal(record.positionTimeQuality, 'unknown');
    assert.equal(record.latitude, 50.85);
  }
});

test('receiver accuracy stays bounded reported metadata, and vertical-rate altitude type is explicit', () => {
  const record = normalizeReadsbAircraft(receiver({ seen_pos: 0, nic: 8, rc: 185.2, nac_p: 9, nac_v: 2, sil: 3, sil_type: 'perhour', baro_rate: 600, alt_geom: 4000, alt_baro: 3800 }), NOW, reported);
  assert.deepEqual(record.accuracy, { nic: 8, rcM: 185.2, nacP: 9, nacV: 2, sil: 3, silType: 'perhour' });
  assert.equal(record.verticalRateAltitudeType, 'barometric');
  assert.equal(record.verticalRateMps, 600 * 0.00508);
  assert.equal(record.ellipsoidAltitudeM, 4000 * 0.3048);
  assert.equal(record.baroAltitudeM, 3800 * 0.3048);
  const invalid = normalizeReadsbAircraft(receiver({ seen_pos: 0, nic: 12, rc: Infinity, nac_p: '9', nac_v: -1, sil: 3.5, sil_type: 'certain' }), NOW, reported);
  assert.deepEqual(invalid.accuracy, { nic: null, rcM: null, nacP: null, nacV: null, sil: null, silType: null });
  assert.equal(invalid.verticalRateAltitudeType, null);
  assert.equal('confidence' in record, false);
  assert.equal(record.positionTimeQuality, 'reported');
});

test('readsb geometric altitude uses a provided geometric rate without mixing barometric climb', () => {
  const row = receiver({ seen_pos: 0, alt_geom: 4000, alt_baro: 3800, geom_rate: 640, baro_rate: 600 });
  const geometric = normalizeReadsbAircraft(row, NOW, reported);
  assert.equal(geometric.verticalRateAltitudeType, 'geometric');
  assert.equal(geometric.verticalRateMps, 640 * 0.00508);
  const onlyBaro = normalizeReadsbAircraft({ ...row, geom_rate: undefined }, NOW, reported);
  assert.equal(onlyBaro.verticalRateAltitudeType, 'barometric');
  assert.equal(onlyBaro.verticalRateMps, 600 * 0.00508);
  const onlyBaroAltitude = normalizeReadsbAircraft({ ...row, alt_geom: undefined }, NOW, reported);
  assert.equal(onlyBaroAltitude.verticalRateAltitudeType, 'barometric');
  const invalidGeometricRate = normalizeReadsbAircraft({ ...row, geom_rate: Infinity }, NOW, reported);
  assert.equal(invalidGeometricRate.verticalRateAltitudeType, 'barometric');
});

test('prepared records retain exact SI fixes and only qualified earlier matching history is admitted', () => {
  const latest = { id: 'abc123', latitude: 50.85, longitude: 4.35, positionTimeMs: NOW, positionTimeQuality: 'reported',
    ellipsoidAltitudeM: 1200, baroAltitudeM: 1100, speedMps: 100, courseDeg: 90, verticalRateMps: 2, verticalRateAltitudeType: 'geometric' };
  const previous = { ...latest, longitude: 4.34, positionTimeMs: NOW - 30000 };
  const payload = { schemaVersion: 1, source: 'adsb.lol', prepared: true, delivery: 'prepared-aircraft-observations', observedAtMs: NOW,
    observedAtSource: 'source', stale: false, records: [latest], history: [previous, { ...previous, id: 'other' },
      { ...previous, positionTimeQuality: 'unknown' }, { ...previous, positionTimeMs: null }, { ...previous, positionTimeMs: NOW + 1 }] };
  const snapshot = preparedAircraftSnapshot(payload, { now: NOW + 1000 });
  assert.equal(snapshot.records[0].positionTimeMs, NOW); assert.equal(snapshot.records[0].ellipsoidAltitudeM, 1200);
  assert.equal(snapshot.records[0].verticalRateAltitudeType, 'geometric'); assert.equal(snapshot.records[0].baroAltitudeM, 1100);
  assert.equal(snapshot.history.length, 1); assert.equal(snapshot.history[0].positionTimeMs, NOW - 30000);
  assert.equal(snapshot.ageMs, 1000); assert.equal(snapshot.complete, false);
  const old = preparedAircraftSnapshot(payload, { now: NOW + 300000 });
  assert.equal(old.stale, true); assert.equal(old.records[0].positionTimeMs, NOW); assert.equal(old.history[0].positionTimeMs, NOW - 30000);
  assert.throws(() => preparedAircraftSnapshot({ ...payload, records: Array(2001).fill(latest) }), /Malformed/);
  assert.throws(() => preparedAircraftSnapshot({ ...payload, history: Array(4001).fill(previous) }), /Malformed/);
  assert.throws(() => preparedAircraftSnapshot({ ...payload, observedAtSource: 'receipt' }), /Malformed/);
});

test('prepared unknown source epochs retain static coordinates without qualifying motion or inventing source age', () => {
  const record = { id: 'abc123', latitude: 50.85, longitude: 4.35, positionTimeQuality: 'unknown', positionTimeMs: null, contactTimeMs: null,
    speedMps: 100, courseDeg: 90, ellipsoidAltitudeM: 1200 };
  const payload = { schemaVersion: 1, source: 'adsb.lol', prepared: true, delivery: 'prepared-aircraft-observations',
    observedAtSource: 'unknown', observedAtMs: null, records: [record], history: [], freshness: 'unknown',
    collectedAt: new Date(NOW - 1000).toISOString(), captureAgeMs: 1000, sourceAgeMs: null };
  const snapshot = preparedAircraftSnapshot(payload, { now: NOW });
  assert.equal(snapshot.observedAtSource, 'unknown'); assert.equal(snapshot.observedAtMs, null); assert.equal(snapshot.ageMs, null);
  assert.equal(snapshot.records[0].latitude, 50.85); assert.equal(snapshot.records[0].positionTimeMs, null);
  assert.equal(snapshot.records[0].positionTimeQuality, 'unknown'); assert.equal(snapshot.freshness, 'unknown'); assert.equal(snapshot.stale, false);
  const unqualified = preparedAircraftSnapshot({ ...payload, records: [{ ...record, positionTimeQuality: 'reported', positionTimeMs: NOW, contactTimeMs: NOW }] }, { now: NOW });
  assert.equal(unqualified.records[0].positionTimeQuality, 'unknown'); assert.equal(unqualified.records[0].positionTimeMs, null);
  assert.equal(unqualified.records[0].contactTimeMs, null);
  assert.throws(() => preparedAircraftSnapshot({ ...payload, observedAtMs: NOW }), /Malformed/);
});

test('prepared cached delivery recomputes source and capture ages while leaving original fix dates unchanged', () => {
  const record = { id: 'abc123', latitude: 50.85, longitude: 4.35, positionTimeQuality: 'reported', positionTimeMs: NOW - 1000 };
  const payload = { schemaVersion: 1, source: 'adsb.lol', prepared: true, delivery: 'prepared-aircraft-observations',
    observedAtSource: 'source', observedAtMs: NOW, records: [record], history: [], freshness: 'current',
    collectedAt: new Date(NOW).toISOString(), sourceAgeMs: 0, captureAgeMs: 0, lastCheckedAt: new Date(NOW).toISOString() };
  const cached = preparedAircraftSnapshot(payload, { now: NOW + 121000 });
  assert.equal(cached.sourceAgeMs, 121000); assert.equal(cached.captureAgeMs, 121000); assert.equal(cached.stale, true);
  assert.equal(cached.lastCheckedAt, payload.lastCheckedAt); assert.equal(cached.records[0].positionTimeMs, NOW - 1000);
  const header = preparedAircraftSnapshot(payload, { now: NOW, cacheAgeMs: 125000 });
  assert.equal(header.sourceAgeMs, 125000); assert.equal(header.stale, true);
  assert.equal(preparedAircraftSnapshot({ ...payload, sourceState: { cache: 'STALE' } }, { now: NOW }).stale, true);
});
