export const LOCAL_DEFAULT_LAYERS = Object.freeze(['flights', 'transit', 'bikeshare', 'cctv', 'earthquakes', 'local-datacenters', 'local-dams']);
export function validateArea(value) {
  if (!value || !Number.isFinite(value.lat) || !Number.isFinite(value.lon) || Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180) return null;
  return { lat: Number(value.lat.toFixed(3)), lon: Number(value.lon.toFixed(3)), radiusKm: [10, 25, 50, 100, 250].includes(value.radiusKm) ? value.radiusKm : 10 };
}
export function distanceKm(lat, lon, area) {
  const radians = Math.PI / 180;
  const deltaLat = (lat - area.lat) * radians, deltaLon = (lon - area.lon) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat * radians) * Math.cos(area.lat * radians) * Math.sin(deltaLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function inLocalArea(lat, lon, area) { return !area || distanceKm(lat, lon, area) <= area.radiusKm; }
export function localCameraView(area) {
  return { lat: area.lat, lon: area.lon, alt: Math.max(25000, area.radiusKm * 2700), heading: 0, pitch: -90, roll: 0 };
}
