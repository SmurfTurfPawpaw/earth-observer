import { CITY_POIS } from './cities.js';

export const HOME_VIEW = Object.freeze({ lat: 30, lon: 12, alt: 18000000, heading: 0, pitch: -90, roll: 0 });
const ADDED_CITIES = [
  { name: 'Brussels', lat: 50.8503, lon: 4.3517 },
  { name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { name: 'New York', lat: 40.7128, lon: -74.006 },
  { name: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  { name: 'Mexico City', lat: 19.4326, lon: -99.1332 },
  { name: 'São Paulo', lat: -23.5505, lon: -46.6333 },
  { name: 'Cairo', lat: 30.0444, lon: 31.2357 },
  { name: 'Cape Town', lat: -33.9249, lon: 18.4241 },
  { name: 'Delhi', lat: 28.6139, lon: 77.209 },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { name: 'Hong Kong', lat: 22.3193, lon: 114.1694 },
  { name: 'Beijing', lat: 39.9042, lon: 116.4074 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
];
export const PLACES = [
  ...Object.values(CITY_POIS).flatMap((city) => [
    { name: city.name, lat: city.pois[0].lat, lon: city.pois[0].lon },
    ...city.pois.map((poi) => ({ name: `${poi.name}, ${city.name}`, lat: poi.lat, lon: poi.lon })),
  ]),
  ...ADDED_CITIES,
];
const normalize = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** Offline search avoids third-party geocoder limits and leaked search queries. */
export function resolvePlace(query) {
  const raw = String(query || '').trim();
  const coordinates = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*[,;]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (coordinates) {
    const lat = Number(coordinates[1]);
    const lon = Number(coordinates[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
  }
  const key = normalize(raw);
  if (key.length < 2) return null;
  const exact = PLACES.find((place) => normalize(place.name) === key);
  if (exact) return exact;
  const matches = PLACES.filter((place) => normalize(place.name).startsWith(key));
  return matches.length === 1 ? matches[0] : null;
}

const limits = { lat: [-90, 90], lon: [-180, 180], alt: [250, 50000000], heading: [0, 360], pitch: [-90, 0], roll: [-180, 180] };

/** Accept old camera links; legacy map/effect/layer tokens are intentionally ignored. */
export function parseViewHash(hash, allowedLayerIds = []) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const view = { ...HOME_VIEW };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const raw = params.get(key);
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(value) && value >= min && value <= max) view[key] = value;
  }
  const layerValue = params.get('layers');
  const allowed = new Set(allowedLayerIds);
  const layers = layerValue === null ? undefined : [...new Set(layerValue.split(',').filter((id) => allowed.has(id)))];
  let layerParams;
  try {
    const parsed = JSON.parse(params.get('params') || 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      layerParams = Object.fromEntries(Object.entries(parsed).filter(([id, value]) => allowed.has(id) && value && typeof value === 'object' && !Array.isArray(value)));
    }
  } catch { /* Invalid optional parameters leave the defaults intact. */ }
  return { view, layers, layerParams };
}

export function serializeViewHash(view, layerIds = [], layerParams = {}) {
  const params = new URLSearchParams({ v: '3' });
  for (const key of Object.keys(limits)) {
    const value = Number(view[key]);
    if (!Number.isFinite(value)) continue;
    params.set(key, String(Number(value.toFixed(key === 'lat' || key === 'lon' ? 5 : key === 'alt' ? 0 : 2))));
  }
  params.set('layers', [...new Set(layerIds)].join(','));
  if (Object.keys(layerParams).length) params.set('params', JSON.stringify(layerParams));
  return `#${params.toString()}`;
}
