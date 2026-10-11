export const AIRCRAFT_HORIZON_MS = 5000;
export const AIRCRAFT_PRESENTATION_DELAY_MS = 25000;
export const AIRCRAFT_INTERPOLATION_GAP_MS = 35000;
export const AIRCRAFT_MOTION_MODEL = 'wgs84-ground-motion-v1';
const A = 6378137, F = 1 / 298.257223563, B = A * (1 - F);
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const MAX_SPEED_MPS = 450, MAX_VERTICAL_MPS = 60, MAX_CORRECTION_M = 2000;
const longitude = (value) => ((value + 540) % 360) - 180;
const course = (value) => ((value % 360) + 360) % 360;
const coordinates = (point) => Number.isFinite(point?.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point?.longitude) && Math.abs(point.longitude) <= 180;
const time = (value) => Number.isFinite(value) && value > 0 && value <= 8640000000000000;
const altitudeValid = (value) => Number.isFinite(value) && value >= -500 && value <= 20000;

/** Vincenty's direct WGS84 geodesic; small bounded paths cross ±180° and poles. */
export function aircraftGeodesic(start, bearingDeg, distanceM) {
  if (!coordinates(start) || !Number.isFinite(bearingDeg) || !Number.isFinite(distanceM) || distanceM < 0) return null;
  if (!distanceM) return { latitude: start.latitude, longitude: start.longitude };
  const alpha = bearingDeg * RAD, sinAlpha1 = Math.sin(alpha), cosAlpha1 = Math.cos(alpha);
  const tanU = (1 - F) * Math.tan(start.latitude * RAD), cosU = 1 / Math.sqrt(1 + tanU * tanU), sinU = tanU * cosU;
  const sigma1 = Math.atan2(tanU, cosAlpha1), sinAlpha = cosU * sinAlpha1, cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = cosSqAlpha * (A * A - B * B) / (B * B);
  const aa = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bb = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = distanceM / (B * aa), cos2SigmaM, sinSigma, cosSigma;
  for (let step = 0; step < 30; step++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma); sinSigma = Math.sin(sigma); cosSigma = Math.cos(sigma);
    const delta = bb * sinSigma * (cos2SigmaM + bb / 4 * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - bb / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
    const next = distanceM / (B * aa) + delta;
    if (Math.abs(next - sigma) < 1e-12) { sigma = next; break; } sigma = next;
  }
  sinSigma = Math.sin(sigma); cosSigma = Math.cos(sigma); cos2SigmaM = Math.cos(2 * sigma1 + sigma);
  const tmp = sinU * sinSigma - cosU * cosSigma * cosAlpha1;
  const latitude = Math.atan2(sinU * cosSigma + cosU * sinSigma * cosAlpha1, (1 - F) * Math.hypot(sinAlpha, tmp)) * DEG;
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU * cosSigma - sinU * sinSigma * cosAlpha1);
  const cc = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
  const ll = lambda - (1 - cc) * F * sinAlpha * (sigma + cc * sinSigma * (cos2SigmaM + cc * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  return { latitude, longitude: longitude(start.longitude + ll * DEG) };
}

/** Short-path distance/bearing; antipodal failures are only used to reject jumps. */
function inverse(start, end) {
  const u1 = Math.atan((1 - F) * Math.tan(start.latitude * RAD)), u2 = Math.atan((1 - F) * Math.tan(end.latitude * RAD));
  const sin1 = Math.sin(u1), cos1 = Math.cos(u1), sin2 = Math.sin(u2), cos2 = Math.cos(u2);
  const ll = longitude(end.longitude - start.longitude) * RAD;
  let lambda = ll, sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cos2SigmaM, converged = false;
  for (let step = 0; step < 100; step++) {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.hypot(cos2 * sinL, cos1 * sin2 - sin1 * cos2 * cosL);
    cosSigma = sin1 * sin2 + cos1 * cos2 * cosL;
    if (sinSigma < 1e-14) return { distanceM: cosSigma > 0 ? 0 : Math.PI * A, bearingDeg: 0 };
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = cos1 * cos2 * sinL / sinSigma; cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha > 1e-15 ? cosSigma - 2 * sin1 * sin2 / cosSqAlpha : 0;
    const cc = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const next = ll + (1 - cc) * F * sinAlpha * (sigma + cc * sinSigma * (cos2SigmaM + cc * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(next - lambda) < 1e-12) { lambda = next; converged = true; break; } lambda = next;
  }
  if (!converged) {
    const dLat = (end.latitude - start.latitude) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(start.latitude * RAD) * Math.cos(end.latitude * RAD) * Math.sin(ll / 2) ** 2;
    return { distanceM: 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h))), bearingDeg: 0 };
  }
  const uSq = cosSqAlpha * (A * A - B * B) / (B * B);
  const aa = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bb = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const delta = bb * sinSigma * (cos2SigmaM + bb / 4 * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - bb / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return { distanceM: B * aa * (sigma - delta), bearingDeg: course(Math.atan2(cos2 * Math.sin(lambda), cos1 * sin2 - sin1 * cos2 * Math.cos(lambda)) * DEG) };
}

