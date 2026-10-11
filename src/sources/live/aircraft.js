import {
  admitRecords,
  cleanText,
  coordinates,
  epoch,
  finite,
  LiveSourceError,
} from './contract.js';

function boundedReportedNumber(value, min, max, integer = false) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
    ? value : null;
}

/** Raw receiver quality fields are metadata, not a calibrated motion confidence. */
function readsbAccuracy(row) {
  const silType = cleanText(row.sil_type);
  return {
    nic: boundedReportedNumber(row.nic, 0, 11, true),
    rcM: boundedReportedNumber(row.rc, 0, 1000000),
    nacP: boundedReportedNumber(row.nac_p, 0, 11, true),
    nacV: boundedReportedNumber(row.nac_v, 0, 4, true),
    sil: boundedReportedNumber(row.sil, 0, 3, true),
    silType: ['unknown', 'perhour', 'persample'].includes(silType) ? silType : null,
  };
}

/** Normalize the OpenSky state-vector route, including its regional fallback. */
export function normalizeOpenSkyAircraft(row) {
  if (!Array.isArray(row)) return null;
  const id = cleanText(row[0]).toLowerCase();
  if (!id || !coordinates(row[6], row[5])) return null;
  const positionTimeMs = epoch(row[3], 1000);
  return {
    id,
    reference: id,
    latitude: row[6],
    longitude: row[5],
    callsign: cleanText(row[1]),
    originCountry: cleanText(row[2]),
    positionTimeMs,
    positionTimeQuality: positionTimeMs == null ? 'unknown' : 'reported',
    contactTimeMs: epoch(row[4], 1000),
    baroAltitudeM: finite(row[7]),
    ellipsoidAltitudeM: finite(row[13]),
    onGround: row[8] === true,
    speedMps: finite(row[9]),
    courseDeg: finite(row[10]),
    verticalRateMps: finite(row[11]),
    verticalRateAltitudeType: null,
    accuracy: null,
    category: finite(row[17]),
    typeCode: null,
    registration: null,
    operator: null,
  };
}

