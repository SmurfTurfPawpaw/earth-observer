/** Reviewed public camera catalogs; only still images are registered. */
import {
  TFL_JAMCAM_URL, TFL_IMAGE_ORIGIN, DEFAULT_TFL_MAX_SOURCES, LONDON_CENTER,
  ONTARIO_511_CAMERAS_URL, ONTARIO_511_IMAGE_ORIGIN, DEFAULT_ONTARIO_MAX_SOURCES, ONTARIO_ANCHORS,
  FINTRAFFIC_STATIONS_URL, FINTRAFFIC_IMAGE_ORIGIN, FINTRAFFIC_GROUND_ELEVATION_M,
  DIGITRAFFIC_USER, DEFAULT_FINTRAFFIC_MAX_SOURCES, FINLAND_ANCHORS,
  DRIVEBC_WEBCAMS_URL, DRIVEBC_IMAGE_URL, DEFAULT_DRIVEBC_MAX_SOURCES, DRIVEBC_ANCHORS,
  NSW_CAMERAS_URL, NSW_IMAGE_ORIGIN, DEFAULT_NSW_MAX_SOURCES, SYDNEY_CENTER, NSW_MAX_VIEW_LABEL,
  DEFAULT_CALGARY_ROWS_URL, CALGARY_IMAGE_ORIGIN, DEFAULT_CALGARY_MAX_SOURCES, CALGARY_DOWNTOWN,
  CALGARY_MAX_CATALOG_BYTES, CCTV_SOURCE_FETCH_TIMEOUT_MS,
  DEFAULT_VEGVESEN_CCTV_URL, VEGVESEN_IMAGE_ORIGIN, DEFAULT_VEGVESEN_MAX_SOURCES,
  VEGVESEN_MAX_CATALOG_BYTES, NORWAY_ANCHORS,
} from './constants.js';
import {
  toFiniteNumber, fallbackHeadingFromId, isLikelyFinlandCoordinate, fintrafficCameraName,
  hashSeed, isPlausibleLatLon, isLikelyBcCoordinate, isLikelyNswCoordinate,
  isLikelyCalgaryCoordinate, isLikelyNorwayCoordinate, cameraDisplayCode, prioritizeSources,
} from './normalize.js';
import { directionToHeading } from '../../../src/data/directionText.js';
import { readResponseJsonCapped } from '../common/http.js';

