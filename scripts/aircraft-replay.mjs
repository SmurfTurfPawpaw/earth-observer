import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeReadsbAircraft } from '../src/sources/live/aircraft.js';
import { AIRCRAFT_MOTION_MODEL, createAircraftMotion, projectAircraftObservation, aircraftObservationError } from '../src/core/aircraft-motion.js';

export const REPLAY_LIMITS = Object.freeze({ inputBytes: 32 * 1024 * 1024, traces: 500, records: 500000,
  executionMs: 90000, outputBytes: 1024 * 1024, toleranceMs: 1000, maxGapMs: 20000, maxTraceSpanMs: 172800000 });
const HORIZONS = Object.freeze([5, 10, 15, 30, 45]);
const FORMAT = 'https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const iso = (value) => new Date(value).toISOString();
const text = (value) => typeof value === 'string' ? value.slice(0, 2400) : null;
const round = (value) => Math.round(value * 1000) / 1000;
const turn = (a, b) => Math.abs(((b - a + 540) % 360) - 180);

function altitudeType(record) {
  if (record.onGround) return 'ground';
  if (finite(record.ellipsoidAltitudeM) && record.ellipsoidAltitudeM >= -500 && record.ellipsoidAltitudeM <= 20000) return 'geometric';
  if (finite(record.baroAltitudeM) && record.baroAltitudeM >= -500 && record.baroAltitudeM <= 20000) return 'barometric';
  return 'unknown';
}
function compatibleRate(record) {
  return record.verticalRateAltitudeType === altitudeType(record) && finite(record.verticalRateMps) && Math.abs(record.verticalRateMps) <= 60;
}

/** Translate an actual trace fix; zero age represents its supplied fix epoch, not a guessed receipt time.
 * No motion field is carried forward from an earlier point's optional extra object.
 */
export function normalizeReadsbTracePoint(trace, point) {
  if (!Array.isArray(point) || point.length < 10 || !finite(trace?.timestamp) || !finite(point[0]) ||
      !Number.isInteger(point[6]) || point[6] < 0 || point[6] > 65535) return null;
  const at = trace.timestamp * 1000 + point[0] * 1000;
  if (!finite(at) || at <= 0 || at > 8640000000000000) return null;
  const flags = point[6], extra = point[8] && typeof point[8] === 'object' && !Array.isArray(point[8]) ? point[8] : {};
  const raw = { ...extra, hex: trace.icao, r: trace.r, t: trace.t,
    lat: point[1], lon: point[2], gs: point[4], track: point[5], seen_pos: 0, seen: undefined,
    alt_baro: point[3] === 'ground' ? 'ground' : flags & 8 ? null : point[3],
    alt_geom: finite(point[10]) ? point[10] : flags & 8 && point[3] !== 'ground' ? point[3] : null,
    baro_rate: flags & 4 ? null : point[7], geom_rate: finite(point[11]) ? point[11] : flags & 4 ? point[7] : null,
  };
  const record = normalizeReadsbAircraft(raw, at, { observedAtSource: 'source' });
  if (!record || record.positionTimeQuality !== 'reported') return null;
  return { record, flags, sourceType: text(point[9]) || text(extra.type) || 'unknown', altitudeType: altitudeType(record) };
}

