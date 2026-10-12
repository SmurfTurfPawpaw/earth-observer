import { HOME_VIEW, parseViewHash, serializeViewHash, workspaceTime, WorkspaceStateError } from './navigation-state.js';
import { validateArea } from './local-area.js';
export const SESSION_KEY = 'earth-observer:workspace:v2';
export function safeStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function loadSession(storage = safeStorage(), options = {}) {
  try {
    const value = JSON.parse(storage?.getItem(SESSION_KEY) || 'null');
    if (![2, 3].includes(value?.version) || typeof value.view !== 'object' || !value.view) return null;
    let view;
    try { view = parseViewHash(`#${value.version === 3 ? 'v=4&' : ''}${new URLSearchParams(value.view)}`).view; }
    catch (error) { return { ...value, view: { ...HOME_VIEW }, error: error.message, area: validateArea(value.area) }; }
    let temporal; try { if (value.version === 3 && !value.temporal) throw new Error('Saved workspace time is missing.');
      temporal = value.version === 3 ? workspaceTime(value.temporal, options) : { mode: 'live' }; }
    catch (error) { return { ...value, view, error: error.message, area: validateArea(value.area) }; }
    return { ...value, view, temporal, area: validateArea(value.area) };
  } catch { return null; }
}
export function initialWorkspace(hash, session, allowedIds, options = {}) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const shared = ['v', 'lat', 'lon', 'layers', 'mode', 'at', 'lens', 'rate'].some((key) => params.has(key));
  if (shared) {
    const parsed = parseViewHash(hash, allowedIds, options);
    const sameView = session && ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'].every((key) => Math.abs(parsed.view[key] - session.view[key]) < (key === 'alt' ? 2 : key === 'lat' || key === 'lon' ? .00002 : .03));
    return { ...parsed, area: sameView ? session.area : null, requestLocation: false, shared: true };
  }
  if (session?.error) throw new WorkspaceStateError(`Saved workspace could not restore: ${session.error}`);
  if (session) return { view: session.view, area: session.area, temporal: workspaceTime(session.temporal || { mode: 'live' }, options), layers: undefined, requestLocation: false, shared: false };
  return { view: { ...HOME_VIEW }, temporal: { mode: 'live' }, area: null, layers: undefined, requestLocation: true, shared: false };
}
export function saveSession(view, area, storage = safeStorage(), temporal = { mode: 'live' }, options = {}) {
  const selected = workspaceTime(temporal?.mode === 'live' ? { mode: 'live' } : temporal, options);
  const camera = parseViewHash(serializeViewHash(view, [], {}, selected, options), [], options).view;
  try { storage?.setItem(SESSION_KEY, JSON.stringify({ version: 3, view: camera, temporal: selected, area: validateArea(area), updatedAt: Date.now() })); } catch {}
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
