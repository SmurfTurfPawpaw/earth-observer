import { CITY_POIS } from './cities.js';
import { worldTime } from './world-identity.js';

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
export const WORKSPACE_RATES = Object.freeze([1, 60, 3600, 86400]);
export class WorkspaceStateError extends Error {
  constructor(message) { super(message); this.name = 'WorkspaceStateError'; this.code = 'EARTH_WORKSPACE_INVALID'; }
}
export function workspaceTime(value = { mode: 'live' }, { now = Date.now() } = {}) {
  if (value?.mode === 'live') {
    if (value.at != null || value.lens != null || value.rate != null) throw new WorkspaceStateError('Live workspace links cannot freeze a historical time.');
    return { mode: 'live' };
  }
  if (value?.mode !== 'history') throw new WorkspaceStateError('Workspace time must be Live or History.');
  let at; try { at = worldTime(value.at); } catch { /* Report a workspace-specific failure. */ }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at || '') || at !== value.at)
    throw new WorkspaceStateError('History requires an exact UTC date with milliseconds.');
  if (Date.parse(at) > now) throw new WorkspaceStateError('Future History is unavailable. Choose an earlier UTC or Live.');
  if (!['reconstruction', 'known-then'].includes(value.lens)) throw new WorkspaceStateError('History requires Reconstruction or Platform knew then.');
  const rate = value.rate === undefined ? 3600 : value.rate;
  if (!WORKSPACE_RATES.includes(rate)) throw new WorkspaceStateError('History playback speed is unsupported.');
  return { mode: 'history', at, lens: value.lens, rate };
}

/** Accept old camera links; legacy map/effect/layer tokens are intentionally ignored. */
export function parseViewHash(hash, allowedLayerIds = [], options = {}) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (params.getAll('v').length > 1) throw new WorkspaceStateError('Workspace link repeats v.');
  if (params.has('v') && !['1', '2', '3', '4'].includes(params.get('v'))) throw new WorkspaceStateError('Workspace link version is unsupported.');
  const modern = params.get('v') === '4';
  if (modern) for (const key of ['v', ...Object.keys(limits), 'layers', 'params', 'mode', 'at', 'lens', 'rate'])
    if (params.getAll(key).length > 1) throw new WorkspaceStateError(`Workspace link repeats ${key}.`);
  let temporal = { mode: 'live' };
  if (modern) {
    const mode = params.get('mode') || 'live';
    if (mode === 'live') {
      if (['at', 'lens', 'rate'].some(key => params.has(key))) throw new WorkspaceStateError('Live workspace links cannot freeze a historical time.');
    } else {
      const rawRate = params.get('rate');
      if (rawRate !== null && !['1', '60', '3600', '86400'].includes(rawRate)) throw new WorkspaceStateError('History playback speed is unsupported.');
      temporal = workspaceTime({ mode, at: params.get('at'), lens: params.get('lens'), ...(rawRate === null ? {} : { rate: Number(rawRate) }) }, options);
    }
  }
  const view = { ...HOME_VIEW };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const raw = params.get(key);
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (modern && raw !== null && (!Number.isFinite(value) || value < min || value > max)) throw new WorkspaceStateError(`Workspace camera ${key} is invalid.`);
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
  } catch { if (modern) throw new WorkspaceStateError('Workspace layer parameters are malformed.'); }
  if (modern && params.has('params') && !layerParams) throw new WorkspaceStateError('Workspace layer parameters are malformed.');
  return { view, layers, layerParams, temporal };
}

export function serializeViewHash(view, layerIds = [], layerParams = {}, temporal = { mode: 'live' }, options = {}) {
  const selected = workspaceTime(temporal?.mode === 'live' ? { mode: 'live' } : temporal, options);
  const params = new URLSearchParams({ v: '4' });
  for (const key of Object.keys(limits)) {
    let value = Number(view[key]);
    if (key === 'roll' && value > 180 && value <= 360) value -= 360;
    if (!Number.isFinite(value)) continue;
    params.set(key, String(Number(value.toFixed(key === 'lat' || key === 'lon' ? 5 : key === 'alt' ? 0 : 2))));
  }
  params.set('layers', [...new Set(layerIds)].join(','));
  if (Object.keys(layerParams).length) params.set('params', JSON.stringify(layerParams));
  if (selected.mode === 'history') for (const key of ['mode', 'at', 'lens', 'rate']) params.set(key, String(selected[key]));
  return `#${params.toString()}`;
}