function distribution(values) {
  if (!values.length) return { count: 0, p50: null, p90: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b), quantile = (p) => round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
  return { count: sorted.length, p50: quantile(.5), p90: quantile(.9), p95: quantile(.95), p99: quantile(.99),
    max: round(sorted.at(-1)), mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) };
}
function metrics() { return { horizontal: [], vertical: [], verticalSigned: [], compatibleVertical: [], heldVertical: [], elapsed: [], worst: null }; }
function addMetric(target, error, elapsed, anchor, details) {
  target.horizontal.push(error.residualHorizontalM); target.elapsed.push(elapsed);
  if (finite(error.residualVerticalM)) {
    target.vertical.push(Math.abs(error.residualVerticalM)); target.verticalSigned.push(error.residualVerticalM);
    (compatibleRate(anchor.record) ? target.compatibleVertical : target.heldVertical).push(Math.abs(error.residualVerticalM));
  }
  if (!target.worst || error.residualHorizontalM > target.worst.errorM) target.worst = { ...details, errorM: error.residualHorizontalM };
}
function summarized(target) {
  return { horizontalM: distribution(target.horizontal), verticalAbsoluteM: distribution(target.vertical),
    verticalSignedBiasM: target.verticalSigned.length ? round(target.verticalSigned.reduce((sum, value) => sum + value, 0) / target.verticalSigned.length) : null,
    verticalWithCompatibleRateM: distribution(target.compatibleVertical), verticalWhileHeldM: distribution(target.heldVertical),
    actualElapsedSeconds: distribution(target.elapsed), worstHorizontalCase: target.worst ? { ...target.worst, errorM: round(target.worst.errorM) } : null };
}
function bufferedSummary(target) {
  const { actualElapsedSeconds, verticalWithCompatibleRateM: _compatible, verticalWhileHeldM: _held, ...values } = summarized(target);
  return { ...values, actualPresentationDelaySeconds: actualElapsedSeconds };
}
const increment = (target, key, value = 1) => { target[key] = (target[key] || 0) + value; };
function nearestFuture(points, index, wantedAt) {
  let low = index + 1, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle].record.positionTimeMs < wantedAt) low = middle + 1; else high = middle; }
  let result = null;
  for (const candidate of [low - 1, low]) {
    if (candidate <= index || candidate >= points.length) continue;
    const distance = Math.abs(points[candidate].record.positionTimeMs - wantedAt);
    if (distance <= REPLAY_LIMITS.toleranceMs && (!result || distance < result.distance || distance === result.distance && candidate < result.index)) result = { index: candidate, distance };
  }
  return result?.index ?? null;
}
function turnClass(anchor, truth, elapsed) {
  if (!finite(anchor.courseDeg) || !finite(truth.courseDeg)) return 'unknown';
  const rate = turn(anchor.courseDeg, truth.courseDeg) / elapsed;
  return rate <= .25 ? 'at-most-0.25-deg-per-second' : rate <= 1 ? '0.25-to-1-deg-per-second' : rate <= 3 ? '1-to-3-deg-per-second' : 'over-3-deg-per-second';
}
function gapIndex(points) {
  let size = 1; while (size < points.length) size *= 2;
  const values = new Float64Array(size * 2);
  for (let index = 1; index < points.length; index++) values[size + index] = points[index].record.positionTimeMs - points[index - 1].record.positionTimeMs;
  for (let index = size - 1; index > 0; index--) values[index] = Math.max(values[index * 2], values[index * 2 + 1]);
  return { size, values };
}
function gapClass(gaps, start, end) {
  let gap = 0, left = gaps.size + start + 1, right = gaps.size + end + 1;
  while (left < right) {
    if (left & 1) gap = Math.max(gap, gaps.values[left++]);
    if (right & 1) gap = Math.max(gap, gaps.values[--right]);
    left >>>= 1; right >>>= 1;
  }
  return gap <= 1000 ? 'at-most-1-second' : gap <= 5000 ? '1-to-5-seconds' : gap <= 10000 ? '5-to-10-seconds' : gap <= 20000 ? '10-to-20-seconds' : 'over-20-seconds';
}
const BOUNDARIES = ['invalid-observation', 'out-of-order', 'unsupported-flags', 'stale-position', 'new-leg', 'ground-transition', 'observation-gap', 'altitude-transition', 'implausible-jump'];
function intervalReasons(points, start, end) {
  return BOUNDARIES.filter((reason) => points[end].prefix[reason] > points[start].prefix[reason]);
}

