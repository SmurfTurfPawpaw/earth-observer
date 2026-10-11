import { HOME_VIEW, parseViewHash } from './navigation-state.js';
import { validateArea } from './local-area.js';
export const SESSION_KEY = 'earth-observer:workspace:v2';
export function safeStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function loadSession(storage = safeStorage()) {
  try {
    const value = JSON.parse(storage?.getItem(SESSION_KEY) || 'null');
    if (value?.version !== 2 || typeof value.view !== 'object' || !value.view) return null;
    const view = parseViewHash(`#${new URLSearchParams(value.view)}`).view;
    return { ...value, view, area: validateArea(value.area) };
  } catch { return null; }
}
export function initialWorkspace(hash, session, allowedIds) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const shared = ['lat', 'lon', 'layers'].some((key) => params.has(key));
  if (shared) {
    const parsed = parseViewHash(hash, allowedIds);
    const sameView = session && ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'].every((key) => Math.abs(parsed.view[key] - session.view[key]) < (key === 'alt' ? 2 : key === 'lat' || key === 'lon' ? .00002 : .03));
    return { ...parsed, area: sameView ? session.area : null, requestLocation: false, shared: true };
  }
  if (session) return { view: session.view, area: session.area, layers: undefined, requestLocation: false, shared: false };
  return { view: { ...HOME_VIEW }, area: null, layers: undefined, requestLocation: true, shared: false };
}
export function saveSession(view, area, storage = safeStorage()) {
  try { storage?.setItem(SESSION_KEY, JSON.stringify({ version: 2, view, area: validateArea(area), updatedAt: Date.now() })); } catch {}
}
export function locateVisitor({ geolocation = globalThis.navigator?.geolocation, timeout = 10000 } = {}) {
  if (!geolocation) return Promise.reject(new Error('Location is unavailable. Search for a city or coordinates.'));
  return new Promise((resolve, reject) => geolocation.getCurrentPosition((position) => {
    const area = validateArea({ lat: position.coords.latitude, lon: position.coords.longitude, radiusKm: 10 });
    if (!area) { reject(new Error('The browser returned an invalid location.')); return; }
    resolve({ ...area, accuracyM: position.coords.accuracy });
  }, (error) => reject(new Error(error.code === 1 ? 'Location was not shared. Search for a place, or use the location icon to try again.' : 'Location could not be found. Search for a place or try again.')),
  { enableHighAccuracy: false, maximumAge: 300000, timeout }));
}
