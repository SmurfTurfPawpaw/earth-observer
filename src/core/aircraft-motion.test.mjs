import test from 'node:test';
import assert from 'node:assert/strict';
import { createAircraftMotion, projectAircraftObservation, interpolateAircraftObservations, aircraftObservationError, aircraftGeodesic,
  AIRCRAFT_HORIZON_MS, AIRCRAFT_PRESENTATION_DELAY_MS } from './aircraft-motion.js';

const at = Date.parse('2026-10-11T09:00:00Z');
const fix = (changes = {}) => ({ id: 'abc123', latitude: 50, longitude: 4, positionTimeMs: at, positionTimeQuality: 'reported',
  speedMps: 220, courseDeg: 90, ellipsoidAltitudeM: 1200, onGround: false, ...changes });
const close = (actual, expected, tolerance = .01) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' differs from ' + expected);

test('the production edge model starts at the true observation and stops after five seconds; unqualified fixes stay observed', () => {
  const motion = createAircraftMotion({ predictionEnabled: true }); motion.admit(fix(), at + 2000);
  const current = motion.sample(at + 2000), error = aircraftObservationError(current.position, fix());
  close(error.residualHorizontalM, 440); assert.equal(current.active, true); assert.equal(current.observedAtMs, at);
  assert.equal(current.validUntilMs, at + AIRCRAFT_HORIZON_MS); assert.equal(current.mode, 'estimated');
  const disabled = createAircraftMotion(); disabled.admit(fix(), at + 15000);
  assert.equal(disabled.sample(at + 30000).position.longitude, 4); assert.equal(disabled.sample(at + 30000).active, false);
  for (const changes of [{ positionTimeQuality: 'unknown' }, { positionTimeMs: null }, { speedMps: -1 }, { speedMps: 451 }, { courseDeg: 360 }, { courseDeg: null }, { ellipsoidAltitudeM: 50000 }, { onGround: true }]) {
    assert.equal(projectAircraftObservation(fix(changes), at + 1000), null);
    const invalid = createAircraftMotion({ predictionEnabled: true }); invalid.admit(fix(changes), at + 1000);
    assert.equal(invalid.sample(at + 1000).mode, 'observed'); assert.equal(invalid.sample(at + 1000).active, false);
  }
});

test('WGS84 paths take the short dateline crossing and continue through the pole', () => {
  const east = aircraftGeodesic({ latitude: 0, longitude: 179.99 }, 90, 10000);
  close(east.longitude, -179.9201684716, 1e-9); close(east.latitude, 0, 1e-9);
  close(aircraftObservationError({ ...east, altitudeType: 'geometric', altitudeM: 1200 }, fix({ latitude: 0, longitude: 179.99 })).residualHorizontalM, 10000);
  const north = aircraftGeodesic({ latitude: 89.99, longitude: 0 }, 0, 10000);
  assert.ok(north.latitude < 89.99 && north.latitude > 89.8); close(Math.abs(north.longitude), 180, 1e-8);
  const same = aircraftObservationError({ latitude: 0, longitude: 0, altitudeType: 'geometric', altitudeM: 1200 }, fix({ latitude: 0, longitude: 180 }));
  assert.ok(same.residualHorizontalM > 20000000, 'An antipodal jump cannot masquerade as a coincident point');
});

test('vertical rates require the same altitude datum and expiry is shortened before leaving the bounded altitude model', () => {
  const mismatched = projectAircraftObservation(fix({ verticalRateMps: 20, verticalRateAltitudeType: 'barometric' }), at + 2000);
  assert.equal(mismatched.altitudeM, 1200);
  const barometric = fix({ ellipsoidAltitudeM: null, baroAltitudeM: 1000, verticalRateMps: 10, verticalRateAltitudeType: 'barometric' });
  assert.equal(projectAircraftObservation(barometric, at + 2000).altitudeM, 1020);
  assert.equal(projectAircraftObservation({ ...barometric, verticalRateMps: 100 }, at + 2000).altitudeM, 1000);
  const high = createAircraftMotion({ predictionEnabled: true }); high.admit(fix({ ellipsoidAltitudeM: 19990, verticalRateMps: 10, verticalRateAltitudeType: 'geometric' }), at);
  assert.equal(high.sample(at + 500).active, true); assert.equal(high.sample(at + 1000).validUntilMs, at + 1000);
  assert.equal(high.sample(at + 1000).mode, 'expired'); close(high.sample(at + 5000).position.altitudeM, 20000);
});