function prepareTrace(item, totals, checkDeadline) {
  const trace = item?.record;
  if (!trace || !Array.isArray(trace.trace)) throw new TypeError('A sampled trace must contain actual point arrays');
  const points = [], prefix = Object.fromEntries(BOUNDARIES.map((key) => [key, 0])), pending = new Set();
  let fixtureIneligiblePrefix = 0;
  const metadata = { icao: text(trace.icao), archivePath: text(item.archivePath), declaredSourceTraceSha256: text(item.sha256),
    parsedTraceSha256: sha256(JSON.stringify(trace)), version: text(trace.version) };
  for (let index = 0; index < trace.trace.length; index++) {
    if (!(index % 1024)) checkDeadline();
    const point = normalizeReadsbTracePoint(trace, trace.trace[index]);
    if (!point) { increment(totals.excludedRows, 'invalid-observation'); pending.add('invalid-observation'); continue; }
    const previous = points.at(-1), at = point.record.positionTimeMs;
    if (previous && at <= previous.record.positionTimeMs) {
      const duplicate = at === previous.record.positionTimeMs;
      increment(totals.excludedRows, duplicate ? 'duplicate-timestamp' : 'out-of-order');
      if (!duplicate) pending.add('out-of-order');
      continue;
    }
    const boundaries = new Set(pending); pending.clear();
    if (point.flags & ~15) boundaries.add('unsupported-flags');
    if (point.flags & 1 || previous?.flags & 1) boundaries.add('stale-position');
    if (point.flags & 2) boundaries.add('new-leg');
    if (previous) {
      const elapsedMs = at - previous.record.positionTimeMs;
      if (Boolean(previous.record.onGround) !== Boolean(point.record.onGround)) boundaries.add('ground-transition');
      if (elapsedMs > REPLAY_LIMITS.maxGapMs) boundaries.add('observation-gap');
      if (previous.altitudeType !== point.altitudeType) boundaries.add('altitude-transition');
      const distance = aircraftObservationError({ ...previous.record, altitudeM: 0, altitudeType: 'unknown' }, point.record)?.residualHorizontalM;
      if (distance > 450 * elapsedMs / 1000 + 1000) boundaries.add('implausible-jump');
      if (previous.altitudeType === point.altitudeType && ['geometric', 'barometric'].includes(point.altitudeType)) {
        const key = point.altitudeType === 'geometric' ? 'ellipsoidAltitudeM' : 'baroAltitudeM';
        if (Math.abs(point.record[key] - previous.record[key]) > 60 * elapsedMs / 1000 + 300) boundaries.add('implausible-jump');
      }
    }
    for (const reason of boundaries) { prefix[reason]++; increment(totals.segmentBoundaries, reason); }
    const modelEligible = Boolean(projectAircraftObservation(point.record, point.record.positionTimeMs));
    if (point.flags & 3 || !modelEligible) fixtureIneligiblePrefix++;
    points.push({ ...point, modelEligible, fixtureIneligiblePrefix, prefix: { ...prefix }, originalPointIndex: index });
    totals.admittedRows++; increment(totals.sourceTypes, point.sourceType);
    increment(totals.altitudeTypes, point.altitudeType);
    if (point.flags & 1) totals.staleFlagRows++;
    if (point.flags & 2) totals.newLegFlagRows++;
    totals.firstAtMs = Math.min(totals.firstAtMs, at); totals.lastAtMs = Math.max(totals.lastAtMs, at);
  }
  if (points.length && points.at(-1).record.positionTimeMs - points[0].record.positionTimeMs > REPLAY_LIMITS.maxTraceSpanMs)
    throw new TypeError('A one-day trace replay cannot admit a span exceeding 48 hours');
  return { metadata, points, gaps: gapIndex(points) };
}

function fixture(traces, source, checkDeadline) {
  for (const trace of traces) {
    const { points } = trace;
    for (let index = 0; index < points.length; index++) {
      if (!(index % 1024)) checkDeadline();
      const start = points[index];
      if (start.flags & 3 || !start.modelEligible) continue;
      const thirty = nearestFuture(points, index, start.record.positionTimeMs + 30000);
      if (thirty == null || intervalReasons(points, index, thirty).length) continue;
      const target = points[thirty], elapsed = (target.record.positionTimeMs - start.record.positionTimeMs) / 1000;
      const predicted = projectAircraftObservation(start.record, target.record.positionTimeMs, { horizonMs: 31000 });
      const error = predicted && aircraftObservationError(predicted, target.record);
      const change = finite(target.record.courseDeg) ? turn(start.record.courseDeg, target.record.courseDeg) : null;
      if (!error || error.residualHorizontalM < 1 || error.residualHorizontalM > 1500 || change == null || change < .5 || change > 25) continue;
      let low = index, high = points.length;
      while (low < high) { const middle = (low + high) >>> 1; if (points[middle].record.positionTimeMs <= start.record.positionTimeMs + 90000) low = middle + 1; else high = middle; }
      const end = low - 1;
      if (points[end].record.positionTimeMs - start.record.positionTimeMs < 60000 || intervalReasons(points, index, end).length) continue;
      if (points[end].fixtureIneligiblePrefix > (points[index - 1]?.fixtureIneligiblePrefix || 0)) continue;
      return { schemaVersion: 1, localOnly: true, mode: 'historical-observation-replay', ...source, ...trace.metadata,
        startAt: iso(start.record.positionTimeMs), endAt: iso(points[end].record.positionTimeMs), durationMs: points[end].record.positionTimeMs - start.record.positionTimeMs,
        snapshotMetadata: { source: source.source, coverage: 'A selected historical segment for local renderer QA', observedAtSource: 'source' },
        observations: points.slice(index, end + 1).map((point) => point.record),
        pointMetadata: points.slice(index, end + 1).map((point) => ({ at: iso(point.record.positionTimeMs), flags: point.flags, sourceType: point.sourceType })),
        selection: { purpose: 'A modest turn provides a measurable correction in local UI replay; selection does not filter bulk calibration',
          atThirtySeconds: { actualElapsedSeconds: round(elapsed), observedCourseChangeDegrees: round(change), horizontalResidualM: round(error.residualHorizontalM) } },
        timeMeaning: 'Original observation epochs are immutable. Advance a simulated historical UTC clock; these are not production live observations.' };
    }
  }
  return null;
}

