import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenSkyAircraft, normalizeReadsbAircraft, openSkySnapshot, readsbSnapshot } from './aircraft.js';

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