test('normal 30-second delivery corrects the expired edge toward the moving buffered cursor and keeps original facts exact', () => {
  const motion = createAircraftMotion({ predictionEnabled: true, correctionMs: 1200 });
  motion.admit(fix(), at, { displayAtMs: at - AIRCRAFT_PRESENTATION_DELAY_MS });
  const rawAtFix = projectAircraftObservation(fix(), at + 30000, { horizonMs: 45000 }), shifted = aircraftGeodesic(rawAtFix, 0, 100);
  const next = fix({ ...shifted, positionTimeMs: at + 30000, speedMps: 230, courseDeg: 95 });
  const before = motion.sample(at + 6000, { wallTimeMs: at + 31000 }); assert.equal(before.mode, 'expired'); assert.equal(before.active, false);
  const accepted = motion.admit(next, at + 31000, { displayAtMs: at + 6000 });
  assert.equal(accepted.accepted, true); assert.equal(accepted.reset, false); assert.equal(accepted.residualM, null);
  close(accepted.diagnosticResidualM, 100);
  const started = motion.sample(at + 6000, { wallTimeMs: at + 31000 });
  close(aircraftObservationError(started.position, { ...fix(), ...before.position, ellipsoidAltitudeM: before.position.altitudeM }).residualM, 0);
  assert.equal(started.active, true); assert.equal(started.bufferState, 'interpolating'); assert.ok(started.correctionRemainingM > 0);
  assert.equal(started.lastErrorM, null); assert.equal(started.diagnosticForecastHorizonMs, 30000);
  assert.equal(motion.getState().observation.longitude, next.longitude); assert.equal(motion.getState().observation.positionTimeMs, at + 30000);
  const midway = motion.sample(at + 6600, { wallTimeMs: at + 31600 }); close(midway.correctionRemainingM, started.correctionRemainingM / 2);
  const done = motion.sample(at + 7200, { wallTimeMs: at + 32200 });
  const newTarget = interpolateAircraftObservations(fix(), next, at + 7200).position;
  close(aircraftObservationError(done.position, { ...next, ...newTarget, ellipsoidAltitudeM: newTarget.altitudeM }).residualM, 0);
  assert.equal(done.correctionRemainingM, 0); assert.equal(done.estimatedAtMs, at + 7200);
  assert.ok(aircraftObservationError(done.position, next).residualHorizontalM > 4000, 'Display correction ends at the buffered trajectory instead of jumping to the received point');
  assert.deepEqual(motion.getState().fixes.map((record) => record.positionTimeMs), [at, at + 30000]);
  assert.deepEqual(done.basisObservedAtMs, [at, at + 30000]);
});

test('duplicate and out-of-order delivery cannot reset the anchor or extend its expiry; expiry freezes a dated estimate', () => {
  const motion = createAircraftMotion({ predictionEnabled: true }); motion.admit(fix(), at + 10000);
  assert.equal(motion.admit(fix({ longitude: 5 }), at + 20000).reason, 'duplicate-observation');
  assert.equal(motion.admit(fix({ positionTimeMs: at - 1000 }), at + 30000).reason, 'out-of-order');
  assert.equal(motion.getState().observation.longitude, 4);
  const expired = motion.sample(at + AIRCRAFT_HORIZON_MS), later = motion.sample(at + 600000);
  assert.equal(expired.mode, 'expired'); assert.equal(expired.active, false); assert.deepEqual(later.position, expired.position);
  assert.equal(later.estimatedAtMs, at + AIRCRAFT_HORIZON_MS); assert.equal(later.observedAtMs, at);
  motion.admit(fix(), at + 650000); assert.equal(motion.sample(at + 650000).validUntilMs, at + AIRCRAFT_HORIZON_MS);
});

