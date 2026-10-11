import { GBFS_CITY_REGISTRY } from '../layers/bikeshare/registry.js';

const GBFS_ALLOWED_URLS = new Set(GBFS_CITY_REGISTRY.flatMap((entry) => [
  entry.stationInformationUrl, entry.stationStatusUrl,
]));
const GBFS_ALLOWED_HOSTS = new Set(GBFS_CITY_REGISTRY.flatMap((entry) => entry.hosts));
const GBFS_ALLOWED_PATHS = new Set([...GBFS_ALLOWED_URLS].map((url) => new URL(url).pathname));

/**
 * Check whether a hostname is in the GBFS allowlist.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  return GBFS_ALLOWED_HOSTS.has(host);
}

/**
 * Only allow station_information.json and station_status.json endpoints.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isAllowedGbfsPath(pathname) {
  return GBFS_ALLOWED_PATHS.has(String(pathname || ''));
}

/** Exact URL admission prevents an approved host exposing unreviewed systems. */
export function isAllowedGbfsUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return GBFS_ALLOWED_URLS.has(url.toString());
  } catch {
    return false;
  }
}

/**
 * Return an appropriate Cache-Control header for a GBFS endpoint.
 *
 * station_information is semi-static (5 min cache); station_status is
 * real-time (no-store).
 *
 * @param {string} pathname
 * @returns {string} Cache-Control header value.
 */
export function gbfsCacheControl(pathname) {
  if (/\/station_information\.json$/i.test(String(pathname || ''))) {
    return 'public, max-age=300';
  }
  return 'no-store';
}