/** Simulated arrivals admit only original fixes already available at that UTC.
 * Every scored intermediate fix is withheld from both presentation models.
 */
function bufferedCadence(traces, checkDeadline) {
  const cadenceMs = 30000, delayMs = 25000, horizonMs = 5000, maxInterpolationGapMs = 35000;
  const methods = ['geodesic', 'endpoint-motion'];
  const combined = Object.fromEntries(methods.map((method) => [method, { errors: metrics(), allWithheld: metrics(),
    exclusions: {}, intervalExclusions: {}, displayedModes: {}, rawInterpolation: metrics(), rawEdge: metrics() }]));
  const sourceAges = [], counts = { actualTruthRows: 0, simulatedDeliveries: 0, unchangedDeliveries: 0,
    staleDeliveries: 0, changedSourceDeliveries: 0, truthWasDelivered: 0, staleTruth: 0, unsupportedTruth: 0 };
  const truthCoverage = { clockSamples: 0, samplesWithRecordedTruthWithinOneSecond: 0, samplesWithoutRecordedTruthWithinOneSecond: 0 };
  let coldStartSeconds = 0;
  for (const trace of traces) {
    const { points, metadata } = trace;
    if (!points.length) continue;
    coldStartSeconds += delayMs / 1000;
    const firstTime = points[0].record.positionTimeMs, lastGridIndex = Math.floor((points.at(-1).record.positionTimeMs - firstTime) / 1000);
    truthCoverage.clockSamples += lastGridIndex + 1;
    let coverageStart = null, coverageEnd = null;
    for (const point of points) {
      if (point.flags & 1 || point.flags & ~15) continue;
      const start = Math.max(0, Math.ceil((point.record.positionTimeMs - firstTime - 1000) / 1000));
      const end = Math.min(lastGridIndex, Math.floor((point.record.positionTimeMs - firstTime + 1000) / 1000));
      if (start > end) continue;
      if (coverageStart !== null && start > coverageEnd + 1) {
        truthCoverage.samplesWithRecordedTruthWithinOneSecond += coverageEnd - coverageStart + 1;
        coverageStart = null;
      }
      coverageStart ??= start; coverageEnd = Math.max(coverageEnd ?? end, end);
    }
    if (coverageStart !== null) truthCoverage.samplesWithRecordedTruthWithinOneSecond += coverageEnd - coverageStart + 1;
    const models = Object.fromEntries(methods.map((method) => [method, createAircraftMotion({ predictionEnabled: true,
      horizonMs, maxInterpolationGapMs, interpolationMethod: method, correctionMs: 0 })]));
    const byTime = new Map(points.map((point, index) => [point.record.positionTimeMs, index])), delivered = new Set();
    const beganAt = points[0].record.positionTimeMs;
    let nextDeliveryAt = beganAt, sourceIndex = -1, lastDeliveredIndex = -1, deliveries = 0;
    for (let truthIndex = 0; truthIndex < points.length; truthIndex++) {
      if (!(truthIndex % 1024)) checkDeadline();
      const truth = points[truthIndex], cursorAt = truth.record.positionTimeMs, receivedUtc = cursorAt + delayMs;
      while (nextDeliveryAt <= receivedUtc) {
        if (!(deliveries++ % 1024)) checkDeadline();
        while (sourceIndex + 1 < points.length && points[sourceIndex + 1].record.positionTimeMs <= nextDeliveryAt) sourceIndex++;
        counts.simulatedDeliveries++;
        if (sourceIndex === lastDeliveredIndex) {
          // Re-reading the same fix cannot refresh its epoch or model horizon.
          // Aggregate unchanged empty schedule slots without allocating frames.
          const beforeNextFix = sourceIndex + 1 < points.length ? points[sourceIndex + 1].record.positionTimeMs - .001 : receivedUtc;
          const until = Math.min(receivedUtc, beforeNextFix);
          const repeats = Math.max(0, Math.floor((until - nextDeliveryAt) / cadenceMs));
          counts.unchangedDeliveries += repeats + 1; counts.simulatedDeliveries += repeats;
          nextDeliveryAt += (repeats + 1) * cadenceMs; continue;
        }
        lastDeliveredIndex = sourceIndex;
        if (sourceIndex >= 0) {
          const actual = points[sourceIndex]; delivered.add(sourceIndex);
          sourceAges.push(nextDeliveryAt - actual.record.positionTimeMs); counts.changedSourceDeliveries++;
          if (actual.flags & 1 || actual.flags & ~15) counts.staleDeliveries++;
          else for (const model of Object.values(models)) {
            // The point was recorded at or before this delivery. No intermediate
            // or future source observation enters the model's two-fix buffer.
            if (actual.record.positionTimeMs > nextDeliveryAt) throw new Error('Replay admitted a future source fix');
            model.admit(actual.record, nextDeliveryAt, { displayAtMs: nextDeliveryAt - delayMs });
          }
        }
        nextDeliveryAt += cadenceMs;
      }
      counts.actualTruthRows++;
      if (truth.flags & 1) { counts.staleTruth++; for (const target of Object.values(combined)) increment(target.exclusions, 'stale-truth'); continue; }
      if (truth.flags & ~15) { counts.unsupportedTruth++; for (const target of Object.values(combined)) increment(target.exclusions, 'unsupported-truth-flags'); continue; }
      if (delivered.has(truthIndex)) { counts.truthWasDelivered++; for (const target of Object.values(combined)) increment(target.exclusions, 'truth-was-delivered-not-withheld'); continue; }
      for (const method of methods) {
        const model = models[method], target = combined[method], state = model.getState(), view = model.sample(cursorAt);
        const latest = state.observation, error = view && aircraftObservationError(view.position, truth.record);
        increment(target.displayedModes, view?.mode || 'unavailable');
        const details = { ...metadata, truthAt: iso(cursorAt), receivedUtc: iso(receivedUtc),
          latestAvailableFixAt: latest?.positionTimeMs ? iso(latest.positionTimeMs) : null,
          availableFixAgeSeconds: latest?.positionTimeMs ? round((receivedUtc - latest.positionTimeMs) / 1000) : null,
          displayedMode: view?.mode || 'unavailable', model: view?.model || null };
        if (error && finite(error.residualHorizontalM)) addMetric(target.allWithheld, error, delayMs / 1000, truth, details);
        if (!latest || !view) { increment(target.exclusions, 'startup-or-unavailable-model'); continue; }
        if (truth.record.onGround) { increment(target.exclusions, 'on-ground-truth'); continue; }
        if (!projectAircraftObservation(latest, latest.positionTimeMs)) { increment(target.exclusions, 'ineligible-source-anchor'); continue; }
        if (view.mode === 'expired') { increment(target.exclusions, 'edge-horizon-expired'); continue; }
        if (view.mode !== 'estimated' || !error || !finite(error.residualHorizontalM)) { increment(target.exclusions, 'cursor-outside-available-interval'); continue; }
        const indexes = state.fixes.map((fix) => byTime.get(fix.positionTimeMs)).filter(Number.isInteger);
        const latestIndex = byTime.get(latest.positionTimeMs);
        const interpolation = view.model !== AIRCRAFT_MOTION_MODEL;
        const boundaries = interpolation && indexes.length === 2 ? intervalReasons(points, Math.min(...indexes, truthIndex), Math.max(...indexes, truthIndex)) :
          Number.isInteger(latestIndex) ? intervalReasons(points, Math.min(latestIndex, truthIndex), Math.max(latestIndex, truthIndex)) : ['invalid-observation'];
        if (boundaries.length) {
          increment(target.exclusions, 'interval-boundary'); for (const reason of boundaries) increment(target.intervalExclusions, reason); continue;
        }
        addMetric(target.errors, error, delayMs / 1000, truth, details);
        addMetric(interpolation ? target.rawInterpolation : target.rawEdge, error, delayMs / 1000, truth, details);
      }
    }
  }
  const comparison = Object.fromEntries(methods.map((method) => {
    const result = combined[method], accepted = result.errors.horizontal.length;
    const excluded = Object.values(result.exclusions).reduce((sum, value) => sum + value, 0);
    if (accepted + excluded !== counts.actualTruthRows) throw new Error('Buffered replay denominator accounting failed');
    return [method, { denominators: { actualTruthRows: counts.actualTruthRows, acceptedPairs: accepted, excludedPairs: excluded },
      exclusions: result.exclusions, intervalExclusions: result.intervalExclusions, displayedModes: result.displayedModes,
      errors: bufferedSummary(result.errors), interpolationErrors: bufferedSummary(result.rawInterpolation), edgePredictionErrors: bufferedSummary(result.rawEdge),
      allWithheldBeforeEligibilityAndBoundaryExclusions: bufferedSummary(result.allWithheld) }];
  }));
  truthCoverage.samplesWithoutRecordedTruthWithinOneSecond = truthCoverage.clockSamples - truthCoverage.samplesWithRecordedTruthWithinOneSecond;
  return { method: 'actual-withheld-fix-buffered-cadence-replay-v1', acquisitionCadenceSeconds: 30, presentationDelaySeconds: 25,
    edgePredictionHorizonSeconds: 5, maxInterpolationGapSeconds: 35, correctionSeconds: 0,
    counts: { ...counts, initialPresentationWithoutPreexistingTruthSeconds: coldStartSeconds },
    recordedTruthCoverageOnOneSecondClockGrid: truthCoverage,
    actualFixAgeAtChangedDeliveryMs: distribution(sourceAges), comparison,
    interpretation: [
      'At each simulated 30-second acquisition, only the latest original trace fix already recorded at that UTC is admitted. Repeated delivery of an unchanged fix never advances its epoch.',
      'Each held-out real fix is scored at its untouched observation UTC, with simulated receiver UTC 25 seconds later. Both models retain at most two received fixes; they never receive the withheld intermediate truth.',
      'The initial 25-second presentation period of each trace has no earlier recorded truth. Its duration is counted explicitly, rather than invented or included as successful playback.',
      'A separate one-second clock-grid accounting counts positions with no recorded non-stale truth within ±1 second, including long gaps. This is reference availability only; scoring still uses untouched actual fix epochs, never grid-shifted or interpolated truth.',
      'Stale trace positions cannot establish a new fix epoch and are not admitted. The former model anchor keeps aging. Stale truth and delivered truth are excluded explicitly.',
      'Primary errors exclude ineligible/ground/expired/outside-interval and recorded source-boundary cases. All available held-out comparisons are separately retained before those exclusions, including maxima.',
      'Raw model comparison disables visual correction blending. Renderer reconciliation is verified separately; these metrics do not establish live network delivery or global accuracy.',
    ] };
}