export async function loadTflSourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  const appKey = String(env.TFL_APP_KEY || '').trim();
  if (!appKey || env.CCTV_TFL_TERMS_ACCEPTED !== '1') return [];
  try {
    const url = `${TFL_JAMCAM_URL}?app_key=${encodeURIComponent(appKey)}`;
    const resp = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] TfL JamCam download failed:', resp.status);
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    const places = await readResponseJsonCapped(resp, 8 * 1024 * 1024);
    if (!Array.isArray(places)) return [];

    const cameras = [];
    for (const place of places) {
      const props = {};
      for (const p of place?.additionalProperties || []) {
        if (p?.key) props[p.key] = p.value;
      }
      if (String(props.available).toLowerCase() !== 'true') continue;
      const lat = toFiniteNumber(place?.lat);
      const lon = toFiniteNumber(place?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(props.imageUrl || '');
      if (!imageUrl.startsWith(TFL_IMAGE_ORIGIN)) continue; // official-bucket pin

      // "JamCams_00002.00865" → "tfl-00002.00865" (provider-stable id).
      const rawId = String(place?.id || '').replace(/^JamCams_/, '');
      if (!rawId) continue;
      const cameraId = `tfl-${rawId}`;

      cameras.push({
        id: cameraId,
        name: String(place?.commonName || `JamCam ${rawId}`),
        city: 'London',
        cityId: 'london',
        provider: 'Transport for London',
        lat,
        lon,
        // No heading signal at all in JamCam data → id-hash fallback, low
        // confidence personality (same as headingless Austin cameras).
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 15, // Thames-basin prior; one-shot snap corrects.
        feedType: 'image', // stills-first (owner decision); props.videoUrl deliberately unused
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'tfl-open-data',
        license: 'Powered by TfL Open Data',
        credit: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016. ' +
          'Geomni UK Map data © and database rights [2019]. ' +
          'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',
      });
    }

    const maxRaw = Number(
      env.CCTV_TFL_MAX_SOURCES || DEFAULT_TFL_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(600, Math.floor(maxRaw)))
      : DEFAULT_TFL_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [LONDON_CENTER], { retainAll });
    console.log(
      `[CCTV] Loaded TfL JamCam sources: ${cameras.length} available (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] TfL JamCam download error:', error?.message || error);
    return [];
  }
}

/**
 * Bounding-box sanity check for Ontario 511 rows.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
function isLikelyOntarioCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 41.0 && lat <= 57.5 && lon >= -95.6 && lon <= -74.0;
}

/**
 * Pin an Ontario 511 camera view URL to the official still-image host.
 *
 * @param {string} value - Upstream view URL.
 * @returns {string} Canonical 511on.ca still URL, or '' if not accepted.
 */
function normalizeOntarioCctvUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const match = /^\/map\/Cctv\/([^/?#]+)$/.exec(parsed.pathname);
    if (!match) return '';
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      (host !== '511on.ca' && !host.endsWith('.traveliq.co'))
    ) {
      return '';
    }
    const viewId = decodeURIComponent(match[1]);
    if (!/^[A-Za-z0-9_.-]+$/.test(viewId)) return '';
    return `${ONTARIO_511_IMAGE_ORIGIN}${encodeURIComponent(viewId)}`;
  } catch {
    return '';
  }
}

/**
 * Select the best Ontario 511 still view for a camera.
 *
 * @param {Array<object>} views
 * @returns {{url:string,description:string}|null}
 */
function pickOntarioCctvView(views) {
  const enabled = (Array.isArray(views) ? views : [])
    .filter(
      (view) =>
        String(view?.Status || view?.status || '')
          .trim()
          .toLowerCase() === 'enabled',
    )
    .map((view) => ({
      url: normalizeOntarioCctvUrl(view?.Url || view?.url),
      description: String(view?.Description || view?.description || '').trim(),
    }))
    .filter((view) => view.url);
  if (!enabled.length) return null;
  return (
    enabled.find((view) => !/\bdown\b/i.test(view.description)) || enabled[0]
  );
}

/**
 * Fetch Ontario 511 CCTV cameras with the deployer's registered API key.
 * The current developer agreement requires a key, while frames are under
 * 511on.ca/map/Cctv/. Only rows with finite Ontario coords and at least one
 * enabled official still view are kept.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadOntarioSourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  const apiKey = String(env.ONTARIO_511_API_KEY || '').trim();
  if (!apiKey || env.CCTV_ONTARIO_TERMS_ACCEPTED !== '1') return [];
  try {
    const endpoint = new URL(ONTARIO_511_CAMERAS_URL);
    endpoint.searchParams.set('key', apiKey);
    const resp = await fetchImpl(endpoint.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Ontario 511 camera download failed:', resp.status);
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    const rows = await readResponseJsonCapped(resp, 8 * 1024 * 1024);
    if (!Array.isArray(rows)) return [];

    const cameras = [];
    for (const row of rows) {
      const rawId = String(row?.Id ?? row?.id ?? '').trim();
      if (!rawId) continue;
      const lat = toFiniteNumber(row?.Latitude ?? row?.latitude);
      const lon = toFiniteNumber(row?.Longitude ?? row?.longitude);
      if (!isLikelyOntarioCoordinate(lat, lon)) continue;

      const view = pickOntarioCctvView(row?.Views || row?.views);
      if (!view) continue;

      const cameraId = `on-${rawId}`;
      const location = String(row?.Location || row?.location || '').trim();
      const roadway = String(row?.Roadway || row?.roadway || '').trim();
      const viewLabel =
        view.description && !/\bdown\b/i.test(view.description)
          ? view.description
          : '';
      const label = [
        location || roadway || `Ontario 511 Camera ${rawId}`,
        viewLabel,
      ]
        .filter(Boolean)
        .join(' - ');
      let heading = directionToHeading(row?.Direction ?? row?.direction, true);
      if (!Number.isFinite(heading)) {
        heading = directionToHeading(view.description, true);
      }
      const hasHeading = Number.isFinite(heading);

      cameras.push({
        id: cameraId,
        name: label,
        city: location || roadway || 'Ontario',
        cityId: 'ontario',
        provider: 'Ontario 511',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 200,
        feedType: 'image',
        url: view.url,
        snapshotUrl: view.url,
        sourceKind: 'ontario-511-open-data',
        license: 'Open Government Licence - Ontario',
      });
    }

    const unique = Array.from(
      new Map(cameras.map((camera) => [camera.id, camera])).values(),
    );
    const maxRaw = Number(
      env.CCTV_ONTARIO_MAX_SOURCES || DEFAULT_ONTARIO_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
      : DEFAULT_ONTARIO_MAX_SOURCES;
    const prioritized = prioritizeSources(unique, maxCount, ONTARIO_ANCHORS, { retainAll });
    console.log(
      `[CCTV] Loaded Ontario 511 camera sources: ${unique.length} enabled (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Ontario 511 camera download error:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * Fetch Fintraffic road weather cameras (all of Finland) from Digitraffic.
 * Keyless; one GeoJSON station list per refresh (~37 KB gzipped, 809 stations
 * / 2,275 presets), identifying itself with the `Digitraffic-User` header the
 * service asks for. One PRESET — one fixed view of a station — is one camera
 * here; the presets of a station share its position, and the id-hash fallback
 * heading fans their gizmos apart instead of stacking them on one bearing.
 *
 * Skips stations whose `collectionStatus` is anything but GATHERING and presets
 * with `inCollection: false`, so the mesh carries no dead cameras. Frame URLs
 * are BUILT from the official image origin and a strictly-validated preset id
 * rather than read from the payload, which pins the frame proxy to
 * weathercam.digitraffic.fi by construction; the catalog fetch refuses
 * redirects (`redirect: 'manual'`) so the list host cannot be steered either.
 *
 * No compass heading exists anywhere in this dataset: the per-preset
 * `direction` on the detail endpoint is road-register relative
 * (INCREASING_DIRECTION = "towards higher road addresses"), not a bearing, and
 * converting it would need road geometry this app does not load. Every preset
 * therefore takes the id-hash fallback and the low-confidence pose personality,
 * the same as headingless Austin and TfL cameras.
 *
 * Attribution: "Fintraffic / digitraffic.fi" (CC BY 4.0), registered in
 * src/data/dataCredits.js.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadFintrafficSourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  try {
    const resp = await fetchImpl(FINTRAFFIC_STATIONS_URL, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'Digitraffic-User': DIGITRAFFIC_USER,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Fintraffic station list redirected; redirects are not followed',
      );
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    if (!resp.ok) {
      console.warn('[CCTV] Fintraffic station download failed:', resp.status);
      return [];
    }
    const payload = await readResponseJsonCapped(resp, 8 * 1024 * 1024);
    if (!Array.isArray(payload?.features)) return [];
    const features = payload.features;

    const cameras = [];
    let stationsSeen = 0;
    for (const feature of features) {
      const props = feature?.properties || {};
      const stationId = String(props.id || '').trim();
      if (!stationId) continue;
      // GATHERING is the only status that means "this station is collecting
      // images right now"; REMOVED_TEMPORARILY and friends would render as
      // permanent Street View / synthetic fallbacks.
      if (String(props.collectionStatus || '').toUpperCase() !== 'GATHERING')
        continue;

      const coords = feature?.geometry?.coordinates;
      const lon = toFiniteNumber(coords?.[0]);
      const lat = toFiniteNumber(coords?.[1]);
      if (!isLikelyFinlandCoordinate(lat, lon)) continue;
      // Third coordinate is metres, but 0 means "not reported" rather than sea
      // level, so only a positive value is a real reading. Prior only: the
      // client's one-shot ground snap corrects it on 3D-tile stacks, and on a
      // no-tileset stack this height is what freezes in.
      const reportedElevation = toFiniteNumber(coords?.[2], 0);
      const groundElevationM =
        reportedElevation > 0
          ? Math.min(1400, reportedElevation)
          : FINTRAFFIC_GROUND_ELEVATION_M;

      stationsSeen += 1;
      for (const preset of props.presets || []) {
        if (preset?.inCollection !== true) continue;
        const presetId = String(preset?.id || '').trim();
        // Strict id shape (station id + two-digit view). Also the guard that
        // keeps a hostile id out of the synthesized frame URL's path.
        if (!/^C\d{7}$/.test(presetId)) continue;
        if (!presetId.startsWith(stationId)) continue;

        const cameraId = `fi-${presetId.toLowerCase()}`;
        const imageUrl = `${FINTRAFFIC_IMAGE_ORIGIN}${presetId}.jpg`;
        cameras.push({
          id: cameraId,
          name: fintrafficCameraName(props.name, stationId, presetId),
          city: 'Finland',
          cityId: 'finland',
          provider: 'Fintraffic',
          lat,
          lon,
          // Headingless personality (see JSDoc), identical to TfL's.
          headingDeg: fallbackHeadingFromId(cameraId),
          headingConfidence: 'low',
          pitchDeg: -18,
          fovDeg: 44,
          rangeM: 145,
          mountHeightM: 8,
          groundElevationM,
          feedType: 'image',
          url: imageUrl,
          snapshotUrl: imageUrl,
          sourceKind: 'fintraffic-open-data',
          license: 'Fintraffic / digitraffic.fi (CC BY 4.0)',
        });
      }
    }

    const maxRaw = Number(
      env.CCTV_FINTRAFFIC_MAX_SOURCES || DEFAULT_FINTRAFFIC_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(600, Math.floor(maxRaw)))
      : DEFAULT_FINTRAFFIC_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, FINLAND_ANCHORS, { retainAll });
    console.log(
      `[CCTV] Loaded Fintraffic camera sources: ${cameras.length} live presets across ${stationsSeen} stations (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Fintraffic station download error:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * The DriveBC `credit` field mixes third-party image attribution ("Images
 * courtesy of TransLink") with operational notes ("relies on solar power").
 * Only the attribution kind is carried onto the camera, HTML stripped, so a
 * partner-owned feed names its owner in the panel; everything else is dropped.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function driveBcImageCredit(raw) {
  const text = String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return /courtesy|provided by|presented in cooperation|city of|parks canada/i.test(
    text,
  )
    ? text
    : '';
}

/** DriveBC orientation codes (the eight compass points) as headings in degrees. */
const DRIVEBC_ORIENTATION_HEADINGS = Object.freeze({
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
});

/**
 * Fetch DriveBC highway cameras (British Columbia). Keyless: one list endpoint
 * served by the DriveBC.ca site. Only cameras that are switched on and published
 * (`is_on` and `should_appear`) with a positive integer id and finite coordinates
 * are kept. Frame URLs are built from that id on the official image host and are
 * never read from the payload. Orientation codes give a high-confidence heading;
 * `elevation` is metres above sea level. Attribution: Open Government Licence –
 * British Columbia (registered in src/data/dataCredits.js).
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadDriveBcSourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  // The public feed includes partner-owned images. A missing credit does not
  // prove ministry ownership, so only explicitly reviewed camera IDs qualify.
  const approvedIds = new Set(
    String(env.CCTV_DRIVEBC_APPROVED_IDS || '').split(',')
      .map((id) => id.trim()).filter((id) => /^[1-9]\d*$/.test(id)),
  );
  if (!approvedIds.size || env.CCTV_DRIVEBC_TERMS_ACCEPTED !== '1') return [];
  try {
    const resp = await fetchImpl(DRIVEBC_WEBCAMS_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] DriveBC camera download failed:', resp.status);
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    const rows = await readResponseJsonCapped(resp, 8 * 1024 * 1024);
    if (!Array.isArray(rows)) return [];

    const cameras = [];
    for (const row of rows) {
      if (row?.is_on !== true || row?.should_appear !== true) continue;
      if (!Number.isSafeInteger(row.id) || row.id <= 0) continue;
      if (!approvedIds.has(String(row.id))) continue;
      // GeoJSON point order: [longitude, latitude].
      const [lon, lat] = Array.isArray(row.location?.coordinates)
        ? row.location.coordinates
        : [];
      if (!isLikelyBcCoordinate(lat, lon)) continue;

      const cameraId = `drivebc-${row.id}`;
      const heading =
        DRIVEBC_ORIENTATION_HEADINGS[
          String(row.orientation || '')
            .trim()
            .toUpperCase()
        ];
      const hasHeading = Number.isFinite(heading);
      const region = String(row.region_name || '').trim();
      const imageUrl = DRIVEBC_IMAGE_URL(row.id);
      const credit = driveBcImageCredit(row.credit);
      cameras.push({
        id: cameraId,
        name: String(row.name || '').trim() || `DriveBC camera ${row.id}`,
        // DriveBC regions: Lower Mainland, Vancouver Island, Southern Interior,
        // Northern, and "Border Cams" for the US crossings.
        city:
          region === 'Border Cams' ? 'BC Border' : region || 'British Columbia',
        cityId: 'british-columbia',
        provider: 'DriveBC',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        // Same two pose personalities as the other packs: raw priors that the
        // client's ground snap and manual calibration refine.
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        // Clamped like Caltrans so a garbage value can't fling a camera
        // kilometres up; sea level is the prior for the coastal default anchors.
        groundElevationM: Number.isFinite(row.elevation)
          ? Math.max(-100, Math.min(4000, row.elevation))
          : 0,
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'drivebc-open-data',
        license: 'DriveBC, Open Government Licence – British Columbia',
        credit,
      });
    }

    const maxRaw = Number(
      env.CCTV_DRIVEBC_MAX_SOURCES || DEFAULT_DRIVEBC_MAX_SOURCES,
    );
    // Up to the catalog ceiling, so a BC-only setup can load the whole province.
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1200, Math.floor(maxRaw)))
      : DEFAULT_DRIVEBC_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, DRIVEBC_ANCHORS, { retainAll });
    console.log(
      `[CCTV] Loaded DriveBC camera sources: ${cameras.length} published (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] DriveBC camera download error:',
      error?.message || error,
    );
    return [];
  }
}

