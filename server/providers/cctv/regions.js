import { haversineKm } from '../common/geo.js';

// Conservative catalog admission extents, matching the source coordinate checks.
// Intersecting an extent selects a provider; it does not promise camera coverage.
export const CCTV_REGIONS = Object.freeze({
  fintraffic: { south: 59.5, north: 70.5, west: 19, east: 32, prefixes: ['fi-', 'fintraffic-'] },
  nsw: { south: -38, north: -28, west: 140.9, east: 159.2, prefixes: ['nsw-'] },
  calgary: { south: 50.8, north: 51.25, west: -114.4, east: -113.8, prefixes: ['calgary-'] },
  vegvesen: { prefixes: ['no-vegvesen-', 'vegvesen-'], boxes: [
    { south: 57.9, north: 63, west: 4.4, east: 13 },
    { south: 63, north: 67, west: 8, east: 17 },
    { south: 67, north: 69.5, west: 12, east: 24 },
    { south: 69, north: 71.3, west: 17, east: 31.3 },
  ] },
  drivebc: { south: 48, north: 60.5, west: -139.5, east: -114, prefixes: ['drivebc-'] },
  tfl: { south: 51.2, north: 51.8, west: -0.65, east: 0.4, prefixes: ['tfl-'] },
  ontario: { south: 41, north: 57.5, west: -95.6, east: -74, prefixes: ['on-', 'ontario-'] },
});
export const CCTV_AREA_RADII = Object.freeze([10, 25, 50, 100, 250]);

/** Only a complete, rounded, bounded local-area query is accepted. */
export function cctvAreaQuery(params) {
  if (![...params.keys()].length) return { area: null };
  const allowed = ['lat', 'lon', 'radiusKm'];
  if ([...params.keys()].some((key) => !allowed.includes(key))
    || allowed.some((key) => params.getAll(key).length !== 1)) return { error: 'Use lat, lon and radiusKm together' };
  const coordinate = /^-?\d{1,3}(?:\.\d{1,3})?$/;
  const latText = params.get('lat'), lonText = params.get('lon'), radiusText = params.get('radiusKm');
  const lat = Number(latText), lon = Number(lonText), radiusKm = Number(radiusText);
  if (!coordinate.test(latText) || !coordinate.test(lonText) || Math.abs(lat) > 90 || Math.abs(lon) > 180
    || !/^\d{2,3}$/.test(radiusText) || !CCTV_AREA_RADII.includes(radiusKm)) {
    return { error: 'Camera area requires rounded coordinates and an allowed radius' };
  }
  return { area: { lat: lat || 0, lon: lon || 0, radiusKm } };
}

export function cctvPackForId(id) {
  if (typeof id !== 'string' || id.length > 256 || /[\s/\\\x00-\x1f\x7f]/.test(id)) return null;
  return Object.keys(CCTV_REGIONS).find((name) => CCTV_REGIONS[name].prefixes.some((prefix) => id.startsWith(prefix) && id.length > prefix.length)) || null;
}

/** Circle bounding box is conservative, including longitude wrap and polar areas. */
export function cctvRegionIntersects(name, area) {
  if (!area) return true;
  const region = CCTV_REGIONS[name];
  if (!region) return false;
  const angular = area.radiusKm / 6371, radians = Math.PI / 180;
  const deltaLat = angular / radians;
  const deltaLon = Math.abs(area.lat) + deltaLat >= 90 ? 180
    : Math.asin(Math.min(1, Math.sin(angular) / Math.cos(area.lat * radians))) / radians;
  return (region.boxes || [region]).some((box) => {
    if (area.lat + deltaLat < box.south || area.lat - deltaLat > box.north) return false;
    return [-360, 0, 360].some((offset) => area.lon + offset + deltaLon >= box.west && area.lon + offset - deltaLon <= box.east);
  });
}

export function cctvDistance(camera, area) {
  return area ? haversineKm(camera.lat, camera.lon, area.lat, area.lon) : 0;
}