function observedPosition(record) {
  const altitudeType = record.onGround ? 'ground' : altitudeValid(record.ellipsoidAltitudeM) ? 'geometric' : altitudeValid(record.baroAltitudeM) ? 'barometric' : 'unknown';
  return { latitude: record.latitude, longitude: record.longitude,
    altitudeM: altitudeType === 'geometric' ? record.ellipsoidAltitudeM : altitudeType === 'barometric' ? record.baroAltitudeM : 0, altitudeType };
}
const copyObservation = (record) => ({ ...record, ...(record.accuracy ? { accuracy: { ...record.accuracy } } : {}) });
function eligible(record) {
  const point = observedPosition(record);
  return coordinates(record) && record.positionTimeQuality === 'reported' && time(record.positionTimeMs) && !record.onGround &&
    Number.isFinite(record.speedMps) && record.speedMps >= 0 && record.speedMps <= MAX_SPEED_MPS &&
    Number.isFinite(record.courseDeg) && record.courseDeg >= 0 && record.courseDeg < 360 && point.altitudeType !== 'unknown';
}
function rate(record) {
  return record.verticalRateAltitudeType === observedPosition(record).altitudeType && Number.isFinite(record.verticalRateMps) && Math.abs(record.verticalRateMps) <= MAX_VERTICAL_MPS ? record.verticalRateMps : 0;
}
function expiry(record, horizonMs) {
  let duration = horizonMs;
  const vertical = rate(record), altitude = observedPosition(record).altitudeM;
  if (vertical > 0) duration = Math.min(duration, (20000 - altitude) / vertical * 1000);
  if (vertical < 0) duration = Math.min(duration, (altitude + 500) / -vertical * 1000);
  return record.positionTimeMs + Math.max(0, duration);
}

/** Raw model only: no visual correction and no timestamp substitution. */
export function projectAircraftObservation(record, atMs, { horizonMs = AIRCRAFT_HORIZON_MS } = {}) {
  if (!record || !eligible(record) || !Number.isFinite(atMs) || !Number.isFinite(horizonMs) || horizonMs <= 0 || horizonMs > 120000 || atMs < record.positionTimeMs || atMs > expiry(record, horizonMs)) return null;
  const elapsed = (atMs - record.positionTimeMs) / 1000, origin = observedPosition(record);
  const point = aircraftGeodesic(origin, record.courseDeg, record.speedMps * elapsed);
  return { ...point, altitudeM: origin.altitudeM + rate(record) * elapsed, altitudeType: origin.altitudeType };
}

export function aircraftObservationError(projectedPosition, record) {
  if (!coordinates(projectedPosition) || !coordinates(record)) return null;
  const observed = observedPosition(record), horizontal = inverse(projectedPosition, observed).distanceM;
  const vertical = projectedPosition.altitudeType === observed.altitudeType ? observed.altitudeM - projectedPosition.altitudeM : null;
  return { residualM: vertical === null ? horizontal : Math.hypot(horizontal, vertical), residualHorizontalM: horizontal, residualVerticalM: vertical };
}