export function calibrateAircraftTraces(sample, { inputSha256 = null } = {}) {
  if (!sample || !Array.isArray(sample.traces) || sample.traces.length > REPLAY_LIMITS.traces) throw new TypeError('Replay trace count is invalid or exceeds 500');
  const totalRows = sample.traces.reduce((sum, trace) => sum + (Array.isArray(trace?.record?.trace) ? trace.record.trace.length : 0), 0);
  if (totalRows > REPLAY_LIMITS.records) throw new TypeError('Replay point count exceeds 500000');
  const beganAt = Date.now(), checkDeadline = () => { if (Date.now() - beganAt > REPLAY_LIMITS.executionMs) throw new Error('Replay execution exceeded its finite 90-second budget'); };
  const totals = { traceCount: sample.traces.length, totalRows, admittedRows: 0, excludedRows: {}, segmentBoundaries: {}, sourceTypes: {}, altitudeTypes: {},
    staleFlagRows: 0, newLegFlagRows: 0, firstAtMs: Infinity, lastAtMs: -Infinity };
  const traces = sample.traces.map((trace) => prepareTrace(trace, totals, checkDeadline));
  const horizons = HORIZONS.map((seconds) => {
    const exclusions = {}, intervalExclusions = {}, accepted = metrics(), allMatched = metrics(), strata = { sourceType: {}, turnRate: {}, maxObservationGap: {}, altitudeType: {} };
    let eligibleAnchors = 0, actualFutureMatches = 0;
    for (const trace of traces) for (let index = 0; index < trace.points.length; index++) {
      if (!(index % 1024)) checkDeadline();
      const anchor = trace.points[index], record = anchor.record;
      if (anchor.flags & ~15) { increment(exclusions, 'unsupported-anchor-flags'); continue; }
      if (anchor.flags & 1) { increment(exclusions, 'stale-anchor'); continue; }
      if (anchor.flags & 2) { increment(exclusions, 'new-leg-anchor'); continue; }
      if (record.onGround) { increment(exclusions, 'on-ground-anchor'); continue; }
      if (!anchor.modelEligible) { increment(exclusions, 'model-ineligible-anchor'); continue; }
      eligibleAnchors++;
      const targetIndex = nearestFuture(trace.points, index, record.positionTimeMs + seconds * 1000);
      if (targetIndex == null) { increment(exclusions, 'no-actual-fix-within-one-second'); continue; }
      actualFutureMatches++;
      const truth = trace.points[targetIndex], atMs = truth.record.positionTimeMs, elapsed = (atMs - record.positionTimeMs) / 1000;
      // Evaluate at the actual future fix time. The one-second match tolerance
      // does not create an interpolated observation or silently shift its date.
      const projected = projectAircraftObservation(record, atMs, { horizonMs: seconds * 1000 + REPLAY_LIMITS.toleranceMs });
      if (!projected) { increment(exclusions, 'projection-expired-or-ineligible'); continue; }
      const error = aircraftObservationError(projected, truth.record);
      if (!error || !finite(error.residualHorizontalM)) { increment(exclusions, 'invalid-error-comparison'); continue; }
      const reasons = intervalReasons(trace.points, index, targetIndex);
      const details = { ...trace.metadata, anchorAt: iso(record.positionTimeMs), truthAt: iso(atMs), actualElapsedSeconds: round(elapsed),
        sourceType: anchor.sourceType, intervalExclusions: reasons };
      addMetric(allMatched, error, elapsed, anchor, details);
      if (reasons.length) { increment(exclusions, 'interval-boundary'); for (const reason of reasons) increment(intervalExclusions, reason); continue; }
      addMetric(accepted, error, elapsed, anchor, details);
      const classes = { sourceType: anchor.sourceType, turnRate: turnClass(record, truth.record, elapsed),
        maxObservationGap: gapClass(trace.gaps, index, targetIndex), altitudeType: anchor.altitudeType };
      for (const [dimension, key] of Object.entries(classes)) {
        strata[dimension][key] ||= metrics(); addMetric(strata[dimension][key], error, elapsed, anchor, details);
      }
    }
    const acceptedPairs = accepted.horizontal.length, excludedAnchors = Object.values(exclusions).reduce((sum, count) => sum + count, 0);
    if (acceptedPairs + excludedAnchors !== totals.admittedRows) throw new Error('Replay denominator accounting failed');
    return { nominalHorizonSeconds: seconds, matchingToleranceSeconds: 1,
      denominators: { allAdmittedAnchors: totals.admittedRows, eligibleAnchors, actualFutureMatches, acceptedPairs, excludedAnchors,
        acceptedFractionOfAllAnchors: totals.admittedRows ? round(acceptedPairs / totals.admittedRows) : 0,
        acceptedFractionOfEligibleAnchors: eligibleAnchors ? round(acceptedPairs / eligibleAnchors) : 0 },
      exclusions, intervalExclusions, errors: summarized(accepted),
      allMatchedIntervalsBeforeBoundaryExclusions: summarized(allMatched),
      stratifiedErrors: Object.fromEntries(Object.entries(strata).map(([dimension, values]) => [dimension,
        Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, summarized(value)]))])) };
  });
  const source = { source: text(sample.source), release: text(sample.release), sourceUrl: text(sample.url), license: text(sample.licence),
    format: text(sample.format) || FORMAT, sampleMethod: text(sample.sampleMethod), downloadedBytes: sample.downloadedBytes, inputSha256 };
  const { firstAtMs, lastAtMs, ...counts } = totals;
  const report = { schemaVersion: 1, method: 'actual-readsb-trace-dead-reckoning-replay-v1', model: AIRCRAFT_MOTION_MODEL,
    generatedAt: iso(Date.now()), source, limits: REPLAY_LIMITS,
    normalization: { format: FORMAT, baseTime: 'record.timestamp Unix seconds + each point[0] offset seconds',
      flags: { 1: 'No position received for 20 seconds before this point', 2: 'Start of new leg', 4: 'point[7] is geometric vertical rate', 8: 'point[3] is geometric altitude' },
      fields: { 3: 'Altitude feet or ground', 4: 'Groundspeed knots', 5: 'Track degrees; ground heading is excluded', 7: 'Vertical rate feet/minute', 10: 'Geometric altitude feet', 11: 'Geometric vertical rate feet/minute' },
      translation: 'Actual trace fix epochs are represented as source snapshot time plus seen_pos:0 through normalizeReadsbAircraft. No snapshot receipt time or fabricated future observation is used.',
      carryForward: 'None for position, speed, course, altitude or rate. Optional point[8] provides only that point\'s reported metadata.',
      gapPolicySeconds: 20, jumpPolicy: 'Adjacent position discontinuities exceeding 450m/s × elapsed + 1000m, or compatible-altitude discontinuities exceeding 60m/s × elapsed + 300m, break intervals, matching model admission bounds.',
      altitudePolicy: 'Geometric altitude preferred; vertical rate is used only for the same altitude type and within the model\'s 60m/s bound.' },
    counts: { ...counts, firstObservedAt: finite(firstAtMs) ? iso(firstAtMs) : null, lastObservedAt: finite(lastAtMs) ? iso(lastAtMs) : null }, horizons,
    bufferedCadence: bufferedCadence(traces, checkDeadline),
    interpretation: [
      'Future truth is the nearest actual subsequent admitted fix within ±1 second, with ties resolved to the earlier fix; it is never interpolated.',
      'Predictions are evaluated at that original future epoch, so actual elapsed time can differ from the nominal horizon by up to one second.',
      'All admitted anchors are accounted for. Boundary reason counts overlap; the primary exclusion partition does not overlap.',
      'The all-matched interval summary retains comparison errors before stale/new-leg/gap/ground/altitude/jump exclusions. No interval is excluded because its prediction error is large.',
      'Error quantiles use nearest rank. Horizontal error is WGS84 distance; vertical statistics are absolute error only where predicted and observed altitude types match. Signed bias is reported separately.',
      'One-day first-4MiB suffix-e3 convenience sample, not a representative global/aircraft/receiver validation. Repeated fixes are correlated; quantiles are not calibrated confidence or an accuracy guarantee.',
      'Trace recording has denser sampling than the live browser receiver cadence. Replay measures open-loop projection from fixes, not live network delivery, dropouts or measured receipt age.',
    ] };
  checkDeadline();
  const browserFixture = fixture(traces, source, checkDeadline);
  checkDeadline();
  return { report, browserFixture };
}