export function nswCameraLabel(props) {
  const view = String(props?.view || '').trim();
  const title = String(props?.title || '').trim();
  const viewIsALabel =
    view.length > 0 &&
    view.length <= NSW_MAX_VIEW_LABEL &&
    !/[\r\n]/.test(view);
  return viewIsALabel ? view : title;
}

/**
 * One Live Traffic NSW camera feature -> one catalog source, or null. Every
 * camera carries a compass `direction` ("N-E") and a `view` sentence.
 *
 * @param {object} feature - GeoJSON feature from the traffic-cam feed.
 * @returns {?object}
 */
export function nswCameraToSource(feature) {
  const rawId = String(feature?.id || '').trim();
  if (!rawId) return null;
  const coords = feature?.geometry?.coordinates;
  // Numbers only: Number(null) and Number('') are 0, which would park a
  // camera on the equator.
  const lon = typeof coords?.[0] === 'number' ? coords[0] : NaN;
  const lat = typeof coords?.[1] === 'number' ? coords[1] : NaN;
  if (!isLikelyNswCoordinate(lat, lon)) return null;
  const props = feature?.properties || {};
  const url = String(props.href || '').trim();
  if (!url.startsWith(NSW_IMAGE_ORIGIN)) return null;
  // "N-E" -> "NE" for the compass lookup.
  const direction = String(props.direction || '')
    .trim()
    .toUpperCase()
    .replace(/-/g, '');
  const heading = directionToHeading(direction, true);
  const hasHeading = Number.isFinite(heading);
  const cameraId = `nsw-${rawId}`;
  return {
    id: cameraId,
    name: nswCameraLabel(props) || `NSW ${rawId}`,
    city: String(props.region || 'New South Wales').replace(/_/g, ' '),
    cityId: 'nsw',
    provider: 'Live Traffic NSW',
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    pitchDeg: hasHeading ? -24 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 210 : 145,
    mountHeightM: hasHeading ? 10 : 8,
    groundElevationM: 25, // Sydney basin prior; the client's ground snap corrects.
    feedType: 'image',
    url,
    snapshotUrl: url,
    sourceKind: 'nsw-livetraffic',
    license: 'Live Traffic NSW — Transport for NSW, CC BY 4.0',
    code: cameraDisplayCode(String(props.title || '').toUpperCase() || rawId),
  };
}