/** Only a reported snapshot epoch and explicit position age prove a fix time. */
export function normalizeReadsbAircraft(row, snapshotTimeMs, { observedAtSource = 'unknown' } = {}) {
  const id = cleanText(row?.hex).toLowerCase();
  const latitude = finite(row?.lat),
    longitude = finite(row?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const baroFt = finite(row.alt_baro),
    geoFt = finite(row.alt_geom);
  const speedKts = finite(row.gs),
    baroRateFtMin = finite(row.baro_rate),
    geoRateFtMin = finite(row.geom_rate);
  const geometricRate = geoRateFtMin != null && (geoFt != null || baroRateFtMin == null);
  const rateFtMin = geometricRate ? geoRateFtMin : baroRateFtMin;
  const seen = finite(row.seen),
    seenPos = typeof row.seen_pos === 'number' && Number.isFinite(row.seen_pos) && row.seen_pos >= 0 ? row.seen_pos : null;
  const sourceTimeMs = observedAtSource === 'source' ? epoch(snapshotTimeMs) : null;
  const positionTimeMs = sourceTimeMs == null || seenPos == null ? null : epoch(sourceTimeMs - seenPos * 1000);
  return {
    id,
    reference: id,
    latitude,
    longitude,
    callsign: cleanText(row.flight),
    originCountry: null,
    positionTimeMs,
    positionTimeQuality: positionTimeMs == null ? 'unknown' : 'reported',
    contactTimeMs:
      sourceTimeMs == null || seen == null || seen < 0
        ? null
        : epoch(sourceTimeMs - seen * 1000),
    baroAltitudeM: baroFt == null ? null : baroFt * 0.3048,
    ellipsoidAltitudeM: geoFt == null ? null : geoFt * 0.3048,
    onGround: cleanText(row.alt_baro).toLowerCase() === 'ground',
    speedMps: speedKts == null ? null : speedKts * 0.514444,
    courseDeg: finite(row.track),
    verticalRateMps: rateFtMin == null ? null : rateFtMin * 0.00508,
    verticalRateAltitudeType: rateFtMin == null ? null : geometricRate ? 'geometric' : 'barometric',
    accuracy: readsbAccuracy(row),
    category: row.category ?? null,
    typeCode: cleanText(row.t),
    registration: cleanText(row.r),
    operator: cleanText(row.ownOp),
  };
}

export function openSkySnapshot(
  payload,
  {
    source = 'OpenSky Network',
    coverage = 'worldwide upstream snapshot',
    now = Date.now(),
    stale = false,
  } = {},
) {
  const admitted = admitRecords(
    payload?.states,
    normalizeOpenSkyAircraft,
    'OpenSky',
  );
  const observedAtMs = epoch(payload?.time, 1000);
  const ageMs = observedAtMs == null ? null : Math.max(0, now - observedAtMs);
  return {
    ...admitted,
    source,
    coverage,
    observedAtMs,
    observedAtSource: observedAtMs == null ? 'unknown' : 'source',
    ageMs,
    stale: stale || (ageMs != null && ageMs > 120000),
    freshness:
      observedAtMs == null
        ? 'unknown'
        : stale || ageMs > 120000
          ? 'stale'
          : 'current',
  };
}

export function readsbSnapshot(
  payload,
  {
    observedAtMs: suppliedObservedAtMs,
    observedAtSource: suppliedObservedAtSource = 'unknown',
    source = 'adsb.lol',
    coverage = 'military upstream snapshot',
    now = Date.now(),
    stale = false,
  } = {},
) {
  const observedAtMs = epoch(suppliedObservedAtMs);
  const observedAtSource = observedAtMs != null && ['source', 'receipt'].includes(suppliedObservedAtSource)
    ? suppliedObservedAtSource : 'unknown';
  const admitted = admitRecords(
    payload?.ac,
    (row) => normalizeReadsbAircraft(row, observedAtMs, { observedAtSource }),
    'adsb.lol',
  );
  const ageMs = observedAtMs == null ? null : Math.max(0, now - observedAtMs);
  return {
    ...admitted,
    source,
    coverage,
    observedAtMs,
    observedAtSource,
    ageMs,
    stale,
    freshness: stale ? 'stale' : observedAtSource !== 'source' ? 'unknown' : 'current',
  };
}

const reportedEpoch = (value) => typeof value === 'number' ? epoch(value) : null;
const reportedNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Prepared storage contains observations in SI units, never rebased receipts. */
function normalizePreparedAircraft(row, { sourceQualified = true } = {}) {
  const id = cleanText(row?.id);
  if (!id || id.length > 128 || !coordinates(row.latitude, row.longitude)) return null;
  const positionTimeMs = sourceQualified && row.positionTimeQuality === 'reported' ? reportedEpoch(row.positionTimeMs) : null;
  return {
    id, reference: cleanText(row.reference) || id, latitude: row.latitude, longitude: row.longitude,
    callsign: cleanText(row.callsign).slice(0, 128), originCountry: cleanText(row.originCountry).slice(0, 128) || null,
    positionTimeMs, positionTimeQuality: positionTimeMs == null ? 'unknown' : 'reported',
    contactTimeMs: sourceQualified ? reportedEpoch(row.contactTimeMs) : null,
    baroAltitudeM: reportedNumber(row.baroAltitudeM), ellipsoidAltitudeM: reportedNumber(row.ellipsoidAltitudeM),
    onGround: row.onGround === true, speedMps: reportedNumber(row.speedMps), courseDeg: reportedNumber(row.courseDeg),
    verticalRateMps: reportedNumber(row.verticalRateMps),
    verticalRateAltitudeType: ['geometric', 'barometric'].includes(row.verticalRateAltitudeType) ? row.verticalRateAltitudeType : null,
    accuracy: row.accuracy ? {
      nic: boundedReportedNumber(row.accuracy.nic, 0, 11, true), rcM: boundedReportedNumber(row.accuracy.rcM, 0, 1000000),
      nacP: boundedReportedNumber(row.accuracy.nacP, 0, 11, true), nacV: boundedReportedNumber(row.accuracy.nacV, 0, 4, true),
      sil: boundedReportedNumber(row.accuracy.sil, 0, 3, true),
      silType: ['unknown', 'perhour', 'persample'].includes(row.accuracy.silType) ? row.accuracy.silType : null,
    } : null,
    category: row.category ?? null, typeCode: cleanText(row.typeCode).slice(0, 128),
    registration: cleanText(row.registration).slice(0, 128), operator: cleanText(row.operator).slice(0, 128),
  };
}

/** Validate a bounded genuine history envelope without inventing fix dates. */
export function preparedAircraftSnapshot(payload, { now = Date.now(), stale: deliveryStale = false, cacheAgeMs = null } = {}) {
  const sourceQualified = payload?.observedAtSource === 'source';
  if (payload?.schemaVersion !== 1 || payload.source !== 'adsb.lol' || payload.prepared !== true ||
    payload.delivery !== 'prepared-aircraft-observations' || !['source', 'unknown'].includes(payload.observedAtSource) ||
    (sourceQualified ? reportedEpoch(payload.observedAtMs) == null : payload.observedAtMs !== null) ||
    !Array.isArray(payload.records) || payload.records.length > 2000 || !Array.isArray(payload.history) || payload.history.length > 4000)
    throw new LiveSourceError('malformed', 'Malformed prepared aircraft observations');
  const normalize = (row) => normalizePreparedAircraft(row, { sourceQualified });
  const admitted = admitRecords(payload.records, normalize, 'prepared aircraft');
  const latest = new Map(admitted.records.map((record) => [record.id, record]));
  const history = payload.history.map(normalize).filter((record) => record && record.positionTimeQuality === 'reported' &&
    record.positionTimeMs <= now && latest.get(record.id)?.positionTimeQuality === 'reported' && record.positionTimeMs < latest.get(record.id).positionTimeMs);
  const observedAtMs = payload.observedAtMs, observedAtSource = payload.observedAtSource;
  const knownAge = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const ages = [sourceQualified ? Math.max(0, now - observedAtMs) : null, knownAge(payload.sourceAgeMs), knownAge(cacheAgeMs)].filter((value) => value != null);
  const ageMs = ages.length ? Math.max(...ages) : null;
  const collectedAt = cleanText(payload.collectedAt) || null, collectedAtMs = Date.parse(collectedAt);
  const captureAges = [Number.isFinite(collectedAtMs) ? Math.max(0, now - collectedAtMs) : null, knownAge(payload.captureAgeMs)].filter((value) => value != null);
  const captureAgeMs = captureAges.length ? Math.max(...captureAges) : null;
  const stale = deliveryStale || payload.stale === true || payload.freshness === 'stale' || payload.sourceState?.freshness === 'stale' ||
    payload.sourceState?.cache === 'STALE' || (ageMs != null && ageMs > 120000) || (captureAgeMs != null && captureAgeMs > 120000);
  return {
    ...admitted, complete: false, history, source: 'adsb.lol', prepared: true, delivery: 'prepared-aircraft-observations',
    observedAtMs, observedAtSource, ageMs, sourceAgeMs: ageMs,
    collectedAt, lastCheckedAt: cleanText(payload.lastCheckedAt) || null, retrievedAt: cleanText(payload.retrievedAt) || null,
    captureAgeMs,
    coverage: cleanText(payload.coverage) || 'Prepared observations inside advertised receiver coverage',
    coverageScopes: Array.isArray(payload.coverageScopes) ? payload.coverageScopes.slice(0, 32) : [],
    stale, freshness: stale ? 'stale' : !sourceQualified || payload.freshness === 'unknown' ? 'unknown' : 'current',
  };
}

/** Track altitude remains barometric; renderers choose a visual ground fallback. */
export function normalizeAircraftTrack(
  rows,
  { baseTimeMs = 0, readsb = false } = {},
) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const latitude = finite(row[1]),
      longitude = finite(row[2]);
    const offset = finite(row[0]);
    const observedAtMs =
      offset == null ? null : epoch(baseTimeMs + offset * 1000);
    if (
      !coordinates(latitude, longitude) ||
      observedAtMs == null ||
      observedAtMs <= 0
    )
      return [];
    const altitude = finite(row[3]);
    return [
      {
        latitude,
        longitude,
        observedAtMs,
        baroAltitudeM:
          altitude == null ? null : altitude * (readsb ? 0.3048 : 1),
        ellipsoidAltitudeM: null,
        onGround: readsb
          ? cleanText(row[3]).toLowerCase() === 'ground'
          : row[5] === true,
      },
    ];
  });
}

/** Known source identities are useful for classification even without positions. */
export function readsbIdentities(payload) {
  const admitted = admitRecords(
    payload?.ac,
    (row) => {
      const id = cleanText(row?.hex).toLowerCase();
      return id ? { id } : null;
    },
    'aircraft identities',
  );
  return admitted.records.map((record) => record.id);
}