async function boundedInput(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > REPLAY_LIMITS.inputBytes) throw new TypeError('Replay input must be a regular file no larger than 32MiB');
    const buffer = Buffer.alloc(Math.min(REPLAY_LIMITS.inputBytes + 1, stat.size + 1)); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; }
    if (length > stat.size || length > REPLAY_LIMITS.inputBytes) throw new Error('Replay input grew beyond its admitted size');
    const data = buffer.subarray(0, length); return { sample: JSON.parse(data.toString('utf8')), inputSha256: sha256(data) };
  } finally { await file.close(); }
}
async function saveJson(path, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(body) > REPLAY_LIMITS.outputBytes) throw new Error('Replay output exceeded its 1MiB bound');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, body, 'utf8');
}
async function main() {
  const options = { '--input': '.qa/aircraft-history-sample.json', '--output': '.qa/aircraft-replay-report.json', '--fixture': '.qa/aircraft-browser-fixture.json' };
  for (let index = 0; index < process.argv.slice(2).length; index += 2) {
    const key = process.argv[index + 2], value = process.argv[index + 3];
    if (!Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new TypeError('Usage: node scripts/aircraft-replay.mjs [--input sample.json] [--output report.json] [--fixture fixture.json]');
    options[key] = value;
  }
  const inputPath = resolve(options['--input']), outputPath = resolve(options['--output']), fixturePath = resolve(options['--fixture']);
  if (new Set([inputPath, outputPath, fixturePath]).size !== 3) throw new TypeError('Input and output paths must differ; the source sample remains immutable');
  const input = await boundedInput(inputPath), { report, browserFixture } = calibrateAircraftTraces(input.sample, input);
  report.implementation = { modelSha256: sha256(await readFile(new URL('../src/core/aircraft-motion.js', import.meta.url))),
    normalizerSha256: sha256(await readFile(new URL('../src/sources/live/aircraft.js', import.meta.url))),
    replaySha256: sha256(await readFile(new URL('./aircraft-replay.mjs', import.meta.url))) };
  await saveJson(outputPath, report);
  if (!browserFixture) throw new Error('No qualifying historical UI segment was found; calibration report was saved without an invented fixture');
  await saveJson(fixturePath, browserFixture);
  process.stdout.write(JSON.stringify({ report: outputPath, fixture: fixturePath, inputSha256: report.source.inputSha256,
    traces: report.counts.traceCount, observedFixes: report.counts.totalRows,
    horizons: report.horizons.map((horizon) => ({ seconds: horizon.nominalHorizonSeconds, pairs: horizon.denominators.acceptedPairs,
      horizontalP95M: horizon.errors.horizontalM.p95, horizontalP99M: horizon.errors.horizontalM.p99, horizontalMaxM: horizon.errors.horizontalM.max,
      verticalP95M: horizon.errors.verticalAbsoluteM.p95 })), buffered: Object.fromEntries(Object.entries(report.bufferedCadence.comparison).map(([method, values]) => [method, {
        pairs: values.denominators.acceptedPairs, horizontalP95M: values.errors.horizontalM.p95,
        horizontalP99M: values.errors.horizontalM.p99, horizontalMaxM: values.errors.horizontalM.max,
      }])) }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`Aircraft replay failed: ${error.message}\n`); process.exitCode = 1; });