test('future observation admission stays ineligible after clock catch-up and needs a genuinely new qualified fix', () => {
  const motion = createAircraftMotion({ predictionEnabled: true });
  const future = fix({ positionTimeMs: at + 10000, accuracy: { rcM: 100 } });
  assert.equal(motion.admit(future, at).reason, 'future-observation');
  assert.equal(motion.sample(at + 20000).active, false); assert.equal(motion.sample(at + 20000).position.longitude, 4);
  assert.equal(motion.getState().timeEligible, false); assert.equal(motion.getState().fixes.length, 0);
  assert.equal(motion.admit(future, at + 20000).reason, 'duplicate-observation'); assert.equal(motion.sample(at + 21000).active, false);
  motion.getState().observation.accuracy.rcM = 999; assert.equal(motion.getState().observation.accuracy.rcM, 100);
  const fresh = fix({ positionTimeMs: at + 19000 }); assert.equal(motion.admit(fresh, at + 20000).accepted, true);
  assert.equal(motion.getState().timeEligible, true); assert.equal(motion.sample(at + 21000).active, true);
});

test('implausible jumps, ground and altitude transitions, and identity changes reset connecting motion', () => {
  for (const [changes, reason] of [[{ longitude: 20 }, 'implausible-jump'], [{ onGround: true }, 'ground-transition'],
    [{ ellipsoidAltitudeM: null, baroAltitudeM: 1200 }, 'altitude-transition'], [{ id: 'other' }, 'identity-change']]) {
    const motion = createAircraftMotion({ predictionEnabled: true }); motion.admit(fix(), at);
    const admission = motion.admit(fix({ positionTimeMs: at + 1000, ...changes }), at + 1000);
    assert.equal(admission.reason, reason); assert.equal(admission.reset, true); assert.equal(motion.getState().fixes.length, 1);
    assert.equal(motion.sample(at + 1000).correctionRemainingM, 0);
  }
});

test('bounded interpolation retains only two true fixes and preserves exact endpoints across the dateline', () => {
  const motion = createAircraftMotion({ predictionEnabled: true, correctionMs: 0, interpolationMethod: 'geodesic' }); motion.admit(fix(), at);
  const end = projectAircraftObservation(fix(), at + 30000, { horizonMs: 45000 }); motion.admit(fix({ ...end, positionTimeMs: at + 30000 }), at + 30000);
  const middle = motion.sample(at + 15000); close(aircraftObservationError(middle.position, fix()).residualHorizontalM, 3300);
  assert.equal(middle.model, 'wgs84-two-observation-interpolation-v1'); assert.equal(middle.active, true);
  const third = projectAircraftObservation(fix(), at + 45000, { horizonMs: 45000 }); motion.admit(fix({ ...third, positionTimeMs: at + 45000 }), at + 45000);
  assert.deepEqual(motion.getState().fixes.map((record) => record.positionTimeMs), [at + 30000, at + 45000]);
  const start = fix({ latitude: 0, longitude: 179.99, speedMps: 300 });
  const finish = fix({ ...start, ...aircraftGeodesic(start, 90, 9000), positionTimeMs: at + 30000 });
  const crossing = interpolateAircraftObservations(start, finish, at + 15000);
  assert.equal(crossing.model, 'wgs84-bounded-endpoint-motion-interpolation-v1');
  close(aircraftObservationError(crossing.position, start).residualHorizontalM, 4500);
  assert.equal(interpolateAircraftObservations(start, finish, at - 1), null);
  assert.equal(interpolateAircraftObservations(start, finish, at + 30001), null);
  assert.equal(interpolateAircraftObservations(start, finish, at).position.longitude, start.longitude);
  assert.equal(interpolateAircraftObservations(start, finish, at + 30000).position.longitude, finish.longitude);
  assert.throws(() => createAircraftMotion({ horizonMs: Infinity }), /finite and bounded/);
});

test('endpoint tangents give a bounded accelerating trajectory and unsupported or implausible tangents use geodesic interpolation', () => {
  const start = fix({ latitude: 0, longitude: 0, speedMps: 100 });
  const finish = fix({ ...start, ...aircraftGeodesic(start, 90, 6000), positionTimeMs: at + 30000, speedMps: 300 });
  const supported = interpolateAircraftObservations(start, finish, at + 15000);
  assert.equal(supported.model, 'wgs84-bounded-endpoint-motion-interpolation-v1'); assert.equal(supported.fallbackReason, null);
  close(aircraftObservationError(supported.position, start).residualHorizontalM, 2250);
  for (const changes of [{ courseDeg: null }, { speedMps: 450, courseDeg: 0 }, { courseDeg: 270 }]) {
    const fallback = interpolateAircraftObservations({ ...start, ...changes }, finish, at + 15000);
    assert.equal(fallback.model, 'wgs84-two-observation-interpolation-v1'); assert.ok(fallback.fallbackReason);
    close(aircraftObservationError(fallback.position, start).residualHorizontalM, 3000);
  }
});