/**
 * Fetch Live Traffic NSW cameras (New South Wales), keyless: the public
 * traffic-cam GeoJSON feed. Frames are stills on webcams.transport.nsw.gov.au.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadNswSourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  try {
    const resp = await fetchImpl(NSW_CAMERAS_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'earth-observer-cctv/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] NSW camera download failed:', resp.status);
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    const body = await readResponseJsonCapped(resp, 8 * 1024 * 1024);
    if (!Array.isArray(body?.features)) return [];
    const features = body.features;
    const cameras = features.map(nswCameraToSource).filter(Boolean);
    const maxRaw = Number(
      env.CCTV_NSW_MAX_SOURCES || DEFAULT_NSW_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(900, Math.floor(maxRaw)))
      : DEFAULT_NSW_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [SYDNEY_CENTER], { retainAll });
    console.log(
      `[CCTV] Loaded NSW camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] NSW camera download error:', error?.message || error);
    return [];
  }
}

/**
 * Upgrade a catalog frame URL to HTTPS and pin it to the City of Calgary host.
 *
 * Most rows ship `http://`; the host answers HTTPS and 301-redirects there, so
 * upgrading avoids a redirect on every frame fetch. Anything not on the
 * official origin is refused rather than proxied, the same pin the TfL and
 * Tarktee packs apply.
 *
 * @param {string|null|undefined} raw - `camera_url.url` from the dataset.
 * @returns {?string} Pinned HTTPS URL, or null when unusable.
 */