const poly = (a, b, c, u) => a * u * u + b * u + c;
function derivativeBounds(a, b, c) {
  const values = [c, a + b + c];
  if (a && -b / (2 * a) > 0 && -b / (2 * a) < 1) values.push(poly(a, b, c, -b / (2 * a)));
  return { min: Math.min(...values), maxAbs: Math.max(...values.map(Math.abs)) };
}
function interpolation(before, after, { method = 'endpoint-motion', maxInterpolationGapMs = AIRCRAFT_INTERPOLATION_GAP_MS } = {}) {
  const gap = after?.positionTimeMs - before?.positionTimeMs;
  if (!coordinates(before) || !coordinates(after) || before.positionTimeQuality !== 'reported' || after.positionTimeQuality !== 'reported' || !time(before.positionTimeMs) || !time(after.positionTimeMs) || gap <= 0 || gap > maxInterpolationGapMs || Boolean(before.onGround) !== Boolean(after.onGround)) return null;
  const from = observedPosition(before), to = observedPosition(after), path = inverse(from, to), seconds = gap / 1000;
  // Observation admission tolerates bounded coordinate noise; a reconstructed
  // curve itself must still obey the declared horizontal and vertical limits.
  if (path.distanceM > MAX_SPEED_MPS * seconds || from.altitudeType !== to.altitudeType || Math.abs(to.altitudeM - from.altitudeM) > MAX_VERTICAL_MPS * seconds) return null;
  let model = 'wgs84-two-observation-interpolation-v1', fallbackReason = method === 'geodesic' ? null : 'Endpoint motion is unavailable or inconsistent';
  let along1 = path.distanceM, along2 = path.distanceM, cross1 = 0, cross2 = 0;
  if (method === 'endpoint-motion' && eligible(before) && eligible(after) && path.distanceM > 1) {
    const endBearing = course(inverse(to, from).bearingDeg + 180);
    along1 = before.speedMps * Math.cos((before.courseDeg - path.bearingDeg) * RAD) * seconds;
    along2 = after.speedMps * Math.cos((after.courseDeg - endBearing) * RAD) * seconds;
    cross1 = before.speedMps * Math.sin((before.courseDeg - path.bearingDeg) * RAD) * seconds;
    cross2 = after.speedMps * Math.sin((after.courseDeg - endBearing) * RAD) * seconds;
    const alongBounds = derivativeBounds(3 * (along1 + along2 - 2 * path.distanceM), 2 * (3 * path.distanceM - 2 * along1 - along2), along1);
    const crossBounds = derivativeBounds(3 * (cross1 + cross2), 2 * (-2 * cross1 - cross2), cross1);
    // Whole-curve derivative bounds prevent reversal or implausible speed;
    // endpoint tangents also keep the curve in a bounded observation corridor.
    if (along1 >= 0 && along2 >= 0 && alongBounds.min >= -1e-6 && Math.hypot(alongBounds.maxAbs, crossBounds.maxAbs) / seconds <= MAX_SPEED_MPS &&
      (Math.abs(cross1) + Math.abs(cross2)) * 4 / 27 <= Math.min(1000, path.distanceM * .3 + 25)) {
      model = 'wgs84-bounded-endpoint-motion-interpolation-v1'; fallbackReason = null;
    }
  }
  return { startAtMs: before.positionTimeMs, endAtMs: after.positionTimeMs, model, fallbackReason,
    position(atMs) {
      const u = Math.max(0, Math.min(1, (atMs - before.positionTimeMs) / gap));
      if (!u) return { ...from }; if (u === 1) return { ...to };
      let along = path.distanceM * u, cross = 0;
      if (model === 'wgs84-bounded-endpoint-motion-interpolation-v1') {
        const u2 = u * u, u3 = u2 * u;
        along = (-2 * u3 + 3 * u2) * path.distanceM + (u3 - 2 * u2 + u) * along1 + (u3 - u2) * along2;
        cross = (u3 - 2 * u2 + u) * cross1 + (u3 - u2) * cross2;
      }
      let point = aircraftGeodesic(from, path.bearingDeg, Math.max(0, Math.min(path.distanceM, along)));
      if (Math.abs(cross) > 1e-6) point = aircraftGeodesic(point, inverse(point, to).bearingDeg + (cross < 0 ? -90 : 90), Math.abs(cross));
      return { ...point, altitudeType: from.altitudeType, altitudeM: from.altitudeM + (to.altitudeM - from.altitudeM) * u };
    },
    moving: path.distanceM > .01 || Math.abs(to.altitudeM - from.altitudeM) > .01,
  };
}