test('a first fix remains observed before its buffer cursor and unsupported gaps cannot fabricate a connecting path', () => {
  const motion = createAircraftMotion({ predictionEnabled: true, correctionMs: 0 });
  motion.admit(fix(), at, { displayAtMs: at - 25000 });
  const startup = motion.sample(at - 1000); assert.equal(startup.mode, 'observed'); assert.equal(startup.active, false);
  assert.equal(startup.bufferState, 'awaiting-buffer'); assert.equal(startup.nextActivationMs, at);
  assert.equal(motion.sample(at).active, true); assert.equal(motion.sample(at + 5000).active, false);
  const delayed = fix({ ...aircraftGeodesic(fix(), 90, 220 * 36), positionTimeMs: at + 36000 });
  assert.equal(motion.admit(delayed, at + 36000, { displayAtMs: at + 11000 }).reset, false);
  const unsupported = motion.sample(at + 11000);
  assert.equal(unsupported.bufferState, 'observation-gap'); assert.equal(unsupported.active, false); assert.equal(unsupported.model, null);
  assert.equal(unsupported.position.longitude, delayed.longitude); assert.equal(interpolateAircraftObservations(fix(), delayed, at + 11000), null);
  const outage = fix({ positionTimeMs: at + 200000 });
  assert.equal(motion.admit(outage, at + 200000, { displayAtMs: at + 175000 }).reason, 'observation-gap');
  assert.equal(motion.getState().fixes.length, 1); assert.equal(motion.sample(at + 175000).correctionRemainingM, 0);
  const noisyShortFix = fix({ ...aircraftGeodesic(fix(), 90, 1000), positionTimeMs: at + 1000 });
  assert.equal(interpolateAircraftObservations(fix(), noisyShortFix, at + 500), null, 'A jump-admission noise allowance cannot become an implausible interpolation speed');
  assert.equal(interpolateAircraftObservations(fix(), fix({ ellipsoidAltitudeM: 1300, positionTimeMs: at + 1000 }), at + 500), null);
});

test('an early second fix retains the first buffered fact until activation without a backward jump', () => {
  const motion = createAircraftMotion({ predictionEnabled: true });
  motion.admit(fix(), at, { displayAtMs: at - 25000 });
  const early = fix({ ...aircraftGeodesic(fix(), 90, 2200), positionTimeMs: at + 10000 });
  const admission = motion.admit(early, at + 10000, { displayAtMs: at - 15000 });
  assert.equal(admission.reset, false);
  const waiting = motion.sample(at - 1, { wallTimeMs: at + 24999 });
  assert.equal(waiting.bufferState, 'awaiting-buffer'); assert.equal(waiting.active, false);
  assert.equal(waiting.position.longitude, fix().longitude); assert.equal(waiting.displayObservedAtMs, at);
  assert.equal(waiting.observedAtMs, at + 10000); assert.equal(waiting.nextActivationMs, at);
  assert.deepEqual(waiting.basisObservedAtMs, [at, at + 10000]);
  assert.equal(motion.getState().observation.longitude, early.longitude); assert.equal(motion.getState().observation.positionTimeMs, at + 10000);
  const activated = motion.sample(at, { wallTimeMs: at + 25000 });
  assert.equal(activated.bufferState, 'interpolating'); assert.equal(activated.active, true);
  assert.deepEqual(activated.position, waiting.position);
  const advanced = motion.sample(at + 1000, { wallTimeMs: at + 26000 });
  close(aircraftObservationError(advanced.position, fix()).residualHorizontalM, 220, .1);
});

test('an explicit diagnostic horizon preserves raw 45-second replay without extending the production model', () => {
  const expected = projectAircraftObservation(fix(), at + 45000, { horizonMs: 45000 });
  close(aircraftObservationError(expected, fix()).residualHorizontalM, 9900);
  assert.equal(projectAircraftObservation(fix(), at + 6000), null);
  const production = createAircraftMotion({ predictionEnabled: true }); production.admit(fix(), at);
  assert.equal(production.sample(at + 6000).mode, 'expired'); assert.equal(production.getState().horizonMs, 5000);
});
