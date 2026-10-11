export const PLACES_STORAGE_KEY = 'earth-observer:places:v1';
export const MAX_SAVED_PLACES = 50;
const limits = { lat: [-90, 90], lon: [-180, 180], alt: [250, 50000000], heading: [0, 360], pitch: [-90, 0], roll: [-180, 180] };
const copy = (place) => ({ ...place, view: { ...place.view } });

/** Match the shared camera contract; invalid saved values never become a fallback destination. */
export function validatePlaceView(value) {
  if (!value || typeof value !== 'object') return null;
  const view = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min - 1e-8 || number > max + 1e-8) return null;
    view[key] = Math.min(max, Math.max(min, number));
  }
  return view;
}
const normalizeName = (value) => String(value || '').trim().slice(0, 80);
function load(storage) {
  let raw;
  try { raw = storage?.getItem(PLACES_STORAGE_KEY); } catch { return { places: [], reason: 'Saved places are unavailable in this browser.' }; }
  if (!raw) return { places: [], reason: null };
  let saved;
  try { saved = JSON.parse(raw); } catch { return { places: [], reason: 'Saved place data could not be read. It has been preserved.' }; }
  if (saved?.version !== 1 || !Array.isArray(saved.places)) return { places: [], reason: 'Saved place data uses an unsupported format. It has been preserved.' };
  const ids = new Set();
  const places = saved.places.slice(0, MAX_SAVED_PLACES).flatMap((item) => {
    const view = validatePlaceView(item?.view), name = normalizeName(item?.name);
    if (!view || !name || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) return [];
    ids.add(item.id);
    return [{ id: item.id, name, view, createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0 }];
  });
  return { places, reason: null };
}

/** Bounded local-only storage. A failed write never reports a durable save or mutates the current list. */
export function createPlaceStore(storage, { now = Date.now, createId = () => globalThis.crypto?.randomUUID?.() || `place-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` } = {}) {
  const saved = load(storage); let places = saved.places;
  const persist = (next) => {
    if (saved.reason) throw new Error(saved.reason);
    if (!storage?.setItem) throw new Error('This browser cannot save places. Copy a view link instead.');
    try { storage.setItem(PLACES_STORAGE_KEY, JSON.stringify({ version: 1, places: next })); }
    catch { throw new Error('The place could not be saved in this browser. Copy a view link instead.'); }
    places = next;
  };
  return {
    list: () => places.map(copy),
    get: (id) => { const item = places.find((place) => place.id === id); return item ? copy(item) : null; },
    getError: () => saved.reason,
    save(nameValue, viewValue, id) {
      const name = normalizeName(nameValue), view = validatePlaceView(viewValue);
      if (!name) throw new Error('Give this view a name.');
      if (!view) throw new Error('This camera view cannot be saved. Return to an overhead or tilted globe view.');
      const old = id ? places.find((place) => place.id === id) : null;
      if (id && !old) throw new Error('This saved place no longer exists.');
      if (!old && places.length >= MAX_SAVED_PLACES) throw new Error(`You can save ${MAX_SAVED_PLACES} views. Remove one to make room.`);
      const stamp = now(), placeId = old?.id || createId();
      if (typeof placeId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(placeId) || (!old && places.some((place) => place.id === placeId))) throw new Error('The place could not be assigned a unique identifier.');
      const item = { id: placeId, name, view, createdAt: old?.createdAt ?? stamp, updatedAt: stamp };
      persist(old ? places.map((place) => place.id === id ? item : place) : [...places, item]);
      return copy(item);
    },
    rename(id, name) { const place = this.get(id); if (!place) throw new Error('This saved place no longer exists.'); return this.save(name, place.view, id); },
    remove(id) { if (!places.some((place) => place.id === id)) return false; persist(places.filter((place) => place.id !== id)); return true; },
  };
}