export function normalizeCalgaryImageUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.protocol = 'https:';
  const upgraded = parsed.toString();
  return upgraded.startsWith(CALGARY_IMAGE_ORIGIN) ? upgraded : null;
}

/**
 * Stable camera id from a frame URL.
 *
 * The dataset carries no id column; the frame filename ("loc86.jpg") is the
 * only stable per-camera token and is what the city keys on. Falls back to a
 * slug of the whole path so a filename-scheme change degrades to a still-stable
 * id rather than dropping the camera.
 *
 * @param {string} imageUrl - A normalized Calgary frame URL.
 * @returns {?string} Provider-stable id, or null when underivable.
 */
export function calgaryCameraId(imageUrl) {
  const text = String(imageUrl ?? '').trim();
  if (!text) return null;
  let path;
  try {
    path = new URL(text).pathname;
  } catch {
    return null;
  }
  const numbered = path.match(/loc(\d+)\.jpg$/i);
  if (numbered) return `calgary-${numbered[1]}`;
  const slug = path
    .replace(/^\/+|\.[a-z0-9]+$/gi, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
  return slug ? `calgary-${slug}` : null;
}

/**
 * Label for one Calgary camera: the intersection an operator recognises
 * ("Bow Trail / 37 Street SW"), used verbatim including its quadrant suffix,
 * which is part of the street address. It must never be read as a facing.
 *
 * @param {object} record - Raw Socrata row.
 * @param {string} cameraId - Derived stable id.
 * @returns {string}
 */
export function calgaryCameraName(record, cameraId) {
  const location = String(record?.camera_location ?? '').trim();
  if (location) return location;
  const described = String(record?.camera_url?.description ?? '').trim();
  if (described) return described;
  return `Calgary Camera ${String(cameraId).replace(/^calgary-/, '')}`;
}

/**
 * One Open Calgary row -> one catalog source, or null.
 *
 * NO HEADING IS DERIVED FROM THE RECORD, and the fields that look like one are
 * not. Every row carries a `quadrant` ("NE"/"NW"/"SE"/"SW", and combinations
 * like "NW/NE") and a `camera_location` ending in the same token ("9 Avenue /
 * 3 Street SE"). That is Calgary's address grid — the quarter of the city the
 * intersection sits in — not a camera bearing. Handing either to
 * directionToHeading() returns a confident compass bearing for every row and
 * every one would be wrong. Headings therefore use the shared id-hash fallback
 * at low confidence, exactly as headingless TfL and Fintraffic cameras do, and
 * the operator corrects them with the calibration gizmo.
 *
 * @param {object} record - Raw Socrata row.
 * @returns {?object}
 */
export function calgaryCameraToSource(record) {
  if (!record || typeof record !== 'object') return null;
  const coordinates = record?.point?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = toFiniteNumber(coordinates[0]);
  const lat = toFiniteNumber(coordinates[1]);
  if (!isLikelyCalgaryCoordinate(lat, lon)) return null;

  const imageUrl = normalizeCalgaryImageUrl(record?.camera_url?.url);
  if (!imageUrl) return null;
  const cameraId = calgaryCameraId(imageUrl);
  if (!cameraId) return null;
  const name = calgaryCameraName(record, cameraId);

  return {
    id: cameraId,
    name,
    city: 'Calgary',
    cityId: 'calgary',
    provider: 'The City of Calgary',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    // Calgary sits high on the prairie; the client's one-shot ground snap
    // corrects this prior wherever 3D tiles are loaded.
    groundElevationM: 1045,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'calgary-open-data',
    license:
      'Contains information licensed under the Open Government Licence – City of Calgary',
    // Unselected-label code: the intersection, so a camera at rest reads as a
    // place rather than as its id.
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

/**
 * Fetch City of Calgary traffic cameras from Open Calgary (Socrata dataset
 * `k7p9-kppz`), keyless. Frames are stills on trafficcam.calgary.ca.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadCalgarySourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  try {
    const endpoint = DEFAULT_CALGARY_ROWS_URL;
    const resp = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    // A response this loader will not read still owns its transport until the
    // body is released, so every rejection path cancels before returning.
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Calgary catalog redirected; redirects are not followed',
      );
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Calgary camera download failed:', resp.status);
      return discard();
    }
    const rows = await readResponseJsonCapped(resp, CALGARY_MAX_CATALOG_BYTES);
    if (!Array.isArray(rows)) return [];
    const cameras = [];
    const seen = new Set();
    for (const record of rows) {
      const camera = calgaryCameraToSource(record);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      env.CCTV_CALGARY_MAX_SOURCES || DEFAULT_CALGARY_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(400, Math.floor(maxRaw)))
      : DEFAULT_CALGARY_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [
      CALGARY_DOWNTOWN,
    ], { retainAll });
    console.log(
      `[CCTV] Loaded Calgary camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Calgary camera download error:',
      error?.message || error,
    );
    return [];
  }
}

export function vegvesenCameraToSource(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const props = feature.properties;
  if (!props || typeof props !== 'object') return null;
  const availability = String(
    props['status.stillImageAvailability'] ?? '',
  ).trim();
  if (availability && availability !== 'videoOrImagesAvailable') return null;

  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = toFiniteNumber(coordinates[0]);
  const lat = toFiniteNumber(coordinates[1]);
  if (!isLikelyNorwayCoordinate(lat, lon)) return null;

  const rawId = String(props.cameraId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(rawId)) return null;
  let image;
  try {
    image = new URL(String(props.stillImageUrl ?? ''));
  } catch {
    return null;
  }
  if (image.username || image.password) return null;
  const imageUrl = image.href;
  if (imageUrl !== `${VEGVESEN_IMAGE_ORIGIN}${rawId}`) return null;

  const cameraId = `no-vegvesen-${rawId.toLowerCase()}`;
  const place = String(props.description ?? '').trim() || `Kamera ${rawId}`;
  const towards = String(props.orientationDescription ?? '').trim();
  const road = String(props.roadNumber ?? '').trim();
  const name = towards && towards !== place ? `${place} → ${towards}` : place;
  return {
    id: cameraId,
    name: road ? `${road} ${name}` : name,
    // One country-wide category in the camera picker, like Finland; the
    // place itself is already in the name.
    city: 'Norway',
    cityId: 'norway',
    provider: 'Statens vegvesen',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    // KNOWN LIMITATION: the feed's coordinates are 2D, so this is one flat
    // prior for the whole country, while cameras run from sea level to
    // mountain passes near 1,000 m (Haukelifjell, Sjonfjellet, Rugeldalen).
    // The point-height prior and the client's one-shot ground snap correct it
    // where they resolve; on a stack where neither does (no 3D tiles), a pass
    // camera stays hundreds of metres below the terrain, the same risk the
    // Caltrans pack documents. A per-camera height (e.g. Kartverket's keyless
    // point-height API) would remove it.
    groundElevationM: 150,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'vegvesen-datex',
    license:
      'Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Statens vegvesen',
    code: cameraDisplayCode(place.toUpperCase()),
  };
}

/**
 * Fetch Statens vegvesen (Norway) road cameras from the keyless OGC API
 * Features view of the DATEX 3.1 CCTV table. Frames are stills on
 * kamera.atlas.vegvesen.no.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadVegvesenSourcesFromOpenData({ env = globalThis.process?.env || {}, fetchImpl = fetch, retainAll = false } = {}) {
  try {
    const endpoint = DEFAULT_VEGVESEN_CCTV_URL;
    const resp = await fetchImpl(endpoint, {
      headers: { Accept: 'application/geo+json,application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Vegvesen catalog redirected; redirects are not followed',
      );
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Vegvesen camera download failed:', resp.status);
      return discard();
    }
    const payload = await readResponseJsonCapped(
      resp,
      VEGVESEN_MAX_CATALOG_BYTES,
    );
    if (!Array.isArray(payload?.features)) return [];
    const features = payload.features;
    const cameras = [];
    const seen = new Set();
    for (const feature of features) {
      const camera = vegvesenCameraToSource(feature);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      env.CCTV_VEGVESEN_MAX_SOURCES || DEFAULT_VEGVESEN_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
      : DEFAULT_VEGVESEN_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, NORWAY_ANCHORS, { retainAll });
    console.log(
      `[CCTV] Loaded Vegvesen camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Vegvesen camera download error:',
      error?.message || error,
    );
    return [];
  }
}