/** Reproducible bounded interpolation; endpoints always remain exact facts. */
export function interpolateAircraftObservations(before, after, atMs, options = {}) {
  const curve = interpolation(before, after, options);
  return curve && atMs >= curve.startAtMs && atMs <= curve.endAtMs ? { position: curve.position(atMs), model: curve.model, fallbackReason: curve.fallbackReason } : null;
}

/** Identity-owned two-fix facts and a separately dated, expiring display model. */
export function createAircraftMotion({ predictionEnabled = false, horizonMs = AIRCRAFT_HORIZON_MS, correctionMs = 1200,
  maxInterpolationGapMs = AIRCRAFT_INTERPOLATION_GAP_MS, interpolationMethod = 'endpoint-motion', diagnosticHorizonMs = 45000 } = {}) {
  if (!Number.isFinite(horizonMs) || horizonMs < 1000 || horizonMs > 120000 || !Number.isFinite(correctionMs) || correctionMs < 0 || correctionMs > 5000 ||
    !Number.isFinite(maxInterpolationGapMs) || maxInterpolationGapMs < 1000 || maxInterpolationGapMs > 120000 || !['endpoint-motion', 'geodesic'].includes(interpolationMethod) || !Number.isFinite(diagnosticHorizonMs) || diagnosticHorizonMs < 1000 || diagnosticHorizonMs > 120000) throw new TypeError('Aircraft motion policy must be finite and bounded');
  let anchor = null, anchorQualified = false, fixes = [], curve = null, correction = null, lastError = null, diagnosticError = null, lastAdmission = null;
  function sample(atMs, { wallTimeMs } = {}) {
    if (!anchor || !Number.isFinite(atMs)) return null;
    const observed = observedPosition(anchor), reported = anchorQualified;
    const validUntilMs = anchorQualified && eligible(anchor) ? expiry(anchor, horizonMs) : null;
    let position = observed, mode = 'observed', active = false, correctionRemainingM = 0, model = null, bufferState = 'unqualified', nextActivationMs = null;
    let displayObservedAtMs = reported ? anchor.positionTimeMs : null;
    // Interpolation is confined to two actual retained fixes and is derived state.
    if (predictionEnabled && curve && atMs < curve.startAtMs) {
      // A new early fix must not move the waiting marker ahead of its cursor,
      // then send it backwards when buffered playback reaches the first fix.
      position = curve.position(curve.startAtMs); displayObservedAtMs = curve.startAtMs;
      bufferState = 'awaiting-buffer'; nextActivationMs = curve.startAtMs;
    } else if (predictionEnabled && curve && atMs >= curve.startAtMs && atMs < curve.endAtMs) {
      position = curve.position(atMs); mode = 'estimated'; model = curve.model; active = curve.moving; bufferState = 'interpolating';
    } else if (predictionEnabled && anchorQualified && eligible(anchor) && atMs >= anchor.positionTimeMs) {
      const modelAtMs = Math.min(atMs, validUntilMs);
      position = projectAircraftObservation(anchor, modelAtMs, { horizonMs }) || observed;
      mode = atMs >= validUntilMs ? 'expired' : atMs > anchor.positionTimeMs ? 'estimated' : 'observed';
      active = atMs < validUntilMs && (anchor.speedMps > 0 || rate(anchor) !== 0); model = AIRCRAFT_MOTION_MODEL;
      bufferState = mode === 'expired' ? 'expired' : 'edge-prediction';
    } else if (predictionEnabled && anchorQualified) {
      bufferState = fixes.length === 2 && !curve ? 'observation-gap' : 'awaiting-buffer';
      nextActivationMs = curve && atMs < curve.startAtMs ? curve.startAtMs : eligible(anchor) && atMs < anchor.positionTimeMs ? anchor.positionTimeMs : null;
    }
    if (correction && model && atMs < validUntilMs) {
      const wall = Number.isFinite(wallTimeMs) ? wallTimeMs : atMs + correction.clockOffsetMs;
      const amount = Math.max(0, Math.min(1, (wall - correction.startedAtMs) / correction.durationMs));
      const remaining = 1 - amount * amount * (3 - 2 * amount);
      if (remaining > 0) {
        position = { ...aircraftGeodesic(position, correction.bearingDeg, correction.distanceM * remaining),
          altitudeM: position.altitudeM + correction.altitudeDeltaM * remaining, altitudeType: position.altitudeType };
        correctionRemainingM = Math.hypot(correction.distanceM, correction.altitudeDeltaM) * remaining; mode = 'estimated'; active ||= correctionRemainingM > 0;
      }
    }
    return { position, mode, active, observedAtMs: reported ? anchor.positionTimeMs : null, displayObservedAtMs: mode === 'observed' ? displayObservedAtMs : null, atMs,
      validUntilMs, estimatedAtMs: mode === 'expired' ? validUntilMs : mode === 'estimated' ? atMs : null,
      model, lastErrorM: lastError?.residualM ?? null, lastErrorForecastHorizonMs: lastError?.forecastHorizonMs ?? null,
      diagnosticErrorM: diagnosticError?.residualM ?? null, diagnosticForecastHorizonMs: diagnosticError?.forecastHorizonMs ?? null, diagnosticHorizonMs,
      correctionRemainingM, bufferState, nextActivationMs,
      basisObservedAtMs: curve && ['interpolating', 'awaiting-buffer'].includes(bufferState) ? fixes.map((fix) => fix.positionTimeMs) : reported ? [anchor.positionTimeMs] : [] };
  }
  function admit(record, receivedAtMs, { displayAtMs = receivedAtMs } = {}) {
    if (!record?.id || !coordinates(record) || !Number.isFinite(receivedAtMs) || !Number.isFinite(displayAtMs) || displayAtMs > receivedAtMs) return { accepted: false, reason: 'invalid-observation', reset: false };
    const incoming = copyObservation(record);
    const previous = anchor, previousReported = anchorQualified;
    const previousRawTime = previous?.positionTimeQuality === 'reported' && time(previous.positionTimeMs);
    const reported = incoming.positionTimeQuality === 'reported' && time(incoming.positionTimeMs);
    if (previous && previous.id === incoming.id && previousRawTime && reported && (incoming.positionTimeMs === previous.positionTimeMs || (previousReported && incoming.positionTimeMs < previous.positionTimeMs)))
      return { accepted: false, reason: incoming.positionTimeMs === previous.positionTimeMs ? 'duplicate-observation' : 'out-of-order', reset: false };
    const beforeDisplay = sample(displayAtMs, { wallTimeMs: receivedAtMs });
    const predicted = previousReported && previous?.id === incoming.id && reported ? projectAircraftObservation(previous, incoming.positionTimeMs, { horizonMs }) : null;
    lastError = predicted ? aircraftObservationError(predicted, incoming) : null;
    if (lastError) lastError = { ...lastError, forecastHorizonMs: incoming.positionTimeMs - previous.positionTimeMs, productionHorizonMs: horizonMs };
    const diagnostic = previousReported && previous?.id === incoming.id && reported ? projectAircraftObservation(previous, incoming.positionTimeMs, { horizonMs: diagnosticHorizonMs }) : null;
    diagnosticError = diagnostic ? { ...aircraftObservationError(diagnostic, incoming), forecastHorizonMs: incoming.positionTimeMs - previous.positionTimeMs, diagnosticHorizonMs } : null;
    let reason = previous ? 'new-observation' : 'first-observation', reset = !previous;
    if (!previous && reported && incoming.positionTimeMs > receivedAtMs) reason = 'future-observation';
    if (previous) {
      const elapsed = previousReported && reported ? (incoming.positionTimeMs - previous.positionTimeMs) / 1000 : null;
      const moved = inverse(previous, incoming).distanceM;
      const oldAltitude = observedPosition(previous), newAltitude = observedPosition(incoming);
      if (previous.id !== incoming.id) { reason = 'identity-change'; reset = true; }
      else if (Boolean(previous.onGround) !== Boolean(incoming.onGround)) { reason = 'ground-transition'; reset = true; }
      else if (!previousReported || !reported || incoming.positionTimeMs > receivedAtMs) { reason = 'unqualified-time'; reset = true; }
      else if (elapsed > 120) { reason = 'observation-gap'; reset = true; }
      else if (moved > MAX_SPEED_MPS * elapsed + 1000 || (oldAltitude.altitudeType === newAltitude.altitudeType && Math.abs(newAltitude.altitudeM - oldAltitude.altitudeM) > MAX_VERTICAL_MPS * elapsed + 300)) { reason = 'implausible-jump'; reset = true; }
      else if (oldAltitude.altitudeType !== newAltitude.altitudeType) { reason = 'altitude-transition'; reset = true; }
    }
    anchor = incoming; anchorQualified = reported && incoming.positionTimeMs <= receivedAtMs; correction = null;
    if (reset) fixes = [];
    if (reported && incoming.positionTimeMs <= receivedAtMs) fixes = [...fixes, incoming].slice(-2);
    curve = fixes.length === 2 ? interpolation(fixes[0], fixes[1], { method: interpolationMethod, maxInterpolationGapMs }) : null;
    const targetDisplay = sample(displayAtMs, { wallTimeMs: receivedAtMs });
    if (predictionEnabled && !reset && correctionMs > 0 && beforeDisplay && targetDisplay?.model && displayAtMs < targetDisplay.validUntilMs && beforeDisplay.position.altitudeType === targetDisplay.position.altitudeType) {
      const target = targetDisplay.position, offset = inverse(target, beforeDisplay.position), altitudeDeltaM = beforeDisplay.position.altitudeM - target.altitudeM;
      if (Math.hypot(offset.distanceM, altitudeDeltaM) <= MAX_CORRECTION_M)
        correction = { startedAtMs: receivedAtMs, clockOffsetMs: receivedAtMs - displayAtMs, durationMs: Math.min(correctionMs, targetDisplay.validUntilMs - displayAtMs), distanceM: offset.distanceM, bearingDeg: offset.bearingDeg, altitudeDeltaM };
      else { reason = 'large-correction'; reset = true; fixes = [incoming]; curve = null; }
    }
    lastAdmission = { accepted: true, reason, reset, residualM: lastError?.residualM ?? null,
      residualHorizontalM: lastError?.residualHorizontalM ?? null, residualVerticalM: lastError?.residualVerticalM ?? null,
      residualForecastHorizonMs: lastError?.forecastHorizonMs ?? null, diagnosticResidualM: diagnosticError?.residualM ?? null };
    return { ...lastAdmission };
  }
  return { admit, sample, getState: () => ({ predictionEnabled: Boolean(predictionEnabled), horizonMs, correctionMs, maxInterpolationGapMs, interpolationMethod, diagnosticHorizonMs, model: AIRCRAFT_MOTION_MODEL,
    timeEligible: anchorQualified, observation: anchor ? copyObservation(anchor) : null, fixes: fixes.map(copyObservation), lastError: lastError ? { ...lastError } : null,
    diagnosticError: diagnosticError ? { ...diagnosticError } : null,
    lastAdmission: lastAdmission ? { ...lastAdmission } : null }) };
}
